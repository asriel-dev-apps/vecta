import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDatabase, type TestDatabase } from "./database.js";

const execute = promisify(execFile);
const script = new URL("../scripts/migrate.mjs", import.meta.url);

describe("production migration CLI", () => {
  let connectionString: string;
  let client: Client;
  let testDatabase: TestDatabase;

  beforeAll(async () => {
    testDatabase = await startTestDatabase("migration_cli");
    connectionString = testDatabase.connectionString;
    client = testDatabase.client;
  }, 60_000);

  afterAll(async () => {
    await testDatabase.dispose();
  });

  function environment(overrides: Record<string, string> = {}) {
    const target = new URL(connectionString);
    return {
      ...process.env,
      DATABASE_URL: connectionString,
      DEPLOY_ENV: "staging",
      EXPECTED_DATABASE_HOST: target.hostname,
      EXPECTED_DATABASE_NAME: decodeURIComponent(target.pathname.slice(1)),
      ...overrides,
    };
  }

  it("checks the target and applies the migration journal", async () => {
    const result = await execute(process.execPath, [script.pathname], { env: environment() });
    expect(JSON.parse(result.stdout.trim())).toEqual({
      event: "database_migrations_complete",
      environment: "staging",
    });
    const migrated = await client.query<{ count: string }>("select count(*) from drizzle.__drizzle_migrations");
    expect(Number(migrated.rows[0]?.count)).toBeGreaterThan(0);
  }, 60_000);

  it("rejects an unconfirmed target before connecting", async () => {
    await expect(execute(process.execPath, [script.pathname], {
      env: environment({ EXPECTED_DATABASE_HOST: "wrong.example.test" }),
    })).rejects.toMatchObject({ stderr: expect.stringContaining("does not match the confirmed database target") });
  });

  it("rejects concurrent migration execution", async () => {
    await client.query("select pg_advisory_lock($1, $2)", [1_169_796_931, 1_761_609_076]);
    try {
      await expect(execute(process.execPath, [script.pathname], { env: environment() }))
        .rejects.toMatchObject({ stderr: expect.stringContaining("migration is already running") });
    } finally {
      await client.query("select pg_advisory_unlock($1, $2)", [1_169_796_931, 1_761_609_076]);
    }
  });
});
