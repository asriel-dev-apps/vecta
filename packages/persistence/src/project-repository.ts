import { and, asc, eq, sql, type ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import type {
  AuditEventRecord,
  MemberRecord,
  PersistedProjectRecord,
  ProcessRecord,
  ProductRecord,
  SubtaskTemplateStepRecord,
  TaskDependencyRecord,
  TaskRecord,
  TemplateRecord,
} from "./project-record.js";
import {
  projectDetailQueries,
  projectHeaderQuery,
} from "./project-read-queries.js";
import {
  auditEvent,
  calendar,
  member,
  process,
  product,
  project,
  schema,
  subtaskTemplate,
  task,
  taskDependency,
  tenant,
  wbs,
} from "./schema.js";

function withoutGeneratedFields<T extends object>(
  value: T,
  fields: readonly (keyof T)[],
): T {
  const copy = { ...value };
  for (const field of fields) {
    Reflect.deleteProperty(copy, field);
  }
  return copy;
}

/** Record field `projectId` is the WBS id; the column is `wbs_id`. */
function toWbsColumn<T extends { projectId: string }>(
  row: T,
): Omit<T, "projectId"> & { wbsId: string } {
  const { projectId, ...rest } = row;
  return { ...rest, wbsId: projectId };
}

function fromWbsColumn<T extends { wbsId: string }>(
  row: T,
): Omit<T, "wbsId"> & { projectId: string } {
  const { wbsId, ...rest } = row;
  return { ...rest, projectId: wbsId };
}

function auditToRow(event: AuditEventRecord) {
  const { projectId, projectRevision, ...rest } = event;
  return { ...rest, wbsId: projectId, wbsRevision: projectRevision };
}

export class ProjectRepository {
  constructor(
    private readonly database:
      | NodePgDatabase<typeof schema>
      | NodePgTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>,
  ) {}

  async save(record: PersistedProjectRecord): Promise<void> {
    await this.database.transaction(async (transaction) => {
      // Content-table triggers allow the write only while `vecta.wbs_write` is
      // `<wbsId>:<revision>`. save creates the WBS; it does not advance one,
      // so the marker is `<id>:0`.
      await transaction.execute(sql`
        select set_config(
          'vecta.wbs_write',
          ${`${record.project.id}:0`},
          true
        )
      `);
      await transaction.insert(tenant).values(record.tenant);
      const [parent] = await transaction
        .insert(project)
        .values({
          tenantId: record.project.tenantId,
          name: record.project.name,
        })
        .returning({ id: project.id });
      if (parent === undefined) {
        throw new Error("project row was not created");
      }
      await transaction.insert(wbs).values({
        ...record.project,
        projectId: parent.id,
        tags: [],
      });

      if (record.calendars.length > 0) {
        await transaction.insert(calendar).values(
          record.calendars.map((row) => ({
            ...toWbsColumn(row),
            workingWeekdays: [...row.workingWeekdays],
            nonWorkingDates: [...row.nonWorkingDates],
          })),
        );
      }
      if (record.members.length > 0) {
        await transaction.insert(member).values(record.members.map((row) => toWbsColumn(row)));
      }
      if (record.processes.length > 0) {
        await transaction.insert(process).values(record.processes.map((row) => toWbsColumn(row)));
      }
      if (record.products.length > 0) {
        await transaction.insert(product).values(record.products.map((row) => toWbsColumn(row)));
      }
      if (record.templates.length > 0) {
        await transaction.insert(subtaskTemplate).values(
          record.templates.map((template) => ({
            ...toWbsColumn(template),
            subtasks: template.subtasks,
          })),
        );
      }
      if (record.tasks.length > 0) {
        // Self-referential parent FK is satisfied within a single batched
        // insert (immediate constraints are checked at statement end).
        await transaction.insert(task).values(
          record.tasks.map((row) => ({ ...toWbsColumn(row), dailyPlan: row.dailyPlan })),
        );
      }
      if (record.dependencies.length > 0) {
        await transaction
          .insert(taskDependency)
          .values(record.dependencies.map((row) => toWbsColumn(row)));
      }
      if (record.auditEvents.length > 0) {
        await transaction.insert(auditEvent).values(record.auditEvents.map((row) => auditToRow(row)));
      }
    });
  }

  async load(tenantId: string, projectId: string): Promise<PersistedProjectRecord | null> {
    const [projectHeader] = await projectHeaderQuery(this.database, tenantId, projectId);

    if (projectHeader === undefined) {
      return null;
    }

    const details = projectDetailQueries(this.database, tenantId, projectId);
    const calendarRows = await details.calendars;
    const memberRows = await details.members;
    const processRows = await details.processes;
    const productRows = await details.products;
    const templateRows = await details.templates;
    const taskRows = await details.tasks;
    const dependencyRows = await details.dependencies;
    // The full record carries the audit trail (the save/round-trip contract);
    // the workspace read model does not, so `projectDetailQueries` leaves it out
    // and it is read here only (see `project-read-queries.ts`).
    const auditRows = await this.database
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, tenantId), eq(auditEvent.wbsId, projectId)))
      .orderBy(asc(auditEvent.sequence));

    return {
      ...toProjectDetailRecord(projectHeader, {
        calendars: calendarRows,
        members: memberRows,
        processes: processRows,
        products: productRows,
        templates: templateRows,
        tasks: taskRows,
        dependencies: dependencyRows,
      }),
      auditEvents: auditRows.map((row) => ({
        id: row.id,
        tenantId: row.tenantId,
        projectId: row.wbsId,
        projectRevision: row.wbsRevision,
        actorType: row.actorType,
        actorId: row.actorId,
        commandType: row.commandType,
        payload: row.payload as Readonly<Record<string, unknown>>,
        occurredAt: new Date(row.occurredAt).toISOString(),
      })),
    };
  }
}

/** The header row shape both readers project the project/tenant identity from. */
export type ProjectHeaderRow = Awaited<
  ReturnType<typeof projectHeaderQuery>
>[number];

/** The seven child-table result sets, as returned by `projectDetailQueries`. */
export interface ProjectDetailRows {
  readonly calendars: Awaited<ReturnType<typeof projectDetailQueries>["calendars"]>;
  readonly members: Awaited<ReturnType<typeof projectDetailQueries>["members"]>;
  readonly processes: Awaited<ReturnType<typeof projectDetailQueries>["processes"]>;
  readonly products: Awaited<ReturnType<typeof projectDetailQueries>["products"]>;
  readonly templates: Awaited<ReturnType<typeof projectDetailQueries>["templates"]>;
  readonly tasks: Awaited<ReturnType<typeof projectDetailQueries>["tasks"]>;
  readonly dependencies: Awaited<
    ReturnType<typeof projectDetailQueries>["dependencies"]
  >;
}

/**
 * Project the header + child rows into the persisted record, minus the audit
 * trail. Shared by `ProjectRepository.load` (which appends `auditEvents`) and
 * the batched HTTP workspace reader (which never reads them), so the row→record
 * mapping — including which generated columns are stripped — exists once.
 */
export function toProjectDetailRecord(
  projectHeader: ProjectHeaderRow,
  rows: ProjectDetailRows,
): Omit<PersistedProjectRecord, "auditEvents"> {
  return {
    tenant: { id: projectHeader.tenantId, name: projectHeader.tenantName },
    project: {
      id: projectHeader.projectId,
      tenantId: projectHeader.tenantId,
      name: projectHeader.name,
      currency: projectHeader.currency,
      timezone: projectHeader.timezone,
      projectStart: projectHeader.projectStart,
      statusDate: projectHeader.statusDate,
      defaultCalendarId: projectHeader.defaultCalendarId,
      revision: projectHeader.revision,
      nextTaskSeq: projectHeader.nextTaskSeq,
      nextBaselineVersion: projectHeader.nextBaselineVersion,
    },
    calendars: rows.calendars.map((row) =>
      withoutGeneratedFields(fromWbsColumn(row), ["createdAt", "updatedAt"]),
    ),
    members: rows.members.map(
      (row): MemberRecord => withoutGeneratedFields(fromWbsColumn(row), ["createdAt", "updatedAt"]),
    ),
    processes: rows.processes.map(
      (row): ProcessRecord => withoutGeneratedFields(fromWbsColumn(row), ["createdAt", "updatedAt"]),
    ),
    products: rows.products.map(
      (row): ProductRecord => withoutGeneratedFields(fromWbsColumn(row), ["createdAt", "updatedAt"]),
    ),
    templates: rows.templates.map(
      (row): TemplateRecord => ({
        ...withoutGeneratedFields(fromWbsColumn(row), ["createdAt", "updatedAt"]),
        subtasks: row.subtasks as readonly SubtaskTemplateStepRecord[],
      }),
    ),
    tasks: rows.tasks.map(
      (row): TaskRecord => ({
        ...withoutGeneratedFields(fromWbsColumn(row), ["createdAt", "updatedAt"]),
        dailyPlan: row.dailyPlan as Record<string, number>,
        datedActuals: row.datedActuals as Record<string, number>,
      }),
    ),
    dependencies: rows.dependencies.map(
      (row): TaskDependencyRecord => withoutGeneratedFields(fromWbsColumn(row), ["createdAt"]),
    ),
  };
}
