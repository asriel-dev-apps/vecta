import { describe, expect, it } from "vitest";
import { evaluate, median, percentile95, withinTolerance, workGate, workStats, type PerfDoc, type WorkSample } from "../perf/gate.mjs";

const run = (p95: number, max: number): WorkSample => ({ p95, max });
// A wheel run that did what the lane says: 60 steps, 60 wheel events, offsets moved by (dy, dx) from (60000, 1728).
const wheel = (dy: number, dx: number, p95 = 8, max = 20): WorkSample => ({
  p95,
  max,
  steps: 60,
  wheelEvents: 60,
  start: { top: 60_000, left: 1728 },
  end: { top: 60_000 + dy, left: 1728 + dx },
});
const lanes = {
  W45: () => wheel(6000, 0),
  W500: () => wheel(6000, 0),
  WH500: () => wheel(0, 6000),
  WF500: () => wheel(18_000, 0),
  V45c: () => run(8, 20),
  V45: () => run(8, 20),
  H45: () => run(8, 20),
  V500: () => run(8, 20),
  H500: () => run(8, 20),
  D500: () => run(8, 20),
} as const;
const load = (first: number, edit: number) => ({ firstRowMs: [first, first, first], editMs: [edit, edit, edit], editFailures: [] });
const full = (): PerfDoc => ({
  runs: 3,
  builds: { before: "aaa", candidate: "bbb" },
  order: ["B", "C", "B", "C", "B", "C", "B", "C", "B", "C", "B", "C"],
  scenarios: Object.fromEntries(
    Object.entries(lanes).map(([id, make]) => [id, { work: [make()], control: [{ ...make(), p95: 0.4, max: 1 }], correctness: [] }]),
  ),
  load: { 45: load(100, 100), 500: load(100, 100) },
  before: { load: { 45: load(100, 100), 500: load(100, 100) } },
});
const withLane = (id: string, patch: { work?: WorkSample[]; control?: WorkSample[]; correctness?: string[] }): PerfDoc => {
  const doc = full();
  doc.scenarios[id] = { ...doc.scenarios[id]!, ...patch };
  return doc;
};

describe("a complete, valid document", () => {
  it("passes", () => {
    expect(evaluate(full())).toEqual({ ok: true, diagnostic: false, failures: [] });
  });
  it("an empty document fails, it does not pass for lack of evidence", () => {
    const result = evaluate({ scenarios: {}, load: {} } as PerfDoc);
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("W500: lane missing");
    expect(result.failures).toContain("D500: lane missing");
    expect(result.failures).toContain("load@45: missing");
    expect(result.failures).toContain("no before measurement");
  });
  it("a document without one lane, one load width or the before side fails", () => {
    const noLane = full();
    delete noLane.scenarios.WF500;
    expect(evaluate(noLane).failures).toEqual(["WF500: lane missing"]);
    const noLoad = full();
    delete noLoad.load![45];
    expect(evaluate(noLoad).failures).toEqual(["load@45: missing", "firstRowMs@45: NaN > max(100 x 1.10, 100 + 20)", "editMs@45: NaN > max(100 x 1.10, 100 + 20)"]);
    const noBefore = full();
    delete noBefore.before;
    expect(evaluate(noBefore).failures).toEqual(["no before measurement"]);
  });
  it("a partial run is a diagnostic: it never reports a pass of the requirement", () => {
    const partial = { ...full(), scenarios: { W500: full().scenarios.W500! } };
    delete partial.before;
    delete (partial as Partial<PerfDoc>).load;
    expect(evaluate(partial as PerfDoc, { diagnostic: true })).toEqual({ ok: true, diagnostic: true, failures: [] });
    expect(evaluate(partial as PerfDoc).ok).toBe(false);
  });
});

describe("work-time gate", () => {
  it("primary lanes: p95 <= 16 ms, max < 50 ms", () => {
    for (const id of ["W45", "W500", "WH500", "WF500"] as const) {
      expect(evaluate(withLane(id, { work: [{ ...lanes[id](), p95: 16, max: 49.9 }] })).failures).toEqual([]);
      expect(evaluate(withLane(id, { work: [{ ...lanes[id](), p95: 16.1, max: 10 }] })).failures).toEqual([`${id}: work p95 16.1 ms > 16 ms`]);
      expect(evaluate(withLane(id, { work: [{ ...lanes[id](), p95: 5, max: 50 }] })).failures).toEqual([`${id}: work max 50.0 ms >= 50 ms`]);
    }
  });
  it("secondary lanes: p95 <= 33 ms, max < 100 ms, and the document cannot loosen a primary lane", () => {
    expect(evaluate(withLane("V500", { work: [run(33, 99.9)] })).failures).toEqual([]);
    expect(evaluate(withLane("V500", { work: [run(33.1, 10)] })).failures).toEqual(["V500: work p95 33.1 ms > 33 ms"]);
    expect(evaluate(withLane("V500", { work: [run(5, 100)] })).failures).toEqual(["V500: work max 100.0 ms >= 100 ms"]);
    expect(evaluate(withLane("V500", { work: [run(20, 60)] })).ok).toBe(true);
    expect(evaluate(withLane("W500", { work: [{ ...lanes.W500(), p95: 20, max: 60 }] })).failures).toHaveLength(2);
    const labelled = withLane("W500", { work: [{ ...lanes.W500(), p95: 20, max: 60 }] });
    (labelled.scenarios.W500 as Record<string, unknown>).tier = "secondary";
    expect(evaluate(labelled).failures).toHaveLength(2);
  });
  it("an unknown lane id is a failure, not a pass", () => {
    const doc = full();
    doc.scenarios.X999 = { work: [run(1, 1)], control: [run(1, 1)], correctness: [] };
    expect(evaluate(doc).failures).toEqual(["X999: unknown lane"]);
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

describe("control lane", () => {
  it("a control over the gate invalidates the measurement, per tier", () => {
    expect(evaluate(withLane("W500", { control: [wheel(6000, 0, 17, 20)] })).failures).toEqual([expect.stringContaining("W500: CONTROL lane")]);
    expect(evaluate(withLane("W500", { control: [wheel(6000, 0, 8, 50)] })).failures).toEqual([expect.stringContaining("W500: CONTROL lane")]);
    expect(evaluate(withLane("V500", { control: [run(34, 20)] })).failures).toEqual([expect.stringContaining("V500: CONTROL lane")]);
  });
  it("a missing or empty control fails, it is not skipped", () => {
    expect(evaluate(withLane("W500", { control: [] })).failures).toEqual(["W500: CONTROL lane (empty scroller) no runs: the measurement is invalid"]);
    const noControl = full();
    delete (noControl.scenarios.V500 as Partial<PerfDoc["scenarios"][string]>).control;
    expect(evaluate(noControl).ok).toBe(false);
    expect(evaluate(withLane("W500", { work: [] })).ok).toBe(false);
  });
});

describe("movement evidence of the wheel lanes", () => {
  it("W500 must scroll 60 x 100 px: 1 px of rounding passes, 2 px fails", () => {
    expect(evaluate(withLane("W500", { work: [wheel(5999, 0)] })).failures).toEqual([]);
    expect(evaluate(withLane("W500", { work: [wheel(5998, 0)] })).failures).toEqual(["W500: correctness: scrolled 5998 px vertically, expected 6000"]);
    expect(evaluate(withLane("W500", { work: [wheel(6001, 0)] })).ok).toBe(true);
  });
  it("a lane that did not move at all fails even though its work time is zero", () => {
    expect(evaluate(withLane("W500", { work: [wheel(0, 0, 0, 0)], control: [wheel(0, 0, 0, 0)] })).ok).toBe(false);
  });
  it("WH500 must move horizontally and not vertically; WF500 moves 18000", () => {
    expect(evaluate(withLane("WH500", { work: [wheel(0, 0)] })).failures).toEqual(["WH500: correctness: scrolled 0 px horizontally, expected 6000"]);
    expect(evaluate(withLane("WH500", { work: [wheel(40, 6000)] })).failures).toEqual(["WH500: correctness: scrolled 40 px vertically, expected 0"]);
    expect(evaluate(withLane("WF500", { work: [wheel(6000, 0)] })).failures).toEqual(["WF500: correctness: scrolled 6000 px vertically, expected 18000"]);
  });
  it("the same movement is required of the control run, and missing evidence fails", () => {
    expect(evaluate(withLane("W500", { control: [wheel(0, 0, 0.4, 1)] })).failures).toEqual([
      "W500: CONTROL lane: scrolled 0 px vertically, expected 6000: the measurement is invalid",
    ]);
    expect(evaluate(withLane("W500", { work: [run(8, 20)] })).failures).toEqual(["W500: correctness: no movement evidence (start/end offsets, wheel events)"]);
  });
  it("60 wheel events and 60 steps are required (a control driven by direct scrolling sends none)", () => {
    expect(evaluate(withLane("W500", { control: [{ ...wheel(6000, 0, 0.4, 1), wheelEvents: 0 }] })).failures).toEqual([
      "W500: CONTROL lane: received 0 wheel events, expected 60: the measurement is invalid",
    ]);
    expect(evaluate(withLane("W500", { work: [{ ...wheel(6000, 0), steps: 59 }] })).failures).toEqual(["W500: correctness: measured 59 steps, expected 60"]);
  });
  it("a destination that is not drawn fails even when work time is zero", () => {
    const broken = withLane("W500", { work: [wheel(6000, 0, 0, 0)], control: [wheel(6000, 0, 0, 0)], correctness: ["notch 3 row 2002 is not in the DOM"] });
    expect(evaluate(broken).failures).toEqual(["W500: correctness: notch 3 row 2002 is not in the DOM"]);
    const noEvidence = full();
    delete (noEvidence.scenarios.W500 as Partial<PerfDoc["scenarios"][string]>).correctness;
    expect(evaluate(noEvidence).ok).toBe(false);
  });
});

describe("tolerance: head <= max(baseline x 1.10, baseline + 20 ms), on medians, before measured in the same session", () => {
  it("uses the percentage for large baselines and the absolute margin for small ones", () => {
    expect(withinTolerance(1000, 1100)).toBe(true);
    expect(withinTolerance(1000, 1100.5)).toBe(false);
    expect(withinTolerance(106, 126)).toBe(true);
    expect(withinTolerance(106, 126.5)).toBe(false);
  });
  it("first display and edit, at both widths", () => {
    for (const cols of [45, 500] as const) {
      const inside = full();
      inside.load![cols] = load(120, 120);
      expect(evaluate(inside).failures).toEqual([]);
      const outside = full();
      outside.load![cols] = load(121, 100);
      expect(evaluate(outside).failures).toEqual([expect.stringContaining(`firstRowMs@${cols}`)]);
      const edit = full();
      edit.load![cols] = load(100, 121);
      expect(evaluate(edit).failures).toEqual([expect.stringContaining(`editMs@${cols}`)]);
    }
  });
  it("is judged on the median: one outlier in the before samples does not move the baseline", () => {
    const doc = full();
    doc.before!.load![500] = { firstRowMs: [100, 100, 100, 100, 900], editMs: [100, 100, 100, 100, 900], editFailures: [] };
    doc.runs = 5;
    const five = { firstRowMs: [100, 100, 100, 100, 100], editMs: [100, 100, 100, 100, 100], editFailures: [] };
    doc.load![45] = five;
    doc.before!.load![45] = five;
    doc.load![500] = { firstRowMs: [130, 130, 130, 130, 130], editMs: [100, 100, 100, 100, 100], editFailures: [] };
    expect(evaluate(doc).failures).toEqual([expect.stringContaining("firstRowMs@500")]);
    doc.load![500] = { firstRowMs: [100, 100, 100, 100, 900], editMs: [100, 100, 100, 100, 100], editFailures: [] };
    expect(evaluate(doc).failures).toEqual([]);
  });
  it("a before probe that failed or has no number invalidates the baseline", () => {
    const failed = full();
    failed.before!.load![45]!.editFailures = ["BAC after: \"1\" expected \"2\""];
    expect(evaluate(failed).failures).toEqual(["before edit@45: BAC after: \"1\" expected \"2\""]);
    const nan = full();
    nan.before!.load![500]!.firstRowMs = [Number.NaN, Number.NaN, Number.NaN];
    expect(evaluate(nan).ok).toBe(false);
    const roundTrip = JSON.parse(JSON.stringify(nan)) as PerfDoc;
    expect(roundTrip.before!.load![500]!.firstRowMs).toEqual([null, null, null]);
    expect(evaluate(roundTrip).ok).toBe(false);
  });
});

describe("one session, two different builds, interleaved", () => {
  it("the same build on both sides, or no identity, is not a comparison", () => {
    const same = full();
    same.builds = { before: "aaa", candidate: "aaa" };
    expect(evaluate(same).failures).toEqual([expect.stringContaining("same build")]);
    const none = full();
    delete none.builds;
    expect(evaluate(none).failures).toEqual([expect.stringContaining("same build")]);
  });
  it("probes must alternate B,C,B,C and each side must have `runs` samples", () => {
    const blocks = full();
    blocks.order = ["B", "B", "B", "B", "B", "B", "C", "C", "C", "C", "C", "C"];
    expect(evaluate(blocks).failures).toEqual([expect.stringContaining("not interleaved")]);
    const few = full();
    few.runs = 4;
    expect(evaluate(few).failures).toContain("firstRowMs@45: 3 samples, expected 4");
  });
});
