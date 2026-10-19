import {
  AgentPlanApprovalRequiredError,
  createProjectCommandAuthorizer,
  createProjectCommandService,
  IdempotencyConflictError,
  ProjectAccessDeniedError,
  ProjectCommandValidationError,
  ProjectNotFoundError,
  ProjectVersionConflictError,
  type AuthenticatedIdentity,
  type ProjectAccessGrant,
  type ProjectAccessGrantResolver,
  type ProjectCommand,
  type ProjectCommandUnitOfWork,
  type ProjectRole,
} from "@vecta/application";
import {
  PostgresProjectCommandUnitOfWork,
  type PersistenceDatabase,
} from "@vecta/persistence";
import type { DbSession } from "../db-session.server";

/**
 * ADR 0012 Step 4b — the WBS write-path action core, shaped as a plain server
 * function so Step 5's Hono surface mounts it unchanged (NO React Router import).
 *
 * It mirrors `apps/web`'s `worker.ts` `projectSessionFromDatabase`: build the
 * command service (over the shared per-request DB session) + the command
 * authorizer, AUTHORIZE the actor here (the session principal is the actor —
 * writes are authorized in this core, not by the `/projects/:id` shell gate,
 * which only grants read access), then execute the operation through the service
 * once. It NEVER closes the session — the 4-pre root middleware owns the
 * connection lifecycle (`close()` in a `finally` after the response), so this
 * function leaks nothing.
 *
 * The cookie-session surface already knows the principal (id + type) and the
 * resolved project role, so authorization uses an in-memory grant resolver
 * rather than the identity-keyed `PostgresProjectAccessGrantResolver` — the same
 * exact-equivalent, zero-extra-round-trip choice the `/projects/:id` access
 * middleware documents. This equivalence holds only under the data invariant the
 * Postgres resolver relies on: the resolved `projectRole` comes from a live tenant
 * membership row with `disabledAt IS NULL` (the shell gate's membership read), so
 * an in-memory grant carrying that role is identical to what
 * `PostgresProjectAccessGrantResolver` would return. The Postgres resolver stays
 * the Step-5 token-identity seam.
 */

/** The audit actor for a command batch: the authenticated session principal. */
export interface CommandActor {
  readonly principalId: string;
  readonly principalType: "HUMAN" | "AGENT";
}

export interface ApplyCommandsInput {
  readonly session: DbSession;
  readonly tenantId: string;
  readonly projectId: string;
  /** Client-minted id of this one operation. A replay of the same id is one revision. */
  readonly operationId: string;
  readonly commands: readonly ProjectCommand[];
  /** The confirmed revision the operation is applied on top of. */
  readonly expectedRevision: bigint;
  /**
   * The cookie surface's already-known actor. Present with {@link projectRole}
   * to build the in-memory-grant default; the token surface omits both and
   * injects {@link ApplyCommandsDeps.identity} + {@link ApplyCommandsDeps.grantResolver}
   * instead (the actor is then derived from the resolved grant).
   */
  readonly actor?: CommandActor;
  /** The actor's resolved project role (from the shell gate's membership). */
  readonly projectRole?: ProjectRole;
}

/**
 * A typed batch outcome. Conflicts and denials are RETURNED, not thrown, so the
 * route can map them to `data(..., { status })` and the Hono surface to a JSON
 * error — neither path relies on exception propagation for the expected cases.
 */
export type ApplyCommandsResult =
  | { readonly ok: true; readonly revision: bigint }
  | { readonly ok: false; readonly code: "VERSION_CONFLICT"; readonly actualRevision: bigint }
  // `reason` is present ONLY for the agent-plan-approval denial, so the cookie
  // surface's ordinary access-denied result stays `{ ok: false, code: "FORBIDDEN" }`
  // byte-identical; the token surface reads `reason` to distinguish the stable
  // `AGENT_APPROVAL_REQUIRED` REST error from `PROJECT_ACCESS_DENIED`.
  | { readonly ok: false; readonly code: "FORBIDDEN"; readonly reason?: "AGENT_APPROVAL_REQUIRED" }
  | { readonly ok: false; readonly code: "NOT_FOUND" }
  | { readonly ok: false; readonly code: "INVALID"; readonly message: string };

export interface ApplyCommandsDeps {
  /**
   * Build the unit of work over the request's database handle. Production wraps
   * the shared session's Postgres UoW; tests inject an in-memory fake so the
   * core is exercised with no real database.
   */
  readonly unitOfWorkFor?: (database: PersistenceDatabase) => ProjectCommandUnitOfWork;
  /**
   * The verified caller identity (ADR 0012 Step 5 — the token surface's half of
   * the identity/grant seam). Absent for the cookie surface, which derives the
   * documented stub identity from the input {@link CommandActor}.
   */
  readonly identity?: AuthenticatedIdentity;
  /**
   * The grant resolver the authorizer runs against. The token surface injects a
   * `PostgresProjectAccessGrantResolver` over the request `DbSession` (so AGENT
   * scopes in `grant.allowedScopes` and the `(issuer,subject)`+`email:` fallback
   * are consulted); absent for the cookie surface, which builds the in-memory
   * grant from the input {@link CommandActor} + {@link ApplyCommandsInput.projectRole}.
   */
  readonly grantResolver?: ProjectAccessGrantResolver;
}

/**
 * An in-memory {@link ProjectAccessGrantResolver} that returns the already-known
 * grant for the session principal. `createProjectCommandAuthorizer` still runs
 * the full role check (only OWNER/EDITOR may write; VIEWER is denied) and the
 * agent-plan rules against this grant.
 */
function cookieGrantResolver(
  actor: CommandActor | undefined,
  projectRole: ProjectRole | undefined,
): ProjectAccessGrantResolver {
  if (actor === undefined || projectRole === undefined) {
    throw new Error(
      "applyCommands requires actor + projectRole unless a grantResolver is injected",
    );
  }
  const grant: ProjectAccessGrant = {
    principalId: actor.principalId,
    principalType: actor.principalType,
    projectRole,
    // Cookie-session principals are humans (the provisioning contract forbids a
    // human carrying agent scopes), so the write scopes are empty; the authorizer
    // reads them only on the AGENT branch.
    allowedScopes: [],
  };
  return { resolve: async () => grant };
}

/**
 * Wrap a grant resolver so a whole batch shares ONE resolution.
 * `createProjectCommandAuthorizer` resolves the grant once per command, but the
 * resolve key `(identity, tenantId, projectId)` is constant across a batch, so
 * the injected `PostgresProjectAccessGrantResolver` would otherwise run ~N
 * identical authz queries for an N-command batch. The per-request memo collapses
 * them to a single DB round trip; every command is still authorized against the
 * resolved grant because the role check and the per-command agent-scope/plan-field
 * rules run in the authorizer against each command, not in the resolver.
 */
function memoizeGrantResolver(
  resolver: ProjectAccessGrantResolver,
): ProjectAccessGrantResolver {
  const cache = new Map<string, Promise<ProjectAccessGrant | null>>();
  return {
    resolve(request) {
      const key = JSON.stringify([
        request.identity.issuer,
        request.identity.subject,
        request.identity.email ?? null,
        request.tenantId,
        request.projectId,
      ]);
      let pending = cache.get(key);
      if (pending === undefined) {
        pending = resolver.resolve(request);
        cache.set(key, pending);
      }
      return pending;
    },
  };
}

/**
 * The stub identity for the cookie surface: the in-memory resolver returns its
 * grant regardless of it, so its content is never inspected (the Postgres
 * resolver the token surface injects would key on it instead).
 */
function cookieStubIdentity(actor: CommandActor | undefined): AuthenticatedIdentity {
  if (actor === undefined) {
    throw new Error("applyCommands requires actor unless an identity is injected");
  }
  return { issuer: "cookie-session", subject: actor.principalId, scopes: [] };
}

export async function applyCommands(
  input: ApplyCommandsInput,
  deps: ApplyCommandsDeps = {},
): Promise<ApplyCommandsResult> {
  const { session, actor, tenantId, projectId, projectRole, commands, expectedRevision, operationId } =
    input;
  const unitOfWorkFor =
    deps.unitOfWorkFor ?? ((database) => new PostgresProjectCommandUnitOfWork(database));

  // The identity/grant seam (ADR 0012 Step 5, finding 2). The token surface
  // injects a verified identity + a Postgres grant resolver; the cookie surface
  // injects neither and gets today's documented in-memory grant + stub identity,
  // so its behaviour is byte-identical to before the seam existed.
  // The injected (token-surface Postgres) resolver is memoized per request so a
  // multi-command batch drives ONE authz resolution, not one per command. The
  // cookie surface's in-memory resolver is left unwrapped (its resolve is a
  // constant, so its path stays byte-identical).
  const grantResolver =
    deps.grantResolver === undefined
      ? cookieGrantResolver(actor, projectRole)
      : memoizeGrantResolver(deps.grantResolver);
  const identity = deps.identity ?? cookieStubIdentity(actor);

  const authorizer = createProjectCommandAuthorizer(grantResolver);
  const service = createProjectCommandService(unitOfWorkFor(session.database()));

  try {
    // Authorize every command BEFORE executing any, so a denied actor persists
    // nothing (fail-closed): the operation is all-or-none on the authorization gate.
    const actors = [];
    for (const command of commands) {
      actors.push(await authorizer.authorize({ identity, tenantId, projectId, command }));
    }
    const auditActor = actors[0];
    if (auditActor === undefined) {
      return { ok: false, code: "INVALID", message: "Project command envelope is invalid" };
    }

    // One call, one transaction, one revision. A failure inside it leaves no
    // revision, receipt, audit row or change record.
    const result = await service.execute({
      tenantId,
      projectId,
      expectedRevision,
      operationId,
      actor: auditActor,
      commands,
    });
    return { ok: true, revision: result.revision };
  } catch (error) {
    if (error instanceof ProjectVersionConflictError) {
      return { ok: false, code: "VERSION_CONFLICT", actualRevision: error.actualRevision };
    }
    if (error instanceof AgentPlanApprovalRequiredError) {
      // An AGENT tried to change a plan field: distinct from a plain access
      // denial so the token surface can surface the stable AGENT_APPROVAL_REQUIRED
      // REST error. The cookie surface never inspects `reason`, so its FORBIDDEN
      // handling is unchanged.
      return { ok: false, code: "FORBIDDEN", reason: "AGENT_APPROVAL_REQUIRED" };
    }
    if (error instanceof ProjectAccessDeniedError) {
      return { ok: false, code: "FORBIDDEN" };
    }
    if (error instanceof ProjectNotFoundError) {
      return { ok: false, code: "NOT_FOUND" };
    }
    if (
      error instanceof IdempotencyConflictError ||
      error instanceof ProjectCommandValidationError
    ) {
      // An idempotency key reused for a different command, or a domain-validation
      // failure — both are unprocessable input with nothing committed.
      return { ok: false, code: "INVALID", message: error.message };
    }
    throw error;
  }
}
