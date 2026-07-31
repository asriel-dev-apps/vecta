#!/usr/bin/env node
// Fill a NON-PRODUCTION database with the deterministic synthetic project that
// `createSeedProjectRecord()` already generates for the tests, plus one principal
// bound as OWNER, so an agent can sign a session cookie and drive real screens
// against real rows.
//
//   DEPLOY_ENV=staging \
//   EXPECTED_DATABASE_HOST=<host> \
//   DATABASE_URL=... \
//   OIDC_ISSUER=https://accounts.google.com \
//   SEED_SUBJECT=agent-verification \
//   pnpm --filter @vecta/persistence db:seed:demo -- --reset
//
// Every label it writes is generic ("Phase A", "Product 1", "Member 01"); the
// reference worksheet under .wbs-private/ is never read and no real name, email
// or value appears here. Same rule as the fixtures.
//
// It REFUSES to run unless DEPLOY_ENV is `staging`. A demo project inserted into
// production would sit next to real work and look exactly like it, so the bad
// path is closed rather than documented. Also mirrors `migrate.mjs`'s
// EXPECTED_DATABASE_HOST / EXPECTED_DATABASE_NAME confirmation, because
// "the connection string I exported" is the easiest thing in this repo to get wrong.
//
// Why a loader hook: `@vecta/persistence` ships TypeScript source (its `exports`
// is `./src/index.ts`) and its build emits declarations only, so there is no
// runtime `dist` to import. Node strips the types on its own; what it does not do
// is resolve the `./foo.js` specifiers TypeScript writes for `./foo.ts`. The hook
// below is that one rewrite and nothing else — it is not a bundler.
//
// Why `--experimental-transform-types` (set in the `db:seed:demo` script, which is
// why you should run it that way): `ProjectRepository`'s constructor uses a
// parameter property (`private readonly database`), which is not erasable syntax,
// so Node's default strip-only mode refuses the file outright. Transform mode
// compiles it instead. Nothing here depends on the flag beyond that.

import { register } from "node:module";
import { randomUUID } from "node:crypto";
import process from "node:process";

const TS_SOURCE_RESOLVE_HOOK = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && specifier.endsWith(".js")) {
    try {
      return await nextResolve(specifier.slice(0, -3) + ".ts", context);
    } catch (error) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    }
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(TS_SOURCE_RESOLVE_HOOK)}`);

const { default: pg } = await import("pg");
const {
  ProjectRepository,
  createPersistenceDatabase,
  createSeedProjectRecord,
  migratePersistenceDatabase,
} = await import("../src/index.ts");

const reset = process.argv.includes("--reset");
const dryRun = process.argv.includes("--dry-run");

const connectionString = process.env.DATABASE_URL;
const environment = process.env.DEPLOY_ENV;
const expectedHost = process.env.EXPECTED_DATABASE_HOST;
const expectedDatabase = process.env.EXPECTED_DATABASE_NAME;
const issuer = process.env.OIDC_ISSUER ?? "https://accounts.google.com";
const subject = process.env.SEED_SUBJECT ?? "agent-verification";
const displayName = process.env.SEED_DISPLAY_NAME ?? "Verification agent";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function fail(message) {
  throw new Error(message);
}

if (environment !== "staging") {
  fail("DEPLOY_ENV must be `staging`; this script refuses to seed production");
}
if (connectionString === undefined || connectionString.length === 0) {
  fail("DATABASE_URL is required");
}
if (expectedHost === undefined || expectedHost.length === 0) {
  fail("EXPECTED_DATABASE_HOST is required");
}
if (expectedDatabase === undefined || expectedDatabase.length === 0) {
  fail("EXPECTED_DATABASE_NAME is required");
}

const target = new URL(connectionString);
const databaseName = decodeURIComponent(target.pathname.replace(/^\//u, ""));
if (target.protocol !== "postgres:" && target.protocol !== "postgresql:") {
  fail("DATABASE_URL must use PostgreSQL");
}
if (target.hostname !== expectedHost || databaseName !== expectedDatabase) {
  fail("DATABASE_URL does not match the confirmed database target");
}

const tenantId = process.env.SEED_TENANT_ID ?? "a0000000-0000-4000-8000-000000000001";
const projectId = process.env.SEED_PROJECT_ID ?? "b0000000-0000-4000-8000-000000000001";
const principalId = process.env.SEED_PRINCIPAL_ID ?? randomUUID();
for (const [name, value] of [
  ["SEED_TENANT_ID", tenantId],
  ["SEED_PROJECT_ID", projectId],
  ["SEED_PRINCIPAL_ID", principalId],
]) {
  if (!UUID.test(value)) fail(`${name} must be a UUID`);
}

/**
 * mulberry32, the same PRNG the fixture generator uses, so a seeded database is
 * reproducible from the seed number alone.
 */
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Spend a different number of minutes than the plan said.
 *
 * The fixture sets `actualEffortMinutes` to exactly `planned × progress`, which
 * makes EV and AC identical and therefore CPI exactly 1.00 on every single row.
 * A dashboard whose whole job is to show cost variance would render a column of
 * 1.00 and look correct while proving nothing — the risk marker (CPI < 0.9)
 * would never fire, in either direction. So the seed applies a deterministic
 * factor per leaf; CPI lands in roughly [0.69, 1.43] and both sides of the
 * threshold appear. Leaves with no progress keep AC = 0, which is the case that
 * has to render as `-` rather than as a division by zero.
 */
function applyCostVariance(record, seed = 0xc057) {
  const random = createRandom(seed);
  return {
    ...record,
    tasks: record.tasks.map((task) => {
      if (task.parentTaskId === null || task.actualEffortMinutes === 0) return task;
      const factor = 0.7 + random() * 0.75;
      return { ...task, actualEffortMinutes: Math.round(task.actualEffortMinutes * factor) };
    }),
  };
}

const record = applyCostVariance(createSeedProjectRecord({ tenantId, projectId }));
const leaves = record.tasks.filter((task) => task.parentTaskId !== null);

console.log(
  JSON.stringify({
    event: "seed_demo_plan",
    dryRun,
    reset,
    database: `${target.protocol}//${target.host}${target.pathname}`,
    tenantId,
    projectId,
    principal: { id: principalId, issuer, subject, displayName },
    counts: {
      tasks: record.tasks.length,
      leaves: leaves.length,
      members: record.members.length,
      processes: record.processes.length,
      products: record.products.length,
      templates: record.templates.length,
      dependencies: record.dependencies.length,
    },
  }),
);

if (dryRun) {
  console.log(JSON.stringify({ event: "seed_demo_dry_run_complete" }));
  process.exit(0);
}

const client = new pg.Client({ connectionString });
await client.connect();
try {
  await migratePersistenceDatabase(client);

  // The environment guards above are only as good as the values the caller
  // exported, and deriving EXPECTED_DATABASE_HOST from DATABASE_URL makes them
  // inert. This one cannot be derived: a database holding a project that is not
  // this seed's is somebody's real workspace, whatever DEPLOY_ENV claimed.
  const foreign = await client.query({
    text: "select count(*)::int as count from projects where id <> $1",
    values: [projectId],
  });
  if (foreign.rows[0].count > 0) {
    fail(
      `target holds ${foreign.rows[0].count} project(s) this seed did not create — refusing; this is not a dedicated database`,
    );
  }

  const existing = await client.query({
    text: "select 1 from projects where id = $1 and tenant_id = $2",
    values: [projectId, tenantId],
  });
  if (existing.rowCount > 0) {
    // `save()` is plain inserts, not upserts, so re-running without --reset would
    // die on a primary key halfway through and leave the project half-written.
    // Refuse loudly instead.
    if (!reset) fail("the project already exists; pass --reset to replace it");
    await client.query({ text: "delete from tenants where id = $1", values: [tenantId] });
  }

  const database = createPersistenceDatabase(client);
  await new ProjectRepository(database).save(record);

  await client.query("begin");
  try {
    const principal = await client.query({
      text: `insert into principals (id, issuer, subject, type, display_name, allowed_scopes)
             values ($1, $2, $3, 'HUMAN', $4, '{}'::text[])
             on conflict (issuer, subject) do update set display_name = excluded.display_name
             returning id`,
      values: [principalId, issuer, subject, displayName],
    });
    const resolvedPrincipalId = principal.rows[0].id;
    await client.query({
      text: `insert into tenant_memberships (tenant_id, principal_id, role)
             values ($1, $2, 'OWNER')
             on conflict (tenant_id, principal_id) do update set role = 'OWNER'`,
      values: [tenantId, resolvedPrincipalId],
    });
    await client.query({
      text: `insert into project_memberships (tenant_id, project_id, principal_id, role)
             values ($1, $2, $3, 'OWNER')
             on conflict (tenant_id, project_id, principal_id) do update set role = 'OWNER'`,
      values: [tenantId, projectId, resolvedPrincipalId],
    });
    await client.query("commit");
    console.log(
      JSON.stringify({
        event: "seed_demo_complete",
        tenantId,
        projectId,
        principalId: resolvedPrincipalId,
      }),
    );
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
} finally {
  await client.end();
}
