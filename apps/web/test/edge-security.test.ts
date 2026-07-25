import { describe, expect, it, vi } from "vitest";
import {
  boundedRequest,
  enforceAuthenticatedLimits,
  enforcePreAuthenticationLimit,
  rateLimitedResponse,
  RequestRateLimitedError,
  routeKey,
  secureResponse,
} from "~/server/api/edge-security";

/**
 * The framework-free edge-security posture for the Hono `/api` branch (ADR 0012
 * Step 5a): bounded-body, IP/principal rate limits, and the `secureResponse`
 * header set. Ported from `apps/web/test/edge-security.test.ts`.
 */

function limiter(success = true) {
  return {
    limit: vi.fn(async (options: RateLimitOptions) => {
      void options;
      return { success };
    }),
  } satisfies RateLimit;
}

describe("edge request security", () => {
  it("normalizes tenant and project identifiers into bounded route classes", () => {
    const first = new Request("https://app.test/api/tenants/tenant-a/projects/project-a/commands", { method: "POST" });
    const second = new Request("https://app.test/api/tenants/tenant-b/projects/project-b/commands", { method: "POST" });
    expect(routeKey(first)).toBe("POST:commands");
    expect(routeKey(second)).toBe(routeKey(first));
    expect(routeKey(new Request("https://app.test/api/tenants/t/projects/p"))).toBe("GET:project");
    expect(routeKey(new Request("https://app.test/api/projects"))).toBe("GET:projects");
    expect(routeKey(new Request("https://app.test/api/health"))).toBe("GET:api-health");
    expect(routeKey(new Request("https://app.test/api/openapi.json"))).toBe("GET:openapi");
    expect(routeKey(new Request("https://app.test/assets/index.js"))).toBe("GET:static-or-unknown");
  });

  it("buckets the /mcp surface (JSON-RPC + RFC 9728 metadata) under its own mcp label", () => {
    expect(routeKey(new Request("https://app.test/mcp", { method: "POST" }))).toBe("POST:mcp");
    expect(routeKey(new Request("https://app.test/mcp", { method: "GET" }))).toBe("GET:mcp");
    expect(
      routeKey(new Request("https://app.test/.well-known/oauth-protected-resource/mcp")),
    ).toBe("GET:mcp");
    // A near-miss path is NOT the MCP surface and stays static-or-unknown.
    expect(routeKey(new Request("https://app.test/mcpfoo"))).toBe("GET:static-or-unknown");
  });

  it("applies a pre-authentication IP+route limit without exposing the raw key", async () => {
    const rateLimit = limiter();
    await enforcePreAuthenticationLimit(
      rateLimit,
      new Request("https://app.test/api/tenants/t/projects/p/commands", {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.8" },
      }),
    );
    const key = rateLimit.limit.mock.calls[0]?.[0].key;
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toContain("203.0.113.8");
  });

  it("applies a principal-scoped authenticated limit without exposing the principal", async () => {
    const authenticated = limiter();
    await enforceAuthenticatedLimits(
      authenticated,
      new Request("https://app.test/api/tenants/tenant-a/projects/project-a/commands", { method: "POST" }),
      { issuer: "https://identity.test/", subject: "principal@example.test", scopes: [] },
    );
    expect(authenticated.limit).toHaveBeenCalledOnce();
    const key = authenticated.limit.mock.calls[0]?.[0].key;
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toContain("principal@example.test");
  });

  it("fails closed (throws) when a native rate limiter rejects the key", async () => {
    await expect(
      enforcePreAuthenticationLimit(limiter(false), new Request("https://app.test/api/health")),
    ).rejects.toBeInstanceOf(RequestRateLimitedError);
    expect(rateLimitedResponse().status).toBe(429);
  });

  it("rejects declared and streamed bodies above the 64 KiB limit and preserves bounded bodies", async () => {
    const declared = new Request("https://app.test/api/test", {
      method: "POST",
      headers: { "content-length": "65537" },
      body: "x",
    });
    expect(await boundedRequest(declared)).toBeNull();

    const streamed = new Request("https://app.test/api/test", {
      method: "POST",
      body: "x".repeat(65_537),
    });
    expect(await boundedRequest(streamed)).toBeNull();

    const bounded = await boundedRequest(
      new Request("https://app.test/api/test", { method: "POST", body: JSON.stringify({ ok: true }) }),
    );
    expect(await bounded?.json()).toEqual({ ok: true });
  });

  it("applies no-store and a deny-all CSP with the security header set", () => {
    const secured = secureResponse(
      new Request("https://app.test/api/health"),
      new Response("ok", { status: 200 }),
      "req-1",
      "https://accounts.google.example.invalid",
    );
    expect(secured.headers.get("cache-control")).toBe("no-store");
    expect(secured.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(secured.headers.get("x-content-type-options")).toBe("nosniff");
    expect(secured.headers.get("x-frame-options")).toBe("DENY");
    expect(secured.headers.get("x-request-id")).toBe("req-1");
    // No CORS on the non-browser surface.
    expect(secured.headers.get("access-control-allow-origin")).toBeNull();
  });
});
