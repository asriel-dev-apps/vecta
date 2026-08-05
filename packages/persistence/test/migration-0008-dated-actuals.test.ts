import { readFile } from "node:fs/promises";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "./database.js";

/**
 * Migration 0008 — dated actuals (Design 0011).
 *
 * The same two things a real database is needed for, one of them new:
 *
 *   1. **It runs on a schema that already HAS DATA.** The other migration tests
 *      start empty, so they cannot notice a statement that only fails against
 *      real rows. Production carries a project with 48 tasks and
 *      `operations/release-and-rollback.md` is forward-only, so a failure there
 *      cannot be undone by rolling the Worker back.
 *   2. **Old code keeps working on the migrated schema.** This is what "expand"
 *      MEANS, and the way to check it is to issue the writes the old Worker
 *      issues — which name every task column EXCEPT `dated_actuals` — against the
 *      new schema and see them succeed. The `NOT NULL DEFAULT` is the whole
 *      reason they can, and a migration that forgot the default would fail here
 *      and nowhere else in the suite.
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

const tenantId = "00000000-0000-4000-8000-000000000cde";
const projectId = "10000000-0000-4000-8000-0000000000c1";
const memberId = "30000000-0000-4000-8000-0000000000c1";
const taskId = (hex: string) => `e0000000-0000-4000-8000-${hex.padStart(12, "0")}`;

/** Production-shaped: one project with 48 tasks, present BEFORE 0008 runs. */
const EXISTING_TASKS = 48;

describe("migration 0008 dated actuals", () => {
  let client: Client;
  let testDatabase: TestDatabase;
  let before: { tasks: number; actualTotal: string; plannedTotal: string };

  beforeAll(async () => {
    testDatabase = await startTestDatabase("migration_0008");
    client = testDatabase.client;

    const journal = await orderedJournal();
    for (const entry of journal.filter((candidate) => candidate.idx < 8)) {
      await applyMigration(client, entry.tag);
    }

    await client.query("insert into tenants (id, name) values ($1, 'Actuals tenant')", [tenantId]);
    await client.query(
      `insert into projects (id, tenant_id, name, project_start, status_date)
       values ($1, $2, 'Loaded project', '2026-01-05', '2026-08-05')`,
      [projectId, tenantId],
    );
    await client.query(
      `insert into project_calendars (tenant_id, project_id, id, name, working_weekdays, non_working_dates)
       values ($1, $2, 'standard', 'Standard', '{1,2,3,4,5}', '{}')`,
      [tenantId, projectId],
    );
    await client.query(
      `insert into members (id, tenant_id, project_id, name, calendar_id, daily_capacity_minutes)
       values ($1, $2, $3, 'Member 01', 'standard', 480)`,
      [memberId, tenantId, projectId],
    );
    for (let index = 1; index <= EXISTING_TASKS; index += 1) {
      await client.query(
        `insert into tasks (id, tenant_id, project_id, sort_order, seq, name,
                            planned_effort_minutes, actual_effort_minutes, daily_plan)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          taskId(index.toString(16)),
          tenantId,
          projectId,
          index * 10,
          index,
          `Task ${index}`,
          480,
          60,
          JSON.stringify({ "2026-08-01": 480 }),
        ],
      );
    }

    const snapshot = await client.query<{ tasks: string; actual: string; planned: string }>(
      `select count(*)::text as tasks,
              coalesce(sum(actual_effort_minutes), 0)::text as actual,
              coalesce(sum(planned_effort_minutes), 0)::text as planned
       from tasks where tenant_id = $1 and project_id = $2`,
      [tenantId, projectId],
    );
    const row = snapshot.rows[0]!;
    before = { tasks: Number(row.tasks), actualTotal: row.actual, plannedTotal: row.planned };
    expect(before.tasks).toBe(EXISTING_TASKS);

    await applyMigration(client, "0008_dated_actuals");
  });

  afterAll(async () => {
    await testDatabase.dispose();
  });

  it("applies to a database that already holds production-shaped data", async () => {
    const after = await client.query<{ tasks: string; actual: string; planned: string }>(
      `select count(*)::text as tasks,
              coalesce(sum(actual_effort_minutes), 0)::text as actual,
              coalesce(sum(planned_effort_minutes), 0)::text as planned
       from tasks where tenant_id = $1 and project_id = $2`,
      [tenantId, projectId],
    );
    const row = after.rows[0]!;
    expect(Number(row.tasks)).toBe(before.tasks);
    // AC is what this feature is about, so "AC did not move" is the number that
    // has to be checked, not merely the row count.
    expect(row.actual).toBe(before.actualTotal);
    expect(row.planned).toBe(before.plannedTotal);
  });

  it("gives every existing task an EMPTY dated-actuals map, not null", async () => {
    // Empty is the value that means "no time axis here", and the EVM module keys
    // its whole fallback on that. A null would reach the app as `null` and the
    // `Object.entries` walk would throw on the first read of an old row.
    const result = await client.query<{ nulls: string; nonEmpty: string }>(
      `select count(*) filter (where dated_actuals is null)::text as nulls,
              count(*) filter (where dated_actuals <> '{}'::jsonb)::text as "nonEmpty"
       from tasks where tenant_id = $1 and project_id = $2`,
      [tenantId, projectId],
    );
    expect(result.rows[0]?.nulls).toBe("0");
    expect(result.rows[0]?.nonEmpty).toBe("0");
  });

  it("EXPAND: an OLD-code write that never names the column still succeeds", async () => {
    // Exactly the statement shape the pre-0008 unit of work issues for every task
    // on every command. If the column had arrived without a default, the Worker
    // would start failing every save the moment the migration ran — and rolling
    // the Worker back would not help, because the schema does not roll back.
    await client.query(
      `insert into tasks (id, tenant_id, project_id, sort_order, seq, name,
                          planned_effort_minutes, actual_effort_minutes, daily_plan)
       values ($1, $2, $3, 9990, 9990, 'Old-code task', 120, 30, '{}'::jsonb)`,
      [taskId("ff"), tenantId, projectId],
    );
    await client.query(
      `update tasks set actual_effort_minutes = 45, daily_plan = '{}'::jsonb where id = $1`,
      [taskId("ff")],
    );
    const result = await client.query<{ dated_actuals: unknown }>(
      "select dated_actuals from tasks where id = $1",
      [taskId("ff")],
    );
    expect(result.rows[0]?.dated_actuals).toEqual({});
  });

  it("stores and reads back a dated-actuals map", async () => {
    const map = { [`2026-08-03|${memberId}`]: 120 };
    await client.query("update tasks set dated_actuals = $1::jsonb where id = $2", [
      JSON.stringify(map),
      taskId("1"),
    ]);
    const result = await client.query<{ dated_actuals: unknown }>(
      "select dated_actuals from tasks where id = $1",
      [taskId("1")],
    );
    expect(result.rows[0]?.dated_actuals).toEqual(map);
  });
});
