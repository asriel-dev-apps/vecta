import type { RouterContextProvider } from "react-router";
import type { BaselineSnapshot } from "@vecta/persistence";
import type { ProjectState } from "@vecta/application";
import type {
  ProjectMembership,
  TenantMembership,
} from "../auth/principal-directory.server";
import { projectMembershipContext, projectWorkspaceContext } from "../context.server";

/**
 * Project access for the cookie-session surface (ADR 0012 §Decision 2). This
 * module is DB-free on purpose — the same split as the principal directory — so
 * the access gate and its tests can depend on the shapes and the reader seam
 * without importing the persistence layer. The Neon-backed
 * {@link ProjectWorkspaceLoader} is `@vecta/persistence`'s batched HTTP reader,
 * wired in by the gate middleware; tests pass a fake.
 */

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

/** The workspace snapshot a project route reads: current state + its revision. */
export interface ProjectWorkspaceRecord {
  readonly revision: bigint;
  readonly current: ProjectState;
  /**
   * The latest published baseline, or `null` when the plan has never been frozen
   * (Design 0009). It rides the SAME batch as the rest of the workspace, so it
   * costs no additional round trip — a project document already costs two and the
   * 2026-07-26 fold exists to keep it at two.
   */
  readonly baseline: BaselineSnapshot | null;
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

// `requireProjectAccess` used to sit here, returning `{ project, membership }`
// with the project row taken out of the workspace batch. Its last production
// caller was the dashboard STUB, which read the whole workspace to print one
// project name; the real dashboard (design 0007) reads the workspace for the
// workspace, through the shared `loadProjectView` choke point like every other
// project screen. A convenience wrapper with no callers is a second way to read
// the same thing that no longer earns its keep — screens that want the project
// name take it from their own view payload.
