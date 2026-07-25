import { describe, expect, it } from "vitest";
import {
  applyEffortSchedule,
  applyProjectCommand,
  deriveSubtaskId,
  projectWbsGrid,
  prorateLargestRemainder,
  type ProjectState,
  type ProjectTask,
  type SubtaskTemplate,
} from "../src/index.js";

// A project-scoped template (Design 0003 §E-1: generation resolves it from
// project state, not a builtin catalog). Weights sum to 10000 so a freshly
// generated parent's children reproduce its planned effort exactly.
const STANDARD_BUILD_TEMPLATE: SubtaskTemplate = {
  id: "standard-build",
  name: "Standard build",
  sortOrder: 0,
  subtasks: [
    { name: "Design", weightBp: 2_000 },
    { name: "Review", weightBp: 1_000, dependsOnPrev: { type: "FS", lagWorkingDays: 1 } },
    { name: "Rework", weightBp: 1_000, dependsOnPrev: { type: "FS", lagWorkingDays: 0 } },
    { name: "Build", weightBp: 4_000, dependsOnPrev: { type: "FS", lagWorkingDays: 0 } },
    { name: "Test", weightBp: 2_000, dependsOnPrev: { type: "FS", lagWorkingDays: 0 } },
  ],
};

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

function baseProject(parentEffortMinutes: number): ProjectState {
  return {
    id: "project-1",
    name: "Effort WBS",
    projectStart: "2026-01-05",
    statusDate: "2026-01-20",
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
    templates: [STANDARD_BUILD_TEMPLATE],
    tasks: [
      makeTask({
        id: "parent-1",
        sortOrder: 0,
        name: "Phase A deliverable",
        assigneeMemberId: "member-1",
        plannedEffortMinutes: parentEffortMinutes,
      }),
    ],
    nextTaskSeq: 2,
  };
}

function childrenOf(state: ProjectState, parentId: string): readonly ProjectTask[] {
  return state.tasks
    .filter((task) => task.parentId === parentId && task.prorationWeightBp !== null)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
}

describe("prorateLargestRemainder", () => {
  it("splits evenly-divisible totals with Σ = total", () => {
    expect(prorateLargestRemainder(1_000, [2_000, 1_000, 1_000, 4_000, 2_000])).toEqual([
      200, 100, 100, 400, 200,
    ]);
  });

  it("assigns leftover units to the largest integer remainder", () => {
    // 1001 × weights/10000 → floors [200,100,100,400,200] (Σ 1000); the single
    // leftover unit goes to the 4000-weight entry (largest remainder).
    const shares = prorateLargestRemainder(1_001, [2_000, 1_000, 1_000, 4_000, 2_000]);
    expect(shares).toEqual([200, 100, 100, 401, 200]);
    expect(shares.reduce((sum, value) => sum + value, 0)).toBe(1_001);
  });

  it("breaks remainder ties by ascending index", () => {
    expect(prorateLargestRemainder(100, [1, 1, 1])).toEqual([34, 33, 33]);
  });

  it("splits evenly when every weight is zero", () => {
    expect(prorateLargestRemainder(10, [0, 0, 0])).toEqual([4, 3, 3]);
  });

  it("is deterministic across repeated calls", () => {
    const weights = [2_000, 1_000, 1_000, 4_000, 2_000];
    expect(prorateLargestRemainder(7_337, weights)).toEqual(
      prorateLargestRemainder(7_337, weights),
    );
  });
});

describe("task.generateSubtasks", () => {
  it("creates weighted children whose planned effort sums to the parent L", () => {
    const next = applyProjectCommand(baseProject(2_400), {
      type: "task.generateSubtasks",
      parentTaskId: "parent-1",
      templateId: "standard-build",
    });

    const children = childrenOf(next, "parent-1");
    expect(children.map((child) => child.name)).toEqual([
      "Design",
      "Review",
      "Rework",
      "Build",
      "Test",
    ]);
    expect(children.map((child) => child.prorationWeightBp)).toEqual([
      2_000, 1_000, 1_000, 4_000, 2_000,
    ]);
    expect(children.map((child) => child.plannedEffortMinutes)).toEqual([480, 240, 240, 960, 480]);
    expect(children.reduce((sum, child) => sum + child.plannedEffortMinutes, 0)).toBe(2_400);
    // Assignee inherited from the parent.
    expect(children.every((child) => child.assigneeMemberId === "member-1")).toBe(true);
  });

  it("chains consecutive subtasks with the template relationship and lag", () => {
    const next = applyProjectCommand(baseProject(2_400), {
      type: "task.generateSubtasks",
      parentTaskId: "parent-1",
      templateId: "standard-build",
    });
    const children = childrenOf(next, "parent-1");

    expect(children[0]!.dependencies).toEqual([]); // Design has no predecessor
    expect(children[1]!.dependencies).toEqual([
      { predecessorId: children[0]!.id, type: "FS", lagWorkingDays: 1 },
    ]);
    for (let index = 2; index < children.length; index += 1) {
      expect(children[index]!.dependencies).toEqual([
        { predecessorId: children[index - 1]!.id, type: "FS", lagWorkingDays: 0 },
      ]);
    }
  });

  it("derives deterministic child ids", () => {
    const command = {
      type: "task.generateSubtasks" as const,
      parentTaskId: "parent-1",
      templateId: "standard-build",
    };
    const first = childrenOf(applyProjectCommand(baseProject(2_400), command), "parent-1");
    const second = childrenOf(applyProjectCommand(baseProject(2_400), command), "parent-1");
    expect(first.map((child) => child.id)).toEqual(second.map((child) => child.id));
    expect(first[0]!.id).toBe(deriveSubtaskId("parent-1", 0));
  });

  it("rejects generation onto an unknown parent or from an unknown template", () => {
    expect(() =>
      applyProjectCommand(baseProject(2_400), {
        type: "task.generateSubtasks",
        parentTaskId: "missing",
        templateId: "standard-build",
      }),
    ).toThrow("Unknown parent task");
    expect(() =>
      applyProjectCommand(baseProject(2_400), {
        type: "task.generateSubtasks",
        parentTaskId: "parent-1",
        templateId: "missing",
      }),
    ).toThrow("Unknown subtask template");
  });
});

describe("re-proration", () => {
  function generated(parentEffort: number): ProjectState {
    return applyProjectCommand(baseProject(parentEffort), {
      type: "task.generateSubtasks",
      parentTaskId: "parent-1",
      templateId: "standard-build",
    });
  }

  it("redistributes children when the parent planned effort changes", () => {
    const next = applyProjectCommand(generated(2_400), {
      type: "task.update",
      taskId: "parent-1",
      changes: { plannedEffortMinutes: 3_600 },
    });
    const children = childrenOf(next, "parent-1");
    expect(children.map((child) => child.plannedEffortMinutes)).toEqual([720, 360, 360, 1_440, 720]);
    expect(children.reduce((sum, child) => sum + child.plannedEffortMinutes, 0)).toBe(3_600);
  });

  it("redistributes siblings when a child weight changes, holding Σ = parent L", () => {
    const state = generated(2_400);
    const design = childrenOf(state, "parent-1")[0]!;
    const next = applyProjectCommand(state, {
      type: "task.update",
      taskId: design.id,
      changes: { prorationWeightBp: 4_000 },
    });
    const children = childrenOf(next, "parent-1");
    expect(children.map((child) => child.prorationWeightBp)).toEqual([
      4_000, 1_000, 1_000, 4_000, 2_000,
    ]);
    // Weights now sum to 12000; parent L (2400) is re-split across them.
    expect(children.map((child) => child.plannedEffortMinutes)).toEqual([800, 200, 200, 800, 400]);
    expect(children.reduce((sum, child) => sum + child.plannedEffortMinutes, 0)).toBe(2_400);
  });
});

describe("projection includes generated parent and children", () => {
  it("returns one row per task with the proration weight surfaced", () => {
    const state = applyProjectCommand(baseProject(2_400), {
      type: "task.generateSubtasks",
      parentTaskId: "parent-1",
      templateId: "standard-build",
    });
    const projection = projectWbsGrid(state);

    expect(projection.rows).toHaveLength(6); // parent + 5 subtasks
    const parentRow = projection.rows.find((row) => row.id === "parent-1")!;
    expect(parentRow.prorationWeightBp).toBeNull();
    const childRows = projection.rows.filter((row) => row.parentId === "parent-1");
    expect(childRows.map((row) => row.prorationWeightBp)).toEqual([
      2_000, 1_000, 1_000, 4_000, 2_000,
    ]);
    expect(childRows.map((row) => row.plannedEffortMinutes)).toEqual([480, 240, 240, 960, 480]);
  });
});

describe("leaf-only rollup holds through subtask generation (no double count)", () => {
  it("keeps BAC equal before and after generating, excluding the now-summary parent", () => {
    // Before generation parent-1 is a leaf worth 2400 min = 5 person-days.
    const before = applyEffortSchedule(baseProject(2_400));
    const bacBefore = projectWbsGrid(before).rollup.bac;
    expect(bacBefore).toBe(2_400 / 60 / 8); // 5 person-days

    // Generate, then place only the new leaf children exactly as the write path
    // does (Design 0003 §C-2): the one-shot scheduler runs for the generated
    // children and leaves every pre-existing plan untouched.
    const generatedState = applyProjectCommand(baseProject(2_400), {
      type: "task.generateSubtasks",
      parentTaskId: "parent-1",
      templateId: "standard-build",
    });
    const newChildIds = new Set(
      generatedState.tasks.filter((task) => task.parentId === "parent-1").map((task) => task.id),
    );
    const generated = applyEffortSchedule(generatedState, newChildIds);
    const grid = projectWbsGrid(generated);

    // The parent is now a non-leaf summary row: its own daily plan is emptied
    // (M = Σ own daily = 0) and it is excluded from the rollup.
    const parentRow = grid.rows.find((row) => row.id === "parent-1")!;
    expect(parentRow.dailyPlan).toEqual({});
    expect(parentRow.plannedEffortHours).toBe(0);

    // The children carry all of the parent's effort (Σ children L = parent L).
    const childRows = grid.rows.filter((row) => row.parentId === "parent-1");
    expect(childRows.reduce((sum, row) => sum + row.plannedEffortMinutes, 0)).toBe(2_400);

    // BAC is unchanged by generation — the parent's 5 pd is not counted twice.
    expect(grid.rollup.bac).toBe(bacBefore);
  });
});
