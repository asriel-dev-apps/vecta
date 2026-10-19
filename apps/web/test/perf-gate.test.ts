import { describe, expect, it } from "vitest";
import { evaluate, median, percentile95, sameMachine, withinTolerance, workGate, workStats, type PerfDoc } from "../perf/gate.mjs";

const run = (p95: number, max: number) => ({ p95, max });
const machine = { os: "Darwin 24 arm64", cpu: "Apple M1 Pro", chrome: "140.0" };
const doc = (overrides: Partial<PerfDoc> = {}): PerfDoc => ({
  machine,
  scenarios: { V500: { work: [run(8, 20)], control: [run(0.4, 1)], correctness: [] } },
  load: { 500: { firstRowMs: [100], editMs: [100], editFailures: [] } },
  ...overrides,
});

describe("tolerance: head <= max(baseline x 1.10, baseline + 20 ms)", () => {
  it("uses the percentage for large baselines and the absolute margin for small ones", () => {
    expect(withinTolerance(1000, 1100)).toBe(true);
    expect(withinTolerance(1000, 1100.5)).toBe(false);
    expect(withinTolerance(106, 126)).toBe(true);
    expect(withinTolerance(106, 126.5)).toBe(false);
  });
});

describe("work-time gate: p95 <= 16 ms and max < 50 ms per scroll step", () => {
  it("passes at p95 exactly 16 ms and max 49.9 ms", () => {
    expect(workGate([run(16, 49.9)]).pass).toBe(true);
  });
  it("fails at p95 16.1 ms", () => {
    expect(workGate([run(16.1, 10)]).failures).toEqual(["work p95 16.1 ms > 16 ms"]);
  });
  it("fails at max exactly 50 ms", () => {
    expect(workGate([run(5, 50)]).failures).toEqual(["work max 50.0 ms >= 50 ms"]);
  });
  it("takes the median p95 over runs but the maximum of the maxima", () => {
    const runs = [run(5, 20), run(5, 20), run(5, 20), run(40, 49), run(40, 80)];
    expect(workGate(runs).summary).toEqual({ p95: 5, max: 80 });
    expect(workGate(runs).pass).toBe(false);
  });
  it("computes p95 as the ceil(0.95 n)-th smallest step and summarises a run", () => {
    const steps = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(percentile95(steps)).toBe(19);
    expect(workStats(steps)).toEqual({ p95: 19, max: 20, mean: 10.5, steps: 20 });
    expect(median([3, 1, 2])).toBe(2);
  });
});

describe("evaluate", () => {
  it("refuses to compare across machines", () => {
    const other = doc({ machine: { ...machine, chrome: "141.0" } });
    expect(sameMachine(machine, other.machine)).toBe(false);
    expect(evaluate(doc(), other)).toEqual({ ok: false, failures: [expect.stringContaining("different machine")] });
  });
  it("fails a control lane that exceeds the gate: the measurement is invalid", () => {
    const noisy = doc({ scenarios: { V500: { work: [run(8, 20)], control: [run(17, 20)], correctness: [] } } });
    expect(evaluate(noisy, null).failures).toEqual([expect.stringContaining("CONTROL lane")]);
  });
  it("fails on a correctness failure even when work time is zero", () => {
    const broken = doc({ scenarios: { V500: { work: [run(0, 0)], control: [run(0, 0)], correctness: ["row 40 missing"] } } });
    expect(evaluate(broken, null).failures).toEqual(["V500: correctness: row 40 missing"]);
  });
  it("fails initial render beyond the tolerance and passes just inside it", () => {
    const inside = doc({ load: { 500: { firstRowMs: [120], editMs: [100], editFailures: [] } } });
    const outside = doc({ load: { 500: { firstRowMs: [121], editMs: [100], editFailures: [] } } });
    expect(evaluate(inside, doc()).ok).toBe(true);
    expect(evaluate(outside, doc()).failures).toEqual([expect.stringContaining("firstRowMs@500")]);
  });
  it("requires the baseline to have the same column counts", () => {
    const baseline = doc({ load: { 45: { firstRowMs: [100], editMs: [100], editFailures: [] } } });
    expect(evaluate(doc(), baseline).failures).toEqual([expect.stringContaining("no 500-column")]);
  });
});
