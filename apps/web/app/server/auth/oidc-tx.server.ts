import { createCookie } from "react-router";

/**
 * The transient login-transaction cookie (`oidc_tx`). It carries the per-attempt
 * PKCE `code_verifier`, CSRF `state`, replay `nonce`, and the validated
 * `returnTo`, so the callback can complete the flow it did not itself start.
 *
 * Signed with the same `SESSION_SECRET` (via RR's `createCookie`, not a
 * hand-rolled HMAC), scoped to `Path=/auth`, and short-lived (10 minutes). The
 * callback clears it unconditionally on every response — success, error, or
 * failure — so a verifier/state/nonce cannot be replayed.
 */
export interface OidcTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
}

const OIDC_TX_MAX_AGE_SECONDS = 600;

function txCookie(env: Env) {
  const previous = env.SESSION_SECRET_PREVIOUS;
  // `__Secure-` (not `__Host-`) because the cookie is scoped to `Path=/auth`;
  // the prefix still enforces the Secure attribute at the browser.
  return createCookie("__Secure-oidc_tx", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/auth",
    maxAge: OIDC_TX_MAX_AGE_SECONDS,
    secrets:
      previous !== undefined && previous.length > 0
        ? [env.SESSION_SECRET, previous]
        : [env.SESSION_SECRET],
  });
}

export async function serializeOidcTx(
  env: Env,
  tx: OidcTransaction,
): Promise<string> {
  return txCookie(env).serialize(tx);
}

/**
 * Read the `oidc_tx` cookie. Returns `null` when it is absent, expired (the
 * browser stops sending it after `Max-Age`), tampered (bad signature), or
 * structurally invalid.
 */
export async function readOidcTx(
  env: Env,
  request: Request,
): Promise<OidcTransaction | null> {
  const parsed = (await txCookie(env).parse(request.headers.get("Cookie"))) as
    | Partial<OidcTransaction>
    | null;
  if (
    parsed === null ||
    typeof parsed.state !== "string" ||
    typeof parsed.nonce !== "string" ||
    typeof parsed.codeVerifier !== "string" ||
    typeof parsed.returnTo !== "string"
  ) {
    return null;
  }
  return {
    state: parsed.state,
    nonce: parsed.nonce,
    codeVerifier: parsed.codeVerifier,
    returnTo: parsed.returnTo,
  };
}

/** A `Set-Cookie` value that expires `oidc_tx` immediately. */
export async function clearOidcTx(env: Env): Promise<string> {
  return txCookie(env).serialize("", { maxAge: 0 });
}
