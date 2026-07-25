import { Client } from "pg";
import { inject } from "vitest";

export interface TestDatabase {
  /** Connection string for this file's own database inside the shared container. */
  readonly connectionString: string;
  /** An open client against that database. */
  readonly client: Client;
  /** Closes the client and drops the database. */
  dispose(): Promise<void>;
}

/**
 * A database of its own, inside the container `global-setup.ts` started.
 *
 * Isolation is per FILE, exactly as it was when each file owned a container:
 * nothing one file writes is visible to another. What changed is the price —
 * creating a database is milliseconds, starting a container is seconds.
 *
 * `name` becomes part of an SQL identifier, which PostgreSQL cannot
 * parameterise, so it is restricted to characters that need no quoting rather
 * than trusted. Callers pass a literal derived from the file name.
 */
export async function startTestDatabase(name: string): Promise<TestDatabase> {
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(name)) {
    throw new Error(`test database name must match /^[a-z][a-z0-9_]{0,40}$/, got ${JSON.stringify(name)}`);
  }

  const baseUri = inject("postgresUri");
  const databaseName = `vecta_test_${name}`;

  await withAdminClient(baseUri, async (admin) => {
    await admin.query(`drop database if exists ${databaseName} with (force)`);
    await admin.query(`create database ${databaseName}`);
  });

  const target = new URL(baseUri);
  target.pathname = `/${databaseName}`;
  const connectionString = target.toString();

  const client = new Client({ connectionString });
  await client.connect();

  return {
    connectionString,
    client,
    async dispose() {
      await client.end();
      await withAdminClient(baseUri, async (admin) => {
        await admin.query(`drop database if exists ${databaseName} with (force)`);
      });
    },
  };
}

async function withAdminClient(baseUri: string, work: (client: Client) => Promise<void>): Promise<void> {
  const admin = new Client({ connectionString: baseUri });
  await admin.connect();
  try {
    await work(admin);
  } finally {
    await admin.end();
  }
}
