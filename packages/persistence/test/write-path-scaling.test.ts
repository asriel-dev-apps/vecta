import { createProjectCommandService } from "@vecta/application";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPersistenceDatabase,
  createSeedProjectRecord,
  migratePersistenceDatabase,
  PostgresProjectCommandUnitOfWork,
  ProjectRepository,
} from "../src/index.js";
import { startTestDatabase, type TestDatabase } from "./database.js";

/**
 * How the write path SCALES — measured in statements, not in seconds.
 *
 * ## Why this test exists
 *
 * Measured 2026-08-06 against staging: importing ONE timesheet row into a
 * 216-task project failed a 20 s budget and passed a 120 s one. The import was
 * not the cause. The unit of work rewrote every task row one statement at a
 * time, twice, so EVERY command paid `round trips × tasks` — and against a
 * database in another region, round trips are the whole cost.
 *
 * ## Why statements and not wall-clock
 *
 * A stopwatch here would measure this machine, this container and this moment,
 * and would need a threshold somebody has to keep re-tuning. The statement count
 * is a property of the code: it is the same number on a laptop and in Singapore,
 * and it is the number that gets multiplied by the round-trip time.
 *
 * ## The control
 *
 * A trivial command — renaming ONE task — is run against a small project and a
 * project an order of magnitude larger, and the statement counts are compared.
 *
 * **They must be equal.** Not "close", not "sub-linear": the work of renaming one
 * task does not depend on how many other tasks exist, so any difference at all is
 * per-row work that should have been one set-based statement. Before the batching
 * this test drove, the two counts differed by roughly twice the task difference.
 */

const SMALL = { parentCount: 2, subtasksPerParent: 2, memberCount: 2 };
const LARGE = { parentCount: 12, subtasksPerParent: 4, memberCount: 2 };

describe("write path scaling", () => {
  let client: Client;
  let testDatabase: TestDatabase;

  beforeAll(async () => {
    testDatabase = await startTestDatabase("write_path_scaling");
    client = testDatabase.client;
    await migratePersistenceDatabase(client);
  }, 60_000);

  afterAll(async () => {
    await testDatabase.dispose();
  });

  /**
   * Seed a project of the given shape, rename ONE leaf through the real command
   * service, and return how many statements that took.
   */
  async function statementsForOneRename(
    options: typeof SMALL,
    name: string,
  ): Promise<{ statements: number; tasks: number }> {
    await client.query("truncate table tenants cascade");
    const record = createSeedProjectRecord(options);
    const repository = new ProjectRepository(createPersistenceDatabase(client));
    await repository.save(record);

    const leaf = record.tasks.find((task) => task.parentTaskId !== null)!;

    // Count only the statements the COMMAND issues — the seeding above is not
    // what is being measured. Wrapping `client.query` catches everything Drizzle
    // sends, including the ones a `for` loop hides inside a transaction.
    let statements = 0;
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as unknown as { query: unknown }).query = (...args: unknown[]): unknown => {
      statements += 1;
      return query(...args);
    };
    try {
      await createProjectCommandService(
        new PostgresProjectCommandUnitOfWork(createPersistenceDatabase(client)),
      ).execute({
        tenantId: record.tenant.id,
        projectId: record.project.id,
        command: { type: "task.update", taskId: leaf.id, changes: { name } },
        expectedRevision: record.project.revision,
        idempotencyKey: `rename-${name}`,
        actor: { type: "HUMAN", id: "00000000-0000-4000-8000-00000000beef" },
      });
    } finally {
      (client as unknown as { query: unknown }).query = query;
    }
    return { statements, tasks: record.tasks.length };
  }

  /**
   * Measured ONCE, in `beforeAll`, and asserted twice below.
   *
   * Seeding a project and running a command against a real database is the
   * expensive part, and this file shares a container with twelve others: an
   * earlier version measured three times and pushed seven unrelated tests in
   * other files past their timeouts (measured 2026-08-07). Two seeds is the
   * minimum that can support the claim.
   */
  let small: { statements: number; tasks: number };
  let large: { statements: number; tasks: number };

  beforeAll(async () => {
    small = await statementsForOneRename(SMALL, "Renamed small");
    large = await statementsForOneRename(LARGE, "Renamed large");
  }, 120_000);

  it("CONTROL: renaming ONE task costs the same whether the project has 6 tasks or 60", () => {
    // The fixtures really are an order of magnitude apart — otherwise the
    // comparison below would be vacuous.
    expect(large.tasks).toBeGreaterThan(small.tasks * 5);

    // The claim. Any difference at all is per-row work.
    expect(large.statements, `small=${small.statements} large=${large.statements}`).toBe(
      small.statements,
    );
  });

  it("keeps the count small in absolute terms, not merely flat", () => {
    // Flat but enormous would satisfy the test above. The command reads the
    // project's tables, writes the changed ones, and appends an audit row and a
    // receipt — a few dozen statements, and nowhere near the task count.
    expect(large.statements).toBeLessThan(60);
  });
});
