import { describe, expect, it } from "vitest";
import { calculateEffortEvm, calculateTaskEffort, type EffortTaskInput } from "../src/index.js";

/**
 * AC over time (Design 0011).
 *
 * The verification standard's correction to the Phase 2 order rests on a
 * measurement: AC had no time axis at all. Three status dates over one fixture
 * left AC at 0.625 person-days and CPI a constant 0.8, so an "EVM trend" drawn
 * before this feature would have been a PV curve and two flat lines.
 *
 * These tests pin both halves of the fix, and the pair is the point:
 *
 *   * POSITIVE — a task WITH dated actuals answers a status date. Without it,
 *     "AC(t)" is a phrase rather than a quantity.
 *   * REGRESSION — a task WITHOUT them answers exactly what it answered before.
 *     Production has no dated actuals anywhere, so this feature must move none of
 *     its numbers; and this alone would pass against a no-op implementation,
 *     which is why it is only ever asserted next to the positive.
 */

const base: EffortTaskInput = {
  id: "T1",
  plannedEffortMinutes: 480,
  progressBasisPoints: 5_000,
  actualEffortMinutes: 300, // W = 5 person-hours, the un-dated fallback
  dailyPlan: { "2026-08-01": 240, "2026-08-15": 240 },
};

describe("AC as of a status date", () => {
  it("counts only the dated actuals on or before the status date", () => {
    const task: EffortTaskInput = {
      ...base,
      datedActualsByDate: { "2026-08-01": 120, "2026-08-15": 240 },
    };

    // Before anything was logged.
    expect(calculateTaskEffort(task, "2026-07-31").actualEffortHours).toBe(0);
    // The first day only — 120 min = 2 h.
    expect(calculateTaskEffort(task, "2026-08-10").actualEffortHours).toBe(2);
    // Both — 360 min = 6 h.
    expect(calculateTaskEffort(task, "2026-08-20").actualEffortHours).toBe(6);
  });

  it("ignores the stored total once dated actuals exist", () => {
    // W says 300 minutes; the dated rows say 360. The dated rows win, because
    // they are the ones that can answer "as of when". The grid surfaces the
    // disagreement as a row warning rather than silently reconciling it.
    const task: EffortTaskInput = {
      ...base,
      actualEffortMinutes: 300,
      datedActualsByDate: { "2026-08-01": 360 },
    };
    expect(calculateTaskEffort(task, "2026-08-31").actualEffortHours).toBe(6);
  });

  it("REGRESSION: a task with no dated actuals answers exactly as before", () => {
    // The same three status dates that measured the degenerate behaviour. They
    // must still be degenerate here — every task in production is this task.
    for (const statusDate of ["2026-07-31", "2026-08-10", "2026-08-20"]) {
      expect(calculateTaskEffort(base, statusDate).actualEffortHours).toBe(5);
    }
    // An explicitly EMPTY map is the same case as an absent one: "imported
    // nothing" must not read as "logged nothing".
    expect(
      calculateTaskEffort({ ...base, datedActualsByDate: {} }, "2026-08-20").actualEffortHours,
    ).toBe(5);
  });

  it("moves CPI, which was the metric that could not move", () => {
    const tasks: readonly EffortTaskInput[] = [
      {
        id: "T",
        plannedEffortMinutes: 480,
        progressBasisPoints: 5_000,
        actualEffortMinutes: 480,
        dailyPlan: { "2026-08-01": 480 },
        datedActualsByDate: { "2026-08-01": 120, "2026-08-15": 360 },
      },
    ];
    // EV is M × T = 8 h × 0.5 = 4 h either way; only AC moves.
    const early = calculateEffortEvm({ statusDate: "2026-08-10", tasks }).rollup;
    const late = calculateEffortEvm({ statusDate: "2026-08-20", tasks }).rollup;
    expect(early.ac).toBe(0.25); // 120 min = 2 h = 0.25 person-days
    expect(late.ac).toBe(1); // 480 min = 8 h = 1 person-day
    expect(early.cpi).toBe(2); // 0.5 / 0.25
    expect(late.cpi).toBe(0.5); // 0.5 / 1
    expect(early.cpi).not.toBe(late.cpi);
  });
});
