import { RouterContextProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { createProjectAccessMiddleware } from "~/middleware/project-access.server";
import type { AuthenticatedPrincipal } from "~/server/auth/principal-directory.server";
import {
  loadProjectList,
  type ProjectListSource,
} from "~/server/project/project-list.server";
import {
  requireProjectMembership,
  requireProjectWorkspace,
  type ProjectWorkspaceLoader,
  type ProjectWorkspaceRecord,
} from "~/server/project/project-access.server";
import { createDemoProject } from "./fixtures/demo-project";
import { loadProjectView } from "~/server/project/load-project-view.server";
import { appContext, principalContext } from "~/server/context.server";
import { fakeEnv } from "./helpers";

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
// A well-formed UUID the principal has no membership for (a project that either
// belongs to someone else, or does not exist — the gate cannot tell them apart).
const UNKNOWN_PROJECT_ID = "33333333-3333-4333-8333-333333333333";

const PROJECT_NAME = "Project 1";

// The gate no longer fetches the project row on its own: the workspace batch's
// header IS that row, so the fake workspace carries the identity every screen
// reads the project's name and id from.
const WORKSPACE: ProjectWorkspaceRecord = {
  revision: 5n,
  current: {
    ...createDemoProject({ parentCount: 1, subtasksPerParent: 1, memberCount: 1 }),
    id: PROJECT_ID,
    name: PROJECT_NAME,
  },
};

function principalWith(
  projectRole: "OWNER" | "EDITOR" | "VIEWER" | null,
): AuthenticatedPrincipal {
  return {
    principal: {
      id: "principal-1",
      issuer: "https://identity.example.invalid/",
      subject: "subject-1",
      displayName: "Test User",
      type: "HUMAN",
    },
    tenantMemberships: [{ tenantId: TENANT_ID, role: "MEMBER" }],
    projectMemberships:
      projectRole === null
        ? []
        : [{ tenantId: TENANT_ID, projectId: PROJECT_ID, role: projectRole }],
  };
}

function middlewareArgs(
  context: RouterContextProvider,
  params: Record<string, string | undefined>,
) {
  const request = new Request(
    `https://app.example.invalid/projects/${params.id ?? ""}/wbs`,
  );
  return {
    request,
    context,
    params,
    url: new URL(request.url),
    pattern: "/projects/:id",
  };
}

interface GateRun {
  readonly denied: boolean;
  readonly thrown: unknown;
  readonly context: RouterContextProvider;
  readonly childLoader: ReturnType<typeof vi.fn>;
  readonly loadPrincipal: ReturnType<typeof vi.fn>;
  readonly loadWorkspace: ReturnType<typeof vi.fn>;
}

/**
 * Run the `/projects/:id` gate the way React Router's auto-next middleware
 * contract does: the gate never calls `next()` itself, so the framework runs the
 * downstream handlers (here, a spy child loader) only after the gate resolves
 * without throwing. If the gate throws first, the child loader is never reached.
 */
async function runGate(
  principal: AuthenticatedPrincipal | null,
  params: Record<string, string | undefined>,
): Promise<GateRun> {
  const loadPrincipal = vi.fn(async () => principal);
  const loadWorkspace = vi.fn(async () => WORKSPACE);
  const childLoader = vi.fn(async () => new Response(null));

  const context = new RouterContextProvider();
  context.set(appContext, { env: fakeEnv(), ctx });
  context.set(principalContext, loadPrincipal);

  const loader: ProjectWorkspaceLoader = { load: loadWorkspace };
  const gate = createProjectAccessMiddleware({ workspaceLoaderFor: () => loader });

  try {
    await gate(middlewareArgs(context, params), childLoader);
    // Framework proceeds to the child loaders once the gate resolves.
    await childLoader();
    return { denied: false, thrown: undefined, context, childLoader, loadPrincipal, loadWorkspace };
  } catch (thrown) {
    return { denied: true, thrown, context, childLoader, loadPrincipal, loadWorkspace };
  }
}

/** A thrown `data(null, { status })` carries the status on its `init`. */
function thrownStatus(thrown: unknown): number | undefined {
  if (typeof thrown === "object" && thrown !== null && "init" in thrown) {
    return (thrown as { init: ResponseInit | null }).init?.status;
  }
  return undefined;
}

describe("project access gate (middleware)", () => {
  it("HEADLINE: on deny the gate throws 404 and no child loader runs", async () => {
    const run = await runGate(principalWith(null), { id: PROJECT_ID });

    expect(run.denied).toBe(true);
    expect(thrownStatus(run.thrown)).toBe(404);
    // The security property: the throw precedes `next()`, so the child loader
    // never executes for a request the principal may not see.
    expect(run.childLoader).toHaveBeenCalledTimes(0);
  });

  it.each(["OWNER", "EDITOR", "VIEWER"] as const)(
    "grants access to a %s member and carries the projectRole in context",
    async (role) => {
      const run = await runGate(principalWith(role), { id: PROJECT_ID });

      expect(run.denied).toBe(false);
      expect(run.childLoader).toHaveBeenCalledTimes(1);

      const workspace = await requireProjectWorkspace(run.context);
      const membership = requireProjectMembership(run.context);
      // The workspace header IS the project row every screen reads.
      expect(workspace.current.id).toBe(PROJECT_ID);
      expect(workspace.current.name).toBe(PROJECT_NAME);
      expect(membership.projectRole).toBe(role);
      expect(membership.tenantId).toBe(TENANT_ID);
      expect(membership.projectId).toBe(PROJECT_ID);
      // tenantRole is carried from the already-loaded principal (no extra query).
      expect(membership.tenantRole).toBe("MEMBER");
    },
  );

  it("returns an identical 404 for a non-member and a nonexistent project id", async () => {
    // Both a project owned by someone else and a project that does not exist
    // present to the gate as "no membership" — indistinguishable by design.
    const nonMember = await runGate(principalWith(null), { id: PROJECT_ID });
    const nonExistent = await runGate(principalWith("OWNER"), {
      id: UNKNOWN_PROJECT_ID,
    });

    expect(nonMember.denied).toBe(true);
    expect(nonExistent.denied).toBe(true);
    expect(thrownStatus(nonMember.thrown)).toBe(404);
    expect(thrownStatus(nonExistent.thrown)).toBe(404);
    // Neither reached the workspace read: the deny path touches no project DB.
    expect(nonMember.loadWorkspace).toHaveBeenCalledTimes(0);
    expect(nonExistent.loadWorkspace).toHaveBeenCalledTimes(0);
    // Identical by payload shape too (not just status), so no existence oracle
    // can leak even if a future refactor diverges one deny site.
    expect((nonMember.thrown as { data: unknown }).data).toBeNull();
    expect((nonExistent.thrown as { data: unknown }).data).toBeNull();
  });

  it("rejects a malformed (non-UUID) id with a 404 and zero DB/thunk calls", async () => {
    const run = await runGate(principalWith("OWNER"), { id: "not-a-uuid" });

    expect(run.denied).toBe(true);
    expect(thrownStatus(run.thrown)).toBe(404);
    // Rejected before the principal load and before any workspace read.
    expect(run.loadPrincipal).toHaveBeenCalledTimes(0);
    expect(run.loadWorkspace).toHaveBeenCalledTimes(0);
  });

  it("treats a non-canonical (uppercase) UUID as malformed: 404 before any principal load", async () => {
    // Postgres emits lowercase uuids and the gate matches case-sensitively, so an
    // uppercase-form id could never match a membership. It must be rejected as
    // malformed (pre-principal), not pass the guard and then unconditionally deny.
    const run = await runGate(principalWith("OWNER"), {
      id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
    });

    expect(run.denied).toBe(true);
    expect(thrownStatus(run.thrown)).toBe(404);
    expect(run.loadPrincipal).toHaveBeenCalledTimes(0);
    expect(run.loadWorkspace).toHaveBeenCalledTimes(0);
  });

  it("rejects a missing id with a 404 before any principal load", async () => {
    const run = await runGate(principalWith("OWNER"), {});

    expect(run.denied).toBe(true);
    expect(thrownStatus(run.thrown)).toBe(404);
    expect(run.loadPrincipal).toHaveBeenCalledTimes(0);
  });

  it("resolves ONE workspace read under two parallel view loads", async () => {
    // React Router runs the layout loader and the child route's loader in
    // parallel; both go through the same memoised thunk.
    const run = await runGate(principalWith("EDITOR"), { id: PROJECT_ID });
    expect(run.denied).toBe(false);

    const [a, b] = await Promise.all([
      loadProjectView(run.context),
      loadProjectView(run.context),
    ]);

    expect(a.stateView.id).toBe(PROJECT_ID);
    expect(b.stateView.id).toBe(PROJECT_ID);
    // Memoised thunk: parallel loaders share a single round trip.
    expect(run.loadWorkspace).toHaveBeenCalledTimes(1);
  });

  it("HEADLINE: the membership is readable with NO database round trip", async () => {
    // The round-trip reduction rests on this: the write path (and anything else
    // that needs only the role + ids) reads the membership straight off the
    // context, so it never triggers the workspace read at all.
    const run = await runGate(principalWith("EDITOR"), { id: PROJECT_ID });

    const membership = requireProjectMembership(run.context);

    expect(membership).toEqual({
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
      projectRole: "EDITOR",
      tenantRole: "MEMBER",
    });
    expect(run.loadWorkspace).toHaveBeenCalledTimes(0);
  });

  it("HEADLINE: the project name and the route's view come out of ONE read", async () => {
    // The round-trip reduction itself. Before the fold the project row was a
    // query of its own, awaited before the workspace could even be requested, so
    // a document request cost three SEQUENTIAL Neon round trips: principal, then
    // project row, then workspace. Now the row comes out of the workspace
    // header, so a screen that shows the name and a screen that shows the data
    // are the same read and the request costs two.
    const run = await runGate(principalWith("OWNER"), { id: PROJECT_ID });

    const view = await loadProjectView(run.context);

    expect(view.stateView.name).toBe(PROJECT_NAME);
    expect(view.revision).toBe("5");
    expect(run.loadWorkspace).toHaveBeenCalledTimes(1);
  });

  it("scopes the workspace read to the membership's tenant, never the id alone", async () => {
    const run = await runGate(principalWith("OWNER"), { id: PROJECT_ID });

    await requireProjectWorkspace(run.context);

    expect(run.loadWorkspace).toHaveBeenCalledWith(TENANT_ID, PROJECT_ID);
  });

  it("fails closed with the same opaque 404 when the workspace row is gone", async () => {
    // Membership exists but the project was deleted between the check and the
    // read: it must present exactly as a non-member does, payload included.
    const loadPrincipal = vi.fn(async () => principalWith("OWNER"));
    const context = new RouterContextProvider();
    context.set(appContext, { env: fakeEnv(), ctx });
    context.set(principalContext, loadPrincipal);
    const gate = createProjectAccessMiddleware({
      workspaceLoaderFor: () => ({ load: async () => null }),
    });

    await gate(middlewareArgs(context, { id: PROJECT_ID }), async () => new Response(null));

    await expect(requireProjectWorkspace(context)).rejects.toMatchObject({
      init: { status: 404 },
      data: null,
    });
  });
});

/**
 * ASVS scan M3. The gate's RESPONSE deliberately cannot distinguish "not a
 * member" from "no such project" — that is the property being protected. The LOG
 * must distinguish them, because someone walking project ids and someone who
 * just lost access are different operational facts, and the 404 is the same
 * number an ordinary missing page produces.
 */
describe("project access gate — security events", () => {
  function captureWarn(): { readonly lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((value) => String(value)).join(" "));
    });
    return { lines, restore: () => spy.mockRestore() };
  }

  it("records `malformed_project_id` without echoing the rejected value", async () => {
    const captured = captureWarn();
    const run = await runGate(principalWith("OWNER"), { id: "not-a-uuid-<script>" });
    captured.restore();

    expect(run.denied).toBe(true);
    expect(captured.lines).toHaveLength(1);
    const record = JSON.parse(captured.lines[0] ?? "") as Record<string, unknown>;
    expect(record).toMatchObject({
      event: "security_event",
      kind: "project_access_denied",
      reason: "malformed_project_id",
      status: 404,
    });
    // React Router already matched it as `:id`, so the templated route carries
    // the NAME, not the attacker's string — and no principal was loaded, so
    // there is no id to record either.
    //
    // This case is why `documentRoute` decodes: the param React Router hands
    // over is `not-a-uuid-<script>` while the path carries
    // `not-a-uuid-%3Cscript%3E`, so a raw value comparison misses and the
    // attacker's string lands in the log. Measured — it did, before the decode.
    expect(record.route).toBe("/projects/:id/wbs");
    expect(captured.lines.join("\n")).not.toContain("<script>");
    expect(captured.lines.join("\n")).not.toContain("%3Cscript%3E");
    expect(record.principalId).toBeUndefined();
    expect(run.loadPrincipal).not.toHaveBeenCalled();
  });

  it("records `not_a_member` with the principal and the project", async () => {
    const captured = captureWarn();
    const run = await runGate(principalWith(null), { id: UNKNOWN_PROJECT_ID });
    captured.restore();

    expect(run.denied).toBe(true);
    expect(JSON.parse(captured.lines[0] ?? "")).toMatchObject({
      kind: "project_access_denied",
      reason: "not_a_member",
      status: 404,
      principalId: "principal-1",
      projectId: UNKNOWN_PROJECT_ID,
    });
  });

  it("records `project_missing` when the row is gone under a real membership", async () => {
    const context = new RouterContextProvider();
    context.set(appContext, { env: fakeEnv(), ctx });
    context.set(principalContext, vi.fn(async () => principalWith("OWNER")));
    const gate = createProjectAccessMiddleware({
      workspaceLoaderFor: () => ({ load: async () => null }),
    });

    const captured = captureWarn();
    await gate(middlewareArgs(context, { id: PROJECT_ID }), async () => new Response(null));
    await expect(requireProjectWorkspace(context)).rejects.toMatchObject({ init: { status: 404 } });
    captured.restore();

    expect(JSON.parse(captured.lines[0] ?? "")).toMatchObject({
      kind: "project_access_denied",
      reason: "project_missing",
      tenantId: TENANT_ID,
      projectId: PROJECT_ID,
    });
  });

  it("stays silent when access is granted", async () => {
    const captured = captureWarn();
    const run = await runGate(principalWith("EDITOR"), { id: PROJECT_ID });
    await requireProjectWorkspace(run.context);
    captured.restore();

    expect(run.denied).toBe(false);
    expect(captured.lines).toEqual([]);
  });
});

describe("project list loader", () => {
  it("returns exactly the principal's membership projects from an injected source", async () => {
    const principal = principalWith("VIEWER");
    const loadPrincipal = vi.fn(async () => principal);
    const context = new RouterContextProvider();
    context.set(appContext, { env: fakeEnv(), ctx });
    context.set(principalContext, loadPrincipal);

    const projects = [
      { id: PROJECT_ID, tenantId: TENANT_ID, name: "Alpha", role: "VIEWER" as const },
      { id: UNKNOWN_PROJECT_ID, tenantId: TENANT_ID, name: "Beta", role: "OWNER" as const },
    ];
    const listForPrincipal = vi.fn(async () => projects);
    const close = vi.fn(async () => {});
    const source: ProjectListSource = { listForPrincipal, close };

    const result = await loadProjectList(context, { sourceFor: () => source });

    expect(result.projects).toEqual(projects);
    expect(listForPrincipal).toHaveBeenCalledWith("principal-1");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
