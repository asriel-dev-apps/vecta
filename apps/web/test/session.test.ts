import { describe, expect, it } from "vitest";
import {
  SESSION_TTL_SECONDS,
  commitNewSession,
  readSession,
} from "~/server/auth/session.server";
import {
  clearOidcTx,
  readOidcTx,
  serializeOidcTx,
  type OidcTransaction,
} from "~/server/auth/oidc-tx.server";
import { cookiePair, fakeEnv } from "./helpers";

const env = fakeEnv();

function requestWithCookie(setCookie: string): Request {
  return new Request("https://app.example.invalid/", {
    headers: { Cookie: cookiePair(setCookie) },
  });
}

describe("session cookie {principalId, exp}", () => {
  it("round-trips a fresh session", async () => {
    const setCookie = await commitNewSession(env, "principal-1");
    const session = await readSession(env, requestWithCookie(setCookie));
    expect(session?.principalId).toBe("principal-1");
    expect(session?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("uses a 7-day absolute lifetime (Max-Age matched to exp)", async () => {
    const setCookie = await commitNewSession(env, "principal-1");
    expect(setCookie).toMatch(new RegExp(`Max-Age=${SESSION_TTL_SECONDS}`));
  });

  it("REJECTS a session whose in-payload exp is in the past (P0)", async () => {
    const t0 = 1_000_000_000_000; // fixed ms clock
    const setCookie = await commitNewSession(env, "principal-1", () => t0);
    // Read far beyond the 7-day exp: RR does not enforce expiry, our check must.
    const laterMs = t0 + (SESSION_TTL_SECONDS + 60) * 1000;
    const session = await readSession(
      env,
      requestWithCookie(setCookie),
      () => laterMs,
    );
    expect(session).toBeNull();
  });

  it("returns null for a missing cookie", async () => {
    const request = new Request("https://app.example.invalid/");
    expect(await readSession(env, request)).toBeNull();
  });

  it("returns null for a tampered signature", async () => {
    const setCookie = await commitNewSession(env, "principal-1");
    const tampered = cookiePair(setCookie).slice(0, -3) + "zzz";
    const request = new Request("https://app.example.invalid/", {
      headers: { Cookie: tampered },
    });
    expect(await readSession(env, request)).toBeNull();
  });

  it("rejects a cookie signed with a different secret", async () => {
    const setCookie = await commitNewSession(
      fakeEnv({ SESSION_SECRET: "some-other-secret-entirely-0000000000" }),
      "principal-1",
    );
    expect(await readSession(env, requestWithCookie(setCookie))).toBeNull();
  });

  it("carries HttpOnly; Secure; SameSite=Lax and the __Host- name", async () => {
    const setCookie = await commitNewSession(env, "principal-1");
    expect(setCookie).toMatch(/^__Host-vecta_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
  });
});

describe("oidc_tx transient cookie", () => {
  const tx: OidcTransaction = {
    state: "state-abc",
    nonce: "nonce-abc",
    codeVerifier: "verifier-abc",
    returnTo: "/projects/7",
  };

  it("round-trips the transaction", async () => {
    const setCookie = await serializeOidcTx(env, tx);
    const parsed = await readOidcTx(env, requestWithCookie(setCookie));
    expect(parsed).toEqual(tx);
  });

  it("is scoped to Path=/auth and short-lived", async () => {
    const setCookie = await serializeOidcTx(env, tx);
    expect(setCookie).toMatch(/Path=\/auth/);
    expect(setCookie).toMatch(/Max-Age=600/);
  });

  it("set carries HttpOnly; Secure; SameSite=Lax; Path=/auth and the __Secure- name", async () => {
    const setCookie = await serializeOidcTx(env, tx);
    expect(setCookie).toMatch(/^__Secure-oidc_tx=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\/auth/);
  });

  it("cleared carries the matching Path=/auth and __Secure- name (a mismatched Path would not clear it)", async () => {
    const cleared = await clearOidcTx(env);
    expect(cleared).toMatch(/^__Secure-oidc_tx=/);
    expect(cleared).toMatch(/Path=\/auth/);
    expect(cleared).toMatch(/Max-Age=0/);
    expect(cleared).toMatch(/HttpOnly/i);
    expect(cleared).toMatch(/Secure/i);
    expect(cleared).toMatch(/SameSite=Lax/i);
  });

  it("returns null when the cookie is missing (also the expired case)", async () => {
    const request = new Request("https://app.example.invalid/auth/callback");
    expect(await readOidcTx(env, request)).toBeNull();
  });

  it("returns null for a tampered cookie", async () => {
    const setCookie = await serializeOidcTx(env, tx);
    const tampered = cookiePair(setCookie).slice(0, -3) + "zzz";
    const request = new Request("https://app.example.invalid/auth/callback", {
      headers: { Cookie: tampered },
    });
    expect(await readOidcTx(env, request)).toBeNull();
  });
});
