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
