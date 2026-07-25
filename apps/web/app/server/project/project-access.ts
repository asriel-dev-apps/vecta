import type { RouterContextProvider } from "react-router";
import type {
  ProjectMembership,
  TenantMembership,
} from "../auth/principal-directory";
import { projectAccessContext } from "../context";

/**
 * Project access for the cookie-session surface (ADR 0012 §Decision 2). This
 * module is DB-free on purpose — the same split as the principal directory — so
 * the access gate and its tests can depend on the shapes and the reader seam
 * without importing the persistence layer. The Neon-backed {@link ProjectReader}
 * lives in `project-reader.neon.server.ts`; tests pass a fake.
 */

/** The project row the gate fetches once access is granted (minimal shell fields). */
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

/** Fetch a single project row scoped by its owning tenant. */
export interface ProjectReader {
  loadProject(
    tenantId: string,
    projectId: string,
  ): Promise<ProjectRow | null>;
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
 * Read the resolved project access for a `/projects/:id` loader/action. The
 * layout's access middleware guarantees the membership check has already passed
 * and installs the memoised loader on {@link projectAccessContext}; this awaits
 * it, so parallel loaders share a single project-row fetch.
 */
export async function requireProjectAccess(
  context: Readonly<RouterContextProvider>,
): Promise<ResolvedProjectAccess> {
  const loadAccess = context.get(projectAccessContext);
  return loadAccess();
}
