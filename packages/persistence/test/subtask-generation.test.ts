import { createProjectCommandService } from "@vecta/application";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceDatabase,
  demoProjectRecord,
  migratePersistenceDatabase,
  PostgresProjectCommandUnitOfWork,
  ProjectRepository,
  type PersistedProjectRecord,
  type TaskRecord,
} from "../src/index.js";

const parentTask = demoProjectRecord.tasks.find((task) => task.parentTaskId === null)!;
const standardBuildTemplateId = demoProjectRecord.templates.find(
  (template) => template.name === "Standard build",
)!.id;

function subtasksOf(record: PersistedProjectRecord | null): TaskRecord[] {
  return (record?.tasks ?? [])
    .filter((task) => task.parentTaskId === parentTask.id && task.prorationWeightBp !== null)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
}

function span(plan: Readonly<Record<string, number>>): {
  start: string | null;
  finish: string | null;
  total: number;
} {
  let start: string | null = null;
  let finish: string | null = null;
  let total = 0;
  for (const [date, value] of Object.entries(plan)) {
    total += value;
    if (value > 0) {
      if (start === null || date < start) start = date;
      if (finish === null || date > finish) finish = date;
    }
  }
  return { start, finish, total };
}

describe("subtask template generation (write path + scheduler)", () => {
  const container = new PostgreSqlContainer("postgres:17.6-alpine");
  let client: Client;
  let repository: ProjectRepository;
  let stopContainer: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const started = await container.start();
    stopContainer = async () => started.stop().then(() => undefined);
    client = new Client({ connectionString: started.getConnectionUri() });
    await client.connect();
    await migratePersistenceDatabase(client);
    repository = new ProjectRepository(createPersistenceDatabase(client));
  }, 60_000);

  afterAll(async () => {
    await client.end();
    await stopContainer?.();
  });

  beforeEach(async () => {
    await client.query("truncate table tenants cascade");
    await repository.save(demoProjectRecord);
  });

  function service() {
    return createProjectCommandService(
      new PostgresProjectCommandUnitOfWork(createPersistenceDatabase(client)),
    );
  }

  const envelope = {
    tenantId: demoProjectRecord.tenant.id,
    projectId: demoProjectRecord.project.id,
    actor: { type: "HUMAN" as const, id: "user-001" },
  };

  async function setParentEffort(revision: bigint, minutes: number): Promise<void> {
    await service().execute({
      ...envelope,
      expectedRevision: revision,
      idempotencyKey: `parent-effort-${minutes}`,
      command: { type: "task.update", taskId: parentTask.id, changes: { plannedEffortMinutes: minutes } },
    });
  }

  async function generate(revision: bigint): Promise<void> {
    await service().execute({
      ...envelope,
      expectedRevision: revision,
      idempotencyKey: "generate-subtasks",
      command: {
        type: "task.generateSubtasks",
        parentTaskId: parentTask.id,
        templateId: standardBuildTemplateId,
      },
    });
  }

  function reload() {
    return repository.load(demoProjectRecord.tenant.id, demoProjectRecord.project.id);
  }

  it("prorates the parent effort, chains dependencies, and the scheduler places them in order", async () => {
    await setParentEffort(1n, 2_400);
    await generate(2n);

    const reloaded = await reload();
    const children = subtasksOf(reloaded);

    expect(children.map((child) => child.name)).toEqual(["Design", "Review", "Rework", "Build", "Test"]);
    expect(children.map((child) => child.prorationWeightBp)).toEqual([2_000, 1_000, 1_000, 4_000, 2_000]);
    expect(children.map((child) => child.plannedEffortMinutes)).toEqual([480, 240, 240, 960, 480]);
    expect(children.reduce((sum, child) => sum + child.plannedEffortMinutes, 0)).toBe(2_400);

    // Template dependencies persisted as FS with the template lag. The repository
    // returns edges ordered by successor id, so compare order-independently.
    const childIds = new Set(children.map((child) => child.id));
    const edgeKey = (edge: { predecessorTaskId: string; successorTaskId: string }) =>
      `${edge.predecessorTaskId}:${edge.successorTaskId}`;
    const edges = (reloaded?.dependencies ?? [])
      .filter((dependency) => childIds.has(dependency.successorTaskId))
      .map(({ predecessorTaskId, successorTaskId, type, lagWorkingDays }) => ({
        predecessorTaskId,
        successorTaskId,
        type,
        lagWorkingDays,
      }))
      .sort((left, right) => edgeKey(left).localeCompare(edgeKey(right)));
    const expectedEdges = [
      { predecessorTaskId: children[0]!.id, successorTaskId: children[1]!.id, type: "FS", lagWorkingDays: 1 },
      { predecessorTaskId: children[1]!.id, successorTaskId: children[2]!.id, type: "FS", lagWorkingDays: 0 },
      { predecessorTaskId: children[2]!.id, successorTaskId: children[3]!.id, type: "FS", lagWorkingDays: 0 },
      { predecessorTaskId: children[3]!.id, successorTaskId: children[4]!.id, type: "FS", lagWorkingDays: 0 },
    ].sort((left, right) => edgeKey(left).localeCompare(edgeKey(right)));
    expect(edges).toEqual(expectedEdges);

    // Step ④ scheduler auto-placed each unlocked child; every daily plan sums to L,
    // and each successor starts strictly after its predecessor finishes (lag honored).
    const spans = children.map((child) => span(child.dailyPlan));
    children.forEach((child, index) => {
      expect(spans[index]!.total).toBe(child.plannedEffortMinutes);
    });
    expect(spans[0]!.start).toBe("2026-01-05");
    for (let index = 1; index < spans.length; index += 1) {
      expect(spans[index]!.start! > spans[index - 1]!.finish!).toBe(true);
    }
    // Review is FS+1 after Design (one working day gap), the others FS+0.
    expect(spans[0]!.finish).toBe("2026-01-05");
    expect(spans[1]!.start).toBe("2026-01-07");
  });

  it("re-prorates the children when the parent planned effort changes", async () => {
    await setParentEffort(1n, 2_400);
    await generate(2n);
    await setParentEffort(3n, 3_600);

    const children = subtasksOf(await reload());
    expect(children.map((child) => child.plannedEffortMinutes)).toEqual([720, 360, 360, 1_440, 720]);
    expect(children.reduce((sum, child) => sum + child.plannedEffortMinutes, 0)).toBe(3_600);
  });

  it("re-prorates the siblings when a child weight changes, holding Σ = parent L", async () => {
    await setParentEffort(1n, 2_400);
    await generate(2n);

    const design = subtasksOf(await reload())[0]!;
    await service().execute({
      ...envelope,
      expectedRevision: 3n,
      idempotencyKey: "edit-weight",
      command: { type: "task.update", taskId: design.id, changes: { prorationWeightBp: 4_000 } },
    });

    const children = subtasksOf(await reload());
    expect(children.map((child) => child.prorationWeightBp)).toEqual([4_000, 1_000, 1_000, 4_000, 2_000]);
    expect(children.map((child) => child.plannedEffortMinutes)).toEqual([800, 200, 200, 800, 400]);
    expect(children.reduce((sum, child) => sum + child.plannedEffortMinutes, 0)).toBe(2_400);
  });
});
