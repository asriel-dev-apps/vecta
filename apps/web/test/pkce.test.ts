import { describe, expect, it } from "vitest";
import {
  deriveCodeChallenge,
  generateCodeVerifier,
  generateNonce,
  generateState,
} from "~/server/auth/pkce";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe("PKCE / state / nonce generation", () => {
  it("produces url-safe base64 tokens within the RFC 7636 length range", () => {
    for (const value of [generateState(), generateNonce(), generateCodeVerifier()]) {
      expect(value).toMatch(BASE64URL);
      expect(value.length).toBeGreaterThanOrEqual(43);
      expect(value.length).toBeLessThanOrEqual(128);
    }
  });

  it("produces unique values across calls", () => {
    const values = new Set(
      Array.from({ length: 100 }, () => generateCodeVerifier()),
    );
    expect(values.size).toBe(100);
  });

  it("derives a stable S256 challenge from a verifier", async () => {
    const verifier = generateCodeVerifier();
    const challenge = await deriveCodeChallenge(verifier);
    expect(challenge).toMatch(BASE64URL);
    // SHA-256 → 32 bytes → base64url 43 chars, no padding.
    expect(challenge).toHaveLength(43);
    expect(await deriveCodeChallenge(verifier)).toBe(challenge);
  });

  it("matches the RFC 7636 Appendix B test vector", async () => {
    // verifier "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk" →
    // challenge "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    const challenge = await deriveCodeChallenge(
      "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    );
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});
