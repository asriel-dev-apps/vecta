import { createLocalJWKSet } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createIdTokenVerifier } from "~/server/auth/id-token";
import {
  type TestKeys,
  TEST_CLIENT_ID,
  TEST_ISSUER,
  TEST_JWKS_URL,
  TEST_SUBJECT,
  generateEs256Key,
  generateRs256Keys,
  signIdToken,
  validIdTokenClaims,
} from "./helpers";

const NONCE = "nonce-xyz";

function verifierFor(keys: TestKeys) {
  return createIdTokenVerifier(() => createLocalJWKSet(keys.publicJwks));
}

const params = {
  issuer: TEST_ISSUER,
  audience: TEST_CLIENT_ID,
  jwksUrl: TEST_JWKS_URL,
  nonce: NONCE,
};

describe("ID-token verification", () => {
  let keys: TestKeys;
  beforeAll(async () => {
    keys = await generateRs256Keys();
  });

  it("accepts a valid RS256 token and returns (iss, sub, verified email)", async () => {
    const token = await signIdToken(keys.privateKey, validIdTokenClaims());
    const identity = await verifierFor(keys).verify(token, params);
    expect(identity).toEqual({
      issuer: TEST_ISSUER,
      subject: TEST_SUBJECT,
      email: "user@example.com",
    });
  });

  it("omits email when email_verified is not true", async () => {
    const token = await signIdToken(
      keys.privateKey,
      validIdTokenClaims({ email_verified: false }),
    );
    const identity = await verifierFor(keys).verify(token, params);
    expect(identity.email).toBeUndefined();
  });

  it("rejects a wrong issuer", async () => {
    const token = await signIdToken(
      keys.privateKey,
      validIdTokenClaims({ iss: "https://evil.example.invalid" }),
    );
    await expect(verifierFor(keys).verify(token, params)).rejects.toThrow();
  });

  it("rejects a wrong audience", async () => {
    const token = await signIdToken(
      keys.privateKey,
      validIdTokenClaims({ aud: "some-other-client" }),
    );
    await expect(verifierFor(keys).verify(token, params)).rejects.toThrow();
  });

  it("rejects a nonce mismatch", async () => {
    const token = await signIdToken(
      keys.privateKey,
      validIdTokenClaims({ nonce: "different-nonce" }),
    );
    await expect(verifierFor(keys).verify(token, params)).rejects.toThrow(
      /nonce/i,
    );
  });

  it("rejects an expired token", async () => {
    const token = await signIdToken(
      keys.privateKey,
      validIdTokenClaims({ exp: Math.floor(Date.now() / 1000) - 100 }),
    );
    await expect(verifierFor(keys).verify(token, params)).rejects.toThrow();
  });

  it("rejects a non-RS256 algorithm even when a key is present", async () => {
    const es256Key = await generateEs256Key();
    const token = await signIdToken(es256Key, validIdTokenClaims(), {
      alg: "ES256",
    });
    await expect(verifierFor(keys).verify(token, params)).rejects.toThrow();
  });
});
