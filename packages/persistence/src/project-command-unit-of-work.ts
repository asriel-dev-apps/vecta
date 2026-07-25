import { createHash } from "node:crypto";
import {
  applyEffortSchedule,
  IdempotencyConflictError,
  ProjectNotFoundError,
  ProjectVersionConflictError,
  type ProjectCommandExecution,
  type ProjectCommandRequest,
  type ProjectCommandUnitOfWork,
  type ProjectState,
  type SubtaskTemplateStep,
} from "@vecta/application";
import { and, asc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  auditEvents,
  commandReceipts,
  members,
  processes,
  products,
  projectCalendars,
  projects,
  schema,
  subtaskTemplates,
  taskDependencies,
  tasks,
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
          .from(commandReceipts)
          .where(
            and(
              eq(commandReceipts.tenantId, request.tenantId),
              eq(commandReceipts.projectId, request.projectId),
              eq(commandReceipts.idempotencyKey, request.idempotencyKey),
            ),
          )
          .limit(1);

      const replay = (receipt: typeof commandReceipts.$inferSelect) => {
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
        from projects
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
          id: projects.id,
          name: projects.name,
          projectStart: projects.projectStart,
          statusDate: projects.statusDate,
          currency: projects.currency,
          defaultCalendarId: projects.defaultCalendarId,
          nextTaskSeq: projects.nextTaskSeq,
        })
        .from(projects)
        .where(and(eq(projects.tenantId, request.tenantId), eq(projects.id, request.projectId)))
        .limit(1);
      if (projectRow === undefined) {
        throw new ProjectNotFoundError(request.projectId);
      }
      if (projectRow.currency !== "JPY") {
        throw new Error(`Unsupported application currency: ${projectRow.currency}`);
      }

      const taskRows = await transaction
        .select()
        .from(tasks)
        .where(and(eq(tasks.tenantId, request.tenantId), eq(tasks.projectId, request.projectId)))
        .orderBy(asc(tasks.sortOrder));
      const calendarRows = await transaction
        .select()
        .from(projectCalendars)
        .where(
          and(
            eq(projectCalendars.tenantId, request.tenantId),
            eq(projectCalendars.projectId, request.projectId),
          ),
        )
        .orderBy(asc(projectCalendars.id));
      const memberRows = await transaction
        .select()
        .from(members)
        .where(and(eq(members.tenantId, request.tenantId), eq(members.projectId, request.projectId)))
        .orderBy(asc(members.id));
      const processRows = await transaction
        .select()
        .from(processes)
        .where(
          and(eq(processes.tenantId, request.tenantId), eq(processes.projectId, request.projectId)),
        )
        .orderBy(asc(processes.sortOrder), asc(processes.id));
      const productRows = await transaction
        .select()
        .from(products)
        .where(
          and(eq(products.tenantId, request.tenantId), eq(products.projectId, request.projectId)),
        )
        .orderBy(asc(products.sortOrder), asc(products.id));
      const templateRows = await transaction
        .select()
        .from(subtaskTemplates)
        .where(
          and(
            eq(subtaskTemplates.tenantId, request.tenantId),
            eq(subtaskTemplates.projectId, request.projectId),
          ),
        )
        .orderBy(asc(subtaskTemplates.sortOrder), asc(subtaskTemplates.id));
      const dependencyRows = await transaction
        .select()
        .from(taskDependencies)
        .where(
          and(
            eq(taskDependencies.tenantId, request.tenantId),
            eq(taskDependencies.projectId, request.projectId),
          ),
        )
        .orderBy(
          asc(taskDependencies.successorTaskId),
          asc(taskDependencies.predecessorTaskId),
          asc(taskDependencies.type),
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
      const nextTaskById = new Map(next.tasks.map((task) => [task.id, task]));
      const nextMemberById = new Map(next.members.map((member) => [member.id, member]));
      const currentMemberIds = new Set(memberRows.map((member) => member.id));
      const nextProcessById = new Map(next.processes.map((process) => [process.id, process]));
      const currentProcessIds = new Set(processRows.map((process) => process.id));
      const nextProductById = new Map(next.products.map((product) => [product.id, product]));
      const currentProductIds = new Set(productRows.map((product) => product.id));
      const nextTemplateById = new Map(next.templates.map((template) => [template.id, template]));
      const currentTemplateIds = new Set(templateRows.map((template) => template.id));

      // Free all self-FK (parent), assignee, process, and product references so
      // deletes and inserts never collide with RESTRICT constraints.
      await transaction
        .delete(taskDependencies)
        .where(
          and(
            eq(taskDependencies.tenantId, request.tenantId),
            eq(taskDependencies.projectId, request.projectId),
          ),
        );
      if (taskRows.length > 0) {
        await transaction
          .update(tasks)
          .set({ parentTaskId: null, assigneeMemberId: null, processId: null, productId: null })
          .where(and(eq(tasks.tenantId, request.tenantId), eq(tasks.projectId, request.projectId)));
      }

      // Members: insert / update present, delete removed (now unreferenced).
      for (const member of next.members) {
        const values = {
          name: member.name,
          calendarId: member.calendarId,
          dailyCapacityMinutes: member.dailyCapacityMinutes,
        };
        if (currentMemberIds.has(member.id)) {
          await transaction
            .update(members)
            .set({ ...values, updatedAt: sql`now()` })
            .where(
              and(
                eq(members.tenantId, request.tenantId),
                eq(members.projectId, request.projectId),
                eq(members.id, member.id),
              ),
            );
        } else {
          await transaction.insert(members).values({
            id: member.id,
            tenantId: request.tenantId,
            projectId: request.projectId,
            ...values,
          });
        }
      }
      for (const member of memberRows) {
        if (!nextMemberById.has(member.id)) {
          await transaction
            .delete(members)
            .where(
              and(
                eq(members.tenantId, request.tenantId),
                eq(members.projectId, request.projectId),
                eq(members.id, member.id),
              ),
            );
        }
      }

      // Processes: insert / update present, delete removed (now unreferenced).
      for (const process of next.processes) {
        const values = { name: process.name, sortOrder: process.sortOrder };
        if (currentProcessIds.has(process.id)) {
          await transaction
            .update(processes)
            .set({ ...values, updatedAt: sql`now()` })
            .where(
              and(
                eq(processes.tenantId, request.tenantId),
                eq(processes.projectId, request.projectId),
                eq(processes.id, process.id),
              ),
            );
        } else {
          await transaction.insert(processes).values({
            id: process.id,
            tenantId: request.tenantId,
            projectId: request.projectId,
            ...values,
          });
        }
      }
      for (const process of processRows) {
        if (!nextProcessById.has(process.id)) {
          await transaction
            .delete(processes)
            .where(
              and(
                eq(processes.tenantId, request.tenantId),
                eq(processes.projectId, request.projectId),
                eq(processes.id, process.id),
              ),
            );
        }
      }

      // Products: insert / update present, delete removed (now unreferenced).
      for (const product of next.products) {
        const values = { name: product.name, sortOrder: product.sortOrder };
        if (currentProductIds.has(product.id)) {
          await transaction
            .update(products)
            .set({ ...values, updatedAt: sql`now()` })
            .where(
              and(
                eq(products.tenantId, request.tenantId),
                eq(products.projectId, request.projectId),
                eq(products.id, product.id),
              ),
            );
        } else {
          await transaction.insert(products).values({
            id: product.id,
            tenantId: request.tenantId,
            projectId: request.projectId,
            ...values,
          });
        }
      }
      for (const product of productRows) {
        if (!nextProductById.has(product.id)) {
          await transaction
            .delete(products)
            .where(
              and(
                eq(products.tenantId, request.tenantId),
                eq(products.projectId, request.projectId),
                eq(products.id, product.id),
              ),
            );
        }
      }

      // Templates: insert / update present, delete removed. Templates are never
      // referenced by a task (generation copies the step data), so a delete has
      // no referential guard (Design 0003 §E-1 locked decision 4).
      for (const template of next.templates) {
        const values = {
          name: template.name,
          sortOrder: template.sortOrder,
          subtasks: template.subtasks,
        };
        if (currentTemplateIds.has(template.id)) {
          await transaction
            .update(subtaskTemplates)
            .set({ ...values, updatedAt: sql`now()` })
            .where(
              and(
                eq(subtaskTemplates.tenantId, request.tenantId),
                eq(subtaskTemplates.projectId, request.projectId),
                eq(subtaskTemplates.id, template.id),
              ),
            );
        } else {
          await transaction.insert(subtaskTemplates).values({
            id: template.id,
            tenantId: request.tenantId,
            projectId: request.projectId,
            ...values,
          });
        }
      }
      for (const template of templateRows) {
        if (!nextTemplateById.has(template.id)) {
          await transaction
            .delete(subtaskTemplates)
            .where(
              and(
                eq(subtaskTemplates.tenantId, request.tenantId),
                eq(subtaskTemplates.projectId, request.projectId),
                eq(subtaskTemplates.id, template.id),
              ),
            );
        }
      }

      // Delete removed tasks (parent references already nulled above).
      for (const task of taskRows) {
        if (!nextTaskById.has(task.id)) {
          await transaction
            .delete(tasks)
            .where(
              and(
                eq(tasks.tenantId, request.tenantId),
                eq(tasks.projectId, request.projectId),
                eq(tasks.id, task.id),
              ),
            );
        }
      }

      // Upsert task native columns (parent deferred to a second pass so every
      // parent target exists before the self-FK is set).
      const currentTaskIds = new Set(taskRows.map((task) => task.id));
      for (const task of next.tasks) {
        const values = {
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
          actualStart: task.actualStart,
          actualFinish: task.actualFinish,
        };
        if (currentTaskIds.has(task.id)) {
          await transaction
            .update(tasks)
            .set({ ...values, parentTaskId: null, updatedAt: sql`now()` })
            .where(
              and(
                eq(tasks.tenantId, request.tenantId),
                eq(tasks.projectId, request.projectId),
                eq(tasks.id, task.id),
              ),
            );
        } else {
          await transaction.insert(tasks).values({
            id: task.id,
            tenantId: request.tenantId,
            projectId: request.projectId,
            parentTaskId: null,
            ...values,
          });
        }
      }
      for (const task of next.tasks) {
        if (task.parentId !== null) {
          await transaction
            .update(tasks)
            .set({ parentTaskId: task.parentId })
            .where(
              and(
                eq(tasks.tenantId, request.tenantId),
                eq(tasks.projectId, request.projectId),
                eq(tasks.id, task.id),
              ),
            );
        }
      }

      const dependencyValues = next.tasks.flatMap((task) =>
        task.dependencies.map((dependency) => ({
          tenantId: request.tenantId,
          projectId: request.projectId,
          predecessorTaskId: dependency.predecessorId,
          successorTaskId: task.id,
          type: dependency.type,
          lagWorkingDays: dependency.lagWorkingDays,
        })),
      );
      if (dependencyValues.length > 0) {
        await transaction.insert(taskDependencies).values(dependencyValues);
      }

      const resultRevision = actualRevision + 1n;
      // Advance the per-project display-No. counter transactionally alongside the
      // revision bump, under the project row lock held above (§F-1). A task.add or
      // generateSubtasks batch leaves `next.nextTaskSeq` ahead by the number of
      // tasks created; every other command leaves it unchanged.
      await transaction
        .update(projects)
        .set({ revision: resultRevision, nextTaskSeq: next.nextTaskSeq, updatedAt: sql`now()` })
        .where(
          and(
            eq(projects.tenantId, request.tenantId),
            eq(projects.id, request.projectId),
            eq(projects.revision, actualRevision),
          ),
        );
      await transaction.insert(auditEvents).values({
        tenantId: request.tenantId,
        projectId: request.projectId,
        projectRevision: resultRevision,
        actorType: request.actor.type,
        actorId: request.actor.id,
        commandType: request.command.type,
        payload: {
          command: request.command,
          expectedRevision: request.expectedRevision.toString(),
          idempotencyKey: request.idempotencyKey,
        },
      });
      await transaction.insert(commandReceipts).values({
        tenantId: request.tenantId,
        projectId: request.projectId,
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
