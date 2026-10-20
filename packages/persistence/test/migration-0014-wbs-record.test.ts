import { readFile } from "node:fs/promises";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "./database.js";

/**
 * Migration 0014 on a database that already has a WBS.
 *
 * 0010–0013 leave that WBS with no creation change. 0014 does not invent one:
 * the new triggers fire on the next statement, and the rows that were already
 * there stay. A later content write, a revision jump, and a bare INSERT are
 * what the triggers refuse.
 */

const drizzleDir = new URL("../drizzle/", import.meta.url);

interface JournalEntry {
  readonly idx: number;
  readonly tag: string;
}

async function orderedJournal(): Promise<readonly JournalEntry[]> {
  const journal = JSON.parse(await readFile(new URL("meta/_journal.json", drizzleDir), "utf8")) as {
    entries: JournalEntry[];
  };
  return [...journal.entries].sort((left, right) => left.idx - right.idx);
}

async function applyMigration(client: Client, tag: string): Promise<void> {
  const sql = await readFile(new URL(`${tag}.sql`, drizzleDir), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed.length > 0) await client.query(trimmed);
  }
}

const tenantId = "a0000000-0000-4000-8000-000000000014";
const wbsId = "b0000000-0000-4000-8000-000000000014";
const taskId = "c0000000-0000-4000-8000-000000000014";

describe("migration 0014 wbs record", () => {
  let client: Client;
  let testDatabase: TestDatabase;

  beforeAll(async () => {
    testDatabase = await startTestDatabase("migration_0014");
    client = testDatabase.client;

    const journal = await orderedJournal();
    for (const entry of journal.filter((candidate) => candidate.idx < 10)) {
      await applyMigration(client, entry.tag);
    }

    await client.query("insert into tenants (id, name) values ($1, 'Loaded')", [tenantId]);
    await client.query(
      `insert into projects (id, tenant_id, name, project_start, status_date)
       values ($1, $2, 'Loaded plan', '2026-01-05', '2026-02-02')`,
      [wbsId, tenantId],
    );
    await client.query(
      `insert into tasks (id, tenant_id, project_id, parent_task_id, sort_order, name, note, assignee_member_id,
                          planned_effort_minutes, progress_basis_points, seq, daily_plan)
       values ($1, $2, $3, null, 0, 'Kept', '', null, 480, 0, 1, '{}')`,
      [taskId, tenantId, wbsId],
    );

    for (const entry of journal.filter((candidate) => candidate.idx >= 10 && candidate.idx < 14)) {
      await applyMigration(client, entry.tag);
    }
    const carried = await client.query<{ name: string; revision: string; changes: number }>(
      `select t.name, w.revision::text as revision, (select count(*)::int from wbs_change) as changes
         from task t
         join wbs w on w.tenant_id = t.tenant_id and w.id = t.wbs_id
        where t.id = $1`,
      [taskId],
    );
    expect(carried.rows).toEqual([{ name: "Kept", revision: "0", changes: 0 }]);

    await applyMigration(client, "0014_wbs_record");
    const after = await client.query<{ name: string; revision: string; changes: number }>(
      `select t.name, w.revision::text as revision, (select count(*)::int from wbs_change) as changes
         from task t
         join wbs w on w.tenant_id = t.tenant_id and w.id = t.wbs_id
        where t.id = $1`,
      [taskId],
    );
    expect(after.rows).toEqual([{ name: "Kept", revision: "0", changes: 0 }]);
  }, 60_000);

  afterAll(async () => {
    await testDatabase.dispose();
  });

  async function inTx(work: () => Promise<void>): Promise<void> {
    await client.query("begin");
    try {
      await work();
      await client.query("commit");
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // The statement error is the one the test asserts.
      }
      throw error;
    }
  }

  async function expectP0001(work: Promise<unknown>, message: string | RegExp): Promise<void> {
    try {
      await work;
    } catch (error) {
      const caught = error as { code?: string; message?: string };
      expect(caught.code).toBe("P0001");
      if (typeof message === "string") expect(caught.message).toBe(message);
      else expect(caught.message).toMatch(message);
      return;
    }
    throw new Error("expected the statement to be rejected, but it succeeded");
  }

  async function taskName(): Promise<string> {
    const result = await client.query<{ name: string }>("select name from task where id = $1", [taskId]);
    return result.rows[0]!.name;
  }

  it("a marker for revision 999 cannot authorise a content update", async () => {
    await expectP0001(
      inTx(async () => {
        await client.query("select set_config('vecta.wbs_write', $1, true)", [`${wbsId}:999`]);
        await client.query("update task set name = 'sneaky' where id = $1", [taskId]);
      }),
      /^wbs write marker revision/,
    );
    expect(await taskName()).toBe("Kept");
  });

  it("a content write at the current revision, with no new change, is refused", async () => {
    await expectP0001(
      inTx(async () => {
        await client.query("select set_config('vecta.wbs_write', $1, true)", [`${wbsId}:0`]);
        await client.query("update task set name = 'no-bump' where id = $1", [taskId]);
      }),
      /^wbs write marker revision/,
    );
    expect(await taskName()).toBe("Kept");
  });

  it("a revision jump of two is refused even when the new revision has a change", async () => {
    await expectP0001(
      inTx(async () => {
        await client.query(
          `insert into wbs_change
             (tenant_id, wbs_id, revision, operation_id, actor_type, actor_id, format, change)
           values ($1, $2, 2, 'jump-2', 'SYSTEM', 'migration-0014', 1, '{"format":1,"changes":[]}'::jsonb)`,
          [tenantId, wbsId],
        );
        await client.query("update wbs set revision = revision + 2 where id = $1", [wbsId]);
      }),
      "wbs revision must advance by one",
    );
    const revision = await client.query<{ revision: string }>(
      "select revision::text as revision from wbs where id = $1",
      [wbsId],
    );
    expect(revision.rows[0]!.revision).toBe("0");
  });

  it("an INSERT into wbs without its change row fails at commit", async () => {
    const freshProject = "d0000000-0000-4000-8000-000000000014";
    const freshWbs = "e0000000-0000-4000-8000-000000000014";
    await expectP0001(
      inTx(async () => {
        await client.query("insert into project (id, tenant_id, name) values ($1, $2, 'Fresh')", [
          freshProject,
          tenantId,
        ]);
        await client.query(
          `insert into wbs (id, tenant_id, project_id, name, project_start, status_date)
           values ($1, $2, $3, 'Fresh', '2026-01-05', '2026-01-05')`,
          [freshWbs, tenantId, freshProject],
        );
      }),
      `wbs_change missing for wbs ${freshWbs} revision 0`,
    );
    expect(
      (await client.query("select count(*)::int as n from wbs where id = $1", [freshWbs])).rows[0]!.n,
    ).toBe(0);
  });

  it("revision 0 -> 1, its change, and a content write commit together", async () => {
    await inTx(async () => {
      await client.query("select set_config('vecta.wbs_write', $1, true)", [`${wbsId}:1`]);
      await client.query("update wbs set revision = revision + 1 where id = $1", [wbsId]);
      await client.query(
        `insert into wbs_change
           (tenant_id, wbs_id, revision, operation_id, actor_type, actor_id, format, change)
         values ($1, $2, 1, 'record-1', 'SYSTEM', 'migration-0014', 1, '{"format":1,"changes":[]}'::jsonb)`,
        [tenantId, wbsId],
      );
      await client.query("update task set name = 'Recorded' where id = $1", [taskId]);
    });
    expect(await taskName()).toBe("Recorded");
    const revision = await client.query<{ revision: string }>(
      "select revision::text as revision from wbs where id = $1",
      [wbsId],
    );
    expect(revision.rows[0]!.revision).toBe("1");
    expect(
      (await client.query("select count(*)::int as n from wbs_change where wbs_id = $1", [wbsId])).rows[0]!.n,
    ).toBe(1);
  });

  it("deleting the WBS is refused by the append-only change row, and the WBS stays", async () => {
    await expectP0001(
      inTx(async () => {
        await client.query("select set_config('vecta.wbs_write', $1, true)", [`${wbsId}:1`]);
        await client.query("delete from wbs where id = $1", [wbsId]);
      }),
      "DELETE on wbs_change is refused",
    );
    expect((await client.query("select count(*)::int as n from wbs where id = $1", [wbsId])).rows[0]!.n).toBe(1);
    expect(await taskName()).toBe("Recorded");
  });

  it("wbs_change, wbs_snapshot and wbs_verified_range refuse update and delete", async () => {
    await expectP0001(
      client.query("update wbs_change set actor_id = 'tamper' where wbs_id = $1", [wbsId]),
      "UPDATE on wbs_change is refused",
    );
    await expectP0001(
      client.query("delete from wbs_change where wbs_id = $1", [wbsId]),
      "DELETE on wbs_change is refused",
    );

    const sha = "ab".repeat(32);
    await client.query(
      `insert into wbs_snapshot (tenant_id, wbs_id, revision, format, sha256, body, body_bytes, raw_bytes)
       values ($1, $2, 0, 1, $3, '\\x00', 1, 1),
              ($1, $2, 1, 1, $3, '\\x00', 1, 1)`,
      [tenantId, wbsId, sha],
    );
    await expectP0001(
      client.query("update wbs_snapshot set format = 1 where wbs_id = $1", [wbsId]),
      "wbs_snapshot is immutable",
    );
    await expectP0001(
      client.query("delete from wbs_snapshot where wbs_id = $1 and revision = 0", [wbsId]),
      "wbs_snapshot is immutable",
    );

    await client.query(
      `insert into wbs_verified_range (tenant_id, wbs_id, from_revision, to_revision, failure)
       values ($1, $2, 0, 1, null)`,
      [tenantId, wbsId],
    );
    await expectP0001(
      client.query("update wbs_verified_range set failure = 'hash' where wbs_id = $1", [wbsId]),
      "UPDATE on wbs_verified_range is refused",
    );
    await expectP0001(
      client.query("delete from wbs_verified_range where wbs_id = $1", [wbsId]),
      "DELETE on wbs_verified_range is refused",
    );
  });
});
