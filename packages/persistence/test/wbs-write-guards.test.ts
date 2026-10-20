import { randomUUID } from "node:crypto";
import { createProjectCommandService } from "@vecta/application";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceDatabase,
  createSeedProjectRecord,
  migratePersistenceDatabase,
  PostgresProjectCommandUnitOfWork,
  ProjectRepository,
  type PersistedProjectRecord,
} from "../src/index.js";
import { startTestDatabase, type TestDatabase } from "./database.js";

/**
 * Migration 0012 (Design 0016 §3.4): the database itself refuses a WBS write
 * that has no change record (revision) or no marker naming the row's WBS.
 * Every refusal is paired with the same statement done correctly, read back.
 */

const SMALL = { parentCount: 2, subtasksPerParent: 3, memberCount: 2 };
const ACTOR = { type: "HUMAN" as const, id: "user-001" };
const CONTENT_TABLES = [
  "task",
  "task_dependency",
  "member",
  "calendar",
  "process",
  "product",
  "subtask_template",
  "baseline",
  "baseline_task",
] as const;
type ContentTable = (typeof CONTENT_TABLES)[number];
type Op = "INSERT" | "UPDATE" | "DELETE";
type Row = Record<string, unknown>;

const MISSING = "wbs write marker missing";
const notNaming = (wbsId: string) => `wbs write marker does not name wbs ${wbsId}`;
const immutable = (op: string, table: string) =>
  `${op} on ${table} is refused: an approved baseline is immutable (Design 0009)`;

/** What an UPDATE changes per table, and the literal the read-back must show. */
const UPDATE_SPEC: Record<ContentTable, { set: string; column: string; expected: string }> = {
  task: { set: "name = 'Guard probe'", column: "name", expected: "Guard probe" },
  task_dependency: { set: "lag_working_days = 7", column: "lag_working_days", expected: "7" },
  member: { set: "name = 'Guard probe'", column: "name", expected: "Guard probe" },
  calendar: { set: "name = 'Guard probe'", column: "name", expected: "Guard probe" },
  process: { set: "name = 'Guard probe'", column: "name", expected: "Guard probe" },
  product: { set: "name = 'Guard probe'", column: "name", expected: "Guard probe" },
  subtask_template: { set: "name = 'Guard probe'", column: "name", expected: "Guard probe" },
  baseline: { set: "source_revision = source_revision + 1", column: "source_revision", expected: "2" },
  baseline_task: { set: "name = 'Guard probe'", column: "name", expected: "Guard probe" },
};
const IMMUTABLE = new Set<ContentTable>(["baseline", "baseline_task"]);

describe("wbs write guards (migration 0012)", () => {
  let client: Client;
  let testDatabase: TestDatabase;
  let repository: ProjectRepository;

  beforeAll(async () => {
    testDatabase = await startTestDatabase("wbs_write_guards");
    client = testDatabase.client;
    await migratePersistenceDatabase(client);
    repository = new ProjectRepository(createPersistenceDatabase(client));
  }, 60_000);

  afterAll(async () => {
    await testDatabase.dispose();
  });

  const service = () =>
    createProjectCommandService(
      new PostgresProjectCommandUnitOfWork(createPersistenceDatabase(client)),
    );

  /** Marker `null` is "not set": RESET puts the setting back to its default. */
  async function setMarker(c: Client, marker: string | null): Promise<void> {
    if (marker === null) await c.query("reset vecta.wbs_write");
    else await c.query("select set_config('vecta.wbs_write', $1, true)", [marker]);
  }

  /** begin / work / commit; rolls back and rethrows when anything fails (COMMIT included). */
  async function inTx<T>(work: () => Promise<T>, c: Client = client): Promise<T> {
    await c.query("begin");
    try {
      const result = await work();
      await c.query("commit");
      return result;
    } catch (error) {
      try {
        await c.query("rollback");
      } catch {
        // The statement error is the one the test asserts.
      }
      throw error;
    }
  }

  async function expectRefusal(promise: Promise<unknown>, message: string, code = "P0001") {
    await expect(promise).rejects.toMatchObject({ code, message });
  }

  async function count(table: string, where: string, params: unknown[] = []): Promise<number> {
    const result = await client.query<{ n: number }>(
      `select count(*)::int as n from ${table} where ${where}`,
      params,
    );
    return result.rows[0]!.n;
  }

  async function wbsRevision(wbsId: string): Promise<string> {
    const result = await client.query<{ revision: string }>(
      "select revision::text as revision from wbs where id = $1",
      [wbsId],
    );
    return result.rows[0]!.revision;
  }

  // ------------------------------------------------------------------ 1
  describe("1. a revision commits only with its wbs_change row", () => {
    let record: PersistedProjectRecord;
    let A: string;
    let T: string;

    beforeEach(async () => {
      await client.query("truncate table tenant cascade");
      record = createSeedProjectRecord(SMALL);
      await repository.save(record);
      A = record.project.id;
      T = record.tenant.id;
    });

    const insertChange = (revision: number) =>
      client.query(
        `insert into wbs_change (tenant_id, wbs_id, revision, operation_id, actor_type, actor_id, format, change)
         values ($1, $2, $3, $4, 'HUMAN', 'user-001', 1, '{}'::jsonb)`,
        [T, A, revision, `guard-op-${randomUUID()}`],
      );

    it("1a. bumping revision without a change row is refused at COMMIT and nothing moves", async () => {
      expect(await wbsRevision(A)).toBe("1");
      await expectRefusal(
        inTx(() => client.query("update wbs set revision = revision + 1 where id = $1", [A])),
        `wbs_change missing for wbs ${A} revision 2`,
      );
      expect(await wbsRevision(A)).toBe("1");
    });

    it("1b. CONTROL: the change row inserted AFTER the update, before commit, commits (deferred)", async () => {
      await inTx(async () => {
        await client.query("update wbs set revision = revision + 1 where id = $1", [A]);
        await insertChange(2);
      });
      expect(await wbsRevision(A)).toBe("2");
      expect(await count("wbs_change", "wbs_id = $1 and revision = 2", [A])).toBe(1);
    });

    it("1c. a change row for revision 3 does not satisfy a bump to 2", async () => {
      await expectRefusal(
        inTx(async () => {
          await insertChange(3);
          await client.query("update wbs set revision = 2 where id = $1", [A]);
        }),
        `wbs_change missing for wbs ${A} revision 2`,
      );
      expect(await wbsRevision(A)).toBe("1");
      expect(await count("wbs_change", "wbs_id = $1", [A])).toBe(0);
    });

    it("1d. CONTROL: a change that does not touch revision needs no change row", async () => {
      await inTx(() => client.query("update wbs set name = 'x' where id = $1", [A]));
      const result = await client.query<{ name: string }>("select name from wbs where id = $1", [A]);
      expect(result.rows[0]!.name).toBe("x");
      expect(await wbsRevision(A)).toBe("1");
    });

    it("4a. a task.update rename through the service commits: revision 1 -> 2 with one wbs_change row", async () => {
      const leaf = record.tasks.find((task) => task.parentTaskId !== null)!;
      const execution = await service().execute({
        tenantId: T,
        projectId: A,
        expectedRevision: 1n,
        operationId: "guard-rename-1",
        actor: ACTOR,
        commands: [{ type: "task.update", taskId: leaf.id, changes: { name: "Renamed by guard test" } }],
      });
      expect(execution.revision).toBe(2n);
      expect(await wbsRevision(A)).toBe("2");
      expect(await count("wbs_change", "wbs_id = $1 and revision = 2", [A])).toBe(1);
      expect(await count("wbs_change", "wbs_id = $1", [A])).toBe(1);
      expect(await count("task", "id = $1 and name = 'Renamed by guard test'", [leaf.id])).toBe(1);
    });

    it("4b. repository.save of a fresh record (new wbs id) commits and load returns it", async () => {
      await client.query("truncate table tenant cascade");
      const fresh = createSeedProjectRecord({
        ...SMALL,
        tenantId: "c0000000-0000-4000-8000-000000000001",
        projectId: "c1000000-0000-4000-8000-000000000001",
      });
      await repository.save(fresh);
      const loaded = await repository.load(fresh.tenant.id, fresh.project.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.project.id).toBe("c1000000-0000-4000-8000-000000000001");
      expect(loaded!.project.name).toBe(fresh.project.name);
      expect(loaded!.tasks).toHaveLength(fresh.tasks.length);
      expect(fresh.tasks.length).toBeGreaterThan(0);
      expect(await wbsRevision(fresh.project.id)).toBe("1");
    });
  });

  // ------------------------------------------------------------------ 2, 3, 4c
  describe("2-4. content tables need a marker naming the row's wbs", () => {
    let record: PersistedProjectRecord;
    let A: string;
    let B: string;
    let T: string;
    const pkColumns = new Map<ContentTable, string[]>();

    beforeAll(async () => {
      await client.query("truncate table tenant cascade");
      record = createSeedProjectRecord(SMALL);
      await repository.save(record);
      A = record.project.id;
      T = record.tenant.id;
      B = "b0000000-0000-4000-8000-0000000000b2";

      // Baseline rows come from the real path: the baseline.publish command.
      const published = await service().execute({
        tenantId: T,
        projectId: A,
        expectedRevision: 1n,
        operationId: "guard-publish-1",
        actor: ACTOR,
        commands: [{ type: "baseline.publish" }],
      });
      expect(published.revision).toBe(2n);

      // A second wbs in the same tenant, inserted the way task-id-tenancy.test.ts does.
      await client.query("insert into project (id, tenant_id, name) values ($1, $2, 'Other')", [B, T]);
      await client.query(
        `insert into wbs (id, tenant_id, project_id, name, project_start, status_date)
         values ($1, $2, $1, 'Other', '2026-01-05', '2026-03-02')`,
        [B, T],
      );

      for (const table of CONTENT_TABLES) {
        const result = await client.query<{ attname: string }>(
          `select a.attname from pg_index i
           join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
           where i.indrelid = $1::regclass and i.indisprimary order by a.attnum`,
          [table],
        );
        pkColumns.set(table, result.rows.map((row) => row.attname));
      }
    }, 60_000);

    it("seed: every one of the 9 tables has a row for wbs A", async () => {
      for (const table of CONTENT_TABLES) {
        expect(await count(table, "wbs_id = $1", [A]), table).toBeGreaterThanOrEqual(1);
      }
    });

    /** A copy of a wbs A row with fresh keys, as the JSON `json_populate_record` reads back. */
    async function makeProbe(table: ContentTable): Promise<Row> {
      const sample = await client.query<{ r: Row }>(
        `select to_jsonb(t) as r from ${table} t where wbs_id = $1 order by to_jsonb(t)::text limit 1`,
        [A],
      );
      const row = { ...sample.rows[0]!.r };
      switch (table) {
        case "task": {
          const max = await client.query<{ n: number }>("select max(seq)::int as n from task where wbs_id = $1", [A]);
          return { ...row, id: randomUUID(), seq: max.rows[0]!.n + 1 };
        }
        case "task_dependency": {
          const types = ["FS", "SS", "FF", "SF"];
          for (const swap of [false, true]) {
            for (const type of types) {
              if (!swap && type === row.type) continue;
              const pred = swap ? row.successor_task_id : row.predecessor_task_id;
              const succ = swap ? row.predecessor_task_id : row.successor_task_id;
              const taken = await count(
                "task_dependency",
                "wbs_id = $1 and predecessor_task_id = $2 and successor_task_id = $3 and type = $4",
                [A, pred, succ, type],
              );
              if (taken === 0) {
                return { ...row, id: randomUUID(), predecessor_task_id: pred, successor_task_id: succ, type };
              }
            }
          }
          throw new Error("no free dependency edge variant left");
        }
        case "calendar":
          return { ...row, id: `guard-${randomUUID()}` };
        case "baseline": {
          const max = await client.query<{ n: number }>(
            "select max(version)::int as n from baseline where wbs_id = $1",
            [A],
          );
          return { ...row, version: max.rows[0]!.n + 1 };
        }
        case "baseline_task":
          return { ...row, task_id: randomUUID() };
        default:
          return { ...row, id: randomUUID() };
      }
    }

    function where(table: ContentTable, probe: Row): { text: string; params: string[] } {
      const columns = pkColumns.get(table)!;
      return {
        text: columns.map((column, index) => `"${column}" = $${(index + 1).toString()}`).join(" and "),
        params: columns.map((column) => String(probe[column])),
      };
    }

    const insertProbe = (table: ContentTable, probe: Row) =>
      client.query(`insert into ${table} select (json_populate_record(null::${table}, $1::json)).*`, [
        JSON.stringify(probe),
      ]);

    /**
     * Run `op` against a wbs A probe row under `marker`, in one transaction.
     * UPDATE/DELETE first insert the probe under a valid marker, then switch.
     */
    async function runOp(table: ContentTable, op: Op, marker: string | null, probe: Row): Promise<void> {
      await inTx(async () => {
        const w = where(table, probe);
        if (op !== "INSERT") {
          await setMarker(client, `${A}:1`);
          await insertProbe(table, probe);
        }
        await setMarker(client, marker);
        if (op === "INSERT") await insertProbe(table, probe);
        else if (op === "UPDATE")
          await client.query(`update ${table} set ${UPDATE_SPEC[table].set} where ${w.text}`, w.params);
        else await client.query(`delete from ${table} where ${w.text}`, w.params);
      });
    }

    const MALFORMED = (a: string): [string, string][] => [
      ["empty", ""],
      ["blank", "   "],
      ["no revision part", a],
      ["empty revision", `${a}:`],
      ["non-numeric revision", `${a}:abc`],
    ];

    for (const table of CONTENT_TABLES) {
      describe(`2. ${table}`, () => {
        for (const op of ["INSERT", "UPDATE", "DELETE"] as const) {
          it(`2a. ${op} with no marker -> marker missing`, async () => {
            const probe = await makeProbe(table);
            await expectRefusal(runOp(table, op, null, probe), MISSING);
          });

          it(`2b. ${op} with a marker naming another wbs -> does not name wbs A`, async () => {
            const probe = await makeProbe(table);
            await expectRefusal(runOp(table, op, `${B}:1`, probe), notNaming(A));
          });

          for (const [label, build] of MALFORMED("%A%").map(([l, m]) => [l, m] as const)) {
            it(`2c. ${op} with a malformed marker (${label}) -> marker missing`, async () => {
              const probe = await makeProbe(table);
              await expectRefusal(runOp(table, op, build.replaceAll("%A%", A), probe), MISSING);
            });
          }

          it(`2d. CONTROL: ${op} with marker A:1 ${IMMUTABLE.has(table) && op !== "INSERT" ? "reaches the immutability trigger" : "succeeds and the row changed"}`, async () => {
            const probe = await makeProbe(table);
            const w = where(table, probe);
            if (IMMUTABLE.has(table) && op !== "INSERT") {
              await expectRefusal(runOp(table, op, `${A}:1`, probe), immutable(op, table), "23001");
              return;
            }
            await runOp(table, op, `${A}:1`, probe);
            if (op === "INSERT") {
              expect(await count(table, w.text, w.params)).toBe(1);
            } else if (op === "UPDATE") {
              const spec = UPDATE_SPEC[table];
              const read = await client.query<{ v: string }>(
                `select ${spec.column}::text as v from ${table} where ${w.text}`,
                w.params,
              );
              expect(read.rows.map((row) => row.v)).toEqual([spec.expected]);
            } else {
              expect(await count(table, w.text, w.params)).toBe(0);
            }
          });
        }

        it("2d. CONTROL: an UPPERCASE wbs id in the marker is accepted", async () => {
          const probe = await makeProbe(table);
          await runOp(table, "INSERT", `${A.toUpperCase()}:1`, probe);
          const w = where(table, probe);
          expect(await count(table, w.text, w.params)).toBe(1);
        });
      });
    }

    it("2a. a brand-new connection that never set the marker is refused too (true NULL)", async () => {
      const fresh = new Client({ connectionString: testDatabase.connectionString });
      await fresh.connect();
      try {
        const probe = await makeProbe("task");
        await expectRefusal(
          inTx(
            () =>
              fresh.query("insert into task select (json_populate_record(null::task, $1::json)).*", [
                JSON.stringify(probe),
              ]),
            fresh,
          ),
          MISSING,
        );
      } finally {
        await fresh.end();
      }
    });

    describe("2e. changing wbs_id", () => {
      const move = (marker: string) =>
        inTx(async () => {
          await setMarker(client, marker);
          const task = await client.query<{ id: string }>("select id from task where wbs_id = $1 limit 1", [A]);
          await client.query("update task set wbs_id = $1 where id = $2", [B, task.rows[0]!.id]);
        });

      it("marker B:1 -> does not name wbs A (the row's old wbs)", async () => {
        await expectRefusal(move(`${B}:1`), notNaming(A));
      });

      it("marker A:1 -> does not name wbs B (the row's new wbs)", async () => {
        await expectRefusal(move(`${A}:1`), notNaming(B));
      });

      it("CONTROL: the same task update that keeps wbs_id passes under A:1 and changes the row", async () => {
        const task = await client.query<{ id: string }>("select id from task where wbs_id = $1 limit 1", [A]);
        await inTx(async () => {
          await setMarker(client, `${A}:1`);
          await client.query("update task set note = 'kept in A' where id = $1", [task.rows[0]!.id]);
        });
        expect(await count("task", "id = $1 and wbs_id = $2 and note = 'kept in A'", [task.rows[0]!.id, A])).toBe(1);
      });
    });

    describe("3. the marker is transaction-local", () => {
      it("set in one committed transaction, it is gone in the next", async () => {
        const probe = await makeProbe("task");
        await inTx(() => setMarker(client, `${A}:1`));
        await expectRefusal(
          inTx(() =>
            client.query("insert into task select (json_populate_record(null::task, $1::json)).*", [
              JSON.stringify(probe),
            ]),
          ),
          MISSING,
        );
      });

      it("CONTROL: the same insert inside a transaction that sets the marker succeeds", async () => {
        const probe = await makeProbe("task");
        await inTx(async () => {
          await setMarker(client, `${A}:1`);
          await client.query("insert into task select (json_populate_record(null::task, $1::json)).*", [
            JSON.stringify(probe),
          ]);
        });
        expect(await count("task", "id = $1", [probe.id])).toBe(1);
      });
    });

    describe("4c. deleting a wbs cascades into content tables", () => {
      let C = "";
      const cascaded = [
        "task_dependency",
        "task",
        "member",
        "calendar",
        "process",
        "product",
        "subtask_template",
      ] as const;

      async function createC(): Promise<void> {
        C = randomUUID();
        await client.query("insert into project (id, tenant_id, name) values ($1, $2, 'C')", [C, T]);
        await client.query(
          `insert into wbs (id, tenant_id, project_id, name, project_start, status_date)
           values ($1, $2, $1, 'C', '2026-01-05', '2026-03-02')`,
          [C, T],
        );
        await inTx(async () => {
          await setMarker(client, `${C}:0`);
          const ids = Array.from({ length: 5 }, () => randomUUID());
          await client.query(
            "insert into calendar (tenant_id, wbs_id, id, name, working_weekdays, non_working_dates) values ($1,$2,'cal-c','Cal','{1,2,3,4,5}','{}')",
            [T, C],
          );
          await client.query(
            "insert into member (id, tenant_id, wbs_id, name, calendar_id, daily_capacity_minutes) values ($3,$1,$2,'M','cal-c',480)",
            [T, C, ids[0]],
          );
          await client.query("insert into process (id, tenant_id, wbs_id, name) values ($3,$1,$2,'P')", [T, C, ids[1]]);
          await client.query("insert into product (id, tenant_id, wbs_id, name) values ($3,$1,$2,'Q')", [T, C, ids[2]]);
          await client.query(
            "insert into subtask_template (id, tenant_id, wbs_id, name, subtasks) values ($3,$1,$2,'S','[]'::jsonb)",
            [T, C, randomUUID()],
          );
          await client.query(
            "insert into task (id, tenant_id, wbs_id, seq, name) values ($3,$1,$2,1,'t1'), ($4,$1,$2,2,'t2')",
            [T, C, ids[3], ids[4]],
          );
          await client.query(
            "insert into task_dependency (tenant_id, wbs_id, predecessor_task_id, successor_task_id) values ($1,$2,$3,$4)",
            [T, C, ids[3], ids[4]],
          );
        });
      }

      it("without a marker the delete is refused with the marker message and C is intact", async () => {
        await createC();
        for (const table of cascaded) expect(await count(table, "wbs_id = $1", [C]), table).toBeGreaterThan(0);
        await expectRefusal(
          inTx(() => client.query("delete from wbs where id = $1", [C])),
          MISSING,
        );
        expect(await count("wbs", "id = $1", [C])).toBe(1);
        for (const table of cascaded) expect(await count(table, "wbs_id = $1", [C]), table).toBeGreaterThan(0);
      });

      it("with a marker naming another wbs the cascading delete is refused, naming C", async () => {
        await createC();
        await expectRefusal(
          inTx(async () => {
            await setMarker(client, `${B}:0`);
            await client.query("delete from wbs where id = $1", [C]);
          }),
          notNaming(C),
        );
        expect(await count("wbs", "id = $1", [C])).toBe(1);
        expect(await count("task", "wbs_id = $1", [C])).toBe(2);
      });

      it("CONTROL: with marker C:0 the delete succeeds, C's rows are gone, A and B are untouched", async () => {
        await createC();
        await client.query("begin");
        await client.query("select set_config('vecta.wbs_write', $1, true)", [`${B}:0`]);
        await client.query("insert into task (id, tenant_id, wbs_id, seq, name) values ($1,$2,$3,1,'b-task')", [
          randomUUID(),
          T,
          B,
        ]);
        await client.query("commit");

        const before = new Map<string, number>();
        for (const table of CONTENT_TABLES) before.set(`${table}/A`, await count(table, "wbs_id = $1", [A]));
        const bBefore = await count("task", "wbs_id = $1", [B]);
        expect(bBefore).toBe(1);

        await inTx(async () => {
          await setMarker(client, `${C}:0`);
          await client.query("delete from wbs where id = $1", [C]);
        });

        expect(await count("wbs", "id = $1", [C])).toBe(0);
        for (const table of cascaded) expect(await count(table, "wbs_id = $1", [C]), table).toBe(0);
        for (const table of CONTENT_TABLES) {
          expect(await count(table, "wbs_id = $1", [A]), `${table}/A`).toBe(before.get(`${table}/A`));
        }
        expect(await count("task", "wbs_id = $1", [B])).toBe(1);
      });

      it("a wbs that has a baseline and audit history cannot be deleted at all (restrict FKs, 23503)", async () => {
        // Why 4c runs on C: A holds a baseline and an audit event; baseline -> wbs and audit_event -> wbs are RESTRICT.
        let caught: unknown;
        try {
          await inTx(async () => {
            await setMarker(client, `${A}:2`);
            await client.query("delete from wbs where id = $1", [A]);
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toMatchObject({ code: "23503" });
        expect((caught as Error).message).toContain("violates foreign key constraint");
        expect(await count("wbs", "id = $1", [A])).toBe(1);
        expect(await count("baseline", "wbs_id = $1", [A])).toBeGreaterThan(0);
      });
    });
  });
});
