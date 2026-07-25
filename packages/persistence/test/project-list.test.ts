import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceDatabase,
  migratePersistenceDatabase,
  PostgresProjectListReader,
} from "../src/index.js";

const TENANT_ID = "20000000-0000-4000-8000-000000000001";
const PRINCIPAL_ID = "90000000-0000-4000-8000-000000000001";
const OTHER_PRINCIPAL_ID = "90000000-0000-4000-8000-000000000002";
const ALPHA_ID = "10000000-0000-4000-8000-00000000000b";
const BETA_ID = "10000000-0000-4000-8000-00000000000c";
const GAMMA_ID = "10000000-0000-4000-8000-00000000000a";

describe("PostgresProjectListReader", () => {
  const container = new PostgreSqlContainer("postgres:17.6-alpine");
  let client: Client;
  let reader: PostgresProjectListReader;
  let stopContainer: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const started = await container.start();
    stopContainer = async () => started.stop().then(() => undefined);
    client = new Client({ connectionString: started.getConnectionUri() });
    await client.connect();
    await migratePersistenceDatabase(client);
    reader = new PostgresProjectListReader(createPersistenceDatabase(client));
  }, 60_000);

  beforeEach(async () => {
    await client.query("truncate table principals, tenants cascade");
    await client.query("insert into tenants (id, name) values ($1, 'Tenant 1')", [
      TENANT_ID,
    ]);
    // Three synthetic projects, inserted out of alphabetical order to prove the
    // reader sorts by name.
    await client.query(
      `insert into projects (id, tenant_id, name, project_start, status_date) values
         ($1, $4, 'Gamma project', '2026-07-13', '2026-07-13'),
         ($2, $4, 'Alpha project', '2026-07-13', '2026-07-13'),
         ($3, $4, 'Beta project',  '2026-07-13', '2026-07-13')`,
      [GAMMA_ID, ALPHA_ID, BETA_ID, TENANT_ID],
    );
    await client.query(
      `insert into principals (id, issuer, subject, type, display_name) values
         ($1, 'https://identity.example.test/', 'principal-1', 'HUMAN', 'Principal 1'),
         ($2, 'https://identity.example.test/', 'principal-2', 'HUMAN', 'Principal 2')`,
      [PRINCIPAL_ID, OTHER_PRINCIPAL_ID],
    );
    await client.query(
      `insert into tenant_memberships (tenant_id, principal_id, role) values
         ($1, $2, 'MEMBER'), ($1, $3, 'MEMBER')`,
      [TENANT_ID, PRINCIPAL_ID, OTHER_PRINCIPAL_ID],
    );
    // The principal is a member of 2 of the 3 projects (Alpha, Gamma), not Beta.
    await client.query(
      `insert into project_memberships (tenant_id, project_id, principal_id, role) values
         ($1, $2, $4, 'VIEWER'),
         ($1, $3, $4, 'OWNER')`,
      [TENANT_ID, ALPHA_ID, GAMMA_ID, PRINCIPAL_ID],
    );
    // A second principal is a member of Beta only, so the filter must exclude it.
    await client.query(
      `insert into project_memberships (tenant_id, project_id, principal_id, role) values
         ($1, $2, $3, 'EDITOR')`,
      [TENANT_ID, BETA_ID, OTHER_PRINCIPAL_ID],
    );
  });

  afterAll(async () => {
    await client.end();
    await stopContainer?.();
  });

  it("returns exactly the principal's membership projects, with role and name, sorted by name", async () => {
    const result = await reader.listForPrincipal(PRINCIPAL_ID);

    expect(result).toEqual([
      { id: ALPHA_ID, tenantId: TENANT_ID, name: "Alpha project", role: "VIEWER" },
      { id: GAMMA_ID, tenantId: TENANT_ID, name: "Gamma project", role: "OWNER" },
    ]);
  });

  it("returns an empty list for a principal with no project memberships", async () => {
    await client.query(
      `insert into principals (id, issuer, subject, type, display_name)
       values ($1, 'https://identity.example.test/', 'principal-3', 'HUMAN', 'Principal 3')`,
      ["90000000-0000-4000-8000-000000000003"],
    );

    const result = await reader.listForPrincipal(
      "90000000-0000-4000-8000-000000000003",
    );

    expect(result).toEqual([]);
  });

  it("listForIdentity matches the direct (issuer, subject), the email fallback, and their union", async () => {
    // Direct subject match resolves the same set as listForPrincipal.
    const direct = await reader.listForIdentity({
      issuer: "https://identity.example.test/",
      subject: "principal-1",
      scopes: [],
    });
    expect(direct).toEqual([
      { id: ALPHA_ID, tenantId: TENANT_ID, name: "Alpha project", role: "VIEWER" },
      { id: GAMMA_ID, tenantId: TENANT_ID, name: "Gamma project", role: "OWNER" },
    ]);

    // A principal seeded before its provider subject is known is keyed as
    // `email:<addr>`; with no direct match it resolves through the email key alone
    // (ADR 0012 Step 5a).
    const emailPrincipalId = "90000000-0000-4000-8000-0000000000ee";
    await client.query(
      `insert into principals (id, issuer, subject, type, display_name)
       values ($1, 'https://identity.example.test/', 'email:seed@example.test', 'HUMAN', 'Seeded by email')`,
      [emailPrincipalId],
    );
    await client.query(
      "insert into tenant_memberships (tenant_id, principal_id, role) values ($1, $2, 'MEMBER')",
      [TENANT_ID, emailPrincipalId],
    );
    await client.query(
      `insert into project_memberships (tenant_id, project_id, principal_id, role)
       values ($1, $2, $3, 'EDITOR')`,
      [TENANT_ID, BETA_ID, emailPrincipalId],
    );

    const viaEmail = await reader.listForIdentity({
      issuer: "https://identity.example.test/",
      subject: "unknown-provider-subject",
      email: "seed@example.test",
      scopes: [],
    });
    expect(viaEmail).toEqual([
      { id: BETA_ID, tenantId: TENANT_ID, name: "Beta project", role: "EDITOR" },
    ]);

    // When the identity has BOTH a direct-subject principal and an email-keyed
    // principal, the reader returns the UNION (deduped by project) so the email
    // principal's Beta membership — writable per-project via the resolver's
    // fallback — is not absent from the list. Sorted by name.
    const union = await reader.listForIdentity({
      issuer: "https://identity.example.test/",
      subject: "principal-1",
      email: "seed@example.test",
      scopes: [],
    });
    expect(union).toEqual([
      { id: ALPHA_ID, tenantId: TENANT_ID, name: "Alpha project", role: "VIEWER" },
      { id: BETA_ID, tenantId: TENANT_ID, name: "Beta project", role: "EDITOR" },
      { id: GAMMA_ID, tenantId: TENANT_ID, name: "Gamma project", role: "OWNER" },
    ]);
  });

  it("listForIdentity dedups a project shared by the direct and email principals, direct role winning", async () => {
    // The email-keyed principal is a member of Gamma too (where the direct subject
    // is OWNER) with a DIFFERENT role, plus Beta which only it can see. The union
    // must contain Gamma exactly once, carrying the direct-subject role (OWNER) —
    // mirroring the resolver's per-project "direct subject, else email" precedence.
    const emailPrincipalId = "90000000-0000-4000-8000-0000000000ef";
    await client.query(
      `insert into principals (id, issuer, subject, type, display_name)
       values ($1, 'https://identity.example.test/', 'email:seed@example.test', 'HUMAN', 'Seeded by email')`,
      [emailPrincipalId],
    );
    await client.query(
      "insert into tenant_memberships (tenant_id, principal_id, role) values ($1, $2, 'MEMBER')",
      [TENANT_ID, emailPrincipalId],
    );
    await client.query(
      `insert into project_memberships (tenant_id, project_id, principal_id, role) values
         ($1, $2, $4, 'EDITOR'),
         ($1, $3, $4, 'VIEWER')`,
      [TENANT_ID, BETA_ID, GAMMA_ID, emailPrincipalId],
    );

    const union = await reader.listForIdentity({
      issuer: "https://identity.example.test/",
      subject: "principal-1",
      email: "seed@example.test",
      scopes: [],
    });
    expect(union).toEqual([
      { id: ALPHA_ID, tenantId: TENANT_ID, name: "Alpha project", role: "VIEWER" },
      { id: BETA_ID, tenantId: TENANT_ID, name: "Beta project", role: "EDITOR" },
      // Deduped: Gamma appears once, with the DIRECT subject's OWNER (not the
      // email principal's VIEWER).
      { id: GAMMA_ID, tenantId: TENANT_ID, name: "Gamma project", role: "OWNER" },
    ]);
  });
});
