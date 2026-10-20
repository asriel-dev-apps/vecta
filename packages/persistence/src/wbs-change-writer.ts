import {
  changeTarget,
  decodeWbsChange,
  WbsChangeCorruptError,
  type DecodedEntry,
  type DependencyType,
  type ProjectCalendar,
  type ProjectMember,
  type ProjectTask,
  type SubtaskTemplate,
  type SubtaskTemplateStep,
  type TaskScalar,
  type WbsChange,
  type WbsField,
} from "@vecta/application";
import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  calendar,
  member,
  process,
  product,
  schema,
  subtaskTemplate,
  task,
  taskDependency,
  wbs,
} from "./schema.js";

type CommandTransaction = Parameters<
  Parameters<NodePgDatabase<typeof schema>["transaction"]>[0]
>[0];

/** The WBS row this operation publishes: tenant, id, and the revision it moves. */
export interface WbsIdentity {
  readonly tenantId: string;
  readonly wbsId: string;
  /** Revision currently stored. The `wbs` UPDATE matches it. */
  readonly revision: bigint;
  /** Revision this operation writes, together with the record's wbs fields. */
  readonly nextRevision: bigint;
}

type TaskRow = Omit<ProjectTask, "dependencies">;
type NamedRow = { readonly id: string; readonly name: string; readonly sortOrder: number };

interface MasterBucket<T> {
  inserts: T[];
  replaces: T[];
  patches: Map<string, Record<string, unknown>>;
  deletes: string[];
}

interface TaskColumns {
  parentTaskId?: string | null;
  sortOrder?: number;
  seq?: number;
  name?: string;
  processId?: string | null;
  productId?: string | null;
  note?: string;
  contract?: string;
  assigneeMemberId?: string | null;
  plannedEffortMinutes?: number;
  progressBasisPoints?: number;
  actualEffortMinutes?: number;
  prorationWeightBp?: number | null;
  actualStart?: string | null;
  actualFinish?: string | null;
}

interface TaskFields {
  columns: TaskColumns;
  dailySets: Map<string, number>;
  dailyRemovals: string[];
  actualSets: Map<string, number>;
  actualRemovals: string[];
}

interface EdgeWrite {
  successorId: string;
  predecessorId: string;
  type: DependencyType;
  action: "insert" | "update" | "delete";
  lag: number;
}

interface WbsColumns {
  name?: string;
  projectStart?: string;
  statusDate?: string;
  defaultCalendarId?: string;
  nextTaskSeq?: number;
  nextBaselineVersion?: number;
}

interface WritePlan {
  calendar: MasterBucket<ProjectCalendar>;
  member: MasterBucket<ProjectMember>;
  process: MasterBucket<NamedRow>;
  product: MasterBucket<NamedRow>;
  template: MasterBucket<SubtaskTemplate>;
  taskInserts: TaskRow[];
  taskReplaces: TaskRow[];
  taskDeletes: string[];
  taskFields: Map<string, TaskFields>;
  edges: Map<string, EdgeWrite>;
  wbs: WbsColumns;
}

const MASTER_TABLES = {
  calendar,
  member,
  process,
  product,
  template: subtaskTemplate,
} as const;

type MasterKind = keyof typeof MASTER_TABLES;

const INSERT_ORDER: readonly MasterKind[] = ["calendar", "member", "process", "product", "template"];
const DELETE_ORDER: readonly MasterKind[] = ["member", "calendar", "process", "product", "template"];

function bucket<T>(): MasterBucket<T> {
  return { inserts: [], replaces: [], patches: new Map(), deletes: [] };
}

function taskFieldsFor(plan: WritePlan, id: string): TaskFields {
  const existing = plan.taskFields.get(id);
  if (existing !== undefined) return existing;
  const created: TaskFields = {
    columns: {},
    dailySets: new Map(),
    dailyRemovals: [],
    actualSets: new Map(),
    actualRemovals: [],
  };
  plan.taskFields.set(id, created);
  return created;
}

function edgeKey(edge: { successorId: string; predecessorId: string; type: string }): string {
  return `${edge.successorId}\0${edge.predecessorId}\0${edge.type}`;
}

function stringValue(value: string | number | null, field: string): string {
  if (typeof value === "string") return value;
  throw new WbsChangeCorruptError(field);
}

function stringOrNull(value: string | number | null, field: string): string | null {
  if (value === null || typeof value === "string") return value;
  throw new WbsChangeCorruptError(field);
}

function numberValue(value: string | number | null, field: string): number {
  if (typeof value === "number") return value;
  throw new WbsChangeCorruptError(field);
}

function numberOrNull(value: string | number | null, field: string): number | null {
  if (value === null || typeof value === "number") return value;
  throw new WbsChangeCorruptError(field);
}

function putTaskScalar(columns: TaskColumns, field: TaskScalar, value: string | number | null): void {
  switch (field) {
    case "parentId":
      columns.parentTaskId = stringOrNull(value, field);
      return;
    case "sortOrder":
      columns.sortOrder = numberValue(value, field);
      return;
    case "seq":
      columns.seq = numberValue(value, field);
      return;
    case "name":
      columns.name = stringValue(value, field);
      return;
    case "processId":
      columns.processId = stringOrNull(value, field);
      return;
    case "productId":
      columns.productId = stringOrNull(value, field);
      return;
    case "note":
      columns.note = stringValue(value, field);
      return;
    case "contract":
      columns.contract = stringValue(value, field);
      return;
    case "assigneeMemberId":
      columns.assigneeMemberId = stringOrNull(value, field);
      return;
    case "plannedEffortMinutes":
      columns.plannedEffortMinutes = numberValue(value, field);
      return;
    case "progressBasisPoints":
      columns.progressBasisPoints = numberValue(value, field);
      return;
    case "actualEffortMinutes":
      columns.actualEffortMinutes = numberValue(value, field);
      return;
    case "prorationWeightBp":
      columns.prorationWeightBp = numberOrNull(value, field);
      return;
    case "actualStart":
      columns.actualStart = stringOrNull(value, field);
      return;
    case "actualFinish":
      columns.actualFinish = stringOrNull(value, field);
      return;
    default: {
      const unreachable: never = field;
      throw new WbsChangeCorruptError(unreachable);
    }
  }
}

function putWbs(columns: WbsColumns, field: WbsField, value: string | number): void {
  switch (field) {
    case "name":
      columns.name = stringValue(value, field);
      return;
    case "projectStart":
      columns.projectStart = stringValue(value, field);
      return;
    case "statusDate":
      columns.statusDate = stringValue(value, field);
      return;
    case "defaultCalendarId":
      columns.defaultCalendarId = stringValue(value, field);
      return;
    case "nextTaskSeq":
      columns.nextTaskSeq = numberValue(value, field);
      return;
    case "nextBaselineVersion":
      columns.nextBaselineVersion = numberValue(value, field);
      return;
    default: {
      const unreachable: never = field;
      throw new WbsChangeCorruptError(unreachable);
    }
  }
}

function rememberCell(sets: Map<string, number>, removals: string[], key: string, value: number | null): void {
  if (value === null) {
    sets.delete(key);
    if (!removals.includes(key)) removals.push(key);
    return;
  }
  const index = removals.indexOf(key);
  if (index >= 0) removals.splice(index, 1);
  sets.set(key, value);
}

function compile(decoded: readonly DecodedEntry[]): WritePlan {
  const plan: WritePlan = {
    calendar: bucket(),
    member: bucket(),
    process: bucket(),
    product: bucket(),
    template: bucket(),
    taskInserts: [],
    taskReplaces: [],
    taskDeletes: [],
    taskFields: new Map(),
    edges: new Map(),
    wbs: {},
  };
  const dependencyRows: Extract<DecodedEntry, { kind: "dependency-row" }>[] = [];
  const dependencyLags: Extract<DecodedEntry, { kind: "dependency-lag" }>[] = [];

  for (const entry of decoded) {
    switch (entry.kind) {
      case "wbs":
        putWbs(plan.wbs, entry.field, entry.value);
        break;
      case "task-row":
        if (entry.row === null) plan.taskDeletes.push(entry.id);
        else if (entry.existed) plan.taskReplaces.push(entry.row);
        else plan.taskInserts.push(entry.row);
        break;
      case "task-scalar":
        putTaskScalar(taskFieldsFor(plan, entry.id).columns, entry.field, entry.value);
        break;
      case "task-cell": {
        const fields = taskFieldsFor(plan, entry.id);
        if (entry.map === "dailyPlan") rememberCell(fields.dailySets, fields.dailyRemovals, entry.key, entry.value);
        else rememberCell(fields.actualSets, fields.actualRemovals, entry.key, entry.value);
        break;
      }
      case "dependency-row":
        dependencyRows.push(entry);
        break;
      case "dependency-lag":
        dependencyLags.push(entry);
        break;
      case "dependency-type":
        break;
      case "member-row":
        takeMasterRow(plan.member, entry.id, entry.existed, entry.row);
        break;
      case "member-field":
        takePatch(plan.member.patches, entry.id, entry.field, entry.value);
        break;
      case "calendar-row":
        takeMasterRow(plan.calendar, entry.id, entry.existed, entry.row);
        break;
      case "calendar-field":
        takePatch(plan.calendar.patches, entry.id, entry.field, entry.value);
        break;
      case "named-row":
        takeMasterRow(plan[entry.master], entry.id, entry.existed, entry.row);
        break;
      case "named-field":
        takePatch(plan[entry.master].patches, entry.id, entry.field, entry.value);
        break;
      case "template-row":
        takeMasterRow(plan.template, entry.id, entry.existed, entry.row);
        break;
      case "template-field":
        takePatch(plan.template.patches, entry.id, entry.field, entry.value);
        break;
      default: {
        const unreachable: never = entry;
        throw new WbsChangeCorruptError(`unmapped change ${JSON.stringify(unreachable)}`);
      }
    }
  }

  // Row upserts, then field updates, then deletes — the same phases as replay.
  // A whole-row entry that still has a before is an update, not an insert.
  for (const entry of dependencyRows) {
    const key = edgeKey(entry);
    if (entry.lagWorkingDays === null) {
      plan.edges.set(key, { ...entry, action: "delete", lag: 0 });
    } else if (entry.existed) {
      plan.edges.set(key, { ...entry, action: "update", lag: entry.lagWorkingDays });
    } else {
      plan.edges.set(key, { ...entry, action: "insert", lag: entry.lagWorkingDays });
    }
  }
  for (const entry of dependencyLags) {
    const key = edgeKey(entry);
    const existing = plan.edges.get(key);
    if (existing === undefined) {
      plan.edges.set(key, { ...entry, action: "update", lag: entry.lagWorkingDays });
    } else if (existing.action !== "delete") {
      existing.lag = entry.lagWorkingDays;
    }
  }
  return plan;
}

function takeMasterRow<T extends { readonly id: string }>(
  bucket: MasterBucket<T>,
  id: string,
  existed: boolean,
  row: T | null,
): void {
  if (row === null) bucket.deletes.push(id);
  else if (existed) bucket.replaces.push(row);
  else bucket.inserts.push(row);
}

function takePatch(patches: Map<string, Record<string, unknown>>, id: string, field: string, value: unknown): void {
  const patch = patches.get(id) ?? {};
  patch[field] = value;
  patches.set(id, patch);
}

function jsonbPatch(column: SQL, sets: ReadonlyMap<string, number>, removals: readonly string[]): SQL {
  let expr = column;
  for (const key of removals) expr = sql`(${expr} - ${key})`;
  if (sets.size > 0) {
    const object: Record<string, number> = {};
    for (const [key, value] of sets) object[key] = value;
    expr = sql`(${expr} || ${JSON.stringify(object)}::jsonb)`;
  }
  return expr;
}

function taskScope(identity: WbsIdentity, id: string) {
  return and(eq(task.tenantId, identity.tenantId), eq(task.wbsId, identity.wbsId), eq(task.id, id));
}

function taskValues(row: TaskRow, parentTaskId: string | null) {
  return {
    parentTaskId,
    sortOrder: row.sortOrder,
    seq: row.seq,
    name: row.name,
    processId: row.processId,
    productId: row.productId,
    note: row.note,
    contract: row.contract,
    assigneeMemberId: row.assigneeMemberId,
    plannedEffortMinutes: row.plannedEffortMinutes,
    progressBasisPoints: row.progressBasisPoints,
    actualEffortMinutes: row.actualEffortMinutes,
    prorationWeightBp: row.prorationWeightBp,
    dailyPlan: row.dailyPlan,
    datedActuals: row.datedActuals,
    actualStart: row.actualStart,
    actualFinish: row.actualFinish,
  };
}

/**
 * Write one change record. Decoding runs to completion before the first statement,
 * so an entry this writer cannot map leaves the transaction untouched by it.
 */
export async function writeWbsChange(
  transaction: CommandTransaction,
  identity: WbsIdentity,
  change: WbsChange,
): Promise<void> {
  for (const entry of change.changes) changeTarget(entry.target);
  const plan = compile(decodeWbsChange(change));
  await execute(transaction, identity, plan);
}

async function execute(transaction: CommandTransaction, identity: WbsIdentity, plan: WritePlan): Promise<void> {
  for (const kind of INSERT_ORDER) {
    await writeMasterRows(transaction, identity, kind, plan);
  }
  await insertTasks(transaction, identity, plan.taskInserts);
  await assignNewParents(transaction, identity, plan.taskInserts);
  for (const row of plan.taskReplaces) {
    await transaction
      .update(task)
      .set({ ...taskValues(row, row.parentId), updatedAt: sql`now()` })
      .where(taskScope(identity, row.id));
  }
  for (const kind of INSERT_ORDER) {
    await patchMasters(transaction, identity, kind, plan);
  }
  for (const [id, fields] of plan.taskFields) {
    await updateTaskFields(transaction, identity, id, fields);
  }
  await writeEdges(transaction, identity, [...plan.edges.values()]);
  if (plan.taskDeletes.length > 0) {
    await transaction
      .delete(task)
      .where(
        and(eq(task.tenantId, identity.tenantId), eq(task.wbsId, identity.wbsId), inArray(task.id, plan.taskDeletes)),
      );
  }
  for (const kind of DELETE_ORDER) {
    await deleteMaster(transaction, identity, kind, masterBucket(plan, kind).deletes);
  }
  await transaction
    .update(wbs)
    .set({ ...plan.wbs, revision: identity.nextRevision, updatedAt: sql`now()` })
    .where(and(eq(wbs.tenantId, identity.tenantId), eq(wbs.id, identity.wbsId), eq(wbs.revision, identity.revision)));
}

function masterBucket(plan: WritePlan, kind: MasterKind): MasterBucket<{ readonly id: string }> {
  return plan[kind];
}

async function writeMasterRows(
  transaction: CommandTransaction,
  identity: WbsIdentity,
  kind: MasterKind,
  plan: WritePlan,
): Promise<void> {
  const rows = masterBucket(plan, kind);
  for (const row of rows.inserts) await insertMaster(transaction, identity, kind, row);
  for (const row of rows.replaces) await replaceMaster(transaction, identity, kind, row);
}

async function insertMaster(
  transaction: CommandTransaction,
  identity: WbsIdentity,
  kind: MasterKind,
  row: { readonly id: string },
): Promise<void> {
  switch (kind) {
    case "calendar": {
      const calendarRow = row as ProjectCalendar;
      await transaction.insert(calendar).values({
        tenantId: identity.tenantId,
        wbsId: identity.wbsId,
        id: calendarRow.id,
        name: calendarRow.name,
        workingWeekdays: [...calendarRow.workingWeekdays],
        nonWorkingDates: [...calendarRow.nonWorkingDates],
      });
      return;
    }
    case "member": {
      const memberRow = row as ProjectMember;
      await transaction.insert(member).values({
        id: memberRow.id,
        tenantId: identity.tenantId,
        wbsId: identity.wbsId,
        name: memberRow.name,
        calendarId: memberRow.calendarId,
        dailyCapacityMinutes: memberRow.dailyCapacityMinutes,
        costRateMinorPerHour: memberRow.costRateMinorPerHour,
      });
      return;
    }
    case "process":
    case "product": {
      const table = MASTER_TABLES[kind];
      const named = row as NamedRow;
      await transaction.insert(table).values({
        id: named.id,
        tenantId: identity.tenantId,
        wbsId: identity.wbsId,
        name: named.name,
        sortOrder: named.sortOrder,
      });
      return;
    }
    case "template": {
      const templateRow = row as SubtaskTemplate;
      await transaction.insert(subtaskTemplate).values({
        id: templateRow.id,
        tenantId: identity.tenantId,
        wbsId: identity.wbsId,
        name: templateRow.name,
        sortOrder: templateRow.sortOrder,
        subtasks: templateSubtasks(templateRow.subtasks),
      });
      return;
    }
    default: {
      const unreachable: never = kind;
      throw new WbsChangeCorruptError(unreachable);
    }
  }
}

async function replaceMaster(
  transaction: CommandTransaction,
  identity: WbsIdentity,
  kind: MasterKind,
  row: { readonly id: string },
): Promise<void> {
  const where = masterWhere(kind, identity, row.id);
  switch (kind) {
    case "calendar": {
      const calendarRow = row as ProjectCalendar;
      await transaction
        .update(calendar)
        .set({
          name: calendarRow.name,
          workingWeekdays: [...calendarRow.workingWeekdays],
          nonWorkingDates: [...calendarRow.nonWorkingDates],
          updatedAt: sql`now()`,
        })
        .where(where);
      return;
    }
    case "member": {
      const memberRow = row as ProjectMember;
      await transaction
        .update(member)
        .set({
          name: memberRow.name,
          calendarId: memberRow.calendarId,
          dailyCapacityMinutes: memberRow.dailyCapacityMinutes,
          costRateMinorPerHour: memberRow.costRateMinorPerHour,
          updatedAt: sql`now()`,
        })
        .where(where);
      return;
    }
    case "process":
    case "product": {
      const table = MASTER_TABLES[kind];
      const named = row as NamedRow;
      await transaction
        .update(table)
        .set({ name: named.name, sortOrder: named.sortOrder, updatedAt: sql`now()` })
        .where(where);
      return;
    }
    case "template": {
      const templateRow = row as SubtaskTemplate;
      await transaction
        .update(subtaskTemplate)
        .set({
          name: templateRow.name,
          sortOrder: templateRow.sortOrder,
          subtasks: templateSubtasks(templateRow.subtasks),
          updatedAt: sql`now()`,
        })
        .where(where);
      return;
    }
    default: {
      const unreachable: never = kind;
      throw new WbsChangeCorruptError(unreachable);
    }
  }
}

function templateSubtasks(steps: readonly SubtaskTemplateStep[]): SubtaskTemplateStep[] {
  return steps.map((step) =>
    step.dependsOnPrev === undefined
      ? { name: step.name, weightBp: step.weightBp }
      : { name: step.name, weightBp: step.weightBp, dependsOnPrev: { ...step.dependsOnPrev } },
  );
}

async function patchMasters(
  transaction: CommandTransaction,
  identity: WbsIdentity,
  kind: MasterKind,
  plan: WritePlan,
): Promise<void> {
  const table = MASTER_TABLES[kind];
  for (const [id, patch] of masterBucket(plan, kind).patches) {
    if (Object.keys(patch).length === 0) continue;
    await transaction
      .update(table)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(masterWhere(kind, identity, id));
  }
}

function masterWhere(kind: MasterKind, identity: WbsIdentity, id: string) {
  const table = MASTER_TABLES[kind];
  return and(eq(table.tenantId, identity.tenantId), eq(table.wbsId, identity.wbsId), eq(table.id, id));
}

async function deleteMaster(
  transaction: CommandTransaction,
  identity: WbsIdentity,
  kind: MasterKind,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const table = MASTER_TABLES[kind];
  await transaction
    .delete(table)
    .where(and(eq(table.tenantId, identity.tenantId), eq(table.wbsId, identity.wbsId), inArray(table.id, [...ids])));
}

async function insertTasks(transaction: CommandTransaction, identity: WbsIdentity, rows: readonly TaskRow[]): Promise<void> {
  if (rows.length === 0) return;
  await transaction.insert(task).values(
    rows.map((row) => ({
      id: row.id,
      tenantId: identity.tenantId,
      wbsId: identity.wbsId,
      ...taskValues(row, null),
    })),
  );
}

async function assignNewParents(
  transaction: CommandTransaction,
  identity: WbsIdentity,
  rows: readonly TaskRow[],
): Promise<void> {
  const parents = rows.filter((row) => row.parentId !== null);
  if (parents.length === 0) return;
  const pairs = sql.join(
    parents.map((row) => sql`(${row.id}::uuid, ${row.parentId}::uuid)`),
    sql`, `,
  );
  await transaction.execute(sql`
    update ${task} set parent_task_id = v.parent_task_id
    from (values ${pairs}) as v(id, parent_task_id)
    where ${task.tenantId} = ${identity.tenantId}
      and ${task.wbsId} = ${identity.wbsId}
      and ${task.id} = v.id
  `);
}

async function updateTaskFields(
  transaction: CommandTransaction,
  identity: WbsIdentity,
  id: string,
  fields: TaskFields,
): Promise<void> {
  const set: TaskColumns & { dailyPlan?: SQL; datedActuals?: SQL; updatedAt?: SQL } = { ...fields.columns };
  if (fields.dailySets.size > 0 || fields.dailyRemovals.length > 0) {
    set.dailyPlan = jsonbPatch(sql`${task.dailyPlan}`, fields.dailySets, fields.dailyRemovals);
  }
  if (fields.actualSets.size > 0 || fields.actualRemovals.length > 0) {
    set.datedActuals = jsonbPatch(sql`${task.datedActuals}`, fields.actualSets, fields.actualRemovals);
  }
  if (Object.keys(set).length === 0) return;
  await transaction
    .update(task)
    .set({ ...set, updatedAt: sql`now()` })
    .where(taskScope(identity, id));
}

async function writeEdges(
  transaction: CommandTransaction,
  identity: WbsIdentity,
  edges: readonly EdgeWrite[],
): Promise<void> {
  const inserts = edges.filter((edge) => edge.action === "insert");
  const updates = edges.filter((edge) => edge.action === "update");
  const deletes = edges.filter((edge) => edge.action === "delete");
  if (inserts.length > 0) {
    await transaction.insert(taskDependency).values(
      inserts.map((edge) => ({
        tenantId: identity.tenantId,
        wbsId: identity.wbsId,
        predecessorTaskId: edge.predecessorId,
        successorTaskId: edge.successorId,
        type: edge.type,
        lagWorkingDays: edge.lag,
      })),
    );
  }
  for (const edge of updates) {
    await transaction
      .update(taskDependency)
      .set({ lagWorkingDays: edge.lag })
      .where(edgeWhere(identity, edge));
  }
  if (deletes.length > 0) {
    await transaction.delete(taskDependency).where(or(...deletes.map((edge) => edgeWhere(identity, edge))));
  }
}

function edgeWhere(identity: WbsIdentity, edge: EdgeWrite) {
  return and(
    eq(taskDependency.tenantId, identity.tenantId),
    eq(taskDependency.wbsId, identity.wbsId),
    eq(taskDependency.successorTaskId, edge.successorId),
    eq(taskDependency.predecessorTaskId, edge.predecessorId),
    eq(taskDependency.type, edge.type),
  );
}
