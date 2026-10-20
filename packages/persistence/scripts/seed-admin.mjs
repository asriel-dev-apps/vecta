import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { register } from "node:module";
import process from "node:process";
import pg from "pg";

// One-off seed for an authenticated deployment: creates a single tenant, one
// WBS (PROJECT_ID is the WBS id), and one admin principal bound as OWNER of the
// tenant and of that WBS's parent project. A WBS that already exists — including
// one whose parent project id was assigned by migration 0010 — is not inserted
// again; the grant is written on its actual parent and raised to OWNER.
//
// A new WBS goes through ProjectRepository.save: revision 1, its creation
// change, and the base snapshot in one transaction.
//
// Every identity value is read from the environment — no real email, subject, or
// connection string is written here. Applies the existing migrations first, then
// upserts idempotently, so re-running is safe. Pass `--dry-run` to validate the
// parameters and print the plan without connecting.
//
// Required env:
//   DATABASE_URL    Postgres/Neon connection string (never committed)
//   OIDC_ISSUER     e.g. https://accounts.google.com
//   ADMIN_EMAIL     admin email, used as the principal display name
// Optional env:
//   ADMIN_SUBJECT   the provider's stable subject claim (Google `sub`); when omitted the
//                   principal is keyed as `email:<ADMIN_EMAIL>` and the resolver's verified
//                   email fallback matches it at sign-in
//   ADMIN_DISPLAY_NAME  overrides the display name (defaults to ADMIN_EMAIL)
//   TENANT_ID / PROJECT_ID / ADMIN_PRINCIPAL_ID  stable UUIDs (else generated)
//   TENANT_NAME / PROJECT_NAME                   labels (default "VECTA")
//   PROJECT_START / STATUS_DATE                  ISO dates (default today)

const dryRun = process.argv.includes("--dry-run");

const connectionString = process.env.DATABASE_URL;
const issuer = process.env.OIDC_ISSUER;
const email = process.env.ADMIN_EMAIL;
const subject =
  process.env.ADMIN_SUBJECT ??
  (email === undefined ? undefined : `email:${email.trim().toLowerCase()}`);
const displayName = process.env.ADMIN_DISPLAY_NAME ?? email;
const tenantId = process.env.TENANT_ID ?? randomUUID();
const projectId = process.env.PROJECT_ID ?? randomUUID();
const principalId = process.env.ADMIN_PRINCIPAL_ID ?? randomUUID();
const tenantName = process.env.TENANT_NAME ?? "VECTA";
const projectName = process.env.PROJECT_NAME ?? "VECTA";
const today = new Date().toISOString().slice(0, 10);
const projectStart = process.env.PROJECT_START ?? today;
const statusDate = process.env.STATUS_DATE ?? projectStart;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

function fail(message) {
  throw new Error(message);
}

if (connectionString === undefined || connectionString.length === 0) {
  fail("DATABASE_URL is required");
}
const target = new URL(connectionString);
if (target.protocol !== "postgres:" && target.protocol !== "postgresql:") {
  fail("DATABASE_URL must use PostgreSQL");
}
if (issuer === undefined || issuer.length === 0) {
  fail("OIDC_ISSUER is required");
}
const issuerUrl = new URL(issuer);
const loopback = issuerUrl.hostname === "localhost" || issuerUrl.hostname === "127.0.0.1";
if (issuerUrl.protocol !== "https:" && !(issuerUrl.protocol === "http:" && loopback)) {
  fail("OIDC_ISSUER must use HTTPS");
}
if (email === undefined || email.trim().length === 0) {
  fail("ADMIN_EMAIL is required");
}
if (subject === undefined || subject.trim().length === 0) {
  fail("ADMIN_SUBJECT (or ADMIN_EMAIL) is required");
}
if (displayName === undefined || displayName.trim().length === 0) {
  fail("ADMIN_DISPLAY_NAME (or ADMIN_EMAIL) must not be blank");
}
for (const [name, value] of [
  ["TENANT_ID", tenantId],
  ["PROJECT_ID", projectId],
  ["ADMIN_PRINCIPAL_ID", principalId],
]) {
  if (!UUID.test(value)) fail(`${name} must be a UUID`);
}
for (const [name, value] of [
  ["PROJECT_START", projectStart],
  ["STATUS_DATE", statusDate],
]) {
  if (!ISO_DATE.test(value)) fail(`${name} must be an ISO date (YYYY-MM-DD)`);
}
if (statusDate < projectStart) {
  fail("STATUS_DATE must not be before PROJECT_START");
}

const plan = {
  tenant: { id: tenantId, name: tenantName },
  wbs: { id: projectId, name: projectName, projectStart, statusDate },
  principal: { id: principalId, issuer, subject, type: "HUMAN", displayName },
  tenantMembership: { role: "OWNER" },
  projectMembership: { role: "OWNER", on: "wbs.project_id" },
};

console.log(
  JSON.stringify({
    event: "seed_admin_plan",
    dryRun,
    database: `${target.protocol}//${target.host}${target.pathname}`,
    plan,
  }),
);

if (dryRun) {
  console.log(JSON.stringify({ event: "seed_admin_dry_run_complete" }));
} else if (!process.execArgv.includes("--experimental-transform-types")) {
  // ProjectRepository is TypeScript with a parameter property. Re-exec so a
  // caller that launches this file with plain `node` still reaches it.
  const child = spawnSync(
    process.execPath,
    ["--experimental-transform-types", ...process.argv.slice(1)],
    { stdio: "inherit", env: process.env },
  );
  process.exit(child.status ?? 1);
} else {
  register(
    `data:text/javascript,${encodeURIComponent(`
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
`)}`,
  );
  const { ProjectRepository, createPersistenceDatabase, migratePersistenceDatabase } = await import(
    "../src/index.ts"
  );

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await migratePersistenceDatabase(client);

    const existing = await client.query({
      text: "select project_id from wbs where tenant_id = $1 and id = $2",
      values: [tenantId, projectId],
    });
    if (existing.rowCount === 0) {
      const tenant = await client.query({
        text: "select 1 from tenant where id = $1",
        values: [tenantId],
      });
      if (tenant.rowCount > 0) {
        fail("tenant exists without this WBS; refusing to invent a second project graph");
      }
      await new ProjectRepository(createPersistenceDatabase(client)).save({
        tenant: { id: tenantId, name: tenantName },
        project: {
          id: projectId,
          tenantId,
          name: projectName,
          currency: "JPY",
          timezone: "Asia/Tokyo",
          projectStart,
          statusDate,
          defaultCalendarId: "standard",
          revision: 1n,
          nextTaskSeq: 1,
          nextBaselineVersion: 1,
        },
        calendars: [],
        members: [],
        processes: [],
        products: [],
        templates: [],
        tasks: [],
        dependencies: [],
        auditEvents: [],
      });
    }

    const parent = await client.query({
      text: "select project_id from wbs where tenant_id = $1 and id = $2",
      values: [tenantId, projectId],
    });
    const parentProjectId = parent.rows[0]?.project_id;
    if (parentProjectId === undefined) fail("WBS was not created");

    await client.query("begin");
    try {
      await client.query({
        text: "insert into tenant (id, name) values ($1, $2) on conflict (id) do update set name = excluded.name",
        values: [tenantId, tenantName],
      });
      await client.query({
        text: `update wbs
                  set name = $3, project_start = $4, status_date = $5
                where tenant_id = $1 and id = $2`,
        values: [tenantId, projectId, projectName, projectStart, statusDate],
      });
      const principal = await client.query({
        text: `insert into principal (id, issuer, subject, type, display_name, allowed_scopes)
               values ($1, $2, $3, 'HUMAN', $4, '{}'::text[])
               on conflict (issuer, subject) do update set display_name = excluded.display_name
               returning id`,
        values: [principalId, issuer, subject, displayName],
      });
      const resolvedPrincipalId = principal.rows[0].id;
      await client.query({
        text: `insert into tenant_membership (tenant_id, principal_id, role)
               values ($1, $2, 'OWNER')
               on conflict (tenant_id, principal_id) do update set role = 'OWNER'`,
        values: [tenantId, resolvedPrincipalId],
      });
      // Membership is on the WBS's parent project, the id 0010 assigned, not
      // the WBS id. A grant already on that parent is raised to OWNER.
      await client.query({
        text: `insert into project_membership (tenant_id, project_id, principal_id, role)
               values ($1, $2, $3, 'OWNER')
               on conflict (tenant_id, project_id, principal_id) do update set role = 'OWNER'`,
        values: [tenantId, parentProjectId, resolvedPrincipalId],
      });
      await client.query("commit");
      console.log(
        JSON.stringify({
          event: "seed_admin_complete",
          tenantId,
          projectId,
          parentProjectId,
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
}
