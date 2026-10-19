import { createHash } from "node:crypto";
import {
  canonicalJson,
  diffOperation,
  IdempotencyConflictError,
  leafTaskIds,
  ProjectCommandValidationError,
  ProjectNotFoundError,
  ProjectVersionConflictError,
  type FieldChange,
  type JsonValue,
  type ProjectCommandExecution,
  type ProjectCommandRequest,
  type ProjectCommandUnitOfWork,
  type ProjectState,
  type SubtaskTemplateStep,
  type WbsChange,
} from "@vecta/application";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  auditEvent,
  baselineTask,
  baseline,
  commandReceipt,
  member,
  process,
  product,
  calendar,
  wbs,
  schema,
  subtaskTemplate,
  taskDependency,
  task,
  wbsChange,
} from "./schema.js";

type CommandTransaction = Parameters<
  Parameters<NodePgDatabase<typeof schema>["transaction"]>[0]
>[0];

const DEPENDENCY_TYPES = ["FF", "FS", "SF", "SS"] as const;
type DependencyTypeName = (typeof DEPENDENCY_TYPES)[number];

interface DependencyIdentity {
  readonly successorId: string;
  readonly predecessorId: string;
  readonly type: DependencyTypeName;
}

interface TaskWrite {
  insert?: { readonly [key: string]: JsonValue };
  remove: boolean;
  readonly columns: Map<string, JsonValue>;
  writeDailyPlan: boolean;
  writeDatedActuals: boolean;
}

interface MasterWrite {
  insert?: { readonly [key: string]: JsonValue };
  remove: boolean;
  readonly patch: Map<string, JsonValue>;
}

type MasterKind = "calendar" | "member" | "process" | "product" | "template";

function operationFingerprint(request: ProjectCommandRequest): string {
  return createHash("sha256")
    .update(canonicalJson({ actor: request.actor, commands: request.commands }))
    .digest("hex");
}

function fieldChanged(change: FieldChange): boolean {
  const beforePresent = Object.hasOwn(change, "before");
  const afterPresent = Object.hasOwn(change, "after");
  if (beforePresent !== afterPresent) return true;
  if (!beforePresent) return false;
  return canonicalJson(change.before) !== canonicalJson(change.after);
}

function asObject(value: JsonValue, label: string): { readonly [key: string]: JsonValue } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`WBS change ${label} is not an object`);
  }
  return value as { readonly [key: string]: JsonValue };
}

function expectString(value: JsonValue, label: string): string {
  if (typeof value !== "string") throw new Error(`WBS change ${label} is not a string`);
  return value;
}

function expectNullableString(value: JsonValue, label: string): string | null {
  if (value === null) return null;
  return expectString(value, label);
}

function expectNumber(value: JsonValue, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`WBS change ${label} is not a number`);
  }
  return value;
}

function expectNullableNumber(value: JsonValue, label: string): number | null {
  if (value === null) return null;
  return expectNumber(value, label);
}

function expectStringArray(value: JsonValue, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`WBS change ${label} is not an array`);
  return (value as readonly JsonValue[]).map((entry) => expectString(entry, label));
}

function expectNumberArray(value: JsonValue, label: string): number[] {
  if (!Array.isArray(value)) throw new Error(`WBS change ${label} is not an array`);
  return (value as readonly JsonValue[]).map((entry) => expectNumber(entry, label));
}

function expectNumberRecord(value: JsonValue, label: string): Record<string, number> {
  const record = asObject(value, label);
  const next: Record<string, number> = {};
  for (const key of Object.keys(record)) {
    const entry = record[key];
    if (entry === undefined) continue;
    next[key] = expectNumber(entry, label);
  }
  return next;
}

function required(record: { readonly [key: string]: JsonValue }, key: string, label: string): JsonValue {
  if (!Object.hasOwn(record, key)) throw new Error(`WBS change ${label} missing ${key}`);
  const value = record[key];
  if (value === undefined) throw new Error(`WBS change ${label} missing ${key}`);
  return value;
}

function isDependencyType(value: string): value is DependencyTypeName {
  return (DEPENDENCY_TYPES as readonly string[]).includes(value);
}

function parseDependencyTarget(target: string): DependencyIdentity | undefined {
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

function prefixedId(target: string, prefix: string): string | undefined {
  if (!target.startsWith(prefix)) return undefined;
  const id = target.slice(prefix.length);
  return id.length === 0 ? undefined : id;
}

function taskWriteFor(writes: Map<string, TaskWrite>, id: string): TaskWrite {
  const existing = writes.get(id);
  if (existing !== undefined) return existing;
  const created: TaskWrite = { remove: false, columns: new Map(), writeDailyPlan: false, writeDatedActuals: false };
  writes.set(id, created);
  return created;
}

function masterWriteFor(writes: Map<string, MasterWrite>, id: string): MasterWrite {
  const existing = writes.get(id);
  if (existing !== undefined) return existing;
  const created: MasterWrite = { remove: false, patch: new Map() };
  writes.set(id, created);
  return created;
}

function absorbMaster(writes: Map<string, MasterWrite>, id: string, change: FieldChange): void {
  const row = masterWriteFor(writes, id);
  if (change.field === "") {
    if (change.after === undefined) row.remove = true;
    else row.insert = asObject(change.after, change.target);
    return;
  }
  if (!fieldChanged(change) || !Object.hasOwn(change, "after") || change.after === undefined) return;
  row.patch.set(change.field, change.after);
}

interface GroupedChanges {
  readonly wbsFields: ReadonlyMap<string, JsonValue>;
  readonly tasks: ReadonlyMap<string, TaskWrite>;
  readonly masters: { readonly [kind in MasterKind]: ReadonlyMap<string, MasterWrite> };
  readonly dependencyDeletes: readonly DependencyIdentity[];
  readonly dependencyInserts: readonly (DependencyIdentity & { readonly lagWorkingDays: number })[];
  readonly dependencyUpdates: readonly (DependencyIdentity & { readonly lagWorkingDays: number })[];
}

function groupChanges(change: WbsChange): GroupedChanges {
  const wbsFields = new Map<string, JsonValue>();
  const tasks = new Map<string, TaskWrite>();
  const masters = {
    calendar: new Map<string, MasterWrite>(),
    member: new Map<string, MasterWrite>(),
    process: new Map<string, MasterWrite>(),
    product: new Map<string, MasterWrite>(),
    template: new Map<string, MasterWrite>(),
  };
  const dependencyDeletes: DependencyIdentity[] = [];
  const dependencyInserts: (DependencyIdentity & { lagWorkingDays: number })[] = [];
  const dependencyUpdates: (DependencyIdentity & { lagWorkingDays: number })[] = [];

  for (const entry of change.changes) {
    if (entry.target === "wbs") {
      if (fieldChanged(entry) && entry.after !== undefined) wbsFields.set(entry.field, entry.after);
      continue;
    }
    const dependency = parseDependencyTarget(entry.target);
    if (dependency !== undefined) {
      if (entry.field === "") {
        if (entry.after === undefined) dependencyDeletes.push(dependency);
        else {
          const row = asObject(entry.after, entry.target);
          dependencyInserts.push({
            ...dependency,
            lagWorkingDays: expectNumber(required(row, "lagWorkingDays", entry.target), "lagWorkingDays"),
          });
        }
        continue;
      }
      if (entry.field === "lagWorkingDays" && fieldChanged(entry) && entry.after !== undefined) {
        dependencyUpdates.push({
          ...dependency,
          lagWorkingDays: expectNumber(entry.after, "lagWorkingDays"),
        });
      }
      continue;
    }
    const taskId = prefixedId(entry.target, "task:");
    if (taskId !== undefined) {
      const row = taskWriteFor(tasks, taskId);
      if (entry.field === "") {
        if (entry.after === undefined) row.remove = true;
        else row.insert = asObject(entry.after, entry.target);
        continue;
      }
      if (entry.field.startsWith("dailyPlan.")) {
        if (fieldChanged(entry)) row.writeDailyPlan = true;
        continue;
      }
      if (entry.field.startsWith("datedActuals.")) {
        if (fieldChanged(entry)) row.writeDatedActuals = true;
        continue;
      }
      if (fieldChanged(entry) && entry.after !== undefined) row.columns.set(entry.field, entry.after);
      continue;
    }
    const kinds: readonly MasterKind[] = ["calendar", "member", "process", "product", "template"];
    let matched = false;
    for (const kind of kinds) {
      const id = prefixedId(entry.target, `${kind}:`);
      if (id === undefined) continue;
      absorbMaster(masters[kind], id, entry);
      matched = true;
      break;
    }
    if (!matched) throw new Error(`Unknown WBS change target ${entry.target}`);
  }

  return { wbsFields, tasks, masters, dependencyDeletes, dependencyInserts, dependencyUpdates };
}

async function upsertMasters(
  transaction: CommandTransaction,
  request: ProjectCommandRequest,
  masters: GroupedChanges["masters"],
): Promise<{ readonly [kind in MasterKind]: readonly string[] }> {
  const removed: { [kind in MasterKind]: string[] } = {
    calendar: [],
    member: [],
    process: [],
    product: [],
    template: [],
  };

  for (const [id, row] of masters.calendar) {
    if (row.remove) {
      removed.calendar.push(id);
      continue;
    }
    if (row.insert !== undefined) {
      const record = row.insert;
      await transaction.insert(calendar).values({
        tenantId: request.tenantId,
        wbsId: request.projectId,
        id,
        name: expectString(required(record, "name", "calendar"), "name"),
        workingWeekdays: expectNumberArray(required(record, "workingWeekdays", "calendar"), "workingWeekdays"),
        nonWorkingDates: expectStringArray(required(record, "nonWorkingDates", "calendar"), "nonWorkingDates"),
      });
      continue;
    }
    if (row.patch.size === 0) continue;
    await transaction
      .update(calendar)
      .set({
        ...(row.patch.has("name") ? { name: expectString(row.patch.get("name")!, "name") } : {}),
        ...(row.patch.has("workingWeekdays")
          ? { workingWeekdays: expectNumberArray(row.patch.get("workingWeekdays")!, "workingWeekdays") }
          : {}),
        ...(row.patch.has("nonWorkingDates")
          ? { nonWorkingDates: expectStringArray(row.patch.get("nonWorkingDates")!, "nonWorkingDates") }
          : {}),
        updatedAt: sql`now()`,
      })
      .where(
        and(eq(calendar.tenantId, request.tenantId), eq(calendar.wbsId, request.projectId), eq(calendar.id, id)),
      );
  }

  for (const [id, row] of masters.member) {
    if (row.remove) {
      removed.member.push(id);
      continue;
    }
    if (row.insert !== undefined) {
      const record = row.insert;
      await transaction.insert(member).values({
        id,
        tenantId: request.tenantId,
        wbsId: request.projectId,
        name: expectString(required(record, "name", "member"), "name"),
        calendarId: expectString(required(record, "calendarId", "member"), "calendarId"),
        dailyCapacityMinutes: expectNumber(
          required(record, "dailyCapacityMinutes", "member"),
          "dailyCapacityMinutes",
        ),
        costRateMinorPerHour: expectNullableNumber(
          required(record, "costRateMinorPerHour", "member"),
          "costRateMinorPerHour",
        ),
      });
      continue;
    }
    if (row.patch.size === 0) continue;
    await transaction
      .update(member)
      .set({
        ...(row.patch.has("name") ? { name: expectString(row.patch.get("name")!, "name") } : {}),
        ...(row.patch.has("calendarId")
          ? { calendarId: expectString(row.patch.get("calendarId")!, "calendarId") }
          : {}),
        ...(row.patch.has("dailyCapacityMinutes")
          ? { dailyCapacityMinutes: expectNumber(row.patch.get("dailyCapacityMinutes")!, "dailyCapacityMinutes") }
          : {}),
        ...(row.patch.has("costRateMinorPerHour")
          ? {
              costRateMinorPerHour: expectNullableNumber(
                row.patch.get("costRateMinorPerHour")!,
                "costRateMinorPerHour",
              ),
            }
          : {}),
        updatedAt: sql`now()`,
      })
      .where(and(eq(member.tenantId, request.tenantId), eq(member.wbsId, request.projectId), eq(member.id, id)));
  }

  for (const kind of ["process", "product"] as const) {
    const table = kind === "process" ? process : product;
    for (const [id, row] of masters[kind]) {
      if (row.remove) {
        removed[kind].push(id);
        continue;
      }
      if (row.insert !== undefined) {
        const record = row.insert;
        await transaction.insert(table).values({
          id,
          tenantId: request.tenantId,
          wbsId: request.projectId,
          name: expectString(required(record, "name", kind), "name"),
          sortOrder: expectNumber(required(record, "sortOrder", kind), "sortOrder"),
        });
        continue;
      }
      if (row.patch.size === 0) continue;
      await transaction
        .update(table)
        .set({
          ...(row.patch.has("name") ? { name: expectString(row.patch.get("name")!, "name") } : {}),
          ...(row.patch.has("sortOrder") ? { sortOrder: expectNumber(row.patch.get("sortOrder")!, "sortOrder") } : {}),
          updatedAt: sql`now()`,
        })
        .where(and(eq(table.tenantId, request.tenantId), eq(table.wbsId, request.projectId), eq(table.id, id)));
    }
  }

  for (const [id, row] of masters.template) {
    if (row.remove) {
      removed.template.push(id);
      continue;
    }
    if (row.insert !== undefined) {
      const record = row.insert;
      await transaction.insert(subtaskTemplate).values({
        id,
        tenantId: request.tenantId,
        wbsId: request.projectId,
        name: expectString(required(record, "name", "template"), "name"),
        sortOrder: expectNumber(required(record, "sortOrder", "template"), "sortOrder"),
        subtasks: required(record, "subtasks", "template"),
      });
      continue;
    }
    if (row.patch.size === 0) continue;
    await transaction
      .update(subtaskTemplate)
      .set({
        ...(row.patch.has("name") ? { name: expectString(row.patch.get("name")!, "name") } : {}),
        ...(row.patch.has("sortOrder") ? { sortOrder: expectNumber(row.patch.get("sortOrder")!, "sortOrder") } : {}),
        ...(row.patch.has("subtasks") ? { subtasks: row.patch.get("subtasks")! } : {}),
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(subtaskTemplate.tenantId, request.tenantId),
          eq(subtaskTemplate.wbsId, request.projectId),
          eq(subtaskTemplate.id, id),
        ),
      );
  }

  return removed;
}

function taskAfter(after: ProjectState, id: string) {
  const found = after.tasks.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`WBS change names missing task ${id}`);
  return found;
}


export class PostgresProjectCommandUnitOfWork implements ProjectCommandUnitOfWork {
  constructor(private readonly database: NodePgDatabase<typeof schema>) {}

  async execute(request: ProjectCommandRequest): Promise<ProjectCommandExecution> {
    const fingerprint = operationFingerprint(request);

    return this.database.transaction(async (transaction) => {
      const findReceipt = () =>
        transaction
          .select()
          .from(commandReceipt)
          .where(
            and(
              eq(commandReceipt.tenantId, request.tenantId),
              eq(commandReceipt.wbsId, request.projectId),
              eq(commandReceipt.idempotencyKey, request.operationId),
            ),
          )
          .limit(1);

      const replay = (receipt: typeof commandReceipt.$inferSelect) => {
        if (receipt.requestHash !== fingerprint) {
          throw new IdempotencyConflictError(request.operationId);
        }
        return {
          projectId: request.projectId,
          revision: receipt.resultRevision,
          replayed: true,
        } satisfies ProjectCommandExecution;
      };

      const [existingReceipt] = await findReceipt();
      if (existingReceipt !== undefined) {
        return replay(existingReceipt);
      }

      const lockedProject = await transaction.execute<{ revision: string }>(sql`
        select revision::text as revision
        from wbs
        where tenant_id = ${request.tenantId} and id = ${request.projectId}
        for update
      `);
      const lockedRow = lockedProject.rows[0];
      if (lockedRow === undefined) {
        throw new ProjectNotFoundError(request.projectId);
      }

      const [concurrentReceipt] = await findReceipt();
      if (concurrentReceipt !== undefined) {
        return replay(concurrentReceipt);
      }

      const actualRevision = BigInt(lockedRow.revision);
      if (actualRevision !== request.expectedRevision) {
        throw new ProjectVersionConflictError(request.expectedRevision, actualRevision);
      }

      const resultRevision = actualRevision + 1n;
      await transaction.execute(sql`
        select set_config(
          'vecta.wbs_write',
          ${`${request.projectId}:${resultRevision.toString()}`},
          true
        )
      `);

      const [projectRow] = await transaction
        .select({
          id: wbs.id,
          name: wbs.name,
          projectStart: wbs.projectStart,
          statusDate: wbs.statusDate,
          currency: wbs.currency,
          defaultCalendarId: wbs.defaultCalendarId,
          nextTaskSeq: wbs.nextTaskSeq,
          nextBaselineVersion: wbs.nextBaselineVersion,
        })
        .from(wbs)
        .where(and(eq(wbs.tenantId, request.tenantId), eq(wbs.id, request.projectId)))
        .limit(1);
      if (projectRow === undefined) {
        throw new ProjectNotFoundError(request.projectId);
      }
      if (projectRow.currency !== "JPY") {
        throw new Error(`Unsupported application currency: ${projectRow.currency}`);
      }

      const taskRows = await transaction
        .select()
        .from(task)
        .where(and(eq(task.tenantId, request.tenantId), eq(task.wbsId, request.projectId)))
        .orderBy(asc(task.sortOrder));
      const calendarRows = await transaction
        .select()
        .from(calendar)
        .where(and(eq(calendar.tenantId, request.tenantId), eq(calendar.wbsId, request.projectId)))
        .orderBy(asc(calendar.id));
      const memberRows = await transaction
        .select()
        .from(member)
        .where(and(eq(member.tenantId, request.tenantId), eq(member.wbsId, request.projectId)))
        .orderBy(asc(member.id));
      const processRows = await transaction
        .select()
        .from(process)
        .where(and(eq(process.tenantId, request.tenantId), eq(process.wbsId, request.projectId)))
        .orderBy(asc(process.sortOrder), asc(process.id));
      const productRows = await transaction
        .select()
        .from(product)
        .where(and(eq(product.tenantId, request.tenantId), eq(product.wbsId, request.projectId)))
        .orderBy(asc(product.sortOrder), asc(product.id));
      const templateRows = await transaction
        .select()
        .from(subtaskTemplate)
        .where(
          and(eq(subtaskTemplate.tenantId, request.tenantId), eq(subtaskTemplate.wbsId, request.projectId)),
        )
        .orderBy(asc(subtaskTemplate.sortOrder), asc(subtaskTemplate.id));
      const dependencyRows = await transaction
        .select()
        .from(taskDependency)
        .where(and(eq(taskDependency.tenantId, request.tenantId), eq(taskDependency.wbsId, request.projectId)))
        .orderBy(
          asc(taskDependency.successorTaskId),
          asc(taskDependency.predecessorTaskId),
          asc(taskDependency.type),
        );

      const dependenciesByTask = new Map<
        string,
        Array<{ predecessorId: string; type: DependencyTypeName; lagWorkingDays: number }>
      >();
      for (const dependency of dependencyRows) {
        const entries = dependenciesByTask.get(dependency.successorTaskId) ?? [];
        entries.push({
          predecessorId: dependency.predecessorTaskId,
          type: dependency.type,
          lagWorkingDays: dependency.lagWorkingDays,
        });
        dependenciesByTask.set(dependency.successorTaskId, entries);
      }

      const current: ProjectState = {
        id: projectRow.id,
        name: projectRow.name,
        projectStart: projectRow.projectStart,
        statusDate: projectRow.statusDate,
        currency: "JPY",
        defaultCalendarId: projectRow.defaultCalendarId,
        calendars: calendarRows.map((row) => ({
          id: row.id,
          name: row.name,
          workingWeekdays: row.workingWeekdays,
          nonWorkingDates: row.nonWorkingDates,
        })),
        members: memberRows.map((row) => ({
          id: row.id,
          name: row.name,
          calendarId: row.calendarId,
          dailyCapacityMinutes: row.dailyCapacityMinutes,
          costRateMinorPerHour: row.costRateMinorPerHour,
        })),
        processes: processRows.map((row) => ({
          id: row.id,
          name: row.name,
          sortOrder: row.sortOrder,
        })),
        products: productRows.map((row) => ({
          id: row.id,
          name: row.name,
          sortOrder: row.sortOrder,
        })),
        templates: templateRows.map((row) => ({
          id: row.id,
          name: row.name,
          sortOrder: row.sortOrder,
          subtasks: row.subtasks as readonly SubtaskTemplateStep[],
        })),
        nextTaskSeq: projectRow.nextTaskSeq,
        nextBaselineVersion: projectRow.nextBaselineVersion,
        tasks: taskRows.map((row) => ({
          id: row.id,
          parentId: row.parentTaskId,
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
          dailyPlan: row.dailyPlan as Record<string, number>,
          datedActuals: row.datedActuals as Record<string, number>,
          actualStart: row.actualStart,
          actualFinish: row.actualFinish,
          dependencies: dependenciesByTask.get(row.id) ?? [],
        })),
      };

      let diffed: ReturnType<typeof diffOperation>;
      try {
        if (current.id !== request.projectId) {
          throw new Error(`Loaded project does not match command: ${request.projectId}`);
        }
        diffed = diffOperation(current, request.commands);
      } catch (error) {
        if (error instanceof ProjectCommandValidationError) throw error;
        throw new ProjectCommandValidationError(
          error instanceof Error ? error.message : "Project command is invalid",
        );
      }

      const grouped = groupChanges(diffed.change);
      const removedMasters = await upsertMasters(transaction, request, grouped.masters);

      const removedTaskIds: string[] = [];
      const newTaskParents: { readonly id: string; readonly parentId: string }[] = [];
      for (const [id, row] of grouped.tasks) {
        if (row.remove) {
          removedTaskIds.push(id);
          continue;
        }
        if (row.insert === undefined) continue;
        const record = row.insert;
        const parentId = expectNullableString(required(record, "parentId", id), "parentId");
        await transaction.insert(task).values({
          id,
          tenantId: request.tenantId,
          wbsId: request.projectId,
          parentTaskId: null,
          sortOrder: expectNumber(required(record, "sortOrder", id), "sortOrder"),
          seq: expectNumber(required(record, "seq", id), "seq"),
          name: expectString(required(record, "name", id), "name"),
          processId: expectNullableString(required(record, "processId", id), "processId"),
          productId: expectNullableString(required(record, "productId", id), "productId"),
          note: expectString(required(record, "note", id), "note"),
          contract: expectString(required(record, "contract", id), "contract"),
          assigneeMemberId: expectNullableString(required(record, "assigneeMemberId", id), "assigneeMemberId"),
          plannedEffortMinutes: expectNumber(required(record, "plannedEffortMinutes", id), "plannedEffortMinutes"),
          progressBasisPoints: expectNumber(required(record, "progressBasisPoints", id), "progressBasisPoints"),
          actualEffortMinutes: expectNumber(required(record, "actualEffortMinutes", id), "actualEffortMinutes"),
          prorationWeightBp: expectNullableNumber(required(record, "prorationWeightBp", id), "prorationWeightBp"),
          dailyPlan: expectNumberRecord(required(record, "dailyPlan", id), "dailyPlan"),
          datedActuals: expectNumberRecord(required(record, "datedActuals", id), "datedActuals"),
          actualStart: expectNullableString(required(record, "actualStart", id), "actualStart"),
          actualFinish: expectNullableString(required(record, "actualFinish", id), "actualFinish"),
        });
        if (parentId !== null) newTaskParents.push({ id, parentId });
      }

      for (const [id, row] of grouped.tasks) {
        if (row.remove || row.insert !== undefined) continue;
        const column = (field: string): JsonValue => {
          const value = row.columns.get(field);
          if (value === undefined) throw new Error(`WBS change missing task field ${field}`);
          return value;
        };
        const set: {
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
          dailyPlan?: Record<string, number>;
          datedActuals?: Record<string, number>;
          actualStart?: string | null;
          actualFinish?: string | null;
        } = {};
        if (row.columns.has("parentId")) set.parentTaskId = expectNullableString(column("parentId"), "parentId");
        if (row.columns.has("sortOrder")) set.sortOrder = expectNumber(column("sortOrder"), "sortOrder");
        if (row.columns.has("seq")) set.seq = expectNumber(column("seq"), "seq");
        if (row.columns.has("name")) set.name = expectString(column("name"), "name");
        if (row.columns.has("processId")) set.processId = expectNullableString(column("processId"), "processId");
        if (row.columns.has("productId")) set.productId = expectNullableString(column("productId"), "productId");
        if (row.columns.has("note")) set.note = expectString(column("note"), "note");
        if (row.columns.has("contract")) set.contract = expectString(column("contract"), "contract");
        if (row.columns.has("assigneeMemberId")) {
          set.assigneeMemberId = expectNullableString(column("assigneeMemberId"), "assigneeMemberId");
        }
        if (row.columns.has("plannedEffortMinutes")) {
          set.plannedEffortMinutes = expectNumber(column("plannedEffortMinutes"), "plannedEffortMinutes");
        }
        if (row.columns.has("progressBasisPoints")) {
          set.progressBasisPoints = expectNumber(column("progressBasisPoints"), "progressBasisPoints");
        }
        if (row.columns.has("actualEffortMinutes")) {
          set.actualEffortMinutes = expectNumber(column("actualEffortMinutes"), "actualEffortMinutes");
        }
        if (row.columns.has("prorationWeightBp")) {
          set.prorationWeightBp = expectNullableNumber(column("prorationWeightBp"), "prorationWeightBp");
        }
        if (row.columns.has("actualStart")) set.actualStart = expectNullableString(column("actualStart"), "actualStart");
        if (row.columns.has("actualFinish")) {
          set.actualFinish = expectNullableString(column("actualFinish"), "actualFinish");
        }
        if (row.writeDailyPlan) set.dailyPlan = { ...taskAfter(diffed.after, id).dailyPlan };
        if (row.writeDatedActuals) set.datedActuals = { ...taskAfter(diffed.after, id).datedActuals };
        if (Object.keys(set).length === 0) continue;
        // Same fence as the insert: the WHERE names (tenant_id, wbs_id, id),
        // so a client-supplied id cannot update a task that belongs elsewhere.
        await transaction
          .update(task)
          .set({ ...set, updatedAt: sql`now()` })
          .where(and(eq(task.tenantId, request.tenantId), eq(task.wbsId, request.projectId), eq(task.id, id)));
      }

      if (newTaskParents.length > 0) {
        const pairs = sql.join(
          newTaskParents.map((row) => sql`(${row.id}::uuid, ${row.parentId}::uuid)`),
          sql`, `,
        );
        await transaction.execute(sql`
          update ${task} set parent_task_id = v.parent_task_id
          from (values ${pairs}) as v(id, parent_task_id)
          where ${task.tenantId} = ${request.tenantId}
            and ${task.wbsId} = ${request.projectId}
            and ${task.id} = v.id
        `);
      }

      for (const edge of grouped.dependencyDeletes) {
        await transaction
          .delete(taskDependency)
          .where(
            and(
              eq(taskDependency.tenantId, request.tenantId),
              eq(taskDependency.wbsId, request.projectId),
              eq(taskDependency.successorTaskId, edge.successorId),
              eq(taskDependency.predecessorTaskId, edge.predecessorId),
              eq(taskDependency.type, edge.type),
            ),
          );
      }
      if (grouped.dependencyInserts.length > 0) {
        await transaction.insert(taskDependency).values(
          grouped.dependencyInserts.map((edge) => ({
            tenantId: request.tenantId,
            wbsId: request.projectId,
            predecessorTaskId: edge.predecessorId,
            successorTaskId: edge.successorId,
            type: edge.type,
            lagWorkingDays: edge.lagWorkingDays,
          })),
        );
      }
      for (const edge of grouped.dependencyUpdates) {
        await transaction
          .update(taskDependency)
          .set({ lagWorkingDays: edge.lagWorkingDays })
          .where(
            and(
              eq(taskDependency.tenantId, request.tenantId),
              eq(taskDependency.wbsId, request.projectId),
              eq(taskDependency.successorTaskId, edge.successorId),
              eq(taskDependency.predecessorTaskId, edge.predecessorId),
              eq(taskDependency.type, edge.type),
            ),
          );
      }

      if (removedTaskIds.length > 0) {
        await transaction
          .delete(task)
          .where(
            and(
              eq(task.tenantId, request.tenantId),
              eq(task.wbsId, request.projectId),
              inArray(task.id, removedTaskIds),
            ),
          );
      }

      const deleteMaster = async (kind: MasterKind, ids: readonly string[]) => {
        if (ids.length === 0) return;
        if (kind === "calendar") {
          await transaction
            .delete(calendar)
            .where(
              and(
                eq(calendar.tenantId, request.tenantId),
                eq(calendar.wbsId, request.projectId),
                inArray(calendar.id, [...ids]),
              ),
            );
        } else if (kind === "member") {
          await transaction
            .delete(member)
            .where(
              and(
                eq(member.tenantId, request.tenantId),
                eq(member.wbsId, request.projectId),
                inArray(member.id, [...ids]),
              ),
            );
        } else if (kind === "process") {
          await transaction
            .delete(process)
            .where(
              and(
                eq(process.tenantId, request.tenantId),
                eq(process.wbsId, request.projectId),
                inArray(process.id, [...ids]),
              ),
            );
        } else if (kind === "product") {
          await transaction
            .delete(product)
            .where(
              and(
                eq(product.tenantId, request.tenantId),
                eq(product.wbsId, request.projectId),
                inArray(product.id, [...ids]),
              ),
            );
        } else {
          await transaction
            .delete(subtaskTemplate)
            .where(
              and(
                eq(subtaskTemplate.tenantId, request.tenantId),
                eq(subtaskTemplate.wbsId, request.projectId),
                inArray(subtaskTemplate.id, [...ids]),
              ),
            );
        }
      };
      await deleteMaster("member", removedMasters.member);
      await deleteMaster("calendar", removedMasters.calendar);
      await deleteMaster("process", removedMasters.process);
      await deleteMaster("product", removedMasters.product);
      await deleteMaster("template", removedMasters.template);

      const wbsSet: {
        revision: bigint;
        nextTaskSeq: number;
        nextBaselineVersion: number;
        name?: string;
        projectStart?: string;
        statusDate?: string;
        defaultCalendarId?: string;
        updatedAt: ReturnType<typeof sql>;
      } = {
        revision: resultRevision,
        nextTaskSeq: diffed.after.nextTaskSeq,
        nextBaselineVersion: diffed.after.nextBaselineVersion,
        updatedAt: sql`now()`,
      };
      if (grouped.wbsFields.has("name")) wbsSet.name = expectString(grouped.wbsFields.get("name")!, "name");
      if (grouped.wbsFields.has("projectStart")) {
        wbsSet.projectStart = expectString(grouped.wbsFields.get("projectStart")!, "projectStart");
      }
      if (grouped.wbsFields.has("statusDate")) {
        wbsSet.statusDate = expectString(grouped.wbsFields.get("statusDate")!, "statusDate");
      }
      if (grouped.wbsFields.has("defaultCalendarId")) {
        wbsSet.defaultCalendarId = expectString(grouped.wbsFields.get("defaultCalendarId")!, "defaultCalendarId");
      }
      await transaction
        .update(wbs)
        .set(wbsSet)
        .where(
          and(
            eq(wbs.tenantId, request.tenantId),
            eq(wbs.id, request.projectId),
            eq(wbs.revision, actualRevision),
          ),
        );

      if (request.commands.some((command) => command.type === "baseline.publish")) {
        const leaves = leafTaskIds(current.tasks);
        await transaction.insert(baseline).values({
          tenantId: request.tenantId,
          wbsId: request.projectId,
          version: current.nextBaselineVersion,
          sourceRevision: actualRevision,
          publishedByActorType: request.actor.type,
          publishedByActorId: request.actor.id,
        });
        const frozen = current.tasks
          .filter((row) => leaves.has(row.id))
          .map((row) => ({
            tenantId: request.tenantId,
            wbsId: request.projectId,
            version: current.nextBaselineVersion,
            taskId: row.id,
            parentTaskId: row.parentId,
            dailyPlan: row.dailyPlan,
            plannedEffortMinutes: row.plannedEffortMinutes,
            assigneeMemberId: row.assigneeMemberId,
            name: row.name,
            seq: row.seq,
          }));
        if (frozen.length > 0) {
          await transaction.insert(baselineTask).values(frozen);
        }
      }

      await transaction.insert(wbsChange).values({
        tenantId: request.tenantId,
        wbsId: request.projectId,
        revision: resultRevision,
        operationId: request.operationId,
        actorType: request.actor.type,
        actorId: request.actor.id,
        format: diffed.change.format,
        change: diffed.change,
      });
      const firstCommand = request.commands[0];
      if (firstCommand === undefined) {
        throw new ProjectCommandValidationError("Project command is invalid");
      }
      await transaction.insert(auditEvent).values({
        tenantId: request.tenantId,
        wbsId: request.projectId,
        wbsRevision: resultRevision,
        actorType: request.actor.type,
        actorId: request.actor.id,
        commandType: firstCommand.type,
        payload: {
          operationId: request.operationId,
          commands: request.commands,
          expectedRevision: request.expectedRevision.toString(),
        },
      });
      await transaction.insert(commandReceipt).values({
        tenantId: request.tenantId,
        wbsId: request.projectId,
        idempotencyKey: request.operationId,
        requestHash: fingerprint,
        resultRevision,
      });

      return {
        projectId: request.projectId,
        revision: resultRevision,
        replayed: false,
      };
    });
  }
}

