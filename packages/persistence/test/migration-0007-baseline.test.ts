import { readFile } from "node:fs/promises";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "./database.js";

/**
 * Migration 0007 — baseline freezing (Design 0009).
 *
 * Two things need a real database rather than a unit test:
 *
 *   1. **The migration runs on a schema that already HAS DATA.** The existing
 *      migration tests start from an empty database, so they would not notice a
 *      statement that only fails against real rows. Production carries a project
 *      with 48 tasks, and `operations/release-and-rollback.md` is forward-only —
 *      a migration that fails there cannot be undone by rolling the Worker back.
 *   2. **The immutability trigger.** A repository that declines to write is a
 *      convention; this asserts the database itself refuses, and pairs it with a
 *      control that drops the trigger and shows the same statement then succeeds.
 *      Without that control, a trigger that was never created looks identical to
 *      one that works, as long as nothing tries to break the rule.
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

const tenantId = "00000000-0000-4000-8000-000000000bcd";
const projectId = "10000000-0000-4000-8000-0000000000b1";
const principalId = "20000000-0000-4000-8000-0000000000b1";
const taskId = (hex: string) => `d0000000-0000-4000-8000-${hex.padStart(12, "0")}`;

/** Production-shaped: one project with 48 tasks, present BEFORE 0007 runs. */
const EXISTING_TASKS = 48;

describe("migration 0007 baseline freezing", () => {
  let client: Client;
  let testDatabase: TestDatabase;
  /** The projection facts captured before the migration, to compare after. */
  let before: { tasks: number; plannedTotal: string; seqMax: number };

  beforeAll(async () => {
    testDatabase = await startTestDatabase("migration_0007");
    client = testDatabase.client;

    const journal = await orderedJournal();
    for (const entry of journal.filter((candidate) => candidate.idx < 7)) {
      await applyMigration(client, entry.tag);
    }

    await client.query("insert into tenants (id, name) values ($1, 'Baseline tenant')", [tenantId]);
    await client.query(
      `insert into principals (id, issuer, subject, display_name, type)
       values ($1, 'https://issuer.invalid', 'subject-b1', 'Publisher', 'HUMAN')`,
      [principalId],
    );
    await client.query(
      `insert into projects (id, tenant_id, name, project_start, status_date)
       values ($1, $2, 'Loaded project', '2026-01-05', '2026-08-05')`,
      [projectId, tenantId],
    );
    for (let index = 1; index <= EXISTING_TASKS; index += 1) {
      await client.query(
        `insert into tasks (id, tenant_id, project_id, sort_order, seq, name,
                            planned_effort_minutes, daily_plan)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [
          taskId(index.toString(16)),
          tenantId,
          projectId,
          index * 10,
          index,
          `Task ${index}`,
          480,
          JSON.stringify({ "2026-08-01": 480 }),
        ],
      );
    }

    const snapshot = await client.query<{ tasks: string; planned: string; seqmax: string }>(
      `select count(*)::text as tasks,
              coalesce(sum(planned_effort_minutes), 0)::text as planned,
              coalesce(max(seq), 0)::text as seqmax
       from tasks where tenant_id = $1 and project_id = $2`,
      [tenantId, projectId],
    );
    const row = snapshot.rows[0]!;
    before = { tasks: Number(row.tasks), plannedTotal: row.planned, seqMax: Number(row.seqmax) };
    expect(before.tasks).toBe(EXISTING_TASKS);

    // The migration under test, applied to the LOADED schema.
    await applyMigration(client, "0007_baseline_freezing");
  });

  afterAll(async () => {
    await testDatabase.dispose();
  });

  it("applies to a database that already holds production-shaped data", async () => {
    const after = await client.query<{ tasks: string; planned: string; seqmax: string }>(
      `select count(*)::text as tasks,
              coalesce(sum(planned_effort_minutes), 0)::text as planned,
              coalesce(max(seq), 0)::text as seqmax
       from tasks where tenant_id = $1 and project_id = $2`,
      [tenantId, projectId],
    );
    const row = after.rows[0]!;
    // Expand-only: existing rows are untouched, which is what lets the OLD Worker
    // keep serving against the migrated database.
    expect(Number(row.tasks)).toBe(before.tasks);
    expect(row.planned).toBe(before.plannedTotal);
    expect(Number(row.seqmax)).toBe(before.seqMax);
  });

  it("gives every existing project a baseline counter starting at 1", async () => {
    const result = await client.query<{ next_baseline_version: number }>(
      "select next_baseline_version from projects where id = $1",
      [projectId],
    );
    expect(result.rows[0]?.next_baseline_version).toBe(1);
  });

  it("refuses UPDATE and DELETE on a published baseline", async () => {
    await client.query(
      `insert into project_baselines (tenant_id, project_id, version, source_revision, published_by_actor_type, published_by_actor_id)
       values ($1, $2, 1, 0, 'HUMAN', $3)`,
      [tenantId, projectId, principalId],
    );
    await client.query(
      `insert into baseline_tasks (tenant_id, project_id, version, task_id, daily_plan,
                                   planned_effort_minutes, name, seq)
       values ($1, $2, 1, $3, $4::jsonb, 480, 'Task 1', 1)`,
      [tenantId, projectId, taskId("1"), JSON.stringify({ "2026-08-01": 480 })],
    );

    await expect(
      client.query("update baseline_tasks set planned_effort_minutes = 0 where version = 1"),
    ).rejects.toThrow(/immutable/u);
    await expect(client.query("delete from baseline_tasks where version = 1")).rejects.toThrow(
      /immutable/u,
    );
    await expect(
      client.query("update project_baselines set source_revision = 99 where version = 1"),
    ).rejects.toThrow(/immutable/u);
  });

  it("CONTROL: the same statements succeed once the trigger is dropped", async () => {
    // Without this, a trigger that was never created is indistinguishable from one
    // that works — nothing else in the suite tries to break the rule. Run in a
    // transaction and rolled back, so the table is immutable again afterwards.
    await client.query("begin");
    try {
      await client.query('drop trigger "baseline_tasks_immutable" on "baseline_tasks"');
      const updated = await client.query(
        "update baseline_tasks set planned_effort_minutes = 0 where version = 1",
      );
      expect(updated.rowCount).toBe(1);
    } finally {
      await client.query("rollback");
    }

    // And the rollback really restored it.
    await expect(
      client.query("update baseline_tasks set planned_effort_minutes = 1 where version = 1"),
    ).rejects.toThrow(/immutable/u);
  });

  it("keeps a baseline row when its task is deleted, and lets the task go", async () => {
    // The reason there is no foreign key to `tasks`: a cascade would turn this
    // deletion into a DELETE on a frozen row and the trigger would refuse it, so
    // an ordinary task deletion would start failing the moment a baseline existed.
    await client.query("delete from tasks where id = $1", [taskId("1")]);
    const surviving = await client.query<{ name: string; seq: number }>(
      "select name, seq from baseline_tasks where task_id = $1",
      [taskId("1")],
    );
    // The frozen name is what lets the resulting schedule variance be explained at
    // all — the task itself no longer exists to be named.
    expect(surviving.rows[0]?.name).toBe("Task 1");
    expect(surviving.rows[0]?.seq).toBe(1);
  });
});
