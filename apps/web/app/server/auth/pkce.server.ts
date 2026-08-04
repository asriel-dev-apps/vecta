/**
 * PKCE (RFC 7636) plus `state`/`nonce` generation for the OIDC authorization-code
 * flow. Pure, using the platform WebCrypto (`globalThis.crypto`) which is present
 * on Cloudflare Workers and on Node 24, so this runs unchanged in tests.
 */

const TOKEN_BYTES = 32;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(byteLength: number = TOKEN_BYTES): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

/** CSRF state parameter (base64url of 32 random bytes → 43 chars). */
export function generateState(): string {
  return randomToken();
}

/** Replay-binding nonce, echoed back inside the ID token and checked on callback. */
export function generateNonce(): string {
  return randomToken();
}

/**
 * PKCE `code_verifier` — base64url of 32 random bytes (43 chars), within the
 * RFC 7636 43–128 unreserved-character range.
 */
export function generateCodeVerifier(): string {
  return randomToken();
}

/** PKCE S256 `code_challenge` = base64url(SHA-256(code_verifier)). */
export async function deriveCodeChallenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );
  return base64Url(new Uint8Array(digest));
}
