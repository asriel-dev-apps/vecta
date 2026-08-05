import { projectWbsGrid } from "@vecta/application";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceDatabase,
  createSeedProjectRecord,
  demoProjectRecord,
  migratePersistenceDatabase,
  NeonHttpProjectWorkspaceReader,
  ProjectRepository,
  ProjectWorkspaceRepository,
  type NeonHttpReadDatabase,
  type PersistenceDatabase,
} from "../src/index.js";
import { startTestDatabase, type TestDatabase } from "./database.js";

/** How many queries each `batch(...)` call carried, in call order. */
const batchedQueryCounts: number[] = [];

/**
 * A Postgres handle that answers `batch(...)` by running the queries it is
 * given. Everything else — the query builders the reader constructs, the row
 * decoding — is the real Drizzle database, so this substitutes the ONE thing a
 * local Postgres cannot provide (Neon's SQL-over-HTTP batch endpoint) and
 * nothing else.
 */
function batchingReadDatabase(database: PersistenceDatabase): NeonHttpReadDatabase {
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property === "batch") {
        return (queries: readonly PromiseLike<unknown>[]) => {
          batchedQueryCounts.push(queries.length);
          return Promise.all(queries);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as NeonHttpReadDatabase;
}

describe("ProjectRepository", () => {
  let client: Client;
  let repository: ProjectRepository;
  let workspaceRepository: ProjectWorkspaceRepository;
  let testDatabase: TestDatabase;

  beforeAll(async () => {
    testDatabase = await startTestDatabase("repository");
    client = testDatabase.client;
    await migratePersistenceDatabase(client);
    const database = createPersistenceDatabase(client);
    repository = new ProjectRepository(database);
    workspaceRepository = new ProjectWorkspaceRepository(database);
  }, 60_000);

  afterAll(async () => {
    await testDatabase.dispose();
  });

  beforeEach(async () => {
    batchedQueryCounts.length = 0;
    await client.query("truncate table tenants cascade");
    await repository.save(demoProjectRecord);
  });

  it("saves and reloads the tenant-scoped demo project", async () => {
    const loaded = await repository.load(demoProjectRecord.project.tenantId, demoProjectRecord.project.id);

    expect(loaded?.project.revision).toBe(1n);
    expect(loaded?.tasks).toHaveLength(demoProjectRecord.tasks.length);
    expect(loaded?.members).toHaveLength(demoProjectRecord.members.length);
    expect(loaded?.processes).toHaveLength(demoProjectRecord.processes.length);
    expect(loaded?.products).toHaveLength(demoProjectRecord.products.length);
    expect(loaded?.dependencies).toHaveLength(demoProjectRecord.dependencies.length);
    expect(loaded?.auditEvents).toEqual(demoProjectRecord.auditEvents);

    const leaf = demoProjectRecord.tasks.find((task) => task.parentTaskId !== null)!;
    expect(loaded?.tasks.find((task) => task.id === leaf.id)).toMatchObject({
      parentTaskId: leaf.parentTaskId,
      plannedEffortMinutes: leaf.plannedEffortMinutes,
      progressBasisPoints: leaf.progressBasisPoints,
      dailyPlan: leaf.dailyPlan,
    });

    await expect(
      repository.load("00000000-0000-4000-8000-ffffffffffff", demoProjectRecord.project.id),
    ).resolves.toBeNull();
  });

  it("loads Current and revision for the workspace", async () => {
    const workspace = await workspaceRepository.load(
      demoProjectRecord.project.tenantId,
      demoProjectRecord.project.id,
    );
    expect(workspace?.revision).toBe(1n);
    expect(workspace?.current.id).toBe(demoProjectRecord.project.id);
    expect(workspace?.current.tasks).toHaveLength(demoProjectRecord.tasks.length);
    expect(workspace?.current.members).toHaveLength(demoProjectRecord.members.length);
  });

  it("reads the same workspace through the batched (HTTP) reader", async () => {
    // The batched reader is what production reads through: it sends the header +
    // nine child queries as ONE `db.batch(...)` instead of that many sequential
    // round trips. Only the execution strategy differs — the queries and the
    // row→record mapping are shared code — so the two readers must agree exactly.
    // Running it here against the real database exercises the batch WIRING (that
    // every query is issued, and that the results are threaded back in the right
    // order) with no fake rows: only `batch` itself is substituted, since the Neon
    // HTTP endpoint has no local equivalent.
    const workspace = await new NeonHttpProjectWorkspaceReader(
      batchingReadDatabase(createPersistenceDatabase(client)),
    ).load(demoProjectRecord.project.tenantId, demoProjectRecord.project.id);

    expect(workspace).toEqual(
      await workspaceRepository.load(
        demoProjectRecord.project.tenantId,
        demoProjectRecord.project.id,
      ),
    );
    // ONE batch is the invariant — the array's LENGTH, not the number inside it.
    // A `/projects/:id/*` document already costs two sequential Neon round trips
    // and the 2026-07-26 fold exists to keep it at two. The count went 8 -> 10 when
    // the baseline joined the batch (Design 0009): more statements, same round
    // trip, which is why the baseline was put here rather than in a query of its
    // own. Both halves are asserted, so adding a SECOND batch fails as loudly as
    // dropping a query does.
    expect(batchedQueryCounts).toHaveLength(1);
    expect(batchedQueryCounts).toEqual([10]);

    await expect(
      new NeonHttpProjectWorkspaceReader(
        batchingReadDatabase(createPersistenceDatabase(client)),
      ).load("00000000-0000-4000-8000-ffffffffffff", demoProjectRecord.project.id),
    ).resolves.toBeNull();
  });

  it("projects a flat WBS grid with derived columns and a rollup", async () => {
    const workspace = await workspaceRepository.load(
      demoProjectRecord.project.tenantId,
      demoProjectRecord.project.id,
    );
    const projection = projectWbsGrid(workspace!.current);
    expect(projection.rows).toHaveLength(demoProjectRecord.tasks.length);
    expect(projection.rows[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        plannedEffortDays: expect.any(Number),
        plannedEffortHours: expect.any(Number),
        plannedEarnedHours: expect.any(Number),
        plannedProgress: expect.any(Number),
        earnedEffortHours: expect.any(Number),
        actualEffortHours: expect.any(Number),
        costVarianceHours: expect.any(Number),
        status: expect.any(String),
      }),
    );
    expect(Object.keys(projection.rollup)).toEqual([
      "bac",
      "pv",
      "ev",
      "ac",
      "sv",
      "cv",
      "spi",
      "cpi",
    ]);
  });
});

describe("createSeedProjectRecord", () => {
  it("is deterministic for the same seed", () => {
    expect(createSeedProjectRecord()).toEqual(createSeedProjectRecord());
  });

  it("produces a two-level hierarchy with the requested shape", () => {
    const record = createSeedProjectRecord({ parentCount: 10, subtasksPerParent: 4 });
    expect(record.tasks).toHaveLength(10 + 10 * 4);
    expect(record.tasks.filter((task) => task.parentTaskId === null)).toHaveLength(10);
    expect(record.tasks.every((task) => task.name.trim().length > 0)).toBe(true);
  });
});
