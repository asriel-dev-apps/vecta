import {
  applyWbsChange,
  canonicalWbsState,
  createProjectCommandService,
  emptyWbsState,
  readWbsChange,
  WbsChangeCorruptError,
  type FieldChange,
  type ProjectCommand,
  type ProjectState,
  type WbsChange,
} from "@vecta/application";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPersistenceDatabase,
  createSeedProjectRecord,
  migratePersistenceDatabase,
  PostgresProjectCommandUnitOfWork,
  ProjectRepository,
  toProjectState,
  type PersistedProjectRecord,
  type TaskRecord,
} from "../src/index.js";
import { startTestDatabase, type TestDatabase } from "./database.js";

/**
 * Tests for review fixes R1 (e8cd652) and R2 (59469e4) of M1 #2.
 *
 * Fault injection (items 1-3): `diffOperation` is wrapped so the record the unit
 * of work writes differs from the state it computed. The unit of work imports it
 * from "@vecta/application", which `vi.mock` replaces for this file only.
 */

type Diffed = { after: ProjectState; change: WbsChange };
const injection = vi.hoisted(() => ({ edit: null as null | ((result: Diffed) => Diffed) }));

vi.mock("@vecta/application", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vecta/application")>();
  return {
    ...actual,
    diffOperation: (...args: Parameters<typeof actual.diffOperation>) => {
      const result = actual.diffOperation(...args);
      return injection.edit === null ? result : injection.edit(result);
    },
  };
});

const ACTOR = { type: "HUMAN" as const, id: "user-001" };
const SHAPE = { parentCount: 1, subtasksPerParent: 2, memberCount: 1 };

/** Drop the first record entry whose field starts with `prefix`; returns a function that says which one went. */
function dropFirst(prefix: string): { edit: (result: Diffed) => Diffed; dropped: () => FieldChange } {
  let dropped: FieldChange | null = null;
  return {
    edit: (result) => {
      const index = result.change.changes.findIndex((entry) => entry.field.startsWith(prefix));
      if (index < 0) throw new Error(`no ${prefix} entry in the record`);
      dropped = result.change.changes[index]!;
      return {
        ...result,
        change: { ...result.change, changes: result.change.changes.filter((_, at) => at !== index) },
      };
    },
    dropped: () => {
      if (dropped === null) throw new Error("the injection never ran");
      return dropped;
    },
  };
}

describe("review fixes R1 + R2", () => {
  let client: Client;
  let testDatabase: TestDatabase;
  let repository: ProjectRepository;

  beforeAll(async () => {
    testDatabase = await startTestDatabase("review_fixes");
    client = testDatabase.client;
    await migratePersistenceDatabase(client);
    repository = new ProjectRepository(createPersistenceDatabase(client));
  }, 60_000);

  afterAll(async () => {
    await testDatabase.dispose();
  });

  beforeEach(async () => {
    injection.edit = null;
    await client.query("truncate table tenant cascade");
  });

  const leafOf = (record: PersistedProjectRecord) => record.tasks.find((task) => task.parentTaskId !== null)!;

  /** The first leaf, with its cells replaced. */
  function withLeaf(record: PersistedProjectRecord, patch: Partial<TaskRecord>): PersistedProjectRecord {
    const target = leafOf(record);
    return { ...record, tasks: record.tasks.map((task) => (task.id === target.id ? { ...task, ...patch } : task)) };
  }

  async function seed(record: PersistedProjectRecord): Promise<void> {
    await repository.save(record);
  }

  async function readWbs(record: PersistedProjectRecord): Promise<ProjectState> {
    const loaded = await repository.load(record.tenant.id, record.project.id);
    if (loaded === null) throw new Error("WBS not found");
    return toProjectState(loaded);
  }

  function execute(
    record: PersistedProjectRecord,
    expectedRevision: bigint,
    operationId: string,
    commands: readonly ProjectCommand[],
  ) {
    const service = createProjectCommandService(
      new PostgresProjectCommandUnitOfWork(createPersistenceDatabase(client)),
    );
    return service.execute({
      tenantId: record.tenant.id,
      projectId: record.project.id,
      expectedRevision,
      operationId,
      actor: ACTOR,
      commands,
    });
  }

  async function storedChange(record: PersistedProjectRecord, revision: number): Promise<WbsChange> {
    const result = await client.query<{ change: unknown }>(
      "select change from wbs_change where wbs_id = $1 and revision = $2",
      [record.project.id, revision],
    );
    expect(result.rows).toHaveLength(1);
    return readWbsChange(result.rows[0]!.change);
  }

  async function column(record: PersistedProjectRecord, name: "daily_plan" | "dated_actuals", id: string) {
    const result = await client.query<{ cells: Record<string, number> }>(
      `select ${name} as cells from task where wbs_id = $1 and id = $2`,
      [record.project.id, id],
    );
    return result.rows[0]!.cells;
  }

  async function snapshotOfDb(record: PersistedProjectRecord) {
    const revision = await client.query<{ revision: string }>(
      "select revision::text as revision from wbs where id = $1",
      [record.project.id],
    );
    const changes = await client.query<{ n: number }>(
      "select count(*)::int as n from wbs_change where wbs_id = $1",
      [record.project.id],
    );
    return {
      revision: revision.rows[0]!.revision,
      changes: changes.rows[0]!.n,
      state: canonicalWbsState(await readWbs(record)),
    };
  }

  // -------------------------------------------------------------------------
  // 1. E: a dropped cell entry cannot reach the database
  // -------------------------------------------------------------------------
  describe("1. E: the cells written are the cells recorded", () => {
    it("a dropped dailyPlan ADD is absent from daily_plan; the other cell is kept; replay of the record equals the DB", async () => {
      const record = withLeaf(createSeedProjectRecord(SHAPE), { dailyPlan: {} });
      const leaf = leafOf(record);
      await seed(record);
      const before = await readWbs(record);

      const fault = dropFirst("dailyPlan.");
      injection.edit = fault.edit;
      await execute(record, 1n, "e-daily-add", [
        {
          type: "task.update",
          taskId: leaf.id,
          changes: { dailyPlan: { "2026-03-01": 10, "2026-03-02": 20 }, plannedEffortMinutes: 30 },
        },
      ]);
      injection.edit = null;

      expect(fault.dropped().field).toBe("dailyPlan.2026-03-01");
      expect(await column(record, "daily_plan", leaf.id)).toEqual({ "2026-03-02": 20 });

      const stored = await storedChange(record, 2);
      expect(stored.changes.filter((entry) => entry.field.startsWith("dailyPlan."))).toEqual([
        { target: `task:${leaf.id}`, field: "dailyPlan.2026-03-02", after: 20, kind: "direct" },
      ]);
      expect(canonicalWbsState(applyWbsChange(before, stored))).toBe(canonicalWbsState(await readWbs(record)));
    });

    it("a dropped dailyPlan REMOVAL leaves that cell in daily_plan (the record said nothing about it); replay equals the DB", async () => {
      const record = withLeaf(createSeedProjectRecord(SHAPE), {
        dailyPlan: { "2026-03-01": 10, "2026-03-02": 20 },
      });
      const leaf = leafOf(record);
      await seed(record);
      const before = await readWbs(record);

      const fault = dropFirst("dailyPlan.");
      injection.edit = fault.edit;
      await execute(record, 1n, "e-daily-remove", [
        { type: "task.update", taskId: leaf.id, changes: { dailyPlan: {}, plannedEffortMinutes: 0 } },
      ]);
      injection.edit = null;

      expect(fault.dropped()).toEqual({
        target: `task:${leaf.id}`,
        field: "dailyPlan.2026-03-01",
        before: 10,
        kind: "direct",
      });
      expect(await column(record, "daily_plan", leaf.id)).toEqual({ "2026-03-01": 10 });
      const stored = await storedChange(record, 2);
      expect(canonicalWbsState(applyWbsChange(before, stored))).toBe(canonicalWbsState(await readWbs(record)));
    });

    it("a dropped datedActuals ADD is absent from dated_actuals; the other cell is kept; replay equals the DB", async () => {
      const record = withLeaf(createSeedProjectRecord(SHAPE), { datedActuals: {} });
      const leaf = leafOf(record);
      const member = record.members[0]!.id;
      await seed(record);
      const before = await readWbs(record);

      const fault = dropFirst("datedActuals.");
      injection.edit = fault.edit;
      await execute(record, 1n, "e-actual-add", [
        {
          type: "task.update",
          taskId: leaf.id,
          changes: {
            datedActuals: { [`2026-01-05|${member}`]: 100, [`2026-01-06|${member}`]: 150 },
            actualEffortMinutes: 250,
          },
        },
      ]);
      injection.edit = null;

      expect(fault.dropped().field).toBe(`datedActuals.2026-01-05|${member}`);
      expect(await column(record, "dated_actuals", leaf.id)).toEqual({ [`2026-01-06|${member}`]: 150 });
      const stored = await storedChange(record, 2);
      expect(canonicalWbsState(applyWbsChange(before, stored))).toBe(canonicalWbsState(await readWbs(record)));
    });
  });

  // -------------------------------------------------------------------------
  // 2. H: the cell-free fast path is loud
  // -------------------------------------------------------------------------
  it("2. H: a cell-free update whose record carries a dailyPlan entry throws and commits nothing", async () => {
    const record = withLeaf(createSeedProjectRecord(SHAPE), { dailyPlan: { "2026-03-02": 20 } });
    const leaf = leafOf(record);
    await seed(record);
    const before = await snapshotOfDb(record);
    expect(before.revision).toBe("1");
    expect(before.changes).toBe(1);

    injection.edit = (result) => ({
      ...result,
      change: {
        ...result.change,
        changes: [
          ...result.change.changes,
          { target: `task:${leaf.id}`, field: "dailyPlan.2026-03-01", after: 10, kind: "direct" },
        ],
      },
    });
    await expect(
      execute(record, 1n, "h-cell-free", [{ type: "task.update", taskId: leaf.id, changes: { name: "Renamed" } }]),
    ).rejects.toThrow(new Error(`Cell-free update recorded dailyPlan.2026-03-01 on task:${leaf.id}`));
    injection.edit = null;

    expect(await snapshotOfDb(record)).toEqual(before);
    expect(await column(record, "daily_plan", leaf.id)).toEqual({ "2026-03-02": 20 });
    const receipts = await client.query("select 1 from command_receipt where wbs_id = $1", [record.project.id]);
    expect(receipts.rowCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 3. I: an unmapped field is loud
  // -------------------------------------------------------------------------
  it("3. I: a record entry for a field that is not a column throws WbsChangeCorruptError and commits nothing", async () => {
    const record = createSeedProjectRecord(SHAPE);
    const leaf = leafOf(record);
    await seed(record);
    const before = await snapshotOfDb(record);

    injection.edit = (result) => ({
      ...result,
      change: {
        ...result.change,
        changes: [
          ...result.change.changes,
          { target: `task:${leaf.id}`, field: "notAColumn", before: "a", after: "b", kind: "direct" },
        ],
      },
    });
    let caught: unknown;
    try {
      await execute(record, 1n, "i-unknown-field", [
        { type: "task.update", taskId: leaf.id, changes: { name: "Renamed" } },
      ]);
    } catch (error) {
      caught = error;
    }
    injection.edit = null;

    expect(caught).toBeInstanceOf(WbsChangeCorruptError);
    expect((caught as Error).message).toBe("Invalid WBS change: unknown task field notAColumn");
    expect(await snapshotOfDb(record)).toEqual(before);
    const named = await client.query<{ name: string }>("select name from task where id = $1", [leaf.id]);
    expect(named.rows[0]!.name).toBe(leaf.name);
  });

  // -------------------------------------------------------------------------
  // 4. R1 C: creation is one operation
  // -------------------------------------------------------------------------
  describe("4. C: WBS creation records revision 1", () => {
    it("save writes exactly one wbs_change row (wbs-creation, SYSTEM, revision 1) whose replay onto the empty state is the stored WBS", async () => {
      const record = createSeedProjectRecord(SHAPE);
      await seed(record);

      const rows = await client.query<{
        revision: string;
        operation_id: string;
        actor_type: string;
        actor_id: string;
        format: number;
        change: unknown;
      }>(
        "select revision::text as revision, operation_id, actor_type, actor_id, format, change from wbs_change where wbs_id = $1",
        [record.project.id],
      );
      expect(rows.rows.map((row) => ({ ...row, change: undefined }))).toEqual([
        { revision: "1", operation_id: "wbs-creation", actor_type: "SYSTEM", actor_id: "wbs-creation", format: 1, change: undefined },
      ]);
      const replayed = applyWbsChange(emptyWbsState(record.project.id), readWbsChange(rows.rows[0]!.change));
      expect(canonicalWbsState(replayed)).toBe(canonicalWbsState(await readWbs(record)));
      const wbsRow = await client.query<{ revision: string }>("select revision::text as revision from wbs where id = $1", [
        record.project.id,
      ]);
      expect(wbsRow.rows[0]!.revision).toBe("1");
    });

    it("saving a record at revision 2 is refused with the literal message and writes nothing", async () => {
      const record = createSeedProjectRecord(SHAPE);
      await expect(
        repository.save({ ...record, project: { ...record.project, revision: 2n } }),
      ).rejects.toThrow(new Error("WBS creation requires revision 1, received 2"));
      expect((await client.query("select 1 from wbs")).rowCount).toBe(0);
      expect((await client.query("select 1 from wbs_change")).rowCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 5. R1 B: the marker is tied to the revision and its change row
  // -------------------------------------------------------------------------
  describe("5. B: the marker, the revision and the change row agree at COMMIT", () => {
    let record: PersistedProjectRecord;
    let tenantId: string;
    let wbsId: string;
    let taskId: string;
    let current: bigint;

    beforeEach(async () => {
      record = createSeedProjectRecord(SHAPE);
      await seed(record);
      tenantId = record.tenant.id;
      wbsId = record.project.id;
      taskId = leafOf(record).id;
      const row = await client.query<{ revision: string }>("select revision::text as revision from wbs where id = $1", [
        wbsId,
      ]);
      current = BigInt(row.rows[0]!.revision);
    });

    const setMarker = (revision: bigint) =>
      client.query("select set_config('vecta.wbs_write', $1, true)", [`${wbsId}:${revision}`]);
    const bump = () => client.query("update wbs set revision = revision + 1 where id = $1", [wbsId]);
    const rename = (name: string) => client.query("update task set name = $1 where id = $2", [name, taskId]);
    const addChange = (revision: bigint) =>
      client.query(
        `insert into wbs_change (tenant_id, wbs_id, revision, operation_id, actor_type, actor_id, format, change)
         values ($1, $2, $3, $4, 'SYSTEM', 'review-fixes', 1, '{"format":1,"changes":[]}'::jsonb)`,
        [tenantId, wbsId, revision.toString(), `b-${revision}-${Math.random()}`],
      );

    /** Runs `work`, then COMMITs; returns the error the COMMIT (or an earlier statement) raised. */
    async function commitError(work: () => Promise<unknown>): Promise<{ code: string | undefined; message: string; at: "work" | "commit" }> {
      await client.query("begin");
      let at: "work" | "commit" = "work";
      try {
        await work();
        at = "commit";
        await client.query("commit");
      } catch (error) {
        try {
          await client.query("rollback");
        } catch {
          // the error above is the one under test
        }
        const caught = error as { code?: string; message: string };
        return { code: caught.code, message: caught.message, at };
      }
      throw new Error("the transaction committed, but it was expected to be refused");
    }

    async function nameNow(): Promise<string> {
      return (await client.query<{ name: string }>("select name from task where id = $1", [taskId])).rows[0]!.name;
    }

    it("a marker naming the right WBS at the current revision, with no bump, is refused at COMMIT", async () => {
      const original = await nameNow();
      const error = await commitError(async () => {
        await setMarker(current);
        await rename("no-bump");
      });
      expect(error).toEqual({
        code: "P0001",
        at: "commit",
        message: `wbs write marker revision ${current} has no change written for wbs ${wbsId}`,
      });
      expect(await nameNow()).toBe(original);
    });

    it("marker current+1 with the bump but no change row is refused at COMMIT", async () => {
      const original = await nameNow();
      const error = await commitError(async () => {
        await setMarker(current + 1n);
        await bump();
        await rename("no-change");
      });
      expect(error).toEqual({ code: "P0001", at: "commit", message: `wbs_change missing for wbs ${wbsId} revision ${current + 1n}` });
      expect(await nameNow()).toBe(original);
    });

    it("marker current+1 with the change row but no bump is refused at COMMIT", async () => {
      const original = await nameNow();
      const error = await commitError(async () => {
        await setMarker(current + 1n);
        await addChange(current + 1n);
        await rename("no-bump-2");
      });
      expect(error).toEqual({
        code: "P0001",
        at: "commit",
        message: `wbs write marker revision ${current + 1n} has no change written for wbs ${wbsId}`,
      });
      expect(await nameNow()).toBe(original);
    });

    it("marker current+1 with the change row and the wbs row touched in this transaction, but its revision not advanced, is refused", async () => {
      // The wbs row is "in progress" (its name changed) and so is the change row; only the revision
      // equality `w.revision = rev_part` tells this from a real revision write.
      const original = await nameNow();
      const error = await commitError(async () => {
        await setMarker(current + 1n);
        await client.query("update wbs set name = name || '!' where id = $1", [wbsId]);
        await addChange(current + 1n);
        await rename("touched-not-bumped");
      });
      expect(error).toEqual({
        code: "P0001",
        at: "commit",
        message: `wbs write marker revision ${current + 1n} has no change written for wbs ${wbsId}`,
      });
      expect(await nameNow()).toBe(original);
    });

    it("CONTROL: the correct bump, change row and marker commit, and the row changed", async () => {
      await client.query("begin");
      await setMarker(current + 1n);
      await bump();
      await addChange(current + 1n);
      await rename("recorded");
      await client.query("commit");
      expect(await nameNow()).toBe("recorded");
      const row = await client.query<{ revision: string }>("select revision::text as revision from wbs where id = $1", [
        wbsId,
      ]);
      expect(row.rows[0]!.revision).toBe(String(current + 1n));
    });
  });

  // -------------------------------------------------------------------------
  // 6. R1 D: the record cannot be rewritten
  // -------------------------------------------------------------------------
  describe("6. D: wbs_change, wbs_snapshot and wbs_verified_range are append-only", () => {
    let wbsId: string;
    let tenantId: string;

    beforeEach(async () => {
      const record = createSeedProjectRecord(SHAPE);
      await seed(record);
      wbsId = record.project.id;
      tenantId = record.tenant.id;
      // A verified range hangs off two snapshots; the save made revision 1, so add a second (fixture bytes).
      await client.query(
        `insert into wbs_snapshot (tenant_id, wbs_id, revision, format, sha256, body, body_bytes, raw_bytes)
         values ($1, $2, 2, 1, $3, '\\x00', 1, 1)`,
        [tenantId, wbsId, "ab".repeat(32)],
      );
      await client.query(
        `insert into wbs_verified_range (tenant_id, wbs_id, from_revision, to_revision, failure)
         values ($1, $2, 1, 2, null)`,
        [tenantId, wbsId],
      );
    });

    const statements: readonly { name: string; sql: string; message: string }[] = [
      { name: "UPDATE wbs_change", sql: "update wbs_change set actor_id = 'tamper' where wbs_id = $1", message: "UPDATE on wbs_change is refused" },
      { name: "DELETE wbs_change", sql: "delete from wbs_change where wbs_id = $1", message: "DELETE on wbs_change is refused" },
      { name: "DELETE wbs_snapshot", sql: "delete from wbs_snapshot where wbs_id = $1", message: "wbs_snapshot is immutable" },
      { name: "UPDATE wbs_verified_range", sql: "update wbs_verified_range set failure = 'x' where wbs_id = $1", message: "UPDATE on wbs_verified_range is refused" },
      { name: "DELETE wbs_verified_range", sql: "delete from wbs_verified_range where wbs_id = $1", message: "DELETE on wbs_verified_range is refused" },
    ];

    for (const statement of statements) {
      it(`${statement.name} is refused (P0001, literal message); under session_replication_role = replica it succeeds`, async () => {
        let caught: { code?: string; message?: string } | null = null;
        try {
          await client.query(statement.sql, [wbsId]);
        } catch (error) {
          caught = error as { code?: string; message?: string };
        }
        expect(caught).toEqual(expect.objectContaining({ code: "P0001", message: statement.message }));

        // CONTROL: with triggers off the same statement runs, so the trigger was what refused it.
        await client.query("begin");
        try {
          await client.query("set local session_replication_role = replica");
          const done = await client.query(statement.sql, [wbsId]);
          expect(done.rowCount).toBeGreaterThan(0);
        } finally {
          await client.query("rollback");
        }
      });
    }

    it("UPDATE wbs_snapshot is refused with the same literal message", async () => {
      await expect(client.query("update wbs_snapshot set format = 1 where wbs_id = $1", [wbsId])).rejects.toMatchObject({
        code: "P0001",
        message: "wbs_snapshot is immutable",
      });
    });
  });
});
