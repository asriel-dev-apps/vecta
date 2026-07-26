// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  STAGING_GATE_INTERNALS,
  stagingGate,
  type StagingGateBindings,
} from "~/server/staging-gate.server";

/**
 * This gate is the ONLY thing keeping staging off the public internet (ADR 0014),
 * so it is tested in both directions and the "must be refused" cases outnumber the
 * "must be admitted" ones. A gate that can only be shown to admit is not shown to
 * work at all.
 */

const KEY = "correct-horse-battery-staple";

function bindings(overrides: Partial<StagingGateBindings> = {}): StagingGateBindings {
  return { DEPLOY_ENV: "staging", STAGING_ACCESS_KEY: KEY, ...overrides };
}

function get(
  path = "/",
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://vecta-staging.example.invalid${path}`, { headers });
}

async function decide(request: Request, env: StagingGateBindings) {
  const { response } = await stagingGate(request, env);
  return response;
}

describe("staging gate — inert everywhere except staging", () => {
  it("lets production through untouched, even with a key present", async () => {
    expect(await decide(get(), { DEPLOY_ENV: "production", STAGING_ACCESS_KEY: KEY })).toBeNull();
  });

  it("lets an unlabelled environment through — it is not staging", async () => {
    expect(await decide(get(), {})).toBeNull();
  });
});

describe("staging gate — fail closed", () => {
  it("refuses everything when armed without a key", async () => {
    // A deploy that forgot the secret must serve NOTHING, not everything.
    const response = await decide(get(), { DEPLOY_ENV: "staging" });
    expect(response?.status).toBe(403);
  });

  it("refuses everything when the key is blank", async () => {
    const response = await decide(get(), bindings({ STAGING_ACCESS_KEY: "   " }));
    expect(response?.status).toBe(403);
  });

  it("refuses an anonymous request", async () => {
    expect((await decide(get(), bindings()))?.status).toBe(403);
  });

  it("refuses the API surface too — an unreachable app has no reachable corner", async () => {
    for (const path of ["/api/projects", "/mcp", "/.well-known/oauth-protected-resource", "/login"]) {
      expect((await decide(get(path), bindings()))?.status, path).toBe(403);
    }
  });

  it("refuses a wrong key, a prefix of the key, and the key with something appended", async () => {
    for (const attempt of [KEY.slice(0, -1), `${KEY}x`, "", "wrong"]) {
      const response = await decide(get("/", { "x-staging-key": attempt }), bindings());
      expect(response?.status, JSON.stringify(attempt)).toBe(403);
    }
  });

  it("refuses a forged cookie, including the raw key as the cookie value", async () => {
    // The cookie is an HMAC, so knowing the key does not let you skip the header
    // path — and a cookie stolen from a browser is not replayable as a header.
    for (const value of [KEY, "deadbeef", ""]) {
      const response = await decide(get("/", { cookie: `vecta_stg=${value}` }), bindings());
      expect(response?.status, value).toBe(403);
    }
  });

  it("tells a refused request nothing about the application", async () => {
    const response = await decide(get(), bindings());
    expect(await response?.text()).not.toMatch(/vecta|wbs|project/iu);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(response?.headers.get("x-robots-tag")).toContain("noindex");
  });
});

describe("staging gate — the agent path", () => {
  it("admits the correct key in a header, with no cookie and no browser", async () => {
    expect(await decide(get("/", { "x-staging-key": KEY }), bindings())).toBeNull();
  });

  it("is case-insensitive about the header name, as HTTP requires", async () => {
    expect(await decide(get("/", { "X-Staging-Key": KEY }), bindings())).toBeNull();
  });
});

describe("staging gate — the human path", () => {
  it("mints a cookie from `?__stg=<key>` and redirects without the key", async () => {
    const response = await decide(get(`/projects?__stg=${KEY}`), bindings());
    expect(response?.status).toBe(302);
    // The key must not survive in the address bar, the history, or a Referer.
    expect(response?.headers.get("location")).toBe("/projects");
    const cookie = response?.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    // The cookie carries an HMAC, never the key itself.
    expect(cookie).not.toContain(KEY);
  });

  it("keeps the rest of the query string when it strips the key", async () => {
    const response = await decide(get(`/projects?tab=wbs&__stg=${KEY}`), bindings());
    expect(response?.headers.get("location")).toBe("/projects?tab=wbs");
  });

  it("admits the cookie it minted on the next request", async () => {
    const minted = await decide(get(`/?__stg=${KEY}`), bindings());
    const cookie = (minted?.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(await decide(get("/", { cookie }), bindings())).toBeNull();
  });

  it("invalidates every existing cookie when the key is rotated", async () => {
    // Rotation has to be one command with immediate effect, so the cookie must be
    // derived from the key rather than stored anywhere.
    const minted = await decide(get(`/?__stg=${KEY}`), bindings());
    const cookie = (minted?.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const rotated = bindings({ STAGING_ACCESS_KEY: "a-new-key-entirely" });
    expect((await decide(get("/", { cookie }), rotated))?.status).toBe(403);
  });

  it("refuses a wrong key in the query parameter", async () => {
    expect((await decide(get("/?__stg=nope"), bindings()))?.status).toBe(403);
  });
});

describe("staging gate — the optional IP allowance", () => {
  it("admits an allowlisted address", async () => {
    const env = bindings({ STAGING_ALLOWED_IPS: "203.0.113.7, 198.51.100.4" });
    expect(await decide(get("/", { "cf-connecting-ip": "198.51.100.4" }), env)).toBeNull();
  });

  it("refuses an address that is not on the list", async () => {
    const env = bindings({ STAGING_ALLOWED_IPS: "203.0.113.7" });
    expect((await decide(get("/", { "cf-connecting-ip": "203.0.113.8" }), env))?.status).toBe(403);
  });

  it("is genuinely optional — an unset list does not admit anyone", async () => {
    expect((await decide(get("/", { "cf-connecting-ip": "203.0.113.7" }), bindings()))?.status).toBe(
      403,
    );
  });

  it("does not treat an empty list entry as a wildcard", async () => {
    const env = bindings({ STAGING_ALLOWED_IPS: " , ,, " });
    expect((await decide(get("/", { "cf-connecting-ip": "" }), env))?.status).toBe(403);
    expect((await decide(get(), env))?.status).toBe(403);
  });
});

describe("staging gate — the cookie token", () => {
  it("is deterministic for a key, so the gate needs no stored state", async () => {
    const first = await STAGING_GATE_INTERNALS.cookieTokenFor(KEY);
    const second = await STAGING_GATE_INTERNALS.cookieTokenFor(KEY);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("differs per key", async () => {
    const a = await STAGING_GATE_INTERNALS.cookieTokenFor(KEY);
    const b = await STAGING_GATE_INTERNALS.cookieTokenFor(`${KEY}!`);
    expect(a).not.toBe(b);
  });
});
