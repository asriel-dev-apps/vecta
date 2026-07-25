import { type ProjectAccessGrant } from "@vecta/application";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  API_ISSUER,
  TENANT_ID,
  fakeGrantResolver,
  fakeSession,
  fakeWorkspaceLoader,
  fixedAuthenticate,
  generateApiKeys,
  signAccessToken,
  type ApiTestKeys,
} from "./fixtures/api";
import { FakeProjectCommandUnitOfWork } from "./fixtures/fake-unit-of-work";
import { scheduledProject } from "./fixtures/wbs";
import {
  MCP_METADATA_URL,
  MCP_RESOURCE_URL,
  buildMcpHandler,
  callMcp,
  mcpCtx,
  mcpEnv,
  mcpRpcRequest,
  realMcpAuthenticate,
  signMcpToken,
  toolErrorCode,
  type McpToolResult,
} from "./fixtures/mcp";

/**
 * The token `/mcp` surface (ADR 0012 Step 5b; ADR 0003). A stateless remote MCP
 * server ported from `apps/web/src/mcp.ts`, retargeted at the batch command core.
 * Every assertion runs against the injectable handler from `~/server/api/mcp`,
 * wired with a local JWKS + the SAME in-memory persistence fakes as `/api` (see
 * `./fixtures/mcp`), so the three tools, Bearer auth (audience `MCP_RESOURCE_URL`),
 * the RFC 9728 metadata, the host/Origin + 64 KiB guards, and the DbSession
 * lifecycle are exercised with no network and no Neon.
 */

const project = scheduledProject({ parentCount: 2, subtasksPerParent: 3, memberCount: 3 });
const PROJECT_ID = project.id;
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

/** Drive a `tools/call` and return the tool result payload. */
async function callTool(
  handler: ReturnType<typeof buildMcpHandler>["handler"],
  name: string,
  args: Record<string, unknown>,
  token: string,
): Promise<{ status: number; result: McpToolResult | undefined }> {
  const { status, body } = await callMcp(
    handler,
    "tools/call",
    { name, arguments: args },
    { token },
  );
  return { status, result: body.result };
}

function applyArgs(command: unknown, idempotencyKey = "key-1", expectedRevision = "5") {
  return {
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    expectedRevision,
    commands: [{ command, idempotencyKey }],
  };
}

describe("/mcp initialize + tools/list (Bearer)", () => {
  it("initializes and lists exactly the three project tools", async () => {
    const token = await signMcpToken(keys.privateKey, { sub: "human-1" });
    const { handler } = buildMcpHandler({ authenticate: realMcpAuthenticate(keys) });

    const init = await callMcp(
      handler,
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vecta-test", version: "1.0.0" },
      },
      { token },
    );
    expect(init.status).toBe(200);

    const list = await callMcp(handler, "tools/list", {}, { token });
    expect(list.status).toBe(200);
    expect(list.body.result?.tools?.map((tool) => tool.name)).toEqual([
      "list_projects",
      "get_project",
      "apply_project_commands",
    ]);
  });
});

describe("/mcp tools/call apply_project_commands (authz through the shared core)", () => {
  it("denies a VIEWER write with the stable PROJECT_ACCESS_DENIED code", async () => {
    const token = await signMcpToken(keys.privateKey, { sub: "viewer-1" });
    const { handler } = buildMcpHandler({
      authenticate: realMcpAuthenticate(keys),
      grantResolver: fakeGrantResolver(grant({ projectRole: "VIEWER" })),
      unitOfWorkFor: () => new FakeProjectCommandUnitOfWork(project, 5n),
    });
    const { status, result } = await callTool(
      handler,
      "apply_project_commands",
      applyArgs({ type: "task.update", taskId: leaf.id, changes: { name: "X" } }),
      token,
    );
    expect(status).toBe(200);
    expect(result?.isError).toBe(true);
    expect(toolErrorCode(result)).toBe("PROJECT_ACCESS_DENIED");
  });

  it("denies an agent plan-field change with AGENT_APPROVAL_REQUIRED", async () => {
    const token = await signMcpToken(keys.privateKey, {
      sub: "agent-1",
      scope: "project:progress:write",
    });
    const { handler } = buildMcpHandler({
      authenticate: fixedAuthenticate({
        issuer: API_ISSUER,
        subject: "agent-1",
        scopes: ["project:progress:write"],
      }),
      grantResolver: fakeGrantResolver(
        grant({ principalType: "AGENT", projectRole: "EDITOR", allowedScopes: ["project:progress:write"] }),
      ),
      unitOfWorkFor: () => new FakeProjectCommandUnitOfWork(project, 5n),
    });
    const { status, result } = await callTool(
      handler,
      "apply_project_commands",
      applyArgs({ type: "task.update", taskId: leaf.id, changes: { name: "Renamed" } }),
      token,
    );
    expect(status).toBe(200);
    expect(result?.isError).toBe(true);
    expect(toolErrorCode(result)).toBe("AGENT_APPROVAL_REQUIRED");
  });

  it("applies a valid EDITOR write and returns the chained revision", async () => {
    const token = await signMcpToken(keys.privateKey, { sub: "editor-1" });
    const { handler } = buildMcpHandler({
      authenticate: realMcpAuthenticate(keys),
      grantResolver: fakeGrantResolver(grant({ projectRole: "EDITOR" })),
      unitOfWorkFor: () => new FakeProjectCommandUnitOfWork(project, 5n),
    });
    const { status, result } = await callTool(
      handler,
      "apply_project_commands",
      applyArgs({ type: "task.update", taskId: leaf.id, changes: { progressBasisPoints: 5_000 } }),
      token,
    );
    expect(status).toBe(200);
    expect(result?.isError ?? false).toBe(false);
    expect(result?.structuredContent).toEqual({ projectId: PROJECT_ID, revision: "6" });
  });
});

describe("/mcp tools/call get_project (role projection + no existence oracle)", () => {
  function currentFromResult(result: McpToolResult | undefined): {
    members: Record<string, unknown>[];
  } {
    const text = result?.content?.[0]?.text ?? "{}";
    return (JSON.parse(text) as { current: { members: Record<string, unknown>[] } }).current;
  }

  it("omits dailyCapacityMinutes from the GENERAL (VIEWER) view but keeps it for PRIVILEGED", async () => {
    const token = await signMcpToken(keys.privateKey, { sub: "reader-1" });
    const general = buildMcpHandler({
      authenticate: realMcpAuthenticate(keys),
      grantResolver: fakeGrantResolver(grant({ projectRole: "VIEWER" })),
      workspace: fakeWorkspaceLoader({ revision: 7n, current: project }),
    });
    const generalCall = await callTool(general.handler, "get_project", { tenantId: TENANT_ID, projectId: PROJECT_ID }, token);
    const generalCurrent = currentFromResult(generalCall.result);
    expect(generalCurrent.members.length).toBeGreaterThan(0);
    for (const member of generalCurrent.members) {
      expect("dailyCapacityMinutes" in member).toBe(false);
    }

    const privileged = buildMcpHandler({
      authenticate: realMcpAuthenticate(keys),
      grantResolver: fakeGrantResolver(grant({ projectRole: "EDITOR" })),
      workspace: fakeWorkspaceLoader({ revision: 7n, current: project }),
    });
    const privilegedCall = await callTool(privileged.handler, "get_project", { tenantId: TENANT_ID, projectId: PROJECT_ID }, token);
    for (const member of currentFromResult(privilegedCall.result).members) {
      expect(typeof member.dailyCapacityMinutes).toBe("number");
    }
  });

  it("returns a byte-identical error for a non-member and a nonexistent project (no existence oracle)", async () => {
    const token = await signMcpToken(keys.privateKey, { sub: "outsider-1" });
    // Non-member of an existing project: the workspace loader would return it, but
    // authorization runs first and there is no grant.
    const nonMember = buildMcpHandler({
      authenticate: realMcpAuthenticate(keys),
      grantResolver: fakeGrantResolver(null),
      workspace: fakeWorkspaceLoader({ revision: 7n, current: project }),
    });
    // Nonexistent project: no grant AND no workspace.
    const nonexistent = buildMcpHandler({
      authenticate: realMcpAuthenticate(keys),
      grantResolver: fakeGrantResolver(null),
      workspace: fakeWorkspaceLoader(null),
    });
    const a = await callTool(nonMember.handler, "get_project", { tenantId: TENANT_ID, projectId: PROJECT_ID }, token);
    const b = await callTool(nonexistent.handler, "get_project", { tenantId: TENANT_ID, projectId: PROJECT_ID }, token);
    expect(a.result?.isError).toBe(true);
    expect(b.result?.isError).toBe(true);
    expect(toolErrorCode(a.result)).toBe("PROJECT_ACCESS_DENIED");
    expect(a.result?.content).toEqual(b.result?.content);
  });
});

describe("/mcp RFC 9728 metadata + pre-protocol guards", () => {
  it("serves the protected-resource metadata document (unauthenticated)", async () => {
    const { handler } = buildMcpHandler({ authenticate: realMcpAuthenticate(keys) });
    const response = (await handler(
      new Request(MCP_METADATA_URL),
      mcpEnv(),
      mcpCtx,
    )) as Response;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      resource: MCP_RESOURCE_URL,
      authorization_servers: [API_ISSUER],
      scopes_supported: ["project:progress:write", "project:actuals:write"],
      bearer_methods_supported: ["header"],
      resource_name: "VECTA project commands",
    });
  });

  it("rejects an unauthenticated MCP request with 401 carrying resource_metadata", async () => {
    const { handler } = buildMcpHandler({ authenticate: realMcpAuthenticate(keys) });
    const response = (await handler(
      mcpRpcRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1.0.0" } },
      }),
      mcpEnv(),
      mcpCtx,
    )) as Response;
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${MCP_METADATA_URL}"`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects a foreign Origin before protocol handling (403)", async () => {
    const token = await signMcpToken(keys.privateKey, { sub: "human-1" });
    const { handler } = buildMcpHandler({ authenticate: realMcpAuthenticate(keys) });
    const response = (await handler(
      mcpRpcRequest(
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { token, origin: "https://attacker.example.test" },
      ),
      mcpEnv(),
      mcpCtx,
    )) as Response;
    expect(response.status).toBe(403);
  });

  it("rejects a request body larger than 64 KiB (413)", async () => {
    const token = await signMcpToken(keys.privateKey, { sub: "human-1" });
    const { handler } = buildMcpHandler({ authenticate: realMcpAuthenticate(keys) });
    const response = (await handler(
      new Request(MCP_RESOURCE_URL, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ padding: "x".repeat(70 * 1024) }),
      }),
      mcpEnv(),
      mcpCtx,
    )) as Response;
    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects a non-POST /mcp with 405 (no SSE stream, no session) even with a valid Bearer", async () => {
    // In stateless mode a standalone GET would open a held-open SSE stream; the
    // method gate returns 405 before the transport and before any session opens.
    const token = await signMcpToken(keys.privateKey, { sub: "human-1" });
    const session = fakeSession();
    const closeSpy = vi.spyOn(session, "close");
    const { handler } = buildMcpHandler({
      authenticate: realMcpAuthenticate(keys),
      createSession: () => session,
    });
    const response = (await handler(
      new Request(MCP_RESOURCE_URL, {
        method: "GET",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
      }),
      mcpEnv(),
      mcpCtx,
    )) as Response;
    expect(response.status).toBe(405);
    // A JSON error envelope, never a `text/event-stream` the client could hold open.
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it("rejects a token minted for the /api audience with 401 (cross-surface replay), opening no session", async () => {
    // `signAccessToken` defaults to the REST audience (OIDC_CLIENT_ID); replayed at
    // `/mcp` it must fail the MCP_RESOURCE_URL audience check with no DB session.
    const apiAudienceToken = await signAccessToken(keys.privateKey, { sub: "human-1" });
    const session = fakeSession();
    const closeSpy = vi.spyOn(session, "close");
    const { handler } = buildMcpHandler({
      authenticate: realMcpAuthenticate(keys),
      createSession: () => session,
    });
    const response = (await handler(
      mcpRpcRequest(
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { token: apiAudienceToken },
      ),
      mcpEnv(),
      mcpCtx,
    )) as Response;
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${MCP_METADATA_URL}"`,
    );
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it("does not advertise permissive CORS on a JSON-RPC response", async () => {
    // The agents WorkerTransport appends `Access-Control-Allow-Origin: *`; the
    // rewrap strips it (auth is Bearer-only + the Origin gate 403s cross-origin).
    const token = await signMcpToken(keys.privateKey, { sub: "human-1" });
    const { handler } = buildMcpHandler({ authenticate: realMcpAuthenticate(keys) });
    const init = await callMcp(
      handler,
      "initialize",
      { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1.0.0" } },
      { token },
    );
    expect(init.status).toBe(200);
    expect(init.response.headers.get("access-control-allow-origin")).toBeNull();
    expect(init.response.headers.get("access-control-expose-headers")).toBeNull();
  });
});

describe("/mcp DbSession lifecycle (handler owns close)", () => {
  it("closes the request session exactly once on a successful tool call", async () => {
    const token = await signMcpToken(keys.privateKey, { sub: "human-1" });
    const session = fakeSession();
    const closeSpy = vi.spyOn(session, "close");
    const { handler } = buildMcpHandler({
      authenticate: realMcpAuthenticate(keys),
      createSession: () => session,
    });
    const { status } = await callTool(handler, "list_projects", {}, token);
    expect(status).toBe(200);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("opens no session for an unauthenticated request (a 401 before createSession)", async () => {
    const session = fakeSession();
    const closeSpy = vi.spyOn(session, "close");
    const { handler } = buildMcpHandler({
      authenticate: realMcpAuthenticate(keys),
      createSession: () => session,
    });
    const response = (await handler(
      mcpRpcRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      mcpEnv(),
      mcpCtx,
    )) as Response;
    expect(response.status).toBe(401);
    expect(closeSpy).not.toHaveBeenCalled();
  });
});
