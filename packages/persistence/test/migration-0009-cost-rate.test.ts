import { readFile } from "node:fs/promises";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "./database.js";

/**
 * Migration 0009 — the cost rate (Design 0010).
 *
 * Three claims a real database is needed for:
 *
 *   1. it applies to a schema that already HAS DATA, and moves none of it;
 *   2. **old code keeps working**, which is what "expand" means — the pre-0009
 *      Worker writes every member column EXCEPT this one, and those writes must
 *      still succeed. That is only true because the column is nullable, and a
 *      migration that made it `NOT NULL DEFAULT 0` would fail here and nowhere
 *      else in the suite;
 *   3. the check constraint actually refuses a negative rate. A constraint that
 *      was never created looks exactly like one that works until something tries
 *      to break it.
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

const tenantId = "00000000-0000-4000-8000-000000000def";
const projectId = "10000000-0000-4000-8000-0000000000d1";
const memberId = (hex: string) => `40000000-0000-4000-8000-${hex.padStart(12, "0")}`;

const EXISTING_MEMBERS = 12;

describe("migration 0009 cost rate", () => {
  let client: Client;
  let testDatabase: TestDatabase;
  let before: { members: number; capacityTotal: string };

  beforeAll(async () => {
    testDatabase = await startTestDatabase("migration_0009");
    client = testDatabase.client;

    const journal = await orderedJournal();
    for (const entry of journal.filter((candidate) => candidate.idx < 9)) {
      await applyMigration(client, entry.tag);
    }

    await client.query("insert into tenants (id, name) values ($1, 'Rate tenant')", [tenantId]);
    await client.query(
      `insert into projects (id, tenant_id, name, project_start, status_date)
       values ($1, $2, 'Loaded project', '2026-01-05', '2026-08-06')`,
      [projectId, tenantId],
    );
    await client.query(
      `insert into project_calendars (tenant_id, project_id, id, name, working_weekdays, non_working_dates)
       values ($1, $2, 'standard', 'Standard', '{1,2,3,4,5}', '{}')`,
      [tenantId, projectId],
    );
    for (let index = 1; index <= EXISTING_MEMBERS; index += 1) {
      await client.query(
        `insert into members (id, tenant_id, project_id, name, calendar_id, daily_capacity_minutes)
         values ($1, $2, $3, $4, 'standard', 480)`,
        [memberId(index.toString(16)), tenantId, projectId, `Member ${index}`],
      );
    }

    const snapshot = await client.query<{ members: string; capacity: string }>(
      `select count(*)::text as members,
              coalesce(sum(daily_capacity_minutes), 0)::text as capacity
       from members where tenant_id = $1 and project_id = $2`,
      [tenantId, projectId],
    );
    const row = snapshot.rows[0]!;
    before = { members: Number(row.members), capacityTotal: row.capacity };
    expect(before.members).toBe(EXISTING_MEMBERS);

    await applyMigration(client, "0009_cost_rate");
  });

  afterAll(async () => {
    await testDatabase.dispose();
  });

  it("applies to a database that already holds members, and moves nothing", async () => {
    const after = await client.query<{ members: string; capacity: string }>(
      `select count(*)::text as members,
              coalesce(sum(daily_capacity_minutes), 0)::text as capacity
       from members where tenant_id = $1 and project_id = $2`,
      [tenantId, projectId],
    );
    expect(Number(after.rows[0]!.members)).toBe(before.members);
    expect(after.rows[0]!.capacity).toBe(before.capacityTotal);
  });

  it("leaves every existing member with NO rate, rather than a zero one", async () => {
    // The distinction the whole feature rests on. A `DEFAULT 0` would have priced
    // twelve people's work at nothing and summed it in silence.
    const result = await client.query<{ nulls: string }>(
      `select count(*) filter (where cost_rate_minor_per_hour is null)::text as nulls
       from members where tenant_id = $1 and project_id = $2`,
      [tenantId, projectId],
    );
    expect(result.rows[0]?.nulls).toBe(String(EXISTING_MEMBERS));
  });

  it("EXPAND: an OLD-code write that never names the column still succeeds", async () => {
    await client.query(
      `insert into members (id, tenant_id, project_id, name, calendar_id, daily_capacity_minutes)
       values ($1, $2, $3, 'Old-code member', 'standard', 300)`,
      [memberId("ff"), tenantId, projectId],
    );
    const result = await client.query<{ cost_rate_minor_per_hour: number | null }>(
      "select cost_rate_minor_per_hour from members where id = $1",
      [memberId("ff")],
    );
    expect(result.rows[0]?.cost_rate_minor_per_hour).toBeNull();
  });

  it("stores a rate, and REFUSES a negative one", async () => {
    await client.query("update members set cost_rate_minor_per_hour = 12345 where id = $1", [
      memberId("1"),
    ]);
    const stored = await client.query<{ cost_rate_minor_per_hour: number }>(
      "select cost_rate_minor_per_hour from members where id = $1",
      [memberId("1")],
    );
    expect(stored.rows[0]?.cost_rate_minor_per_hour).toBe(12345);

    await expect(
      client.query("update members set cost_rate_minor_per_hour = -1 where id = $1", [
        memberId("1"),
      ]),
    ).rejects.toThrow(/members_cost_rate_non_negative/u);
  });
});
