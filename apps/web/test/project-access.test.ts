import { RouterContextProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { createProjectAccessMiddleware } from "~/middleware/project-access.server";
import type { AuthenticatedPrincipal } from "~/server/auth/principal-directory";
import {
  loadProjectList,
  type ProjectListSource,
} from "~/server/project/project-list.server";
import {
  requireProjectAccess,
  type ProjectReader,
  type ProjectRow,
} from "~/server/project/project-access";
import { appContext, principalContext } from "~/server/context";
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

const PROJECT_ROW: ProjectRow = {
  id: PROJECT_ID,
  tenantId: TENANT_ID,
  name: "Project 1",
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
  readonly loadProject: ReturnType<typeof vi.fn>;
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
  const loadProject = vi.fn(async () => PROJECT_ROW);
  const childLoader = vi.fn(async () => new Response(null));

  const context = new RouterContextProvider();
  context.set(appContext, { env: fakeEnv(), ctx });
  context.set(principalContext, loadPrincipal);

  const reader: ProjectReader = { loadProject };
  const gate = createProjectAccessMiddleware({ readerFor: () => reader });

  try {
    await gate(middlewareArgs(context, params), childLoader);
    // Framework proceeds to the child loaders once the gate resolves.
    await childLoader();
    return { denied: false, thrown: undefined, context, childLoader, loadPrincipal, loadProject };
  } catch (thrown) {
    return { denied: true, thrown, context, childLoader, loadPrincipal, loadProject };
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

      const { project, membership } = await requireProjectAccess(run.context);
      expect(project).toEqual(PROJECT_ROW);
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
    // Neither reached the project-row fetch: the deny path touches no project DB.
    expect(nonMember.loadProject).toHaveBeenCalledTimes(0);
    expect(nonExistent.loadProject).toHaveBeenCalledTimes(0);
    // Identical by payload shape too (not just status), so no existence oracle
    // can leak even if a future refactor diverges one deny site.
    expect((nonMember.thrown as { data: unknown }).data).toBeNull();
    expect((nonExistent.thrown as { data: unknown }).data).toBeNull();
  });

  it("rejects a malformed (non-UUID) id with a 404 and zero DB/thunk calls", async () => {
    const run = await runGate(principalWith("OWNER"), { id: "not-a-uuid" });

    expect(run.denied).toBe(true);
    expect(thrownStatus(run.thrown)).toBe(404);
    // Rejected before the principal load and before any project-row fetch.
    expect(run.loadPrincipal).toHaveBeenCalledTimes(0);
    expect(run.loadProject).toHaveBeenCalledTimes(0);
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
    expect(run.loadProject).toHaveBeenCalledTimes(0);
  });

  it("rejects a missing id with a 404 before any principal load", async () => {
    const run = await runGate(principalWith("OWNER"), {});

    expect(run.denied).toBe(true);
    expect(thrownStatus(run.thrown)).toBe(404);
    expect(run.loadPrincipal).toHaveBeenCalledTimes(0);
  });

  it("resolves ONE project-row fetch under two parallel requireProjectAccess awaits", async () => {
    const run = await runGate(principalWith("EDITOR"), { id: PROJECT_ID });
    expect(run.denied).toBe(false);

    const [a, b] = await Promise.all([
      requireProjectAccess(run.context),
      requireProjectAccess(run.context),
    ]);

    expect(a.project).toEqual(PROJECT_ROW);
    expect(b.project).toEqual(PROJECT_ROW);
    // Memoised thunk: parallel loaders share a single round trip.
    expect(run.loadProject).toHaveBeenCalledTimes(1);
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
