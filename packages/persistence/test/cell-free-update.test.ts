import {
  applyProjectCommand,
  applyWbsChange,
  canonicalWbsState,
  createProjectCommandService,
  decodeWbsSnapshot,
  readWbsChange,
  type ProjectCommand,
  type ProjectState,
} from "@vecta/application";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
 * M1 #2 perf: when a snapshot exists and no edit is due, a `task.update` whose
 * keys are all cell-free does not read `daily_plan` / `dated_actuals`. These
 * tests pin that the stored cells survive every such operation untouched, that
 * the fast path really was taken, and that the full-load path still reads them.
 */

const ACTOR = { type: "HUMAN" as const, id: "user-001" };
type Query = (...args: unknown[]) => Promise<unknown>;
type Cells = Record<string, { plan: Readonly<Record<string, number>>; actual: Readonly<Record<string, number>> }>;

function statementText(argument: unknown): string {
  if (typeof argument === "string") return argument;
  const text = (argument as { text?: unknown } | null)?.text;
  return typeof text === "string" ? text : "";
}

/** 2 parents x 3 leaves, 2 members; EVERY leaf has half-integer daily cells, two leaves have dated actuals. */
function seedRecord(): PersistedProjectRecord {
  const base = createSeedProjectRecord({ parentCount: 2, subtasksPerParent: 3, memberCount: 2 });
  const memberId = base.members[0]!.id;
  let n = 0;
  const tasks: TaskRecord[] = base.tasks.map((task) => {
    if (task.parentTaskId === null) return task;
    n += 1;
    const dailyPlan: Record<string, number> = { "2026-01-05": 0.5, "2026-01-06": 240, [`2026-02-${String(n).padStart(2, "0")}`]: 1.5 };
    const datedActuals: Record<string, number> = n === 1 || n === 4 ? { [`2026-01-05|${memberId}`]: 90 } : {};
    return { ...task, dailyPlan, datedActuals };
  });
  return { ...base, tasks };
}

interface Step {
  readonly label: string;
  readonly commands: readonly ProjectCommand[];
}

function steps(record: PersistedProjectRecord): { fast: Step[] } {
  const leaves = record.tasks.filter((task) => task.parentTaskId !== null);
  const [l0, l1, l2, l3, l4, l5] = leaves as [TaskRecord, TaskRecord, TaskRecord, TaskRecord, TaskRecord, TaskRecord];
  const [p0, p1] = record.tasks.filter((task) => task.parentTaskId === null) as [TaskRecord, TaskRecord];
  const upd = (taskId: string, changes: Record<string, unknown>): ProjectCommand =>
    ({ type: "task.update", taskId, changes }) as ProjectCommand;
  const one = (label: string, taskId: string, changes: Record<string, unknown>): Step => ({
    label,
    commands: [upd(taskId, changes)],
  });
  return {
    // `repository.save` already stored the base snapshot at revision 1, so even revision 2 is on the fast path
    fast: [
      one("name", l0.id, { name: "Renamed leaf" }),
      one("note", l1.id, { note: "a new note" }),
      one("contract", l2.id, { contract: "Contract 9" }),
      one("processId", l0.id, { processId: record.processes[1]!.id }),
      one("productId", l1.id, { productId: record.products[1]!.id }),
      one("assigneeMemberId", l2.id, { assigneeMemberId: record.members[1]!.id }),
      one("progressBasisPoints", l1.id, { progressBasisPoints: 4_000 }),
      one("actualEffortMinutes", l2.id, { actualEffortMinutes: 90 }),
      one("prorationWeightBp", l3.id, { prorationWeightBp: 5_000 }),
      one("actualStart + actualFinish", l4.id, { actualStart: "2026-01-05", actualFinish: "2026-01-09" }),
      one("plannedEffortMinutes on a parent", p0.id, { plannedEffortMinutes: 1_200 }),
      one("parentId (reparent a leaf with cells)", l0.id, { parentId: p1.id }),
      {
        label: "sortOrder (reorder batch)",
        commands: [upd(l1.id, { sortOrder: 900 }), upd(l2.id, { sortOrder: 901 }), upd(l3.id, { sortOrder: 902 })],
      },
      one("dependencies (add)", l5.id, { dependencies: [{ predecessorId: l1.id, type: "SS", lagWorkingDays: 1 }] }),
      one("dependencies (remove)", l5.id, { dependencies: [] }),
    ],
  };
}

function expectedCells(record: PersistedProjectRecord): Cells {
  return Object.fromEntries(record.tasks.map((task) => [task.id, { plan: task.dailyPlan, actual: task.datedActuals }]));
}

interface Run {
  readonly record: PersistedProjectRecord;
  readonly labels: string[];
  /** per revision 1..N: [a = b, b = c, cells in DB equal the seeded maps] */
  readonly checks: [number, boolean, boolean, boolean][];
  readonly taskSelectMentionsPlan: boolean[][];
  readonly storedCellFieldChanges: string[];
  readonly dbCells: unknown;
}

async function run(client: Client, interval: number): Promise<Run> {
  const database = createPersistenceDatabase(client);
  const repository = new ProjectRepository(database);
  const service = createProjectCommandService(
    new PostgresProjectCommandUnitOfWork(database, { snapshotInterval: () => interval }),
  );
  const record = seedRecord();
  await client.query("truncate table tenant cascade");
  await repository.save(record);
  const readDb = async (): Promise<ProjectState> => toProjectState((await repository.load(record.tenant.id, record.project.id))!);
  const dbCells = async (): Promise<Cells> => {
    const rows = await client.query<{ id: string; plan: Record<string, number>; actual: Record<string, number> }>(
      "select id, daily_plan as plan, dated_actuals as actual from task where wbs_id = $1",
      [record.project.id],
    );
    return Object.fromEntries(rows.rows.map((row) => [row.id, { plan: row.plan, actual: row.actual }]));
  };

  const all = steps(record).fast;
  let folded = toProjectState(record);
  const a = [canonicalWbsState(folded)];
  const b = [canonicalWbsState(await readDb())];
  const cellsOk = [true];
  const expected = expectedCells(record);
  const selects: string[][] = [];
  const original = client.query.bind(client) as Query;

  for (const [index, step] of all.entries()) {
    for (const command of step.commands) folded = applyProjectCommand(folded, command);
    a.push(canonicalWbsState(folded));
    const seen: string[] = [];
    (client as unknown as { query: Query }).query = async (...args: unknown[]) => {
      const text = statementText(args[0]);
      if (/^\s*select[\s\S]*from "task"\s+where/i.test(text)) seen.push(text);
      return original(...args);
    };
    try {
      await service.execute({
        tenantId: record.tenant.id, projectId: record.project.id, expectedRevision: BigInt(index + 1),
        operationId: `cellfree-${index}`, actor: ACTOR, commands: step.commands,
      });
    } finally {
      (client as unknown as { query: unknown }).query = original;
    }
    selects.push(seen);
    b.push(canonicalWbsState(await readDb()));
    cellsOk.push(sameCells(await dbCells(), expected));
  }

  const snapshots = await client.query<{ revision: number; format: number; sha256: string; body: Buffer }>(
    "select revision::int as revision, format, sha256, body from wbs_snapshot where wbs_id = $1 order by revision",
    [record.project.id],
  );
  const stored = await client.query<{ revision: number; change: unknown }>(
    "select revision::int as revision, change from wbs_change where wbs_id = $1 order by revision",
    [record.project.id],
  );
  expect(stored.rows.map((row) => row.revision)).toEqual(all.map((_, index) => index + 2));
  let replayed = await decodeWbsSnapshot(snapshots.rows[0]!);
  const c = [canonicalWbsState(replayed)];
  for (const row of stored.rows) {
    replayed = applyWbsChange(replayed, readWbsChange(row.change));
    c.push(canonicalWbsState(replayed));
  }
  const fields = (
    await client.query<{ field: string }>(
      `select e->>'field' as field from wbs_change w, jsonb_array_elements(w.change->'changes') e
        where w.wbs_id = $1 and (e->>'field' like 'dailyPlan%' or e->>'field' like 'datedActuals%')`,
      [record.project.id],
    )
  ).rows.map((row) => row.field);

  return {
    record,
    labels: ["(seed)", ...all.map((step) => step.label)],
    checks: a.map((text, index) => [index + 1, text === b[index], b[index] === c[index], cellsOk[index]!] as [number, boolean, boolean, boolean]),
    taskSelectMentionsPlan: selects.map((list) => list.map((text) => /daily_plan/.test(text))),
    storedCellFieldChanges: fields,
    dbCells: await dbCells(),
  };
}

function sameCells(actual: Cells, expected: Cells): boolean {
  const ids = Object.keys(expected);
  return (
    Object.keys(actual).length === ids.length &&
    ids.every((id) => JSON.stringify(sortKeys(actual[id])) === JSON.stringify(sortKeys(expected[id])))
  );
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as object).sort(([x], [y]) => x.localeCompare(y)).map(([k, v]) => [k, sortKeys(v)]));
}

describe("cell-free fast path (interval 1000: nothing is due after the base)", () => {
  let database: TestDatabase;
  let result: Run;
  beforeAll(async () => {
    database = await startTestDatabase("cell_free_fast");
    await migratePersistenceDatabase(database.client);
    result = await run(database.client, 1_000);
  }, 120_000);
  afterAll(async () => {
    await database.dispose();
  });

  it("a = b = c at every revision, and the DB cells equal the seeded maps", () => {
    expect(result.checks.map(([revision, ab, bc, cells]) => [revision, ab, bc, cells])).toEqual(
      result.labels.map((_, index) => [index + 1, true, true, true]),
    );
  });

  it("every task's daily_plan and dated_actuals read with SQL equal the seeded maps after the last operation", () => {
    expect(sortKeys(result.dbCells)).toEqual(sortKeys(expectedCells(result.record)));
    const seededLeaf = result.record.tasks.find((task) => Object.keys(task.datedActuals).length > 0)!;
    expect((result.dbCells as Cells)[seededLeaf.id]!.plan).toEqual({ "2026-01-05": 0.5, "2026-01-06": 240, "2026-02-01": 1.5 });
  });

  it("no stored wbs_change row holds a dailyPlan* or datedActuals* field change", () => {
    expect(result.storedCellFieldChanges).toEqual([]);
  });

  it("control: no operation's task SELECT mentions daily_plan (and each ran one), incl. the name edit", () => {
    expect(result.taskSelectMentionsPlan.map((mentions) => [mentions.length, mentions.some(Boolean)])).toEqual(
      result.taskSelectMentionsPlan.map(() => [1, false]),
    );
    expect(result.labels[1]).toBe("name");
  });
});

describe("control: interval 1 (isSnapshotDue is current - last.revision >= 1, so the first edit, at current 1 = last 1, is not due and every later one is)", () => {
  let database: TestDatabase;
  let result: Run;
  beforeAll(async () => {
    database = await startTestDatabase("cell_free_due");
    await migratePersistenceDatabase(database.client);
    result = await run(database.client, 1);
  }, 120_000);
  afterAll(async () => {
    await database.dispose();
  });

  it("a due edit's task SELECT reads daily_plan, a not-due one does not; the cells and a = b = c hold either way", () => {
    // measured: op 0 is on the fast path, every later op is due and reads the cells
    expect(result.taskSelectMentionsPlan.map((mentions) => [mentions.length, mentions.every(Boolean)])).toEqual(
      result.taskSelectMentionsPlan.map((_, index) => [1, index > 0]),
    );
    expect(result.checks.every(([, ab, bc, cells]) => ab && bc && cells)).toBe(true);
  });
});
