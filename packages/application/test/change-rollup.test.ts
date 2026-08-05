import { describe, expect, it } from "vitest";
import {
  projectEvmDashboard,
  projectWbsGrid,
  type ProjectState,
  type ProjectTask,
} from "../src/index.js";

/**
 * Change-level rollups (ADR 0011 Decision 8, Design 0014).
 *
 * ## The conservation law, and why the obvious version of it is worthless
 *
 * Design 0008 asks for `Σ(group rollups) = project rollup`, and warns that
 * checking only for double-counting lets a DROPPED task through. There is a
 * subtler trap on top of that, and it decides how this file is written:
 *
 * > `projectEvmDashboard`'s own `total` is accumulated in the SAME loop, over the
 * > SAME leaf set, as every bucket. A filter bug that drops a leaf drops it from
 * > both sides equally, so `Σ(rows) === total` stays true while the number is
 * > wrong.
 *
 * So the comparison here is against `projectWbsGrid().rollup`, which the domain's
 * `calculateEffortEvm` computes by an independent path. That catches
 * over-counting (Σ > rollup) and loss (Σ < rollup) at once.
 *
 * The honest limit: both paths share `leafTaskIds`, so a bug in the definition of
 * "leaf" is invisible to this test. The existing dashboard test — adding a
 * summary row turns BAC 2.0 into 4.0 — is what guards that.
 *
 * ## The one control that proves the feature exists
 *
 * With all names distinct, `byChange` is `byParentTask` and a stub that returned
 * the latter would pass everything else here. So a fixture with two same-named
 * roots is mandatory, and its merge is asserted directly.
 */

function makeTask(overrides: Partial<ProjectTask> & Pick<ProjectTask, "id" | "seq">): ProjectTask {
  return {
    parentId: null,
    sortOrder: overrides.seq,
    name: `Task ${overrides.seq}`,
    processId: null,
    productId: null,
    note: "",
    contract: "",
    assigneeMemberId: null,
    plannedEffortMinutes: 0,
    progressBasisPoints: 0,
    actualEffortMinutes: 0,
    prorationWeightBp: null,
    dailyPlan: {},
    datedActuals: {},
    actualStart: null,
    actualFinish: null,
    dependencies: [],
    ...overrides,
  };
}

/** All minutes are multiples of 60, so the person-day conversion is exact in binary. */
function leaf(id: string, seq: number, parentId: string | null, name: string, day: string) {
  return makeTask({
    id,
    seq,
    parentId,
    name,
    plannedEffortMinutes: 480,
    progressBasisPoints: 5_000,
    actualEffortMinutes: 240,
    dailyPlan: { [day]: 480 },
  });
}

/**
 * Deliberately awkward: two roots named "変更A", a root leaf with no children, an
 * ORPHAN whose parent does not exist, and a three-level subtree.
 */
const project: ProjectState = {
  id: "project-1",
  name: "Effort WBS",
  projectStart: "2026-08-01",
  statusDate: "2026-08-31",
  currency: "JPY",
  defaultCalendarId: "standard",
  calendars: [
    { id: "standard", name: "Standard", workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [] },
  ],
  members: [],
  processes: [],
  products: [],
  templates: [],
  tasks: [
    makeTask({ id: "r1", seq: 1, name: "変更A" }),
    leaf("r1a", 2, "r1", "A-1", "2026-08-03"),
    makeTask({ id: "r2", seq: 3, name: "変更A" }), // the same NAME, a different row
    leaf("r2a", 4, "r2", "A-2", "2026-08-04"),
    makeTask({ id: "r3", seq: 5, name: "変更B" }),
    makeTask({ id: "r3m", seq: 6, parentId: "r3", name: "中間" }), // three levels
    leaf("r3ml", 7, "r3m", "B-1", "2026-08-05"),
    leaf("solo", 8, null, "変更C", "2026-08-06"), // a root that is itself a leaf
    leaf("orphan", 9, "missing-parent", "変更D", "2026-08-07"), // parent absent
  ],
  nextTaskSeq: 10,
  nextBaselineVersion: 1,
};

const AS_OF = "2026-08-31";

describe("change-level rollup", () => {
  it("CONTROL: two roots with the SAME name become ONE row", () => {
    // The only behaviour that separates this segment from `byParentTask`. A stub
    // returning `byParentTask` fails here and passes everything else.
    const projection = projectEvmDashboard(project, { statusDate: AS_OF });
    const changeA = projection.byChange.filter((row) => row.label === "変更A");
    expect(changeA).toHaveLength(1);
    expect(projection.byParentTask.filter((row) => row.label === "変更A")).toHaveLength(2);
    expect(projection.byChange.length).toBe(projection.byParentTask.length - 1);
    // And the merged row is the SUM: two leaves of 8 h each = 2 person-days.
    expect(changeA[0]!.bac).toBeCloseTo(2, 10);
  });

  it("CONTROL (conservation): Σ(change rows) equals the INDEPENDENTLY computed rollup", () => {
    // Against `projectWbsGrid().rollup`, not against the projection's own total —
    // the total is accumulated in the same loop and would agree with a bug.
    const projection = projectEvmDashboard(project, { statusDate: project.statusDate });
    const independent = projectWbsGrid(project).rollup;
    for (const key of ["bac", "pv", "ev", "ac"] as const) {
      const summed = projection.byChange.reduce((sum, row) => sum + row[key], 0);
      expect(summed, key).toBeCloseTo(independent[key], 10);
    }
  });

  it("CONTROL (conservation, second status date): PV moves and the law still holds", () => {
    // Only PV depends on the status date, so a second date exercises a different
    // number through the same law — the lesson of Design 0008's order correction.
    const early = { statusDate: "2026-08-04" } as const;
    const projection = projectEvmDashboard(project, early);
    const summed = projection.byChange.reduce((sum, row) => sum + row.pv, 0);
    expect(summed).toBeCloseTo(projection.total.pv, 10);
    // And PV really did move, so this is not the same assertion twice.
    expect(projection.total.pv).not.toBeCloseTo(
      projectEvmDashboard(project, { statusDate: AS_OF }).total.pv,
      10,
    );
  });

  it("puts a root leaf and an ORPHAN in their own change, under their own names", () => {
    const projection = projectEvmDashboard(project, { statusDate: AS_OF });
    const labels = projection.byChange.map((row) => row.label);
    // An orphan is a root by the same rule the grid uses, so it is its own change
    // rather than vanishing into a group that does not exist.
    expect(labels).toContain("変更C");
    expect(labels).toContain("変更D");
  });

  it("orders rows by the FIRST root carrying the name, in WBS order", () => {
    // A merged row has no position of its own, so it takes the earliest one.
    // Design 0007 §2: the WBS projection is the authority on row order, and this
    // segment must not invent a sort of its own.
    expect(projectEvmDashboard(project, { statusDate: AS_OF }).byChange.map((row) => row.label))
      .toEqual(["変更A", "変更B", "変更C", "変更D"]);
  });

  it("CONTROL (one leaf, one row): moving one task's progress moves exactly one change", () => {
    const before = projectEvmDashboard(project, { statusDate: AS_OF });
    const after = projectEvmDashboard(
      {
        ...project,
        tasks: project.tasks.map((task) =>
          task.id === "r3ml" ? { ...task, progressBasisPoints: 10_000 } : task,
        ),
      },
      { statusDate: AS_OF },
    );
    const evByLabel = (projection: typeof before) =>
      Object.fromEntries(projection.byChange.map((row) => [row.label, row.ev]));
    const beforeEv = evByLabel(before);
    const afterEv = evByLabel(after);
    expect(afterEv["変更B"]).not.toBeCloseTo(beforeEv["変更B"]!, 10);
    for (const label of ["変更A", "変更C", "変更D"]) {
      expect(afterEv[label], label).toBeCloseTo(beforeEv[label]!, 10);
    }
  });

  it("compares names EXACTLY — no trim, no case folding, no width folding", () => {
    // Every normalisation is a claim about how a spreadsheet compares text, and
    // this module cannot check any of them. Exact match is the only rule that
    // needs no evidence. The limit is recorded rather than papered over.
    const spaced: ProjectState = {
      ...project,
      tasks: project.tasks.map((task) => (task.id === "r2" ? { ...task, name: "変更A " } : task)),
    };
    const labels = projectEvmDashboard(spaced, { statusDate: AS_OF }).byChange.map(
      (row) => row.label,
    );
    expect(labels).toContain("変更A");
    expect(labels).toContain("変更A ");
  });
});
