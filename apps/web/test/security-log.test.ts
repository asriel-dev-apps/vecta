// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestIdOf,
  subjectDigest,
  writeSecurityEvent,
  type SubjectDigest,
} from "~/server/security-log.server";
import { fakeEnv } from "./helpers";

/**
 * M3 of the 2026-07-27 ASVS L2 scan: no authentication or authorization event
 * was recorded anywhere, so `operations/monitoring-and-alerts.md`'s required
 * "changes in 401/403" signal had no producer.
 *
 * The rule these tests exist to hold: a security event may carry an INTERNAL
 * UUID and a keyed digest, and nothing else that identifies a person. Every
 * "the secret is absent" assertion is paired with a "…and the digest is
 * present" one, because a logger that emitted nothing at all would otherwise
 * pass every leak check in this file.
 */

const EMAIL = "person@example.com";
const SUBJECT = "104729000000000000001";
const ISSUER = "https://accounts.google.example.invalid";

function captureConsole(): {
  readonly warn: string[];
  readonly log: string[];
  restore: () => void;
} {
  const warn: string[] = [];
  const log: string[] = [];
  const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warn.push(args.map((value) => String(value)).join(" "));
  });
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    log.push(args.map((value) => String(value)).join(" "));
  });
  return {
    warn,
    log,
    restore: () => {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

async function digest(subject: string, env = fakeEnv()): Promise<SubjectDigest> {
  return subjectDigest(env, ISSUER, subject);
}

describe("subjectDigest — the only identifier allowed for someone with no principal", () => {
  it("is 16 hex characters and reveals neither the subject nor an email", async () => {
    const value = await digest(SUBJECT);

    // The control: assert the digest EXISTS and has the expected shape first, so
    // the two `not.toContain`s below cannot pass on an empty string.
    expect(value).toMatch(/^[0-9a-f]{16}$/);
    expect(value).not.toContain(SUBJECT);
    expect(value).not.toContain(EMAIL);
  });

  it("is stable for the same pair and different for a different subject", async () => {
    expect(await digest(SUBJECT)).toBe(await digest(SUBJECT));
    expect(await digest(SUBJECT)).not.toBe(await digest("104729000000000000002"));
  });

  it("is KEYED: the same subject digests differently under a different SESSION_SECRET", async () => {
    // This is the property a plain SHA-256 would not have, and the reason the
    // implementation uses HMAC: someone with log access plus a candidate subject
    // must not be able to confirm "was it this account?".
    const other = fakeEnv({ SESSION_SECRET: "a-different-session-secret-000000000" });
    expect(await digest(SUBJECT)).not.toBe(await digest(SUBJECT, other));
  });

  it("refuses to produce a digest with no key configured", async () => {
    const env = { SESSION_SECRET: "" } as unknown as Env;
    await expect(subjectDigest(env, ISSUER, SUBJECT)).rejects.toThrow(/SESSION_SECRET/);
  });
});

describe("writeSecurityEvent", () => {
  it("emits one JSON line with the shared vocabulary", () => {
    const captured = captureConsole();
    writeSecurityEvent({
      kind: "project_access_denied",
      reason: "not_a_member",
      status: 404,
      request: new Request("https://vecta.example.com/projects/p-1/wbs", {
        headers: { "x-request-id": "11111111-2222-3333-4444-555555555555" },
      }),
      params: { id: "p-1" },
      principalId: "018f2c3d-0000-7000-8000-000000000001",
      projectId: "p-1",
    });
    captured.restore();

    expect(captured.warn).toHaveLength(1);
    expect(JSON.parse(captured.warn[0] ?? "")).toEqual({
      event: "security_event",
      kind: "project_access_denied",
      reason: "not_a_member",
      requestId: "11111111-2222-3333-4444-555555555555",
      method: "GET",
      route: "/projects/:id/wbs",
      status: 404,
      principalId: "018f2c3d-0000-7000-8000-000000000001",
      projectId: "p-1",
    });
  });

  it("omits the optional fields rather than emitting nulls", () => {
    const captured = captureConsole();
    writeSecurityEvent({
      kind: "session_rejected",
      reason: "cookie_absent",
      status: 302,
      request: new Request("https://vecta.example.com/projects"),
    });
    captured.restore();

    const record = JSON.parse(captured.warn[0] ?? "") as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual([
      "event",
      "kind",
      "method",
      "reason",
      "requestId",
      "route",
      "status",
    ]);
    expect(record.requestId).toBe("unknown");
  });

  it("sends the one success to `log` and every denial to `warn`", () => {
    const captured = captureConsole();
    writeSecurityEvent({
      kind: "login_succeeded",
      reason: "session_issued",
      status: 302,
      request: new Request("https://vecta.example.com/auth/callback"),
      principalId: "principal-1",
    });
    writeSecurityEvent({
      kind: "login_failed",
      reason: "state_mismatch",
      status: 400,
      request: new Request("https://vecta.example.com/auth/callback"),
    });
    captured.restore();

    expect(captured.log).toHaveLength(1);
    expect(captured.warn).toHaveLength(1);
    expect((JSON.parse(captured.log[0] ?? "") as { kind: string }).kind).toBe("login_succeeded");
  });

  it("passes an error through the `/api` name allowlist, never its message", () => {
    const hostile = new Error("connection string: postgresql://u:PASSWORD@host/db");
    hostile.name = `Weird" ,"kind":"login_succeeded`;

    const captured = captureConsole();
    writeSecurityEvent({
      kind: "login_failed",
      reason: "unexpected_error",
      status: 503,
      request: new Request("https://vecta.example.com/auth/callback"),
      error: hostile,
    });
    captured.restore();

    expect(captured.warn).toHaveLength(1);
    const record = JSON.parse(captured.warn[0] ?? "") as Record<string, unknown>;
    expect(record.errorName).toBe("UnknownError");
    expect(record.kind).toBe("login_failed");
    expect(captured.warn.join("\n")).not.toContain("PASSWORD");
  });

  it("cannot be made to forge a second record from an attacker-chosen path", () => {
    const captured = captureConsole();
    writeSecurityEvent({
      kind: "session_rejected",
      reason: "cookie_invalid",
      status: 302,
      request: new Request(
        `https://vecta.example.com/${encodeURIComponent('x","kind":"login_succeeded')}`,
      ),
    });
    captured.restore();

    expect(captured.warn).toHaveLength(1);
    const record = JSON.parse(captured.warn[0] ?? "") as Record<string, unknown>;
    expect(record.kind).toBe("session_rejected");
    expect(String(record.route)).not.toContain('"');
  });
});

describe("requestIdOf", () => {
  it("reads the id the document edge stamps", () => {
    expect(
      requestIdOf(
        new Request("https://vecta.example.com/", { headers: { "x-request-id": "abc" } }),
      ),
    ).toBe("abc");
  });

  it("says `unknown` rather than omitting the field", () => {
    expect(requestIdOf(new Request("https://vecta.example.com/"))).toBe("unknown");
  });
});
