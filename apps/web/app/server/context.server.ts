import { createContext } from "react-router";
import type { AuthenticatedPrincipal } from "./auth/principal-directory.server";
import type { DbSession } from "./db-session.server";
import type {
  ProjectMembershipView,
  ProjectWorkspaceRecord,
} from "./project/project-access.server";

/**
 * Router context handles shared between the Worker entry (`workers/app.ts`,
 * which seeds them via `getLoadContext`) and the route modules that read them
 * in loaders/actions/middleware. This is the documented React Router v8 pattern
 * for bridging the adapter's `env`/`ctx` into the request lifecycle.
 */

/** The Worker bindings + execution context for the current request. */
export const appContext = createContext<{
  readonly env: Env;
  readonly ctx: ExecutionContext;
}>();

/**
 * The per-request database session (ADR 0012 §4-pre). The root middleware
 * installs it for EVERY request and closes it after the response; it opens a
 * single Neon WebSocket-Pool connection lazily on first use, so a request that
 * reads the principal, the project row, and the workspace shares ONE connection
 * and a DB-free request (e.g. `/login`) opens none. Readers pull the shared
 * connection from here instead of opening one per call.
 */
export const dbSessionContext = createContext<DbSession>();

/**
 * A memoised, per-request loader for the authenticated principal. The auth
 * middleware installs it after verifying the session cookie; calling it more
 * than once (e.g. from several loaders batched by RR single fetch) hits the DB
 * only once. Present only on the protected subtree.
 */
export const principalContext =
  createContext<() => Promise<AuthenticatedPrincipal | null>>();

/**
 * The principal's membership in the current project. The `/projects/:id` layout's
 * access middleware installs it *after* the fail-closed membership check, so a
 * denied request never sets it. It is a plain value, not a thunk: the membership
 * comes from the already-memoised principal, so reading it costs no database
 * round trip. Present only under `/projects/:id`.
 */
export const projectMembershipContext = createContext<ProjectMembershipView>();

/**
 * A memoised, per-request loader for the current project's workspace — the ONE
 * batched read that serves both the project row (the header it already fetches)
 * and the route's state view. Installed by the same access middleware, after the
 * same check, so a denied request never sets it and never touches the project
 * database. The thunk defers the read until a loader/component first asks, and
 * memoises it so the layout loader and its child share one round trip. Present
 * only under `/projects/:id`.
 */
export const projectWorkspaceContext =
  createContext<() => Promise<ProjectWorkspaceRecord>>();
