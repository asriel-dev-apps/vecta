import type { AuthenticatedIdentity } from "@vecta/application";

/**
 * Framework-free edge-security posture for the token `/api` surface (ADR 0012
 * Step 5). Ported from `apps/web/src/edge-security.ts`: a 64 KiB bounded body,
 * pre-authentication (IP+route) and authenticated (principal+route) rate limits,
 * a request-id + JSON request log, and `secureResponse` headers (`no-store`,
 * deny-all CSP). It runs only on the Hono `/api` branch; the React-Router branch
 * keeps its own lifecycle. This module is React-Router-import-free.
 */

export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const RATE_LIMIT_PERIOD_SECONDS = 60;

export class RequestRateLimitedError extends Error {
  constructor() {
    super("Request rate limit exceeded");
    this.name = "RequestRateLimitedError";
  }
}

function routeParts(pathname: string): readonly string[] {
  return pathname.split("/").filter((part) => part.length > 0);
}

export function routeKey(request: Request): string {
  const url = new URL(request.url);
  const parts = routeParts(url.pathname);
  const method = request.method.toUpperCase();
  // The `/mcp` surface (JSON-RPC + its RFC 9728 metadata) gets its own bucket so
  // its pre-auth/authed rate limits are per-surface and its request logs carry an
  // `mcp` label instead of being lumped into `static-or-unknown`.
  if (parts[0] === "mcp") return `${method}:mcp`;
  if (parts[0] === ".well-known" && parts[1] === "oauth-protected-resource") {
    return `${method}:mcp`;
  }
  if (parts[0] !== "api") return `${method}:static-or-unknown`;
  if (parts[1] === "health") return `${method}:api-health`;
  if (parts[1] === "projects") return `${method}:projects`;
  if (parts[1] === "openapi.json") return `${method}:openapi`;
  if (parts[1] !== "tenants") return `${method}:static-or-unknown`;

  const resource = parts.slice(5);
  if (resource[0] === "commands") return `${method}:commands`;
  return `${method}:project`;
}

async function digestKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function requireRateLimit(limiter: RateLimit, key: string): Promise<void> {
  if (!(await limiter.limit({ key: await digestKey(key) })).success) {
    throw new RequestRateLimitedError();
  }
}

export async function enforcePreAuthenticationLimit(
  limiter: RateLimit,
  request: Request,
): Promise<void> {
  const source = request.headers.get("cf-connecting-ip") ?? "unknown-source";
  await requireRateLimit(limiter, `pre:${source}:${routeKey(request)}`);
}

export async function enforceAuthenticatedLimits(
  authenticatedLimiter: RateLimit,
  request: Request,
  identity: AuthenticatedIdentity,
): Promise<void> {
  const principal = `${identity.issuer}:${identity.subject}`;
  await requireRateLimit(authenticatedLimiter, `auth:${principal}:${routeKey(request)}`);
}

export async function boundedRequest(
  request: Request,
  maxBytes = MAX_REQUEST_BODY_BYTES,
): Promise<Request | null> {
  if (request.body === null) return request;
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const size = Number(declaredLength);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) return null;
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request, { body });
}

export function requestId(): string {
  return crypto.randomUUID();
}

export function withRequestId(request: Request, id: string): Request {
  const headers = new Headers(request.headers);
  headers.set("x-request-id", id);
  return new Request(request, { headers });
}

function allowedConnectSource(oidcIssuer: string | undefined): string {
  if (oidcIssuer === undefined) return "'self'";
  try {
    const issuer = new URL(oidcIssuer);
    const loopback = issuer.hostname === "localhost" || issuer.hostname === "127.0.0.1";
    return issuer.protocol === "https:" || (issuer.protocol === "http:" && loopback)
      ? `'self' ${issuer.origin}`
      : "'self'";
  } catch {
    return "'self'";
  }
}

/**
 * Apply the security headers + deny-all CSP + `no-store` to a `/api` response.
 * Non-browser consumers only, so the CSP is `default-src 'none'` and there is no
 * CORS. `oidcIssuer` is accepted for parity with the shared browser path but is
 * unused on the deny-all `/api` CSP.
 */
export function secureResponse(
  request: Request,
  response: Response,
  id: string,
  oidcIssuer?: string,
): Response {
  void allowedConnectSource(oidcIssuer);
  const headers = new Headers(response.headers);
  headers.set("X-Request-Id", id);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Origin-Agent-Cluster", "?1");
  headers.delete("Server");
  if (new URL(request.url).protocol === "https:") {
    headers.set("Strict-Transport-Security", "max-age=31536000");
  }
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function rateLimitedResponse(): Response {
  return Response.json(
    { error: { code: "RATE_LIMITED", message: "Too many requests" } },
    { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(RATE_LIMIT_PERIOD_SECONDS) } },
  );
}

export function bodyTooLargeResponse(): Response {
  return Response.json(
    { error: { code: "BODY_TOO_LARGE", message: "Request body exceeds 64 KiB" } },
    { status: 413, headers: { "Cache-Control": "no-store" } },
  );
}

export function internalErrorResponse(): Response {
  return Response.json(
    { error: { code: "INTERNAL_ERROR", message: "Internal server error" } },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}

export function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name)
    ? error.name
    : "UnknownError";
}

export function writeHttpRequestLog(input: {
  readonly requestId: string;
  readonly method: string;
  readonly route: string;
  readonly status: number;
  readonly durationMs: number;
  readonly error?: unknown;
}): void {
  const record: Record<string, string | number> = {
    event: "http_request",
    requestId: input.requestId,
    method: input.method,
    route: input.route,
    status: input.status,
    durationMs: input.durationMs,
  };
  if (input.error !== undefined) record.errorName = errorName(input.error);
  const serialized = JSON.stringify(record);
  if (input.status >= 500) console.error(serialized);
  else console.log(serialized);
}
