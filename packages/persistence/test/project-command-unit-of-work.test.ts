import {
  IdempotencyConflictError,
  ProjectVersionConflictError,
  createProjectCommandService,
  type ProjectTask,
} from "@vecta/application";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceDatabase,
  demoProjectRecord,
  migratePersistenceDatabase,
  PostgresProjectCommandUnitOfWork,
  ProjectRepository,
} from "../src/index.js";

const parentTask = demoProjectRecord.tasks.find((task) => task.parentTaskId === null)!;
const leafTask = demoProjectRecord.tasks.find((task) => task.parentTaskId !== null)!;
const secondLeaf = demoProjectRecord.tasks.filter((task) => task.parentTaskId !== null)[1]!;

describe("PostgresProjectCommandUnitOfWork", () => {
  const container = new PostgreSqlContainer("postgres:17.6-alpine");
  let client: Client;
  let connectionString: string;
  let repository: ProjectRepository;
  let stopContainer: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const started = await container.start();
    connectionString = started.getConnectionUri();
    stopContainer = async () => started.stop().then(() => undefined);
    client = new Client({ connectionString });
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

  it("persists a command with revision, audit event, and idempotency receipt", async () => {
    const result = await service().execute({
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      expectedRevision: 1n,
      idempotencyKey: "progress-update",
      actor: { type: "HUMAN", id: "user-001" },
      command: {
        type: "task.update",
        taskId: leafTask.id,
        changes: { progressBasisPoints: 7_500, actualEffortMinutes: 4_200 },
      },
    });

    expect(result).toEqual({ projectId: demoProjectRecord.project.id, revision: 2n, replayed: false });

    const reloaded = await repository.load(demoProjectRecord.tenant.id, demoProjectRecord.project.id);
    expect(reloaded?.project.revision).toBe(2n);
    expect(reloaded?.tasks.find((task) => task.id === leafTask.id)).toMatchObject({
      progressBasisPoints: 7_500,
      actualEffortMinutes: 4_200,
    });
    expect(reloaded?.auditEvents.at(-1)).toMatchObject({
      projectRevision: 2n,
      actorType: "HUMAN",
      actorId: "user-001",
      commandType: "task.update",
    });
  });

  it("persists all native task columns and reloads them identically", async () => {
    const changes: Partial<Omit<ProjectTask, "id">> = {
      name: "Reworked subtask",
      processId: demoProjectRecord.processes[1]!.id,
      productId: demoProjectRecord.products[1]!.id,
      note: "Reworked note",
      contract: "Contract 9",
      plannedEffortMinutes: 960,
      progressBasisPoints: 6_000,
      actualEffortMinutes: 720,
      dailyPlan: { "2026-01-06": 480, "2026-01-07": 480 },
      actualStart: "2026-01-06",
      actualFinish: "2026-01-08",
    };

    await service().execute({
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      expectedRevision: 1n,
      idempotencyKey: "rewrite-leaf",
      actor: { type: "HUMAN", id: "user-001" },
      command: { type: "task.update", taskId: leafTask.id, changes },
    });

    const reloaded = await repository.load(demoProjectRecord.tenant.id, demoProjectRecord.project.id);
    expect(reloaded?.tasks.find((task) => task.id === leafTask.id)).toMatchObject(changes);
  });

  it("allows a downward actual-effort correction (W monotonic guard removed)", async () => {
    await service().execute({
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      expectedRevision: 1n,
      idempotencyKey: "raise-effort",
      actor: { type: "HUMAN", id: "user-001" },
      command: { type: "task.update", taskId: leafTask.id, changes: { actualEffortMinutes: 5_000 } },
    });
    await service().execute({
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      expectedRevision: 2n,
      idempotencyKey: "correct-effort",
      actor: { type: "HUMAN", id: "user-001" },
      command: { type: "task.update", taskId: leafTask.id, changes: { actualEffortMinutes: 100 } },
    });

    const reloaded = await repository.load(demoProjectRecord.tenant.id, demoProjectRecord.project.id);
    expect(reloaded?.tasks.find((task) => task.id === leafTask.id)?.actualEffortMinutes).toBe(100);
    expect(reloaded?.project.revision).toBe(3n);
  });

  it("adds a task with hierarchy and typed dependencies", async () => {
    const newTaskId = "e0000000-0000-4000-8000-0000000fffff";
    // The client never supplies the display No.; the server assigns it (§F-1).
    const task: Omit<ProjectTask, "seq"> = {
      id: newTaskId,
      parentId: parentTask.id,
      sortOrder: 9_000,
      name: "Post-launch review",
      processId: demoProjectRecord.processes[0]!.id,
      productId: demoProjectRecord.products[0]!.id,
      note: "",
      contract: "Contract 1",
      assigneeMemberId: demoProjectRecord.members[0]!.id,
      plannedEffortMinutes: 120,
      progressBasisPoints: 0,
      actualEffortMinutes: 0,
      prorationWeightBp: null,
      dailyPlan: { "2026-01-05": 120 },
      actualStart: null,
      actualFinish: null,
      dependencies: [
        { predecessorId: leafTask.id, type: "SS", lagWorkingDays: 1 },
        { predecessorId: secondLeaf.id, type: "FF", lagWorkingDays: 2 },
      ],
    };

    await service().execute({
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      expectedRevision: 1n,
      idempotencyKey: "add-review",
      actor: { type: "HUMAN", id: "user-001" },
      command: { type: "task.add", task },
    });

    const reloaded = await repository.load(demoProjectRecord.tenant.id, demoProjectRecord.project.id);
    expect(reloaded?.tasks.find((row) => row.id === newTaskId)).toMatchObject({
      parentTaskId: parentTask.id,
      name: "Post-launch review",
      assigneeMemberId: demoProjectRecord.members[0]!.id,
      // The server assigned the display No. from the project counter and advanced
      // it (§F-1): the new task takes the seed's nextTaskSeq, now bumped by one.
      seq: demoProjectRecord.project.nextTaskSeq,
    });
    expect(reloaded?.project.nextTaskSeq).toBe(demoProjectRecord.project.nextTaskSeq + 1);
    expect(
      reloaded?.dependencies
        .filter((dependency) => dependency.successorTaskId === newTaskId)
        .map(({ predecessorTaskId, type, lagWorkingDays }) => ({ predecessorTaskId, type, lagWorkingDays }))
        .sort((left, right) => left.predecessorTaskId.localeCompare(right.predecessorTaskId)),
    ).toEqual([
      { predecessorTaskId: leafTask.id, type: "SS", lagWorkingDays: 1 },
      { predecessorTaskId: secondLeaf.id, type: "FF", lagWorkingDays: 2 },
    ]);
  });

  it("deletes a leaf task and its dependencies", async () => {
    // A leaf that no other task depends on (the last leaf in its parent chain).
    const deletableLeaf = demoProjectRecord.tasks.find(
      (task) =>
        task.parentTaskId !== null &&
        !demoProjectRecord.dependencies.some((dependency) => dependency.predecessorTaskId === task.id),
    )!;

    await service().execute({
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      expectedRevision: 1n,
      idempotencyKey: "delete-leaf",
      actor: { type: "HUMAN", id: "user-001" },
      command: { type: "task.delete", taskId: deletableLeaf.id },
    });

    const reloaded = await repository.load(demoProjectRecord.tenant.id, demoProjectRecord.project.id);
    expect(reloaded?.tasks.some((task) => task.id === deletableLeaf.id)).toBe(false);
    expect(
      reloaded?.dependencies.some(
        (dependency) =>
          dependency.predecessorTaskId === deletableLeaf.id ||
          dependency.successorTaskId === deletableLeaf.id,
      ),
    ).toBe(false);
  });

  it("adds and removes a member", async () => {
    const memberId = "c0000000-0000-4000-8000-0000000000ff";
    await service().execute({
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      expectedRevision: 1n,
      idempotencyKey: "add-member",
      actor: { type: "HUMAN", id: "user-001" },
      command: {
        type: "member.add",
        member: { id: memberId, name: "Member 99", calendarId: "standard", dailyCapacityMinutes: 420 },
      },
    });
    let reloaded = await repository.load(demoProjectRecord.tenant.id, demoProjectRecord.project.id);
    expect(reloaded?.members.find((member) => member.id === memberId)).toMatchObject({
      name: "Member 99",
      dailyCapacityMinutes: 420,
    });

    await service().execute({
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      expectedRevision: 2n,
      idempotencyKey: "delete-member",
      actor: { type: "HUMAN", id: "user-001" },
      command: { type: "member.delete", memberId },
    });
    reloaded = await repository.load(demoProjectRecord.tenant.id, demoProjectRecord.project.id);
    expect(reloaded?.members.some((member) => member.id === memberId)).toBe(false);
  });

  it("adds, renames, and removes a process master", async () => {
    const processId = "70000000-0000-4000-8000-0000000000ff";
    await service().execute({
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      expectedRevision: 1n,
      idempotencyKey: "add-process",
      actor: { type: "HUMAN", id: "user-001" },
      command: { type: "process.add", process: { id: processId, name: "Phase Z", sortOrder: 99 } },
    });
    let reloaded = await repository.load(demoProjectRecord.tenant.id, demoProjectRecord.project.id);
    expect(reloaded?.processes.find((process) => process.id === processId)).toMatchObject({
      name: "Phase Z",
      sortOrder: 99,
    });

    await service().execute({
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      expectedRevision: 2n,
      idempotencyKey: "rename-process",
      actor: { type: "HUMAN", id: "user-001" },
      command: { type: "process.update", processId, changes: { name: "Phase ZZ" } },
    });
    reloaded = await repository.load(demoProjectRecord.tenant.id, demoProjectRecord.project.id);
    expect(reloaded?.processes.find((process) => process.id === processId)?.name).toBe("Phase ZZ");

    await service().execute({
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      expectedRevision: 3n,
      idempotencyKey: "delete-process",
      actor: { type: "HUMAN", id: "user-001" },
      command: { type: "process.delete", processId },
    });
    reloaded = await repository.load(demoProjectRecord.tenant.id, demoProjectRecord.project.id);
    expect(reloaded?.processes.some((process) => process.id === processId)).toBe(false);
  });

  it("replays the original result for a repeated command", async () => {
    const request = {
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      expectedRevision: 1n,
      idempotencyKey: "replay-key",
      actor: { type: "AGENT" as const, id: "agent-001" },
      command: {
        type: "task.update" as const,
        taskId: leafTask.id,
        changes: { actualEffortMinutes: 4_200 },
      },
    };
    await service().execute(request);
    const replay = await service().execute(request);
    expect(replay).toEqual({ projectId: demoProjectRecord.project.id, revision: 2n, replayed: true });

    const reloaded = await repository.load(demoProjectRecord.tenant.id, demoProjectRecord.project.id);
    expect(reloaded?.tasks.find((task) => task.id === leafTask.id)?.actualEffortMinutes).toBe(4_200);
    expect(reloaded?.auditEvents).toHaveLength(2);
  });

  it("rejects an idempotency key reused for a different command", async () => {
    const request = {
      tenantId: demoProjectRecord.tenant.id,
      projectId: demoProjectRecord.project.id,
      expectedRevision: 1n,
      idempotencyKey: "same-key",
      actor: { type: "HUMAN" as const, id: "user-001" },
      command: {
        type: "task.update" as const,
        taskId: leafTask.id,
        changes: { progressBasisPoints: 7_000 },
      },
    };
    await service().execute(request);
    await expect(
      service().execute({
        ...request,
        command: { ...request.command, changes: { progressBasisPoints: 8_000 } },
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    const reloaded = await repository.load(demoProjectRecord.tenant.id, demoProjectRecord.project.id);
    expect(reloaded?.tasks.find((task) => task.id === leafTask.id)?.progressBasisPoints).toBe(7_000);
    expect(reloaded?.project.revision).toBe(2n);
  });

  it("rejects a stale revision without mutating state", async () => {
    await expect(
      service().execute({
        tenantId: demoProjectRecord.tenant.id,
        projectId: demoProjectRecord.project.id,
        expectedRevision: 0n,
        idempotencyKey: "stale",
        actor: { type: "HUMAN", id: "user-001" },
        command: { type: "task.update", taskId: leafTask.id, changes: { name: "Must not persist" } },
      }),
    ).rejects.toBeInstanceOf(ProjectVersionConflictError);

    const reloaded = await repository.load(demoProjectRecord.tenant.id, demoProjectRecord.project.id);
    expect(reloaded?.project.revision).toBe(1n);
    expect(reloaded?.auditEvents).toHaveLength(1);
  });

  it("serializes concurrent retries so only one command mutates the project", async () => {
    const concurrentClient = new Client({ connectionString });
    await concurrentClient.connect();
    try {
      const first = createProjectCommandService(
        new PostgresProjectCommandUnitOfWork(createPersistenceDatabase(client)),
      );
      const second = createProjectCommandService(
        new PostgresProjectCommandUnitOfWork(createPersistenceDatabase(concurrentClient)),
      );
      const request = {
        tenantId: demoProjectRecord.tenant.id,
        projectId: demoProjectRecord.project.id,
        expectedRevision: 1n,
        idempotencyKey: "concurrent",
        actor: { type: "AGENT" as const, id: "agent-001" },
        command: {
          type: "task.update" as const,
          taskId: leafTask.id,
          changes: { actualEffortMinutes: 4_200 },
        },
      };

      const results = await Promise.all([first.execute(request), second.execute(request)]);
      expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);

      const reloaded = await repository.load(demoProjectRecord.tenant.id, demoProjectRecord.project.id);
      expect(reloaded?.tasks.find((task) => task.id === leafTask.id)?.actualEffortMinutes).toBe(4_200);
      expect(reloaded?.auditEvents).toHaveLength(2);
    } finally {
      await concurrentClient.end();
    }
  });
});
