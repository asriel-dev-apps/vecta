import { createProjectCommandService, type ProjectTask } from "@vecta/application";
import type { Client } from "pg";
import { afterAll, beforeEach, beforeAll, describe, expect, it } from "vitest";
import {
  createPersistenceDatabase,
  demoProjectRecord,
  migratePersistenceDatabase,
  PostgresProjectCommandUnitOfWork,
  ProjectRepository,
} from "../src/index.js";
import { startTestDatabase, type TestDatabase } from "./database.js";

/**
 * A command scoped to one project cannot touch another project's task row.
 *
 * ## Why this is a real reachable path, not a hypothetical
 *
 * Task ids are supplied by the CLIENT: `AddTaskCommand` carries the whole task
 * including its `id`. Two projects in one tenant is the ordinary case, and a
 * person who can read project B (viewer) and edit project A (editor) knows
 * B's task ids and can put one in an `A` command.
 *
 * The per-row write loop that the batching replaced was scoped
 * `where tenant = … and project = … and id = …`, so a foreign id was classified
 * as new, INSERTed, and rejected by `tasks_pkey`. The first batched version
 * targeted `ON CONFLICT (id)` — the bare primary key — which turned that hard
 * failure into a silent UPDATE of the victim's row: `tenant_id` and `project_id`
 * are not in the `set` list, so the row stayed in project B and took project A's
 * name, seq, plan and a nulled parent.
 *
 * The fix targets the composite `tasks_tenant_project_id_unique`, so a foreign id
 * is not a conflict, the INSERT is attempted, and `tasks_pkey` rejects it exactly
 * as before.
 */

const TENANT_ID = demoProjectRecord.tenant.id;
const VICTIM_PROJECT_ID = "b0000000-0000-4000-8000-0000000000f0";
const VICTIM_TASK_ID = "d0000000-0000-4000-8000-0000000000f1";
const VICTIM_NAME = "Victim task in the other project";

describe("task ids cannot cross a project boundary", () => {
  let client: Client;
  let repository: ProjectRepository;
  let testDatabase: TestDatabase;

  beforeAll(async () => {
    testDatabase = await startTestDatabase("task_id_tenancy");
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
    // A SECOND project under the SAME tenant, holding one task. Inserted
    // directly rather than through the repository, which writes its own tenant
    // row and would collide.
    await client.query(
      `insert into projects (id, tenant_id, name, project_start, status_date)
       values ($1, $2, 'Other project', '2026-01-05', '2026-03-02')`,
      [VICTIM_PROJECT_ID, TENANT_ID],
    );
    await client.query(
      `insert into tasks (id, tenant_id, project_id, seq, name, sort_order, planned_effort_minutes)
       values ($1, $2, $3, 1, $4, 10, 480)`,
      [VICTIM_TASK_ID, TENANT_ID, VICTIM_PROJECT_ID, VICTIM_NAME],
    );
  });

  function service() {
    return createProjectCommandService(
      new PostgresProjectCommandUnitOfWork(createPersistenceDatabase(client)),
    );
  }

  async function readVictim() {
    const { rows } = await client.query(
      `select id, tenant_id, project_id, name, seq, sort_order, planned_effort_minutes, parent_task_id
       from tasks where id = $1`,
      [VICTIM_TASK_ID],
    );
    return rows[0];
  }

  function addTaskCommand(id: string) {
    const task: Omit<ProjectTask, "seq"> = {
      id,
      parentId: null,
      sortOrder: 999,
      name: "Task written by the attacking project",
      processId: null,
      productId: null,
      note: "",
      contract: "",
      assigneeMemberId: null,
      plannedEffortMinutes: 60,
      progressBasisPoints: 0,
      actualEffortMinutes: 0,
      prorationWeightBp: null,
      dailyPlan: {},
      datedActuals: {},
      actualStart: null,
      actualFinish: null,
      dependencies: [],
    };
    return { type: "task.add", task } as const;
  }

  it("NEGATIVE: adding a task whose id belongs to another project is rejected, and the other project's row is untouched", async () => {
    const before = await readVictim();

    await expect(
      service().execute({
        tenantId: TENANT_ID,
        projectId: demoProjectRecord.project.id,
        expectedRevision: 1n,
        idempotencyKey: "cross-project-add",
        actor: { type: "HUMAN", id: "user-001" },
        command: addTaskCommand(VICTIM_TASK_ID),
      }),
    ).rejects.toThrow();

    // Byte-for-byte, not merely "still called something": the silent-UPDATE
    // failure mode changed the name, the seq, the sort order and the parent.
    expect(await readVictim()).toEqual(before);

    // And the attacking project gained nothing — the whole command rolled back.
    const attacker = await repository.load(TENANT_ID, demoProjectRecord.project.id);
    expect(attacker?.project.revision).toBe(1n);
    expect(attacker?.tasks.some((task) => task.id === VICTIM_TASK_ID)).toBe(false);
  });

  it("POSITIVE: adding a task with an id of its own still works", async () => {
    // Without this, the test above would pass against an implementation that
    // rejected every `task.add`.
    const freshId = "d0000000-0000-4000-8000-0000000000aa";
    const result = await service().execute({
      tenantId: TENANT_ID,
      projectId: demoProjectRecord.project.id,
      expectedRevision: 1n,
      idempotencyKey: "ordinary-add",
      actor: { type: "HUMAN", id: "user-001" },
      command: addTaskCommand(freshId),
    });

    expect(result.revision).toBe(2n);
    const attacker = await repository.load(TENANT_ID, demoProjectRecord.project.id);
    expect(attacker?.tasks.find((task) => task.id === freshId)?.name).toBe(
      "Task written by the attacking project",
    );
    // The other project is still none the wiser.
    expect((await readVictim()).name).toBe(VICTIM_NAME);
  });
});
