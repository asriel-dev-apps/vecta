import {
  redirect,
  type MiddlewareFunction,
  type RouterContextProvider,
} from "react-router";
import {
  appContext,
  dbSessionContext,
  principalContext,
} from "~/server/context";
import type {
  AuthenticatedPrincipal,
  PrincipalDirectory,
} from "~/server/auth/principal-directory";
import { createNeonPrincipalDirectory } from "~/server/auth/principal-directory.neon.server";
import { safeReturnTo } from "~/server/auth/redirect";
import { readSessionResult } from "~/server/auth/session.server";
import { writeSecurityEvent } from "~/server/security-log.server";

/**
 * Authentication middleware for the protected route subtree (ADR 0012
 * §Decision 4/5). It runs before any loader on that subtree and:
 *   1. verifies the signed session cookie — pure crypto, NO database — and
 *      rejects an absent/tampered/expired session by redirecting to `/login`
 *      with the current path as `returnTo` (fail-closed);
 *   2. otherwise installs a memoised principal loader on the router context so
 *      the DB is hit at most once per request, no matter how many loaders call
 *      `requirePrincipal` (RR single fetch runs them in parallel).
 *
 * Roles are resolved lazily from the DB, never cached in the cookie, and only
 * for this protected subtree — public routes (`/login`, `/auth/callback`,
 * `/logout`) live outside it and never trigger a lookup.
 *
 * `directoryFor` is injectable so tests can supply a fake directory; production
 * defaults to the Neon-backed one built over the per-request session from
 * context. The directory is resolved lazily inside the memoised thunk, so a
 * request that never reaches `requirePrincipal` (e.g. the project gate rejects a
 * malformed id first) never opens a connection.
 */
export interface AuthMiddlewareOptions {
  readonly directoryFor?: (
    context: Readonly<RouterContextProvider>,
  ) => PrincipalDirectory;
}

function directoryFromContext(
  context: Readonly<RouterContextProvider>,
): PrincipalDirectory {
  return createNeonPrincipalDirectory(context.get(dbSessionContext));
}

export function createAuthMiddleware(
  options: AuthMiddlewareOptions = {},
): MiddlewareFunction<Response> {
  const directoryFor = options.directoryFor ?? directoryFromContext;
  return async ({ request, context, params }) => {
    const { env } = context.get(appContext);
    const result = await readSessionResult(env, request);
    if (!result.ok) {
      // ASVS scan M3. This denial answers 302, not 401, so the operational
      // signal `monitoring-and-alerts.md` asks for cannot be derived from the
      // status — every unauthenticated visit to a protected path looks like an
      // ordinary redirect. The record is what makes it countable, and the
      // reason is what separates a crawler from a forged cookie.
      writeSecurityEvent({
        kind: "session_rejected",
        reason: result.reason,
        status: 302,
        request,
        params,
      });
      const url = new URL(request.url);
      const returnTo = safeReturnTo(url.pathname + url.search);
      throw redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
    }
    const { session } = result;
    let cached: Promise<AuthenticatedPrincipal | null> | undefined;
    context.set(
      principalContext,
      () =>
        (cached ??= directoryFor(context)
          .loadPrincipal(session.principalId)
          .then((principal) => {
            // A signed, unexpired session whose principal has been deleted or
            // disabled — a revocation taking effect, or a stale session against
            // a wiped directory. `requirePrincipal` turns this into a redirect;
            // it is logged HERE because this is where the request (and so the
            // route and request id) is in scope.
            if (principal === null) {
              writeSecurityEvent({
                kind: "principal_revoked",
                reason: "principal_missing",
                status: 302,
                request,
                params,
                principalId: session.principalId,
              });
            }
            return principal;
          })),
    );
  };
}
