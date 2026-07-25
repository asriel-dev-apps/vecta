import {
  IdempotencyConflictError,
  type ProjectAccessGrant,
  type ProjectCommandExecution,
  type ProjectCommandRequest,
  type ProjectCommandUnitOfWork,
  type ProjectState,
} from "@vecta/application";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { applyCommands } from "~/server/project/apply-commands.server";
import { AuthenticationRequiredError } from "~/server/api/oidc-auth";
import { toCommand } from "~/wbs/project-command-contract";
import {
  API_ISSUER,
  TENANT_ID,
  apiEnv,
  buildApiApp,
  fakeGrantResolver,
  fakeSession,
  fakeWorkspaceLoader,
  fixedAuthenticate,
  generateApiKeys,
  realAuthenticate,
  signAccessToken,
  type ApiTestKeys,
} from "./fixtures/api";
import { MCP_RESOURCE_URL } from "./fixtures/mcp";
import { FakeProjectCommandUnitOfWork } from "./fixtures/fake-unit-of-work";
import { scheduledProject } from "./fixtures/wbs";

/**
 * The token `/api` surface (ADR 0012 Step 5a). Every assertion runs against the
 * injectable Hono app from `~/server/api/app`, wired with a local JWKS + in-memory
 * persistence fakes (see `./fixtures/api`), so the whole surface — Bearer auth,
 * the `applyCommands` identity/grant seam, the role-scoped read model, the batch
 * write core, conflict/idempotency, and the DbSession lifecycle — is exercised
 * with no network and no Neon connection.
 */

const project = scheduledProject({ parentCount: 2, subtasksPerParent: 3, memberCount: 3 });
const PROJECT_ID = project.id;
const BASE = `/api/tenants/${TENANT_ID}/projects/${PROJECT_ID}`;
const leaf = project.tasks.find((task) => task.parentId !== null)!;

let keys: ApiTestKeys;
beforeAll(async () => {
  keys = await generateApiKeys();
});

function grant(overrides: Partial<ProjectAccessGrant> = {}): ProjectAccessGrant {
  return {
    principalId: "principal-1",
    principalType: "HUMAN",
    projectRole: "EDITOR",
    allowedScopes: [],
    ...overrides,
  };
}

function postCommands(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function batchOf(command: unknown, idempotencyKey = "key-1", expectedRevision = "5") {
  return { expectedRevision, commands: [{ command, idempotencyKey }] };
}

/**
 * A unit of work that models the Postgres UoW's idempotency receipt (checked
 * BEFORE the version gate, per `PostgresProjectCommandUnitOfWork.execute`): a
 * repeated `(idempotencyKey)` with a matching request fingerprint REPLAYS the
 * recorded revision without re-applying the transition or bumping the revision;
 * a mismatched fingerprint is an {@link IdempotencyConflictError}. `applyCount`
 * counts real transitions so a replay can be proven not to re-execute.
 */
class IdempotentFakeUnitOfWork implements ProjectCommandUnitOfWork {
  private readonly inner: FakeProjectCommandUnitOfWork;
  private readonly receipts = new Map<string, { revision: bigint; fingerprint: string }>();
  applyCount = 0;

  constructor(state: ProjectState, revision: bigint) {
    this.inner = new FakeProjectCommandUnitOfWork(state, revision);
  }

  get state(): ProjectState {
    return this.inner.state;
  }

  get revision(): bigint {
    return this.inner.revision;
  }

  async execute(
    request: ProjectCommandRequest,
    transition: (project: ProjectState) => ProjectState,
  ): Promise<ProjectCommandExecution> {
    const fingerprint = JSON.stringify({
      actor: request.actor,
      command: request.command,
      expectedRevision: request.expectedRevision.toString(),
    });
    const existing = this.receipts.get(request.idempotencyKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new IdempotencyConflictError(request.idempotencyKey);
      }
      return { projectId: request.projectId, revision: existing.revision, replayed: true };
    }
    const execution = await this.inner.execute(request, transition);
    this.applyCount += 1;
    this.receipts.set(request.idempotencyKey, { revision: execution.revision, fingerprint });
    return execution;
  }
}

describe("/api auth (token-only, cookie never grants)", () => {
  it("serves the health probe without a token", async () => {
    const { app } = buildApiApp();
    const response = await app.request("/api/health", {}, apiEnv());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ service: "vecta", status: "ok" });
  });

  it("rejects a missing Authorization header with 401 + WWW-Authenticate", async () => {
    const { app } = buildApiApp({ authenticate: realAuthenticate(keys) });
    const response = await app.request("/api/projects", {}, apiEnv());
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "AUTHENTICATION_REQUIRED" },
    });
  });

  it("rejects a valid session cookie WITHOUT a Bearer token with 401 (cookie never grants)", async () => {
    const { app } = buildApiApp({ authenticate: realAuthenticate(keys) });
    const response = await app.request(
      "/api/projects",
      { headers: { cookie: "__Secure-vecta_session=valid-looking-cookie" } },
      apiEnv(),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("rejects malformed / expired / wrong-issuer / wrong-audience tokens with 401", async () => {
    const { app } = buildApiApp({ authenticate: realAuthenticate(keys) });
    const now = Math.floor(Date.now() / 1000);
    const cases: Array<[string, string]> = [
      ["malformed", "not-a-jwt"],
      ["expired", await signAccessToken(keys.privateKey, { exp: now - 10 })],
      ["wrong-issuer", await signAccessToken(keys.privateKey, { iss: "https://evil.example.invalid" })],
      ["wrong-audience", await signAccessToken(keys.privateKey, { aud: "some-other-audience" })],
    ];
    for (const [, token] of cases) {
      const response = await app.request(
        "/api/projects",
        { headers: { authorization: `Bearer ${token}` } },
        apiEnv(),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
    }
  });

  it("rejects a token minted for the /mcp audience with 401 (cross-surface replay), opening no DB session", async () => {
    // A token whose aud is MCP_RESOURCE_URL, replayed at /api: it must fail the
    // OIDC_CLIENT_ID audience check with a 401 and never open the DB session.
    const mcpAudienceToken = await signAccessToken(keys.privateKey, { aud: MCP_RESOURCE_URL });
    const { app, session } = buildApiApp({ authenticate: realAuthenticate(keys) });
    const databaseSpy = vi.spyOn(session, "database");
    const response = await app.request(
      "/api/projects",
      { headers: { authorization: `Bearer ${mcpAudienceToken}` } },
      apiEnv(),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(databaseSpy).not.toHaveBeenCalled();
  });

  it("derives the identity (subject, scopes, verified email) from a valid token", async () => {
    const token = await signAccessToken(keys.privateKey, {
      sub: "google-sub-42",
      scope: "project:progress:write openid",
      email: "Person@Example.test",
      email_verified: true,
    });
    const { app, listReader } = buildApiApp({ authenticate: realAuthenticate(keys) });
    const response = await app.request(
      "/api/projects",
      { headers: { authorization: `Bearer ${token}` } },
      apiEnv(),
    );
    expect(response.status).toBe(200);
    // The list read is keyed on the verified identity from the token — never a cookie.
    expect(listReader.lastIdentity).toMatchObject({
      issuer: API_ISSUER,
      subject: "google-sub-42",
      email: "person@example.test",
    });
    expect(listReader.lastIdentity?.scopes).toContain("project:progress:write");
  });
});

describe("/api authz (role gating, no existence oracle)", () => {
  it("lets a VIEWER read the workspace but denies a POST with 403", async () => {
    const read = buildApiApp({
      grantResolver: fakeGrantResolver(grant({ projectRole: "VIEWER" })),
      workspace: fakeWorkspaceLoader({ revision: 7n, current: project }),
    });
    const readResponse = await read.app.request(BASE, {}, apiEnv());
    expect(readResponse.status).toBe(200);

    const write = buildApiApp({
      grantResolver: fakeGrantResolver(grant({ projectRole: "VIEWER" })),
      unitOfWorkFor: () => new FakeProjectCommandUnitOfWork(project, 5n),
    });
    const writeResponse = await write.app.request(
      `${BASE}/commands`,
      postCommands(batchOf({ type: "task.update", taskId: leaf.id, changes: { name: "X" } })),
      apiEnv(),
    );
    expect(writeResponse.status).toBe(403);
    await expect(writeResponse.json()).resolves.toMatchObject({
      error: { code: "PROJECT_ACCESS_DENIED" },
    });
  });

  it("returns a byte-identical 403 for a non-member and a nonexistent project (no existence oracle)", async () => {
    // Non-member of an EXISTING project: the workspace loader would return it,
    // but authorization runs first and there is no grant.
    const nonMember = buildApiApp({
      grantResolver: fakeGrantResolver(null),
      workspace: fakeWorkspaceLoader({ revision: 7n, current: project }),
    });
    // Nonexistent project: no grant AND no workspace.
    const nonexistent = buildApiApp({
      grantResolver: fakeGrantResolver(null),
      workspace: fakeWorkspaceLoader(null),
    });
    const a = await nonMember.app.request(BASE, {}, apiEnv());
    const b = await nonexistent.app.request(BASE, {}, apiEnv());
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
    expect(await a.json()).toEqual(await b.json());
  });

  it("omits dailyCapacityMinutes from the GENERAL (VIEWER) view but keeps it for PRIVILEGED", async () => {
    const general = buildApiApp({
      grantResolver: fakeGrantResolver(grant({ projectRole: "VIEWER" })),
      workspace: fakeWorkspaceLoader({ revision: 7n, current: project }),
    });
    const generalBody = (await (await general.app.request(BASE, {}, apiEnv())).json()) as {
      current: { members: Record<string, unknown>[] };
    };
    expect(generalBody.current.members.length).toBeGreaterThan(0);
    for (const member of generalBody.current.members) {
      expect("dailyCapacityMinutes" in member).toBe(false);
    }

    for (const projectRole of ["OWNER", "EDITOR"] as const) {
      const privileged = buildApiApp({
        grantResolver: fakeGrantResolver(grant({ projectRole })),
        workspace: fakeWorkspaceLoader({ revision: 7n, current: project }),
      });
      const body = (await (await privileged.app.request(BASE, {}, apiEnv())).json()) as {
        current: { members: Record<string, unknown>[] };
      };
      for (const member of body.current.members) {
        expect(typeof member.dailyCapacityMinutes).toBe("number");
      }
    }
  });
});

describe("/api AGENT semantics through the identity/grant seam (finding-2 regression)", () => {
  // These would ALL fail against the pre-seam applyCommands: it used the cookie
  // stub identity (scopes []) + in-memory grant (allowedScopes []), so an AGENT
  // could never satisfy `canAgentApply`. Passing them proves the token surface
  // injects the verified identity + the Postgres-shaped grant into the core.
  const agentGrant = (allowedScopes: string[]) =>
    fakeGrantResolver(grant({ principalType: "AGENT", projectRole: "EDITOR", allowedScopes }));

  it("lets a scoped agent write progress (task.update actuals)", async () => {
    const { app } = buildApiApp({
      authenticate: fixedAuthenticate({
        issuer: API_ISSUER,
        subject: "agent-1",
        scopes: ["project:progress:write"],
      }),
      grantResolver: agentGrant(["project:progress:write"]),
      unitOfWorkFor: () => new FakeProjectCommandUnitOfWork(project, 5n),
    });
    const response = await app.request(
      `${BASE}/commands`,
      postCommands(batchOf({ type: "task.update", taskId: leaf.id, changes: { progressBasisPoints: 5_000 } })),
      apiEnv(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ projectId: PROJECT_ID, revision: "6" });
  });

  it("denies an agent plan-field change with 403 AGENT_APPROVAL_REQUIRED", async () => {
    const { app } = buildApiApp({
      authenticate: fixedAuthenticate({
        issuer: API_ISSUER,
        subject: "agent-1",
        scopes: ["project:progress:write"],
      }),
      grantResolver: agentGrant(["project:progress:write"]),
      unitOfWorkFor: () => new FakeProjectCommandUnitOfWork(project, 5n),
    });
    const response = await app.request(
      `${BASE}/commands`,
      postCommands(batchOf({ type: "task.update", taskId: leaf.id, changes: { name: "Renamed" } })),
      apiEnv(),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "AGENT_APPROVAL_REQUIRED" },
    });
  });

  it("denies an agent write when the identity is missing the required scope (403 PROJECT_ACCESS_DENIED)", async () => {
    // The grant carries the scope, but the token identity does not — `canAgentApply`
    // requires BOTH, so the identity half of the seam is load-bearing.
    const { app } = buildApiApp({
      authenticate: fixedAuthenticate({ issuer: API_ISSUER, subject: "agent-1", scopes: [] }),
      grantResolver: agentGrant(["project:progress:write"]),
      unitOfWorkFor: () => new FakeProjectCommandUnitOfWork(project, 5n),
    });
    const response = await app.request(
      `${BASE}/commands`,
      postCommands(batchOf({ type: "task.update", taskId: leaf.id, changes: { progressBasisPoints: 5_000 } })),
      apiEnv(),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "PROJECT_ACCESS_DENIED" },
    });
  });
});

describe("/api identity threading (email fallback seam)", () => {
  it("threads the token's verified identity (with email) into the grant resolver and the list reader", async () => {
    const token = await signAccessToken(keys.privateKey, {
      sub: "provider-sub",
      email: "seed@example.test",
      email_verified: true,
    });
    // List path: the identity reaches the identity-keyed reader (which applies the
    // `email:` fallback in Postgres — covered by the persistence package tests).
    const list = buildApiApp({ authenticate: realAuthenticate(keys) });
    await list.app.request("/api/projects", { headers: { authorization: `Bearer ${token}` } }, apiEnv());
    expect(list.listReader.lastIdentity?.email).toBe("seed@example.test");

    // Per-project path: the same identity reaches the grant resolver.
    const perProject = buildApiApp({
      authenticate: realAuthenticate(keys),
      grantResolver: fakeGrantResolver(grant({ projectRole: "VIEWER" })),
      workspace: fakeWorkspaceLoader({ revision: 7n, current: project }),
    });
    await perProject.app.request(BASE, { headers: { authorization: `Bearer ${token}` } }, apiEnv());
    const resolver = perProject.grantResolver as ReturnType<typeof fakeGrantResolver>;
    expect(resolver.lastRequest?.identity.email).toBe("seed@example.test");
  });
});

describe("/api core parity (one write core, no fork by surface)", () => {
  it("reaches applyCommands with identical UoW transitions via the cookie shape and via /api", async () => {
    const wireCommand = { type: "task.update", taskId: leaf.id, changes: { sortOrder: 3 } } as const;

    // Cookie surface shape (what command-action.server.ts builds): actor +
    // projectRole, no identity/grant seam.
    const uowCookie = new FakeProjectCommandUnitOfWork(project, 5n);
    const cookieResult = await applyCommands(
      {
        session: fakeSession(),
        actor: { principalId: "p-1", principalType: "HUMAN" },
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        projectRole: "OWNER",
        commands: [{ command: toCommand(wireCommand), idempotencyKey: "k-parity" }],
        expectedRevision: 5n,
      },
      { unitOfWorkFor: () => uowCookie },
    );

    // Token surface: the same wire batch through the real /api commands route.
    const uowToken = new FakeProjectCommandUnitOfWork(project, 5n);
    const { app } = buildApiApp({
      grantResolver: fakeGrantResolver(grant({ projectRole: "OWNER" })),
      unitOfWorkFor: () => uowToken,
    });
    const response = await app.request(
      `${BASE}/commands`,
      postCommands(batchOf(wireCommand, "k-parity")),
      apiEnv(),
    );

    expect(response.status).toBe(200);
    expect(cookieResult).toEqual({ ok: true, revision: 6n });
    // Identical unit-of-work transitions: same next state, revision, and count.
    expect(uowToken.state).toEqual(uowCookie.state);
    expect(uowToken.revision).toBe(uowCookie.revision);
    expect(uowToken.executeCount).toBe(uowCookie.executeCount);
    expect(uowToken.revision).toBe(6n);
  });
});

describe("/api conflict + idempotency", () => {
  it("maps a stale expectedRevision to 409 carrying the actual revision", async () => {
    const { app } = buildApiApp({
      grantResolver: fakeGrantResolver(grant({ projectRole: "OWNER" })),
      unitOfWorkFor: () => new FakeProjectCommandUnitOfWork(project, 5n),
    });
    const response = await app.request(
      `${BASE}/commands`,
      postCommands(batchOf({ type: "task.update", taskId: leaf.id, changes: { name: "X" } }, "k-1", "4")),
      apiEnv(),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VERSION_CONFLICT", expectedRevision: "4", actualRevision: "5" },
    });
  });

  it("replays an identical re-POST to the same state (idempotency)", async () => {
    const uow = new IdempotentFakeUnitOfWork(project, 5n);
    const { app } = buildApiApp({
      grantResolver: fakeGrantResolver(grant({ projectRole: "OWNER" })),
      unitOfWorkFor: () => uow,
    });
    const request = () =>
      app.request(
        `${BASE}/commands`,
        postCommands(batchOf({ type: "task.update", taskId: leaf.id, changes: { name: "Renamed" } }, "k-idem")),
        apiEnv(),
      );
    const first = await request();
    const second = await request();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ projectId: PROJECT_ID, revision: "6" });
    await expect(second.json()).resolves.toEqual({ projectId: PROJECT_ID, revision: "6" });
    // The transition was applied exactly once; the second POST replayed the receipt.
    expect(uow.applyCount).toBe(1);
    expect(uow.revision).toBe(6n);
  });

  it("rejects a malformed authenticated body with 400 (auth passed, validation failed)", async () => {
    const { app } = buildApiApp({ grantResolver: fakeGrantResolver(grant({ projectRole: "OWNER" })) });
    const response = await app.request(
      `${BASE}/commands`,
      postCommands({ expectedRevision: "5", commands: [{ command: { type: "task.update" }, idempotencyKey: "k" }] }),
      apiEnv(),
    );
    expect(response.status).toBe(400);
  });

  it("rejects a SYNTACTICALLY malformed JSON body with 400 (not 500, no api_unhandled_error log)", async () => {
    // Well-formed auth, but the body is not parseable JSON: Hono's json validator
    // throws HTTPException(400) BEFORE the route handler. It must surface as a 400
    // error envelope, never a 500 + api_unhandled_error log (P1 regression).
    const { app } = buildApiApp({ grantResolver: fakeGrantResolver(grant({ projectRole: "OWNER" })) });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await app.request(
      `${BASE}/commands`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{ not valid json" },
      apiEnv(),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: expect.any(String), message: expect.any(String) },
    });
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("api_unhandled_error"));
    errorSpy.mockRestore();
  });

  it("rejects an oversize command body with 413 (bodyLimit, after auth passes)", async () => {
    const { app } = buildApiApp({ grantResolver: fakeGrantResolver(grant({ projectRole: "OWNER" })) });
    const response = await app.request(
      `${BASE}/commands`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(70 * 1024) },
      apiEnv(),
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "BODY_TOO_LARGE" } });
  });
});

describe("/api OpenAPI document", () => {
  it("parses and carries the routes + the OidcBearer security scheme", async () => {
    const { app } = buildApiApp();
    const response = await app.request("/api/openapi.json", {}, apiEnv());
    expect(response.status).toBe(200);
    const doc = (await response.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
      components: { securitySchemes: Record<string, { type: string; scheme: string }> };
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths).toHaveProperty("/api/projects");
    expect(doc.paths).toHaveProperty("/api/tenants/{tenantId}/projects/{projectId}");
    expect(doc.paths).toHaveProperty("/api/tenants/{tenantId}/projects/{projectId}/commands");
    expect(doc.components.securitySchemes.OidcBearer).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
  });
});

describe("/api DbSession lifecycle (Hono branch owns close)", () => {
  it("closes the request session exactly once on a successful request", async () => {
    const { app, session } = buildApiApp();
    const closeSpy = vi.spyOn(session, "close");
    const response = await app.request("/api/projects", {}, apiEnv());
    expect(response.status).toBe(200);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("closes the request session exactly once even when a downstream throws", async () => {
    const { app, session } = buildApiApp({
      authenticate: () => Promise.reject(new AuthenticationRequiredError()),
    });
    const closeSpy = vi.spyOn(session, "close");
    const response = await app.request("/api/projects", {}, apiEnv());
    expect(response.status).toBe(401);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("applyCommands cookie surface unchanged (post-seam regression)", () => {
  it("keeps the default (no identity/grant seam) call byte-identical", async () => {
    // OWNER human, no injected identity/grantResolver → cookie stub identity + the
    // in-memory grant. Byte-identical to the pre-seam behaviour.
    const ok = await applyCommands(
      {
        session: fakeSession(),
        actor: { principalId: "p-1", principalType: "HUMAN" },
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        projectRole: "OWNER",
        commands: [{ command: { type: "task.update", taskId: leaf.id, changes: { name: "X" } }, idempotencyKey: "k1" }],
        expectedRevision: 5n,
      },
      { unitOfWorkFor: () => new FakeProjectCommandUnitOfWork(project, 5n) },
    );
    expect(ok).toEqual({ ok: true, revision: 6n });

    // A denied cookie actor stays exactly `{ ok: false, code: "FORBIDDEN" }` — the
    // `reason` field is token-surface-only, so `toEqual` (no extra keys) pins it.
    const denied = await applyCommands(
      {
        session: fakeSession(),
        actor: { principalId: "v-1", principalType: "HUMAN" },
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        projectRole: "VIEWER",
        commands: [{ command: { type: "task.update", taskId: leaf.id, changes: { name: "X" } }, idempotencyKey: "k2" }],
        expectedRevision: 5n,
      },
      { unitOfWorkFor: () => new FakeProjectCommandUnitOfWork(project, 5n) },
    );
    expect(denied).toEqual({ ok: false, code: "FORBIDDEN" });
  });

  it("still requires actor + projectRole when no grant resolver is injected", async () => {
    await expect(
      applyCommands({
        session: fakeSession(),
        tenantId: TENANT_ID,
        projectId: PROJECT_ID,
        commands: [{ command: { type: "task.update", taskId: leaf.id, changes: { name: "X" } }, idempotencyKey: "k3" }],
        expectedRevision: 5n,
      }),
    ).rejects.toThrow(/grantResolver/);
  });
});
