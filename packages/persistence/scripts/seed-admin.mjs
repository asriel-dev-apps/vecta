import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

// One-off seed for an authenticated deployment: creates a single tenant, a
// single project, and one admin principal bound as OWNER on both, so a human who
// signs in with the configured OIDC provider resolves to a PRIVILEGED grant.
//
// Every identity value is read from the environment — no real email, subject, or
// connection string is written here. Applies the existing migrations first, then
// upserts the five rows idempotently, so re-running is safe. Pass `--dry-run` to
// validate the parameters and print the plan without connecting.
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
  project: { id: projectId, name: projectName, projectStart, statusDate },
  principal: { id: principalId, issuer, subject, type: "HUMAN", displayName },
  tenantMembership: { role: "OWNER" },
  projectMembership: { role: "OWNER" },
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
} else {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await migrate(drizzle(client), {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });

    await client.query("begin");
    try {
      await client.query({
        text: "insert into tenant (id, name) values ($1, $2) on conflict (id) do update set name = excluded.name",
        values: [tenantId, tenantName],
      });
      await client.query({
        text: `insert into project (id, tenant_id, name)
               values ($1, $2, $3)
               on conflict (id) do update set name = excluded.name`,
        values: [projectId, tenantId, projectName],
      });
      await client.query({
        text: `insert into wbs (id, tenant_id, project_id, name, project_start, status_date)
               values ($1, $2, $1, $3, $4, $5)
               on conflict (id) do update set
                 name = excluded.name,
                 project_start = excluded.project_start,
                 status_date = excluded.status_date`,
        values: [projectId, tenantId, projectName, projectStart, statusDate],
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
      await client.query({
        text: `insert into project_membership (tenant_id, project_id, principal_id, role)
               values ($1, $2, $3, 'OWNER')
               on conflict (tenant_id, project_id, principal_id) do update set role = 'OWNER'`,
        values: [tenantId, projectId, resolvedPrincipalId],
      });
      await client.query("commit");
      console.log(
        JSON.stringify({
          event: "seed_admin_complete",
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
}
