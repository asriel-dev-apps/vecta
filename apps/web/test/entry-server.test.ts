// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { handleError } from "~/entry.server";
// `documentRoute` moved to the security-log module when the auth middleware and
// the project gate started needing it too (ASVS M3). Its tests stay here, next
// to the handler whose log line it shapes.
import { documentRoute } from "~/server/security-log.server";

/**
 * H1 of the 2026-07-27 ASVS L2 scan: the document surface had no `handleError`,
 * so React Router's default printed the whole `Error` — and `neon()`'s "not a
 * valid URL" exception carries the connection string, password included, into
 * Cloudflare Workers Logs.
 *
 * Every test here is paired with a CONTROL that asserts the framework default
 * WOULD have leaked the same fixture. Without it, a suite that stopped exercising
 * anything would report the same green as a suite that is doing its job.
 */

const PASSWORD = "npg_TESTONLYnotarealsecret";

/**
 * The exact message `@neondatabase/serverless@1.1.0` throws, reproduced from the
 * library itself rather than paraphrased: `neon()` parses with its own URL
 * routine and, on failure, throws
 * `"Database connection string provided to \`neon()\` is not a valid URL. Connection string: " + String(input)`.
 *
 * Measured 2026-07-27 against the real library, all three malformed shapes
 * `wrangler secret put` can pick up from a paste — quoted, `psql `-prefixed, and
 * leading-whitespace — throw, and ALL THREE put the password in the message.
 * (The scan report's table says a leading space is tolerated; that is true of
 * `new URL`, but `neon()` does not use `new URL`. Corrected here.)
 *
 * **The string is byte-identical in 1.1.0 and in 0.10.4** — checked against the
 * published 1.1.0 tarball during the 0.x → 1.x bump, not assumed from the
 * changelog. So the disclosure this file exists to prevent survived the major
 * version, and so does the fixture.
 */
function neonUrlParseError(): Error {
  return new Error(
    "Database connection string provided to `neon()` is not a valid URL. Connection string: " +
      `"postgresql://vecta_owner:${PASSWORD}@ep-example-123456.ap-southeast-1.aws.neon.tech/vecta"`,
  );
}

function requestFor(url: string, init?: RequestInit): Request {
  return new Request(url, init);
}

function captureConsoleError(): { readonly lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((value) => String(value)).join(" "));
  });
  return { lines, restore: () => spy.mockRestore() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleError — the secret never reaches the log", () => {
  it("CONTROL: the framework default would have printed the password", () => {
    // React Router 8.2.0's default is
    // `console.error(isRouteErrorResponse(error) && error.error ? error.error : error)`.
    // Reproduce that call with the same fixture, so this suite fails if the
    // fixture ever stops being dangerous — a green run below would then mean
    // nothing.
    const captured = captureConsoleError();
    console.error(neonUrlParseError());
    captured.restore();

    expect(captured.lines.join("\n")).toContain(PASSWORD);
  });

  it("logs the error NAME and nothing else — no message, no stack, no password", () => {
    const captured = captureConsoleError();
    handleError(neonUrlParseError(), {
      request: requestFor("https://vecta.example.com/projects/p-1/wbs"),
      params: { id: "p-1" },
    });
    captured.restore();

    const line = captured.lines.join("\n");
    expect(line).not.toContain(PASSWORD);
    expect(line).not.toContain("Connection string");
    expect(line).not.toContain("postgresql://");

    expect(JSON.parse(line)).toEqual({
      event: "document_unhandled_error",
      requestId: "unknown",
      method: "GET",
      route: "/projects/:id/wbs",
      phase: "handler",
      errorName: "Error",
    });
  });

  it("emits exactly one line, and it is valid JSON", () => {
    const captured = captureConsoleError();
    handleError(new Error("boom"), {
      request: requestFor("https://vecta.example.com/login"),
      params: {},
    });
    captured.restore();

    expect(captured.lines).toHaveLength(1);
    expect(() => JSON.parse(captured.lines[0] ?? "")).not.toThrow();
  });

  it("passes the error name through the same allowlist `/api` uses", () => {
    // A name that is not a plain identifier is attacker-influenceable in
    // principle (a library can set it from input), so it collapses to
    // `UnknownError` rather than being trusted into the log.
    const hostile = new Error("boom");
    hostile.name = `Weird" ,"leak":"${PASSWORD}`;

    const captured = captureConsoleError();
    handleError(hostile, {
      request: requestFor("https://vecta.example.com/login"),
      params: {},
    });
    captured.restore();

    const record = JSON.parse(captured.lines.join("\n")) as Record<string, unknown>;
    expect(record.errorName).toBe("UnknownError");
    expect(captured.lines.join("\n")).not.toContain(PASSWORD);
  });

  it("carries the request id once something upstream stamps one", () => {
    // Nothing stamps `x-request-id` on the document branch yet (M1 does). The
    // field is wired now so the two surfaces correlate the day it is.
    const captured = captureConsoleError();
    handleError(new Error("boom"), {
      request: requestFor("https://vecta.example.com/login", {
        headers: { "x-request-id": "11111111-2222-3333-4444-555555555555" },
      }),
      params: {},
    });
    captured.restore();

    const record = JSON.parse(captured.lines.join("\n")) as Record<string, unknown>;
    expect(record.requestId).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("stays quiet when the client aborted, matching the framework default", () => {
    const controller = new AbortController();
    controller.abort();
    const request = requestFor("https://vecta.example.com/projects/p-1/wbs", {
      signal: controller.signal,
    });

    const captured = captureConsoleError();
    handleError(new Error("boom"), { request, params: {} });
    captured.restore();

    expect(captured.lines).toEqual([]);
  });
});

describe("documentRoute — the log carries the route, not the identifiers", () => {
  it("replaces every matched param value with its name", () => {
    expect(
      documentRoute("/projects/018f2c3d-0000-7000-8000-000000000001/wbs", {
        id: "018f2c3d-0000-7000-8000-000000000001",
      }),
    ).toBe("/projects/:id/wbs");
  });

  it("leaves a path with no params alone", () => {
    expect(documentRoute("/login", {})).toBe("/login");
  });

  it("ignores empty and undefined param values rather than blanking segments", () => {
    expect(documentRoute("/projects/p-1/wbs", { id: "p-1", rest: undefined, blank: "" })).toBe(
      "/projects/:id/wbs",
    );
  });

  it("matches a param whose value the path had to percent-encode", () => {
    // React Router hands over DECODED params; `URL.pathname` keeps the encoded
    // bytes. Without decoding, this segment does not match its own param value
    // and the attacker's string is echoed into the log — which is exactly the
    // shape the malformed-project-id denial produces.
    expect(
      documentRoute("/projects/not-a-uuid-%3Cscript%3E/wbs", { id: "not-a-uuid-<script>" }),
    ).toBe("/projects/:id/wbs");
  });

  it("survives a malformed escape rather than throwing on it", () => {
    // `decodeURIComponent("%")` throws, and a request path can contain one.
    expect(documentRoute("/projects/%/wbs", { id: "x" })).toBe("/projects/%/wbs");
  });

  it("caps an unmatched (therefore attacker-chosen) path", () => {
    const long = `/${"a".repeat(500)}`;
    const templated = documentRoute(long, {});
    expect(templated.length).toBeLessThanOrEqual(129);
    expect(templated.endsWith("…")).toBe(true);
  });

  it("cannot forge a second log line — TWO layers stop it, measured separately", () => {
    // Layer 1, and the one that actually fires: `new URL(...).pathname` percent-
    // encodes `"` before the route is ever built, so the raw quote never exists.
    const captured = captureConsoleError();
    handleError(new Error("boom"), {
      request: requestFor(
        `https://vecta.example.com/${encodeURIComponent('x","event":"login_success","user":"admin')}`,
      ),
      params: {},
    });
    captured.restore();

    expect(captured.lines).toHaveLength(1);
    const record = JSON.parse(captured.lines[0] ?? "") as Record<string, unknown>;
    expect(record.event).toBe("document_unhandled_error");
    expect(String(record.route)).not.toContain('"');
    expect(String(record.route)).toContain("%22event%22");

    // Layer 2, verified on its own so the first is not the only thing standing:
    // hand `documentRoute` a raw quote directly and confirm `JSON.stringify`
    // still yields one parseable record with the text trapped inside the field.
    const forged = documentRoute('/x","event":"login_success', {});
    const line = JSON.stringify({ event: "document_unhandled_error", route: forged });
    expect(line.split("\n")).toHaveLength(1);
    expect((JSON.parse(line) as Record<string, unknown>).event).toBe("document_unhandled_error");
  });
});
