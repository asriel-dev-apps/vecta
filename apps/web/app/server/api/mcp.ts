import {
  createProjectQueryAuthorizer,
  projectionRoleForProjectRole,
  projectWorkspaceView,
  ProjectNotFoundError,
  type AuthenticatedIdentity,
} from "@vecta/application";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import type { DbSession } from "../db-session.server";
import { applyCommands, type ApplyCommandsResult } from "../project/apply-commands.server";
import {
  CommandBatchSchema,
  CommandEntrySchema,
  RevisionSchema,
  UuidSchema,
  toCommand,
} from "~/wbs/project-command-contract";
import { projectStateResponse, type ApiDeps } from "./app";
import { AuthenticationRequiredError } from "./oidc-auth";
import { boundedRequest, errorName } from "./edge-security";
import { resolveProjectCommandError } from "./project-command-error";

/**
 * The token-auth `/mcp` surface over the command core (ADR 0012 Step 5b; ADR
 * 0003). A stateless remote MCP server ported from `apps/web/src/mcp.ts`,
 * retargeted at the CURRENT batch write core (`applyCommands`) and the shared
 * per-request `DbSession`. Each request builds a fresh `McpServer` (no Durable
 * Object — free tier) whose three tools delegate to the SAME code paths as
 * `/api`: `list_projects` → `listForIdentity`, `get_project` → the role-scoped
 * `projectWorkspaceView`, `apply_project_commands` → `applyCommands` with the
 * verified token identity + a `PostgresProjectAccessGrantResolver`. Errors are
 * surfaced through the shared `project-command-error` vocabulary as MCP `isError`
 * content, using the SAME code strings as `/api`. This module is
 * React-Router-import-free so it can be mounted from the Worker entry without
 * dragging in the RR pipeline; persistence, auth, and the session lifecycle are
 * injected via {@link ApiDeps} so the whole surface is exercised in tests with a
 * local JWKS + in-memory fakes and no network.
 */

const MCP_SERVER_NAME = "VECTA project commands";
// The agent write scopes the authorizer recognises (`canAgentApply`). Advertised
// in the RFC 9728 metadata so a remote client can request the right consent;
// `project:staffing:propose` from the historical server is deferred (no staffing
// in the batch core).
const MCP_SCOPES = ["project:progress:write", "project:actuals:write"] as const;
const MAX_MCP_BODY_BYTES = 64 * 1024;

/** An MCP tool result carrying the shared error envelope as `isError` content. */
function mcpErrorContent(error: {
  readonly code: string;
  readonly message: string;
  readonly expectedRevision?: string;
  readonly actualRevision?: string;
}) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify({ error }) }],
  };
}

/** Map an unexpected throw through the shared vocabulary (else INTERNAL_ERROR). */
function mcpToolError(error: unknown) {
  const resolution = resolveProjectCommandError(error);
  if (resolution === null) {
    console.error(
      JSON.stringify({ event: "mcp_tool_unhandled_error", errorName: errorName(error) }),
    );
  }
  return mcpErrorContent(
    resolution?.error ?? { code: "INTERNAL_ERROR", message: "Internal server error" },
  );
}

/**
 * Map a returned {@link ApplyCommandsResult} (conflicts/denials are RETURNED, not
 * thrown) to MCP `isError` content — byte-for-byte the SAME code strings the
 * `/api` commands route emits, so the two mouths cannot drift.
 */
function applyResultError(result: ApplyCommandsResult, expectedRevision: string) {
  if (result.ok) {
    throw new Error("applyResultError called on an ok result");
  }
  if (result.code === "VERSION_CONFLICT") {
    return mcpErrorContent({
      code: "VERSION_CONFLICT",
      message: "Project revision conflict",
      expectedRevision,
      actualRevision: result.actualRevision.toString(),
    });
  }
  if (result.code === "FORBIDDEN") {
    return result.reason === "AGENT_APPROVAL_REQUIRED"
      ? mcpErrorContent({
          code: "AGENT_APPROVAL_REQUIRED",
          message: "Agent plan changes require human approval",
        })
      : mcpErrorContent({
          code: "PROJECT_ACCESS_DENIED",
          message: "Project command is not permitted",
        });
  }
  if (result.code === "NOT_FOUND") {
    return mcpErrorContent({ code: "PROJECT_NOT_FOUND", message: "Project was not found" });
  }
  return mcpErrorContent({ code: "COMMAND_INVALID", message: result.message });
}

/**
 * Build the per-request MCP server. `session` is the shared per-request
 * {@link DbSession}; `identity` is the verified token identity. The tools close
 * over both and delegate to the same persistence seams + write core as `/api`.
 */
function createServer(deps: ApiDeps, session: DbSession, identity: AuthenticatedIdentity): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: "0.1.0" });

  server.registerTool(
    "list_projects",
    {
      description: "List the projects the authenticated identity can access, with its role on each.",
      annotations: {
        title: "List accessible projects",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {},
    },
    async () => {
      try {
        const projects = await deps.persistence.listReader(session).listForIdentity(identity);
        const output = {
          projects: projects.map((project) => ({
            id: project.id,
            tenantId: project.tenantId,
            name: project.name,
            role: project.role,
          })),
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(output) }] };
      } catch (error) {
        return mcpToolError(error);
      }
    },
  );

  server.registerTool(
    "get_project",
    {
      description: "Get one project's persisted Current workspace (role-scoped) and its revision.",
      annotations: {
        title: "Get project workspace",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        tenantId: UuidSchema.describe("Tenant that owns the project"),
        projectId: UuidSchema.describe("Project to read"),
      },
    },
    async ({ tenantId, projectId }) => {
      try {
        // A denial and a nonexistent project both resolve to no grant → the same
        // ProjectAccessDeniedError → the same PROJECT_ACCESS_DENIED (no existence
        // oracle). The null-workspace branch is only reachable once a grant has
        // been resolved, so it never leaks existence to a non-member.
        const grant = await createProjectQueryAuthorizer(
          deps.persistence.grantResolver(session),
        ).authorize({ identity, tenantId, projectId });
        const workspace = await deps.persistence.workspace(session).load(tenantId, projectId);
        if (workspace === null) {
          throw new ProjectNotFoundError(projectId);
        }
        const view = projectWorkspaceView(
          workspace.current,
          projectionRoleForProjectRole(grant.projectRole),
        );
        const output = {
          revision: workspace.revision.toString(),
          current: projectStateResponse(view),
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(output) }] };
      } catch (error) {
        return mcpToolError(error);
      }
    },
  );

  server.registerTool(
    "apply_project_commands",
    {
      description:
        "Apply a batch of project commands, chaining revisions server-side on top of expectedRevision.",
      annotations: {
        title: "Apply project commands",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        tenantId: UuidSchema.describe("Tenant that owns the project"),
        projectId: UuidSchema.describe("Project to change"),
        expectedRevision: RevisionSchema.describe("Confirmed revision the batch applies on top of"),
        commands: z
          .array(CommandEntrySchema)
          .min(1)
          .describe("Ordered commands, each with a client-minted idempotency key"),
      },
      outputSchema: {
        projectId: UuidSchema,
        revision: RevisionSchema,
      },
    },
    async ({ tenantId, projectId, expectedRevision, commands }) => {
      try {
        // Re-validate the assembled batch through the SAME contract schema `/api`
        // uses, so the duplicate-idempotency-key refine and bounds hold identically.
        const parsed = CommandBatchSchema.safeParse({ expectedRevision, commands });
        if (!parsed.success) {
          return mcpErrorContent({ code: "REQUEST_INVALID", message: "Request validation failed" });
        }
        const result = await applyCommands(
          {
            session,
            tenantId,
            projectId,
            commands: parsed.data.commands.map((entry) => ({
              command: toCommand(entry.command),
              idempotencyKey: entry.idempotencyKey,
            })),
            expectedRevision: BigInt(parsed.data.expectedRevision),
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
          const output = { projectId, revision: result.revision.toString() };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(output) }],
            structuredContent: output,
          };
        }
        return applyResultError(result, parsed.data.expectedRevision);
      } catch (error) {
        return mcpToolError(error);
      }
    },
  );

  return server;
}

/**
 * Validate `MCP_RESOURCE_URL` as an RFC 9728 resource identifier: https (or http
 * loopback for local tests), no query/hash, and exactly the `/mcp` path. The path
 * is pinned to `/mcp` because `workers/app.ts` hardcodes that dispatch prefix — a
 * mismatched resource path would silently make the surface unreachable, so fail
 * fast at the first request instead.
 */
function validateResourceUrl(value: string): URL {
  const resource = new URL(value);
  const isLoopback = resource.hostname === "localhost" || resource.hostname === "127.0.0.1";
  if (
    (resource.protocol !== "https:" && !(resource.protocol === "http:" && isLoopback)) ||
    resource.search.length > 0 ||
    resource.hash.length > 0 ||
    resource.pathname !== "/mcp"
  ) {
    throw new Error("MCP resource URL is invalid");
  }
  return resource;
}

/** The RFC 9728 metadata document URL for a resource (`/.well-known/...`+path). */
function metadataUrl(resource: URL): URL {
  const metadata = new URL(resource.origin);
  metadata.pathname = `/.well-known/oauth-protected-resource${resource.pathname}`;
  return metadata;
}

function mcpRejection(status: 403 | 405 | 413, message: string): Response {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * The stateless `/mcp` request handler. Returns `null` when the request is not
 * for the MCP resource or its metadata (so the dispatcher can 404), a Response
 * otherwise. Ports the metadata, host/Origin, 64 KiB bound, and Bearer-401 order
 * from the historical server; the cookie is NEVER consulted (auth is Bearer-only,
 * audience `MCP_RESOURCE_URL`). Owns the per-request `DbSession` lifecycle.
 */
export function createProjectMcpHandler(deps: ApiDeps) {
  return async (
    request: Request,
    environment: Env,
    context: ExecutionContext,
  ): Promise<Response | null> => {
    const resource = validateResourceUrl(environment.MCP_RESOURCE_URL);
    const metadata = metadataUrl(resource);
    const requestUrl = new URL(request.url);

    if (request.method === "GET" && requestUrl.pathname === metadata.pathname) {
      return Response.json({
        resource: resource.href,
        authorization_servers: [environment.OIDC_ISSUER],
        scopes_supported: MCP_SCOPES,
        bearer_methods_supported: ["header"],
        resource_name: MCP_SERVER_NAME,
      });
    }
    if (requestUrl.pathname !== resource.pathname) return null;
    // Only POST carries JSON-RPC (the metadata GET is served above). In stateless
    // mode the transport would accept a standalone GET as an SSE stream and pin it
    // open with keepalives forever (a stateless server never writes back), so one
    // token could accumulate unbounded concurrent Worker connections — the rate
    // limit bounds the open RATE, not the count of live streams. Reject any
    // non-POST here, before the transport (and before the session is opened).
    if (request.method !== "POST") {
      return mcpRejection(405, "MCP method not allowed");
    }
    if (requestUrl.host !== resource.host) {
      return mcpRejection(403, "MCP request host is not permitted");
    }
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== resource.origin) {
      return mcpRejection(403, "MCP request origin is not permitted");
    }
    const bounded = await boundedRequest(request, MAX_MCP_BODY_BYTES);
    if (bounded === null) {
      return mcpRejection(413, "MCP request body exceeds 64 KiB");
    }

    let identity: AuthenticatedIdentity;
    try {
      identity = await deps.authenticate(bounded, environment);
    } catch (error) {
      if (!(error instanceof AuthenticationRequiredError)) throw error;
      return Response.json(
        { error: "Authentication is required" },
        {
          status: 401,
          headers: {
            "Cache-Control": "no-store",
            "WWW-Authenticate": `Bearer resource_metadata="${metadata.href}"`,
          },
        },
      );
    }

    // Auth passed: open the request session (lazy — nothing is opened for a 401
    // above) and close it deterministically after the MCP handler resolves.
    const session = deps.createSession(environment);
    try {
      const server = createServer(deps, session, identity);
      const response = await createMcpHandler(server, {
        route: resource.pathname,
        enableJsonResponse: true,
        authContext: { props: { identity } },
      })(bounded, environment, context);
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-store");
      // The agents WorkerTransport appends permissive CORS (`Access-Control-Allow-
      // Origin: *` + `Access-Control-Expose-Headers`) to JSON-RPC responses. Strip
      // both so the public surface advertises no CORS: auth is Bearer-only and the
      // Origin gate already 403s cross-origin browsers, matching `secureResponse`'s
      // same-origin posture on `/api`.
      headers.delete("Access-Control-Allow-Origin");
      headers.delete("Access-Control-Expose-Headers");
      return new Response(response.body, { status: response.status, headers });
    } finally {
      await session.close();
    }
  };
}
