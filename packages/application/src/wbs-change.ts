/**
 * Result diff of one WBS operation (Design 0016 §2.1).
 *
 * `diffOperation` runs `applyProjectCommand` and records what that run changed.
 * It does not re-implement transitions. Replaying the record on the before
 * state reproduces the after state, including values the command did not name
 * (re-proration, display numbers, re-parenting). Direct fields are kept even
 * when the value ends unchanged; structural and derived fields that end equal
 * are dropped.
 */
import type { DependencyType } from "@vecta/domain";
import { datedActualKey } from "./dated-actuals.js";
import {
  applyProjectCommand,
  type ProjectCalendar,
  type ProjectCommand,
  type ProjectDependency,
  type ProjectMember,
  type ProjectProcess,
  type ProjectProduct,
  type ProjectState,
  type ProjectTask,
  type SubtaskTemplate,
} from "./project-state.js";
import type { SubtaskTemplateStep } from "./subtask-templates.js";

export type ChangeKind = "direct" | "structural" | "derived";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [k: string]: JsonValue };

/** One field of one logical row. `before`/`after` ABSENT (key missing) = the row/cell does not exist; null = exists with null. */
export interface FieldChange {
  readonly target: string;
  readonly field: string;
  readonly before?: JsonValue;
  readonly after?: JsonValue;
  readonly kind: ChangeKind;
}

export interface WbsChange {
  readonly format: 1;
  readonly changes: readonly FieldChange[];
}

export const WBS_CHANGE_FORMAT = 1;

const ABSENT = Symbol("absent");
type MaybeValue = JsonValue | typeof ABSENT;

interface Mark {
  readonly target: string;
  readonly field: string;
  readonly kind: "direct" | "structural";
}

interface RowBody {
  readonly fields: ReadonlyMap<string, JsonValue>;
  readonly whole: JsonValue;
}

interface FlatState {
  readonly wbs: ReadonlyMap<string, JsonValue>;
  readonly rows: ReadonlyMap<string, RowBody>;
}

interface Draft {
  id: string;
  name: string;
  projectStart: string;
  statusDate: string;
  currency: "JPY";
  defaultCalendarId: string;
  calendars: ProjectCalendar[];
  members: ProjectMember[];
  processes: ProjectProcess[];
  products: ProjectProduct[];
  templates: SubtaskTemplate[];
  tasks: ProjectTask[];
  nextTaskSeq: number;
  nextBaselineVersion: number;
}

const WBS_FIELDS = [
  "name",
  "projectStart",
  "statusDate",
  "defaultCalendarId",
  "nextTaskSeq",
  "nextBaselineVersion",
] as const;

type WbsField = (typeof WBS_FIELDS)[number];

const TASK_SCALARS = [
  "parentId",
  "sortOrder",
  "seq",
  "name",
  "processId",
  "productId",
  "note",
  "contract",
  "assigneeMemberId",
  "plannedEffortMinutes",
  "progressBasisPoints",
  "actualEffortMinutes",
  "prorationWeightBp",
  "actualStart",
  "actualFinish",
] as const;

type TaskScalar = (typeof TASK_SCALARS)[number];

const DEPENDENCY_TYPES: readonly DependencyType[] = ["FF", "FS", "SF", "SS"];

/**
 * `validateProject` rejects a duplicate edge only when predecessor AND type
 * match (`predecessorId` + NUL + `type`). The same predecessor may appear
 * twice on one successor with different types, so the type is part of the key:
 * `dependency:<successorId><-<predecessorId>:<type>`.
 */
function dependencyTarget(successorId: string, predecessorId: string, type: DependencyType): string {
  return `dependency:${successorId}<-${predecessorId}:${type}`;
}

function direct(target: string, field: string): Mark {
  return { target, field, kind: "direct" };
}

function structural(target: string, field: string): Mark {
  return { target, field, kind: "structural" };
}

/** UTF-16 code-unit order. `localeCompare` follows the runtime locale; `<` does not. */
function compareCodeUnit(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function invalid(detail: string): Error {
  return new Error(`Invalid WBS change: ${detail}`);
}

function isPlainRecord(value: object): boolean {
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function isDependencyType(value: string): value is DependencyType {
  return (DEPENDENCY_TYPES as readonly string[]).includes(value);
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Canonical JSON cannot encode a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (isUnknownArray(value)) {
    const parts: string[] = [];
    for (const entry of value) {
      if (entry === undefined) throw new Error("Canonical JSON cannot encode undefined");
      parts.push(canonicalJson(entry));
    }
    return `[${parts.join(",")}]`;
  }
  if (typeof value === "object") {
    if (!isPlainRecord(value)) throw new Error("Canonical JSON cannot encode a non-plain object");
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(compareCodeUnit);
    const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${parts.join(",")}}`;
  }
  throw new Error(`Canonical JSON cannot encode ${typeof value}`);
}

function sortById<T extends { readonly id: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => compareCodeUnit(left.id, right.id));
}

function sortDependencies(dependencies: readonly ProjectDependency[]): ProjectDependency[] {
  return [...dependencies].sort(
    (left, right) =>
      compareCodeUnit(left.predecessorId, right.predecessorId) ||
      compareCodeUnit(left.type, right.type),
  );
}

export function canonicalWbsState(state: ProjectState): string {
  return canonicalJson({
    canonical: 1,
    id: state.id,
    name: state.name,
    projectStart: state.projectStart,
    statusDate: state.statusDate,
    currency: state.currency,
    defaultCalendarId: state.defaultCalendarId,
    nextTaskSeq: state.nextTaskSeq,
    nextBaselineVersion: state.nextBaselineVersion,
    calendars: sortById(state.calendars),
    members: sortById(state.members),
    processes: sortById(state.processes),
    products: sortById(state.products),
    templates: sortById(state.templates),
    tasks: sortById(state.tasks).map((task) => ({
      id: task.id,
      parentId: task.parentId,
      sortOrder: task.sortOrder,
      seq: task.seq,
      name: task.name,
      processId: task.processId,
      productId: task.productId,
      note: task.note,
      contract: task.contract,
      assigneeMemberId: task.assigneeMemberId,
      plannedEffortMinutes: task.plannedEffortMinutes,
      progressBasisPoints: task.progressBasisPoints,
      actualEffortMinutes: task.actualEffortMinutes,
      prorationWeightBp: task.prorationWeightBp,
      dailyPlan: task.dailyPlan,
      datedActuals: task.datedActuals,
      actualStart: task.actualStart,
      actualFinish: task.actualFinish,
      dependencies: sortDependencies(task.dependencies),
    })),
  });
}

export async function hashWbsState(state: ProjectState): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalWbsState(state));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  let hex = "";
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function subtasksToJson(steps: readonly SubtaskTemplateStep[]): JsonValue {
  return steps.map((step) => {
    const json: { name: string; weightBp: number; dependsOnPrev?: JsonValue } = {
      name: step.name,
      weightBp: step.weightBp,
    };
    if (step.dependsOnPrev !== undefined) {
      json.dependsOnPrev = {
        type: step.dependsOnPrev.type,
        lagWorkingDays: step.dependsOnPrev.lagWorkingDays,
      };
    }
    return json;
  });
}

function numberMap(value: Readonly<Record<string, number>>): { readonly [k: string]: JsonValue } {
  const copy: { [k: string]: JsonValue } = {};
  for (const key of Object.keys(value)) {
    const entry = value[key];
    if (entry !== undefined) copy[key] = entry;
  }
  return copy;
}

function taskSnapshot(task: ProjectTask): RowBody {
  const fields = new Map<string, JsonValue>();
  fields.set("parentId", task.parentId);
  fields.set("sortOrder", task.sortOrder);
  fields.set("seq", task.seq);
  fields.set("name", task.name);
  fields.set("processId", task.processId);
  fields.set("productId", task.productId);
  fields.set("note", task.note);
  fields.set("contract", task.contract);
  fields.set("assigneeMemberId", task.assigneeMemberId);
  fields.set("plannedEffortMinutes", task.plannedEffortMinutes);
  fields.set("progressBasisPoints", task.progressBasisPoints);
  fields.set("actualEffortMinutes", task.actualEffortMinutes);
  fields.set("prorationWeightBp", task.prorationWeightBp);
  fields.set("actualStart", task.actualStart);
  fields.set("actualFinish", task.actualFinish);
  for (const [date, minutes] of Object.entries(task.dailyPlan)) {
    fields.set(`dailyPlan.${date}`, minutes);
  }
  for (const [key, minutes] of Object.entries(task.datedActuals)) {
    fields.set(`datedActuals.${key}`, minutes);
  }
  return {
    fields,
    whole: {
      id: task.id,
      parentId: task.parentId,
      sortOrder: task.sortOrder,
      seq: task.seq,
      name: task.name,
      processId: task.processId,
      productId: task.productId,
      note: task.note,
      contract: task.contract,
      assigneeMemberId: task.assigneeMemberId,
      plannedEffortMinutes: task.plannedEffortMinutes,
      progressBasisPoints: task.progressBasisPoints,
      actualEffortMinutes: task.actualEffortMinutes,
      prorationWeightBp: task.prorationWeightBp,
      dailyPlan: numberMap(task.dailyPlan),
      datedActuals: numberMap(task.datedActuals),
      actualStart: task.actualStart,
      actualFinish: task.actualFinish,
    },
  };
}

function dependencySnapshot(dependency: ProjectDependency): RowBody {
  const fields = new Map<string, JsonValue>();
  fields.set("type", dependency.type);
  fields.set("lagWorkingDays", dependency.lagWorkingDays);
  return {
    fields,
    whole: {
      predecessorId: dependency.predecessorId,
      type: dependency.type,
      lagWorkingDays: dependency.lagWorkingDays,
    },
  };
}

function memberSnapshot(member: ProjectMember): RowBody {
  const fields = new Map<string, JsonValue>();
  fields.set("name", member.name);
  fields.set("calendarId", member.calendarId);
  fields.set("dailyCapacityMinutes", member.dailyCapacityMinutes);
  fields.set("costRateMinorPerHour", member.costRateMinorPerHour);
  return {
    fields,
    whole: {
      id: member.id,
      name: member.name,
      calendarId: member.calendarId,
      dailyCapacityMinutes: member.dailyCapacityMinutes,
      costRateMinorPerHour: member.costRateMinorPerHour,
    },
  };
}

function calendarSnapshot(calendar: ProjectCalendar): RowBody {
  const fields = new Map<string, JsonValue>();
  fields.set("name", calendar.name);
  fields.set("workingWeekdays", [...calendar.workingWeekdays]);
  fields.set("nonWorkingDates", [...calendar.nonWorkingDates]);
  return {
    fields,
    whole: {
      id: calendar.id,
      name: calendar.name,
      workingWeekdays: [...calendar.workingWeekdays],
      nonWorkingDates: [...calendar.nonWorkingDates],
    },
  };
}

function namedSortSnapshot(
  entity: ProjectProcess | ProjectProduct,
): RowBody {
  const fields = new Map<string, JsonValue>();
  fields.set("name", entity.name);
  fields.set("sortOrder", entity.sortOrder);
  return {
    fields,
    whole: { id: entity.id, name: entity.name, sortOrder: entity.sortOrder },
  };
}

function templateSnapshot(template: SubtaskTemplate): RowBody {
  const subtasks = subtasksToJson(template.subtasks);
  const fields = new Map<string, JsonValue>();
  fields.set("name", template.name);
  fields.set("sortOrder", template.sortOrder);
  fields.set("subtasks", subtasks);
  return {
    fields,
    whole: {
      id: template.id,
      name: template.name,
      sortOrder: template.sortOrder,
      subtasks,
    },
  };
}

function putRow(rows: Map<string, RowBody>, target: string, row: RowBody): void {
  if (rows.has(target)) throw new Error(`Duplicate WBS row target ${target}`);
  rows.set(target, row);
}

function flatten(state: ProjectState): FlatState {
  const wbs = new Map<string, JsonValue>();
  wbs.set("name", state.name);
  wbs.set("projectStart", state.projectStart);
  wbs.set("statusDate", state.statusDate);
  wbs.set("defaultCalendarId", state.defaultCalendarId);
  wbs.set("nextTaskSeq", state.nextTaskSeq);
  wbs.set("nextBaselineVersion", state.nextBaselineVersion);

  const rows = new Map<string, RowBody>();
  for (const calendar of state.calendars) putRow(rows, `calendar:${calendar.id}`, calendarSnapshot(calendar));
  for (const member of state.members) putRow(rows, `member:${member.id}`, memberSnapshot(member));
  for (const process of state.processes) putRow(rows, `process:${process.id}`, namedSortSnapshot(process));
  for (const product of state.products) putRow(rows, `product:${product.id}`, namedSortSnapshot(product));
  for (const template of state.templates) putRow(rows, `template:${template.id}`, templateSnapshot(template));
  for (const task of state.tasks) {
    putRow(rows, `task:${task.id}`, taskSnapshot(task));
    for (const dependency of task.dependencies) {
      putRow(
        rows,
        dependencyTarget(task.id, dependency.predecessorId, dependency.type),
        dependencySnapshot(dependency),
      );
    }
  }
  return { wbs, rows };
}

function mapCellMarks(
  target: string,
  prefix: "dailyPlan" | "datedActuals",
  before: Readonly<Record<string, number>>,
  supplied: Readonly<Record<string, number>>,
): Mark[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(supplied)]);
  const marks: Mark[] = [];
  for (const key of keys) marks.push(direct(target, `${prefix}.${key}`));
  return marks;
}

function dependencyEdgeMarks(successorId: string, before: readonly ProjectDependency[], after: readonly ProjectDependency[]): Mark[] {
  const beforeByTarget = new Map<string, ProjectDependency>();
  for (const dependency of before) {
    beforeByTarget.set(dependencyTarget(successorId, dependency.predecessorId, dependency.type), dependency);
  }
  const afterByTarget = new Map<string, ProjectDependency>();
  for (const dependency of after) {
    afterByTarget.set(dependencyTarget(successorId, dependency.predecessorId, dependency.type), dependency);
  }
  const marks: Mark[] = [];
  for (const target of new Set([...beforeByTarget.keys(), ...afterByTarget.keys()])) {
    if (!beforeByTarget.has(target) || !afterByTarget.has(target)) {
      marks.push(direct(target, ""));
      continue;
    }
    if (beforeByTarget.get(target)!.lagWorkingDays !== afterByTarget.get(target)!.lagWorkingDays) {
      marks.push(direct(target, "lagWorkingDays"));
    }
  }
  return marks;
}

function updateMarks(target: string, changes: object): Mark[] {
  return Object.keys(changes).map((field) => direct(target, field));
}

/**
 * What each command names (direct) and what must travel with it (structural).
 * Anything else that still differs after the command is derived. Keyed by
 * command type so a new command cannot fall through an if-chain.
 */
const COMMAND_EFFECTS = commandEffects({
  "baseline.publish": () => [direct("wbs", "nextBaselineVersion")],
  "actuals.import": (state, command) => {
    const partitions = new Set<string>();
    const marks: Mark[] = [];
    for (const entry of command.entries) {
      const cell = datedActualKey(entry.workDate, entry.memberId);
      partitions.add(cell);
      marks.push(direct(`task:${entry.taskId}`, `datedActuals.${cell}`));
    }
    for (const task of state.tasks) {
      for (const key of Object.keys(task.datedActuals)) {
        if (!partitions.has(key)) continue;
        marks.push(direct(`task:${task.id}`, `datedActuals.${key}`));
      }
    }
    return marks;
  },
  "task.add": (_state, command) => {
    const marks: Mark[] = [
      direct(`task:${command.task.id}`, ""),
      structural("wbs", "nextTaskSeq"),
    ];
    for (const dependency of command.task.dependencies) {
      marks.push(direct(dependencyTarget(command.task.id, dependency.predecessorId, dependency.type), ""));
    }
    return marks;
  },
  "task.update": (state, command) => {
    const task = state.tasks.find((entry) => entry.id === command.taskId);
    if (task === undefined) return [];
    const target = `task:${task.id}`;
    const marks: Mark[] = [];
    if (Object.hasOwn(command.changes, "dailyPlan") && command.changes.dailyPlan !== undefined) {
      marks.push(...mapCellMarks(target, "dailyPlan", task.dailyPlan, command.changes.dailyPlan));
    }
    if (Object.hasOwn(command.changes, "datedActuals") && command.changes.datedActuals !== undefined) {
      marks.push(...mapCellMarks(target, "datedActuals", task.datedActuals, command.changes.datedActuals));
    }
    if (Object.hasOwn(command.changes, "dependencies") && command.changes.dependencies !== undefined) {
      marks.push(...dependencyEdgeMarks(task.id, task.dependencies, command.changes.dependencies));
    }
    for (const field of TASK_SCALARS) {
      if (Object.hasOwn(command.changes, field)) marks.push(direct(target, field));
    }
    return marks;
  },
  "task.delete": (state, command) => {
    const task = state.tasks.find((entry) => entry.id === command.taskId);
    if (task === undefined) return [];
    const marks: Mark[] = [direct(`task:${task.id}`, "")];
    for (const dependency of task.dependencies) {
      marks.push(structural(dependencyTarget(task.id, dependency.predecessorId, dependency.type), ""));
    }
    for (const child of state.tasks) {
      if (child.parentId === task.id) marks.push(structural(`task:${child.id}`, "parentId"));
    }
    return marks;
  },
  "task.generateSubtasks": (state, command, after) => {
    const beforeIds = new Set(state.tasks.map((task) => task.id));
    const marks: Mark[] = [structural("wbs", "nextTaskSeq")];
    for (const task of after.tasks) {
      if (beforeIds.has(task.id) || task.parentId !== command.parentTaskId) continue;
      marks.push(structural(`task:${task.id}`, ""));
      for (const dependency of task.dependencies) {
        marks.push(structural(dependencyTarget(task.id, dependency.predecessorId, dependency.type), ""));
      }
    }
    return marks;
  },
  "member.add": (_state, command) => [direct(`member:${command.member.id}`, "")],
  "member.update": (_state, command) => updateMarks(`member:${command.memberId}`, command.changes),
  "member.delete": (_state, command) => [direct(`member:${command.memberId}`, "")],
  "process.add": (_state, command) => [direct(`process:${command.process.id}`, "")],
  "process.update": (_state, command) => updateMarks(`process:${command.processId}`, command.changes),
  "process.delete": (_state, command) => [direct(`process:${command.processId}`, "")],
  "product.add": (_state, command) => [direct(`product:${command.product.id}`, "")],
  "product.update": (_state, command) => updateMarks(`product:${command.productId}`, command.changes),
  "product.delete": (_state, command) => [direct(`product:${command.productId}`, "")],
  "template.add": (_state, command) => [direct(`template:${command.template.id}`, "")],
  "template.update": (_state, command) => updateMarks(`template:${command.templateId}`, command.changes),
  "template.delete": (_state, command) => [direct(`template:${command.templateId}`, "")],
});

function commandEffects<
  const T extends {
    readonly [K in ProjectCommand["type"]]: (
      state: ProjectState,
      command: Extract<ProjectCommand, { readonly type: K }>,
      after: ProjectState,
    ) => readonly Mark[];
  },
>(table: T): T {
  return table;
}

function classify(state: ProjectState, command: ProjectCommand, after: ProjectState): readonly Mark[] {
  const effect = COMMAND_EFFECTS[command.type] as (
    state: ProjectState,
    command: ProjectCommand,
    after: ProjectState,
  ) => readonly Mark[];
  return effect(state, command, after);
}

function stronger(
  current: "direct" | "structural" | undefined,
  next: "direct" | "structural",
): "direct" | "structural" {
  if (current === "direct" || next === "direct") return "direct";
  return "structural";
}

function mergeMarks(marks: readonly Mark[]): Mark[] {
  const byKey = new Map<string, Mark>();
  for (const mark of marks) {
    const key = `${mark.target}\0${mark.field}`;
    const previous = byKey.get(key);
    if (previous === undefined || stronger(previous.kind, mark.kind) !== previous.kind) {
      byKey.set(key, mark);
    }
  }
  return [...byKey.values()];
}

function sameMaybe(left: MaybeValue, right: MaybeValue): boolean {
  if (left === ABSENT || right === ABSENT) return left === right;
  return canonicalJson(left) === canonicalJson(right);
}

function readField(row: RowBody, field: string): MaybeValue {
  if (!row.fields.has(field)) return ABSENT;
  const value = row.fields.get(field);
  return value === undefined ? ABSENT : value;
}

function toChange(target: string, field: string, before: MaybeValue, after: MaybeValue, kind: ChangeKind): FieldChange {
  const change: {
    target: string;
    field: string;
    kind: ChangeKind;
    before?: JsonValue;
    after?: JsonValue;
  } = { target, field, kind };
  if (before !== ABSENT) change.before = before;
  if (after !== ABSENT) change.after = after;
  return change;
}

function diffRow(target: string, beforeRow: RowBody | undefined, afterRow: RowBody | undefined, marks: readonly Mark[]): FieldChange[] {
  const markByField = new Map<string, "direct" | "structural">();
  for (const mark of marks) {
    markByField.set(mark.field, stronger(markByField.get(mark.field), mark.kind));
  }

  // Added and removed within one operation: nothing to record or replay.
  if (beforeRow === undefined && afterRow === undefined) return [];

  // A row that appears or disappears is one whole-row entry. Edits later in
  // the same operation are inside that before/after value, so a generated or
  // deleted task does not also emit one entry per daily cell.
  if (beforeRow === undefined || afterRow === undefined) {
    const rowKind = markByField.get("");
    return [
      toChange(
        target,
        "",
        beforeRow === undefined ? ABSENT : beforeRow.whole,
        afterRow === undefined ? ABSENT : afterRow.whole,
        rowKind ?? "derived",
      ),
    ];
  }

  const changes: FieldChange[] = [];
  const fields = new Set<string>([...beforeRow.fields.keys(), ...afterRow.fields.keys()]);
  for (const field of markByField.keys()) {
    if (field !== "") fields.add(field);
  }
  for (const field of fields) {
    const beforeValue = readField(beforeRow, field);
    const afterValue = readField(afterRow, field);
    const mark = markByField.get(field);
    if (mark === "direct") {
      changes.push(toChange(target, field, beforeValue, afterValue, "direct"));
      continue;
    }
    if (sameMaybe(beforeValue, afterValue)) continue;
    changes.push(toChange(target, field, beforeValue, afterValue, mark ?? "derived"));
  }

  const rowMark = markByField.get("");
  const wholesEqual = canonicalJson(beforeRow.whole) === canonicalJson(afterRow.whole);
  if (rowMark === "direct" || (rowMark === "structural" && !wholesEqual)) {
    changes.push(toChange(target, "", beforeRow.whole, afterRow.whole, rowMark));
  }
  return changes;
}

function diffFlat(before: FlatState, after: FlatState, marks: readonly Mark[]): FieldChange[] {
  const marksByTarget = new Map<string, Mark[]>();
  for (const mark of marks) {
    const list = marksByTarget.get(mark.target);
    if (list === undefined) marksByTarget.set(mark.target, [mark]);
    else list.push(mark);
  }

  const changes: FieldChange[] = [];
  const wbsMarks = new Map<string, "direct" | "structural">();
  for (const mark of marksByTarget.get("wbs") ?? []) {
    wbsMarks.set(mark.field, stronger(wbsMarks.get(mark.field), mark.kind));
  }
  for (const field of WBS_FIELDS) {
    const beforeValue = before.wbs.get(field);
    const afterValue = after.wbs.get(field);
    if (beforeValue === undefined || afterValue === undefined) {
      throw new Error(`WBS state is missing ${field}`);
    }
    const mark = wbsMarks.get(field);
    if (mark === "direct") {
      changes.push(toChange("wbs", field, beforeValue, afterValue, "direct"));
      continue;
    }
    if (canonicalJson(beforeValue) === canonicalJson(afterValue)) continue;
    changes.push(toChange("wbs", field, beforeValue, afterValue, mark ?? "derived"));
  }

  const targets = new Set<string>([...before.rows.keys(), ...after.rows.keys(), ...marksByTarget.keys()]);
  targets.delete("wbs");
  for (const target of targets) {
    changes.push(...diffRow(target, before.rows.get(target), after.rows.get(target), marksByTarget.get(target) ?? []));
  }
  changes.sort(
    (left, right) => compareCodeUnit(left.target, right.target) || compareCodeUnit(left.field, right.field),
  );
  return changes;
}

export function diffOperation(
  before: ProjectState,
  commands: readonly ProjectCommand[],
): { after: ProjectState; change: WbsChange } {
  let after = before;
  const marks: Mark[] = [];
  for (const command of commands) {
    const next = applyProjectCommand(after, command);
    marks.push(...classify(after, command, next));
    after = next;
  }
  return {
    after,
    change: { format: WBS_CHANGE_FORMAT, changes: diffFlat(flatten(before), flatten(after), mergeMarks(marks)) },
  };
}

function entrySide(value: JsonValue | undefined): MaybeValue {
  return value === undefined ? ABSENT : value;
}

function valueAt(flat: FlatState, target: string, field: string): MaybeValue {
  if (target === "wbs") {
    const value = flat.wbs.get(field);
    return value === undefined ? ABSENT : value;
  }
  const row = flat.rows.get(target);
  if (field === "") return row === undefined ? ABSENT : row.whole;
  if (row === undefined) return ABSENT;
  return readField(row, field);
}

function assertUnique(changes: readonly FieldChange[]): void {
  const seen = new Set<string>();
  for (const change of changes) {
    const key = `${change.target}\0${change.field}`;
    if (seen.has(key)) throw invalid(`duplicate ${change.target} ${JSON.stringify(change.field)}`);
    seen.add(key);
  }
}

function cloneState(state: ProjectState): Draft {
  return {
    id: state.id,
    name: state.name,
    projectStart: state.projectStart,
    statusDate: state.statusDate,
    currency: state.currency,
    defaultCalendarId: state.defaultCalendarId,
    nextTaskSeq: state.nextTaskSeq,
    nextBaselineVersion: state.nextBaselineVersion,
    calendars: state.calendars.map((calendar) => ({
      id: calendar.id,
      name: calendar.name,
      workingWeekdays: [...calendar.workingWeekdays],
      nonWorkingDates: [...calendar.nonWorkingDates],
    })),
    members: state.members.map((member) => ({ ...member })),
    processes: state.processes.map((process) => ({ ...process })),
    products: state.products.map((product) => ({ ...product })),
    templates: state.templates.map((template) => ({
      id: template.id,
      name: template.name,
      sortOrder: template.sortOrder,
      subtasks: template.subtasks.map((step) =>
        step.dependsOnPrev === undefined
          ? { name: step.name, weightBp: step.weightBp }
          : {
              name: step.name,
              weightBp: step.weightBp,
              dependsOnPrev: {
                type: step.dependsOnPrev.type,
                lagWorkingDays: step.dependsOnPrev.lagWorkingDays,
              },
            },
      ),
    })),
    tasks: state.tasks.map((task) => ({
      ...task,
      dailyPlan: { ...task.dailyPlan },
      datedActuals: { ...task.datedActuals },
      dependencies: task.dependencies.map((dependency) => ({ ...dependency })),
    })),
  };
}

type JsonObject = { readonly [k: string]: JsonValue };

function expectObject(value: JsonValue, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid(label);
  return value as JsonObject;
}

function requiredKey(record: JsonObject, key: string, label: string): JsonValue {
  if (!Object.hasOwn(record, key)) throw invalid(`${label} missing ${key}`);
  const value = record[key];
  if (value === undefined) throw invalid(`${label} missing ${key}`);
  return value;
}

function sameKeySet(record: object, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort(compareCodeUnit);
  if (actual.length !== keys.length) return false;
  const expected = [...keys].sort(compareCodeUnit);
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== expected[index]) return false;
  }
  return true;
}

function expectExact(record: JsonObject, keys: readonly string[], label: string): void {
  if (!sameKeySet(record, keys)) throw invalid(`${label} keys`);
}

function expectString(value: JsonValue, label: string): string {
  if (typeof value !== "string") throw invalid(label);
  return value;
}

function expectNullableString(value: JsonValue, label: string): string | null {
  if (value === null) return null;
  return expectString(value, label);
}

function expectNumber(value: JsonValue, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalid(label);
  return value;
}

function expectNullableNumber(value: JsonValue, label: string): number | null {
  if (value === null) return null;
  return expectNumber(value, label);
}

function expectStringArray(value: JsonValue, label: string): string[] {
  if (!Array.isArray(value)) throw invalid(label);
  const next: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") throw invalid(label);
    next.push(entry);
  }
  return next;
}

function expectNumberArray(value: JsonValue, label: string): number[] {
  if (!Array.isArray(value)) throw invalid(label);
  const next: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) throw invalid(label);
    next.push(entry);
  }
  return next;
}

function expectNumberRecord(value: JsonValue, label: string): Record<string, number> {
  const record = expectObject(value, label);
  const next: Record<string, number> = {};
  for (const key of Object.keys(record)) {
    next[key] = expectNumber(requiredKey(record, key, label), label);
  }
  return next;
}

function expectDependencyType(value: JsonValue, label: string): DependencyType {
  if (typeof value !== "string" || !isDependencyType(value)) throw invalid(label);
  return value;
}

function jsonToSubtasks(value: JsonValue): SubtaskTemplateStep[] {
  if (!isJsonArray(value)) throw invalid("template subtasks");
  return value.map((entry, index) => {
    const label = `template subtask ${index}`;
    const record = expectObject(entry, label);
    const name = expectString(requiredKey(record, "name", label), label);
    const weightBp = expectNumber(requiredKey(record, "weightBp", label), label);
    if (!Object.hasOwn(record, "dependsOnPrev")) {
      expectExact(record, ["name", "weightBp"], label);
      return { name, weightBp };
    }
    expectExact(record, ["dependsOnPrev", "name", "weightBp"], label);
    const dependency = expectObject(requiredKey(record, "dependsOnPrev", label), label);
    expectExact(dependency, ["lagWorkingDays", "type"], label);
    return {
      name,
      weightBp,
      dependsOnPrev: {
        type: expectDependencyType(requiredKey(dependency, "type", label), label),
        lagWorkingDays: expectNumber(requiredKey(dependency, "lagWorkingDays", label), label),
      },
    };
  });
}

const TASK_ROW_KEYS = [
  "actualEffortMinutes",
  "actualFinish",
  "actualStart",
  "assigneeMemberId",
  "contract",
  "dailyPlan",
  "datedActuals",
  "id",
  "name",
  "note",
  "parentId",
  "plannedEffortMinutes",
  "processId",
  "productId",
  "progressBasisPoints",
  "prorationWeightBp",
  "seq",
  "sortOrder",
] as const;

function parseTaskRow(id: string, value: JsonValue): Omit<ProjectTask, "dependencies"> {
  const record = expectObject(value, `task:${id}`);
  expectExact(record, TASK_ROW_KEYS, `task:${id}`);
  const rowId = expectString(requiredKey(record, "id", `task:${id}`), `task:${id} id`);
  if (rowId !== id) throw invalid(`task:${id} id`);
  return {
    id,
    parentId: expectNullableString(requiredKey(record, "parentId", id), "parentId"),
    sortOrder: expectNumber(requiredKey(record, "sortOrder", id), "sortOrder"),
    seq: expectNumber(requiredKey(record, "seq", id), "seq"),
    name: expectString(requiredKey(record, "name", id), "name"),
    processId: expectNullableString(requiredKey(record, "processId", id), "processId"),
    productId: expectNullableString(requiredKey(record, "productId", id), "productId"),
    note: expectString(requiredKey(record, "note", id), "note"),
    contract: expectString(requiredKey(record, "contract", id), "contract"),
    assigneeMemberId: expectNullableString(requiredKey(record, "assigneeMemberId", id), "assigneeMemberId"),
    plannedEffortMinutes: expectNumber(requiredKey(record, "plannedEffortMinutes", id), "plannedEffortMinutes"),
    progressBasisPoints: expectNumber(requiredKey(record, "progressBasisPoints", id), "progressBasisPoints"),
    actualEffortMinutes: expectNumber(requiredKey(record, "actualEffortMinutes", id), "actualEffortMinutes"),
    prorationWeightBp: expectNullableNumber(requiredKey(record, "prorationWeightBp", id), "prorationWeightBp"),
    dailyPlan: expectNumberRecord(requiredKey(record, "dailyPlan", id), "dailyPlan"),
    datedActuals: expectNumberRecord(requiredKey(record, "datedActuals", id), "datedActuals"),
    actualStart: expectNullableString(requiredKey(record, "actualStart", id), "actualStart"),
    actualFinish: expectNullableString(requiredKey(record, "actualFinish", id), "actualFinish"),
  };
}

function parseDependencyRow(
  predecessorId: string,
  type: DependencyType,
  value: JsonValue,
): ProjectDependency {
  const record = expectObject(value, "dependency");
  expectExact(record, ["lagWorkingDays", "predecessorId", "type"], "dependency");
  const rowPredecessor = expectString(requiredKey(record, "predecessorId", "dependency"), "predecessorId");
  const rowType = expectDependencyType(requiredKey(record, "type", "dependency"), "type");
  if (rowPredecessor !== predecessorId || rowType !== type) throw invalid("dependency identity");
  return {
    predecessorId,
    type,
    lagWorkingDays: expectNumber(requiredKey(record, "lagWorkingDays", "dependency"), "lagWorkingDays"),
  };
}

function withoutNumberKey(record: Readonly<Record<string, number>>, key: string): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [entryKey, entry] of Object.entries(record)) {
    if (entryKey !== key) next[entryKey] = entry;
  }
  return next;
}

function applyTaskScalar(task: ProjectTask, field: TaskScalar, after: MaybeValue): ProjectTask {
  if (after === ABSENT) throw invalid(`task field ${field} cannot be removed`);
  switch (field) {
    case "parentId":
      return { ...task, parentId: expectNullableString(after, field) };
    case "sortOrder":
      return { ...task, sortOrder: expectNumber(after, field) };
    case "seq":
      return { ...task, seq: expectNumber(after, field) };
    case "name":
      return { ...task, name: expectString(after, field) };
    case "processId":
      return { ...task, processId: expectNullableString(after, field) };
    case "productId":
      return { ...task, productId: expectNullableString(after, field) };
    case "note":
      return { ...task, note: expectString(after, field) };
    case "contract":
      return { ...task, contract: expectString(after, field) };
    case "assigneeMemberId":
      return { ...task, assigneeMemberId: expectNullableString(after, field) };
    case "plannedEffortMinutes":
      return { ...task, plannedEffortMinutes: expectNumber(after, field) };
    case "progressBasisPoints":
      return { ...task, progressBasisPoints: expectNumber(after, field) };
    case "actualEffortMinutes":
      return { ...task, actualEffortMinutes: expectNumber(after, field) };
    case "prorationWeightBp":
      return { ...task, prorationWeightBp: expectNullableNumber(after, field) };
    case "actualStart":
      return { ...task, actualStart: expectNullableString(after, field) };
    case "actualFinish":
      return { ...task, actualFinish: expectNullableString(after, field) };
    default: {
      const unreachable: never = field;
      throw invalid(unreachable);
    }
  }
}

function isTaskScalar(field: string): field is TaskScalar {
  return (TASK_SCALARS as readonly string[]).includes(field);
}

function isWbsField(field: string): field is WbsField {
  return (WBS_FIELDS as readonly string[]).includes(field);
}

function applyWbsField(draft: Draft, field: string, after: MaybeValue): void {
  if (!isWbsField(field)) throw invalid(`unknown wbs field ${field}`);
  if (after === ABSENT) throw invalid(`wbs.${field} cannot be removed`);
  switch (field) {
    case "name":
      draft.name = expectString(after, field);
      return;
    case "projectStart":
      draft.projectStart = expectString(after, field);
      return;
    case "statusDate":
      draft.statusDate = expectString(after, field);
      return;
    case "defaultCalendarId":
      draft.defaultCalendarId = expectString(after, field);
      return;
    case "nextTaskSeq":
      draft.nextTaskSeq = expectNumber(after, field);
      return;
    case "nextBaselineVersion":
      draft.nextBaselineVersion = expectNumber(after, field);
      return;
    default: {
      const unreachable: never = field;
      throw invalid(unreachable);
    }
  }
}

function replaceTask(draft: Draft, id: string, task: ProjectTask): void {
  const index = draft.tasks.findIndex((entry) => entry.id === id);
  if (index < 0) {
    draft.tasks.push(task);
    return;
  }
  draft.tasks[index] = task;
}

function applyTaskField(draft: Draft, id: string, field: string, after: MaybeValue): void {
  const current = draft.tasks.find((task) => task.id === id);
  if (current === undefined) throw invalid(`missing task ${id}`);
  if (field.startsWith("dailyPlan.")) {
    const date = field.slice("dailyPlan.".length);
    if (date.length === 0) throw invalid("dailyPlan cell");
    const dailyPlan =
      after === ABSENT ? withoutNumberKey(current.dailyPlan, date) : { ...current.dailyPlan, [date]: expectNumber(after, field) };
    replaceTask(draft, id, { ...current, dailyPlan });
    return;
  }
  if (field.startsWith("datedActuals.")) {
    const key = field.slice("datedActuals.".length);
    if (key.length === 0) throw invalid("datedActuals cell");
    const datedActuals =
      after === ABSENT
        ? withoutNumberKey(current.datedActuals, key)
        : { ...current.datedActuals, [key]: expectNumber(after, field) };
    replaceTask(draft, id, { ...current, datedActuals });
    return;
  }
  if (!isTaskScalar(field)) throw invalid(`unknown task field ${field}`);
  replaceTask(draft, id, applyTaskScalar(current, field, after));
}

function applyTaskRow(draft: Draft, id: string, after: MaybeValue): void {
  if (after === ABSENT) {
    draft.tasks = draft.tasks.filter((task) => task.id !== id);
    return;
  }
  const parsed = parseTaskRow(id, after);
  const existing = draft.tasks.find((task) => task.id === id);
  replaceTask(draft, id, {
    ...parsed,
    dependencies: existing === undefined ? [] : existing.dependencies.map((dependency) => ({ ...dependency })),
  });
}

interface ParsedDependencyTarget {
  readonly successorId: string;
  readonly predecessorId: string;
  readonly type: DependencyType;
}

function parseDependencyTarget(target: string): ParsedDependencyTarget | undefined {
  const prefix = "dependency:";
  if (!target.startsWith(prefix)) return undefined;
  const body = target.slice(prefix.length);
  const arrow = body.indexOf("<-");
  if (arrow <= 0) return undefined;
  const successorId = body.slice(0, arrow);
  const rest = body.slice(arrow + 2);
  const colon = rest.lastIndexOf(":");
  if (colon <= 0) return undefined;
  const predecessorId = rest.slice(0, colon);
  const type = rest.slice(colon + 1);
  if (predecessorId.length === 0 || !isDependencyType(type)) return undefined;
  return { successorId, predecessorId, type };
}

function applyDependencyRow(draft: Draft, parsed: ParsedDependencyTarget, after: MaybeValue): void {
  const current = draft.tasks.find((task) => task.id === parsed.successorId);
  if (after === ABSENT) {
    if (current === undefined) return;
    replaceTask(draft, parsed.successorId, {
      ...current,
      dependencies: current.dependencies.filter(
        (dependency) => !(dependency.predecessorId === parsed.predecessorId && dependency.type === parsed.type),
      ),
    });
    return;
  }
  if (current === undefined) throw invalid(`missing task ${parsed.successorId}`);
  const row = parseDependencyRow(parsed.predecessorId, parsed.type, after);
  const kept = current.dependencies.filter(
    (dependency) => !(dependency.predecessorId === parsed.predecessorId && dependency.type === parsed.type),
  );
  replaceTask(draft, parsed.successorId, { ...current, dependencies: [...kept, row] });
}

function applyDependencyField(draft: Draft, parsed: ParsedDependencyTarget, field: string, after: MaybeValue): void {
  const current = draft.tasks.find((task) => task.id === parsed.successorId);
  if (current === undefined) throw invalid(`missing task ${parsed.successorId}`);
  const index = current.dependencies.findIndex(
    (dependency) => dependency.predecessorId === parsed.predecessorId && dependency.type === parsed.type,
  );
  if (index < 0) throw invalid(`missing dependency ${parsed.predecessorId}`);
  const dependency = current.dependencies[index];
  if (dependency === undefined) throw invalid(`missing dependency ${parsed.predecessorId}`);
  let next: ProjectDependency;
  if (field === "lagWorkingDays") {
    if (after === ABSENT) throw invalid("lagWorkingDays cannot be removed");
    next = { ...dependency, lagWorkingDays: expectNumber(after, field) };
  } else if (field === "type") {
    if (after === ABSENT) throw invalid("type cannot be removed");
    const type = expectDependencyType(after, field);
    if (type !== parsed.type) throw invalid("dependency type is part of its identity");
    next = { ...dependency, type };
  } else {
    throw invalid(`unknown dependency field ${field}`);
  }
  const dependencies = [...current.dependencies];
  dependencies[index] = next;
  replaceTask(draft, parsed.successorId, { ...current, dependencies });
}

function rowId(target: string, prefix: string): string {
  const id = target.slice(prefix.length);
  if (id.length === 0) throw invalid(`empty id in ${target}`);
  return id;
}

function applyMemberRow(draft: Draft, id: string, after: MaybeValue): void {
  if (after === ABSENT) {
    draft.members = draft.members.filter((member) => member.id !== id);
    return;
  }
  const record = expectObject(after, `member:${id}`);
  expectExact(record, ["calendarId", "costRateMinorPerHour", "dailyCapacityMinutes", "id", "name"], `member:${id}`);
  const rowIdValue = expectString(requiredKey(record, "id", `member:${id}`), "id");
  if (rowIdValue !== id) throw invalid(`member:${id} id`);
  const member: ProjectMember = {
    id,
    name: expectString(requiredKey(record, "name", id), "name"),
    calendarId: expectString(requiredKey(record, "calendarId", id), "calendarId"),
    dailyCapacityMinutes: expectNumber(requiredKey(record, "dailyCapacityMinutes", id), "dailyCapacityMinutes"),
    costRateMinorPerHour: expectNullableNumber(requiredKey(record, "costRateMinorPerHour", id), "costRateMinorPerHour"),
  };
  const index = draft.members.findIndex((entry) => entry.id === id);
  if (index < 0) draft.members.push(member);
  else draft.members[index] = member;
}

function applyMemberField(draft: Draft, id: string, field: string, after: MaybeValue): void {
  const index = draft.members.findIndex((member) => member.id === id);
  const current = index < 0 ? undefined : draft.members[index];
  if (current === undefined) throw invalid(`missing member ${id}`);
  if (after === ABSENT) throw invalid(`member field ${field} cannot be removed`);
  let next: ProjectMember;
  switch (field) {
    case "name":
      next = { ...current, name: expectString(after, field) };
      break;
    case "calendarId":
      next = { ...current, calendarId: expectString(after, field) };
      break;
    case "dailyCapacityMinutes":
      next = { ...current, dailyCapacityMinutes: expectNumber(after, field) };
      break;
    case "costRateMinorPerHour":
      next = { ...current, costRateMinorPerHour: expectNullableNumber(after, field) };
      break;
    default:
      throw invalid(`unknown member field ${field}`);
  }
  draft.members[index] = next;
}

function applyCalendarRow(draft: Draft, id: string, after: MaybeValue): void {
  if (after === ABSENT) {
    draft.calendars = draft.calendars.filter((calendar) => calendar.id !== id);
    return;
  }
  const record = expectObject(after, `calendar:${id}`);
  expectExact(record, ["id", "name", "nonWorkingDates", "workingWeekdays"], `calendar:${id}`);
  const rowIdValue = expectString(requiredKey(record, "id", `calendar:${id}`), "id");
  if (rowIdValue !== id) throw invalid(`calendar:${id} id`);
  const calendar: ProjectCalendar = {
    id,
    name: expectString(requiredKey(record, "name", id), "name"),
    workingWeekdays: expectNumberArray(requiredKey(record, "workingWeekdays", id), "workingWeekdays"),
    nonWorkingDates: expectStringArray(requiredKey(record, "nonWorkingDates", id), "nonWorkingDates"),
  };
  const index = draft.calendars.findIndex((entry) => entry.id === id);
  if (index < 0) draft.calendars.push(calendar);
  else draft.calendars[index] = calendar;
}

function applyCalendarField(draft: Draft, id: string, field: string, after: MaybeValue): void {
  const index = draft.calendars.findIndex((calendar) => calendar.id === id);
  const current = index < 0 ? undefined : draft.calendars[index];
  if (current === undefined) throw invalid(`missing calendar ${id}`);
  if (after === ABSENT) throw invalid(`calendar field ${field} cannot be removed`);
  let next: ProjectCalendar;
  switch (field) {
    case "name":
      next = { ...current, name: expectString(after, field) };
      break;
    case "workingWeekdays":
      next = { ...current, workingWeekdays: expectNumberArray(after, field) };
      break;
    case "nonWorkingDates":
      next = { ...current, nonWorkingDates: expectStringArray(after, field) };
      break;
    default:
      throw invalid(`unknown calendar field ${field}`);
  }
  draft.calendars[index] = next;
}

function applyNamedSortRow(
  collection: "processes" | "products",
  draft: Draft,
  id: string,
  after: MaybeValue,
): void {
  const items = draft[collection];
  if (after === ABSENT) {
    draft[collection] = items.filter((entry) => entry.id !== id);
    return;
  }
  const record = expectObject(after, `${collection}:${id}`);
  expectExact(record, ["id", "name", "sortOrder"], `${collection}:${id}`);
  const rowIdValue = expectString(requiredKey(record, "id", id), "id");
  if (rowIdValue !== id) throw invalid(`${collection}:${id} id`);
  const row = {
    id,
    name: expectString(requiredKey(record, "name", id), "name"),
    sortOrder: expectNumber(requiredKey(record, "sortOrder", id), "sortOrder"),
  };
  const index = items.findIndex((entry) => entry.id === id);
  if (index < 0) items.push(row);
  else items[index] = row;
}

function applyNamedSortField(
  collection: "processes" | "products",
  draft: Draft,
  id: string,
  field: string,
  after: MaybeValue,
): void {
  const items = draft[collection];
  const index = items.findIndex((entry) => entry.id === id);
  const current = index < 0 ? undefined : items[index];
  if (current === undefined) throw invalid(`missing ${collection} ${id}`);
  if (after === ABSENT) throw invalid(`${collection} field ${field} cannot be removed`);
  if (field === "name") items[index] = { ...current, name: expectString(after, field) };
  else if (field === "sortOrder") items[index] = { ...current, sortOrder: expectNumber(after, field) };
  else throw invalid(`unknown ${collection} field ${field}`);
}

function applyTemplateRow(draft: Draft, id: string, after: MaybeValue): void {
  if (after === ABSENT) {
    draft.templates = draft.templates.filter((template) => template.id !== id);
    return;
  }
  const record = expectObject(after, `template:${id}`);
  expectExact(record, ["id", "name", "sortOrder", "subtasks"], `template:${id}`);
  const rowIdValue = expectString(requiredKey(record, "id", id), "id");
  if (rowIdValue !== id) throw invalid(`template:${id} id`);
  const template: SubtaskTemplate = {
    id,
    name: expectString(requiredKey(record, "name", id), "name"),
    sortOrder: expectNumber(requiredKey(record, "sortOrder", id), "sortOrder"),
    subtasks: jsonToSubtasks(requiredKey(record, "subtasks", id)),
  };
  const index = draft.templates.findIndex((entry) => entry.id === id);
  if (index < 0) draft.templates.push(template);
  else draft.templates[index] = template;
}

function applyTemplateField(draft: Draft, id: string, field: string, after: MaybeValue): void {
  const index = draft.templates.findIndex((template) => template.id === id);
  const current = index < 0 ? undefined : draft.templates[index];
  if (current === undefined) throw invalid(`missing template ${id}`);
  if (after === ABSENT) throw invalid(`template field ${field} cannot be removed`);
  let next: SubtaskTemplate;
  switch (field) {
    case "name":
      next = { ...current, name: expectString(after, field) };
      break;
    case "sortOrder":
      next = { ...current, sortOrder: expectNumber(after, field) };
      break;
    case "subtasks":
      next = { ...current, subtasks: jsonToSubtasks(after) };
      break;
    default:
      throw invalid(`unknown template field ${field}`);
  }
  draft.templates[index] = next;
}

function applyEntry(draft: Draft, entry: FieldChange): void {
  const after = entrySide(entry.after);
  if (entry.target === "wbs") {
    applyWbsField(draft, entry.field, after);
    return;
  }
  const dependency = parseDependencyTarget(entry.target);
  if (dependency !== undefined) {
    if (entry.field === "") applyDependencyRow(draft, dependency, after);
    else applyDependencyField(draft, dependency, entry.field, after);
    return;
  }
  if (entry.target.startsWith("task:")) {
    const id = rowId(entry.target, "task:");
    if (entry.field === "") applyTaskRow(draft, id, after);
    else applyTaskField(draft, id, entry.field, after);
    return;
  }
  if (entry.target.startsWith("member:")) {
    const id = rowId(entry.target, "member:");
    if (entry.field === "") applyMemberRow(draft, id, after);
    else applyMemberField(draft, id, entry.field, after);
    return;
  }
  if (entry.target.startsWith("calendar:")) {
    const id = rowId(entry.target, "calendar:");
    if (entry.field === "") applyCalendarRow(draft, id, after);
    else applyCalendarField(draft, id, entry.field, after);
    return;
  }
  if (entry.target.startsWith("process:")) {
    const id = rowId(entry.target, "process:");
    if (entry.field === "") applyNamedSortRow("processes", draft, id, after);
    else applyNamedSortField("processes", draft, id, entry.field, after);
    return;
  }
  if (entry.target.startsWith("product:")) {
    const id = rowId(entry.target, "product:");
    if (entry.field === "") applyNamedSortRow("products", draft, id, after);
    else applyNamedSortField("products", draft, id, entry.field, after);
    return;
  }
  if (entry.target.startsWith("template:")) {
    const id = rowId(entry.target, "template:");
    if (entry.field === "") applyTemplateRow(draft, id, after);
    else applyTemplateField(draft, id, entry.field, after);
    return;
  }
  throw invalid(`unknown target ${entry.target}`);
}

function isDependencyTarget(target: string): boolean {
  return target.startsWith("dependency:");
}

export function applyWbsChange(state: ProjectState, change: WbsChange): ProjectState {
  if (change.format !== WBS_CHANGE_FORMAT) throw invalid("format");
  assertUnique(change.changes);
  const flat = flatten(state);
  for (const entry of change.changes) {
    if (!sameMaybe(valueAt(flat, entry.target, entry.field), entrySide(entry.before))) {
      throw new Error(`WBS change is stale for ${entry.target} field ${JSON.stringify(entry.field)}`);
    }
  }
  const draft = cloneState(state);
  const entries = change.changes;
  const isRowUpsert = (entry: FieldChange): boolean => entry.field === "" && entry.after !== undefined;
  const isRowDelete = (entry: FieldChange): boolean => entry.field === "" && entry.after === undefined;
  // Insert rows before edges that point at them, and delete edges before the
  // task row that owns them. Field updates sit in between so a whole-row
  // replace and a field write in the same record both land.
  for (const entry of entries) {
    if (!isDependencyTarget(entry.target) && isRowUpsert(entry)) applyEntry(draft, entry);
  }
  for (const entry of entries) {
    if (!isDependencyTarget(entry.target) && entry.field !== "") applyEntry(draft, entry);
  }
  for (const entry of entries) {
    if (isDependencyTarget(entry.target) && isRowUpsert(entry)) applyEntry(draft, entry);
  }
  for (const entry of entries) {
    if (isDependencyTarget(entry.target) && entry.field !== "") applyEntry(draft, entry);
  }
  for (const entry of entries) {
    if (isDependencyTarget(entry.target) && isRowDelete(entry)) applyEntry(draft, entry);
  }
  for (const entry of entries) {
    if (!isDependencyTarget(entry.target) && isRowDelete(entry)) applyEntry(draft, entry);
  }
  return draft;
}

/**
 * Each entry rewrites a stored record of that format into the next format.
 * Format 1 is current, so the table is empty. Format 2 is one new entry,
 * `1: (old) => ({ ...old, format: 2 })`. `readWbsChange` walks this until
 * `WBS_CHANGE_FORMAT`.
 */
const WBS_CHANGE_UPGRADERS: {
  readonly [format: number]: (old: Record<string, unknown>) => Record<string, unknown>;
} = {};

const CHANGE_KINDS: readonly ChangeKind[] = ["direct", "structural", "derived"];

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(label);
  if (!isPlainRecord(value)) throw invalid(label);
  return value as Record<string, unknown>;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (isUnknownArray(value)) return value.every((entry) => isJsonValue(entry));
  if (typeof value === "object") {
    if (!isPlainRecord(value)) return false;
    return Object.values(value as Record<string, unknown>).every((entry) => isJsonValue(entry));
  }
  return false;
}

function parseFormat1(record: Record<string, unknown>): WbsChange {
  if (!sameKeySet(record, ["changes", "format"])) throw invalid("format 1 keys");
  const changesValue = record.changes;
  if (!Array.isArray(changesValue)) throw invalid("changes");
  const changes: FieldChange[] = changesValue.map((entry, index) => {
    const label = `changes[${index}]`;
    const change = expectRecord(entry, label);
    const keys = Object.keys(change);
    for (const key of keys) {
      if (key !== "target" && key !== "field" && key !== "before" && key !== "after" && key !== "kind") {
        throw invalid(`${label} keys`);
      }
    }
    if (typeof change.target !== "string" || change.target.length === 0 || change.target.includes("\0")) {
      throw invalid(`${label} target`);
    }
    if (typeof change.field !== "string" || change.field.includes("\0")) throw invalid(`${label} field`);
    if (typeof change.kind !== "string" || !(CHANGE_KINDS as readonly string[]).includes(change.kind)) {
      throw invalid(`${label} kind`);
    }
    const parsed: {
      target: string;
      field: string;
      kind: ChangeKind;
      before?: JsonValue;
      after?: JsonValue;
    } = { target: change.target, field: change.field, kind: change.kind as ChangeKind };
    if (Object.hasOwn(change, "before")) {
      if (!isJsonValue(change.before)) throw invalid(`${label} before`);
      parsed.before = change.before;
    }
    if (Object.hasOwn(change, "after")) {
      if (!isJsonValue(change.after)) throw invalid(`${label} after`);
      parsed.after = change.after;
    }
    return parsed;
  });
  assertUnique(changes);
  return { format: 1, changes };
}

export function readWbsChange(stored: unknown): WbsChange {
  let current = expectRecord(stored, "record");
  if (typeof current.format !== "number" || !Number.isSafeInteger(current.format) || current.format < 1) {
    throw invalid("format");
  }
  let format = current.format;
  const seen = new Set<number>();
  while (format < WBS_CHANGE_FORMAT) {
    if (seen.has(format)) throw invalid("upgrade cycle");
    seen.add(format);
    const upgrade = WBS_CHANGE_UPGRADERS[format];
    if (upgrade === undefined) throw invalid(`no upgrade from format ${format}`);
    const upgraded = upgrade(current);
    current = expectRecord(upgraded, "upgraded record");
    if (typeof current.format !== "number" || !Number.isSafeInteger(current.format) || current.format < 1) {
      throw invalid("format");
    }
    format = current.format;
  }
  if (format !== WBS_CHANGE_FORMAT) throw invalid(`unsupported format ${format}`);
  return parseFormat1(current);
}
