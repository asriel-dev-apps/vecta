import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  canonicalWbsState,
  createProjectCommandService,
  decodeWbsSnapshot,
  hashWbsState,
  ProjectCommandValidationError,
  readWbsChange,
  type ProjectCommand,
  type ProjectState,
} from "@vecta/application";
import type { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPersistenceDatabase,
  createSeedProjectRecord,
  migratePersistenceDatabase,
  PostgresProjectCommandUnitOfWork,
  ProjectRepository,
  takeWbsSnapshot,
  toProjectState,
  WbsSnapshotConflictError,
  WbsSnapshotStore,
  type PersistedProjectRecord,
} from "../src/index.js";
import { startTestDatabase, type TestDatabase } from "./database.js";

/**
 * WBS snapshots (M1 #2 unit 6) against real Postgres: the store, `save`, the
 * unit of work's due/base/failure rules, and the script-level `takeBase` /
 * `verifyNext`.
 */

type Query = (...args: unknown[]) => Promise<unknown>;
type Rows = Record<string, { ins: number; upd: number; del: number }>;

const ACTOR = { type: "HUMAN" as const, id: "user-001" };
const SHAPE = { parentCount: 1, subtasksPerParent: 2, memberCount: 1 }; // 1 parent + 2 leaves

function statementText(argument: unknown): string {
  if (typeof argument === "string") return argument;
  const text = (argument as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text : "";
}

describe("wbs snapshot", () => {
  let client: Client;
  let testDatabase: TestDatabase;
  let repository: ProjectRepository;

  beforeAll(async () => {
    testDatabase = await startTestDatabase("wbs_snapshot");
    client = testDatabase.client;
    await migratePersistenceDatabase(client);
    repository = new ProjectRepository(createPersistenceDatabase(client));
  }, 60_000);

  afterAll(async () => {
    await testDatabase.dispose();
  });

  beforeEach(async () => {
    await client.query("truncate table tenant cascade");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function seed(): Promise<PersistedProjectRecord> {
    const record = createSeedProjectRecord(SHAPE);
    await repository.save(record);
    return record;
  }

  const keyOf = (record: PersistedProjectRecord) => ({ tenantId: record.tenant.id, wbsId: record.project.id });
  const leafIds = (record: PersistedProjectRecord) =>
    record.tasks.filter((task) => task.parentTaskId !== null).map((task) => task.id);

  function service(snapshotInterval?: () => number) {
    return createProjectCommandService(
      new PostgresProjectCommandUnitOfWork(
        createPersistenceDatabase(client),
        snapshotInterval === undefined ? {} : { snapshotInterval },
      ),
    );
  }

  function edit(
    record: PersistedProjectRecord,
    expectedRevision: number,
    commands: readonly ProjectCommand[],
    interval: () => number = () => 3,
  ) {
    return service(interval).execute({
      tenantId: record.tenant.id,
      projectId: record.project.id,
      expectedRevision: BigInt(expectedRevision),
      operationId: `op-${expectedRevision.toString()}`,
      actor: ACTOR,
      commands,
    });
  }

  const rename = (taskId: string, name: string): ProjectCommand => ({
    type: "task.update",
    taskId,
    changes: { name },
  });

  async function readWbs(record: PersistedProjectRecord): Promise<ProjectState> {
    const loaded = await repository.load(record.tenant.id, record.project.id);
    if (loaded === null) throw new Error("WBS not found");
    return toProjectState(loaded);
  }

  interface SnapshotRow {
    revision: number;
    format: number;
    sha256: string;
    body: Buffer;
    body_bytes: number;
    octets: number;
  }

  async function snapshotRows(): Promise<SnapshotRow[]> {
    const result = await client.query<SnapshotRow>(
      `select revision::int as revision, format::int as format, sha256, body, body_bytes,
              octet_length(body) as octets
         from wbs_snapshot order by revision`,
    );
    return result.rows;
  }

  const revisionsOf = async () => (await snapshotRows()).map((row) => row.revision);

  /** Append-only triggers stay enabled. Replica role is how a test simulates corruption. */
  async function tamper(statement: string, params: unknown[] = []): Promise<void> {
    await client.query("begin");
    try {
      await client.query("set local session_replication_role = replica");
      await client.query(statement, params);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }

  const decodeRow = (row: SnapshotRow) =>
    decodeWbsSnapshot({ format: row.format, sha256: row.sha256, body: new Uint8Array(row.body) });

  async function withStatementHook<T>(
    hook: (statement: string, raw: Query) => Promise<void>,
    body: () => Promise<T>,
  ): Promise<T> {
    const original = client.query.bind(client) as Query;
    let inHook = false;
    (client as unknown as { query: Query }).query = async (...args: unknown[]) => {
      const result = await original(...args);
      if (!inHook) {
        inHook = true;
        try {
          await hook(statementText(args[0]), original);
        } finally {
          inHook = false;
        }
      }
      return result;
    };
    try {
      return await body();
    } finally {
      (client as unknown as { query: unknown }).query = original;
    }
  }

  // ---- 2a ----
  it("a. save writes exactly one snapshot, at the seed revision, equal to the re-read state", async () => {
    const record = await seed();
    const rows = await snapshotRows();

    expect(rows.map((row) => [row.revision, row.format])).toEqual([[1, 1]]);
    expect(rows[0]!.body_bytes).toBe(rows[0]!.octets);
    expect(rows[0]!.body_bytes).toBeGreaterThan(0);
    const decoded = await decodeRow(rows[0]!);
    const reread = await readWbs(record);
    expect(canonicalWbsState(decoded)).toBe(canonicalWbsState(reread));
    expect(decoded.tasks).toHaveLength(3);
    expect(rows[0]!.sha256).toBe(await hashWbsState(reread));
  });

  // ---- 2b ----
  it("b. re-taking the same state is 'existed'; a changed state at that revision is a conflict; UPDATE is refused", async () => {
    const record = await seed();
    const db = createPersistenceDatabase(client);
    const state = await readWbs(record);

    expect(await takeWbsSnapshot(db, keyOf(record), 1n, state)).toBe("existed");
    expect(await revisionsOf()).toEqual([1]);

    const changed = { ...state, name: `${state.name} changed` };
    const error = await takeWbsSnapshot(db, keyOf(record), 1n, changed).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WbsSnapshotConflictError);
    expect((error as Error).message).toBe(`wbs_snapshot ${record.project.id}@1 exists with a different hash`);
    expect(await revisionsOf()).toEqual([1]);

    const update = await client.query("update wbs_snapshot set format = 1").catch((e: unknown) => e);
    expect((update as { code?: string }).code).toBe("P0001");
    expect((update as Error).message).toBe("wbs_snapshot is immutable");

    const deleted = await client.query("delete from wbs_snapshot").catch((e: unknown) => e);
    expect((deleted as { code?: string }).code).toBe("P0001");
    expect((deleted as Error).message).toBe("wbs_snapshot is immutable");
    expect(await revisionsOf()).toEqual([1]);
  });

  // ---- 2c ----
  it("c. interval 3, seven renames from revision 1: rows at exactly [1, 4, 7], each equal to the DB re-read", async () => {
    const record = await seed();
    const leaf = leafIds(record)[0]!;
    const reread = new Map<number, string>([[1, canonicalWbsState(await readWbs(record))]]);

    for (let step = 1; step <= 7; step += 1) {
      const result = await edit(record, step, [rename(leaf, `Renamed ${step.toString()}`)]);
      expect(result.revision).toBe(BigInt(step + 1));
      reread.set(step + 1, canonicalWbsState(await readWbs(record)));
    }

    const rows = await snapshotRows();
    expect(rows.map((row) => row.revision)).toEqual([1, 4, 7]);
    for (const row of rows) {
      expect(canonicalWbsState(await decodeRow(row))).toBe(reread.get(row.revision));
    }
    expect((await decodeRow(rows[1]!)).tasks.find((task) => task.id === leaf)?.name).toBe("Renamed 3");
    expect((await decodeRow(rows[2]!)).tasks.find((task) => task.id === leaf)?.name).toBe("Renamed 6");
  }, 60_000);

  // ---- 2d ----
  it("d. a WBS with no snapshot gets its base inside the edit's transaction; a failed edit leaves none", async () => {
    const record = await seed();
    await tamper("delete from wbs_snapshot"); // a WBS that never went through save
    const leaf = leafIds(record)[0]!;
    const statements: string[] = [];

    const failing = await withStatementHook(
      async (statement) => {
        statements.push(statement);
      },
      () => edit(record, 1, [rename("no-such-task", "x")]).catch((e: unknown) => e),
    );

    expect(failing).toBeInstanceOf(ProjectCommandValidationError);
    expect(statements.some((statement) => /insert into "wbs_snapshot"/i.test(statement))).toBe(true);
    expect(statements.some((statement) => /^\s*rollback/i.test(statement))).toBe(true);
    expect(await revisionsOf()).toEqual([]);

    const ok = await edit(record, 1, [rename(leaf, "Renamed")]);
    expect(ok.revision).toBe(2n);
    expect(await revisionsOf()).toEqual([1]);
  });

  // ---- 2e ----
  it("e. a due snapshot whose insert fails after commit: the edit stays committed, one console.error, the next due edit snapshots", async () => {
    const record = await seed();
    const leaf = leafIds(record)[0]!;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (let step = 1; step <= 3; step += 1) await edit(record, step, [rename(leaf, `R${step.toString()}`)]);
    expect(await revisionsOf()).toEqual([1]);

    // The unit of work reads "last snapshot = 1" under the lock; a row with revision 4 and another hash
    // then appears inside the same transaction, so the after-commit insert of revision 4 conflicts.
    let planted = 0;
    const result = await withStatementHook(
      async (statement, raw) => {
        if (planted === 0 && /for update/i.test(statement)) {
          planted += 1;
          await raw(
            `insert into wbs_snapshot (tenant_id, wbs_id, revision, format, sha256, body, body_bytes, raw_bytes)
             values ($1, $2, 4, 1, $3, '\\x00', 1, 1)`,
            [record.tenant.id, record.project.id, "f".repeat(64)],
          );
        }
      },
      () => edit(record, 4, [rename(leaf, "R4")]), // pre-edit revision 4 is due
    );
    expect(planted).toBe(1);
    expect(result.revision).toBe(5n);
    expect(result.replayed).toBe(false);
    expect((await readWbs(record)).tasks.find((task) => task.id === leaf)?.name).toBe("R4");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      `wbs snapshot failed for ${record.project.id} revision 4 (WbsSnapshotConflictError)`,
    );
    expect(await revisionsOf()).toEqual([1, 4]);
    expect((await snapshotRows())[1]!.sha256).toBe("f".repeat(64));

    await edit(record, 5, [rename(leaf, "R5")]);
    await edit(record, 6, [rename(leaf, "R6")]);
    expect(await revisionsOf()).toEqual([1, 4]);
    await edit(record, 7, [rename(leaf, "R7")]); // 7 - 4 = 3: due again
    expect(await revisionsOf()).toEqual([1, 4, 7]);
    expect(spy).toHaveBeenCalledTimes(1);
  }, 60_000);

  // ---- 2f ----
  it("f. a not-due rename writes the same rows as before: wbs_snapshot ins 0", async () => {
    const record = await seed();
    const leaf = leafIds(record)[0]!;
    const read = async (raw: Query): Promise<Rows> => {
      const result = (await raw(
        `select relname, n_tup_ins::int as ins, n_tup_upd::int as upd, n_tup_del::int as del
           from pg_stat_xact_user_tables where schemaname = 'public'`,
      )) as { rows: { relname: string; ins: number; upd: number; del: number }[] };
      const rows: Rows = {};
      for (const row of result.rows) rows[row.relname] = { ins: row.ins, upd: row.upd, del: row.del };
      return rows;
    };
    let baseline: Rows | null = null;
    let captured: Rows | null = null;
    await withStatementHook(async (statement, raw) => {
      if (baseline === null && /^\s*begin/i.test(statement)) {
        baseline = await read(raw);
      } else if (baseline !== null && captured === null && /insert into "command_receipt"/i.test(statement)) {
        const now = await read(raw);
        captured = {};
        for (const [table, counts] of Object.entries(now)) {
          const base = baseline[table] ?? { ins: 0, upd: 0, del: 0 };
          captured[table] = { ins: counts.ins - base.ins, upd: counts.upd - base.upd, del: counts.del - base.del };
        }
      }
    }, () => edit(record, 1, [rename(leaf, "Renamed")], () => 100));
    if (captured === null) throw new Error("row probe never fired");
    const rows: Rows = captured;

    const zero = { ins: 0, upd: 0, del: 0 };
    const expected: Rows = {};
    for (const table of Object.keys(rows)) expected[table] = zero;
    expect(Object.keys(rows)).toContain("wbs_snapshot");
    expect(rows).toEqual({
      ...expected,
      task: { ins: 0, upd: 1, del: 0 },
      wbs: { ins: 0, upd: 1, del: 0 },
      command_receipt: { ins: 1, upd: 0, del: 0 },
      audit_event: { ins: 1, upd: 0, del: 0 },
      wbs_change: { ins: 1, upd: 0, del: 0 },
    });
    expect(await revisionsOf()).toEqual([1]);
  });

  // ---- 2g ----
  describe("g. WbsSnapshotStore (what db:snapshot calls)", () => {
    it("takeBase twice is 'inserted' then 'existed'", async () => {
      const record = await seed();
      await tamper("delete from wbs_snapshot");
      const store = new WbsSnapshotStore(createPersistenceDatabase(client));

      expect(await store.takeBase(keyOf(record))).toEqual({ revision: 1n, result: "inserted" });
      expect(await store.takeBase(keyOf(record))).toEqual({ revision: 1n, result: "existed" });
      expect(await revisionsOf()).toEqual([1]);
    });

    async function twoSnapshots() {
      const record = await seed();
      const leaf = leafIds(record)[0]!;
      for (let step = 1; step <= 4; step += 1) {
        await edit(record, step, [{ type: "task.update", taskId: leaf, changes: { name: `N${step.toString()}`, note: `m${step.toString()}` } }]);
      }
      expect(await revisionsOf()).toEqual([1, 4]);
      return record;
    }

    const verifiedRows = async () =>
      (
        await client.query<{ from_revision: number; to_revision: number; failure: string | null }>(
          "select from_revision::int, to_revision::int, failure from wbs_verified_range order by from_revision",
        )
      ).rows;

    it("verifyNext with intact changes is ok, records a NULL failure, and the second call is null", async () => {
      const record = await twoSnapshots();
      const store = new WbsSnapshotStore(createPersistenceDatabase(client));

      expect(await store.verifyNext(keyOf(record))).toEqual({ ok: true, from: 1n, to: 4n });
      expect(await verifiedRows()).toEqual([{ from_revision: 1, to_revision: 4, failure: null }]);
      expect(await store.verifyNext(keyOf(record))).toBeNull();
      expect(await verifiedRows()).toHaveLength(1);
    }, 60_000);

    it("verifyNext with one field change dropped from the last stored change is a 'hash' failure, recorded", async () => {
      const record = await twoSnapshots();
      const stored = await client.query<{ change: unknown }>(
        "select change from wbs_change where wbs_id = $1 and revision = 4",
        [record.project.id],
      );
      const change = readWbsChange(stored.rows[0]!.change);
      expect(change.changes.map((entry) => entry.field)).toEqual(["name", "note"]);
      await tamper("update wbs_change set change = $1::jsonb where wbs_id = $2 and revision = 4", [
        JSON.stringify({ ...change, changes: change.changes.filter((entry) => entry.field !== "note") }),
        record.project.id,
      ]);
      const store = new WbsSnapshotStore(createPersistenceDatabase(client));

      const verdict = await store.verifyNext(keyOf(record));
      expect(verdict).toMatchObject({ ok: false, from: 1n, to: 4n, reason: "hash" });
      expect(await verifiedRows()).toEqual([{ from_revision: 1, to_revision: 4, failure: "hash" }]);
    }, 60_000);

    it("a corrupt change is corrupt@ that revision; a later range and another WBS still verify, and verify exits 1 twice", async () => {
      const broken = await seed();
      const brokenLeaf = leafIds(broken)[0]!;
      for (let step = 1; step <= 7; step += 1) {
        await edit(broken, step, [rename(brokenLeaf, `B${step.toString()}`)]);
      }
      expect(await revisionsOf()).toEqual([1, 4, 7]);
      await tamper(`update wbs_change set change = '{"format":1}'::jsonb where wbs_id = $1 and revision = 2`, [
        broken.project.id,
      ]);

      // Task ids in a seed are a fixed sequence, so a second record needs its own.
      const shiftIds = <T>(value: T, marker: string): T => {
        if (typeof value === "string") return value.replaceAll("-4000-8000-", `-4000-${marker}-`) as T;
        if (Array.isArray(value)) return value.map((item) => shiftIds(item, marker)) as T;
        if (typeof value === "bigint" || value === null || typeof value !== "object") return value;
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) out[key] = shiftIds(item, marker);
        return out as T;
      };
      const other = shiftIds(createSeedProjectRecord(SHAPE), "8001");
      await repository.save(other);
      const otherLeaf = leafIds(other)[0]!;
      for (let step = 1; step <= 4; step += 1) {
        await edit(other, step, [rename(otherLeaf, `O${step.toString()}`)]);
      }

      const throwing = shiftIds(createSeedProjectRecord(SHAPE), "7000");
      await repository.save(throwing);
      const throwingLeaf = leafIds(throwing)[0]!;
      for (let step = 1; step <= 4; step += 1) {
        await edit(throwing, step, [rename(throwingLeaf, `T${step.toString()}`)]);
      }
      await tamper("update wbs_snapshot set body = '\\x00' where wbs_id = $1 and revision = 1", [
        throwing.project.id,
      ]);

      const script = fileURLToPath(new URL("../scripts/wbs-snapshot.mjs", import.meta.url));
      const target = new URL(testDatabase.connectionString);
      const runVerify = () =>
        spawnSync(process.execPath, ["--experimental-transform-types", script, "verify"], {
          encoding: "utf8",
          env: {
            ...process.env,
            DATABASE_URL: testDatabase.connectionString,
            EXPECTED_DATABASE_HOST: target.hostname,
            EXPECTED_DATABASE_NAME: decodeURIComponent(target.pathname.replace(/^\//u, "")),
          },
        });

      const first = runVerify();
      expect(first.status).toBe(1);
      const firstOut = first.stdout;
      expect(firstOut).toContain(`${throwing.project.id} error`);
      expect(firstOut).toContain(`${broken.project.id} 1->4 corrupt@2`);
      expect(firstOut).toContain(`${broken.project.id} 4->7 ok`);
      expect(firstOut).toContain(`${other.project.id} 1->4 ok`);

      const stored = await client.query<{ wbs_id: string; from_revision: string; to_revision: string; failure: string | null }>(
        `select wbs_id, from_revision::text, to_revision::text, failure
           from wbs_verified_range
          order by wbs_id, from_revision`,
      );
      expect(stored.rows).toEqual([
        { wbs_id: broken.project.id, from_revision: "1", to_revision: "4", failure: "corrupt@2" },
        { wbs_id: broken.project.id, from_revision: "4", to_revision: "7", failure: null },
        { wbs_id: other.project.id, from_revision: "1", to_revision: "4", failure: null },
      ]);

      const second = runVerify();
      expect(second.status).toBe(1);
      expect(second.stdout).toContain(`${broken.project.id} 1->4 corrupt@2`);
      expect(second.stdout).toContain(`${throwing.project.id} error`);
      expect(second.stdout).not.toContain(`${broken.project.id} 4->7 ok`);
    }, 90_000);
  });
});
