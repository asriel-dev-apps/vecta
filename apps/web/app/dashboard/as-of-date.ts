/**
 * "Today" for the EVM dashboard's as-of date (design 0007 §4-2, C-8).
 *
 * Resolved SERVER-SIDE and passed down as a prop, never read from the clock
 * during render: the initial as-of date is React state, so a client that computed
 * its own "today" would hydrate a different value than the server rendered.
 *
 * The zone is fixed to Asia/Tokyo rather than the runtime's. The Worker runs in
 * UTC, so a user opening the screen at 08:00 JST would otherwise be shown
 * yesterday — and every date in this product is a local calendar date (the WBS
 * daily plan, `projectStart`, `statusDate`), entered by a Japanese team in a
 * Japanese-language, JPY-denominated app. There is no per-user timezone to read,
 * and inventing one is not this screen's decision to make.
 */
const PROJECT_TIME_ZONE = "Asia/Tokyo";

const DATE_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: PROJECT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * `now` as an ISO calendar date in {@link PROJECT_TIME_ZONE}. Takes the instant as
 * an argument so the conversion is testable without mocking the clock.
 *
 * Assembled from `formatToParts` rather than from a formatted string: a locale's
 * output order is a presentation detail, and reading it positionally is how this
 * silently returns a day/month swap on a runtime whose ICU data differs.
 */
export function todayInProjectTimeZone(now: Date): string {
  const parts = new Map(
    DATE_PARTS.formatToParts(now).map((part) => [part.type, part.value] as const),
  );
  const year = parts.get("year");
  const month = parts.get("month");
  const day = parts.get("day");
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error("Could not resolve the current date in the project time zone");
  }
  return `${year}-${month}-${day}`;
}
