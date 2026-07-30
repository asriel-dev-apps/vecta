import { describe, expect, it } from "vitest";
import {
  projectEvmDashboard,
  projectWbsGrid,
  UNASSIGNED_ROW_KEY,
  type EvmDashboardRow,
  type ProjectState,
  type ProjectTask,
} from "../src/index.js";

function makeTask(overrides: Partial<ProjectTask> & Pick<ProjectTask, "id">): ProjectTask {
  return {
    parentId: null,
    sortOrder: 0,
    seq: 1,
    name: "Task",
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
    actualStart: null,
    actualFinish: null,
    dependencies: [],
    ...overrides,
  };
}

/**
 * Two first-level parents, deliberately arranged so several things can go wrong
 * visibly:
 *
 * - `P1` is a SUMMARY row carrying its own planned effort and its own daily plan.
 *   Both must be ignored — if the projection ever summed a non-leaf, every number
 *   below would change, which is what makes this fixture a control rather than a
 *   decoration.
 * - The array order is `P2, A, P1, B` while the sort order is `P1, A, B, P2`, so a
 *   projection that returned rows in array order fails the ordering test.
 * - `P2` is a leaf that is ALSO a first-level parent, and it has no assignee, so
 *   it exercises the unassigned bucket at the same time.
 */
const P1_LEAVES_STATUS_DATE = "2026-01-06";

const project: ProjectState = {
  id: "project-1",
  name: "Effort WBS",
  projectStart: "2026-01-05",
  statusDate: P1_LEAVES_STATUS_DATE,
  currency: "JPY",
  defaultCalendarId: "standard",
  calendars: [
    { id: "standard", name: "Standard", workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [] },
  ],
  members: [
    { id: "member-1", name: "Member 01", calendarId: "standard", dailyCapacityMinutes: 480 },
    { id: "member-2", name: "Member 02", calendarId: "standard", dailyCapacityMinutes: 480 },
  ],
  processes: [],
  products: [],
  templates: [],
  tasks: [
    makeTask({
      id: "P2",
      sortOrder: 3,
      seq: 4,
      name: "Phase B",
      // Unassigned leaf that is also a root: 4 h planned, nothing started.
      plannedEffortMinutes: 240,
      dailyPlan: { "2026-01-08": 240 },
    }),
    makeTask({
      id: "A",
      parentId: "P1",
      sortOrder: 1,
      seq: 2,
      name: "A",
      assigneeMemberId: "member-1",
      plannedEffortMinutes: 480, // 8 h
      progressBasisPoints: 5_000, // 50 %
      actualEffortMinutes: 300, // 5 h
      dailyPlan: { "2026-01-05": 240, "2026-01-06": 240 },
    }),
    makeTask({
      id: "P1",
      sortOrder: 0,
      seq: 1,
      name: "Phase A",
      // A summary row's own numbers. Never summed — its children carry the effort.
      plannedEffortMinutes: 960,
      dailyPlan: { "2026-01-05": 960 },
    }),
    makeTask({
      id: "B",
      parentId: "P1",
      sortOrder: 2,
      seq: 3,
      name: "B",
      assigneeMemberId: "member-2",
      plannedEffortMinutes: 480, // 8 h
      progressBasisPoints: 10_000, // done
      actualEffortMinutes: 480, // 8 h
      dailyPlan: { "2026-01-07": 480 },
    }),
  ],
  nextTaskSeq: 5,
};

function rowByKey(rows: readonly EvmDashboardRow[], key: string): EvmDashboardRow {
  const row = rows.find((candidate) => candidate.key === key);
  if (row === undefined) throw new Error(`No dashboard row for ${key}`);
  return row;
}

describe("projectEvmDashboard — rows", () => {
  it("HEADLINE: rows are the first-level parents only, in the WBS order", () => {
    const dashboard = projectEvmDashboard(project);

    // Not the array order (P2 first) and not every node in the tree — exactly the
    // roots, ordered by the projection that owns row order.
    expect(dashboard.byParentTask.map((row) => row.key)).toEqual(["P1", "P2"]);
    expect(dashboard.byParentTask.map((row) => row.label)).toEqual(["Phase A", "Phase B"]);

    // And it is the WBS order because it is literally derived the same way: this
    // is the assertion that fails if the two screens ever start sorting apart.
    const wbsRoots = projectWbsGrid(project)
      .rows.filter((row) => row.parentId === null)
      .map((row) => row.id);
    expect(dashboard.byParentTask.map((row) => row.key)).toEqual(wbsRoots);
  });

  it("HEADLINE: a summary row's own effort is never counted", () => {
    const dashboard = projectEvmDashboard(project);
    const phaseA = rowByKey(dashboard.byParentTask, "P1");

    // P1 declares 960 planned minutes and a 960-minute day of its own. Its two
    // leaves declare 480 each. A projection that summed the parent as well would
    // report BAC 4.0 here (and 6.0 for the project) instead of 2.0.
    expect(phaseA.bac).toBe(2);
    expect(dashboard.total.bac).toBe(2.5);
  });

  it("computes the ten columns from the leaves, in person-days", () => {
    const dashboard = projectEvmDashboard(project);
    const phaseA = rowByKey(dashboard.byParentTask, "P1");

    // A: M 8 h, N 8 h (both plan days ≤ the status date), V 4 h, W 5 h.
    // B: M 8 h, N 0 h (planned on the 7th), V 8 h, W 8 h.
    expect(phaseA.pv).toBe(1); //   (8 + 0) / 8
    expect(phaseA.ev).toBe(1.5); // (4 + 8) / 8
    expect(phaseA.ac).toBe(1.625); // (5 + 8) / 8
    expect(phaseA.sv).toBe(0.5); // EV − PV
    expect(phaseA.cv).toBe(-0.125); // EV − AC
    expect(phaseA.spi).toBe(1.5); // EV / PV
    expect(phaseA.cpi).toBeCloseTo(0.923_076_9, 6); // EV / AC
    expect(phaseA.eac as number).toBeCloseTo(2.166_666_7, 6); // BAC / CPI
    expect(phaseA.etc as number).toBeCloseTo(0.541_666_7, 6); // EAC − AC
  });

  it("reports '-' rather than a number for a row that has not started", () => {
    const dashboard = projectEvmDashboard(project);
    const phaseB = rowByKey(dashboard.byParentTask, "P2");

    expect(phaseB.bac).toBe(0.5);
    expect(phaseB.pv).toBe(0); // planned on the 8th, as of the 6th
    expect(phaseB.ev).toBe(0);
    expect(phaseB.ac).toBe(0);
    expect(phaseB.spi).toBe("-"); // PV = 0
    expect(phaseB.cpi).toBe("-"); // AC = 0
    expect(phaseB.eac).toBe("-");
    expect(phaseB.etc).toBe("-");
  });
});

describe("projectEvmDashboard — the two segments agree", () => {
  it("HEADLINE: per-task and per-member sum to the same project total", () => {
    // The reason the unassigned row exists at all. Two segments of ONE table
    // showing different totals is the defect this test is here to prevent, and it
    // is only prevented as long as every leaf lands in exactly one bucket of each.
    const dashboard = projectEvmDashboard(project);

    const sum = (rows: readonly EvmDashboardRow[], field: "bac" | "pv" | "ev" | "ac"): number =>
      rows.reduce((total, row) => total + row[field], 0);

    for (const field of ["bac", "pv", "ev", "ac"] as const) {
      expect(sum(dashboard.byParentTask, field)).toBeCloseTo(dashboard.total[field], 10);
      expect(sum(dashboard.byMember, field)).toBeCloseTo(dashboard.total[field], 10);
    }
  });

  it("groups leaves by assignee, in the members' display order, with unassigned last", () => {
    const dashboard = projectEvmDashboard(project);

    expect(dashboard.byMember.map((row) => row.key)).toEqual([
      "member-1",
      "member-2",
      UNASSIGNED_ROW_KEY,
    ]);
    expect(dashboard.byMember.map((row) => row.kind)).toEqual([
      "member",
      "member",
      "unassigned",
    ]);

    expect(rowByKey(dashboard.byMember, "member-1").bac).toBe(1); // task A
    expect(rowByKey(dashboard.byMember, "member-2").bac).toBe(1); // task B
    expect(rowByKey(dashboard.byMember, UNASSIGNED_ROW_KEY).bac).toBe(0.5); // P2
  });

  it("omits the unassigned row when every leaf has an assignee", () => {
    const assigned: ProjectState = {
      ...project,
      tasks: project.tasks.map((task) =>
        task.id === "P2" ? { ...task, assigneeMemberId: "member-1" } : task,
      ),
    };

    const dashboard = projectEvmDashboard(assigned);

    expect(dashboard.byMember.map((row) => row.key)).toEqual(["member-1", "member-2"]);
  });

  it("keeps a member with nothing assigned as a zero row", () => {
    // Their absence would read as "who is that member again?"; a row of zeros
    // reads as "they hold nothing", which is the fact.
    const idle: ProjectState = {
      ...project,
      tasks: project.tasks.map((task) =>
        task.assigneeMemberId === "member-2" ? { ...task, assigneeMemberId: "member-1" } : task,
      ),
    };

    const dashboard = projectEvmDashboard(idle);
    const idleMember = rowByKey(dashboard.byMember, "member-2");

    expect(idleMember.bac).toBe(0);
    expect(idleMember.cpi).toBe("-");
    expect(idleMember.curve).toEqual([]);
  });

  it("folds an assignee the member list does not contain into the unassigned row", () => {
    // Validation forbids it, but stale data would otherwise make the leaf vanish
    // from the per-member segment and break the totals agreement above.
    const dangling: ProjectState = {
      ...project,
      tasks: project.tasks.map((task) =>
        task.id === "A" ? { ...task, assigneeMemberId: "member-gone" } : task,
      ),
    };

    const dashboard = projectEvmDashboard(dangling);

    expect(rowByKey(dashboard.byMember, "member-1").bac).toBe(0);
    expect(rowByKey(dashboard.byMember, UNASSIGNED_ROW_KEY).bac).toBe(1.5); // A + P2
    expect(
      dashboard.byMember.reduce((total, row) => total + row.bac, 0),
    ).toBeCloseTo(dashboard.total.bac, 10);
  });
});

describe("projectEvmDashboard — the as-of date", () => {
  it("HEADLINE: moves PV, and leaves EV and AC where they are", () => {
    // Not a historical snapshot, and the screen says so: the model stores one
    // current progress figure per task, so only the planned side can be re-read
    // at an earlier date.
    const early = projectEvmDashboard(project, { statusDate: "2026-01-05" });
    const late = projectEvmDashboard(project, { statusDate: "2026-01-08" });

    expect(early.total.pv).toBe(0.5); // only A's first planned day
    expect(late.total.pv).toBe(2.5); // the whole plan is now behind us

    expect(early.total.ev).toBe(late.total.ev);
    expect(early.total.ac).toBe(late.total.ac);
    expect(early.total.bac).toBe(late.total.bac);

    // …and the derived schedule figures follow PV, while the cost ones do not.
    expect(early.total.sv).not.toBe(late.total.sv);
    expect(early.total.cv).toBe(late.total.cv);
    expect(early.total.cpi).toBe(late.total.cpi);
  });

  it("defaults to the project's own stored status date", () => {
    expect(projectEvmDashboard(project).statusDate).toBe(P1_LEAVES_STATUS_DATE);
    expect(projectEvmDashboard(project).total.pv).toBe(
      projectEvmDashboard(project, { statusDate: P1_LEAVES_STATUS_DATE }).total.pv,
    );
  });
});

describe("projectEvmDashboard — the S-curve", () => {
  it("accumulates planned value over the leaves' plan days only", () => {
    const dashboard = projectEvmDashboard(project);

    // P1's own 960-minute day on the 5th is a summary row's plan and contributes
    // nothing: the 5th carries A's 240 minutes (0.5 person-days) and no more.
    expect(dashboard.total.curve).toEqual([
      { date: "2026-01-05", pv: 0.5 },
      { date: "2026-01-06", pv: 1 },
      { date: "2026-01-07", pv: 2 },
      { date: "2026-01-08", pv: 2.5 },
    ]);
    // The curve ends at the row's BAC — that is what makes it an S-curve and not
    // an arbitrary line.
    expect(dashboard.total.curve.at(-1)?.pv).toBe(dashboard.total.bac);
  });

  it("shares one date axis across every row", () => {
    const dashboard = projectEvmDashboard(project);

    expect(dashboard.planStart).toBe("2026-01-05");
    expect(dashboard.planEnd).toBe("2026-01-08");
    // Each row still carries only its own dates; the axis is what is shared.
    expect(rowByKey(dashboard.byParentTask, "P2").curve).toEqual([
      { date: "2026-01-08", pv: 0.5 },
    ]);
  });

  it("ignores zero-valued plan entries so they cannot widen the axis", () => {
    const padded: ProjectState = {
      ...project,
      tasks: project.tasks.map((task) =>
        task.id === "A"
          ? { ...task, dailyPlan: { ...task.dailyPlan, "2025-12-01": 0, "2026-03-01": 0 } }
          : task,
      ),
    };

    const dashboard = projectEvmDashboard(padded);

    expect(dashboard.planStart).toBe("2026-01-05");
    expect(dashboard.planEnd).toBe("2026-01-08");
    expect(dashboard.byParentTask[0]?.curve.map((point) => point.date)).toEqual([
      "2026-01-05",
      "2026-01-06",
      "2026-01-07",
    ]);
  });

  it("has no curve and no axis for a project that plans nothing", () => {
    const unplanned: ProjectState = {
      ...project,
      tasks: project.tasks.map((task) => ({ ...task, dailyPlan: {} })),
    };

    const dashboard = projectEvmDashboard(unplanned);

    expect(dashboard.planStart).toBeNull();
    expect(dashboard.planEnd).toBeNull();
    expect(dashboard.total.curve).toEqual([]);
  });
});

describe("projectEvmDashboard — role scoping", () => {
  it("reaches the member list only through the role-scoped read model", () => {
    // The choke point (ADR 0011 D18): a GENERAL viewer sees the same rows and the
    // same numbers — the projection out is per-member CAPACITY, which no EVM
    // column uses — so narrowing the role must not silently drop a member row.
    const privileged = projectEvmDashboard(project, { role: "PRIVILEGED" });
    const general = projectEvmDashboard(project, { role: "GENERAL" });

    expect(general.byMember).toEqual(privileged.byMember);
    expect(general.total).toEqual(privileged.total);
  });
});

describe("projectEvmDashboard — malformed trees", () => {
  it("treats a child whose parent is missing as a root, exactly as the grid does", () => {
    // Validation forbids this, but the grid's `buildTree` promotes such a child to
    // a root; if this module disagreed, effort would appear on one screen and
    // vanish from the other.
    const orphaned: ProjectState = {
      ...project,
      tasks: project.tasks.map((task) =>
        task.id === "A" ? { ...task, parentId: "gone" } : task,
      ),
    };

    const dashboard = projectEvmDashboard(orphaned);

    // A joins the roots, between P1 (sortOrder 0) and P2 (3), by its own order.
    expect(dashboard.byParentTask.map((row) => row.key)).toEqual(["P1", "A", "P2"]);
    expect(rowByKey(dashboard.byParentTask, "P1").bac).toBe(1); // B alone now
    expect(rowByKey(dashboard.byParentTask, "A").bac).toBe(1);
    expect(dashboard.total.bac).toBe(2.5); // nothing lost: A + B + P2
  });

  it("terminates on a parent cycle instead of walking it forever", () => {
    const cyclic: ProjectState = {
      ...project,
      tasks: project.tasks.map((task) =>
        task.id === "P1" ? { ...task, parentId: "A" } : task,
      ),
    };

    // The assertion that matters is that this returns at all.
    expect(() => projectEvmDashboard(cyclic)).not.toThrow();
  });
});
