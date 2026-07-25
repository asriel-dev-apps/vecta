import {
  createProjectCommandAuthorizer,
  ProjectAccessDeniedError,
} from "@vecta/application";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceDatabase,
  demoProjectRecord,
  migratePersistenceDatabase,
  PostgresProjectAccessGrantResolver,
  ProjectAccessRepository,
  ProjectRepository,
} from "../src/index.js";

describe("PostgreSQL project access", () => {
  const container = new PostgreSqlContainer("postgres:17.6-alpine");
  let client: Client;
  let accessRepository: ProjectAccessRepository;
  let authorizer: ReturnType<typeof createProjectCommandAuthorizer>;
  let stopContainer: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const started = await container.start();
    stopContainer = async () => started.stop().then(() => undefined);
    client = new Client({ connectionString: started.getConnectionUri() });
    await client.connect();
    await migratePersistenceDatabase(client);
    const database = createPersistenceDatabase(client);
    accessRepository = new ProjectAccessRepository(database);
    authorizer = createProjectCommandAuthorizer(
      new PostgresProjectAccessGrantResolver(database),
    );
  }, 60_000);

  beforeEach(async () => {
    await client.query("truncate table principals, tenants cascade");
    await new ProjectRepository(createPersistenceDatabase(client)).save(demoProjectRecord);
  });

  afterAll(async () => {
    await client.end();
    await stopContainer?.();
  });

  it("resolves a provisioned human project editor to an internal audit actor", async () => {
    await accessRepository.provision({
      principal: {
        id: "90000000-0000-4000-8000-000000000001",
        issuer: "https://identity.example.test/",
        subject: "human-editor",
        type: "HUMAN",
        displayName: "Human editor",
        allowedScopes: [],
      },
      tenantId: demoProjectRecord.tenant.id,
      tenantRole: "MEMBER",
      projectId: demoProjectRecord.project.id,
      projectRole: "EDITOR",
    });

    await expect(
      authorizer.authorize({
        identity: {
          issuer: "https://identity.example.test/",
          subject: "human-editor",
          scopes: [],
        },
        tenantId: demoProjectRecord.tenant.id,
        projectId: demoProjectRecord.project.id,
        command: {
          type: "task.update",
          taskId: demoProjectRecord.tasks[0]!.id,
          changes: { name: "New name" },
        },
      }),
    ).resolves.toEqual({
      type: "HUMAN",
      id: "90000000-0000-4000-8000-000000000001",
    });
  });

  it("resolves a principal keyed by verified email through the email fallback", async () => {
    // A principal seeded before its provider subject is known (keyed `email:<addr>`).
    // The token surface passes the verified email so the resolver's fallback grants
    // access even though the provider subject matches nothing directly (ADR 0012 Step 5a).
    await accessRepository.provision({
      principal: {
        id: "90000000-0000-4000-8000-0000000000ee",
        issuer: "https://identity.example.test/",
        subject: "email:seed@example.test",
        type: "HUMAN",
        displayName: "Seeded by email",
        allowedScopes: [],
      },
      tenantId: demoProjectRecord.tenant.id,
      tenantRole: "MEMBER",
      projectId: demoProjectRecord.project.id,
      projectRole: "EDITOR",
    });

    await expect(
      authorizer.authorize({
        identity: {
          issuer: "https://identity.example.test/",
          subject: "unknown-provider-subject",
          email: "seed@example.test",
          scopes: [],
        },
        tenantId: demoProjectRecord.tenant.id,
        projectId: demoProjectRecord.project.id,
        command: {
          type: "task.update",
          taskId: demoProjectRecord.tasks[0]!.id,
          changes: { name: "New name" },
        },
      }),
    ).resolves.toEqual({
      type: "HUMAN",
      id: "90000000-0000-4000-8000-0000000000ee",
    });
  });

  it("does not resolve a membership through a different tenant path", async () => {
    await accessRepository.provision({
      principal: {
        id: "90000000-0000-4000-8000-000000000001",
        issuer: "https://identity.example.test/",
        subject: "human-editor",
        type: "HUMAN",
        displayName: "Human editor",
        allowedScopes: [],
      },
      tenantId: demoProjectRecord.tenant.id,
      tenantRole: "MEMBER",
      projectId: demoProjectRecord.project.id,
      projectRole: "EDITOR",
    });

    await expect(
      authorizer.authorize({
        identity: {
          issuer: "https://identity.example.test/",
          subject: "human-editor",
          scopes: [],
        },
        tenantId: "00000000-0000-4000-8000-000000000099",
        projectId: demoProjectRecord.project.id,
        command: {
          type: "task.delete",
          taskId: demoProjectRecord.tasks[0]!.id,
        },
      }),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);
  });

  it("grants the same external human identity access in another tenant", async () => {
    const principal = {
      id: "90000000-0000-4000-8000-000000000001",
      issuer: "https://identity.example.test/",
      subject: "multi-tenant-human",
      type: "HUMAN" as const,
      displayName: "Multi-tenant human",
      allowedScopes: [] as const,
    };
    await accessRepository.provision({
      principal,
      tenantId: demoProjectRecord.tenant.id,
      tenantRole: "MEMBER",
      projectId: demoProjectRecord.project.id,
      projectRole: "EDITOR",
    });
    const secondTenantId = "00000000-0000-4000-8000-000000000099";
    const secondProjectId = "10000000-0000-4000-8000-000000000099";
    await client.query("insert into tenants (id, name) values ($1, 'Second tenant')", [
      secondTenantId,
    ]);
    await client.query("begin");
    await client.query(
      `insert into projects (id, tenant_id, name, project_start, status_date)
       values ($1, $2, 'Second project', '2026-07-13', '2026-07-13')`,
      [secondProjectId, secondTenantId],
    );
    await client.query(
      `insert into project_calendars
         (tenant_id, project_id, id, name, working_weekdays, non_working_dates)
       values ($1, $2, 'standard', 'Standard', array[1,2,3,4,5], array[]::date[])`,
      [secondTenantId, secondProjectId],
    );
    await client.query("commit");

    await accessRepository.provision({
      principal,
      tenantId: secondTenantId,
      tenantRole: "MEMBER",
      projectId: secondProjectId,
      projectRole: "OWNER",
    });

    await expect(
      authorizer.authorize({
        identity: {
          issuer: principal.issuer,
          subject: principal.subject,
          scopes: [],
        },
        tenantId: secondTenantId,
        projectId: secondProjectId,
        command: { type: "task.delete", taskId: "task-1" },
      }),
    ).resolves.toEqual({ type: "HUMAN", id: principal.id });
  });
});
