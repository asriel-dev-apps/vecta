import { createHash } from "node:crypto";
import {
  canonicalJson,
  commandReadsStoredCells,
  diffOperation,
  IdempotencyConflictError,
  leafTaskIds,
  isSnapshotDue,
  productionSnapshotInterval,
  ProjectCommandValidationError,
  ProjectNotFoundError,
  ProjectVersionConflictError,
  type DependencyType,
  type LastSnapshot,
  type ProjectCommand,
  type ProjectCommandExecution,
  type ProjectCommandRequest,
  type ProjectCommandUnitOfWork,
  type ProjectState,
  type SnapshotInterval,
  type SubtaskTemplateStep,
} from "@vecta/application";
import { and, asc, eq, sql } from "drizzle-orm";
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
import { takeWbsSnapshot } from "./wbs-snapshot-store.js";
import { writeWbsChange } from "./wbs-change-writer.js";

/** Shared empty map for loads that do not read stored cells. Frozen so a stray write throws. */
const EMPTY_CELLS: Record<string, number> = Object.freeze({});

function commandsOmitStoredCells(commands: readonly ProjectCommand[]): boolean {
  return commands.length > 0 && commands.every((command) => !commandReadsStoredCells(command));
}

function operationFingerprint(request: ProjectCommandRequest): string {
  return createHash("sha256")
    .update(canonicalJson({ actor: request.actor, commands: request.commands }))
    .digest("hex");
}

export interface UnitOfWorkOptions {
  /** Replaces the whole interval rule. Tests pass `() => 3`. */
  readonly snapshotInterval?: SnapshotInterval;
}

interface ExecuteOutcome {
  readonly execution: ProjectCommandExecution;
  readonly pendingSnapshot: ProjectState | null;
  readonly snapshotRevision: bigint;
}

function lastSnapshotOf(row: {
  snapshot_revision: string | null;
  snapshot_body_bytes: number | string | null;
}): LastSnapshot | null {
  if (row.snapshot_revision === null || row.snapshot_body_bytes === null) return null;
  const bodyBytes = Number(row.snapshot_body_bytes);
  if (!Number.isFinite(bodyBytes)) return null;
  return { revision: BigInt(row.snapshot_revision), bodyBytes };
}

export class PostgresProjectCommandUnitOfWork implements ProjectCommandUnitOfWork {
  constructor(
    private readonly database: NodePgDatabase<typeof schema>,
    private readonly options: UnitOfWorkOptions = {},
  ) {}

  async execute(request: ProjectCommandRequest): Promise<ProjectCommandExecution> {
    const fingerprint = operationFingerprint(request);
    const interval = this.options.snapshotInterval ?? productionSnapshotInterval;

    const outcome = await this.database.transaction(async (transaction) => {
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

      const replay = (receipt: typeof commandReceipt.$inferSelect): ExecuteOutcome => {
        if (receipt.requestHash !== fingerprint) {
          throw new IdempotencyConflictError(request.operationId);
        }
        return {
          execution: {
            projectId: request.projectId,
            revision: receipt.resultRevision,
            replayed: true,
          },
          pendingSnapshot: null,
          snapshotRevision: 0n,
        };
      };

      const [existingReceipt] = await findReceipt();
      if (existingReceipt !== undefined) {
        return replay(existingReceipt);
      }

      const lockedProject = await transaction.execute<{
        revision: string;
        snapshot_revision: string | null;
        snapshot_body_bytes: number | string | null;
      }>(sql`
        select wbs.revision::text as revision,
          snap.revision::text as snapshot_revision,
          snap.body_bytes as snapshot_body_bytes
        from wbs
        left join lateral (
          select s.revision, s.body_bytes
          from wbs_snapshot s
          where s.tenant_id = wbs.tenant_id and s.wbs_id = wbs.id
          order by s.revision desc
          limit 1
        ) snap on true
        where wbs.tenant_id = ${request.tenantId} and wbs.id = ${request.projectId}
        for update of wbs
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

      const lastSnapshot = lastSnapshotOf(lockedRow);
      const due = isSnapshotDue(actualRevision, lastSnapshot, interval);
      // A name (or other scalar) edit cannot make an untouched daily cell invalid:
      // the cell was validated on the write that stored it, and this command does
      // not replace the map. Skip the jsonb unless we are about to snapshot the
      // loaded state, which must still be the full plan.
      const omitCells = lastSnapshot !== null && !due && commandsOmitStoredCells(request.commands);
      const taskFilter = and(eq(task.tenantId, request.tenantId), eq(task.wbsId, request.projectId));
      const taskScalars = {
        id: task.id,
        parentTaskId: task.parentTaskId,
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
        actualStart: task.actualStart,
        actualFinish: task.actualFinish,
      };
      const taskRows = omitCells
        ? (
            await transaction
              .select(taskScalars)
              .from(task)
              .where(taskFilter)
              .orderBy(asc(task.sortOrder))
          ).map((row) => ({ ...row, dailyPlan: EMPTY_CELLS, datedActuals: EMPTY_CELLS }))
        : (
            await transaction
              .select({ ...taskScalars, dailyPlan: task.dailyPlan, datedActuals: task.datedActuals })
              .from(task)
              .where(taskFilter)
              .orderBy(asc(task.sortOrder))
          ).map((row) => ({
            ...row,
            dailyPlan: row.dailyPlan as Record<string, number>,
            datedActuals: row.datedActuals as Record<string, number>,
          }));
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
        Array<{ predecessorId: string; type: DependencyType; lagWorkingDays: number }>
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

      if (lastSnapshot === null) {
        await takeWbsSnapshot(
          transaction,
          { tenantId: request.tenantId, wbsId: request.projectId },
          actualRevision,
          current,
        );
      }
      const pendingSnapshot = due && lastSnapshot !== null ? current : null;

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

      if (omitCells) {
        for (const entry of diffed.change.changes) {
          if (entry.field.startsWith("dailyPlan.") || entry.field.startsWith("datedActuals.")) {
            throw new Error(`Cell-free update recorded ${entry.field} on ${entry.target}`);
          }
        }
      }
      await writeWbsChange(
        transaction,
        {
          tenantId: request.tenantId,
          wbsId: request.projectId,
          revision: actualRevision,
          nextRevision: resultRevision,
        },
        diffed.change,
      );

      if (request.commands.some((command) => command.type === "baseline.publish")) {
        if (request.commands.length !== 1) {
          throw new ProjectCommandValidationError("Only task.update commands may be combined in one operation");
        }
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
        execution: {
          projectId: request.projectId,
          revision: resultRevision,
          replayed: false,
        },
        pendingSnapshot,
        snapshotRevision: actualRevision,
      };
    });

    if (outcome.pendingSnapshot !== null) {
      try {
        await takeWbsSnapshot(
          this.database,
          { tenantId: request.tenantId, wbsId: request.projectId },
          outcome.snapshotRevision,
          outcome.pendingSnapshot,
        );
      } catch (error) {
        const name = error instanceof Error ? error.name : "Error";
        console.error(
          `wbs snapshot failed for ${request.projectId} revision ${outcome.snapshotRevision.toString()} (${name})`,
        );
      }
    }
    return outcome.execution;
  }
}

