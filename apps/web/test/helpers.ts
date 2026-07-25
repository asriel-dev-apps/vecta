import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { OidcConfig } from "~/server/auth/oidc-config";

/**
 * Test scaffolding: a fake `Env` (only the fields auth touches), an in-memory
 * RS256 key + JWKS so ID-token verification runs with `createLocalJWKSet`, and a
 * token signer. No network, no Google, no DB.
 */

export const TEST_ISSUER = "https://accounts.google.example.invalid";
export const TEST_CLIENT_ID = "client-abc";
export const TEST_JWKS_URL = "https://jwks.example.invalid/certs";
export const TEST_SUBJECT = "google-sub-123";

export function fakeEnv(overrides: Partial<Record<keyof Env, string>> = {}): Env {
  return {
    SESSION_SECRET: "test-session-secret-please-change-0000",
    ...overrides,
  } as unknown as Env;
}

export function testOidcConfig(overrides: Partial<OidcConfig> = {}): OidcConfig {
  return {
    issuer: TEST_ISSUER,
    clientId: TEST_CLIENT_ID,
    clientSecret: "test-client-secret",
    jwksUrl: TEST_JWKS_URL,
    redirectUri: "https://app.example.invalid/auth/callback",
    authEndpoint: `${TEST_ISSUER}/o/oauth2/v2/auth`,
    tokenEndpoint: "https://oauth2.googleapis.example.invalid/token",
    ...overrides,
  };
}

export interface TestKeys {
  readonly privateKey: CryptoKey;
  readonly publicJwks: { keys: Array<Record<string, unknown>> };
}

export async function generateRs256Keys(kid = "test-rs256"): Promise<TestKeys> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  return {
    privateKey,
    publicJwks: { keys: [{ ...jwk, alg: "RS256", use: "sig", kid }] },
  };
}

export async function generateEs256Key(): Promise<CryptoKey> {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  return privateKey;
}

export interface IdTokenClaims {
  iss?: string;
  aud?: string;
  sub?: string;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  /** Epoch seconds. */
  exp?: number;
}

export function validIdTokenClaims(
  overrides: IdTokenClaims = {},
): Required<Pick<IdTokenClaims, "iss" | "aud" | "sub" | "nonce">> & IdTokenClaims {
  return {
    iss: TEST_ISSUER,
    aud: TEST_CLIENT_ID,
    sub: TEST_SUBJECT,
    nonce: "nonce-xyz",
    email: "user@example.com",
    email_verified: true,
    ...overrides,
  };
}

export async function signIdToken(
  privateKey: CryptoKey,
  claims: IdTokenClaims,
  options: { alg?: string; kid?: string } = {},
): Promise<string> {
  const { alg = "RS256", kid = "test-rs256" } = options;
  const { exp, ...rest } = claims;
  const signer = new SignJWT(rest as Record<string, unknown>)
    .setProtectedHeader({ alg, kid })
    .setIssuedAt();
  signer.setExpirationTime(exp ?? Math.floor(Date.now() / 1000) + 3600);
  return signer.sign(privateKey);
}

/** Extract the `name=value` pair from a `Set-Cookie` header for reuse as a request `Cookie`. */
export function cookiePair(setCookie: string): string {
  return setCookie.split(";")[0] ?? "";
}

/** Does a set of `Set-Cookie` values clear the `oidc_tx` cookie (Max-Age=0)? */
export function clearsOidcTx(setCookies: readonly string[]): boolean {
  return setCookies.some(
    (cookie) =>
      cookie.startsWith("__Secure-oidc_tx=") && /Max-Age=0/i.test(cookie),
  );
}
