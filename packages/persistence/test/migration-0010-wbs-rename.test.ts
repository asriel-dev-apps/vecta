import { readFile } from "node:fs/promises";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "./database.js";

/**
 * Migration 0010 — singular table names, `projects` → `wbs`, and a project above
 * each wbs.
 *
 * Applied to a database that already holds two tenants' data, so every claim is
 * about rows that existed BEFORE the migration:
 *
 *   1. each wbs got a project (same tenant, same name) and its per-wbs membership
 *      moved onto that project with its role;
 *   2. the rename moved no data: task, dependency and baseline row sets are
 *      identical before and after, compared in full;
 *   3. the old names are gone and the new ones exist;
 *   4. `wbs.project_id` is NOT NULL and its foreign key is tenant-scoped. These
 *      two are the negative controls: each must fail with the specific
 *      PostgreSQL error, not merely "something threw".
 */

const drizzleDir = new URL("../drizzle/", import.meta.url);

interface JournalEntry {
  readonly idx: number;
  readonly tag: string;
}

async function orderedJournal(): Promise<readonly JournalEntry[]> {
  const journal = JSON.parse(
    await readFile(new URL("meta/_journal.json", drizzleDir), "utf8"),
  ) as { entries: JournalEntry[] };
  return [...journal.entries].sort((left, right) => left.idx - right.idx);
}

async function applyMigration(client: Client, tag: string): Promise<void> {
  const sql = await readFile(new URL(`${tag}.sql`, drizzleDir), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed.length > 0) await client.query(trimmed);
  }
}

const uuid = (prefix: string, tail: number) =>
  `${prefix}0000000-0000-4000-8000-${tail.toString(16).padStart(12, "0")}`;

const tenantA = uuid("a", 1);
const tenantB = uuid("b", 1);
const wbsA = uuid("1", 1);
const wbsB = uuid("1", 2);
const taskParent = uuid("2", 1);
const taskChild = uuid("2", 2);
const taskB = uuid("2", 3);
const dependencyId = uuid("3", 1);
const memberA = uuid("4", 1);
const principalEditor = uuid("5", 1);
const principalViewer = uuid("5", 2);

type Row = Record<string, unknown>;

/** The full row set of a table, as JSON, with the renamed `project_id` column dropped. */
async function rowSet(client: Client, table: string, projectColumn: string): Promise<Row[]> {
  const result = await client.query<{ r: Row }>(
    `select to_jsonb(t) - '${projectColumn}' as r from "${table}" as t order by to_jsonb(t)::text`,
  );
  return result.rows.map((row) => row.r);
}

async function pgError(work: Promise<unknown>): Promise<{ code?: string; constraint?: string; column?: string }> {
  try {
    await work;
  } catch (error) {
    return error as { code?: string; constraint?: string; column?: string };
  }
  throw new Error("expected the statement to be rejected, but it succeeded");
}

describe("migration 0010 wbs rename", () => {
  let client: Client;
  let testDatabase: TestDatabase;
  let tasksBefore: Row[];
  let dependenciesBefore: Row[];
  let baselinesBefore: Row[];
  let baselineTasksBefore: Row[];

  beforeAll(async () => {
    testDatabase = await startTestDatabase("migration_0010");
    client = testDatabase.client;

    const journal = await orderedJournal();
    for (const entry of journal.filter((candidate) => candidate.idx < 10)) {
      await applyMigration(client, entry.tag);
    }

    await client.query(
      `insert into tenants (id, name) values ($1, 'Tenant A'), ($2, 'Tenant B')`,
      [tenantA, tenantB],
    );
    await client.query(
      `insert into projects (id, tenant_id, name, project_start, status_date) values
         ($1, $3, 'Alpha plan', '2026-01-05', '2026-02-02'),
         ($2, $4, 'Beta plan', '2026-03-02', '2026-03-09')`,
      [wbsA, wbsB, tenantA, tenantB],
    );
    for (const [tenant, wbs] of [
      [tenantA, wbsA],
      [tenantB, wbsB],
    ] as const) {
      await client.query(
        `insert into project_calendars (tenant_id, project_id, id, name, working_weekdays, non_working_dates)
         values ($1, $2, 'standard', 'Standard', '{1,2,3,4,5}', '{}')`,
        [tenant, wbs],
      );
    }
    await client.query(
      `insert into members (id, tenant_id, project_id, name, calendar_id, daily_capacity_minutes, cost_rate_minor_per_hour)
       values ($1, $2, $3, 'Member One', 'standard', 480, 5000)`,
      [memberA, tenantA, wbsA],
    );
    await client.query(
      `insert into tasks (id, tenant_id, project_id, parent_task_id, sort_order, name, note, assignee_member_id,
                          planned_effort_minutes, progress_basis_points, seq, daily_plan)
       values ($1, $4, $5, null, 0, 'Parent task', 'first note', null, 960, 2500, 1, '{"2026-01-05": 480}'),
              ($2, $4, $5, $1, 1, 'Child task', '', $6, 480, 0, 2, '{}'),
              ($3, $7, $8, null, 0, 'Beta task', 'beta note', null, 120, 10000, 1, '{}')`,
      [taskParent, taskChild, taskB, tenantA, wbsA, memberA, tenantB, wbsB],
    );
    await client.query(
      `insert into task_dependencies (id, tenant_id, project_id, predecessor_task_id, successor_task_id, type, lag_working_days)
       values ($1, $2, $3, $4, $5, 'SS', 2)`,
      [dependencyId, tenantA, wbsA, taskParent, taskChild],
    );
    await client.query(
      `insert into project_baselines (tenant_id, project_id, version, source_revision, published_by_actor_type, published_by_actor_id, published_at)
       values ($1, $2, 1, 7, 'HUMAN', 'actor-one', '2026-02-01T00:00:00Z')`,
      [tenantA, wbsA],
    );
    await client.query(
      `insert into baseline_tasks (tenant_id, project_id, version, task_id, parent_task_id, daily_plan, planned_effort_minutes, assignee_member_id, name, seq)
       values ($1, $2, 1, $3, null, '{"2026-01-05": 480}', 960, null, 'Parent task', 1),
              ($1, $2, 1, $4, $3, '{}', 480, $5, 'Child task', 2)`,
      [tenantA, wbsA, taskParent, taskChild, memberA],
    );

    await client.query(
      `insert into principals (id, issuer, subject, type, display_name) values
         ($1, 'https://issuer.example', 'subject-editor', 'HUMAN', 'Editor Person'),
         ($2, 'https://issuer.example', 'subject-viewer', 'HUMAN', 'Viewer Person')`,
      [principalEditor, principalViewer],
    );
    await client.query(
      `insert into tenant_memberships (tenant_id, principal_id, role) values
         ($1, $3, 'MEMBER'), ($1, $4, 'MEMBER'), ($2, $3, 'MEMBER')`,
      [tenantA, tenantB, principalEditor, principalViewer],
    );
    await client.query(
      `insert into project_memberships (tenant_id, project_id, principal_id, role) values
         ($1, $2, $4, 'EDITOR'), ($1, $2, $5, 'VIEWER'), ($3, $6, $4, 'OWNER')`,
      [tenantA, wbsA, tenantB, principalEditor, principalViewer, wbsB],
    );

    tasksBefore = await rowSet(client, "tasks", "project_id");
    dependenciesBefore = await rowSet(client, "task_dependencies", "project_id");
    baselinesBefore = await rowSet(client, "project_baselines", "project_id");
    baselineTasksBefore = await rowSet(client, "baseline_tasks", "project_id");
    expect(tasksBefore).toHaveLength(3);
    expect(dependenciesBefore).toHaveLength(1);
    expect(baselinesBefore).toHaveLength(1);
    expect(baselineTasksBefore).toHaveLength(2);

    await applyMigration(client, "0010_m1_wbs_rename");
  });

  afterAll(async () => {
    await testDatabase.dispose();
  });

  it("gives each wbs a project of the same name in the same tenant", async () => {
    const result = await client.query<Row>(
      `select w.id as wbs_id, w.name as wbs_name, w.tenant_id as wbs_tenant,
              p.id as project_id, p.name as project_name, p.tenant_id as project_tenant
       from wbs as w join project as p on p.id = w.project_id
       order by w.name`,
    );
    expect(result.rows.map((row) => ({ ...row, project_id: typeof row.project_id }))).toEqual([
      {
        wbs_id: wbsA,
        wbs_name: "Alpha plan",
        wbs_tenant: tenantA,
        project_id: "string",
        project_name: "Alpha plan",
        project_tenant: tenantA,
      },
      {
        wbs_id: wbsB,
        wbs_name: "Beta plan",
        wbs_tenant: tenantB,
        project_id: "string",
        project_name: "Beta plan",
        project_tenant: tenantB,
      },
    ]);
    const distinct = await client.query<{ n: string }>(
      "select count(distinct project_id)::text as n from wbs",
    );
    expect(distinct.rows[0]?.n).toBe("2");
    const projects = await client.query<{ n: string }>("select count(*)::text as n from project");
    expect(projects.rows[0]?.n).toBe("2");
  });

  it("moves per-wbs memberships onto the project with their roles", async () => {
    const result = await client.query<Row>(
      `select pm.tenant_id, w.id as wbs_id, pm.principal_id, pm.role
       from project_membership as pm join wbs as w on w.project_id = pm.project_id
       order by pm.role, pm.principal_id`,
    );
    expect(result.rows).toEqual([
      { tenant_id: tenantB, wbs_id: wbsB, principal_id: principalEditor, role: "OWNER" },
      { tenant_id: tenantA, wbs_id: wbsA, principal_id: principalEditor, role: "EDITOR" },
      { tenant_id: tenantA, wbs_id: wbsA, principal_id: principalViewer, role: "VIEWER" },
    ]);
  });

  it("leaves task rows identical, and addressed by wbs_id", async () => {
    expect(await rowSet(client, "task", "wbs_id")).toEqual(tasksBefore);
    const result = await client.query<Row>(
      "select id, wbs_id, parent_task_id, name, seq, planned_effort_minutes from task order by name",
    );
    expect(result.rows).toEqual([
      { id: taskB, wbs_id: wbsB, parent_task_id: null, name: "Beta task", seq: 1, planned_effort_minutes: 120 },
      { id: taskChild, wbs_id: wbsA, parent_task_id: taskParent, name: "Child task", seq: 2, planned_effort_minutes: 480 },
      { id: taskParent, wbs_id: wbsA, parent_task_id: null, name: "Parent task", seq: 1, planned_effort_minutes: 960 },
    ]);
  });

  it("leaves dependency rows identical", async () => {
    expect(await rowSet(client, "task_dependency", "wbs_id")).toEqual(dependenciesBefore);
    const result = await client.query<Row>(
      "select id, wbs_id, predecessor_task_id, successor_task_id, type, lag_working_days from task_dependency",
    );
    expect(result.rows).toEqual([
      {
        id: dependencyId,
        wbs_id: wbsA,
        predecessor_task_id: taskParent,
        successor_task_id: taskChild,
        type: "SS",
        lag_working_days: 2,
      },
    ]);
  });

  it("leaves baseline and baseline task rows identical", async () => {
    expect(await rowSet(client, "baseline", "wbs_id")).toEqual(baselinesBefore);
    expect(await rowSet(client, "baseline_task", "wbs_id")).toEqual(baselineTasksBefore);
    const result = await client.query<Row>(
      "select wbs_id, version, source_revision, published_by_actor_id from baseline",
    );
    expect(result.rows).toEqual([
      { wbs_id: wbsA, version: 1, source_revision: "7", published_by_actor_id: "actor-one" },
    ]);
  });

  it("renames the tables: the new names exist and the old ones are gone", async () => {
    const names = async (list: readonly string[]) => {
      const result = await client.query<{ name: string; oid: string | null }>(
        `select n as name, to_regclass('public.' || quote_ident(n))::text as oid
         from unnest($1::text[]) as n order by n`,
        [list],
      );
      return result.rows.filter((row) => row.oid !== null).map((row) => row.name);
    };
    expect(
      await names([
        "principals", "tenants", "tenant_memberships", "projects", "project_calendars", "members",
        "processes", "products", "subtask_templates", "tasks", "task_dependencies", "project_baselines",
        "baseline_tasks", "audit_events", "command_receipts", "project_memberships",
      ]),
    ).toEqual([]);
    expect(
      await names([
        "audit_event", "baseline", "baseline_task", "calendar", "command_receipt", "member", "principal",
        "process", "product", "project", "project_membership", "subtask_template", "task", "task_dependency",
        "tenant", "tenant_membership", "wbs",
      ]),
    ).toEqual([
      "audit_event", "baseline", "baseline_task", "calendar", "command_receipt", "member", "principal",
      "process", "product", "project", "project_membership", "subtask_template", "task", "task_dependency",
      "tenant", "tenant_membership", "wbs",
    ]);
  });

  it("NEGATIVE CONTROL: a wbs without project_id is refused (NOT NULL, 23502)", async () => {
    const error = await pgError(
      client.query(
        `insert into wbs (tenant_id, name, project_start, status_date)
         values ($1, 'Orphan wbs', '2026-04-01', '2026-04-01')`,
        [tenantA],
      ),
    );
    expect(error.code).toBe("23502");
    expect(error.column).toBe("project_id");
  });

  it("NEGATIVE CONTROL: a wbs pointing at another tenant's project is refused (wbs_project_fk, 23503)", async () => {
    const other = await client.query<{ project_id: string }>(
      "select project_id from wbs where id = $1",
      [wbsB],
    );
    const error = await pgError(
      client.query(
        `insert into wbs (tenant_id, project_id, name, project_start, status_date)
         values ($1, $2, 'Cross-tenant wbs', '2026-04-01', '2026-04-01')`,
        [tenantA, other.rows[0]!.project_id],
      ),
    );
    expect(error.code).toBe("23503");
    expect(error.constraint).toBe("wbs_project_fk");
  });
});
