import { and, asc, eq, type ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import type {
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
  auditEvents,
  members,
  processes,
  products,
  projectCalendars,
  projects,
  schema,
  subtaskTemplates,
  taskDependencies,
  tasks,
  tenants,
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

export class ProjectRepository {
  constructor(
    private readonly database:
      | NodePgDatabase<typeof schema>
      | NodePgTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>,
  ) {}

  async save(record: PersistedProjectRecord): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.insert(tenants).values(record.tenant);
      await transaction.insert(projects).values(record.project);

      if (record.calendars.length > 0) {
        await transaction.insert(projectCalendars).values(
          record.calendars.map((calendar) => ({
            ...calendar,
            workingWeekdays: [...calendar.workingWeekdays],
            nonWorkingDates: [...calendar.nonWorkingDates],
          })),
        );
      }
      if (record.members.length > 0) {
        await transaction.insert(members).values([...record.members]);
      }
      if (record.processes.length > 0) {
        await transaction.insert(processes).values([...record.processes]);
      }
      if (record.products.length > 0) {
        await transaction.insert(products).values([...record.products]);
      }
      if (record.templates.length > 0) {
        await transaction.insert(subtaskTemplates).values(
          record.templates.map((template) => ({
            ...template,
            subtasks: template.subtasks,
          })),
        );
      }
      if (record.tasks.length > 0) {
        // Self-referential parent FK is satisfied within a single batched
        // insert (immediate constraints are checked at statement end).
        await transaction.insert(tasks).values(
          record.tasks.map((task) => ({ ...task, dailyPlan: task.dailyPlan })),
        );
      }
      if (record.dependencies.length > 0) {
        await transaction.insert(taskDependencies).values([...record.dependencies]);
      }
      if (record.auditEvents.length > 0) {
        await transaction.insert(auditEvents).values([...record.auditEvents]);
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
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.projectId, projectId)))
      .orderBy(asc(auditEvents.sequence));

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
        ...withoutGeneratedFields(row, ["sequence"]),
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
      withoutGeneratedFields(row, ["createdAt", "updatedAt"]),
    ),
    members: rows.members.map(
      (row): MemberRecord => withoutGeneratedFields(row, ["createdAt", "updatedAt"]),
    ),
    processes: rows.processes.map(
      (row): ProcessRecord => withoutGeneratedFields(row, ["createdAt", "updatedAt"]),
    ),
    products: rows.products.map(
      (row): ProductRecord => withoutGeneratedFields(row, ["createdAt", "updatedAt"]),
    ),
    templates: rows.templates.map(
      (row): TemplateRecord => ({
        ...withoutGeneratedFields(row, ["createdAt", "updatedAt"]),
        subtasks: row.subtasks as readonly SubtaskTemplateStepRecord[],
      }),
    ),
    tasks: rows.tasks.map(
      (row): TaskRecord => ({
        ...withoutGeneratedFields(row, ["createdAt", "updatedAt"]),
        dailyPlan: row.dailyPlan as Record<string, number>,
        datedActuals: row.datedActuals as Record<string, number>,
      }),
    ),
    dependencies: rows.dependencies.map(
      (row): TaskDependencyRecord => withoutGeneratedFields(row, ["createdAt"]),
    ),
  };
}
