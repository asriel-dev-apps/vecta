import { describe, expect, it } from "vitest";
import {
  applyProjectCommand,
  leafTaskIds,
  projectWbsGrid,
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
      plannedEffortMinutes: 480,
      progressBasisPoints: 4_000,
      actualEffortMinutes: 300,
      dailyPlan: { "2026-01-05": 480 },
      actualStart: "2026-01-05",
    }),
  ],
  nextTaskSeq: 3,
};

describe("applyProjectCommand", () => {
  it("updates one task without mutating the current project state", () => {
    const next = applyProjectCommand(project, {
      type: "task.update",
      taskId: "task-2",
      changes: { progressBasisPoints: 5_500, actualEffortMinutes: 3_660 },
    });

    expect(next.tasks[1]).toMatchObject({
      progressBasisPoints: 5_500,
      actualEffortMinutes: 3_660,
    });
    expect(project.tasks[1]).toMatchObject({
      progressBasisPoints: 4_000,
      actualEffortMinutes: 300,
    });
  });

  it("adds a task, assigning the display No. from the project counter (§F-1)", () => {
    const added = makeTask({
      id: "task-3",
      parentId: "task-1",
      sortOrder: 2,
      name: "Subtask 1.2",
      assigneeMemberId: "member-1",
      plannedEffortMinutes: 960,
      dailyPlan: { "2026-01-06": 480, "2026-01-07": 480 },
      dependencies: [{ predecessorId: "task-2", type: "FS", lagWorkingDays: 0 }],
    });
    const next = applyProjectCommand(project, { type: "task.add", task: added });
    // The new task takes the project's nextTaskSeq (3) as its immutable seq, and
    // the counter advances to 4 — regardless of any seq on the input task.
    expect(next.tasks).toEqual([...project.tasks, { ...added, seq: 3 }]);
    expect(next.nextTaskSeq).toBe(4);
    expect(project.tasks).toHaveLength(2);
    expect(project.nextTaskSeq).toBe(3);
  });

  it("keeps display numbers immutable across reorder and delete, with gaps (§F-1)", () => {
    // Add a third task (seq 3), then reorder and delete; existing seqs must never
    // change, and the deleted number is not reused (a gap persists).
    const withThird = applyProjectCommand(project, {
      type: "task.add",
      task: makeTask({ id: "task-3", sortOrder: 2, name: "Phase B" }),
    });
    expect(withThird.tasks.map((task) => task.seq)).toEqual([1, 2, 3]);

    // Move task-3 to a new sort position (a reorder rewrites sortOrder) — the
    // display seqs are untouched.
    const reordered = applyProjectCommand(withThird, {
      type: "task.update",
      taskId: "task-3",
      changes: { sortOrder: 5 },
    });
    const reorderedSeqById = new Map(reordered.tasks.map((task) => [task.id, task.seq]));
    expect(reorderedSeqById.get("task-1")).toBe(1);
    expect(reorderedSeqById.get("task-2")).toBe(2);
    expect(reorderedSeqById.get("task-3")).toBe(3);
    expect(reordered.nextTaskSeq).toBe(4);

    // Delete task-2; task-1 and task-3 keep seq 1 and 3 (a gap at 2), and the next
    // add continues at 4 — the counter never rewinds.
    const deleted = applyProjectCommand(reordered, { type: "task.delete", taskId: "task-2" });
    expect(deleted.tasks.map((task) => task.seq).sort((a, b) => a - b)).toEqual([1, 3]);
    expect(deleted.nextTaskSeq).toBe(4);
    const afterDeleteAdd = applyProjectCommand(deleted, {
      type: "task.add",
      task: makeTask({ id: "task-4", sortOrder: 3, name: "Phase C" }),
    });
    expect(afterDeleteAdd.tasks.find((task) => task.id === "task-4")?.seq).toBe(4);
    expect(afterDeleteAdd.nextTaskSeq).toBe(5);
  });

  it("draws subtask numbers from the same per-project counter as tasks (§F-1)", () => {
    // A fresh single-parent project with a template, so generateSubtasks creates
    // children that must consume consecutive numbers after the parent's.
    const seedProject: ProjectState = {
      ...project,
      templates: [
        {
          id: "template-1",
          name: "Two steps",
          sortOrder: 0,
          subtasks: [
            { name: "Design", weightBp: 6_000 },
            { name: "Review", weightBp: 4_000, dependsOnPrev: { type: "FS", lagWorkingDays: 1 } },
          ],
        },
      ],
      tasks: [makeTask({ id: "parent-1", sortOrder: 0, seq: 1, name: "Parent" })],
      nextTaskSeq: 2,
    };
    const generated = applyProjectCommand(seedProject, {
      type: "task.generateSubtasks",
      parentTaskId: "parent-1",
      templateId: "template-1",
    });
    const children = generated.tasks.filter((task) => task.parentId === "parent-1");
    expect(children.map((task) => task.seq).sort((a, b) => a - b)).toEqual([2, 3]);
    // Two children consumed two numbers off the shared counter.
    expect(generated.nextTaskSeq).toBe(4);
  });

  it("deletes a task and re-parents its children to null", () => {
    const next = applyProjectCommand(project, { type: "task.delete", taskId: "task-1" });
    expect(next.tasks.map((task) => task.id)).toEqual(["task-2"]);
    expect(next.tasks[0]?.parentId).toBeNull();
  });

  it("rejects progress outside 0..10000 basis points", () => {
    expect(() =>
      applyProjectCommand(project, {
        type: "task.update",
        taskId: "task-2",
        changes: { progressBasisPoints: 10_500 },
      }),
    ).toThrow("progress must be whole basis points");
  });

  it("rejects non-whole planned effort minutes", () => {
    expect(() =>
      applyProjectCommand(project, {
        type: "task.update",
        taskId: "task-2",
        changes: { plannedEffortMinutes: 480.5 },
      }),
    ).toThrow("planned effort must be whole minutes");
  });

  it("rejects negative daily plan values", () => {
    expect(() =>
      applyProjectCommand(project, {
        type: "task.update",
        taskId: "task-2",
        changes: { dailyPlan: { "2026-01-05": -60 } },
      }),
    ).toThrow("daily plan values must be finite and >= 0");
  });

  it("rejects an actual finish that precedes the actual start (R <= S)", () => {
    expect(() =>
      applyProjectCommand(project, {
        type: "task.update",
        taskId: "task-2",
        changes: { actualStart: "2026-01-10", actualFinish: "2026-01-05" },
      }),
    ).toThrow("actual finish must not precede");
  });

  it("rejects a parent cycle in the task hierarchy", () => {
    expect(() =>
      applyProjectCommand(project, {
        type: "task.update",
        taskId: "task-1",
        changes: { parentId: "task-2" },
      }),
    ).toThrow("cycle");
  });

  it("rejects a task that is its own parent", () => {
    expect(() =>
      applyProjectCommand(project, {
        type: "task.update",
        taskId: "task-2",
        changes: { parentId: "task-2" },
      }),
    ).toThrow("cannot be its own parent");
  });

  it("rejects re-parenting a task under one of its own (transitive) descendants", () => {
    // A → B → C. Re-parenting A beneath its grandchild C would close the loop
    // A→C→B→A; the acyclic check must fire on the re-parent path across depth.
    const chain: ProjectState = {
      ...project,
      tasks: [
        makeTask({ id: "A", sortOrder: 0, name: "A" }),
        makeTask({ id: "B", parentId: "A", sortOrder: 1, name: "B" }),
        makeTask({ id: "C", parentId: "B", sortOrder: 2, name: "C" }),
      ],
    };
    expect(() =>
      applyProjectCommand(chain, {
        type: "task.update",
        taskId: "A",
        changes: { parentId: "C" },
      }),
    ).toThrow("cycle");
  });

  it("rejects an unknown assignee member", () => {
    expect(() =>
      applyProjectCommand(project, {
        type: "task.update",
        taskId: "task-2",
        changes: { assigneeMemberId: "member-missing" },
      }),
    ).toThrow("unknown member");
  });

  it("rejects a dependency on an unknown task", () => {
    expect(() =>
      applyProjectCommand(project, {
        type: "task.update",
        taskId: "task-2",
        changes: { dependencies: [{ predecessorId: "task-missing", type: "FS", lagWorkingDays: 0 }] },
      }),
    ).toThrow("unknown task");
  });
});

describe("drag re-parent recomputes leaf membership and holds the rollup", () => {
  // P1 owns the only real-effort leaf L1 (8h = 1 pd); P2 is an empty leaf.
  const reparentFixture: ProjectState = {
    ...project,
    tasks: [
      makeTask({ id: "P1", sortOrder: 0, name: "Parent 1" }),
      makeTask({
        id: "L1",
        parentId: "P1",
        sortOrder: 1,
        name: "Leaf 1",
        plannedEffortMinutes: 480,
        dailyPlan: { "2026-01-05": 480 },
      }),
      makeTask({ id: "P2", sortOrder: 2, name: "Parent 2" }),
    ],
  };

  it("flips old parent to a leaf, new parent to a summary, and keeps BAC leaf-only", () => {
    const beforeLeaves = leafTaskIds(reparentFixture.tasks);
    expect(beforeLeaves.has("L1")).toBe(true);
    expect(beforeLeaves.has("P2")).toBe(true);
    expect(beforeLeaves.has("P1")).toBe(false); // P1 is a summary (owns L1)
    // Leaf-only BAC: L1's 8h = 1 person-day (P2's empty leaf adds 0).
    expect(projectWbsGrid(reparentFixture).rollup.bac).toBe(1);

    // Drag L1 from P1 onto P2 — the same command the grid's dnd path dispatches.
    const next = applyProjectCommand(reparentFixture, {
      type: "task.update",
      taskId: "L1",
      changes: { parentId: "P2" },
    });
    expect(next.tasks.find((task) => task.id === "L1")?.parentId).toBe("P2");

    const afterLeaves = leafTaskIds(next.tasks);
    expect(afterLeaves.has("P1")).toBe(true); // old parent is now a leaf
    expect(afterLeaves.has("P2")).toBe(false); // new parent is now a summary
    expect(afterLeaves.has("L1")).toBe(true);

    // The moved effort is still counted exactly once: BAC is unchanged at 1 pd
    // (P1 now contributes 0 as a leaf, P2's former 0 leaf is now excluded).
    expect(projectWbsGrid(next).rollup.bac).toBe(1);
  });
});
