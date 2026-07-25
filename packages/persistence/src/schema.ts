import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const dependencyType = pgEnum("dependency_type", ["FS", "SS", "FF", "SF"]);

export const auditActorType = pgEnum("audit_actor_type", ["HUMAN", "AGENT", "SYSTEM"]);
export const principalType = pgEnum("principal_type", ["HUMAN", "AGENT"]);
export const tenantRole = pgEnum("tenant_role", ["OWNER", "ADMIN", "MEMBER"]);
export const projectRole = pgEnum("project_role", ["OWNER", "EDITOR", "VIEWER"]);

const auditTimestamp = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string", precision: 6 });

export const principals = pgTable(
  "principals",
  {
    id: uuid().primaryKey().defaultRandom(),
    issuer: text().notNull(),
    subject: text().notNull(),
    type: principalType().notNull(),
    displayName: text("display_name").notNull(),
    allowedScopes: text("allowed_scopes").array().notNull().default(sql`array[]::text[]`),
    disabledAt: auditTimestamp("disabled_at"),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("principals_issuer_subject_unique").on(table.issuer, table.subject),
    check("principals_issuer_not_blank", sql`length(trim(${table.issuer})) > 0`),
    check("principals_subject_not_blank", sql`length(trim(${table.subject})) > 0`),
    check("principals_display_name_not_blank", sql`length(trim(${table.displayName})) > 0`),
    check(
      "principals_allowed_scopes_known",
      sql`${table.allowedScopes} <@ array['project:progress:write', 'project:actuals:write']::text[]`,
    ),
    check(
      "principals_human_scopes_empty",
      sql`${table.type} <> 'HUMAN' or cardinality(${table.allowedScopes}) = 0`,
    ),
  ],
);

export const tenants = pgTable("tenants", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  createdAt: auditTimestamp("created_at").notNull().defaultNow(),
});

export const tenantMemberships = pgTable(
  "tenant_memberships",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    role: tenantRole().notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.principalId] }),
    index("tenant_memberships_principal_idx").on(table.principalId),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    name: text().notNull(),
    currency: char({ length: 3 }).notNull().default("JPY"),
    timezone: text().notNull().default("Asia/Tokyo"),
    projectStart: date("project_start", { mode: "string" }).notNull(),
    statusDate: date("status_date", { mode: "string" }).notNull(),
    defaultCalendarId: text("default_calendar_id").notNull().default("standard"),
    revision: bigint({ mode: "bigint" }).notNull().default(sql`0`),
    // Per-project counter for the immutable display No. (Design 0003 §F-1). A new
    // task takes the current value as its `seq`; the counter then advances, so
    // numbers are never reused even after a delete (gaps are expected). A
    // transactional column counter — advanced under the project row lock the
    // command UoW already holds — is simpler and safer here than a PG sequence.
    nextTaskSeq: integer("next_task_seq").notNull().default(1),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
    updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("projects_tenant_id_id_unique").on(table.tenantId, table.id),
    index("projects_tenant_id_idx").on(table.tenantId),
    check("projects_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check("projects_currency_uppercase", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check("projects_revision_non_negative", sql`${table.revision} >= 0`),
    check("projects_next_task_seq_positive", sql`${table.nextTaskSeq} >= 1`),
    check("projects_status_after_start", sql`${table.statusDate} >= ${table.projectStart}`),
  ],
);

export const projectCalendars = pgTable(
  "project_calendars",
  {
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    id: text().notNull(),
    name: text().notNull(),
    workingWeekdays: integer("working_weekdays").array().notNull(),
    nonWorkingDates: date("non_working_dates", { mode: "string" }).array().notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
    updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.id] }),
    foreignKey({
      name: "project_calendars_project_fk",
      columns: [table.tenantId, table.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }).onDelete("cascade"),
    check("project_calendars_id_not_blank", sql`length(trim(${table.id})) > 0`),
    check("project_calendars_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check(
      "project_calendars_working_weekdays_known",
      sql`cardinality(${table.workingWeekdays}) > 0 and ${table.workingWeekdays} <@ array[1,2,3,4,5,6,7]::integer[]`,
    ),
  ],
);

export const members = pgTable(
  "members",
  {
    id: uuid().defaultRandom().notNull(),
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    name: text().notNull(),
    calendarId: text("calendar_id").notNull(),
    dailyCapacityMinutes: integer("daily_capacity_minutes").notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
    updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.id] }),
    foreignKey({
      name: "members_project_fk",
      columns: [table.tenantId, table.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "members_calendar_fk",
      columns: [table.tenantId, table.projectId, table.calendarId],
      foreignColumns: [projectCalendars.tenantId, projectCalendars.projectId, projectCalendars.id],
    }).onDelete("restrict"),
    check("members_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check("members_daily_capacity_range", sql`${table.dailyCapacityMinutes} between 1 and 1440`),
  ],
);

export const processes = pgTable(
  "processes",
  {
    id: uuid().defaultRandom().notNull(),
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    name: text().notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
    updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.id] }),
    foreignKey({
      name: "processes_project_fk",
      columns: [table.tenantId, table.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }).onDelete("cascade"),
    check("processes_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check("processes_sort_order_non_negative", sql`${table.sortOrder} >= 0`),
  ],
);

export const products = pgTable(
  "products",
  {
    id: uuid().defaultRandom().notNull(),
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    name: text().notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
    updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.id] }),
    foreignKey({
      name: "products_project_fk",
      columns: [table.tenantId, table.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }).onDelete("cascade"),
    check("products_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check("products_sort_order_non_negative", sql`${table.sortOrder} >= 0`),
  ],
);

export const subtaskTemplates = pgTable(
  "subtask_templates",
  {
    id: uuid().defaultRandom().notNull(),
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    name: text().notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    subtasks: jsonb().notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
    updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.id] }),
    foreignKey({
      name: "subtask_templates_project_fk",
      columns: [table.tenantId, table.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }).onDelete("cascade"),
    check("subtask_templates_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check("subtask_templates_sort_order_non_negative", sql`${table.sortOrder} >= 0`),
  ],
);

export const projectMemberships = pgTable(
  "project_memberships",
  {
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    principalId: uuid("principal_id").notNull(),
    role: projectRole().notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId, table.principalId] }),
    index("project_memberships_principal_idx").on(table.principalId),
    foreignKey({
      name: "project_memberships_project_fk",
      columns: [table.tenantId, table.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "project_memberships_tenant_membership_fk",
      columns: [table.tenantId, table.principalId],
      foreignColumns: [tenantMemberships.tenantId, tenantMemberships.principalId],
    }).onDelete("cascade"),
  ],
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    parentTaskId: uuid("parent_task_id"),
    sortOrder: integer("sort_order").notNull().default(0),
    // Immutable per-project display No. (Design 0003 §F-1), assigned from the
    // project's `nextTaskSeq` at creation and never renumbered on reorder/delete
    // (gaps allowed). Tasks and subtasks share this one per-project sequence. The
    // internal key stays the task UUID; `seq` is a display number only.
    seq: integer().notNull(),
    name: text().notNull(),
    processId: uuid("process_id"),
    productId: uuid("product_id"),
    note: text().notNull().default(""),
    contract: text().notNull().default(""),
    assigneeMemberId: uuid("assignee_member_id"),
    plannedEffortMinutes: integer("planned_effort_minutes").notNull().default(0),
    progressBasisPoints: integer("progress_basis_points").notNull().default(0),
    actualEffortMinutes: integer("actual_effort_minutes").notNull().default(0),
    prorationWeightBp: integer("proration_weight_bp"),
    dailyPlan: jsonb("daily_plan").notNull().default(sql`'{}'::jsonb`),
    actualStart: date("actual_start", { mode: "string" }),
    actualFinish: date("actual_finish", { mode: "string" }),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
    updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("tasks_tenant_project_id_unique").on(table.tenantId, table.projectId, table.id),
    unique("tasks_tenant_project_seq_unique").on(table.tenantId, table.projectId, table.seq),
    index("tasks_parent_idx").on(table.tenantId, table.projectId, table.parentTaskId),
    index("tasks_sort_order_idx").on(table.tenantId, table.projectId, table.sortOrder),
    foreignKey({
      name: "tasks_project_fk",
      columns: [table.tenantId, table.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "tasks_parent_fk",
      columns: [table.tenantId, table.projectId, table.parentTaskId],
      foreignColumns: [table.tenantId, table.projectId, table.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "tasks_assignee_fk",
      columns: [table.tenantId, table.projectId, table.assigneeMemberId],
      foreignColumns: [members.tenantId, members.projectId, members.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "tasks_process_fk",
      columns: [table.tenantId, table.projectId, table.processId],
      foreignColumns: [processes.tenantId, processes.projectId, processes.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "tasks_product_fk",
      columns: [table.tenantId, table.projectId, table.productId],
      foreignColumns: [products.tenantId, products.projectId, products.id],
    }).onDelete("restrict"),
    check("tasks_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check("tasks_sort_order_non_negative", sql`${table.sortOrder} >= 0`),
    check("tasks_seq_positive", sql`${table.seq} >= 1`),
    check("tasks_planned_effort_non_negative", sql`${table.plannedEffortMinutes} >= 0`),
    check("tasks_actual_effort_non_negative", sql`${table.actualEffortMinutes} >= 0`),
    check(
      "tasks_progress_range",
      sql`${table.progressBasisPoints} between 0 and 10000`,
    ),
    check(
      "tasks_proration_weight_range",
      sql`${table.prorationWeightBp} is null or ${table.prorationWeightBp} between 0 and 10000`,
    ),
    check(
      "tasks_not_own_parent",
      sql`${table.parentTaskId} is null or ${table.parentTaskId} <> ${table.id}`,
    ),
    check(
      "tasks_actual_dates_ordered",
      sql`${table.actualStart} is null or ${table.actualFinish} is null or ${table.actualFinish} >= ${table.actualStart}`,
    ),
  ],
);

export const taskDependencies = pgTable(
  "task_dependencies",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    predecessorTaskId: uuid("predecessor_task_id").notNull(),
    successorTaskId: uuid("successor_task_id").notNull(),
    type: dependencyType().notNull().default("FS"),
    lagWorkingDays: integer("lag_working_days").notNull().default(0),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("task_dependencies_edge_unique").on(
      table.tenantId,
      table.projectId,
      table.predecessorTaskId,
      table.successorTaskId,
      table.type,
    ),
    index("task_dependencies_successor_idx").on(
      table.tenantId,
      table.projectId,
      table.successorTaskId,
    ),
    foreignKey({
      name: "task_dependencies_predecessor_fk",
      columns: [table.tenantId, table.projectId, table.predecessorTaskId],
      foreignColumns: [tasks.tenantId, tasks.projectId, tasks.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "task_dependencies_successor_fk",
      columns: [table.tenantId, table.projectId, table.successorTaskId],
      foreignColumns: [tasks.tenantId, tasks.projectId, tasks.id],
    }).onDelete("cascade"),
    check(
      "task_dependencies_distinct_tasks",
      sql`${table.predecessorTaskId} <> ${table.successorTaskId}`,
    ),
    check("task_dependencies_lag_non_negative", sql`${table.lagWorkingDays} >= 0`),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    sequence: bigserial({ mode: "bigint" }).primaryKey(),
    id: uuid().notNull().defaultRandom().unique(),
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    projectRevision: bigint("project_revision", { mode: "bigint" }).notNull(),
    actorType: auditActorType("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    commandType: text("command_type").notNull(),
    payload: jsonb().notNull(),
    occurredAt: auditTimestamp("occurred_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("audit_events_project_revision_unique").on(
      table.tenantId,
      table.projectId,
      table.projectRevision,
    ),
    foreignKey({
      name: "audit_events_project_fk",
      columns: [table.tenantId, table.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }).onDelete("restrict"),
    check("audit_events_revision_positive", sql`${table.projectRevision} > 0`),
    check("audit_events_actor_id_not_blank", sql`length(trim(${table.actorId})) > 0`),
    check("audit_events_command_type_not_blank", sql`length(trim(${table.commandType})) > 0`),
  ],
);

export const commandReceipts = pgTable(
  "command_receipts",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: char("request_hash", { length: 64 }).notNull(),
    resultRevision: bigint("result_revision", { mode: "bigint" }).notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("command_receipts_project_key_unique").on(
      table.tenantId,
      table.projectId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: "command_receipts_project_fk",
      columns: [table.tenantId, table.projectId],
      foreignColumns: [projects.tenantId, projects.id],
    }).onDelete("restrict"),
    check(
      "command_receipts_idempotency_key_length",
      sql`length(trim(${table.idempotencyKey})) between 1 and 200`,
    ),
    check("command_receipts_request_hash_hex", sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
    check("command_receipts_revision_positive", sql`${table.resultRevision} > 0`),
  ],
);

export const schema = {
  principals,
  tenants,
  tenantMemberships,
  projects,
  projectCalendars,
  members,
  processes,
  products,
  subtaskTemplates,
  projectMemberships,
  tasks,
  taskDependencies,
  auditEvents,
  commandReceipts,
};
