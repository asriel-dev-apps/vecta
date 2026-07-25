import {
  createProjectQueryAuthorizer,
  projectionRoleForProjectRole,
  projectWorkspaceView,
  type AuthenticatedIdentity,
  type ProjectAccessGrantResolver,
  type ProjectCommandUnitOfWork,
  type ProjectState,
  type ProjectStateView,
} from "@vecta/application";
import type { AccessibleProject, PersistenceDatabase } from "@vecta/persistence";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { DbSession } from "../db-session.server";
import { applyCommands } from "../project/apply-commands.server";
import {
  CommandBatchSchema,
  RevisionSchema,
  UuidSchema,
  toCommand,
} from "~/wbs/project-command-contract";
import { AuthenticationRequiredError } from "./oidc-auth";
import { errorName, rateLimitedResponse, RequestRateLimitedError } from "./edge-security";
import { resolveProjectCommandError } from "./project-command-error";

/**
 * The token-auth `/api` surface over the command core (ADR 0012 Step 5a). A
 * `@hono/zod-openapi` app ported from `apps/web/src/api.ts`, retargeted at the
 * batch write core (`applyCommands`) and the shared per-request `DbSession`. It
 * is React-Router-import-free so it can be mounted from the Worker entry without
 * dragging in the RR pipeline. Persistence, auth, and the session lifecycle are
 * injected via {@link ApiDeps} so the whole surface is exercised in tests with a
 * local JWKS + in-memory fakes and no network.
 */

/** A per-request workspace read (the persistence seam the read path loads through). */
export interface ApiWorkspaceLoader {
  load(
    tenantId: string,
    projectId: string,
  ): Promise<{ readonly revision: bigint; readonly current: ProjectState } | null>;
}

/** A per-request identity-keyed accessible-project list (the `/api/projects` seam). */
export interface ApiProjectListReader {
  listForIdentity(identity: AuthenticatedIdentity): Promise<readonly AccessibleProject[]>;
}

/**
 * The persistence seam for the `/api` surface, built per request over the shared
 * {@link DbSession}. Production wires the Postgres implementations; tests inject
 * in-memory fakes. `unitOfWorkFor` is threaded into `applyCommands`; when absent,
 * `applyCommands` builds the Postgres unit of work over the session itself.
 */
export interface ApiPersistence {
  grantResolver(session: DbSession): ProjectAccessGrantResolver;
  workspace(session: DbSession): ApiWorkspaceLoader;
  listReader(session: DbSession): ApiProjectListReader;
  readonly unitOfWorkFor?: (database: PersistenceDatabase) => ProjectCommandUnitOfWork;
}

export interface ApiDeps {
  /** Verify the Bearer token → identity (and enforce the authed rate limit in prod). */
  authenticate(request: Request, env: Env): Promise<AuthenticatedIdentity>;
  /** Open the per-request DB session; the Hono session middleware closes it. */
  createSession(env: Env): DbSession;
  readonly persistence: ApiPersistence;
}

type ApiVariables = {
  identity: AuthenticatedIdentity;
  dbSession: DbSession;
};

const CalendarSchema = z.object({
  id: z.string(),
  name: z.string(),
  workingWeekdays: z.array(z.number().int()),
  nonWorkingDates: z.array(z.iso.date()),
});

// dailyCapacityMinutes is a privileged-only field: the general read model omits
// the key entirely (⑦ / ADR 0011 D18), so the response contract marks it
// optional rather than nullable.
const MemberResponseSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  calendarId: z.string(),
  dailyCapacityMinutes: z.number().int().optional(),
});

const DependencyResponseSchema = z.object({
  predecessorId: UuidSchema,
  type: z.enum(["FS", "SS", "FF", "SF"]),
  lagWorkingDays: z.number().int(),
});

const MasterResponseSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  sortOrder: z.number().int(),
});

const TemplateStepResponseSchema = z.object({
  name: z.string(),
  weightBp: z.number().int(),
  dependsOnPrev: z
    .object({
      type: z.enum(["FS", "SS", "FF", "SF"]),
      lagWorkingDays: z.number().int(),
    })
    .optional(),
});

const TemplateResponseSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  sortOrder: z.number().int(),
  subtasks: z.array(TemplateStepResponseSchema),
});

const TaskResponseSchema = z.object({
  id: UuidSchema,
  parentId: UuidSchema.nullable(),
  sortOrder: z.number().int(),
  seq: z.number().int(),
  name: z.string(),
  processId: UuidSchema.nullable(),
  productId: UuidSchema.nullable(),
  note: z.string(),
  contract: z.string(),
  assigneeMemberId: UuidSchema.nullable(),
  plannedEffortMinutes: z.number().int(),
  progressBasisPoints: z.number().int(),
  actualEffortMinutes: z.number().int(),
  dailyPlan: z.record(z.iso.date(), z.number()),
  actualStart: z.iso.date().nullable(),
  actualFinish: z.iso.date().nullable(),
  dependencies: z.array(DependencyResponseSchema),
});

const ProjectStateResponseSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  projectStart: z.iso.date(),
  statusDate: z.iso.date(),
  currency: z.literal("JPY"),
  defaultCalendarId: z.string(),
  calendars: z.array(CalendarSchema),
  members: z.array(MemberResponseSchema),
  processes: z.array(MasterResponseSchema),
  products: z.array(MasterResponseSchema),
  templates: z.array(TemplateResponseSchema),
  tasks: z.array(TaskResponseSchema),
  nextTaskSeq: z.number().int(),
});

const WorkspaceResponseSchema = z
  .object({ revision: RevisionSchema, current: ProjectStateResponseSchema })
  .openapi("ProjectWorkspaceResponse");

const ProjectListItemSchema = z.object({
  id: UuidSchema,
  tenantId: UuidSchema,
  name: z.string(),
  role: z.enum(["OWNER", "EDITOR", "VIEWER"]),
});

const ProjectListResponseSchema = z
  .object({ projects: z.array(ProjectListItemSchema) })
  .openapi("ProjectListResponse");

const CommandBatchResponseSchema = z
  .object({ projectId: UuidSchema, revision: RevisionSchema })
  .openapi("ProjectCommandBatchResponse");

const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      expectedRevision: RevisionSchema.optional(),
      actualRevision: RevisionSchema.optional(),
    }),
  })
  .openapi("ErrorResponse");

// Exported so the `/mcp` `get_project` tool serializes the role-scoped view with
// the SAME codec as `/api` (ADR 0012 Step 5b): both read paths run the projection
// choke point `projectWorkspaceView` and this serializer, so the GENERAL-view
// `dailyCapacityMinutes` omission (D18) can never fork between the two mouths.
export function projectStateResponse(
  project: ProjectStateView,
): z.infer<typeof ProjectStateResponseSchema> {
  return {
    id: project.id,
    name: project.name,
    projectStart: project.projectStart,
    statusDate: project.statusDate,
    currency: project.currency,
    defaultCalendarId: project.defaultCalendarId,
    calendars: project.calendars.map((calendar) => ({
      id: calendar.id,
      name: calendar.name,
      workingWeekdays: [...calendar.workingWeekdays],
      nonWorkingDates: [...calendar.nonWorkingDates],
    })),
    // Spread keeps the general member absent of dailyCapacityMinutes: the view
    // has already removed the key, so it never reaches the JSON response.
    members: project.members.map((member) => ({ ...member })),
    processes: project.processes.map((process) => ({ ...process })),
    products: project.products.map((product) => ({ ...product })),
    templates: project.templates.map((template) => ({
      id: template.id,
      name: template.name,
      sortOrder: template.sortOrder,
      subtasks: template.subtasks.map((step) => ({
        name: step.name,
        weightBp: step.weightBp,
        ...(step.dependsOnPrev === undefined ? {} : { dependsOnPrev: { ...step.dependsOnPrev } }),
      })),
    })),
    tasks: project.tasks.map((task) => ({
      id: task.id,
      parentId: task.parentId,
      sortOrder: task.sortOrder,
      seq: task.seq,
      name: task.name,
      processId: task.processId,
      productId: task.productId,
      note: task.note,
      contract: task.contract,
      assigneeMemberId: task.assigneeMemberId,
      plannedEffortMinutes: task.plannedEffortMinutes,
      progressBasisPoints: task.progressBasisPoints,
      actualEffortMinutes: task.actualEffortMinutes,
      dailyPlan: { ...task.dailyPlan },
      actualStart: task.actualStart,
      actualFinish: task.actualFinish,
      dependencies: task.dependencies.map((dependency) => ({ ...dependency })),
    })),
    nextTaskSeq: project.nextTaskSeq,
  };
}

// Path params are built with this module's (`@hono/zod-openapi`) `z` — NOT the
// shared contract's `UuidSchema` — because only this `z` carries the `.openapi()`
// extension needed to name a path parameter. The UUID validation is identical.
const projectPathParams = z.object({
  tenantId: z.string().uuid().openapi({ param: { name: "tenantId", in: "path" } }),
  projectId: z.string().uuid().openapi({ param: { name: "projectId", in: "path" } }),
});

const projectsRoute = createRoute({
  method: "get",
  path: "/api/projects",
  security: [{ OidcBearer: [] }],
  responses: {
    200: { description: "Accessible projects for the authenticated identity", content: { "application/json": { schema: ProjectListResponseSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponseSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

const workspaceRoute = createRoute({
  method: "get",
  path: "/api/tenants/{tenantId}/projects/{projectId}",
  security: [{ OidcBearer: [] }],
  request: {
    params: projectPathParams,
  },
  responses: {
    200: { description: "Persisted Current workspace (role-scoped)", content: { "application/json": { schema: WorkspaceResponseSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponseSchema } } },
    403: { description: "Authenticated identity cannot read the project", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "Project not found", content: { "application/json": { schema: ErrorResponseSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

const commandRoute = createRoute({
  method: "post",
  path: "/api/tenants/{tenantId}/projects/{projectId}/commands",
  security: [{ OidcBearer: [] }],
  request: {
    params: projectPathParams,
    body: {
      required: true,
      content: { "application/json": { schema: CommandBatchSchema } },
    },
  },
  responses: {
    200: { description: "Batch executed (revisions chained server-side)", content: { "application/json": { schema: CommandBatchResponseSchema } } },
    400: { description: "Malformed request", content: { "application/json": { schema: ErrorResponseSchema } } },
    401: { description: "Authentication required", content: { "application/json": { schema: ErrorResponseSchema } } },
    403: { description: "Authenticated identity is not permitted to run the batch", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "Project not found", content: { "application/json": { schema: ErrorResponseSchema } } },
    409: { description: "Revision conflict", content: { "application/json": { schema: ErrorResponseSchema } } },
    413: { description: "Request body is too large", content: { "application/json": { schema: ErrorResponseSchema } } },
    422: { description: "Batch violates project invariants", content: { "application/json": { schema: ErrorResponseSchema } } },
    500: { description: "Internal server error", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

export function createApiApp(deps: ApiDeps) {
  const app = new OpenAPIHono<{ Bindings: Env; Variables: ApiVariables }>({
    // Auth runs BEFORE validation (see the middleware order below), so a
    // validation failure here can only mean an authenticated-but-malformed body.
    defaultHook: (result, context) => {
      if (!result.success) {
        return context.json(
          { error: { code: "REQUEST_INVALID", message: "Request validation failed" } },
          400,
        );
      }
    },
  });

  app.openAPIRegistry.registerComponent("securitySchemes", "OidcBearer", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description: "OIDC access token issued for the VECTA API audience",
  });

  app.get("/api/health", (context) => context.json({ service: "vecta", status: "ok" }));

  // The protected subtree. Order is load-bearing: the session opens first (lazy,
  // so a 401 opens no connection) and closes in a `finally` even when auth or a
  // handler throws; auth then runs BEFORE the zod-openapi validators, so every
  // rejection is a uniform 401 that never parses (much less trusts) the body. A
  // session cookie is never read here — the token is the only credential.
  for (const path of ["/api/projects", "/api/tenants/*"]) {
    app.use(path, async (context, next) => {
      const session = deps.createSession(context.env);
      context.set("dbSession", session);
      try {
        await next();
      } finally {
        await session.close();
      }
    });
    app.use(path, async (context, next) => {
      const identity = await deps.authenticate(context.req.raw, context.env);
      context.set("identity", identity);
      await next();
    });
  }

  app.use(
    "/api/tenants/:tenantId/projects/:projectId/commands",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (context) =>
        context.json(
          { error: { code: "BODY_TOO_LARGE", message: "Request body exceeds 64 KiB" } },
          413,
        ),
    }),
  );

  app.openapi(projectsRoute, async (context) => {
    const identity = context.get("identity");
    const session = context.get("dbSession");
    const projects = await deps.persistence.listReader(session).listForIdentity(identity);
    return context.json(
      {
        projects: projects.map((project) => ({
          id: project.id,
          tenantId: project.tenantId,
          name: project.name,
          role: project.role,
        })),
      },
      200,
    );
  });

  app.openapi(workspaceRoute, async (context) => {
    const { tenantId, projectId } = context.req.valid("param");
    const identity = context.get("identity");
    const session = context.get("dbSession");
    // A denial and a nonexistent project both resolve to no grant → the same
    // ProjectAccessDeniedError → the same 403 (no existence oracle).
    const grant = await createProjectQueryAuthorizer(
      deps.persistence.grantResolver(session),
    ).authorize({ identity, tenantId, projectId });
    const workspace = await deps.persistence.workspace(session).load(tenantId, projectId);
    if (workspace === null) {
      return context.json({ error: { code: "PROJECT_NOT_FOUND", message: "Project was not found" } }, 404);
    }
    const view = projectWorkspaceView(
      workspace.current,
      projectionRoleForProjectRole(grant.projectRole),
    );
    context.header("ETag", `"${workspace.revision}"`);
    return context.json(
      { revision: workspace.revision.toString(), current: projectStateResponse(view) },
      200,
    );
  });

  app.openapi(commandRoute, async (context) => {
    const { tenantId, projectId } = context.req.valid("param");
    const identity = context.get("identity");
    const session = context.get("dbSession");
    const body = context.req.valid("json");
    const result = await applyCommands(
      {
        session,
        tenantId,
        projectId,
        commands: body.commands.map((entry) => ({
          command: toCommand(entry.command),
          idempotencyKey: entry.idempotencyKey,
        })),
        expectedRevision: BigInt(body.expectedRevision),
      },
      {
        identity,
        grantResolver: deps.persistence.grantResolver(session),
        ...(deps.persistence.unitOfWorkFor === undefined
          ? {}
          : { unitOfWorkFor: deps.persistence.unitOfWorkFor }),
      },
    );
    if (result.ok) {
      context.header("ETag", `"${result.revision}"`);
      return context.json({ projectId, revision: result.revision.toString() }, 200);
    }
    if (result.code === "VERSION_CONFLICT") {
      return context.json(
        {
          error: {
            code: "VERSION_CONFLICT",
            message: "Project revision conflict",
            expectedRevision: body.expectedRevision,
            actualRevision: result.actualRevision.toString(),
          },
        },
        409,
      );
    }
    if (result.code === "FORBIDDEN") {
      return result.reason === "AGENT_APPROVAL_REQUIRED"
        ? context.json(
            { error: { code: "AGENT_APPROVAL_REQUIRED", message: "Agent plan changes require human approval" } },
            403,
          )
        : context.json(
            { error: { code: "PROJECT_ACCESS_DENIED", message: "Project command is not permitted" } },
            403,
          );
    }
    if (result.code === "NOT_FOUND") {
      return context.json({ error: { code: "PROJECT_NOT_FOUND", message: "Project was not found" } }, 404);
    }
    return context.json({ error: { code: "COMMAND_INVALID", message: result.message } }, 422);
  });

  app.doc("/api/openapi.json", {
    openapi: "3.1.0",
    info: { title: "VECTA API", version: "0.1.0" },
  });

  app.onError((error, context) => {
    if (error instanceof RequestRateLimitedError) return rateLimitedResponse();
    if (error instanceof AuthenticationRequiredError) {
      context.header("WWW-Authenticate", "Bearer");
      return context.json({ error: { code: "AUTHENTICATION_REQUIRED", message: error.message } }, 401);
    }
    const resolution = resolveProjectCommandError(error);
    if (resolution !== null) {
      return context.json({ error: resolution.error }, resolution.status);
    }
    // A Hono HTTPException (e.g. the JSON body validator's 400 "Malformed JSON in
    // request body") is a client error, not an unhandled 5xx: map it to the same
    // error envelope carrying its own status, and do NOT log it as an
    // api_unhandled_error 500. `secureResponse` headers are applied by the outer
    // `handleApiRequest` wrapper, exactly as for the other error branches above.
    if (error instanceof HTTPException) {
      return context.json({ error: { code: "BAD_REQUEST", message: error.message } }, error.status);
    }
    console.error(
      JSON.stringify({
        event: "api_unhandled_error",
        requestId: context.req.header("x-request-id") ?? "unknown",
        errorName: errorName(error),
      }),
    );
    return context.json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } }, 500);
  });

  return app;
}
