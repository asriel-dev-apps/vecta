import { redirect } from "react-router";
import type { IdTokenVerifier, VerifiedIdentity } from "./id-token";
import type { OidcConfig } from "./oidc-config";
import {
  deriveCodeChallenge,
  generateCodeVerifier,
  generateNonce,
  generateState,
} from "./pkce";
import {
  clearOidcTx,
  readOidcTx,
  serializeOidcTx,
  type OidcTransaction,
} from "./oidc-tx.server";
import type { PrincipalDirectory } from "./principal-directory";
import { safeReturnTo } from "./redirect";
import { commitNewSession, type Clock } from "./session.server";

/**
 * Server-side OIDC authorization-code flow (ADR 0012 §Decision 4). The two
 * entry points are written as dependency-injected async functions — the route
 * loaders are thin wrappers that build the real dependencies from `env`, while
 * tests drive these directly with fakes (no Google, no DB, no network).
 *
 * Tokens, the authorization `code`, and the token-exchange request are never
 * logged (Worker observability is on).
 */

export interface LoginDeps {
  readonly env: Env;
  readonly config: OidcConfig;
  readonly request: Request;
}

/**
 * `/login`: generate PKCE + state + nonce, capture a validated `returnTo`, set
 * the `oidc_tx` cookie, and 302 to the provider's authorization endpoint.
 */
export async function runLogin(deps: LoginDeps): Promise<Response> {
  const url = new URL(deps.request.url);
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  const state = generateState();
  const nonce = generateNonce();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await deriveCodeChallenge(codeVerifier);

  const authUrl = new URL(deps.config.authEndpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", deps.config.clientId);
  authUrl.searchParams.set("redirect_uri", deps.config.redirectUri);
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("nonce", nonce);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  const tx: OidcTransaction = { state, nonce, codeVerifier, returnTo };
  return redirect(authUrl.toString(), {
    headers: { "Set-Cookie": await serializeOidcTx(deps.env, tx) },
  });
}

export interface TokenResponse {
  readonly id_token: string;
}

export type TokenExchanger = (params: {
  readonly config: OidcConfig;
  readonly code: string;
  readonly codeVerifier: string;
}) => Promise<TokenResponse>;

const defaultTokenExchanger: TokenExchanger = async ({
  config,
  code,
  codeVerifier,
}) => {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code_verifier: codeVerifier,
  });
  const response = await fetch(config.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`token endpoint responded ${response.status}`);
  }
  const json = (await response.json()) as { id_token?: unknown };
  if (typeof json.id_token !== "string" || json.id_token.length === 0) {
    throw new Error("token response missing id_token");
  }
  return { id_token: json.id_token };
};

/** The clean end-user screens the callback can render instead of a 500. */
export type CallbackScreen =
  | "provider_error"
  | "retry"
  | "forbidden"
  | "unavailable";

export type CallbackResult =
  | { readonly type: "redirect"; readonly location: string; readonly setCookies: readonly string[] }
  | { readonly type: "screen"; readonly screen: CallbackScreen; readonly setCookies: readonly string[] };

export interface CallbackDeps {
  readonly env: Env;
  readonly config: OidcConfig;
  readonly request: Request;
  readonly verifier: IdTokenVerifier;
  readonly directory: PrincipalDirectory;
  readonly exchangeCode?: TokenExchanger;
  readonly clock?: Clock;
}

/**
 * `/auth/callback` (a GET redirect from the provider). Returns a normalised
 * result so the loader can turn it into a redirect or a rendered screen. The
 * `oidc_tx` cookie is cleared on EVERY branch (its cleared `Set-Cookie` is in
 * `setCookies` unconditionally).
 */
export async function runCallback(deps: CallbackDeps): Promise<CallbackResult> {
  const clearedTx = await clearOidcTx(deps.env);
  const screen = (kind: CallbackScreen): CallbackResult => ({
    type: "screen",
    screen: kind,
    setCookies: [clearedTx],
  });

  const url = new URL(deps.request.url);

  // (1) The provider reported an error (e.g. the user pressed "deny").
  if (url.searchParams.get("error") !== null) {
    return screen("provider_error");
  }

  // (2) No live transaction to complete (cookie missing/expired/tampered).
  const tx = await readOidcTx(deps.env, deps.request);
  if (tx === null) {
    return screen("retry");
  }

  // (3) CSRF: the returned state must match the one we issued.
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (state === null || state !== tx.state || code === null || code.length === 0) {
    return screen("retry");
  }

  // (4) Exchange the code and (5) verify the ID token (iss/aud/exp/nonce).
  let identity: VerifiedIdentity;
  try {
    const exchange = deps.exchangeCode ?? defaultTokenExchanger;
    const { id_token } = await exchange({
      config: deps.config,
      code,
      codeVerifier: tx.codeVerifier,
    });
    identity = await deps.verifier.verify(id_token, {
      issuer: deps.config.issuer,
      audience: deps.config.clientId,
      jwksUrl: deps.config.jwksUrl,
      nonce: tx.nonce,
    });
  } catch {
    return screen("provider_error");
  }

  // (6) Map the verified (iss, sub) to an existing principal and (7) issue the
  // session cookie. Both touch the backend (Neon), so a transient DB failure
  // must render a clean "unavailable" screen — with the tx already cleared —
  // rather than throwing out of the loader into a 500.
  try {
    // (6) Map the verified (iss, sub) to an existing principal. No JIT provisioning.
    const principal = await deps.directory.findByIssuerSubject(
      identity.issuer,
      identity.subject,
    );
    if (principal === null) {
      return screen("forbidden");
    }

    // (7) Issue the session cookie and redirect to the validated returnTo.
    const sessionCookie = await commitNewSession(
      deps.env,
      principal.id,
      deps.clock ?? Date.now,
    );
    return {
      type: "redirect",
      location: safeReturnTo(tx.returnTo),
      setCookies: [sessionCookie, clearedTx],
    };
  } catch {
    return screen("unavailable");
  }
}
