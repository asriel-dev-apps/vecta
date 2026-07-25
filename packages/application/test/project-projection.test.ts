import { describe, expect, it } from "vitest";
import {
  projectionRoleForProjectRole,
  projectWbsGrid,
  projectWorkspaceView,
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

const project: ProjectState = {
  id: "project-1",
  name: "Effort WBS",
  projectStart: "2026-01-05",
  statusDate: "2026-01-13",
  currency: "JPY",
  defaultCalendarId: "standard",
  calendars: [
    { id: "standard", name: "Standard", workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [] },
  ],
  members: [
    { id: "member-1", name: "Member 01", calendarId: "standard", dailyCapacityMinutes: 480 },
  ],
  processes: [],
  products: [],
  templates: [],
  tasks: [
    makeTask({ id: "task-1", sortOrder: 0, seq: 1, name: "Phase A" }),
    makeTask({
      id: "task-2",
      parentId: "task-1",
      sortOrder: 1,
      seq: 2,
      name: "Subtask 1.1",
      assigneeMemberId: "member-1",
      plannedEffortMinutes: 480, // L = 8 h
      progressBasisPoints: 5_000, // T = 0.5
      actualEffortMinutes: 300, // W = 5 h
      dailyPlan: { "2026-01-13": 240, "2026-01-14": 240 }, // M = 8 h, N = 4 h
    }),
  ],
  nextTaskSeq: 3,
};

describe("projectWbsGrid", () => {
  it("surfaces each task's immutable display No. on the grid row (§F-1)", () => {
    const rows = projectWbsGrid(project).rows;
    expect(rows.find((row) => row.id === "task-1")!.seq).toBe(1);
    expect(rows.find((row) => row.id === "task-2")!.seq).toBe(2);
  });

  it("returns one row per task with derived columns equal to the §2 formulas", () => {
    const projection = projectWbsGrid(project);
    expect(projection.rows).toHaveLength(2);

    const leaf = projection.rows.find((row) => row.id === "task-2")!;
    expect(leaf).toMatchObject({
      assigneeName: "Member 01",
      plannedEffortDays: 1, // K = 480 / 60 / 8
      plannedEffortHours: 8, // M
      plannedEarnedHours: 4, // N (only the on/before status-date day)
      plannedProgress: 0.5, // O
      plannedStart: "2026-01-13", // P
      plannedFinish: "2026-01-14", // Q
      progress: 0.5, // T
      status: "IN_PROGRESS", // U
      earnedEffortHours: 4, // V = M × T
      actualEffortHours: 5, // W hours
      costVarianceHours: -1, // X = V − W
    });
  });

  it("computes the project rollup in person-days", () => {
    const { rollup } = projectWbsGrid(project);
    // Only the leaf carries effort: BAC = 8/8 = 1; PV = 4/8 = 0.5;
    // EV = 4/8 = 0.5; AC = 5/8 = 0.625.
    expect(rollup).toEqual({
      bac: 1,
      pv: 0.5,
      ev: 0.5,
      ac: 0.625,
      sv: 0,
      cv: 0.5 - 0.625,
      spi: 1, // EV / PV
      cpi: 0.5 / 0.625,
    });
  });

  it("orders rows by sortOrder and never leaks a member-sensitive column to any role", () => {
    const privileged = projectWbsGrid(project, { role: "PRIVILEGED" });
    const general = projectWbsGrid(project, { role: "GENERAL" });
    expect(privileged.rows.map((row) => row.id)).toEqual(["task-1", "task-2"]);
    // The grid surfaces no privileged-only member field, so the general grid is
    // structurally identical to the privileged grid — and neither row carries
    // dailyCapacityMinutes.
    expect(general.rows).toEqual(privileged.rows);
    for (const row of general.rows) {
      expect("dailyCapacityMinutes" in row).toBe(false);
    }
  });

  it("flags a leaf whose L disagrees with Σ daily, and a summary whose L disagrees with Σ children", () => {
    // The fixture leaf (task-2) has L = 480 and Σ daily = 480 (consistent), and
    // its parent (task-1) has L = 0 while its only child carries 480 — so the
    // parent is the estimate-vs-children mismatch and the leaf is clean.
    const consistent = projectWbsGrid(project);
    const parent = consistent.rows.find((row) => row.id === "task-1")!;
    const leaf = consistent.rows.find((row) => row.id === "task-2")!;
    expect(parent.parentEffortMismatch).toBe(true); // 0 ≠ Σ children (480)
    expect(parent.estimateVsDailyMismatch).toBe(false); // summary row: not checked
    expect(leaf.parentEffortMismatch).toBe(false); // leaf: not checked
    expect(leaf.estimateVsDailyMismatch).toBe(false); // L = Σ daily = 480

    // Now break the leaf's estimate-vs-daily agreement (L = 600 ≠ Σ daily 480),
    // and align the parent's L with its child so its mismatch clears.
    const edited: ProjectState = {
      ...project,
      tasks: project.tasks.map((task) =>
        task.id === "task-1"
          ? { ...task, plannedEffortMinutes: 600 }
          : task.id === "task-2"
            ? { ...task, plannedEffortMinutes: 600 }
            : task,
      ),
    };
    const rows = projectWbsGrid(edited).rows;
    expect(rows.find((row) => row.id === "task-1")!.parentEffortMismatch).toBe(false); // 600 = Σ children
    expect(rows.find((row) => row.id === "task-2")!.estimateVsDailyMismatch).toBe(true); // 600 ≠ Σ daily 480
  });
});

describe("projectionRoleForProjectRole", () => {
  it("maps OWNER and EDITOR to PRIVILEGED", () => {
    expect(projectionRoleForProjectRole("OWNER")).toBe("PRIVILEGED");
    expect(projectionRoleForProjectRole("EDITOR")).toBe("PRIVILEGED");
  });

  it("maps VIEWER to GENERAL", () => {
    expect(projectionRoleForProjectRole("VIEWER")).toBe("GENERAL");
  });
});

describe("projectWorkspaceView", () => {
  it("keeps the sensitive member capacity for the PRIVILEGED role", () => {
    const view = projectWorkspaceView(project, "PRIVILEGED");
    const member = view.members[0]!;
    expect("dailyCapacityMinutes" in member).toBe(true);
    expect((member as { dailyCapacityMinutes?: number }).dailyCapacityMinutes).toBe(480);
  });

  it("removes the member capacity key for the GENERAL role (absent, not null)", () => {
    const view = projectWorkspaceView(project, "GENERAL");
    const member = view.members[0]!;
    // Basis 6: the key is absent from the structure, not present-and-null.
    expect("dailyCapacityMinutes" in member).toBe(false);
    expect(Object.keys(member)).toEqual(["id", "name", "calendarId"]);
    // The non-sensitive fields survive.
    expect(member).toMatchObject({ id: "member-1", name: "Member 01", calendarId: "standard" });
  });
});
