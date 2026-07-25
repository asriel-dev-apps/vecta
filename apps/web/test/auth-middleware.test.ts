import { RouterContextProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { createAuthMiddleware } from "~/middleware/auth.server";
import type {
  AuthenticatedPrincipal,
  PrincipalDirectory,
} from "~/server/auth/principal-directory";
import { requirePrincipal } from "~/server/auth/require-principal";
import { commitNewSession } from "~/server/auth/session.server";
import { appContext, principalContext } from "~/server/context";
import { cookiePair, fakeEnv } from "./helpers";

const env = fakeEnv();
const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

const PRINCIPAL: AuthenticatedPrincipal = {
  principal: {
    id: "principal-1",
    issuer: "https://accounts.google.example.invalid",
    subject: "google-sub-123",
    displayName: "Test User",
    type: "HUMAN",
  },
  tenantMemberships: [{ tenantId: "t1", role: "OWNER" }],
  projectMemberships: [{ tenantId: "t1", projectId: "p1", role: "EDITOR" }],
};

function baseContext(): RouterContextProvider {
  const context = new RouterContextProvider();
  context.set(appContext, { env, ctx });
  return context;
}

function middlewareArgs(request: Request, context: RouterContextProvider) {
  return {
    request,
    context,
    params: {},
    url: new URL(request.url),
    pattern: "/",
  };
}

const noopNext = async () => new Response(null);

describe("auth middleware", () => {
  it("redirects unauthenticated requests to /login with returnTo", async () => {
    const directoryFor = () =>
      ({ findByIssuerSubject: async () => null, loadPrincipal: async () => null }) satisfies PrincipalDirectory;
    const middleware = createAuthMiddleware({ directoryFor });
    const request = new Request(
      "https://app.example.invalid/projects/42/wbs?tab=1",
    );
    const context = baseContext();

    let thrown: unknown;
    try {
      await middleware(middlewareArgs(request, context), noopNext);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Response);
    const response = thrown as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "/login?returnTo=%2Fprojects%2F42%2Fwbs%3Ftab%3D1",
    );
  });

  it("installs a memoised principal loader that hits the directory once", async () => {
    const loadPrincipal = vi.fn(async () => PRINCIPAL);
    const directory: PrincipalDirectory = {
      findByIssuerSubject: async () => null,
      loadPrincipal,
    };
    const middleware = createAuthMiddleware({ directoryFor: () => directory });

    const setCookie = await commitNewSession(env, "principal-1");
    const request = new Request("https://app.example.invalid/", {
      headers: { Cookie: cookiePair(setCookie) },
    });
    const context = baseContext();

    await middleware(middlewareArgs(request, context), noopNext);

    // Two loaders (RR single fetch) resolving in parallel → one DB hit.
    const [a, b] = await Promise.all([
      requirePrincipal(context),
      requirePrincipal(context),
    ]);
    expect(a).toBe(PRINCIPAL);
    expect(b).toBe(PRINCIPAL);
    expect(loadPrincipal).toHaveBeenCalledTimes(1);
    expect(loadPrincipal).toHaveBeenCalledWith("principal-1");
  });

  it("does not resolve the directory when the session is expired", async () => {
    const t0 = 1_000_000_000_000;
    const setCookie = await commitNewSession(env, "principal-1", () => t0);
    const loadPrincipal = vi.fn(async () => PRINCIPAL);
    const middleware = createAuthMiddleware({
      directoryFor: () => ({
        findByIssuerSubject: async () => null,
        loadPrincipal,
      }),
    });
    // A request "now" (far past the fixed-clock exp) must be treated as expired.
    const request = new Request("https://app.example.invalid/", {
      headers: { Cookie: cookiePair(setCookie) },
    });
    await expect(
      middleware(middlewareArgs(request, baseContext()), noopNext),
    ).rejects.toBeInstanceOf(Response);
    expect(loadPrincipal).not.toHaveBeenCalled();
  });
});

describe("requirePrincipal", () => {
  it("returns the memoised principal", async () => {
    const context = baseContext();
    context.set(principalContext, async () => PRINCIPAL);
    expect(await requirePrincipal(context)).toBe(PRINCIPAL);
  });

  it("redirects to /login when the principal is gone (fail-closed)", async () => {
    const context = baseContext();
    context.set(principalContext, async () => null);
    let thrown: unknown;
    try {
      await requirePrincipal(context);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
    expect((thrown as Response).headers.get("Location")).toBe("/login");
  });
});
