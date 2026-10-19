import { and, asc, desc, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  baselineTask,
  baseline,
  member,
  process,
  product,
  calendar,
  wbs,
  schema,
  subtaskTemplate,
  taskDependency,
  task,
  tenant,
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
 * revision. Joined to `tenant` for the tenant name, and always keyed on the
 * composite `(tenantId, id)` so a row is never reachable by global id alone.
 */
export function projectHeaderQuery(
  database: ProjectReadDatabase,
  tenantId: string,
  projectId: string,
) {
  return database
    .select({
      tenantId: tenant.id,
      tenantName: tenant.name,
      projectId: wbs.id,
      name: wbs.name,
      currency: wbs.currency,
      timezone: wbs.timezone,
      projectStart: wbs.projectStart,
      statusDate: wbs.statusDate,
      defaultCalendarId: wbs.defaultCalendarId,
      revision: wbs.revision,
      nextTaskSeq: wbs.nextTaskSeq,
      nextBaselineVersion: wbs.nextBaselineVersion,
    })
    .from(wbs)
    .innerJoin(tenant, eq(tenant.id, wbs.tenantId))
    .where(and(eq(wbs.tenantId, tenantId), eq(wbs.id, projectId)))
    .limit(1);
}

/**
 * The seven child-table reads that make up a project's workspace, each ordered
 * deterministically so both render sides (SSR + hydrate) see the same sequence.
 * `auditEvent` is deliberately NOT among them: the read model
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
      .from(calendar)
      .where(
        and(
          eq(calendar.tenantId, tenantId),
          eq(calendar.wbsId, projectId),
        ),
      )
      .orderBy(asc(calendar.id)),
    members: database
      .select()
      .from(member)
      .where(and(eq(member.tenantId, tenantId), eq(member.wbsId, projectId)))
      .orderBy(asc(member.id)),
    processes: database
      .select()
      .from(process)
      .where(and(eq(process.tenantId, tenantId), eq(process.wbsId, projectId)))
      .orderBy(asc(process.sortOrder), asc(process.id)),
    products: database
      .select()
      .from(product)
      .where(and(eq(product.tenantId, tenantId), eq(product.wbsId, projectId)))
      .orderBy(asc(product.sortOrder), asc(product.id)),
    templates: database
      .select()
      .from(subtaskTemplate)
      .where(
        and(
          eq(subtaskTemplate.tenantId, tenantId),
          eq(subtaskTemplate.wbsId, projectId),
        ),
      )
      .orderBy(asc(subtaskTemplate.sortOrder), asc(subtaskTemplate.id)),
    tasks: database
      .select()
      .from(task)
      .where(and(eq(task.tenantId, tenantId), eq(task.wbsId, projectId)))
      .orderBy(asc(task.sortOrder), asc(task.id)),
    dependencies: database
      .select()
      .from(taskDependency)
      .where(
        and(
          eq(taskDependency.tenantId, tenantId),
          eq(taskDependency.wbsId, projectId),
        ),
      )
      .orderBy(
        asc(taskDependency.successorTaskId),
        asc(taskDependency.predecessorTaskId),
        asc(taskDependency.type),
      ),
    // Design 0009. In the SAME batch, so the baseline costs no extra round trip —
    // and a second batch for the dashboard alone WOULD be one, which the 2026-07-26
    // round-trip fold exists to prevent. The rows are read on every project screen,
    // including ones that do not show them; that is bytes, not latency, and a
    // project's baseline is one header plus its leaves.
    baseline: database
      .select()
      .from(baseline)
      .where(
        and(
          eq(baseline.tenantId, tenantId),
          eq(baseline.wbsId, projectId),
        ),
      )
      // Newest first: the read path takes max(version), and ordering here means the
      // caller never has to sort to find it.
      .orderBy(desc(baseline.version))
      .limit(1),
    baselineTasks: database
      .select()
      .from(baselineTask)
      .where(
        and(eq(baselineTask.tenantId, tenantId), eq(baselineTask.wbsId, projectId)),
      )
      .orderBy(desc(baselineTask.version), asc(baselineTask.seq)),
  };
}
