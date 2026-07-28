import {
  data,
  type MiddlewareFunction,
  type RouterContextProvider,
} from "react-router";
import { NeonHttpProjectWorkspaceReader } from "@vecta/persistence";
import { findProjectMembership } from "~/server/auth/principal-directory";
import { requirePrincipal } from "~/server/auth/require-principal";
import {
  dbSessionContext,
  projectMembershipContext,
  projectWorkspaceContext,
} from "~/server/context";
import {
  isProjectId,
  type ProjectWorkspaceLoader,
  type ProjectWorkspaceRecord,
} from "~/server/project/project-access";
import { writeSecurityEvent } from "~/server/security-log.server";

/**
 * The `/projects/:id` access gate (ADR 0012 §Decision 2), enforced as MIDDLEWARE
 * so the denial `throw` happens BEFORE `next()` — no child loader ever runs for a
 * request the principal may not see (the security property a parent loader could
 * not provide). It:
 *   1. rejects a non-UUID `:id` before any principal load or DB round trip;
 *   2. awaits the memoised principal (which carries its project memberships);
 *   3. finds the membership via the shared pure {@link findProjectMembership};
 *   4. throws an identical `404` for a non-member OR a nonexistent project — the
 *      two are indistinguishable by design — and only then, on success, publishes
 *      the membership and a lazily-memoised workspace loader on the context.
 *
 * VIEWER passes the gate (read access); denial means *no membership*.
 * Write-authorization is the Step-4 command authorizer, not this gate. The
 * cookie session uses this in-memory check rather than
 * `PostgresProjectAccessGrantResolver` (the token-identity seam for Step 5's
 * Hono surface): it is exact-equivalent here and costs zero extra round trips.
 *
 * The project row is NOT read separately. The workspace batch's header query IS
 * the project row (same composite `(tenantId, id)` scope, same fail-closed 404
 * when it is gone), so folding the two collapses a document request from three
 * sequential Neon round trips to two: principal, then workspace. A route that
 * needs only the membership (the command action) reads it straight off the
 * context and issues none of its own.
 *
 * `workspaceLoaderFor` is injectable so tests can supply a fake; production
 * defaults to the batched Neon HTTP reader built over the per-request session
 * from context. The loader is resolved lazily inside the memoised thunk, so a
 * denied request never touches the project database.
 */
export interface ProjectAccessMiddlewareOptions {
  readonly workspaceLoaderFor?: (
    context: Readonly<RouterContextProvider>,
  ) => ProjectWorkspaceLoader;
}

function workspaceLoaderFromContext(
  context: Readonly<RouterContextProvider>,
): ProjectWorkspaceLoader {
  return new NeonHttpProjectWorkspaceReader(context.get(dbSessionContext).read());
}

export function createProjectAccessMiddleware(
  options: ProjectAccessMiddlewareOptions = {},
): MiddlewareFunction<Response> {
  const workspaceLoaderFor =
    options.workspaceLoaderFor ?? workspaceLoaderFromContext;
  return async ({ context, params, request }) => {
    const projectId = params.id;
    if (!isProjectId(projectId)) {
      // No principal has been loaded yet (deliberately — a malformed id must not
      // cost a DB round trip), so there is no id to record. The rejected value is
      // attacker-chosen and is NOT echoed: `documentRoute` templates it away
      // because React Router already matched it as `:id`.
      writeSecurityEvent({
        kind: "project_access_denied",
        reason: "malformed_project_id",
        status: 404,
        request,
        params,
      });
      throw data(null, { status: 404 });
    }
    const principal = await requirePrincipal(context);
    const membership = findProjectMembership(principal, projectId);
    if (membership === null) {
      // The response cannot distinguish "not a member" from "no such project" —
      // that is the gate's design. The LOG can, and must: the two have different
      // operational meanings (someone probing ids vs. someone who lost access).
      writeSecurityEvent({
        kind: "project_access_denied",
        reason: "not_a_member",
        status: 404,
        request,
        params,
        principalId: principal.principal.id,
        projectId,
      });
      throw data(null, { status: 404 });
    }
    const tenantRole = principal.tenantMemberships.find(
      (tenant) => tenant.tenantId === membership.tenantId,
    )?.role;
    // Access granted. The membership needs no query — it came off the principal
    // that was already loaded — so it is published as a plain value.
    context.set(projectMembershipContext, {
      tenantId: membership.tenantId,
      projectId: membership.projectId,
      projectRole: membership.role,
      ...(tenantRole !== undefined ? { tenantRole } : {}),
    });
    // Install the memoised workspace thunk; it issues no query (and does not even
    // resolve the loader) until a loader/component first asks, then caches it so
    // the parallel layout + child loaders share one round trip. The deny paths
    // above never reach here, so a denied request touches no project database.
    let cached: Promise<ProjectWorkspaceRecord> | undefined;
    context.set(
      projectWorkspaceContext,
      () =>
        (cached ??= workspaceLoaderFor(context)
          .load(membership.tenantId, projectId)
          .then((workspace): ProjectWorkspaceRecord => {
            if (workspace === null) {
              // Membership exists but the project row is gone: fail closed, with
              // the gate's own opaque 404 rather than a 500.
              writeSecurityEvent({
                kind: "project_access_denied",
                reason: "project_missing",
                status: 404,
                request,
                params,
                principalId: principal.principal.id,
                tenantId: membership.tenantId,
                projectId,
              });
              throw data(null, { status: 404 });
            }
            return workspace;
          })),
    );
  };
}
