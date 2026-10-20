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
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
 * M1 #2 unit 6: at EVERY revision the state three independent ways must agree.
 *   (a) `applyProjectCommand` folded over the script only (no database, no diff);
 *   (b) `repository.load` right after the operation (what the tables hold);
 *   (c) the base snapshot plus every stored `wbs_change` up to that revision.
 * Two mutations, injected from this file only, show the comparison can fail in
 * the two directions that matter: a diff that loses an entry, and a table write
 * that is lost while the diff is recorded.
 */

const mutation = vi.hoisted(() => ({ dropRenameName: false, hits: 0 }));

vi.mock("@vecta/application", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vecta/application")>();
  return {
    ...actual,
    diffOperation: (...args: Parameters<typeof actual.diffOperation>) => {
      const result = actual.diffOperation(...args);
      if (!mutation.dropRenameName) return result;
      const renames = args[1].some(
        (command) => command.type === "task.update" && command.changes.name === RENAMED,
      );
      if (!renames) return result;
      const kept = result.change.changes.filter((entry) => entry.field !== "name");
      mutation.hits += result.change.changes.length - kept.length;
      return { after: result.after, change: { ...result.change, changes: kept } };
    },
  };
});

const RENAMED = "Renamed task";
const ACTOR = { type: "HUMAN" as const, id: "user-001" };
const PARENT_ID = "d0000000-0000-4000-8000-0000000000f1";
const TEMPLATE_ID = "60000000-0000-4000-8000-0000000000f1";
const NEW_ID = "e0000000-0000-4000-8000-00000000aaa1";
const PASTE_IDS = [2, 3, 4].map((n) => `e0000000-0000-4000-8000-00000000aaa${n}`);

/** 2 parents with 3 leaves each (a dependency chain among them), plus P (no children) and a 50/30/20 template. */
function richRecord(): PersistedProjectRecord {
  const base = createSeedProjectRecord({ parentCount: 2, subtasksPerParent: 3, memberCount: 2 });
  const { tenantId, projectId } = { tenantId: base.tenant.id, projectId: base.project.id };
  const parent: TaskRecord = {
    id: PARENT_ID, tenantId, projectId, parentTaskId: null, sortOrder: 100, seq: base.project.nextTaskSeq,
    name: "Generated parent", processId: base.processes[0]!.id, productId: base.products[0]!.id, note: "",
    contract: "Contract 1", assigneeMemberId: null, plannedEffortMinutes: 100, progressBasisPoints: 0,
    actualEffortMinutes: 0, prorationWeightBp: null, dailyPlan: {}, datedActuals: {}, actualStart: null, actualFinish: null,
  };
  return {
    ...base,
    project: { ...base.project, nextTaskSeq: base.project.nextTaskSeq + 1 },
    tasks: [...base.tasks, parent],
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
    ],
  };
}

function script(record: PersistedProjectRecord): readonly (readonly ProjectCommand[])[] {
  const leaves = record.tasks.filter((task) => task.parentTaskId !== null);
  const parents = record.tasks.filter((task) => task.parentTaskId === null && task.id !== PARENT_ID);
  const [l0, l1, l2, l3] = leaves as [TaskRecord, TaskRecord, TaskRecord, TaskRecord];
  const newTask = (id: string, sortOrder: number, name: string, dependencies: { predecessorId: string; type: "FS"; lagWorkingDays: number }[] = []) =>
    ({
      type: "task.add" as const,
      task: {
        id, parentId: null, sortOrder, name, processId: record.processes[0]!.id, productId: record.products[0]!.id,
        note: "", contract: "Contract 1", assigneeMemberId: null, plannedEffortMinutes: 60, progressBasisPoints: 0,
        actualEffortMinutes: 0, prorationWeightBp: null, dailyPlan: { "2026-01-07": 60 }, datedActuals: {},
        actualStart: null, actualFinish: null, dependencies,
      },
    });
  return [
    /* 2 */ [newTask(NEW_ID, 200, "Added")],
    /* 3 */ [{ type: "task.update", taskId: l0.id, changes: { name: RENAMED } }],
    /* 4 */ [{ type: "task.update", taskId: l1.id, changes: { dailyPlan: { "2026-01-05": 0.5 }, plannedEffortMinutes: 1 } }],
    /* 5 */ [{ type: "task.generateSubtasks", parentTaskId: PARENT_ID, templateId: TEMPLATE_ID }],
    /* 6 */ [{ type: "task.update", taskId: PARENT_ID, changes: { plannedEffortMinutes: 200 } }],
    /* 7 */ [
      { type: "task.update", taskId: l2.id, changes: { sortOrder: 900 } },
      { type: "task.update", taskId: l3.id, changes: { sortOrder: 901 } },
      { type: "task.update", taskId: NEW_ID, changes: { sortOrder: 902 } },
    ],
    /* 8 */ [{ type: "task.update", taskId: l3.id, changes: { dependencies: [{ predecessorId: l2.id, type: "SS", lagWorkingDays: 2 }] } }],
    /* 9 */ [{ type: "task.update", taskId: l3.id, changes: { dependencies: [] } }],
    /* 10 */ [{ type: "task.delete", taskId: parents[1]!.id }],
    /* 11 */ [{ type: "process.update", processId: record.processes[0]!.id, changes: { name: "Renamed process" } }],
    /* 12 */ [{ type: "member.update", memberId: record.members[0]!.id, changes: { name: "Renamed member" } }],
    /* 13 */ [{ type: "baseline.publish", acknowledgeUnplottedTasks: true }],
    /* 14 */ [
      newTask(PASTE_IDS[0]!, 300, "Pasted 1"),
      newTask(PASTE_IDS[1]!, 301, "Pasted 2", [{ predecessorId: PASTE_IDS[0]!, type: "FS", lagWorkingDays: 0 }]),
      newTask(PASTE_IDS[2]!, 302, "Pasted 3"),
    ],
  ];
}

interface Comparison {
  readonly revision: number;
  readonly aEqB: boolean;
  readonly bEqC: boolean;
  readonly aEqC: boolean;
  readonly bName: string;
}

interface Run {
  readonly visited: number[];
  readonly snapshotRevisions: number[];
  readonly comparisons: Comparison[];
  readonly snapshotsEqualB: boolean[];
  readonly record: PersistedProjectRecord;
}

const RENAMED_ID_OF = (record: PersistedProjectRecord) => record.tasks.find((task) => task.parentTaskId !== null)!.id;

async function runScript(client: Client, afterSeed?: () => Promise<void>): Promise<Run> {
  const database = createPersistenceDatabase(client);
  const repository = new ProjectRepository(database);
  const service = createProjectCommandService(
    new PostgresProjectCommandUnitOfWork(database, { snapshotInterval: () => 3 }),
  );
  const record = richRecord();
  await client.query("truncate table tenant cascade");
  await repository.save(record);
  if (afterSeed !== undefined) await afterSeed();

  const readDb = async (): Promise<ProjectState> => {
    const loaded = await repository.load(record.tenant.id, record.project.id);
    if (loaded === null) throw new Error("WBS not found");
    return toProjectState(loaded);
  };

  // (a) and (b), captured right after each operation
  let folded = toProjectState(record);
  const a: string[] = [canonicalWbsState(folded)];
  const b: ProjectState[] = [await readDb()];
  const steps = script(record);
  for (const [index, commands] of steps.entries()) {
    for (const command of commands) folded = applyProjectCommand(folded, command);
    a.push(canonicalWbsState(folded));
    const result = await service.execute({
      tenantId: record.tenant.id, projectId: record.project.id, expectedRevision: BigInt(index + 1),
      operationId: `replay-${index}`, actor: ACTOR, commands,
    });
    expect(result).toEqual({ projectId: record.project.id, revision: BigInt(index + 2), replayed: false });
    b.push(await readDb());
  }

  // (c) the base snapshot decoded, then every stored change in order
  const snapshots = await client.query<{ revision: number; format: number; sha256: string; body: Buffer }>(
    "select revision::int as revision, format, sha256, body from wbs_snapshot where wbs_id = $1 order by revision",
    [record.project.id],
  );
  const base = await decodeWbsSnapshot(snapshots.rows[0]!);
  const stored = await client.query<{ revision: number; change: unknown }>(
    "select revision::int as revision, change from wbs_change where wbs_id = $1 order by revision",
    [record.project.id],
  );
  expect(stored.rows.map((row) => row.revision)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  let replayed = base;
  const c: string[] = [canonicalWbsState(base)];
  for (const row of stored.rows) {
    replayed = applyWbsChange(replayed, readWbsChange(row.change));
    c.push(canonicalWbsState(replayed));
  }

  const visited: number[] = [];
  const comparisons: Comparison[] = [];
  for (let index = 0; index < a.length; index += 1) {
    visited.push(index + 1);
    const bText = canonicalWbsState(b[index]!);
    comparisons.push({
      revision: index + 1,
      aEqB: a[index] === bText,
      bEqC: bText === c[index],
      aEqC: a[index] === c[index],
      bName: b[index]!.tasks.find((task) => task.id === RENAMED_ID_OF(record))!.name,
    });
  }

  const snapshotsEqualB: boolean[] = [];
  for (const row of snapshots.rows) {
    snapshotsEqualB.push(canonicalWbsState(await decodeWbsSnapshot(row)) === canonicalWbsState(b[row.revision - 1]!));
  }
  return { visited, snapshotRevisions: snapshots.rows.map((row) => row.revision), comparisons, snapshotsEqualB, record };
}

const ALL_REVISIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const OLD_NAME = "Subtask 1.1";

async function withDatabase(name: string): Promise<TestDatabase> {
  const database = await startTestDatabase(name);
  await migratePersistenceDatabase(database.client);
  return database;
}

describe("every revision, three ways (control)", () => {
  let database: TestDatabase;
  let run: Run;
  beforeAll(async () => {
    mutation.dropRenameName = false;
    database = await withDatabase("revision_replay_ctl");
    run = await runScript(database.client);
  }, 120_000);
  afterAll(async () => {
    await database.dispose();
  });

  it("visits revisions 1 to 14 and the periodic snapshots sit at exactly 1, 4, 7, 10, 13", () => {
    expect(run.visited).toEqual(ALL_REVISIONS);
    expect(run.snapshotRevisions).toEqual([1, 4, 7, 10, 13]);
  });

  it("a = b = c at every revision", () => {
    expect(run.comparisons.map((entry) => [entry.revision, entry.aEqB, entry.bEqC, entry.aEqC])).toEqual(
      ALL_REVISIONS.map((revision) => [revision, true, true, true]),
    );
  });

  it("the task renamed at revision 3 reads the old name before it and the new name from it on", () => {
    expect(run.comparisons.map((entry) => entry.bName)).toEqual(
      ALL_REVISIONS.map((revision) => (revision < 3 ? OLD_NAME : RENAMED)),
    );
  });

  it("each periodic snapshot decodes to the database state at its revision", () => {
    expect(run.snapshotsEqualB).toEqual([true, true, true, true, true]);
  });
});

describe("mutation: drop-diff-entry (the diff loses the rename's name entry)", () => {
  let database: TestDatabase;
  let run: Run;
  beforeAll(async () => {
    mutation.dropRenameName = true;
    mutation.hits = 0;
    database = await withDatabase("revision_replay_diff");
    run = await runScript(database.client);
  }, 120_000);
  afterAll(async () => {
    mutation.dropRenameName = false;
    await database.dispose();
  });

  it("the mutation fired exactly once", () => {
    expect(mutation.hits).toBe(1);
  });

  it("from revision 3 on: a differs from b, b equals c, a differs from c, and b keeps the old name", () => {
    expect(run.comparisons.map((entry) => [entry.revision, entry.aEqB, entry.bEqC, entry.aEqC, entry.bName])).toEqual(
      ALL_REVISIONS.map((revision) =>
        revision < 3 ? [revision, true, true, true, OLD_NAME] : [revision, false, true, false, OLD_NAME],
      ),
    );
  });
});

describe("mutation: drop-db-write (the table write is lost, the diff is recorded)", () => {
  let database: TestDatabase;
  let run: Run;
  beforeAll(async () => {
    mutation.dropRenameName = false;
    database = await withDatabase("revision_replay_write");
    run = await runScript(database.client, async () => {
      await database.client.query("create table mutation_hit (n int not null)");
      await database.client.query(`
        create function skip_rename() returns trigger language plpgsql as $$
        begin
          if new.name = '${RENAMED}' and old.name <> new.name then
            insert into mutation_hit values (1);
            return null;
          end if;
          return new;
        end $$`);
      await database.client.query(
        "create trigger a_skip_rename before update on task for each row execute function skip_rename()",
      );
    });
  }, 120_000);
  afterAll(async () => {
    await database.dispose();
  });

  it("the mutation fired exactly once", async () => {
    const hits = await database.client.query<{ n: number }>("select count(*)::int as n from mutation_hit");
    expect(hits.rows[0]!.n).toBe(1);
  });

  it("from revision 3 on: a differs from b, b differs from c, a equals c, and b keeps the old name", () => {
    expect(run.comparisons.map((entry) => [entry.revision, entry.aEqB, entry.bEqC, entry.aEqC, entry.bName])).toEqual(
      ALL_REVISIONS.map((revision) =>
        revision < 3 ? [revision, true, true, true, OLD_NAME] : [revision, false, false, true, OLD_NAME],
      ),
    );
  });
});
