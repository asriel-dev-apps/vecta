import { describe, expect, it } from "vitest";

/**
 * The gate on `baseline.publish` (Design 0009 §3.1).
 *
 * BAC comes from the daily plot, not the estimate (measured 2026-08-05), so a leaf
 * with an estimate and no plot is frozen at ZERO budget and every later SV is
 * kinder by that amount, permanently and with nothing on screen to say so.
 *
 * The predicate is only "the plot disagrees with the estimate". A first version
 * also flagged every plot summing to zero, which a Codex review found to be a
 * false positive on valid input — a leaf estimated at 0 minutes hides nothing,
 * and daily-plan validation permits zero-valued days. A prompt that cries wolf is
 * how the real case gets waved through.
 */
import { unplottedLeafTasks, type ProjectState } from "../src/project-state.js";
const base = (tasks: { id: string; parentId: string | null; plannedEffortMinutes: number; dailyPlan: Record<string, number> }[]) =>
  ({ tasks: tasks.map((t) => ({ ...t, sortOrder: 0, seq: 1, name: t.id, processId: null, productId: null,
      note: "", contract: "", assigneeMemberId: null, progressBasisPoints: 0, actualEffortMinutes: 0,
      prorationWeightBp: null, actualStart: null, actualFinish: null, dependencies: [] })) } as unknown as ProjectState);
describe("unplottedLeafTasks", () => {
  it("flags a real hole: an estimate with no plot", () => {
    expect(unplottedLeafTasks(base([{ id: "a", parentId: null, plannedEffortMinutes: 480, dailyPlan: {} }])).map(t => t.id)).toEqual(["a"]);
  });
  it("does NOT flag a zero-effort leaf, plotted or not (Codex review 2026-08-05)", () => {
    expect(unplottedLeafTasks(base([{ id: "z1", parentId: null, plannedEffortMinutes: 0, dailyPlan: {} }]))).toEqual([]);
    expect(unplottedLeafTasks(base([{ id: "z2", parentId: null, plannedEffortMinutes: 0, dailyPlan: { "2026-08-05": 0 } }]))).toEqual([]);
  });
  it("flags a plot that disagrees with the estimate", () => {
    expect(unplottedLeafTasks(base([{ id: "d", parentId: null, plannedEffortMinutes: 480, dailyPlan: { "2026-08-05": 240 } }])).map(t => t.id)).toEqual(["d"]);
  });
  it("ignores summary rows, which do not roll up", () => {
    expect(unplottedLeafTasks(base([
      { id: "p", parentId: null, plannedEffortMinutes: 999, dailyPlan: {} },
      { id: "c", parentId: "p", plannedEffortMinutes: 480, dailyPlan: { "2026-08-05": 480 } },
    ]))).toEqual([]);
  });
});
