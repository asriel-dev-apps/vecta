import { and, asc, desc, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  baselineTasks,
  projectBaselines,
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

/**
 * Any Drizzle handle a project READ can be built on: the node-postgres database
 * or transaction (Hyperdrive/pg and the Neon WebSocket pool) and the Neon HTTP
 * database. They differ only in how a built query is *executed* — sequentially
 * on the wire protocol, or batched into one HTTP request — so the queries
 * themselves are written once here and shared by both readers. Sharing them is
 * what keeps `ProjectRepository.load` (covered by the Postgres integration
 * tests) and the batched HTTP reader from drifting apart.
 */
export type ProjectReadDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * The project header: identity, schedule anchors, and the optimistic-concurrency
 * revision. Joined to `tenants` for the tenant name, and always keyed on the
 * composite `(tenantId, id)` so a row is never reachable by global id alone.
 */
export function projectHeaderQuery(
  database: ProjectReadDatabase,
  tenantId: string,
  projectId: string,
) {
  return database
    .select({
      tenantId: tenants.id,
      tenantName: tenants.name,
      projectId: projects.id,
      name: projects.name,
      currency: projects.currency,
      timezone: projects.timezone,
      projectStart: projects.projectStart,
      statusDate: projects.statusDate,
      defaultCalendarId: projects.defaultCalendarId,
      revision: projects.revision,
      nextTaskSeq: projects.nextTaskSeq,
      nextBaselineVersion: projects.nextBaselineVersion,
    })
    .from(projects)
    .innerJoin(tenants, eq(tenants.id, projects.tenantId))
    .where(and(eq(projects.tenantId, tenantId), eq(projects.id, projectId)))
    .limit(1);
}

/**
 * The seven child-table reads that make up a project's workspace, each ordered
 * deterministically so both render sides (SSR + hydrate) see the same sequence.
 * `auditEvents` is deliberately NOT among them: the read model
 * (`toProjectState`) never looks at it, and it is the one table that grows
 * without bound, so reading it was pure cost on every page view.
 */
export function projectDetailQueries(
  database: ProjectReadDatabase,
  tenantId: string,
  projectId: string,
) {
  return {
    calendars: database
      .select()
      .from(projectCalendars)
      .where(
        and(
          eq(projectCalendars.tenantId, tenantId),
          eq(projectCalendars.projectId, projectId),
        ),
      )
      .orderBy(asc(projectCalendars.id)),
    members: database
      .select()
      .from(members)
      .where(and(eq(members.tenantId, tenantId), eq(members.projectId, projectId)))
      .orderBy(asc(members.id)),
    processes: database
      .select()
      .from(processes)
      .where(and(eq(processes.tenantId, tenantId), eq(processes.projectId, projectId)))
      .orderBy(asc(processes.sortOrder), asc(processes.id)),
    products: database
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.projectId, projectId)))
      .orderBy(asc(products.sortOrder), asc(products.id)),
    templates: database
      .select()
      .from(subtaskTemplates)
      .where(
        and(
          eq(subtaskTemplates.tenantId, tenantId),
          eq(subtaskTemplates.projectId, projectId),
        ),
      )
      .orderBy(asc(subtaskTemplates.sortOrder), asc(subtaskTemplates.id)),
    tasks: database
      .select()
      .from(tasks)
      .where(and(eq(tasks.tenantId, tenantId), eq(tasks.projectId, projectId)))
      .orderBy(asc(tasks.sortOrder), asc(tasks.id)),
    dependencies: database
      .select()
      .from(taskDependencies)
      .where(
        and(
          eq(taskDependencies.tenantId, tenantId),
          eq(taskDependencies.projectId, projectId),
        ),
      )
      .orderBy(
        asc(taskDependencies.successorTaskId),
        asc(taskDependencies.predecessorTaskId),
        asc(taskDependencies.type),
      ),
    // Design 0009. In the SAME batch, so the baseline costs no extra round trip —
    // and a second batch for the dashboard alone WOULD be one, which the 2026-07-26
    // round-trip fold exists to prevent. The rows are read on every project screen,
    // including ones that do not show them; that is bytes, not latency, and a
    // project's baseline is one header plus its leaves.
    baseline: database
      .select()
      .from(projectBaselines)
      .where(
        and(
          eq(projectBaselines.tenantId, tenantId),
          eq(projectBaselines.projectId, projectId),
        ),
      )
      // Newest first: the read path takes max(version), and ordering here means the
      // caller never has to sort to find it.
      .orderBy(desc(projectBaselines.version))
      .limit(1),
    baselineTasks: database
      .select()
      .from(baselineTasks)
      .where(
        and(eq(baselineTasks.tenantId, tenantId), eq(baselineTasks.projectId, projectId)),
      )
      .orderBy(desc(baselineTasks.version), asc(baselineTasks.seq)),
  };
}
