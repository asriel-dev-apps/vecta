import { describe, expect, it } from "vitest";
import { todayInProjectTimeZone } from "~/dashboard/as-of-date";

/**
 * The dashboard's default as-of date. The zone is fixed rather than the
 * runtime's, and this file exists because the failure it prevents is invisible:
 * a Worker runs in UTC, so for nine hours of every JST day "today" and "today in
 * UTC" are different dates, and the screen would open on yesterday's plan with
 * nothing on it to say so.
 */
describe("todayInProjectTimeZone", () => {
  it("HEADLINE: an early-morning JST instant is TODAY in Japan, not yesterday in UTC", () => {
    // 2026-07-31T08:00 JST is 2026-07-30T23:00 UTC — the case a naive
    // `toISOString().slice(0, 10)` gets wrong, every single morning.
    const instant = new Date("2026-07-30T23:00:00.000Z");

    expect(todayInProjectTimeZone(instant)).toBe("2026-07-31");
    // The control: the same instant read as UTC really does give the other date,
    // so this test is measuring the conversion and not agreeing with itself.
    expect(instant.toISOString().slice(0, 10)).toBe("2026-07-30");
  });

  it("rolls over at 15:00 UTC, which is midnight JST", () => {
    expect(todayInProjectTimeZone(new Date("2026-07-30T14:59:59.999Z"))).toBe("2026-07-30");
    expect(todayInProjectTimeZone(new Date("2026-07-30T15:00:00.000Z"))).toBe("2026-07-31");
  });

  it("pads month and day to a plain ISO calendar date", () => {
    // The dashboard hands this straight to <input type="date">, which accepts
    // exactly `YYYY-MM-DD` and silently shows nothing for anything else.
    expect(todayInProjectTimeZone(new Date("2026-01-05T03:00:00.000Z"))).toBe("2026-01-05");
    expect(todayInProjectTimeZone(new Date("2026-12-31T20:00:00.000Z"))).toBe("2027-01-01");
    expect(todayInProjectTimeZone(new Date("2026-01-05T03:00:00.000Z"))).toMatch(
      /^\d{4}-\d{2}-\d{2}$/u,
    );
  });
});
