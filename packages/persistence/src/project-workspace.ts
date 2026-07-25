import type { ProjectState } from "@vecta/application";
import type { NeonHttpReadDatabase } from "./neon-http-database.js";
import type { PersistedProjectRecord } from "./project-record.js";
import {
  projectDetailQueries,
  projectHeaderQuery,
} from "./project-read-queries.js";
import {
  ProjectRepository,
  toProjectDetailRecord,
} from "./project-repository.js";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { schema } from "./schema.js";

export interface ProjectWorkspace {
  readonly revision: bigint;
  readonly current: ProjectState;
}

/**
 * The read model never looks at the audit trail, so it is typed out of the
 * mapper's input: readers that skip the `audit_events` table (the batched HTTP
 * one) satisfy this directly, and a full {@link PersistedProjectRecord} still
 * does too.
 */
export type ProjectStateSource = Omit<PersistedProjectRecord, "auditEvents">;

export function toProjectState(record: ProjectStateSource): ProjectState {
  const dependenciesByTask = new Map<
    string,
    Array<{ predecessorId: string; type: "FS" | "SS" | "FF" | "SF"; lagWorkingDays: number }>
  >();
  for (const dependency of record.dependencies) {
    const entries = dependenciesByTask.get(dependency.successorTaskId) ?? [];
    entries.push({
      predecessorId: dependency.predecessorTaskId,
      type: dependency.type,
      lagWorkingDays: dependency.lagWorkingDays,
    });
    dependenciesByTask.set(dependency.successorTaskId, entries);
  }

  return {
    id: record.project.id,
    name: record.project.name,
    projectStart: record.project.projectStart,
    statusDate: record.project.statusDate,
    currency: "JPY",
    defaultCalendarId: record.project.defaultCalendarId,
    calendars: record.calendars.map(({ id, name, workingWeekdays, nonWorkingDates }) => ({
      id,
      name,
      workingWeekdays,
      nonWorkingDates,
    })),
    members: record.members.map(({ id, name, calendarId, dailyCapacityMinutes }) => ({
      id,
      name,
      calendarId,
      dailyCapacityMinutes,
    })),
    processes: record.processes.map(({ id, name, sortOrder }) => ({ id, name, sortOrder })),
    products: record.products.map(({ id, name, sortOrder }) => ({ id, name, sortOrder })),
    templates: record.templates.map(({ id, name, sortOrder, subtasks }) => ({
      id,
      name,
      sortOrder,
      subtasks: subtasks.map((step) => ({ ...step })),
    })),
    nextTaskSeq: record.project.nextTaskSeq,
    tasks: record.tasks.map((task) => ({
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
      dailyPlan: task.dailyPlan,
      actualStart: task.actualStart,
      actualFinish: task.actualFinish,
      dependencies: dependenciesByTask.get(task.id) ?? [],
    })),
  };
}

export function toProjectWorkspace(record: ProjectStateSource): ProjectWorkspace {
  return { revision: record.project.revision, current: toProjectState(record) };
}

/** What every workspace reader offers, whatever transport it runs on. */
export interface ProjectWorkspaceReader {
  load(tenantId: string, projectId: string): Promise<ProjectWorkspace | null>;
}

export class ProjectWorkspaceRepository implements ProjectWorkspaceReader {
  constructor(private readonly database: NodePgDatabase<typeof schema>) {}
  async load(tenantId: string, projectId: string): Promise<ProjectWorkspace | null> {
    return this.database.transaction(
      async (transaction) => {
        const record = await new ProjectRepository(transaction).load(tenantId, projectId);
        return record === null ? null : toProjectWorkspace(record);
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }
}

/**
 * The workspace read as ONE network round trip (ADR 0012 post-cutover perf).
 *
 * {@link ProjectWorkspaceRepository} costs `BEGIN` + eight sequential SELECTs +
 * `COMMIT` — ten round trips on the wire protocol, on top of the WebSocket
 * handshake a fresh pool pays per Worker invocation. Over the Neon HTTP
 * transport the same eight queries go out as a single `db.batch(...)` request,
 * which Neon runs server-side as one non-interactive transaction.
 *
 * The queries and the row→record mapping are the SAME code the pool-backed
 * repository runs (`projectHeaderQuery` / `projectDetailQueries` /
 * `toProjectDetailRecord`), so the Postgres integration tests that cover those
 * cover this reader's behaviour too; only the execution strategy differs.
 *
 * The batch's REPEATABLE READ / READ ONLY isolation — the same the pool-backed
 * reader asks for — is carried by the HTTP client itself, see
 * {@link openNeonHttpReadDatabase}.
 */
export class NeonHttpProjectWorkspaceReader implements ProjectWorkspaceReader {
  constructor(private readonly database: NeonHttpReadDatabase) {}

  async load(tenantId: string, projectId: string): Promise<ProjectWorkspace | null> {
    const details = projectDetailQueries(this.database, tenantId, projectId);
    const [
      headerRows,
      calendars,
      members,
      processes,
      products,
      templates,
      tasks,
      dependencies,
    ] = await this.database.batch([
      projectHeaderQuery(this.database, tenantId, projectId),
      details.calendars,
      details.members,
      details.processes,
      details.products,
      details.templates,
      details.tasks,
      details.dependencies,
    ]);

    const projectHeader = headerRows[0];
    if (projectHeader === undefined) {
      return null;
    }
    return toProjectWorkspace(
      toProjectDetailRecord(projectHeader, {
        calendars,
        members,
        processes,
        products,
        templates,
        tasks,
        dependencies,
      }),
    );
  }
}
