import { calculateBaselineEvm, calculateEffortEvm } from "@vecta/domain";
import {
  createProjectCommandService,
  leafTaskIds,
  type ProjectCommand,
} from "@vecta/application";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceDatabase,
  demoProjectRecord,
  migratePersistenceDatabase,
  PostgresProjectCommandUnitOfWork,
  projectDetailQueries,
  ProjectRepository,
  toBaselineSnapshot,
} from "../src/index.js";
import { startTestDatabase, type TestDatabase } from "./database.js";

/**
 * `baseline.publish` through the real unit of work (Design 0009).
 *
 * The controls the design named. Each positive one is paired, because "the frozen
 * plan did not move" is equally true of a feature that was never wired: it is only
 * evidence next to a check that fails when the snapshot is missing or wrong.
 */

const tenantId = demoProjectRecord.tenant.id;
const projectId = demoProjectRecord.project.id;
const leafTasks = demoProjectRecord.tasks.filter((task) => task.parentTaskId !== null);
const summaryTasks = demoProjectRecord.tasks.filter((task) => task.parentTaskId === null);
const firstLeaf = leafTasks[0]!;

describe("baseline.publish", () => {
  let client: Client;
  let testDatabase: TestDatabase;
  let repository: ProjectRepository;

  beforeAll(async () => {
    testDatabase = await startTestDatabase("baseline_publish");
    client = testDatabase.client;
    await migratePersistenceDatabase(client);
    repository = new ProjectRepository(createPersistenceDatabase(client));
  }, 60_000);

  afterAll(async () => {
    await testDatabase.dispose();
  });

  beforeEach(async () => {
    await client.query("truncate table tenants cascade");
    await repository.save(demoProjectRecord);
  });

  const service = () =>
    createProjectCommandService(
      new PostgresProjectCommandUnitOfWork(createPersistenceDatabase(client)),
    );

  // A fresh idempotency key per call. Deriving it from the revision made the
  // stale-revision test pass for the wrong reason: the retry reused the first
  // call's key, so the receipt REPLAYED and returned success instead of the
  // conflict the test was written to see.
  let attempt = 0;
  const publish = (command: ProjectCommand = { type: "baseline.publish" }, expectedRevision = 1n) =>
    service().execute({
      tenantId,
      projectId,
      expectedRevision,
      idempotencyKey: `publish-${(attempt += 1).toString()}`,
      actor: { type: "HUMAN", id: "user-001" },
      command,
    });

  const frozenRows = () =>
    client.query<{ task_id: string; name: string; daily_plan: Record<string, number> }>(
      "select task_id, name, daily_plan from baseline_tasks where project_id = $1 order by seq",
      [projectId],
    );

  it("freezes the LEAVES only, pinned to the revision it was issued against", async () => {
    const execution = await publish();
    expect(execution.revision).toBe(2n);

    const rows = await frozenRows();
    // Summary rows are excluded on purpose: `calculateEffortEvm` does not roll them
    // up, so a frozen summary row would be a number in the table that no reader may
    // add — and the first person to sum the column would double-count.
    expect(rows.rows).toHaveLength(leafTasks.length);
    expect(summaryTasks.length).toBeGreaterThan(0);
    const frozenIds = new Set(rows.rows.map((row) => row.task_id));
    for (const summary of summaryTasks) {
      expect(frozenIds.has(summary.id)).toBe(false);
    }

    const header = await client.query<{ version: number; source_revision: string }>(
      "select version, source_revision::text as source_revision from project_baselines where project_id = $1",
      [projectId],
    );
    expect(header.rows[0]?.version).toBe(1);
    // The revision the command was issued AGAINST, not the one it produced: the
    // snapshot is of that state.
    expect(header.rows[0]?.source_revision).toBe("1");
  });

  it("CONTROL: editing the current plan afterwards does not move the frozen plot", async () => {
    await publish();
    const before = await frozenRows();
    await client.query("update tasks set daily_plan = $1::jsonb where id = $2", [
      JSON.stringify({ "2099-01-01": 9_999 }),
      firstLeaf.id,
    ]);
    const after = await frozenRows();
    expect(after.rows).toEqual(before.rows);
  });

  it("CONTROL (pair): the frozen plot is the REAL plot, not an empty default", async () => {
    // Without this, "it did not move" would also hold for a feature that writes
    // `{}` for every row, or writes nothing at all.
    await publish();
    const rows = await frozenRows();
    const matching = rows.rows.find((row) => row.task_id === firstLeaf.id);
    expect(matching?.daily_plan).toEqual(firstLeaf.dailyPlan);
    expect(Object.keys(matching?.daily_plan ?? {}).length).toBeGreaterThan(0);
  });

  it("refuses a plan whose leaves are unplotted, unless a human acknowledges it", async () => {
    // Measured 2026-08-05: BAC comes from the daily plot, so an unplotted leaf is
    // worth ZERO to the baseline and every later SV is kinder by that amount —
    // permanently, and with nothing on screen to say so.
    await client.query("update tasks set daily_plan = '{}'::jsonb where id = $1", [firstLeaf.id]);
    await expect(publish()).rejects.toThrow(/empty or inconsistent daily plot/u);

    const acknowledged = await publish({
      type: "baseline.publish",
      acknowledgeUnplottedTasks: true,
    });
    expect(acknowledged.revision).toBe(2n);
  });

  it("advances the version counter, so a second publish is version 2", async () => {
    await publish();
    await publish({ type: "baseline.publish" }, 2n);
    const versions = await client.query<{ version: number }>(
      "select version from project_baselines where project_id = $1 order by version",
      [projectId],
    );
    expect(versions.rows.map((row) => row.version)).toEqual([1, 2]);
  });

  it("records the human in the audit trail", async () => {
    await publish();
    const audit = await client.query<{
      actor_type: string;
      actor_id: string;
      command_type: string;
    }>(
      "select actor_type, actor_id, command_type from audit_events where project_id = $1 and command_type = 'baseline.publish'",
      [projectId],
    );
    expect(audit.rows[0]?.actor_type).toBe("HUMAN");
    expect(audit.rows[0]?.actor_id).toBe("user-001");
  });

  it("PUBLISH-TIME EQUALITY: the frozen plan reproduces the live rollup exactly", async () => {
    // The design's positive control, at the level that matters: through the REAL
    // unit of work and back out of the database, not over synthetic input. It only
    // holds if every frozen column is the right one and the leaf filter matches —
    // it fails on a snapshot that dropped rows, kept summary rows, or read the
    // wrong field. "The frozen plot did not change" cannot do that job.
    await publish();

    const frozen = await client.query<{
      task_id: string;
      parent_task_id: string | null;
      daily_plan: Record<string, number>;
    }>(
      "select task_id, parent_task_id, daily_plan from baseline_tasks where project_id = $1",
      [projectId],
    );
    const live = demoProjectRecord.tasks;
    const statusDate = demoProjectRecord.project.statusDate;

    const baseline = calculateBaselineEvm({
      statusDate,
      baselineTasks: frozen.rows.map((row) => ({ id: row.task_id, dailyPlan: row.daily_plan })),
      progressByTaskId: Object.fromEntries(
        live.map((task) => [task.id, task.progressBasisPoints]),
      ),
    });
    const leaves = leafTaskIds(
      live.map((task) => ({ id: task.id, parentId: task.parentTaskId })) as never,
    );
    const current = calculateEffortEvm({
      statusDate,
      tasks: live.map((task) => ({
        id: task.id,
        plannedEffortMinutes: task.plannedEffortMinutes,
        progressBasisPoints: task.progressBasisPoints,
        actualEffortMinutes: task.actualEffortMinutes,
        dailyPlan: task.dailyPlan,
        isLeaf: leaves.has(task.id),
      })),
    }).rollup;

    expect(baseline.bac).toBe(current.bac);
    expect(baseline.pv).toBe(current.pv);
    expect(baseline.ev).toBe(current.ev);
    // And the numbers are not both zero, which would make the equality vacuous.
    expect(current.bac).toBeGreaterThan(0);
  });

  it("OMISSION SWEEP: nothing outside the frozen columns can move the baseline", async () => {
    // Design 0008 named this the ONLY check that catches a column the snapshot
    // forgot. Each mutation below is something deliberately NOT frozen; if any of
    // them moved the baseline, the snapshot would be reading live data somewhere.
    await publish();
    const read = async () => {
      const rows = await client.query<{ task_id: string; daily_plan: Record<string, number> }>(
        "select task_id, daily_plan from baseline_tasks where project_id = $1 order by task_id",
        [projectId],
      );
      return calculateBaselineEvm({
        statusDate: demoProjectRecord.project.statusDate,
        baselineTasks: rows.rows.map((row) => ({ id: row.task_id, dailyPlan: row.daily_plan })),
        progressByTaskId: {},
      });
    };
    const before = await read();
    expect(before.bac).toBeGreaterThan(0);

    const mutations: readonly [string, string, unknown[]][] = [
      ["progress", "update tasks set progress_basis_points = 10000 where id = $1", [firstLeaf.id]],
      ["actuals", "update tasks set actual_effort_minutes = 99999 where id = $1", [firstLeaf.id]],
      ["estimate", "update tasks set planned_effort_minutes = 99999 where id = $1", [firstLeaf.id]],
      ["name", "update tasks set name = 'Renamed after publishing' where id = $1", [firstLeaf.id]],
      ["reparent", "update tasks set parent_task_id = null where id = $1", [firstLeaf.id]],
      ["member name", "update members set name = 'Renamed member' where project_id = $1", [projectId]],
      [
        "calendar",
        "update project_calendars set non_working_dates = '{2026-08-01}' where project_id = $1",
        [projectId],
      ],
    ];
    for (const [label, statement, parameters] of mutations) {
      await client.query(statement, parameters as never[]);
      const after = await read();
      expect(after, `changing ${label} moved the baseline`).toEqual(before);
    }

    // Deleting a task must not move it either — and the frozen row survives.
    await client.query("delete from task_dependencies where tenant_id = $1", [tenantId]);
    await client.query("delete from tasks where id = $1", [firstLeaf.id]);
    expect(await read()).toEqual(before);
  });

  it("READ PATH: the workspace returns the latest baseline, and null before any publish", async () => {
    // Reading it back is what the screens depend on, and the negative half matters
    // as much: the production project has never been baselined, so `null` is the
    // state most of the app is in and the dashboard must render it.
    // The reader itself needs Neon's HTTP `batch`, which this node-postgres client
    // does not have; what is exercised here is the pair this feature added — the
    // two queries and the mapper. The batch WIRING is checked by the compiler:
    // `db.batch([...])` destructures as a tuple, so a query added to the array
    // without a name to receive it does not typecheck.
    const database = createPersistenceDatabase(client);
    const snapshotNow = async () => {
      const queries = projectDetailQueries(database, tenantId, projectId);
      return toBaselineSnapshot(await queries.baseline, await queries.baselineTasks);
    };

    expect(await snapshotNow()).toBeNull();

    await publish();

    const after = await snapshotNow();
    expect(after?.version).toBe(1);
    expect(after?.sourceRevision).toBe(1n);
    expect(after?.tasks).toHaveLength(leafTasks.length);
    // The frozen name survives even though the task still exists — it is the same
    // string today, and the point is that it stops tracking after a deletion.
    expect(after?.tasks.map((task) => task.name).sort()).toEqual(
      leafTasks.map((task) => task.name).sort(),
    );
  });

  it("rejects a stale expectedRevision", async () => {
    await publish();
    await expect(publish({ type: "baseline.publish" }, 1n)).rejects.toThrow(/revision conflict/iu);
  });
});
