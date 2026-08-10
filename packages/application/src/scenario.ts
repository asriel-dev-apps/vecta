/**
 * Scenario (Design 0015): a revision-pinned draft of PLAN-ONLY changes that never
 * touches Current until a human publishes it.
 *
 * This module is the gate. ADR 0008 Decision 1 says a scenario holds "an ordered
 * set of existing plan-only project commands. Progress, actuals, and Baseline
 * publication are not valid Scenario changes." Turning that into a check is less
 * obvious than it reads, for two reasons measured against the real types:
 *
 *  1. `UpdateTaskCommand.changes` is `Partial<Omit<ProjectTask, "id" | "seq">>`
 *     and `UpdateMemberCommand.changes` is `Partial<Omit<ProjectMember, "id">>`.
 *     Progress, actuals and the cost rate therefore reach a scenario through
 *     FIELDS, not through command types. A type-level allow-list alone would let
 *     `{type: "task.update", changes: {progressBasisPoints: 10000}}` straight in.
 *  2. The `ProjectCommand` union grows. So the type check DEFAULT-DENIES: a
 *     command type added later is refused until someone lists it here on purpose,
 *     rather than inheriting a scenario write path nobody reviewed.
 *
 * Both lists are ALLOW-lists, the same shape and for the same reason as
 * `stripSensitiveMemberFields` in `project-projection.ts`.
 */

import {
  applyProjectCommand,
  type ProjectCommand,
  type ProjectMember,
  type ProjectState,
  type ProjectTask,
} from "./project-state.js";

/**
 * Command types a scenario may hold. Everything absent is refused, including a
 * type that does not exist yet.
 *
 * `actuals.import` and `baseline.publish` are the two the ADR names explicitly:
 * the first is actuals, the second is the thing a scenario must never do
 * (ADR 0008 Decision 3 — publish is scenario-to-Current and leaves Baseline
 * alone). Member commands ARE allowed, because "what if we add one person" is the
 * feature's whole motivation.
 */
const ALLOWED_COMMAND_TYPES: ReadonlySet<ProjectCommand["type"]> = new Set([
  "task.add",
  "task.update",
  "task.delete",
  "task.generateSubtasks",
  "member.add",
  "member.update",
  "member.delete",
  "process.add",
  "process.update",
  "process.delete",
  "product.add",
  "product.update",
  "product.delete",
  "template.add",
  "template.update",
  "template.delete",
]);

/**
 * Task fields a scenario may change. Plan only.
 *
 * Absent on purpose, and each absence is the ADR's "progress and actuals":
 * `progressBasisPoints`, `actualEffortMinutes`, `datedActuals`, `actualStart`,
 * `actualFinish`. A scenario that could move progress would move EV, and its SPI
 * would then answer a question nobody asked.
 */
const ALLOWED_TASK_FIELDS: ReadonlySet<keyof ProjectTask> = new Set([
  "parentId",
  "sortOrder",
  "name",
  "processId",
  "productId",
  "note",
  "contract",
  "assigneeMemberId",
  "plannedEffortMinutes",
  "prorationWeightBp",
  "dailyPlan",
  "dependencies",
]);

/**
 * Member fields a scenario may change.
 *
 * `costRateMinorPerHour` is absent, and that follows from the snapshot rather
 * than from the ADR: Design 0015 §4.2 keeps the rate OUT of the base snapshot, so
 * a scenario cannot read it, and letting a scenario write a value it cannot read
 * would be a blind edit. Money in a scenario is derived from Current's members
 * through the normal privileged path, exactly as feature 4 built it.
 */
const ALLOWED_MEMBER_FIELDS: ReadonlySet<keyof ProjectMember> = new Set([
  "name",
  "calendarId",
  "dailyCapacityMinutes",
]);

/** Raised when a command is not something a scenario may hold. */
export class ScenarioCommandRejectedError extends Error {
  constructor(
    readonly commandType: string,
    readonly field: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ScenarioCommandRejectedError";
  }
}

function rejectedFields(
  changes: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): readonly string[] {
  return Object.keys(changes).filter((field) => !allowed.has(field));
}

/**
 * Throw unless `command` is one a scenario may hold.
 *
 * Returns nothing on success rather than a boolean, so a caller cannot use it and
 * ignore the result — the same reason the command service throws on a revision
 * conflict instead of returning one.
 */
export function assertScenarioCommand(command: ProjectCommand): void {
  if (!ALLOWED_COMMAND_TYPES.has(command.type)) {
    throw new ScenarioCommandRejectedError(
      command.type,
      undefined,
      `A scenario cannot hold a "${command.type}" command: it holds plan-only changes ` +
        "(ADR 0008 Decision 1). Progress, actuals and baseline publication belong to Current.",
    );
  }
  if (command.type === "task.update") {
    const refused = rejectedFields(command.changes, ALLOWED_TASK_FIELDS as ReadonlySet<string>);
    if (refused.length > 0) {
      throw new ScenarioCommandRejectedError(
        command.type,
        refused[0],
        `A scenario cannot change task field(s) ${refused.join(", ")}: a scenario holds plan, ` +
          "not progress or actuals (ADR 0008 Decision 1).",
      );
    }
  }
  if (command.type === "member.update") {
    const refused = rejectedFields(command.changes, ALLOWED_MEMBER_FIELDS as ReadonlySet<string>);
    if (refused.length > 0) {
      throw new ScenarioCommandRejectedError(
        command.type,
        refused[0],
        `A scenario cannot change member field(s) ${refused.join(", ")}: the cost rate is not in ` +
          "the base snapshot (Design 0015 §4.2), so a scenario cannot read it and must not write it.",
      );
    }
  }
}

/**
 * The scenario's own `ProjectState`: the base snapshot with the edits replayed in
 * order.
 *
 * This is the whole of "what does this scenario look like". There is no second EVM
 * engine — `applyProjectCommand` is pure (`project-state.ts:703`) and
 * `projectEvmDashboard` / `projectWbsGrid` are pure projections over a
 * `ProjectState`, so the answer is the SAME projections Current runs, over a
 * different state.
 *
 * Every edit is re-checked on the way through. The gate already ran when the edit
 * was stored, but a stored row outlives the code that wrote it, and this is the
 * cheaper of the two places to be paranoid.
 */
export function scenarioState(
  base: ProjectState,
  edits: readonly ProjectCommand[],
): ProjectState {
  return edits.reduce<ProjectState>((state, command) => {
    assertScenarioCommand(command);
    return applyProjectCommand(state, command);
  }, base);
}

/**
 * The base snapshot, as it is stored: a `ProjectState` with the sensitive member
 * fields removed.
 *
 * Keys are ABSENT rather than null, so `"costRateMinorPerHour" in member` is false
 * — the same structural choice `stripSensitiveMemberFields` makes, and for the
 * same reason: a null would still be a place for a value to appear later.
 */
export type ScenarioSnapshotMember = Omit<ProjectMember, "costRateMinorPerHour">;
export interface ScenarioSnapshotState extends Omit<ProjectState, "members"> {
  readonly members: readonly ScenarioSnapshotMember[];
}

/**
 * Take the snapshot. An ALLOW-list, so a field added to `ProjectMember` stays out
 * of the snapshot until someone puts it there deliberately.
 */
export function scenarioSnapshot(state: ProjectState): ScenarioSnapshotState {
  return {
    ...state,
    members: state.members.map((member) => ({
      id: member.id,
      name: member.name,
      calendarId: member.calendarId,
      dailyCapacityMinutes: member.dailyCapacityMinutes,
    })),
  };
}

/**
 * Rebuild a `ProjectState` from a stored snapshot.
 *
 * The rate comes back as `null` — "not known to this scenario" — which is the
 * value `ProjectMember` already defines for a member with no recorded rate, and it
 * flows through feature 4's money layer as a member whose leaves are counted OUT
 * of the money aggregate with a visible count, rather than as a silent zero.
 */
export function scenarioStateFromSnapshot(snapshot: ScenarioSnapshotState): ProjectState {
  return {
    ...snapshot,
    members: snapshot.members.map((member) => ({ ...member, costRateMinorPerHour: null })),
  };
}
