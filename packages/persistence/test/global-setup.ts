import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";

/**
 * ONE PostgreSQL container for the whole test run.
 *
 * Every test file used to start its own, which cost a container boot per file
 * and — with all eight running at once — put enough load on the machine that
 * real statements outran vitest's per-test timeout. vitest then abandoned a
 * test while its transaction was still open, and the leftover rows failed the
 * NEXT test on a unique constraint. The container is the expensive, contended
 * resource; a database inside it is neither. So the container is global and the
 * isolation boundary moves down to the database, which `startTestDatabase`
 * creates per file.
 */
let container: StartedPostgreSqlContainer | undefined;

export async function setup(project: TestProject): Promise<void> {
  container = await new PostgreSqlContainer("postgres:17.6-alpine").start();
  project.provide("postgresUri", container.getConnectionUri());
}

export async function teardown(): Promise<void> {
  await container?.stop();
  container = undefined;
}

declare module "vitest" {
  interface ProvidedContext {
    /** Connection URI of the shared container's default database. */
    postgresUri: string;
  }
}
