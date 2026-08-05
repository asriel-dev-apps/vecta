import {
  createProjectCommandService,
  parseTimesheetCsv,
  type ProjectCommand,
} from "@vecta/application";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceDatabase,
  createSeedProjectRecord,
  migratePersistenceDatabase,
  PostgresProjectCommandUnitOfWork,
  ProjectRepository,
} from "../src/index.js";
import { toProjectWorkspace } from "../src/project-workspace.js";
import { startTestDatabase, type TestDatabase } from "./database.js";

/**
 * `actuals.import` through the real unit of work (Design 0011).
 *
 * The claim this file exists to check is the one that decided the storage shape:
 *
 * > an import must survive the NEXT, unrelated command.
 *
 * The unit of work rewrites every task row on every command, `actual_effort_minutes`
 * among them, from the in-memory `ProjectState`. An earlier draft put dated
 * actuals in their own table and re-derived W afterwards; the next cell edit would
 * then have written the pre-import W back and silently undone the import. Nothing
 * in a unit test would have caught that, because the bug lives in the interaction
 * between two commands and a real reconcile.
 */

/**
 * A DELIBERATELY SMALL seed — 2 parents × 2 subtasks, 2 members — not the 24×9
 * default. `vitest.config.ts` records that this suite already competes for cores
 * with apps/web's 500 tests under `pnpm check`, and a twelfth file re-seeding 216
 * tasks before each of five tests pushed three unrelated files past their
 * timeout (measured 2026-08-06). Nothing here needs volume: the claims are about
 * one task's map surviving another task's edit.
 */
const seedRecord = createSeedProjectRecord({
  parentCount: 2,
  subtasksPerParent: 2,
  memberCount: 2,
});
const tenantId = seedRecord.tenant.id;
const projectId = seedRecord.project.id;
const leafTasks = seedRecord.tasks.filter((task) => task.parentTaskId !== null);
const summaryTask = seedRecord.tasks.find((task) => task.parentTaskId === null)!;
const firstLeaf = leafTasks[0]!;
const secondLeaf = leafTasks[1]!;
const memberName = seedRecord.members[0]!.name;
const HEADER = "タスクNo,日付,メンバー,工数(時間)";

describe("actuals.import (persisted)", () => {
  let client: Client;
  let testDatabase: TestDatabase;
  let repository: ProjectRepository;
  let keyCounter = 0;

  beforeAll(async () => {
    testDatabase = await startTestDatabase("timesheet_import");
    client = testDatabase.client;
    await migratePersistenceDatabase(client);
    repository = new ProjectRepository(createPersistenceDatabase(client));
  }, 60_000);

  afterAll(async () => {
    await testDatabase.dispose();
  });

  beforeEach(async () => {
    await client.query("truncate table tenants cascade");
    await repository.save(seedRecord);
    keyCounter = 0;
  });

  const service = () =>
    createProjectCommandService(
      new PostgresProjectCommandUnitOfWork(createPersistenceDatabase(client)),
    );

  const load = async () => {
    const record = await repository.load(tenantId, projectId);
    if (record === null) throw new Error("project missing");
    return toProjectWorkspace(record);
  };

  const execute = async (command: ProjectCommand, expectedRevision: bigint) => {
    keyCounter += 1;
    return service().execute({
      tenantId,
      projectId,
      command,
      expectedRevision,
      idempotencyKey: `timesheet-${keyCounter}`,
      actor: { type: "HUMAN", id: "00000000-0000-4000-8000-00000000cafe" },
    });
  };

  const importCsv = async (csv: string) => {
    const workspace = await load();
    const parsed = parseTimesheetCsv(csv, workspace.current);
    if (!parsed.ok) throw new Error(`rejected: ${JSON.stringify(parsed.issues)}`);
    return execute({ type: "actuals.import", entries: parsed.entries }, workspace.revision);
  };

  it("persists the dated rows and the total they add up to", async () => {
    await importCsv(`${HEADER}\n${firstLeaf.seq},2026-08-03,${memberName},2\n`);

    const workspace = await load();
    const task = workspace.current.tasks.find((candidate) => candidate.id === firstLeaf.id)!;
    expect(Object.values(task.datedActuals)).toEqual([120]);
    expect(task.actualEffortMinutes).toBe(120);
  });

  it("SURVIVES the next unrelated command — the reason the map lives on the task", async () => {
    await importCsv(`${HEADER}\n${firstLeaf.seq},2026-08-03,${memberName},2\n`);

    // An ordinary edit to a DIFFERENT task. The unit of work rewrites every task
    // row from state while applying it, which is precisely where a design that
    // kept actuals elsewhere would lose them.
    const afterImport = await load();
    await execute(
      { type: "task.update", taskId: secondLeaf.id, changes: { name: "Renamed" } },
      afterImport.revision,
    );

    const workspace = await load();
    const task = workspace.current.tasks.find((candidate) => candidate.id === firstLeaf.id)!;
    expect(task.actualEffortMinutes).toBe(120);
    expect(Object.values(task.datedActuals)).toEqual([120]);
  });

  it("records the importing human in the audit log", async () => {
    await importCsv(`${HEADER}\n${firstLeaf.seq},2026-08-03,${memberName},1\n`);
    const audit = await client.query<{ actor_type: string; command_type: string }>(
      `select actor_type, command_type from audit_events
       where tenant_id = $1 and project_id = $2 order by sequence desc limit 1`,
      [tenantId, projectId],
    );
    expect(audit.rows[0]?.command_type).toBe("actuals.import");
    expect(audit.rows[0]?.actor_type).toBe("HUMAN");
  });

  it("is idempotent across two separate imports of the same file", async () => {
    const csv = `${HEADER}\n${firstLeaf.seq},2026-08-03,${memberName},2\n${secondLeaf.seq},2026-08-03,${memberName},1\n`;
    await importCsv(csv);
    const first = await load();
    await importCsv(csv);
    const second = await load();

    // The revision moves — a command ran — but the DATA is identical. The receipt
    // handles a retried request; this handles a re-uploaded file, which is the
    // case a person actually creates.
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(second.current.tasks).toEqual(first.current.tasks);
  });

  it("refuses a summary row at the command boundary too, not only in the parser", async () => {
    const workspace = await load();
    await expect(
      execute(
        {
          type: "actuals.import",
          entries: [
            {
              taskId: summaryTask.id,
              workDate: "2026-08-03",
              memberId: seedRecord.members[0]!.id,
              actualMinutes: 60,
            },
          ],
        },
        workspace.revision,
      ),
    ).rejects.toThrow(/summary task/u);
  });
});
