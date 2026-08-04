import { redirect } from "react-router";
import type { IdTokenVerifier, VerifiedIdentity } from "./id-token.server";
import type { OidcConfig } from "./oidc-config.server";
import {
  deriveCodeChallenge,
  generateCodeVerifier,
  generateNonce,
  generateState,
} from "./pkce.server";
import {
  clearOidcTx,
  readOidcTx,
  serializeOidcTx,
  type OidcTransaction,
} from "./oidc-tx.server";
import type { PrincipalDirectory } from "./principal-directory.server";
import { safeReturnTo } from "./redirect.server";
import { commitNewSession, type Clock } from "./session.server";
import { errorName } from "~/server/api/edge-security.server";
import {
  subjectDigest,
  type SecurityEventReason,
  type SubjectDigest,
} from "~/server/security-log.server";

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
    // ASVS scan L7. This body carries `client_secret`; `fetch` follows redirects
    // by default and replays the POST body at whatever host the 3xx names. The
    // token endpoint comes from env, so today there is no way to point it
    // somewhere hostile — this closes the step where that stops being true
    // (a compromised or misconfigured issuer answering 302) rather than relying
    // on the destination staying trustworthy. A redirect is not part of RFC 6749's
    // token exchange, so refusing to follow one loses nothing.
    redirect: "manual",
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

/**
 * Why the sign-in did not complete. INTERNAL: it is carried out of here for the
 * security log (ASVS scan M3) and is never rendered — the four screens above are
 * what a person sees, and telling them which check failed would help whoever is
 * probing more than it helps them.
 *
 * The values are a subset of the log's own reason union rather than a private
 * vocabulary, so the two cannot drift.
 */
export type CallbackFailureReason = Extract<
  SecurityEventReason,
  | "provider_reported_error"
  | "no_transaction"
  | "state_mismatch"
  | "token_exchange_failed"
  | "id_token_rejected"
  | "principal_not_found"
  | "directory_unavailable"
>;

export type CallbackResult =
  | {
      readonly type: "redirect";
      readonly location: string;
      readonly setCookies: readonly string[];
      /** The internal UUID, for the `login_succeeded` record. */
      readonly principalId: string;
    }
  | {
      readonly type: "screen";
      readonly screen: CallbackScreen;
      readonly setCookies: readonly string[];
      readonly reason: CallbackFailureReason;
      /**
       * Only for `principal_not_found`: a keyed digest of the VERIFIED
       * `(issuer, subject)`. The `VerifiedIdentity` itself carries the person's
       * email and never leaves this function.
       */
      readonly subjectDigest?: SubjectDigest;
      /** Already through the `/api` allowlist; never an error MESSAGE. */
      readonly errorName?: string;
    };

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
  const screen = (
    kind: CallbackScreen,
    reason: CallbackFailureReason,
    extra: { readonly error?: unknown; readonly subjectDigest?: SubjectDigest } = {},
  ): CallbackResult => ({
    type: "screen",
    screen: kind,
    setCookies: [clearedTx],
    reason,
    ...(extra.error === undefined ? {} : { errorName: errorName(extra.error) }),
    ...(extra.subjectDigest === undefined ? {} : { subjectDigest: extra.subjectDigest }),
  });

  const url = new URL(deps.request.url);

  // (1) The provider reported an error (e.g. the user pressed "deny").
  if (url.searchParams.get("error") !== null) {
    return screen("provider_error", "provider_reported_error");
  }

  // (2) No live transaction to complete (cookie missing/expired/tampered).
  const tx = await readOidcTx(deps.env, deps.request);
  if (tx === null) {
    return screen("retry", "no_transaction");
  }

  // (3) CSRF: the returned state must match the one we issued.
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (state === null || state !== tx.state || code === null || code.length === 0) {
    return screen("retry", "state_mismatch");
  }

  // (4) Exchange the code. SPLIT from (5) — the two used to share one `catch`,
  // and the ASVS scan names "token exchange failure" and "nonce mismatch" as
  // separate events it cannot see. One reason for both would not answer that.
  let idToken: string;
  try {
    const exchange = deps.exchangeCode ?? defaultTokenExchanger;
    const exchanged = await exchange({
      config: deps.config,
      code,
      codeVerifier: tx.codeVerifier,
    });
    idToken = exchanged.id_token;
  } catch (error) {
    return screen("provider_error", "token_exchange_failed", { error });
  }

  // (5) Verify the ID token (iss/aud/exp/nonce). The error NAME distinguishes a
  // nonce mismatch from an expiry or a bad audience (jose names its claim
  // failures); the message never leaves this function.
  let identity: VerifiedIdentity;
  try {
    identity = await deps.verifier.verify(idToken, {
      issuer: deps.config.issuer,
      audience: deps.config.clientId,
      jwksUrl: deps.config.jwksUrl,
      nonce: tx.nonce,
    });
  } catch (error) {
    return screen("provider_error", "id_token_rejected", { error });
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
      // The digest is computed HERE so `identity` — which carries the person's
      // verified email — never leaves this function. It needs `SESSION_SECRET`,
      // whose absence would already have made step (7) impossible, so letting a
      // digest failure fall to `unavailable` costs nothing real.
      return screen("forbidden", "principal_not_found", {
        subjectDigest: await subjectDigest(deps.env, identity.issuer, identity.subject),
      });
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
      principalId: principal.id,
    };
  } catch (error) {
    return screen("unavailable", "directory_unavailable", { error });
  }
}
