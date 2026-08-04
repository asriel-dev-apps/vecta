import { describe, expect, it, vi } from "vitest";
import { fakeEnv } from "./helpers";

/**
 * The `/api` PRODUCTION wiring in `~/server/api/index.server` (ADR 0012 Step 5a):
 * `authenticateApiRequest` verifies the Bearer token and then enforces the
 * authenticated (principal+route) rate limit via `enforceAuthenticatedLimits`.
 * This exercises that real composition through `handleApiRequest` — only the
 * network JWKS verification is stubbed (so the token "verifies" with no fetch);
 * everything else (the real authenticator's bearer-format check + error wrapping,
 * the edge posture, the app, and `onError`) is the production code path.
 */

// Stub the token verifier so a well-formed Bearer token verifies with no network.
// The rest of the module (the real `createOidcBearerAuthenticator`,
// `AuthenticationRequiredError`, …) is kept via `importOriginal`.
vi.mock("~/server/api/oidc-auth.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/server/api/oidc-auth.server")>();
  return {
    ...actual,
    createJoseOidcTokenVerifier: () => ({
      verify: async () => ({
        issuer: "https://accounts.google.example.invalid",
        subject: "wired-sub",
        scopes: [],
      }),
    }),
  };
});

// Imported AFTER the mock is registered (vi.mock is hoisted), so `index.ts` builds
// its module-level authenticator over the stubbed verifier.
import { handleApiRequest } from "~/server/api/index.server";

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

function wiringEnv(authLimit: RateLimit): Env {
  const env = fakeEnv({
    OIDC_ISSUER: "https://accounts.google.example.invalid",
    OIDC_CLIENT_ID: "vecta-web-local.apps.googleusercontent.invalid",
    OIDC_JWKS_URL: "https://www.googleapis.example.invalid/oauth2/v3/certs",
    DATABASE_URL: "postgres://user:pass@db.example.invalid/vecta",
  });
  const mutable = env as unknown as {
    PRE_AUTH_RATE_LIMIT: RateLimit;
    AUTH_RATE_LIMIT: RateLimit;
  };
  // Pre-auth (IP) limiter allows, so the request reaches the authed limiter.
  mutable.PRE_AUTH_RATE_LIMIT = {
    limit: vi.fn(async () => ({ success: true })),
  } as unknown as RateLimit;
  mutable.AUTH_RATE_LIMIT = authLimit;
  return env;
}

describe("/api production auth wiring (index.ts)", () => {
  it("consults AUTH_RATE_LIMIT after verifying a token and returns 429 on deny", async () => {
    const limitSpy = vi.fn(async () => ({ success: false }));
    const env = wiringEnv({ limit: limitSpy } as unknown as RateLimit);
    const request = new Request("https://app.test/api/projects", {
      headers: { authorization: "Bearer aaaa.bbbb.cccc" },
    }) as unknown as Parameters<typeof handleApiRequest>[0];

    const response = await handleApiRequest(request, env, ctx);

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "RATE_LIMITED" },
    });
    // The authenticated (post-verification) limiter was consulted exactly once.
    expect(limitSpy).toHaveBeenCalledTimes(1);
  });
});
