import { describe, expect, it } from "vitest";
import {
  ScenarioCommandRejectedError,
  assertScenarioCommand,
  projectEvmDashboard,
  scenarioSnapshot,
  scenarioState,
  scenarioStateFromSnapshot,
  type ProjectCommand,
  type ProjectState,
  type ProjectTask,
} from "../src/index.js";

/**
 * Scenario gate and state assembly (Design 0015 §4, §6).
 *
 * Design 0008 requires every control to come as a PAIR, because a negative alone
 * ("the forbidden thing is refused") passes against a feature that was never
 * wired at all. So each rejection here is matched by a command that IS allowed
 * and that measurably moves the scenario's state.
 *
 * What each control would let through if it were the only one:
 *
 *   * The type-level pair alone would miss `{type: "task.update", changes:
 *     {progressBasisPoints: 10000}}` — `UpdateTaskCommand.changes` is
 *     `Partial<Omit<ProjectTask, "id" | "seq">>`, so progress and actuals ride in
 *     on an allowed TYPE. Hence the field-level pair.
 *   * The field-level pair alone would miss a command type added to the union
 *     later. Hence the unknown-type control, which is the one that proves the
 *     list default-denies rather than default-allows.
 *   * Both together would still miss a snapshot that quietly dropped a field.
 *     Hence the round-trip control, which is the only check here that catches
 *     something nobody thought to name.
 */

const MEMBER_A = "a0000000-0000-4000-8000-000000000001";
const MEMBER_B = "a0000000-0000-4000-8000-000000000002";

function makeTask(overrides: Partial<ProjectTask> & Pick<ProjectTask, "id" | "seq">): ProjectTask {
  return {
    parentId: null,
    sortOrder: 0,
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

function makeProject(overrides: Partial<ProjectState> = {}): ProjectState {
  return {
    id: "project-1",
    name: "Effort WBS",
    projectStart: "2026-08-01",
    statusDate: "2026-08-31",
    currency: "JPY",
    defaultCalendarId: "standard",
    calendars: [
      { id: "standard", name: "Standard", workingWeekdays: [1, 2, 3, 4, 5], nonWorkingDates: [] },
    ],
    members: [
      {
        id: MEMBER_A,
        name: "Member 01",
        calendarId: "standard",
        dailyCapacityMinutes: 480,
        // A RECORDED rate, on purpose: a null would make the snapshot control
        // pass whether or not the field was stripped.
        costRateMinorPerHour: 500_000,
      },
      {
        id: MEMBER_B,
        name: "Member 02",
        calendarId: "standard",
        dailyCapacityMinutes: 480,
        costRateMinorPerHour: 400_000,
      },
    ],
    processes: [],
    products: [],
    templates: [],
    tasks: [
      makeTask({ id: "parent", seq: 1, name: "Phase A" }),
      makeTask({
        id: "leaf-1",
        seq: 2,
        parentId: "parent",
        name: "A",
        plannedEffortMinutes: 480,
        dailyPlan: { "2026-08-03": 480 },
        progressBasisPoints: 5000,
        actualEffortMinutes: 240,
      }),
      makeTask({
        id: "leaf-2",
        seq: 3,
        parentId: "parent",
        name: "B",
        plannedEffortMinutes: 480,
        dailyPlan: { "2026-08-04": 480 },
      }),
    ],
    nextTaskSeq: 4,
    nextBaselineVersion: 1,
    ...overrides,
  };
}

function rejection(command: ProjectCommand): ScenarioCommandRejectedError {
  try {
    assertScenarioCommand(command);
  } catch (error) {
    if (error instanceof ScenarioCommandRejectedError) return error;
    throw error;
  }
  throw new Error("assertScenarioCommand resolved instead of rejecting");
}

describe("which commands a scenario may hold", () => {
  it("refuses actuals.import — a scenario holds plan, not actuals", () => {
    const error = rejection({ type: "actuals.import", entries: [] });
    expect(error.commandType).toBe("actuals.import");
  });

  it("refuses baseline.publish — publish is scenario-to-Current and leaves Baseline alone", () => {
    const error = rejection({ type: "baseline.publish" } as ProjectCommand);
    expect(error.commandType).toBe("baseline.publish");
  });

  it("refuses a command type that does not exist, so the list default-DENIES", () => {
    // The `ProjectCommand` union grows. This stands in for the next member of it:
    // if the check were a deny-list, a new type would inherit a scenario write
    // path nobody reviewed, and this test would go green by doing nothing.
    const error = rejection({ type: "task.teleport" } as unknown as ProjectCommand);
    expect(error.commandType).toBe("task.teleport");
  });

  it("ALLOWS member.add, and it moves the scenario — the positive half", () => {
    // "What if we add one person" is the feature's whole motivation. Without this
    // pair, a gate that refused everything would pass every test above.
    const base = makeProject();
    const next = scenarioState(base, [
      {
        type: "member.add",
        member: {
          id: "a0000000-0000-4000-8000-000000000003",
          name: "Member 03",
          calendarId: "standard",
          dailyCapacityMinutes: 480,
          costRateMinorPerHour: null,
        },
      },
    ]);
    expect(next.members).toHaveLength(3);
    expect(base.members).toHaveLength(2);
  });

  it("ALLOWS a plan-only task.update, and the scenario's BAC moves", () => {
    const base = makeProject();
    const next = scenarioState(base, [
      { type: "task.update", taskId: "leaf-2", changes: { dailyPlan: { "2026-08-04": 960 } } },
    ]);
    const before = projectEvmDashboard(base);
    const after = projectEvmDashboard(next);
    expect(after.total.bac).not.toBe(before.total.bac);
  });
});

describe("the fields inside an allowed command type", () => {
  it.each([
    ["progressBasisPoints", { progressBasisPoints: 10_000 }],
    ["actualEffortMinutes", { actualEffortMinutes: 999 }],
    ["datedActuals", { datedActuals: { "2026-08-03|x": 60 } }],
    ["actualStart", { actualStart: "2026-08-03" }],
    ["actualFinish", { actualFinish: "2026-08-03" }],
  ])("refuses task.update carrying %s", (field, changes) => {
    // Every one of these rides in on an ALLOWED command type. A type-level
    // allow-list on its own lets all five through.
    const error = rejection({
      type: "task.update",
      taskId: "leaf-1",
      changes: changes as ProjectTask,
    });
    expect(error.field).toBe(field);
  });

  it("refuses member.update carrying the cost rate", () => {
    // Not because the ADR names it, but because Design 0015 §4.2 keeps the rate
    // OUT of the snapshot: a scenario cannot read it, so writing it would be a
    // blind edit.
    const error = rejection({
      type: "member.update",
      memberId: MEMBER_A,
      changes: { costRateMinorPerHour: 999_999 },
    });
    expect(error.field).toBe("costRateMinorPerHour");
  });

  it("ALLOWS member.update on capacity, and the scenario takes it", () => {
    const next = scenarioState(makeProject(), [
      { type: "member.update", memberId: MEMBER_A, changes: { dailyCapacityMinutes: 240 } },
    ]);
    expect(next.members.find((m) => m.id === MEMBER_A)?.dailyCapacityMinutes).toBe(240);
  });

  it("names every refused field, not just the first", () => {
    // A fix loop as long as the change bag is the failure this avoids — the same
    // reasoning Design 0011 §8 負 2 applies to the timesheet importer.
    const error = rejection({
      type: "task.update",
      taskId: "leaf-1",
      changes: { progressBasisPoints: 1, actualEffortMinutes: 2 } as ProjectTask,
    });
    expect(error.message).toContain("progressBasisPoints");
    expect(error.message).toContain("actualEffortMinutes");
  });
});

describe("the base snapshot", () => {
  it("does not carry the cost rate, by absence rather than by null", () => {
    // Exact-name, the same flavour as the bundle scanner and feature 4's control:
    // a snapshot holding the rate would be a second read path for a field the
    // GENERAL projection strips.
    const snapshot = scenarioSnapshot(makeProject());
    for (const member of snapshot.members) {
      expect("costRateMinorPerHour" in member).toBe(false);
    }
    expect(JSON.stringify(snapshot)).not.toContain("costRateMinorPerHour");
    expect(JSON.stringify(snapshot)).not.toContain("500000");
  });

  it("round-trips: snapshot then rebuild gives the SAME projection as Current", () => {
    // Measured 2026-08-10: this catches a dropped `dailyPlan` but NOT a dropped
    // `calendars`, because `projectEvmDashboard` does not read the calendars. A
    // projection-level round-trip only ever covers what that projection consumes,
    // which is why the STATE-level control below has to exist beside it. Keeping
    // both: this one is what a reader will reach for first, and its limit is
    // recorded rather than assumed away.
    const current = makeProject();
    const rebuilt = scenarioStateFromSnapshot(scenarioSnapshot(current));
    expect(projectEvmDashboard(rebuilt)).toStrictEqual(projectEvmDashboard(current));
  });

  it("round-trips the whole STATE, so a dropped field cannot hide behind a projection", () => {
    // The control that actually catches "a field nobody thought to name". The
    // cost rate is the one intended difference, so it is nulled on the expected
    // side rather than excluded from the comparison — excluding it would also
    // excuse a second field going missing.
    const current = makeProject();
    const rebuilt = scenarioStateFromSnapshot(scenarioSnapshot(current));
    expect(rebuilt).toStrictEqual({
      ...current,
      members: current.members.map((member) => ({ ...member, costRateMinorPerHour: null })),
    });
  });

  it("keeps nextTaskSeq, so a draft's No. is the No. it publishes with", () => {
    const rebuilt = scenarioStateFromSnapshot(scenarioSnapshot(makeProject({ nextTaskSeq: 42 })));
    const next = scenarioState(rebuilt, [
      {
        type: "task.add",
        task: makeTask({ id: "new-1", seq: 0, name: "New", parentId: "parent" }),
      } as ProjectCommand,
    ]);
    expect(next.tasks.find((task) => task.id === "new-1")?.seq).toBe(42);
  });
});

describe("a scenario never touches Current", () => {
  it("leaves the base state byte-identical after a run of edits", () => {
    // Design 0008's row-6 NEGATIVE. It is here for completeness and is explicitly
    // NOT sufficient on its own — it passes against a feature that does nothing,
    // which is why every describe block above pairs it with a positive.
    const base = makeProject();
    const before = structuredClone(base);
    scenarioState(base, [
      { type: "task.update", taskId: "leaf-2", changes: { plannedEffortMinutes: 960 } },
      { type: "member.update", memberId: MEMBER_B, changes: { name: "Renamed" } },
      { type: "task.delete", taskId: "leaf-1" },
    ]);
    expect(base).toStrictEqual(before);
  });
});
