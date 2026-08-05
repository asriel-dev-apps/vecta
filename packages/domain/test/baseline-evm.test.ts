import { describe, expect, it } from "vitest";
import { calculateBaselineEvm, type BaselineTaskInput } from "../src/baseline-evm.js";
import { calculateEffortEvm } from "../src/evm.js";

/**
 * Design 0009. The controls here are the ones the design named, and each pair is
 * deliberate: a check that only says "SV/SPI did not move" also passes on an
 * implementation where they never move at all.
 */

const DAY = 480; // person-minutes in a person-day

/** Two leaves, one day of plan each, planned on 08-01 and 09-01. */
const baselineTasks: readonly BaselineTaskInput[] = [
  { id: "a", dailyPlan: { "2026-08-01": DAY } },
  { id: "b", dailyPlan: { "2026-09-01": DAY } },
];

const run = (progress: Record<string, number>, statusDate = "2026-08-15") =>
  calculateBaselineEvm({ statusDate, baselineTasks, progressByTaskId: progress });

describe("calculateBaselineEvm", () => {
  it("HEADLINE: PV comes from the frozen plot and EV from M_baseline x T_current", () => {
    // Through 08-15 only task a's day has been planned, so PV is 1 of the 2-day
    // budget. Task a is half done, b untouched: EV = 1 x 0.5 + 1 x 0 = 0.5.
    const rollup = run({ a: 5_000 });
    expect(rollup.bac).toBe(2);
    expect(rollup.pv).toBe(1);
    expect(rollup.ev).toBe(0.5);
    expect(rollup.sv).toBe(-0.5);
    expect(rollup.spi).toBe(0.5);
  });

  it("CONTROL (decision b): a task added AFTER publishing cannot move SV or SPI", () => {
    // Under the rejected option (a), EV would come from the current plan and this
    // task's plot would enter EV without entering PV — so adding work would
    // IMPROVE SPI. Here it is simply absent from the baseline scope.
    const before = run({ a: 5_000 });
    const after = calculateBaselineEvm({
      statusDate: "2026-08-15",
      baselineTasks, // unchanged: the new task is not in the baseline
      progressByTaskId: { a: 5_000, "added-later": 10_000 },
    });
    expect(after.sv).toBe(before.sv);
    expect(after.spi).toBe(before.spi);
    expect(after.bac).toBe(before.bac);
  });

  it("CONTROL (pair): progress on a task that IS in the baseline does move them", () => {
    // Without this, "SV/SPI never move" would satisfy the test above. The pair is
    // what distinguishes baseline scoping from a frozen number.
    const half = run({ a: 5_000 });
    const whole = run({ a: 10_000 });
    expect(whole.ev).toBeGreaterThan(half.ev);
    expect(whole.sv).toBeGreaterThan(half.sv);
    expect(whole.spi).toBe(1);
  });

  it("a task DELETED after publishing keeps hurting SV", () => {
    // No progress entry at all: read as 0 %. Planned work that vanished is
    // schedule variance, not an improvement.
    const rollup = run({});
    expect(rollup.pv).toBe(1);
    expect(rollup.ev).toBe(0);
    expect(rollup.sv).toBe(-1);
    expect(rollup.spi).toBe(0);
  });

  it("PUBLISH-TIME EQUALITY: at the instant of publishing, baseline PV equals current PV", () => {
    // The design's positive control. It only holds if the snapshot really is the
    // current plot and the leaf filter matches — it fails on a snapshot that
    // dropped rows, included summary rows, or was taken from the wrong field.
    const current = calculateEffortEvm({
      statusDate: "2026-08-15",
      tasks: baselineTasks.map((task) => ({
        id: task.id,
        plannedEffortMinutes: DAY,
        progressBasisPoints: 5_000,
        actualEffortMinutes: 120,
        dailyPlan: task.dailyPlan,
      })),
    }).rollup;
    const baseline = run({ a: 5_000, b: 5_000 });
    expect(baseline.pv).toBe(current.pv);
    expect(baseline.bac).toBe(current.bac);
    expect(baseline.ev).toBe(current.ev);
  });

  it("does not roll up summary rows, so a parent cannot double-count its children", () => {
    const withParent = calculateBaselineEvm({
      statusDate: "2026-08-15",
      baselineTasks: [
        { id: "p", dailyPlan: { "2026-08-01": DAY * 2 }, isLeaf: false },
        { id: "c1", dailyPlan: { "2026-08-01": DAY }, isLeaf: true },
        { id: "c2", dailyPlan: { "2026-08-01": DAY }, isLeaf: true },
      ],
      progressByTaskId: {},
    });
    expect(withParent.bac).toBe(2);
  });

  it("a frozen plot with no days contributes nothing, exactly as the live rollup does", () => {
    // Measured 2026-08-05 and recorded in design 0009 section 3.1: BAC comes from
    // the daily plot, so an unplotted task is 0 whatever its estimate says. The
    // publish command warns about these; the arithmetic does not hide them.
    const rollup = calculateBaselineEvm({
      statusDate: "2026-08-15",
      baselineTasks: [{ id: "unplotted", dailyPlan: {} }],
      progressByTaskId: { unplotted: 10_000 },
    });
    expect(rollup.bac).toBe(0);
    expect(rollup.pv).toBe(0);
    expect(rollup.spi).toBe("-");
  });

  it("keeps the zero-denominator convention rather than inventing another", () => {
    const beforeAnyPlannedDay = run({ a: 10_000 }, "2026-07-01");
    expect(beforeAnyPlannedDay.pv).toBe(0);
    expect(beforeAnyPlannedDay.spi).toBe("-");
  });
});
