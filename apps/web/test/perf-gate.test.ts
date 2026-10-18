import { describe, expect, it } from "vitest";
import { evaluate, frameGate, median, sameMachine, withinTolerance, type PerfDoc } from "../perf/gate.mjs";

const sweep = (framesOver50: number, p95FrameMs: number, worstFrameMs: number) => ({ framesOver50, p95FrameMs, worstFrameMs });
const machine = { os: "Darwin 24 arm64", cpu: "Apple M1 Pro", chrome: "140.0" };
const doc = (overrides: Partial<PerfDoc> = {}): PerfDoc => ({
  machine,
  scenarios: { V500: { sweeps: [sweep(1, 20, 60)], correctness: [] } },
  load: { 500: { firstRowMs: [100], editMs: [100], editFailures: [] } },
  ...overrides,
});

describe("tolerance: head <= max(baseline x 1.10, baseline + 20 ms)", () => {
  it("uses the percentage for large baselines and the absolute margin for small ones", () => {
    expect(withinTolerance(1000, 1100)).toBe(true); // x1.10 = 1100
    expect(withinTolerance(1000, 1100.5)).toBe(false);
    expect(withinTolerance(106, 126)).toBe(true); // + 20 ms beats x1.10 = 116.6
    expect(withinTolerance(106, 126.5)).toBe(false);
    expect(withinTolerance(180, 200)).toBe(true);
    expect(withinTolerance(180, 200.5)).toBe(false);
  });
});

describe("frame gate", () => {
  it("passes exactly at 20 slow frames, p95 33 ms and worst 99 ms", () => {
    expect(frameGate([sweep(20, 33, 99)]).pass).toBe(true);
  });
  it("fails at 21 slow frames, p95 33.1 ms, or worst exactly 100 ms", () => {
    expect(frameGate([sweep(21, 33, 99)]).pass).toBe(false);
    expect(frameGate([sweep(20, 33.1, 99)]).pass).toBe(false);
    expect(frameGate([sweep(20, 33, 100)]).pass).toBe(false);
  });
  it("judges the worst frame by the maximum over runs, not the median", () => {
    const runs = [60, 60, 60, 500, 500].map((worst) => sweep(1, 20, worst));
    expect(median(runs.map((run) => run.worstFrameMs))).toBe(60);
    expect(frameGate(runs).pass).toBe(false);
  });
});

describe("evaluate", () => {
  it("refuses to compare across machines", () => {
    const other = doc({ machine: { ...machine, chrome: "141.0" } });
    expect(sameMachine(machine, other.machine)).toBe(false);
    expect(evaluate(doc(), other)).toEqual({ ok: false, failures: [expect.stringContaining("different machine")] });
  });
  it("fails a regression of initial render beyond the tolerance and passes just inside it", () => {
    const baseline = doc();
    const inside = doc({ load: { 500: { firstRowMs: [120], editMs: [100], editFailures: [] } } });
    const outside = doc({ load: { 500: { firstRowMs: [121], editMs: [100], editFailures: [] } } });
    expect(evaluate(inside, baseline).ok).toBe(true);
    expect(evaluate(outside, baseline).failures).toEqual([expect.stringContaining("firstRowMs@500")]);
  });
  it("fails on a correctness failure even when every frame is perfect", () => {
    const broken = doc({ scenarios: { V500: { sweeps: [sweep(0, 8, 17)], correctness: ["row 40 missing"] } } });
    const verdict = evaluate(broken, null);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toEqual(["V500: correctness: row 40 missing"]);
  });
  it("requires the baseline to have the same column counts", () => {
    const baseline = doc({ load: { 45: { firstRowMs: [100], editMs: [100], editFailures: [] } } });
    expect(evaluate(doc(), baseline).failures).toEqual([expect.stringContaining("no 500-column")]);
  });
});
