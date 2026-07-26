import { describe, expect, it } from "vitest";
import { safeReturnTo } from "~/server/auth/redirect";

describe("safeReturnTo (open-redirect guard, P0)", () => {
  const table: Array<[string, string | null | undefined, string]> = [
    ["same-site path is kept", "/x", "/x"],
    ["nested path is kept", "/projects/42/wbs?tab=1", "/projects/42/wbs?tab=1"],
    ["protocol-relative // is rejected", "//evil.com", "/"],
    ["backslash /\\ is rejected", "/\\evil.com", "/"],
    ["absolute URL is rejected", "https://evil.com", "/"],
    ["empty string falls back", "", "/"],
    ["null falls back", null, "/"],
    ["undefined falls back", undefined, "/"],
    ["non-slash relative is rejected", "evil.com", "/"],
  ];

  for (const [name, input, expected] of table) {
    it(name, () => {
      expect(safeReturnTo(input)).toBe(expected);
    });
  }
});

/**
 * M2 of the 2026-07-27 ASVS L2 scan. Two independent readers looked at the same
 * function and reached OPPOSITE conclusions — one called the tab "same-origin,
 * harmless" — and only measuring how a browser RESOLVES the string settled it.
 * So the browser's own resolution is a test here, not a comment.
 */
describe("safeReturnTo — the characters a URL parser deletes", () => {
  const RESOLUTION_BASE = "https://vecta.example.com";

  const stripped: Array<[string, string]> = [
    ["TAB", "\t"],
    ["LF", "\n"],
    ["CR", "\r"],
  ];

  for (const [name, character] of stripped) {
    it(`CONTROL: a browser resolves /${name}/evil off-origin`, () => {
      // If this ever stops being true the guard below is testing nothing, and a
      // green run would mean the opposite of what it looks like.
      const resolved = new URL(`/${character}/evil.invalid`, RESOLUTION_BASE);
      expect(resolved.origin).toBe("https://evil.invalid");
    });

    it(`rejects a ${name} smuggled through returnTo`, () => {
      // The live shape: `/login?returnTo=%2F%09%2Fevil.invalid`. `searchParams.get`
      // decodes the escape, so the guard sees the raw character.
      const decoded = new URL(
        `/login?returnTo=${encodeURIComponent(`/${character}/evil.invalid`)}`,
        RESOLUTION_BASE,
      ).searchParams.get("returnTo");
      expect(decoded).toBe(`/${character}/evil.invalid`);
      expect(safeReturnTo(decoded)).toBe("/");
    });

    it(`rejects a ${name} with a backslash too`, () => {
      expect(safeReturnTo(`/${character}\\evil.invalid`)).toBe("/");
    });
  }

  it("rejects a NUL and a DEL, not just the three that resolve", () => {
    // Escapes, never literals: a NUL byte in a tracked file makes grep treat the
    // whole file as binary, which silently blinds the repo's own leak audit.
    expect(safeReturnTo("/\u0000/evil.invalid")).toBe("/");
    expect(safeReturnTo("/\u007F/evil.invalid")).toBe("/");
  });

  it("keeps a percent-ENCODED tab, which the parser does not decode into the path", () => {
    // %09 stays encoded through resolution, so it never becomes a delimiter and
    // the path stays same-origin. Rejecting it would be a false positive.
    expect(new URL("/%09/ok", RESOLUTION_BASE).origin).toBe(RESOLUTION_BASE);
    expect(safeReturnTo("/%09/ok")).toBe("/%09/ok");
  });
});

describe("safeReturnTo — layer 2 does not depend on the enumeration being right", () => {
  it("returns what the URL parser resolved, so approval and resolution agree", () => {
    // Normalisation happens once, here, rather than differently in every browser
    // that later resolves the `Location`.
    expect(safeReturnTo("/projects/../projects/42/wbs")).toBe("/projects/42/wbs");
    expect(safeReturnTo("/projects/42/wbs#top")).toBe("/projects/42/wbs#top");
    expect(safeReturnTo("/projects/42/wbs?a=1&b=2")).toBe("/projects/42/wbs?a=1&b=2");
  });

  it("cannot be walked above the root", () => {
    expect(safeReturnTo("/../../etc/passwd")).toBe("/etc/passwd");
  });

  it("still rejects a candidate that only layer 2 could catch", () => {
    // A single leading slash followed by a backslash-run: the string tests only
    // look at the first two characters, the parser folds the lot into `//`.
    expect(safeReturnTo("/\\\\evil.invalid")).toBe("/");
  });
});
