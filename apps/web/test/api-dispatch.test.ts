import { describe, expect, it, vi } from "vitest";
import worker, { isApiPath, isMcpPath } from "../workers/app";
import { fakeEnv } from "./helpers";

/**
 * The Worker-entry dispatch (ADR 0012 Step 5a + 5b): `/api*`, `/mcp*`, and the
 * RFC 9728 metadata subtree `/.well-known/oauth-protected-resource*` are handled
 * by the token surfaces and never reach the React Router (cookie) pipeline, while
 * a lookalike like `/apifoo` falls through to React Router. The predicates are the
 * dispatch decision, so pinning them pins the routing; the handler drive proves
 * the entry wires the `/api` and `/mcp` branches to the right handlers.
 */

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

function dispatchEnv(): Env {
  const env = fakeEnv({
    OIDC_ISSUER: "https://accounts.google.example.invalid",
    OIDC_JWKS_URL: "https://www.googleapis.example.invalid/oauth2/v3/certs",
    // The MCP resource host must match the request host below (app.test) or the
    // handler rejects with 403 before auth (host-not-permitted).
    MCP_RESOURCE_URL: "https://app.test/mcp",
  });
  // Both the `/api` and `/mcp` edge postures enforce a pre-auth rate limit before
  // the surface runs.
  (env as unknown as { PRE_AUTH_RATE_LIMIT: RateLimit }).PRE_AUTH_RATE_LIMIT = {
    limit: vi.fn(async () => ({ success: true })),
  } as unknown as RateLimit;
  return env;
}

describe("worker-entry dispatch predicates", () => {
  it("routes exact and subpath /api to the API surface, but not a lookalike", () => {
    expect(isApiPath("/api")).toBe(true);
    expect(isApiPath("/api/")).toBe(true);
    expect(isApiPath("/api/health")).toBe(true);
    expect(isApiPath("/api/tenants/t/projects/p/commands")).toBe(true);
    expect(isApiPath("/apifoo")).toBe(false);
    expect(isApiPath("/mcp")).toBe(false);
    expect(isApiPath("/")).toBe(false);
  });

  it("routes exact and subpath /mcp + the oauth-protected-resource metadata to the MCP surface, but not a lookalike", () => {
    expect(isMcpPath("/mcp")).toBe(true);
    expect(isMcpPath("/mcp/")).toBe(true);
    expect(isMcpPath("/mcp/message")).toBe(true);
    // The RFC 9728 metadata subtree is owned by the MCP branch (else it falls
    // through to the React Router auth middleware and dies).
    expect(isMcpPath("/.well-known/oauth-protected-resource")).toBe(true);
    expect(isMcpPath("/.well-known/oauth-protected-resource/mcp")).toBe(true);
    expect(isMcpPath("/mcpfoo")).toBe(false);
    expect(isMcpPath("/.well-known/oauth-protected-resourcefoo")).toBe(false);
    expect(isMcpPath("/api")).toBe(false);
  });
});

describe("worker-entry dispatch handler", () => {
  it("serves /api/health through the API surface (not React Router)", async () => {
    const response = await worker.fetch(
      new Request("https://app.test/api/health") as Parameters<typeof worker.fetch>[0],
      dispatchEnv(),
      ctx,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ service: "vecta", status: "ok" });
    // The edge posture ran: the security headers are present on the /api response.
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers an unauthenticated /mcp through the MCP surface with 401 (not React Router)", async () => {
    const response = await worker.fetch(
      new Request("https://app.test/mcp", {
        method: "POST",
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }) as Parameters<typeof worker.fetch>[0],
      dispatchEnv(),
      ctx,
    );
    // The real stateless MCP handler ran (Bearer required), never the RR pipeline:
    // a 401 carrying the RFC 9728 resource_metadata pointer.
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      "/.well-known/oauth-protected-resource/mcp",
    );
  });

  it("serves the oauth-protected-resource metadata through the MCP surface (never React Router)", async () => {
    const response = await worker.fetch(
      new Request(
        "https://app.test/.well-known/oauth-protected-resource/mcp",
      ) as Parameters<typeof worker.fetch>[0],
      dispatchEnv(),
      ctx,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      resource: "https://app.test/mcp",
      bearer_methods_supported: ["header"],
      resource_name: "VECTA project commands",
    });
  });

  it("applies the /api pre-auth rate limit (429) through the edge posture", async () => {
    const env = dispatchEnv();
    // Deny at the pre-auth limiter → the edge wrapper maps it to 429.
    (env as unknown as { PRE_AUTH_RATE_LIMIT: RateLimit }).PRE_AUTH_RATE_LIMIT = {
      limit: vi.fn(async () => ({ success: false })),
    } as unknown as RateLimit;
    const response = await worker.fetch(
      new Request("https://app.test/api/health") as Parameters<typeof worker.fetch>[0],
      env,
      ctx,
    );
    expect(response.status).toBe(429);
  });
});
