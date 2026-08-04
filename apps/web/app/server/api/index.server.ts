import type { AuthenticatedIdentity } from "@vecta/application";
import {
  NeonHttpProjectWorkspaceReader,
  PostgresProjectAccessGrantResolver,
  PostgresProjectListReader,
} from "@vecta/persistence";
import { createDbSession } from "../db-session.server";
import { createApiApp, type ApiPersistence } from "./app.server";
import {
  boundedRequest,
  bodyTooLargeResponse,
  enforceAuthenticatedLimits,
  enforcePreAuthenticationLimit,
  internalErrorResponse,
  rateLimitedResponse,
  requestId,
  RequestRateLimitedError,
  routeKey,
  secureResponse,
  withRequestId,
  writeHttpRequestLog,
} from "./edge-security.server";
import {
  createJoseOidcTokenVerifier,
  createOidcBearerAuthenticator,
} from "./oidc-auth.server";
import { createProjectMcpHandler } from "./mcp.server";

/**
 * Production wiring + edge-security wrapper for the `/api` and `/mcp` surfaces
 * (ADR 0012 Step 5a + 5b). The Worker entry dispatches `/api*` and `/mcp*` (plus
 * `/.well-known/oauth-protected-resource*`) here; everything below is the real
 * Neon-backed composition of the injectable app in `./app` and the stateless MCP
 * server in `./mcp`. Both mouths share one authenticator, one persistence seam,
 * and the per-request `DbSession`; only the token AUDIENCE differs (the `/api`
 * audience is `OIDC_CLIENT_ID`, the `/mcp` audience is `MCP_RESOURCE_URL`).
 */

// All three are reads, so they run on the session's HTTP transport: no WebSocket
// handshake, and the workspace read goes out as one batched round trip. The
// write pool is still opened lazily by `applyCommands` when a batch is executed.
const neonApiPersistence: ApiPersistence = {
  grantResolver: (session) => new PostgresProjectAccessGrantResolver(session.read()),
  workspace: (session) => new NeonHttpProjectWorkspaceReader(session.read()),
  listReader: (session) => new PostgresProjectListReader(session.read()),
};

const authenticator = createOidcBearerAuthenticator(createJoseOidcTokenVerifier());

// The `/api` audience is OIDC_CLIENT_ID (ADR 0012 §Decision 4 / Step 5 plan — no
// new var). The authed rate limit is enforced only after a token verifies, so an
// unauthenticated flood is bounded by the pre-auth (IP) limiter instead.
async function authenticateApiRequest(
  request: Request,
  environment: Env,
): Promise<AuthenticatedIdentity> {
  const identity = await authenticator.authenticate(request, {
    issuer: environment.OIDC_ISSUER,
    audience: environment.OIDC_CLIENT_ID,
    jwksUrl: environment.OIDC_JWKS_URL,
  });
  await enforceAuthenticatedLimits(environment.AUTH_RATE_LIMIT, request, identity);
  return identity;
}

const apiApp = createApiApp({
  authenticate: authenticateApiRequest,
  createSession: (environment) => createDbSession(environment),
  persistence: neonApiPersistence,
});

// The `/mcp` audience is MCP_RESOURCE_URL (ADR 0012 Step 5b / ADR 0003 — the
// RFC 9728 resource identifier, a SEPARATE audience from the REST OIDC_CLIENT_ID,
// so a token minted for one mouth is rejected at the other). The authenticated
// rate limit is enforced only after a token verifies, exactly as for `/api`.
async function authenticateMcpRequest(
  request: Request,
  environment: Env,
): Promise<AuthenticatedIdentity> {
  const identity = await authenticator.authenticate(request, {
    issuer: environment.OIDC_ISSUER,
    audience: environment.MCP_RESOURCE_URL,
    jwksUrl: environment.OIDC_JWKS_URL,
  });
  await enforceAuthenticatedLimits(environment.AUTH_RATE_LIMIT, request, identity);
  return identity;
}

const mcpHandler = createProjectMcpHandler({
  authenticate: authenticateMcpRequest,
  createSession: (environment) => createDbSession(environment),
  persistence: neonApiPersistence,
});

/**
 * Handle a `/api*` request with the full edge-security posture: a pre-auth
 * (IP+route) rate limit, a 64 KiB bounded body, a request-id + JSON request log,
 * and `secureResponse` headers (`no-store`, deny-all CSP). Mirrors the old
 * `apps/web` worker's `fetch`, scoped to the Hono branch.
 */
export async function handleApiRequest(
  request: Request,
  environment: Env,
  context: ExecutionContext,
): Promise<Response> {
  const id = requestId();
  const startedAt = Date.now();
  const route = routeKey(request);
  let response: Response;
  let failure: unknown;
  try {
    await enforcePreAuthenticationLimit(environment.PRE_AUTH_RATE_LIMIT, request);
    const bounded = await boundedRequest(request);
    if (bounded === null) {
      response = bodyTooLargeResponse();
    } else {
      const correlated = withRequestId(bounded, id);
      response = await apiApp.fetch(correlated, environment, context);
    }
  } catch (error) {
    failure = error;
    response =
      error instanceof RequestRateLimitedError ? rateLimitedResponse() : internalErrorResponse();
  }
  const secured = secureResponse(request, response, id, environment.OIDC_ISSUER);
  writeHttpRequestLog({
    requestId: id,
    method: request.method,
    route,
    status: secured.status,
    durationMs: Date.now() - startedAt,
    ...(failure === undefined ? {} : { error: failure }),
  });
  return secured;
}

/**
 * Handle a `/mcp*` (or `/.well-known/oauth-protected-resource*`) request with the
 * same edge-security posture as `/api`: a pre-auth (IP+route) rate limit, a
 * request-id + JSON request log, and `secureResponse` headers. The 64 KiB body
 * bound + host/Origin checks live INSIDE the MCP handler (ported from the
 * historical server, so they run before Bearer auth). A path that reaches this
 * branch but is neither the MCP resource nor its metadata resolves to `null` and
 * becomes a 404 — it never falls through to the React Router (cookie) pipeline.
 */
export async function handleMcpRequest(
  request: Request,
  environment: Env,
  context: ExecutionContext,
): Promise<Response> {
  const id = requestId();
  const startedAt = Date.now();
  const route = routeKey(request);
  let response: Response;
  let failure: unknown;
  try {
    await enforcePreAuthenticationLimit(environment.PRE_AUTH_RATE_LIMIT, request);
    const correlated = withRequestId(request, id);
    response =
      (await mcpHandler(correlated, environment, context)) ??
      Response.json(
        { error: { code: "NOT_FOUND", message: "Not found" } },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
  } catch (error) {
    failure = error;
    response =
      error instanceof RequestRateLimitedError ? rateLimitedResponse() : internalErrorResponse();
  }
  const secured = secureResponse(request, response, id, environment.OIDC_ISSUER);
  writeHttpRequestLog({
    requestId: id,
    method: request.method,
    route,
    status: secured.status,
    durationMs: Date.now() - startedAt,
    ...(failure === undefined ? {} : { error: failure }),
  });
  return secured;
}
