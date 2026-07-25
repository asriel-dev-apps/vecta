import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { action, loader } from "~/routes/login";
import { readOidcTx } from "~/server/auth/oidc-tx.server";
import { commitNewSession } from "~/server/auth/session.server";
import { appContext } from "~/server/context";
import { cookiePair, fakeEnv, testOidcConfig, TEST_CLIENT_ID } from "./helpers";

// ADR 0012 auth-UX fix. `/login` is no longer a redirect-only loader: a GET now
// RENDERS the sign-in page (and bounces an already-authenticated principal to
// `/projects`), while the OIDC authorization-code flow moved behind a POST
// `action`. These exercise the loader and the action directly (the component
// render lives in login-route.test.tsx); the byte-for-byte OIDC assertions that
// used to hit `runLogin` now hit the POST action.

const env = fakeEnv();
const config = testOidcConfig();
const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

// The Worker vars `oidcConfigFromEnv` reads, so the route action builds the same
// authorize URL the test config describes.
const authEnv = fakeEnv({
  OIDC_ISSUER: config.issuer,
  OIDC_CLIENT_ID: config.clientId,
  OIDC_CLIENT_SECRET: config.clientSecret,
  OIDC_JWKS_URL: config.jwksUrl,
  OIDC_REDIRECT_URI: config.redirectUri,
  OIDC_AUTH_ENDPOINT: config.authEndpoint,
  OIDC_TOKEN_ENDPOINT: config.tokenEndpoint,
});

function contextFor(e: Env): RouterContextProvider {
  const context = new RouterContextProvider();
  context.set(appContext, { env: e, ctx });
  return context;
}

function loaderArgs(request: Request, e: Env = env) {
  return {
    request,
    context: contextFor(e),
    params: {},
    url: new URL(request.url),
    pattern: "/login",
  } as Parameters<typeof loader>[0];
}

function actionArgs(request: Request, e: Env = authEnv) {
  return {
    request,
    context: contextFor(e),
    params: {},
    url: new URL(request.url),
    pattern: "/login",
  } as Parameters<typeof action>[0];
}

function get(returnTo?: string): Request {
  const url = new URL("https://app.example.invalid/login");
  if (returnTo !== undefined) url.searchParams.set("returnTo", returnTo);
  return new Request(url);
}

function post(returnTo?: string): Request {
  const url = new URL("https://app.example.invalid/login");
  if (returnTo !== undefined) url.searchParams.set("returnTo", returnTo);
  return new Request(url, { method: "POST" });
}

describe("GET /login (loader)", () => {
  it("renders the sign-in page for an unauthenticated request (data, not a redirect)", async () => {
    const result = await loader(loaderArgs(get("/projects/42")));
    expect(result).not.toBeInstanceOf(Response);
    expect(result).toEqual({ returnTo: "/projects/42" });
  });

  it("sanitizes a hostile returnTo (//evil.com) to / in the rendered data", async () => {
    const result = await loader(loaderArgs(get("//evil.com")));
    expect(result).toEqual({ returnTo: "/" });
  });

  it("redirects an already-authenticated principal to /projects", async () => {
    const setCookie = await commitNewSession(env, "principal-1");
    const request = new Request("https://app.example.invalid/login", {
      headers: { Cookie: cookiePair(setCookie) },
    });
    const result = await loader(loaderArgs(request));
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/projects");
  });
});

describe("POST /login (action)", () => {
  it("302s to the provider authorize URL with PKCE + state + nonce", async () => {
    const response = await action(actionArgs(post("/projects/42")));
    expect(response.status).toBe(302);

    const location = response.headers.get("Location");
    expect(location).not.toBeNull();
    const params = new URL(location ?? "").searchParams;

    expect(params.get("response_type")).toBe("code");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect((params.get("code_challenge") ?? "").length).toBeGreaterThan(0);
    expect((params.get("state") ?? "").length).toBeGreaterThan(0);
    expect((params.get("nonce") ?? "").length).toBeGreaterThan(0);
    expect(params.get("client_id")).toBe(TEST_CLIENT_ID);
    expect(params.get("redirect_uri")).toBe(config.redirectUri);
    expect(params.get("scope")).toBe("openid email profile");
  });

  it("sets an oidc_tx Set-Cookie", async () => {
    const response = await action(actionArgs(post("/projects/42")));
    const setCookie = response.headers.get("Set-Cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie ?? "").toContain("__Secure-oidc_tx=");
  });

  it("sanitizes a hostile returnTo (//evil.com) to / in the stored tx", async () => {
    const response = await action(actionArgs(post("//evil.com")));
    const setCookie = response.headers.get("Set-Cookie") ?? "";
    const tx = await readOidcTx(
      authEnv,
      new Request("https://app.example.invalid/auth/callback", {
        headers: { Cookie: cookiePair(setCookie) },
      }),
    );
    expect(tx?.returnTo).toBe("/");
  });
});
