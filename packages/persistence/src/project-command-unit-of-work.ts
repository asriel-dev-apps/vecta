import { createHash } from "node:crypto";
import {
  applyEffortSchedule,
  leafTaskIds,
  IdempotencyConflictError,
  ProjectNotFoundError,
  ProjectVersionConflictError,
  type ProjectCommandExecution,
  type ProjectCommandRequest,
  type ProjectCommandUnitOfWork,
  type ProjectState,
  type SubtaskTemplateStep,
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
} from "./schema.js";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Command fingerprint contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") {
    return JSON.stringify(value.toString());
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error(`Command fingerprint contains unsupported data: ${typeof value}`);
}

function requestHash(request: ProjectCommandRequest): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        actor: request.actor,
        command: request.command,
        expectedRevision: request.expectedRevision,
      }),
    )
    .digest("hex");
}

export class PostgresProjectCommandUnitOfWork implements ProjectCommandUnitOfWork {
  constructor(private readonly database: NodePgDatabase<typeof schema>) {}

  async execute(
    request: ProjectCommandRequest,
    transition: (project: ProjectState) => ProjectState,
  ): Promise<ProjectCommandExecution> {
    const fingerprint = requestHash(request);

    return this.database.transaction(async (transaction) => {
      const findReceipt = () =>
        transaction
          .select()
          .from(commandReceipt)
          .where(
            and(
              eq(commandReceipt.tenantId, request.tenantId),
              eq(commandReceipt.wbsId, request.projectId),
              eq(commandReceipt.idempotencyKey, request.idempotencyKey),
            ),
          )
          .limit(1);

      const replay = (receipt: typeof commandReceipt.$inferSelect) => {
        if (receipt.requestHash !== fingerprint) {
          throw new IdempotencyConflictError(request.idempotencyKey);
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
        .where(
          and(
            eq(calendar.tenantId, request.tenantId),
            eq(calendar.wbsId, request.projectId),
          ),
        )
        .orderBy(asc(calendar.id));
      const memberRows = await transaction
        .select()
        .from(member)
        .where(and(eq(member.tenantId, request.tenantId), eq(member.wbsId, request.projectId)))
        .orderBy(asc(member.id));
      const processRows = await transaction
        .select()
        .from(process)
        .where(
          and(eq(process.tenantId, request.tenantId), eq(process.wbsId, request.projectId)),
        )
        .orderBy(asc(process.sortOrder), asc(process.id));
      const productRows = await transaction
        .select()
        .from(product)
        .where(
          and(eq(product.tenantId, request.tenantId), eq(product.wbsId, request.projectId)),
        )
        .orderBy(asc(product.sortOrder), asc(product.id));
      const templateRows = await transaction
        .select()
        .from(subtaskTemplate)
        .where(
          and(
            eq(subtaskTemplate.tenantId, request.tenantId),
            eq(subtaskTemplate.wbsId, request.projectId),
          ),
        )
        .orderBy(asc(subtaskTemplate.sortOrder), asc(subtaskTemplate.id));
      const dependencyRows = await transaction
        .select()
        .from(taskDependency)
        .where(
          and(
            eq(taskDependency.tenantId, request.tenantId),
            eq(taskDependency.wbsId, request.projectId),
          ),
        )
        .orderBy(
          asc(taskDependency.successorTaskId),
          asc(taskDependency.predecessorTaskId),
          asc(taskDependency.type),
        );

      const dependenciesByTask = new Map<
        string,
        Array<{ predecessorId: string; type: "FS" | "SS" | "FF" | "SF"; lagWorkingDays: number }>
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
        calendars: calendarRows.map((calendar) => ({
          id: calendar.id,
          name: calendar.name,
          workingWeekdays: calendar.workingWeekdays,
          nonWorkingDates: calendar.nonWorkingDates,
        })),
        members: memberRows.map((member) => ({
          id: member.id,
          name: member.name,
          calendarId: member.calendarId,
          dailyCapacityMinutes: member.dailyCapacityMinutes,
          costRateMinorPerHour: member.costRateMinorPerHour,
        })),
        processes: processRows.map((process) => ({
          id: process.id,
          name: process.name,
          sortOrder: process.sortOrder,
        })),
        products: productRows.map((product) => ({
          id: product.id,
          name: product.name,
          sortOrder: product.sortOrder,
        })),
        templates: templateRows.map((template) => ({
          id: template.id,
          name: template.name,
          sortOrder: template.sortOrder,
          subtasks: template.subtasks as readonly SubtaskTemplateStep[],
        })),
        nextTaskSeq: projectRow.nextTaskSeq,
        nextBaselineVersion: projectRow.nextBaselineVersion,
        tasks: taskRows.map((task) => ({
          id: task.id,
          parentId: task.parentTaskId,
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
          dailyPlan: task.dailyPlan as Record<string, number>,
          datedActuals: task.datedActuals as Record<string, number>,
          actualStart: task.actualStart,
          actualFinish: task.actualFinish,
          dependencies: dependenciesByTask.get(task.id) ?? [],
        })),
      };

      // Apply the validated command. The deterministic scheduler runs only for
      // `task.generateSubtasks`, and even then it places daily plans for just the
      // newly-created leaf children as initial values (Design 0003 §C-2); every
      // pre-existing task's daily plan is left untouched. All other commands
      // persist the transitioned state verbatim — nothing auto-overwrites a hand
      // edit, and consistency is surfaced as non-blocking validation warnings.
      const transitioned = transition(current);
      let next: ProjectState;
      if (request.command.type === "task.generateSubtasks") {
        const existingTaskIds = new Set(current.tasks.map((task) => task.id));
        const newTaskIds = new Set(
          transitioned.tasks
            .filter((task) => !existingTaskIds.has(task.id))
            .map((task) => task.id),
        );
        next = applyEffortSchedule(transitioned, newTaskIds);
      } else {
        next = transitioned;
      }
      // Only the NEXT-state maps survive. The matching `current…Ids` sets existed
      // to answer "insert or update?" per row; every write below is now an upsert,
      // so that question belongs to Postgres and is asked once for the whole set.
      const nextTaskById = new Map(next.tasks.map((task) => [task.id, task]));
      const nextMemberById = new Map(next.members.map((member) => [member.id, member]));
      const nextProcessById = new Map(next.processes.map((process) => [process.id, process]));
      const nextProductById = new Map(next.products.map((product) => [product.id, product]));
      const nextTemplateById = new Map(next.templates.map((template) => [template.id, template]));

      // Free all self-FK (parent), assignee, process, and product references so
      // deletes and inserts never collide with RESTRICT constraints.
      await transaction
        .delete(taskDependency)
        .where(
          and(
            eq(taskDependency.tenantId, request.tenantId),
            eq(taskDependency.wbsId, request.projectId),
          ),
        );
      if (taskRows.length > 0) {
        await transaction
          .update(task)
          .set({ parentTaskId: null, assigneeMemberId: null, processId: null, productId: null })
          .where(and(eq(task.tenantId, request.tenantId), eq(task.wbsId, request.projectId)));
      }

      // Members: insert / update present, delete removed (now unreferenced).
      // One upsert, one delete — the same shape as the task write below, and for
      // the same reason.
      //
      // `costRateMinorPerHour` was MISSING from this list until 2026-08-07, so a
      // rate typed on the members screen was accepted, applied optimistically,
      // and silently dropped on the next read. The seed path writes the whole
      // record and so was unaffected, which is why nothing caught it — and the
      // one test that touched the field passed a `null`, a value that cannot
      // distinguish "written" from "not written". It now passes a real amount.
      const memberValues = next.members.map((member) => ({
        id: member.id,
        tenantId: request.tenantId,
        wbsId: request.projectId,
        name: member.name,
        calendarId: member.calendarId,
        dailyCapacityMinutes: member.dailyCapacityMinutes,
        costRateMinorPerHour: member.costRateMinorPerHour,
      }));
      if (memberValues.length > 0) {
        await transaction
          .insert(member)
          .values(memberValues)
          .onConflictDoUpdate({
            target: [member.tenantId, member.wbsId, member.id],
            set: {
              name: sql`excluded.name`,
              calendarId: sql`excluded.calendar_id`,
              dailyCapacityMinutes: sql`excluded.daily_capacity_minutes`,
              costRateMinorPerHour: sql`excluded.cost_rate_minor_per_hour`,
              updatedAt: sql`now()`,
            },
          });
      }
      const removedMemberIds = memberRows
        .filter((member) => !nextMemberById.has(member.id))
        .map((member) => member.id);
      if (removedMemberIds.length > 0) {
        await transaction
          .delete(member)
          .where(
            and(
              eq(member.tenantId, request.tenantId),
              eq(member.wbsId, request.projectId),
              inArray(member.id, removedMemberIds),
            ),
          );
      }

      // Processes: upsert present, delete removed (now unreferenced).
      const processValues = next.processes.map((process) => ({
        id: process.id,
        tenantId: request.tenantId,
        wbsId: request.projectId,
        name: process.name,
        sortOrder: process.sortOrder,
      }));
      if (processValues.length > 0) {
        await transaction
          .insert(process)
          .values(processValues)
          .onConflictDoUpdate({
            target: [process.tenantId, process.wbsId, process.id],
            set: {
              name: sql`excluded.name`,
              sortOrder: sql`excluded.sort_order`,
              updatedAt: sql`now()`,
            },
          });
      }
      const removedProcessIds = processRows
        .filter((process) => !nextProcessById.has(process.id))
        .map((process) => process.id);
      if (removedProcessIds.length > 0) {
        await transaction
          .delete(process)
          .where(
            and(
              eq(process.tenantId, request.tenantId),
              eq(process.wbsId, request.projectId),
              inArray(process.id, removedProcessIds),
            ),
          );
      }

      // Products: upsert present, delete removed (now unreferenced).
      const productValues = next.products.map((product) => ({
        id: product.id,
        tenantId: request.tenantId,
        wbsId: request.projectId,
        name: product.name,
        sortOrder: product.sortOrder,
      }));
      if (productValues.length > 0) {
        await transaction
          .insert(product)
          .values(productValues)
          .onConflictDoUpdate({
            target: [product.tenantId, product.wbsId, product.id],
            set: {
              name: sql`excluded.name`,
              sortOrder: sql`excluded.sort_order`,
              updatedAt: sql`now()`,
            },
          });
      }
      const removedProductIds = productRows
        .filter((product) => !nextProductById.has(product.id))
        .map((product) => product.id);
      if (removedProductIds.length > 0) {
        await transaction
          .delete(product)
          .where(
            and(
              eq(product.tenantId, request.tenantId),
              eq(product.wbsId, request.projectId),
              inArray(product.id, removedProductIds),
            ),
          );
      }

      // Templates: insert / update present, delete removed. Templates are never
      // referenced by a task (generation copies the step data), so a delete has
      // no referential guard (Design 0003 §E-1 locked decision 4).
      const templateValues = next.templates.map((template) => ({
        id: template.id,
        tenantId: request.tenantId,
        wbsId: request.projectId,
        name: template.name,
        sortOrder: template.sortOrder,
        subtasks: template.subtasks,
      }));
      if (templateValues.length > 0) {
        await transaction
          .insert(subtaskTemplate)
          .values(templateValues)
          .onConflictDoUpdate({
            target: [subtaskTemplate.tenantId, subtaskTemplate.wbsId, subtaskTemplate.id],
            set: {
              name: sql`excluded.name`,
              sortOrder: sql`excluded.sort_order`,
              subtasks: sql`excluded.subtasks`,
              updatedAt: sql`now()`,
            },
          });
      }
      const removedTemplateIds = templateRows
        .filter((template) => !nextTemplateById.has(template.id))
        .map((template) => template.id);
      if (removedTemplateIds.length > 0) {
        await transaction
          .delete(subtaskTemplate)
          .where(
            and(
              eq(subtaskTemplate.tenantId, request.tenantId),
              eq(subtaskTemplate.wbsId, request.projectId),
              inArray(subtaskTemplate.id, removedTemplateIds),
            ),
          );
      }

      // Delete removed tasks (parent references already nulled above). ONE
      // statement for the whole set: a loop here cost a round trip per deleted
      // task, and deleting a subtree is exactly when there are many.
      const removedTaskIds = taskRows
        .filter((task) => !nextTaskById.has(task.id))
        .map((task) => task.id);
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

      // Write every task in ONE statement, then link the parents in ONE more.
      //
      // This used to be a loop per task — an UPDATE or an INSERT each — plus a
      // second loop for the parent links, so a command cost `2 × tasks` round
      // trips whether it touched one task or all of them. Measured 2026-08-06:
      // renaming a SINGLE task cost 37 statements on a 6-task project and 149 on
      // a 60-task one, and against a database in another region that is the whole
      // latency budget. `write-path-scaling.test.ts` pins the two counts EQUAL,
      // which is the only shape that says "the work does not depend on how big
      // the project is".
      //
      // An upsert rather than update-or-insert: whether a row already exists
      // becomes Postgres' question, asked once for the set, instead of ours asked
      // per row.
      //
      // The conflict target is the COMPOSITE `task_tenant_wbs_id_unique`,
      // not the `id` primary key, and that is the tenancy fence. Task ids are
      // supplied by the client (`AddTaskCommand.task` carries `id`), so a request
      // scoped to project A can name a task id that lives in project B. Targeting
      // `id` alone made that a silent cross-project UPDATE: `tenant_id` and
      // `wbs_id` are absent from the `set` list, so the victim's row stayed
      // where it was and took this project's name, seq, plan and a nulled parent.
      // Against the composite the row is not a conflict at all, so Postgres
      // attempts the INSERT and `task_pkey` rejects it — which is exactly what
      // the per-row loop this replaced did. Fail closed, as before.
      const taskValues = next.tasks.map((task) => ({
        id: task.id,
        tenantId: request.tenantId,
        wbsId: request.projectId,
        // Parent deferred to the second statement so every parent target exists
        // before the self-FK is set — the same reason the two loops were in this
        // order, unchanged.
        parentTaskId: null,
        sortOrder: task.sortOrder,
        // Immutable display No.: written once at insert and re-set to the same
        // value on update, so a reorder/edit never renumbers a task (§F-1).
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
        // Design 0011. Carried in the same per-task write as `dailyPlan`, which
        // is why an import survives the next unrelated command: both the total
        // and the rows it comes from travel with the task.
        datedActuals: task.datedActuals,
        actualStart: task.actualStart,
        actualFinish: task.actualFinish,
      }));
      if (taskValues.length > 0) {
        await transaction
          .insert(task)
          .values(taskValues)
          .onConflictDoUpdate({
            target: [task.tenantId, task.wbsId, task.id],
            set: {
              parentTaskId: sql`null`,
              sortOrder: sql`excluded.sort_order`,
              seq: sql`excluded.seq`,
              name: sql`excluded.name`,
              processId: sql`excluded.process_id`,
              productId: sql`excluded.product_id`,
              note: sql`excluded.note`,
              contract: sql`excluded.contract`,
              assigneeMemberId: sql`excluded.assignee_member_id`,
              plannedEffortMinutes: sql`excluded.planned_effort_minutes`,
              progressBasisPoints: sql`excluded.progress_basis_points`,
              actualEffortMinutes: sql`excluded.actual_effort_minutes`,
              prorationWeightBp: sql`excluded.proration_weight_bp`,
              dailyPlan: sql`excluded.daily_plan`,
              datedActuals: sql`excluded.dated_actuals`,
              actualStart: sql`excluded.actual_start`,
              actualFinish: sql`excluded.actual_finish`,
              updatedAt: sql`now()`,
            },
          });
      }

      // The parent links, once every row above exists. An UPDATE driven by a
      // VALUES list, so it stays one statement however deep or wide the tree is.
      const parented = next.tasks.filter((task) => task.parentId !== null);
      if (parented.length > 0) {
        const pairs = sql.join(
          parented.map((task) => sql`(${task.id}::uuid, ${task.parentId}::uuid)`),
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

      const dependencyValues = next.tasks.flatMap((task) =>
        task.dependencies.map((dependency) => ({
          tenantId: request.tenantId,
          wbsId: request.projectId,
          predecessorTaskId: dependency.predecessorId,
          successorTaskId: task.id,
          type: dependency.type,
          lagWorkingDays: dependency.lagWorkingDays,
        })),
      );
      if (dependencyValues.length > 0) {
        await transaction.insert(taskDependency).values(dependencyValues);
      }

      // Design 0009. The snapshot is taken from `current` — the state AT
      // `expectedRevision` — not from `next`, even though for this command they
      // differ only by the counter. Reading the pre-transition state is what makes
      // "the frozen plan and the revision it is pinned to agree" true by
      // construction rather than by the transition happening to be a no-op.
      //
      // Only LEAF rows are frozen. A summary row does not roll up (`calculateEvm`
      // skips it), so storing one would put a number in the table that no reader
      // may add, and the first person to sum the column would double-count.
      if (request.command.type === "baseline.publish") {
        // `leafTaskIds` rather than a local re-derivation: this set decides what
        // the baseline's BAC is, and the rollup's BAC comes from the same
        // predicate. Two hand-written copies agree by transcription, which is not
        // a property anything enforces.
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
          .filter((task) => leaves.has(task.id))
          .map((task) => ({
            tenantId: request.tenantId,
            wbsId: request.projectId,
            version: current.nextBaselineVersion,
            taskId: task.id,
            parentTaskId: task.parentId,
            dailyPlan: task.dailyPlan,
            plannedEffortMinutes: task.plannedEffortMinutes,
            assigneeMemberId: task.assigneeMemberId,
            name: task.name,
            seq: task.seq,
          }));
        if (frozen.length > 0) {
          await transaction.insert(baselineTask).values(frozen);
        }
      }

      const resultRevision = actualRevision + 1n;
      // Advance the per-project display-No. counter transactionally alongside the
      // revision bump, under the project row lock held above (§F-1). A task.add or
      // generateSubtasks batch leaves `next.nextTaskSeq` ahead by the number of
      // tasks created; every other command leaves it unchanged.
      await transaction
        .update(wbs)
        .set({
          revision: resultRevision,
          nextTaskSeq: next.nextTaskSeq,
          nextBaselineVersion: next.nextBaselineVersion,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(wbs.tenantId, request.tenantId),
            eq(wbs.id, request.projectId),
            eq(wbs.revision, actualRevision),
          ),
        );
      await transaction.insert(auditEvent).values({
        tenantId: request.tenantId,
        wbsId: request.projectId,
        wbsRevision: resultRevision,
        actorType: request.actor.type,
        actorId: request.actor.id,
        commandType: request.command.type,
        payload: {
          command: request.command,
          expectedRevision: request.expectedRevision.toString(),
          idempotencyKey: request.idempotencyKey,
        },
      });
      await transaction.insert(commandReceipt).values({
        tenantId: request.tenantId,
        wbsId: request.projectId,
        idempotencyKey: request.idempotencyKey,
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
