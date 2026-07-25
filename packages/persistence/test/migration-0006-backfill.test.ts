import { readFile } from "node:fs/promises";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Faithful backfill test for migration 0006 (Design 0003 §F-1). We apply the
// journal *up to 0005* (a `tasks` table with no `seq` column), seed pre-existing
// tasks the way production already has them, then apply 0006 and assert the
// display-No. backfill: every task is numbered 1..N per (tenant, project) by
// (sort_order, id), and each project's `next_task_seq` is seeded to max(seq)+1.

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

const tenantId = "00000000-0000-4000-8000-000000000abc";
const projA = "10000000-0000-4000-8000-00000000000a";
const projB = "10000000-0000-4000-8000-00000000000b";
const projC = "10000000-0000-4000-8000-00000000000c";
const projProd = "10000000-0000-4000-8000-00000000000d";

function taskUuid(hex: string): string {
  return `d0000000-0000-4000-8000-${hex.padStart(12, "0")}`;
}

describe("migration 0006 display-No. backfill", () => {
  const container = new PostgreSqlContainer("postgres:17.6-alpine");
  let client: Client;
  let stopContainer: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const started = await container.start();
    stopContainer = async () => started.stop().then(() => undefined);
    client = new Client({ connectionString: started.getConnectionUri() });
    await client.connect();

    const journal = await orderedJournal();
    // Apply every migration strictly before 0006, leaving the schema at 0005 —
    // a `tasks` table without the `seq` column and `projects` without the counter.
    for (const entry of journal.filter((candidate) => candidate.idx < 6)) {
      await applyMigration(client, entry.tag);
    }

    await client.query("insert into tenants (id, name) values ($1, 'Backfill tenant')", [tenantId]);
    for (const id of [projA, projB, projC, projProd]) {
      await client.query(
        `insert into projects (id, tenant_id, name, project_start, status_date)
         values ($1, $2, 'Project', '2026-01-05', '2026-01-20')`,
        [id, tenantId],
      );
    }

    const insertTask = (projectId: string, id: string, sortOrder: number, name: string) =>
      client.query(
        "insert into tasks (id, tenant_id, project_id, sort_order, name) values ($1, $2, $3, $4, $5)",
        [id, tenantId, projectId, sortOrder, name],
      );

    // Project A: three tasks whose creation order differs from sort order, so the
    // (sort_order, id) numbering must reorder them 1..3.
    await insertTask(projA, taskUuid("a3"), 30, "A three");
    await insertTask(projA, taskUuid("a1"), 10, "A one");
    await insertTask(projA, taskUuid("a2"), 20, "A two");
    // Project B: a sort-order tie broken by ascending id.
    await insertTask(projB, taskUuid("b01"), 5, "B one");
    await insertTask(projB, taskUuid("b02"), 5, "B two");
    // Project C: no tasks (its counter must default to 1).
    // Project prod: 48 tasks mirroring the live project — must number 1..48.
    for (let index = 0; index < 48; index += 1) {
      await insertTask(projProd, taskUuid(`d${(index + 1).toString(16)}`), index, `Prod ${index + 1}`);
    }

    // Now apply 0006 (idx 6) — the column add + backfill + counter seed.
    const zeroSix = journal.find((entry) => entry.idx === 6);
    if (zeroSix === undefined) throw new Error("Migration 0006 is missing from the journal");
    await applyMigration(client, zeroSix.tag);
  }, 60_000);

  afterAll(async () => {
    await client.end();
    await stopContainer?.();
  });

  async function seqByTask(projectId: string): Promise<Map<string, number>> {
    const rows = await client.query<{ id: string; seq: number }>(
      "select id, seq from tasks where project_id = $1 order by seq",
      [projectId],
    );
    return new Map(rows.rows.map((row) => [row.id, row.seq]));
  }

  async function nextTaskSeq(projectId: string): Promise<number> {
    const rows = await client.query<{ next_task_seq: number }>(
      "select next_task_seq from projects where id = $1",
      [projectId],
    );
    return rows.rows[0]!.next_task_seq;
  }

  it("numbers a project's tasks 1..N ordered by (sort_order, id)", async () => {
    const seqs = await seqByTask(projA);
    expect(seqs.get(taskUuid("a1"))).toBe(1); // sort_order 10
    expect(seqs.get(taskUuid("a2"))).toBe(2); // sort_order 20
    expect(seqs.get(taskUuid("a3"))).toBe(3); // sort_order 30
    expect(await nextTaskSeq(projA)).toBe(4);
  });

  it("breaks a sort-order tie by ascending id", async () => {
    const seqs = await seqByTask(projB);
    expect(seqs.get(taskUuid("b01"))).toBe(1);
    expect(seqs.get(taskUuid("b02"))).toBe(2);
    expect(await nextTaskSeq(projB)).toBe(3);
  });

  it("defaults an empty project's counter to 1", async () => {
    expect(await nextTaskSeq(projC)).toBe(1);
  });

  it("numbers the 48-task production-shaped project 1..48 with the counter at 49", async () => {
    const rows = await client.query<{ seq: number }>(
      "select seq from tasks where project_id = $1 order by seq",
      [projProd],
    );
    expect(rows.rows.map((row) => row.seq)).toEqual(
      Array.from({ length: 48 }, (_unused, index) => index + 1),
    );
    expect(await nextTaskSeq(projProd)).toBe(49);
  });

  it("keeps display numbers unique per project after the unique constraint lands", async () => {
    // seq 1 is already held in project A, so a duplicate is rejected.
    await expect(
      client.query(
        "insert into tasks (tenant_id, project_id, sort_order, name, seq) values ($1, $2, 99, 'Dup', 1)",
        [tenantId, projA],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
