import { createContext } from "react-router";
import type { AuthenticatedPrincipal } from "./auth/principal-directory";
import type { DbSession } from "./db-session.server";
import type { ResolvedProjectAccess } from "./project/project-access";

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
 * A memoised, per-request loader for the current project's access grant (the
 * resolved project row + the principal's membership). The `/projects/:id`
 * layout's access middleware installs it *after* the fail-closed membership
 * check, so a denied request never sets it and never touches the database. The
 * thunk itself defers the single project-row fetch until a loader/component
 * first calls `requireProjectAccess`, and memoises it so parallel loaders share
 * one round trip. Present only under `/projects/:id`.
 */
export const projectAccessContext =
  createContext<() => Promise<ResolvedProjectAccess>>();
