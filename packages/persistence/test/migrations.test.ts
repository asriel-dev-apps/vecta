import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migratePersistenceDatabase } from "../src/index.js";

describe("persistence migrations", () => {
  const container = new PostgreSqlContainer("postgres:17.6-alpine");
  let client: Client;
  let stopContainer: (() => Promise<void>) | undefined;

  const tenantId = "00000000-0000-4000-8000-000000000001";
  const projectId = "10000000-0000-4000-8000-000000000001";
  const memberId = "c0000000-0000-4000-8000-000000000001";
  const taskId = "d0000000-0000-4000-8000-000000000001";

  beforeAll(async () => {
    const started = await container.start();
    stopContainer = async () => started.stop().then(() => undefined);
    client = new Client({ connectionString: started.getConnectionUri() });
    await client.connect();
    await migratePersistenceDatabase(client);

    await client.query("insert into tenants (id, name) values ($1, 'Tenant A')", [tenantId]);
    await client.query("begin");
    await client.query(
      `insert into projects (id, tenant_id, name, project_start, status_date)
       values ($1, $2, 'Project A', '2026-01-05', '2026-01-20')`,
      [projectId, tenantId],
    );
    await client.query(
      `insert into project_calendars
         (tenant_id, project_id, id, name, working_weekdays, non_working_dates)
       values ($1, $2, 'standard', 'Standard', array[1,2,3,4,5], array[]::date[])`,
      [tenantId, projectId],
    );
    await client.query("commit");
    await client.query(
      `insert into members (id, tenant_id, project_id, name, calendar_id, daily_capacity_minutes)
       values ($1, $2, $3, 'Member 01', 'standard', 480)`,
      [memberId, tenantId, projectId],
    );
    await client.query(
      `insert into tasks (id, tenant_id, project_id, name, seq, planned_effort_minutes, progress_basis_points)
       values ($1, $2, $3, 'Subtask', 1, 480, 5000)`,
      [taskId, tenantId, projectId],
    );
  }, 60_000);

  afterAll(async () => {
    await client.end();
    await stopContainer?.();
  });

  it("applies the effort-first schema to an empty PostgreSQL database", async () => {
    const result = await client.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    expect(result.rows.map((row) => row.table_name)).toEqual([
      "audit_events",
      "command_receipts",
      "members",
      "principals",
      "processes",
      "products",
      "project_calendars",
      "project_memberships",
      "projects",
      "subtask_templates",
      "task_dependencies",
      "tasks",
      "tenant_memberships",
      "tenants",
    ]);
  });

  it("rejects a human principal that carries agent scopes", async () => {
    await expect(
      client.query(
        `insert into principals (issuer, subject, type, display_name, allowed_scopes)
         values ('https://identity.example.test/', 'human-with-scope', 'HUMAN',
                 'Invalid human', array['project:progress:write'])`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("enforces project membership boundaries across tenants", async () => {
    const principalId = "90000000-0000-4000-8000-000000000001";
    const otherTenant = "00000000-0000-4000-8000-000000000002";
    await client.query("insert into tenants (id, name) values ($1, 'Tenant B')", [otherTenant]);
    await client.query(
      `insert into principals (id, issuer, subject, type, display_name)
       values ($1, 'https://identity.example.test/', 'bounded-human', 'HUMAN', 'Bounded human')`,
      [principalId],
    );
    await client.query(
      "insert into tenant_memberships (tenant_id, principal_id, role) values ($1, $2, 'MEMBER')",
      [otherTenant, principalId],
    );
    await expect(
      client.query(
        `insert into project_memberships (tenant_id, project_id, principal_id, role)
         values ($1, $2, $3, 'EDITOR')`,
        [tenantId, projectId, principalId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("enforces task effort, progress, parent, and date invariants", async () => {
    // Each insert carries a distinct, non-colliding `seq` (NOT NULL after 0006)
    // so it is rejected on the invariant under test, not the seq column itself.
    await expect(
      client.query(
        "insert into tasks (tenant_id, project_id, name, seq, planned_effort_minutes) values ($1, $2, 'Bad', 101, -1)",
        [tenantId, projectId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query(
        "insert into tasks (tenant_id, project_id, name, seq, progress_basis_points) values ($1, $2, 'Bad', 102, 10001)",
        [tenantId, projectId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query(
        "insert into tasks (id, tenant_id, project_id, name, seq, parent_task_id) values ($3, $1, $2, 'Bad', 103, $3)",
        [tenantId, projectId, "d0000000-0000-4000-8000-000000000099"],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query(
        "insert into tasks (tenant_id, project_id, name, seq, actual_start, actual_finish) values ($1, $2, 'Bad', 104, '2026-02-01', '2026-01-01')",
        [tenantId, projectId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query(
        "insert into tasks (tenant_id, project_id, name, seq, assignee_member_id) values ($1, $2, 'Bad', 105, $3)",
        [tenantId, projectId, "c0000000-0000-4000-8000-0000000000ff"],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      client.query(
        "insert into tasks (tenant_id, project_id, name, seq, proration_weight_bp) values ($1, $2, 'Bad', 106, 10001)",
        [tenantId, projectId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("accepts a null or in-range proration weight from the additive migration", async () => {
    await client.query(
      "insert into tasks (tenant_id, project_id, name, seq, proration_weight_bp) values ($1, $2, 'Weighted subtask', 2, 2500)",
      [tenantId, projectId],
    );
    const weighted = await client.query<{ proration_weight_bp: number | null }>(
      "select proration_weight_bp from tasks where name = 'Weighted subtask'",
    );
    expect(weighted.rows[0]?.proration_weight_bp).toBe(2500);
    const seeded = await client.query<{ proration_weight_bp: number | null }>(
      "select proration_weight_bp from tasks where id = $1",
      [taskId],
    );
    expect(seeded.rows[0]?.proration_weight_bp).toBeNull();
  });

  it("enforces the immutable display-No. column added by 0006 (§F-1)", async () => {
    // seq is NOT NULL after the backfill sets it SET NOT NULL.
    await expect(
      client.query("insert into tasks (tenant_id, project_id, name) values ($1, $2, 'No seq')", [
        tenantId,
        projectId,
      ]),
    ).rejects.toMatchObject({ code: "23502" });
    // seq is unique within (tenant, project): the seed task already holds seq 1.
    await expect(
      client.query(
        "insert into tasks (tenant_id, project_id, name, seq) values ($1, $2, 'Dup seq', 1)",
        [tenantId, projectId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    // The per-project counter must stay >= 1.
    await expect(
      client.query("update projects set next_task_seq = 0 where id = $1", [projectId]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("enforces member capacity and task-dependency invariants", async () => {
    await expect(
      client.query(
        "insert into members (tenant_id, project_id, name, calendar_id, daily_capacity_minutes) values ($1, $2, 'Bad', 'standard', 0)",
        [tenantId, projectId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query(
        `insert into task_dependencies (tenant_id, project_id, predecessor_task_id, successor_task_id)
         values ($1, $2, $3, $3)`,
        [tenantId, projectId, taskId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("enforces process/product master invariants and the task master FKs", async () => {
    const processId = "70000000-0000-4000-8000-000000000001";
    await client.query(
      "insert into processes (id, tenant_id, project_id, name, sort_order) values ($1, $2, $3, 'Phase A', 0)",
      [processId, tenantId, projectId],
    );
    // A task may reference a master row in the same project.
    await client.query(
      "insert into tasks (tenant_id, project_id, name, seq, process_id) values ($1, $2, 'Bound', 3, $3)",
      [tenantId, projectId, processId],
    );
    // A blank master name is rejected.
    await expect(
      client.query(
        "insert into products (tenant_id, project_id, name) values ($1, $2, '  ')",
        [tenantId, projectId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    // A task referencing an unknown process is rejected by the restrict FK.
    await expect(
      client.query(
        "insert into tasks (tenant_id, project_id, name, seq, process_id) values ($1, $2, 'Bad', 107, $3)",
        [tenantId, projectId, "70000000-0000-4000-8000-0000000000ff"],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("keeps audit events append-only and timezone-normalized", async () => {
    await client.query(
      `insert into audit_events
         (tenant_id, project_id, project_revision, actor_type, actor_id, command_type, payload, occurred_at)
       values ($1, $2, 1, 'HUMAN', 'planner@example.test', 'project.seed', '{}',
               '2026-01-05 09:00:00+09')`,
      [tenantId, projectId],
    );
    await client.query("set timezone = 'America/New_York'");
    const auditInstant = await client.query<{ utc_instant: string }>(
      `select to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as utc_instant
       from audit_events where project_id = $1`,
      [projectId],
    );
    expect(auditInstant.rows[0]?.utc_instant).toBe("2026-01-05T00:00:00.000Z");
    await expect(
      client.query("update audit_events set payload = '{\"changed\":true}' where project_id = $1", [
        projectId,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("keeps command receipts immutable", async () => {
    await client.query(
      `insert into command_receipts
         (tenant_id, project_id, idempotency_key, request_hash, result_revision)
       values ($1, $2, 'immutable-key', repeat('0', 64), 1)`,
      [tenantId, projectId],
    );
    await expect(
      client.query("update command_receipts set result_revision = 2 where project_id = $1", [
        projectId,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
  });
});
