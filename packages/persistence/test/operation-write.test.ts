import {
  applyProjectCommand,
  applyWbsChange,
  canonicalWbsState,
  createProjectCommandService,
  deriveSubtaskId,
  hashWbsState,
  IdempotencyConflictError,
  ProjectCommandValidationError,
  readWbsChange,
  type ProjectCommand,
  type ProjectCommandExecution,
  type ProjectState,
  type WbsChange,
} from "@vecta/application";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { withWbsWriteMarker } from "./wbs-write-marker.js";

/**
 * One operation = one transaction = one revision (M1 #2 unit 4), driven through
 * the real command service against real Postgres.
 *
 * Two probes, both wrapping `client.query` the way `write-path-scaling.test.ts`
 * does (the unit of work runs on this very session):
 *
 * - the ROW probe reads `pg_stat_xact_user_tables` (per-backend, current
 *   transaction only) right after the `command_receipt` insert, which is the last
 *   write of an operation, so it sees exactly what the operation wrote;
 * - the MARKER probe reads `vecta.wbs_write` after every statement.
 */

type Query = (...args: unknown[]) => Promise<unknown>;
type Rows = Record<string, { ins: number; upd: number; del: number }>;

const ACTOR = { type: "HUMAN" as const, id: "user-001" };
const SMALL_SHAPE = { parentCount: 1, subtasksPerParent: 2, memberCount: 1 }; // 1 parent + 2 leaves
const LARGE_SHAPE = { parentCount: 20, subtasksPerParent: 14, memberCount: 2 }; // 20 + 280 = 300 tasks

function statementText(argument: unknown): string {
  if (typeof argument === "string") return argument;
  const text = (argument as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text : "";
}

describe("operation write (one operation, one transaction, one revision)", () => {
  let client: Client;
  let testDatabase: TestDatabase;
  let repository: ProjectRepository;

  beforeAll(async () => {
    testDatabase = await startTestDatabase("operation_write");
    client = testDatabase.client;
    await migratePersistenceDatabase(client);
    repository = new ProjectRepository(createPersistenceDatabase(client));
  }, 60_000);

  afterAll(async () => {
    await testDatabase.dispose();
  });

  async function seed(record: PersistedProjectRecord): Promise<void> {
    await client.query("truncate table tenant cascade");
    await repository.save(record);
  }

  beforeEach(async () => {
    await client.query("truncate table tenant cascade");
  });

  function service() {
    return createProjectCommandService(
      new PostgresProjectCommandUnitOfWork(createPersistenceDatabase(client)),
    );
  }

  function operation(
    record: PersistedProjectRecord,
    expectedRevision: bigint,
    operationId: string,
    commands: readonly ProjectCommand[],
    actor: { type: "HUMAN" | "AGENT" | "SYSTEM"; id: string } = ACTOR,
  ): Promise<ProjectCommandExecution> {
    return service().execute({
      tenantId: record.tenant.id,
      projectId: record.project.id,
      expectedRevision,
      operationId,
      actor,
      commands,
    });
  }

  async function readWbs(record: PersistedProjectRecord): Promise<ProjectState> {
    const loaded = await repository.load(record.tenant.id, record.project.id);
    if (loaded === null) throw new Error("WBS not found");
    return toProjectState(loaded);
  }

  async function hashOf(record: PersistedProjectRecord): Promise<string> {
    return hashWbsState(await readWbs(record));
  }

  async function count(table: string, where = "true"): Promise<number> {
    const result = await client.query<{ n: number }>(
      `select count(*)::int as n from ${table} where ${where}`,
    );
    return result.rows[0]!.n;
  }

  async function storedChange(record: PersistedProjectRecord, revision: number): Promise<WbsChange> {
    const result = await client.query<{ change: unknown }>(
      "select change from wbs_change where wbs_id = $1 and revision = $2",
      [record.project.id, revision],
    );
    expect(result.rows).toHaveLength(1);
    return readWbsChange(result.rows[0]!.change);
  }

  async function wbsRevision(record: PersistedProjectRecord): Promise<number> {
    const result = await client.query<{ revision: number }>(
      "select revision::int as revision from wbs where id = $1",
      [record.project.id],
    );
    return result.rows[0]!.revision;
  }

  /** Run `body` with `hook` firing after every statement the unit of work sends (not after the hook's own). */
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

  /**
   * Rows each public table received inside the transaction, read right after
   * `trigger` resolves. `pg_stat_xact_user_tables` is NOT reset per transaction
   * (measured: pending counters of earlier transactions on the session stay
   * visible until the stats flush), so the counters are read once right after
   * `begin` and subtracted.
   */
  async function probeRows(trigger: RegExp, body: () => Promise<unknown>): Promise<Rows> {
    const read = async (raw: Query): Promise<Rows> => {
      const result = (await raw(
        `select relname,
                n_tup_ins::int as ins, n_tup_upd::int as upd, n_tup_del::int as del
           from pg_stat_xact_user_tables
          where schemaname = 'public'`,
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
      } else if (baseline !== null && captured === null && trigger.test(statement)) {
        const now = await read(raw);
        captured = {};
        for (const [table, counts] of Object.entries(now)) {
          const base = baseline[table] ?? { ins: 0, upd: 0, del: 0 };
          captured[table] = { ins: counts.ins - base.ins, upd: counts.upd - base.upd, del: counts.del - base.del };
        }
      }
    }, body);
    if (baseline === null) throw new Error("row probe never saw the transaction begin");
    if (captured === null) throw new Error("row probe never fired: the trigger statement was not seen");
    return captured;
  }

  const RECEIPT_INSERT = /insert into "command_receipt"/i;
  const REQUIRED_TABLES = [
    "wbs", "task", "task_dependency", "member", "calendar", "process", "product",
    "subtask_template", "command_receipt", "audit_event", "wbs_change",
  ];

  function expectedRows(probed: Rows, touched: Rows): Rows {
    const expected: Rows = {};
    for (const table of Object.keys(probed)) expected[table] = { ins: 0, upd: 0, del: 0 };
    return { ...expected, ...touched };
  }

  const leavesOf = (record: PersistedProjectRecord) => record.tasks.filter((task) => task.parentTaskId !== null);

  // -------------------------------------------------------------------------
  // 1. rows touched
  // -------------------------------------------------------------------------
  describe("1. rows touched are independent of the WBS size", () => {
    const renameMap: Rows = {
      task: { ins: 0, upd: 1, del: 0 },
      wbs: { ins: 0, upd: 1, del: 0 },
      command_receipt: { ins: 1, upd: 0, del: 0 },
      audit_event: { ins: 1, upd: 0, del: 0 },
      wbs_change: { ins: 1, upd: 0, del: 0 },
    };

    async function renameRows(shape: typeof SMALL_SHAPE, id: string): Promise<{ rows: Rows; tasks: number; dependencies: number }> {
      const record = createSeedProjectRecord(shape);
      await seed(record);
      const leaf = leavesOf(record)[0]!;
      const rows = await probeRows(RECEIPT_INSERT, () =>
        operation(record, 1n, id, [{ type: "task.update", taskId: leaf.id, changes: { name: "Renamed" } }]),
      );
      return { rows, tasks: record.tasks.length, dependencies: record.dependencies.length };
    }

    it("a one-task rename writes the same literal rows for 3 tasks and for 300 tasks (+ >100 dependencies)", async () => {
      const small = await renameRows(SMALL_SHAPE, "op-rename-small");
      const large = await renameRows(LARGE_SHAPE, "op-rename-large");

      expect(small.tasks).toBe(3);
      expect(large.tasks).toBe(300);
      expect(large.dependencies).toBeGreaterThan(100);
      expect(Object.keys(small.rows).length).toBeGreaterThanOrEqual(REQUIRED_TABLES.length);
      for (const table of REQUIRED_TABLES) expect(Object.keys(small.rows)).toContain(table);

      const message = `small=${JSON.stringify(small.rows)} large=${JSON.stringify(large.rows)}`;
      expect(small.rows, message).toEqual(expectedRows(small.rows, renameMap));
      expect(large.rows, message).toEqual(expectedRows(large.rows, renameMap));
      expect(JSON.stringify(large.rows), message).toBe(JSON.stringify(small.rows));
    }, 60_000);

    it("CONTROL: a 2-task update reports task upd 2, so the probe sees per-row counts", async () => {
      const record = createSeedProjectRecord(SMALL_SHAPE);
      await seed(record);
      const [first, second] = leavesOf(record);
      const rows = await probeRows(RECEIPT_INSERT, () =>
        operation(record, 1n, "op-two-updates", [
          { type: "task.update", taskId: first!.id, changes: { name: "One" } },
          { type: "task.update", taskId: second!.id, changes: { name: "Two" } },
        ]),
      );
      expect(rows.task).toEqual({ ins: 0, upd: 2, del: 0 });
      expect(rows.wbs).toEqual({ ins: 0, upd: 1, del: 0 });
      expect(rows.wbs_change).toEqual({ ins: 1, upd: 0, del: 0 });
    });

    it("probe self-check: seeding 300 tasks through repository.save reports task ins 300 and >100 dependency inserts", async () => {
      const record = createSeedProjectRecord(LARGE_SHAPE);
      await client.query("truncate table tenant cascade");
      const rows = await probeRows(/insert into "audit_event"/i, () => repository.save(record));
      expect(rows.task!.ins).toBe(300);
      expect(rows.task_dependency!.ins).toBe(260);
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  // 2. change record size
  // -------------------------------------------------------------------------
  describe("2. the change record does not grow with the daily columns", () => {
    async function renameWithCells(cells: number, id: string) {
      const base = createSeedProjectRecord(SMALL_SHAPE);
      const target = leavesOf(base)[0]!;
      const dailyPlan: Record<string, number> = {};
      const cursor = new Date("2026-01-05T00:00:00.000Z");
      for (let index = 0; index < cells; index += 1) {
        dailyPlan[cursor.toISOString().slice(0, 10)] = 480;
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      const record: PersistedProjectRecord = {
        ...base,
        tasks: base.tasks.map((task) =>
          task.id === target.id ? { ...task, dailyPlan, plannedEffortMinutes: cells * 480 } : task,
        ),
      };
      await seed(record);
      await operation(record, 1n, id, [
        { type: "task.update", taskId: target.id, changes: { name: "Renamed" } },
      ]);
      const size = await client.query<{ n: number; change: unknown }>(
        "select octet_length(change::text) as n, change from wbs_change where wbs_id = $1 and revision = 2",
        [record.project.id],
      );
      return { target, n: size.rows[0]!.n, change: size.rows[0]!.change };
    }

    it("renaming a task with 45 cells and one with 500 cells stores the same literal record, under 300 bytes", async () => {
      const small = await renameWithCells(45, "op-cells-45");
      const large = await renameWithCells(500, "op-cells-500");
      const entry = (target: string, before: string) => ({
        format: 1,
        changes: [{ target: `task:${target}`, field: "name", before, after: "Renamed", kind: "direct" }],
      });

      expect(small.change).toEqual(entry(small.target.id, small.target.name));
      expect(large.change).toEqual(entry(large.target.id, large.target.name));
      expect(small.n).toBeLessThan(300);
      expect(large.n).toBe(small.n);
      console.info(`octet_length(change::text): 45 cells = ${small.n}, 500 cells = ${large.n}`);
    });
  });

  // -------------------------------------------------------------------------
  // 3. 20-sibling reorder
  // -------------------------------------------------------------------------
  it("3. a 20-sibling reorder is ONE revision and ONE wbs_change row", async () => {
    const record = createSeedProjectRecord({ parentCount: 1, subtasksPerParent: 20, memberCount: 1 });
    await seed(record);
    const children = leavesOf(record);
    expect(children).toHaveLength(20);

    const result = await operation(
      record,
      1n,
      "op-reorder",
      children.map((child, index) => ({
        type: "task.update" as const,
        taskId: child.id,
        changes: { sortOrder: 19 - index },
      })),
    );

    expect(result).toEqual({ projectId: record.project.id, revision: 2n, replayed: false });
    expect(await wbsRevision(record)).toBe(2);
    const changes = await client.query<{ n: number; lo: number; hi: number }>(
      "select count(*)::int as n, min(revision)::int as lo, max(revision)::int as hi from wbs_change where revision > 1",
    );
    expect(changes.rows[0]).toEqual({ n: 1, lo: 2, hi: 2 });
    expect(await count("audit_event", "wbs_revision = 2")).toBe(1);
    expect(await count("audit_event")).toBe(2);
    expect(await count("command_receipt")).toBe(1);

    const length = await client.query<{ n: number; kinds: string[]; fields: string[] }>(
      `select jsonb_array_length(change->'changes') as n,
              array(select distinct e->>'kind' from jsonb_array_elements(change->'changes') e) as kinds,
              array(select distinct e->>'field' from jsonb_array_elements(change->'changes') e) as fields
         from wbs_change where revision = 2`,
    );
    expect(length.rows[0]).toEqual({ n: 20, kinds: ["direct"], fields: ["sortOrder"] });

    const after = await repository.load(record.tenant.id, record.project.id);
    const sortOrders = children.map((child) => after!.tasks.find((task) => task.id === child.id)!.sortOrder);
    expect(sortOrders).toEqual([19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  });

  // -------------------------------------------------------------------------
  // 4. atomicity
  // -------------------------------------------------------------------------
  it("4. a failing 3rd command rolls the whole operation back; the corrected re-send with the same id succeeds", async () => {
    const record = createSeedProjectRecord({ parentCount: 1, subtasksPerParent: 3, memberCount: 1 });
    await seed(record);
    const [a, b, c] = leavesOf(record) as [TaskRecord, TaskRecord, TaskRecord];
    const hashBefore = await hashOf(record);

    expect(await wbsRevision(record)).toBe(1);
    expect(await count("command_receipt")).toBe(0);
    expect(await count("audit_event")).toBe(1);
    expect(await count("wbs_change")).toBe(1);

    await expect(
      operation(record, 1n, "op-atomic", [
        { type: "task.update", taskId: a.id, changes: { name: "A2" } },
        { type: "task.update", taskId: b.id, changes: { name: "B2" } },
        { type: "task.update", taskId: c.id, changes: { progressBasisPoints: 10_001 } },
      ]),
    ).rejects.toBeInstanceOf(ProjectCommandValidationError);

    expect(await wbsRevision(record)).toBe(1);
    expect(await count("command_receipt")).toBe(0);
    expect(await count("audit_event")).toBe(1);
    expect(await count("wbs_change")).toBe(1);
    expect(await count("command_receipt", "idempotency_key = 'op-atomic'")).toBe(0);
    expect(await hashOf(record)).toBe(hashBefore);
    const names = await client.query<{ name: string }>("select name from task where id in ($1, $2) order by name", [a.id, b.id]);
    expect(names.rows.map((row) => row.name)).toEqual([a.name, b.name].sort());

    const retried = await operation(record, 1n, "op-atomic", [
      { type: "task.update", taskId: a.id, changes: { name: "A2" } },
      { type: "task.update", taskId: b.id, changes: { name: "B2" } },
      { type: "task.update", taskId: c.id, changes: { progressBasisPoints: 5_000 } },
    ]);
    expect(retried).toEqual({ projectId: record.project.id, revision: 2n, replayed: false });
    const renamed = await client.query<{ name: string }>("select name from task where id in ($1, $2) order by name", [a.id, b.id]);
    expect(renamed.rows.map((row) => row.name)).toEqual(["A2", "B2"]);
  });

  // -------------------------------------------------------------------------
  // 5. replay and idempotency
  // -------------------------------------------------------------------------
  describe("5. replay and idempotency", () => {
    let record: PersistedProjectRecord;
    let leaf: TaskRecord;
    let other: TaskRecord;
    const rename = (name: string): ProjectCommand[] => [{ type: "task.update", taskId: leaf.id, changes: { name } }];

    beforeEach(async () => {
      record = createSeedProjectRecord(SMALL_SHAPE);
      await seed(record);
      [leaf, other] = leavesOf(record) as [TaskRecord, TaskRecord];
    });

    it("a replay returns the original revision whatever expectedRevision says, and writes nothing", async () => {
      const first = await operation(record, 1n, "op-5", rename("Renamed"));
      expect(first).toEqual({ projectId: record.project.id, revision: 2n, replayed: false });
      const hash = await hashOf(record);

      const wrong = await operation(record, 7n, "op-5", rename("Renamed"));
      expect(wrong).toEqual({ projectId: record.project.id, revision: 2n, replayed: true });
      const current = await operation(record, 2n, "op-5", rename("Renamed"));
      expect(current).toEqual({ projectId: record.project.id, revision: 2n, replayed: true });

      expect(await count("audit_event")).toBe(2);
      expect(await count("wbs_change")).toBe(2);
      expect(await count("command_receipt")).toBe(1);
      expect(await wbsRevision(record)).toBe(2);
      expect(await hashOf(record)).toBe(hash);
    });

    it("the same id with different commands, or a different actor, is an IdempotencyConflictError and writes nothing", async () => {
      await operation(record, 1n, "op-5", rename("Renamed"));
      await expect(operation(record, 2n, "op-5", rename("Other name"))).rejects.toBeInstanceOf(IdempotencyConflictError);
      await expect(
        operation(record, 2n, "op-5", rename("Renamed"), { type: "HUMAN", id: "user-002" }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
      expect(await count("audit_event")).toBe(2);
      expect(await count("wbs_change")).toBe(2);
      expect(await count("command_receipt")).toBe(1);
      expect(await wbsRevision(record)).toBe(2);
    });

    it("object key order in the commands does not change the fingerprint", async () => {
      await operation(record, 1n, "op-5", rename("Renamed"));
      const reordered: ProjectCommand[] = [
        { changes: { name: "Renamed" }, taskId: leaf.id, type: "task.update" },
      ];
      const replay = await operation(record, 1n, "op-5", reordered);
      expect(replay).toEqual({ projectId: record.project.id, revision: 2n, replayed: true });
    });

    it("a replay after the revision moved still reports the original revision", async () => {
      await operation(record, 1n, "op-5", rename("Renamed"));
      const second = await operation(record, 2n, "op-5b", [{ type: "task.update", taskId: other.id, changes: { name: "Moved on" } }]);
      expect(second.revision).toBe(3n);
      const replay = await operation(record, 3n, "op-5", rename("Renamed"));
      expect(replay).toEqual({ projectId: record.project.id, revision: 2n, replayed: true });
      expect(await wbsRevision(record)).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // 6. same-value update
  // -------------------------------------------------------------------------
  it("6. renaming a task to its current name commits a revision and records a direct before===after entry", async () => {
    const record = createSeedProjectRecord(SMALL_SHAPE);
    await seed(record);
    const leaf = leavesOf(record)[0]!;
    expect(leaf.name).toBe("Subtask 1.1");

    const result = await operation(record, 1n, "op-same", [
      { type: "task.update", taskId: leaf.id, changes: { name: "Subtask 1.1" } },
    ]);
    expect(result).toEqual({ projectId: record.project.id, revision: 2n, replayed: false });
    const stored = await client.query<{ change: unknown }>("select change from wbs_change where revision = 2");
    expect(stored.rows[0]!.change).toEqual({
      format: 1,
      changes: [{ target: `task:${leaf.id}`, field: "name", before: "Subtask 1.1", after: "Subtask 1.1", kind: "direct" }],
    });
    expect(await count("wbs_change")).toBe(2);
    expect(await count("audit_event")).toBe(2);
    expect(await wbsRevision(record)).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Rich fixture for 7, 8, 9, 12
  // -------------------------------------------------------------------------
  const PARENT_ID = "d0000000-0000-4000-8000-0000000000f1";
  const TEMPLATE_ID = "60000000-0000-4000-8000-0000000000f1";
  const SPARE = {
    member: "c0000000-0000-4000-8000-0000000000f1",
    process: "70000000-0000-4000-8000-0000000000f1",
    product: "80000000-0000-4000-8000-0000000000f1",
    template: "60000000-0000-4000-8000-0000000000f2",
  };

  /** 2 parents with 3 leaves each, plus P (effort 100, no children, unassigned), a 50/30/20 template, and unused masters. */
  function richRecord(): PersistedProjectRecord {
    const base = createSeedProjectRecord({ parentCount: 2, subtasksPerParent: 3, memberCount: 2 });
    const { tenantId, projectId } = { tenantId: base.tenant.id, projectId: base.project.id };
    const parent: TaskRecord = {
      id: PARENT_ID,
      tenantId,
      projectId,
      parentTaskId: null,
      sortOrder: 100,
      seq: base.project.nextTaskSeq,
      name: "Generated parent",
      processId: base.processes[0]!.id,
      productId: base.products[0]!.id,
      note: "",
      contract: "Contract 1",
      assigneeMemberId: null,
      plannedEffortMinutes: 100,
      progressBasisPoints: 0,
      actualEffortMinutes: 0,
      prorationWeightBp: null,
      dailyPlan: {},
      datedActuals: {},
      actualStart: null,
      actualFinish: null,
    };
    return {
      ...base,
      project: { ...base.project, nextTaskSeq: base.project.nextTaskSeq + 1 },
      tasks: [...base.tasks, parent],
      members: [
        ...base.members,
        { id: SPARE.member, tenantId, projectId, name: "Spare member", calendarId: "standard", dailyCapacityMinutes: 240, costRateMinorPerHour: 5_000 },
      ],
      processes: [...base.processes, { id: SPARE.process, tenantId, projectId, name: "Spare process", sortOrder: 90 }],
      products: [...base.products, { id: SPARE.product, tenantId, projectId, name: "Spare product", sortOrder: 90 }],
      templates: [
        ...base.templates,
        {
          id: TEMPLATE_ID, tenantId, projectId, name: "Fifty thirty twenty", sortOrder: 10,
          subtasks: [
            { name: "A", weightBp: 5_000 },
            { name: "B", weightBp: 3_000, dependsOnPrev: { type: "FS", lagWorkingDays: 0 } },
            { name: "C", weightBp: 2_000, dependsOnPrev: { type: "FS", lagWorkingDays: 0 } },
          ],
        },
        { id: SPARE.template, tenantId, projectId, name: "Spare template", sortOrder: 11, subtasks: [{ name: "X", weightBp: 10_000 }] },
      ],
    };
  }

  const GENERATE: ProjectCommand = { type: "task.generateSubtasks", parentTaskId: PARENT_ID, templateId: TEMPLATE_ID };
  const CHILD_IDS = [0, 1, 2].map((index) => deriveSubtaskId(PARENT_ID, index));
  const byCodeUnit = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

  // -------------------------------------------------------------------------
  // 7. parent effort prorates siblings
  // -------------------------------------------------------------------------
  it("7. a parent effort change moves siblings as derived entries and the DB agrees", async () => {
    const record = richRecord();
    await seed(record);
    await operation(record, 1n, "op-gen", [GENERATE]);

    const minutes = () =>
      client.query<{ id: string; planned: number }>(
        "select id, planned_effort_minutes as planned from task where id = any($1) order by id",
        [CHILD_IDS],
      );
    const generated = new Map((await minutes()).rows.map((row) => [row.id, row.planned]));
    expect([0, 1, 2].map((index) => generated.get(CHILD_IDS[index]!))).toEqual([50, 30, 20]);

    const rows = await probeRows(RECEIPT_INSERT, () =>
      operation(record, 2n, "op-parent-effort", [
        { type: "task.update", taskId: PARENT_ID, changes: { plannedEffortMinutes: 200 } },
      ]),
    );
    expect(rows.task).toEqual({ ins: 0, upd: 4, del: 0 });

    const updated = new Map((await minutes()).rows.map((row) => [row.id, row.planned]));
    expect([0, 1, 2].map((index) => updated.get(CHILD_IDS[index]!))).toEqual([100, 60, 40]);
    const parent = await client.query<{ planned: number }>(
      "select planned_effort_minutes as planned from task where id = $1",
      [PARENT_ID],
    );
    expect(parent.rows[0]!.planned).toBe(200);

    const entry = (id: string, before: number, after: number, kind: string) => ({
      target: `task:${id}`, field: "plannedEffortMinutes", before, after, kind,
    });
    const expected = [
      entry(CHILD_IDS[0]!, 50, 100, "derived"),
      entry(CHILD_IDS[1]!, 30, 60, "derived"),
      entry(CHILD_IDS[2]!, 20, 40, "derived"),
      entry(PARENT_ID, 100, 200, "direct"),
    ].sort((left, right) => byCodeUnit(left.target, right.target));
    const stored = await client.query<{ change: unknown }>("select change from wbs_change where revision = 3");
    expect(stored.rows[0]!.change).toEqual({ format: 1, changes: expected });
  });

  // -------------------------------------------------------------------------
  // Shared by 8, 9 and 12: run a setup, one operation, and compare DB with record replay
  // -------------------------------------------------------------------------
  interface Replayed {
    readonly record: PersistedProjectRecord;
    readonly before: ProjectState;
    readonly after: ProjectState;
    readonly hashBefore: string;
    readonly rec: WbsChange;
    readonly revision: bigint;
    readonly commands: readonly ProjectCommand[];
  }

  async function runCase(
    record: PersistedProjectRecord,
    setup: readonly (readonly ProjectCommand[])[],
    commands: readonly ProjectCommand[],
  ): Promise<Replayed> {
    await seed(record);
    let revision = 1n;
    for (const [index, step] of setup.entries()) {
      revision = (await operation(record, revision, `setup-${index}`, step)).revision;
    }
    const before = await readWbs(record);
    const hashBefore = await hashWbsState(before);
    const result = await operation(record, revision, "op-under-test", commands);
    expect(result).toEqual({ projectId: record.project.id, revision: revision + 1n, replayed: false });
    const rec = await storedChange(record, Number(revision + 1n));
    return { record, before, after: await readWbs(record), hashBefore, rec, revision: revision + 1n, commands };
  }

  // -------------------------------------------------------------------------
  // 8. generateSubtasks: scheduler inside the transition
  // -------------------------------------------------------------------------
  it("8. generateSubtasks persists exactly the transition's result, scheduler included, and the record replays to it", async () => {
    const record = richRecord();
    await seed(record);
    const before = await readWbs(record);
    const expected = applyProjectCommand(before, GENERATE);

    const result = await operation(record, 1n, "op-generate", [GENERATE]);
    expect(result.revision).toBe(2n);
    const after = await readWbs(record);

    expect(canonicalWbsState(after)).toBe(canonicalWbsState(expected));
    expect(await hashWbsState(after)).toBe(await hashWbsState(expected));

    const children = CHILD_IDS.map((id) => after.tasks.find((task) => task.id === id)!);
    expect(children.map((child) => child.plannedEffortMinutes)).toEqual([50, 30, 20]);
    expect(children.map((child) => child.dailyPlan)).toEqual([
      { "2026-01-05": 50 },
      { "2026-01-06": 30 },
      { "2026-01-07": 20 },
    ]);

    const rec = await storedChange(record, 2);
    expect(await hashWbsState(applyWbsChange(before, rec))).toBe(await hashWbsState(after));
    expect(JSON.stringify(rec)).toContain("2026-01-05");
  });

  // -------------------------------------------------------------------------
  // 9. every command type
  // -------------------------------------------------------------------------
  interface Case {
    readonly name: string;
    readonly setup?: (record: PersistedProjectRecord) => readonly (readonly ProjectCommand[])[];
    readonly commands: (record: PersistedProjectRecord) => readonly ProjectCommand[];
    /** Number of FieldChange entries the stored record carries, pinned from unit 3's exact FieldChange tests. */
    readonly entries: number;
  }

  const MASTER_TEMPLATE_STEPS = [{ name: "Y", weightBp: 10_000 }];
  const NEW_TASK_ID = "e0000000-0000-4000-8000-00000000aaaa";
  const importDate = "2026-01-05";

  const memberOf = (record: PersistedProjectRecord) => record.members[0]!.id;
  const leafAt = (record: PersistedProjectRecord, index: number) => leavesOf(record)[index]!;

  const CASES: Record<ProjectCommand["type"], readonly Case[]> = {
    "task.add": [{
      name: "task.add (with a dependency and a dailyPlan)",
      entries: 3,
      commands: (record) => [{
        type: "task.add",
        task: {
          id: NEW_TASK_ID, parentId: null, sortOrder: 200, name: "Added", processId: record.processes[0]!.id,
          productId: record.products[0]!.id, note: "", contract: "Contract 1", assigneeMemberId: null,
          plannedEffortMinutes: 60, progressBasisPoints: 0, actualEffortMinutes: 0, prorationWeightBp: null,
          dailyPlan: { "2026-01-07": 60 }, datedActuals: {}, actualStart: null, actualFinish: null,
          dependencies: [{ predecessorId: leafAt(record, 0).id, type: "SS", lagWorkingDays: 1 }],
        },
      }],
    }],
    "task.update": [
      {
        name: "task.update (scalar)",
        entries: 2,
        commands: (record) => [{ type: "task.update", taskId: leafAt(record, 0).id, changes: { name: "New name", note: "n" } }],
      },
      {
        name: "task.update (dailyPlan cells)",
        entries: 9, // 2 cells added, 6 seed cells removed, plannedEffortMinutes
        commands: (record) => [{
          type: "task.update", taskId: leafAt(record, 0).id,
          changes: { dailyPlan: { "2026-01-05": 100, "2026-01-06": 200 }, plannedEffortMinutes: 300 },
        }],
      },
      {
        name: "task.update (datedActuals)",
        entries: 1,
        setup: (record) => [[{
          type: "task.update", taskId: leafAt(record, 0).id,
          changes: { datedActuals: { [`${importDate}|${memberOf(record)}`]: 100 }, actualEffortMinutes: 100 },
        }]],
        commands: (record) => [{
          type: "task.update", taskId: leafAt(record, 0).id,
          changes: { datedActuals: { [`${importDate}|${memberOf(record)}`]: 150 } },
        }],
      },
      {
        name: "task.update (dependencies)",
        entries: 2,
        commands: (record) => [{
          type: "task.update", taskId: leafAt(record, 1).id,
          changes: { dependencies: [{ predecessorId: leafAt(record, 0).id, type: "SS", lagWorkingDays: 2 }] },
        }],
      },
    ],
    "task.delete": [
      {
        name: "task.delete (parent with children)",
        entries: 4, // the row + 3 children re-parented
        setup: () => [[GENERATE]],
        commands: () => [{ type: "task.delete", taskId: PARENT_ID }],
      },
      {
        name: "task.delete (leaf with a dependency edge)",
        entries: 2, // the edge + the row
        commands: (record) => [{ type: "task.delete", taskId: leafAt(record, 2).id }],
      },
    ],
    "task.generateSubtasks": [{
      name: "task.generateSubtasks",
      entries: 6, // 3 rows, 2 edges, nextTaskSeq
      commands: () => [GENERATE],
    }],
    "member.add": [{
      name: "member.add", entries: 1,
      commands: () => [{ type: "member.add", member: { id: "c0000000-0000-4000-8000-0000000000f9", name: "New member", calendarId: "standard", dailyCapacityMinutes: 240, costRateMinorPerHour: null } }],
    }],
    "member.update": [{
      name: "member.update", entries: 1,
      commands: () => [{ type: "member.update", memberId: SPARE.member, changes: { name: "Renamed member" } }],
    }],
    "member.delete": [{ name: "member.delete", entries: 1, commands: () => [{ type: "member.delete", memberId: SPARE.member }] }],
    "process.add": [{
      name: "process.add", entries: 1,
      commands: () => [{ type: "process.add", process: { id: "70000000-0000-4000-8000-0000000000f9", name: "New process", sortOrder: 95 } }],
    }],
    "process.update": [{
      name: "process.update", entries: 1,
      commands: () => [{ type: "process.update", processId: SPARE.process, changes: { name: "Renamed process" } }],
    }],
    "process.delete": [{ name: "process.delete", entries: 1, commands: () => [{ type: "process.delete", processId: SPARE.process }] }],
    "product.add": [{
      name: "product.add", entries: 1,
      commands: () => [{ type: "product.add", product: { id: "80000000-0000-4000-8000-0000000000f9", name: "New product", sortOrder: 95 } }],
    }],
    "product.update": [{
      name: "product.update", entries: 1,
      commands: () => [{ type: "product.update", productId: SPARE.product, changes: { name: "Renamed product" } }],
    }],
    "product.delete": [{ name: "product.delete", entries: 1, commands: () => [{ type: "product.delete", productId: SPARE.product }] }],
    "template.add": [{
      name: "template.add", entries: 1,
      commands: () => [{ type: "template.add", template: { id: "60000000-0000-4000-8000-0000000000f9", name: "New template", sortOrder: 20, subtasks: MASTER_TEMPLATE_STEPS } }],
    }],
    "template.update": [{
      name: "template.update", entries: 1,
      commands: () => [{ type: "template.update", templateId: SPARE.template, changes: { name: "Renamed template" } }],
    }],
    "template.delete": [{ name: "template.delete", entries: 1, commands: () => [{ type: "template.delete", templateId: SPARE.template }] }],
    "baseline.publish": [{
      name: "baseline.publish", entries: 1,
      commands: () => [{ type: "baseline.publish", acknowledgeUnplottedTasks: true }],
    }],
    "actuals.import": [{
      name: "actuals.import", entries: 2,
      commands: (record) => [{
        type: "actuals.import",
        entries: [{ taskId: leafAt(record, 0).id, workDate: importDate, memberId: memberOf(record), actualMinutes: 30 }],
      }],
    }],
  };

  const ALL_CASES: readonly Case[] = Object.values(CASES).flat();

  describe("9. every command type: DB after == applyWbsChange(before, stored record)", () => {
    it.each(ALL_CASES.map((entry) => [entry.name, entry] as const))("%s", async (_name, entry) => {
      const record = richRecord();
      const commands = entry.commands(record);
      const run = await runCase(record, entry.setup?.(record) ?? [], commands);

      expect(await hashWbsState(applyWbsChange(run.before, run.rec))).toBe(await hashWbsState(run.after));
      expect(await hashWbsState(run.after)).not.toBe(run.hashBefore);
      expect(run.rec.changes).toHaveLength(entry.entries);
      expect(canonicalWbsState(run.after)).toBe(
        canonicalWbsState(commands.reduce(applyProjectCommand, run.before)),
      );
    }, 30_000);

    it("baseline.publish freezes one row per leaf (as baseline-publish.test.ts pins)", async () => {
      const record = richRecord();
      await seed(record);
      await operation(record, 1n, "op-baseline", [{ type: "baseline.publish", acknowledgeUnplottedTasks: true }]);
      const parents = new Set(record.tasks.map((task) => task.parentTaskId).filter((id) => id !== null));
      const leafCount = record.tasks.filter((task) => !parents.has(task.id)).length;
      expect(leafCount).toBe(7);
      expect(await count("baseline_task")).toBe(7);
    });
  });

  // -------------------------------------------------------------------------
  // 11. marker
  // -------------------------------------------------------------------------
  describe("11. vecta.wbs_write marker", () => {
    interface Step { sql: string; marker: string | null }

    async function recordMarkers(body: () => Promise<unknown>): Promise<Step[]> {
      const steps: Step[] = [];
      await withStatementHook(async (statement, raw) => {
        const result = (await raw("select current_setting('vecta.wbs_write', true) as marker")) as {
          rows: { marker: string | null }[];
        };
        steps.push({ sql: statement.toLowerCase(), marker: result.rows[0]!.marker });
      }, body);
      return steps;
    }

    const unset = (marker: string | null) => marker === null || marker === "";
    const markerNow = async () =>
      (await client.query<{ marker: string | null }>("select current_setting('vecta.wbs_write', true) as marker")).rows[0]!.marker;

    it("is set to <wbs>:<new revision> before any content write, held to the receipt insert, and gone after commit", async () => {
      const record = createSeedProjectRecord(SMALL_SHAPE);
      await seed(record);
      const leaf = leavesOf(record)[0]!;
      const wbsId = record.project.id;

      const steps = await recordMarkers(() =>
        operation(record, 1n, "op-marker-1", [{ type: "task.update", taskId: leaf.id, changes: { name: "Renamed" } }]),
      );
      const setAt = steps.findIndex((step) => step.sql.includes("set_config"));
      const firstWrite = steps.findIndex((step) => /update "task"|insert into "wbs_change"/.test(step.sql));
      const receipt = steps.findIndex((step) => /insert into "command_receipt"/.test(step.sql));
      const commit = steps.findIndex((step) => step.sql.trim() === "commit");

      expect(setAt).toBeGreaterThan(-1);
      expect(firstWrite).toBeGreaterThan(setAt);
      expect(receipt).toBeGreaterThan(firstWrite);
      expect(commit).toBeGreaterThan(receipt);
      for (const step of steps.slice(0, setAt)) expect(unset(step.marker)).toBe(true);
      for (const step of steps.slice(setAt, receipt + 1)) expect(step.marker).toBe(`${wbsId}:2`);
      expect(steps.findIndex((step) => step.marker === `${wbsId}:2`)).toBe(setAt);
      expect(unset(steps[commit]!.marker)).toBe(true);
      expect(unset(await markerNow())).toBe(true);

      const second = await recordMarkers(() =>
        operation(record, 2n, "op-marker-2", [{ type: "task.update", taskId: leaf.id, changes: { name: "Renamed again" } }]),
      );
      const secondReceipt = second.findIndex((step) => /insert into "command_receipt"/.test(step.sql));
      expect(second[secondReceipt]!.marker).toBe(`${wbsId}:3`);
    });

    it("a replay never sets the marker, and a failed operation leaves it unset", async () => {
      const record = createSeedProjectRecord(SMALL_SHAPE);
      await seed(record);
      const leaf = leavesOf(record)[0]!;
      const commands: ProjectCommand[] = [{ type: "task.update", taskId: leaf.id, changes: { name: "Renamed" } }];
      await operation(record, 1n, "op-marker-replay", commands);

      const replay = await recordMarkers(() => operation(record, 1n, "op-marker-replay", commands));
      expect(replay.length).toBeGreaterThan(0);
      expect(replay.every((step) => unset(step.marker))).toBe(true);
      expect(replay.some((step) => step.sql.includes("set_config"))).toBe(false);

      await expect(
        operation(record, 2n, "op-marker-fail", [{ type: "task.update", taskId: leaf.id, changes: { progressBasisPoints: 10_001 } }]),
      ).rejects.toBeInstanceOf(ProjectCommandValidationError);
      expect(unset(await markerNow())).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 12. negative controls
  // -------------------------------------------------------------------------
  describe("12. negative controls: the comparison can see a missing entry or a missing DB write", () => {
    async function differing(run: Replayed): Promise<number> {
      const target = await hashWbsState(run.after);
      let different = 0;
      for (let index = 0; index < run.rec.changes.length; index += 1) {
        const mutated: WbsChange = { ...run.rec, changes: run.rec.changes.filter((_, at) => at !== index) };
        try {
          if ((await hashWbsState(applyWbsChange(run.before, mutated))) !== target) different += 1;
        } catch {
          different += 1;
        }
      }
      return different;
    }

    it("dropping any one entry of a rename record breaks the replay (1 entry => 1 differing)", async () => {
      const record = richRecord();
      const run = await runCase(record, [], [{ type: "task.update", taskId: leafAt(record, 0).id, changes: { name: "Renamed" } }]);
      expect(run.rec.changes).toHaveLength(1);
      expect(await differing(run)).toBe(1);
    });

    it("dropping entries of a generateSubtasks record breaks the replay for most of them", async () => {
      const record = richRecord();
      const run = await runCase(record, [], [GENERATE]);
      expect(run.rec.changes.length).toBeGreaterThan(3);
      expect(await differing(run)).toBeGreaterThan(0);
    });

    it("tampering with the DB after commit makes the replay disagree; before tampering it agrees", async () => {
      const record = richRecord();
      const leaf = leafAt(record, 0);
      const run = await runCase(record, [], [{ type: "task.update", taskId: leaf.id, changes: { name: "Renamed" } }]);
      const replayed = await hashWbsState(applyWbsChange(run.before, run.rec));

      expect(replayed).toBe(await hashOf(record));
      await withWbsWriteMarker(client, record.project.id, 0, () =>
        client.query("update task set name = 'TAMPERED' where id = $1", [leaf.id]),
      );
      expect(replayed).not.toBe(await hashOf(record));
    });
  });
});
