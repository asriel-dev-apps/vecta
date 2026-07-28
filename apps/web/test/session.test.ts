import { describe, expect, it } from "vitest";
import {
  SESSION_TTL_SECONDS,
  commitNewSession,
  readSession,
  readSessionResult,
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

/**
 * ASVS scan M3. `readSession` collapses three different situations into one
 * `null`, which is right for the CALLER (they must behave identically) and wrong
 * for the LOG: "no cookie" is a crawler, "expired" is Monday morning, and
 * "invalid" is a cookie bearing this name that does not verify — which does not
 * happen in ordinary use.
 */
describe("readSessionResult — why the session was refused", () => {
  it("accepts a fresh session and reports it as ok", async () => {
    const setCookie = await commitNewSession(env, "principal-1");
    const result = await readSessionResult(env, requestWithCookie(setCookie));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.session.principalId).toBe("principal-1");
  });

  it("says `cookie_absent` when nothing was sent", async () => {
    const result = await readSessionResult(env, new Request("https://app.example.invalid/"));
    expect(result).toEqual({ ok: false, reason: "cookie_absent" });
  });

  it("says `cookie_absent` when some OTHER cookie was sent", async () => {
    const request = new Request("https://app.example.invalid/", {
      headers: { Cookie: "ga_something=1; other=2" },
    });
    expect(await readSessionResult(env, request)).toEqual({ ok: false, reason: "cookie_absent" });
  });

  it("says `cookie_invalid` for a tampered signature — the one that is not routine", async () => {
    const setCookie = await commitNewSession(env, "principal-1");
    const tampered = cookiePair(setCookie).slice(0, -3) + "zzz";
    const request = new Request("https://app.example.invalid/", {
      headers: { Cookie: tampered },
    });
    expect(await readSessionResult(env, request)).toEqual({ ok: false, reason: "cookie_invalid" });
  });

  it("says `cookie_invalid` for a cookie signed with a different secret", async () => {
    const setCookie = await commitNewSession(
      fakeEnv({ SESSION_SECRET: "some-other-secret-entirely-0000000000" }),
      "principal-1",
    );
    expect(await readSessionResult(env, requestWithCookie(setCookie))).toEqual({
      ok: false,
      reason: "cookie_invalid",
    });
  });

  it("says `session_expired` for a valid signature past its in-payload exp", async () => {
    const t0 = 1_000_000_000_000;
    const setCookie = await commitNewSession(env, "principal-1", () => t0);
    const laterMs = t0 + (SESSION_TTL_SECONDS + 60) * 1000;
    expect(
      await readSessionResult(env, requestWithCookie(setCookie), () => laterMs),
    ).toEqual({ ok: false, reason: "session_expired" });
  });

  it("finds the cookie even when it is not first in the header", async () => {
    // The reason is derived from the raw `Cookie` header, so the parse has to
    // survive a browser that sends analytics cookies ahead of ours. Without
    // this, a tampered session would be misreported as absent.
    const setCookie = await commitNewSession(env, "principal-1");
    const tampered = cookiePair(setCookie).slice(0, -3) + "zzz";
    const request = new Request("https://app.example.invalid/", {
      headers: { Cookie: `first=1; ${tampered}; last=2` },
    });
    expect(await readSessionResult(env, request)).toEqual({ ok: false, reason: "cookie_invalid" });
  });

  it("is not fooled by a cookie whose NAME merely ends with ours", async () => {
    const request = new Request("https://app.example.invalid/", {
      headers: { Cookie: "not__Host-vecta_session=forged" },
    });
    expect(await readSessionResult(env, request)).toEqual({ ok: false, reason: "cookie_absent" });
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
