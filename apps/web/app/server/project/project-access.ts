import type { RouterContextProvider } from "react-router";
import type { ProjectState } from "@vecta/application";
import type {
  ProjectMembership,
  TenantMembership,
} from "../auth/principal-directory";
import { projectMembershipContext, projectWorkspaceContext } from "../context";

/**
 * Project access for the cookie-session surface (ADR 0012 §Decision 2). This
 * module is DB-free on purpose — the same split as the principal directory — so
 * the access gate and its tests can depend on the shapes and the reader seam
 * without importing the persistence layer. The Neon-backed
 * {@link ProjectWorkspaceLoader} is `@vecta/persistence`'s batched HTTP reader,
 * wired in by the gate middleware; tests pass a fake.
 */

/** The project row a loader/component reads (minimal shell fields). */
export interface ProjectRow {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
}

/**
 * The principal's membership as surfaced to loaders. `projectRole` drives the
 * Step-4 read/command projection; `tenantRole` is carried when the memoised
 * principal already provides it (it does — `loadPrincipal` loads tenant
 * memberships), at no extra query.
 */
export interface ProjectMembershipView {
  readonly tenantId: string;
  readonly projectId: string;
  readonly projectRole: ProjectMembership["role"];
  readonly tenantRole?: TenantMembership["role"];
}

/** The resolved access grant a loader/component reads for the current project. */
export interface ResolvedProjectAccess {
  readonly project: ProjectRow;
  readonly membership: ProjectMembershipView;
}

/** The workspace snapshot a project route reads: current state + its revision. */
export interface ProjectWorkspaceRecord {
  readonly revision: bigint;
  readonly current: ProjectState;
}

/** The persistence seam the gate reads the workspace through (fakeable in tests). */
export interface ProjectWorkspaceLoader {
  load(
    tenantId: string,
    projectId: string,
  ): Promise<ProjectWorkspaceRecord | null>;
}

// Canonical lowercase only (no `i` flag): Postgres emits lowercase uuids, and
// the gate matches `projectId` case-sensitively against them. Accepting an
// uppercase form here would pass the guard yet never match a membership — a
// member's case-mangled link would 404 *after* a needless principal load. So a
// non-canonical uuid is treated as malformed and rejected before any DB work.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Is `value` a syntactically valid (canonical, lowercase) UUID — the shape of
 * every project id? Guards the access gate so a non-UUID `:id` is rejected
 * before any principal load or database round trip.
 */
export function isProjectId(value: string | undefined): value is string {
  return value !== undefined && UUID_PATTERN.test(value);
}

/**
 * The principal's membership in the current project — SYNCHRONOUS, because it is
 * derived entirely from the already-memoised principal. The gate middleware puts
 * it on the context *after* the fail-closed membership check, so reaching this at
 * all means access was granted. Costs no database round trip, which is why the
 * command action (which needs only the role and the tenant/project ids) uses it
 * instead of {@link requireProjectAccess}.
 */
export function requireProjectMembership(
  context: Readonly<RouterContextProvider>,
): ProjectMembershipView {
  return context.get(projectMembershipContext);
}

/**
 * The current project's workspace — the ONE batched read every project route
 * shares. The gate installs it as a memoised thunk, so the layout loader and its
 * child loader (which React Router runs in parallel) resolve a single round trip
 * between them, and a route that never asks issues no query at all.
 */
export function requireProjectWorkspace(
  context: Readonly<RouterContextProvider>,
): Promise<ProjectWorkspaceRecord> {
  return context.get(projectWorkspaceContext)();
}

/**
 * Read the resolved project access for a `/projects/:id` loader/component. The
 * layout's access middleware guarantees the membership check has already passed;
 * the project row itself comes out of the shared workspace read rather than a
 * query of its own, so asking for it costs no round trip beyond the one the
 * route was going to make anyway (the header the workspace batch already
 * fetches IS the project row).
 */
export async function requireProjectAccess(
  context: Readonly<RouterContextProvider>,
): Promise<ResolvedProjectAccess> {
  const membership = requireProjectMembership(context);
  const workspace = await requireProjectWorkspace(context);
  return {
    project: {
      id: workspace.current.id,
      tenantId: membership.tenantId,
      name: workspace.current.name,
    },
    membership,
  };
}
