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

export const principal = pgTable(
  "principal",
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
    uniqueIndex("principal_issuer_subject_unique").on(table.issuer, table.subject),
    check("principal_issuer_not_blank", sql`length(trim(${table.issuer})) > 0`),
    check("principal_subject_not_blank", sql`length(trim(${table.subject})) > 0`),
    check("principal_display_name_not_blank", sql`length(trim(${table.displayName})) > 0`),
    check(
      "principal_allowed_scopes_known",
      sql`${table.allowedScopes} <@ array['project:progress:write', 'project:actuals:write']::text[]`,
    ),
    check(
      "principal_human_scopes_empty",
      sql`${table.type} <> 'HUMAN' or cardinality(${table.allowedScopes}) = 0`,
    ),
  ],
);

export const tenant = pgTable("tenant", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  createdAt: auditTimestamp("created_at").notNull().defaultNow(),
});

export const tenantMembership = pgTable(
  "tenant_membership",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principal.id, { onDelete: "cascade" }),
    role: tenantRole().notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "tenant_membership_tenant_id_principal_id_pk",
      columns: [table.tenantId, table.principalId],
    }),
    index("tenant_membership_principal_idx").on(table.principalId),
  ],
);

export const project = pgTable(
  "project",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "restrict" }),
    name: text().notNull(),
    // 受注額, column only. Input is outside M1.
    orderAmountMinor: bigint("order_amount_minor", { mode: "bigint" }),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
    updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("project_tenant_id_id_unique").on(table.tenantId, table.id),
    index("project_tenant_id_idx").on(table.tenantId),
    check("project_name_not_blank", sql`length(trim(${table.name})) > 0`),
  ],
);

export const wbs = pgTable(
  "wbs",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "restrict" }),
    projectId: uuid("project_id").notNull(),
    name: text().notNull(),
    tags: text().array().notNull().default(sql`'{}'::text[]`),
    currency: char({ length: 3 }).notNull().default("JPY"),
    timezone: text().notNull().default("Asia/Tokyo"),
    projectStart: date("project_start", { mode: "string" }).notNull(),
    statusDate: date("status_date", { mode: "string" }).notNull(),
    defaultCalendarId: text("default_calendar_id").notNull().default("standard"),
    revision: bigint({ mode: "bigint" }).notNull().default(sql`0`),
    // Per-WBS counter for the immutable display No. (Design 0003 §F-1). A new
    // task takes the current value as its `seq`; the counter then advances, so
    // numbers are never reused even after a delete (gaps are expected). A
    // transactional column counter — advanced under the wbs row lock the
    // command UoW already holds — is simpler and safer here than a PG sequence.
    nextTaskSeq: integer("next_task_seq").notNull().default(1),
    // Per-WBS baseline version counter (Design 0009). Same shape and the same
    // reasoning as `nextTaskSeq`: a transactional column advanced under the
    // wbs row lock the command UoW already holds, rather than a PG sequence.
    nextBaselineVersion: integer("next_baseline_version").notNull().default(1),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
    updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("wbs_tenant_id_id_unique").on(table.tenantId, table.id),
    index("wbs_tenant_id_idx").on(table.tenantId),
    foreignKey({
      name: "wbs_project_fk",
      columns: [table.tenantId, table.projectId],
      foreignColumns: [project.tenantId, project.id],
    }).onDelete("restrict"),
    check("wbs_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check("wbs_currency_uppercase", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check("wbs_revision_non_negative", sql`${table.revision} >= 0`),
    check("wbs_next_task_seq_positive", sql`${table.nextTaskSeq} >= 1`),
    check("wbs_next_baseline_version_positive", sql`${table.nextBaselineVersion} >= 1`),
    check("wbs_status_after_start", sql`${table.statusDate} >= ${table.projectStart}`),
  ],
);

export const calendar = pgTable(
  "calendar",
  {
    tenantId: uuid("tenant_id").notNull(),
    wbsId: uuid("wbs_id").notNull(),
    id: text().notNull(),
    name: text().notNull(),
    workingWeekdays: integer("working_weekdays").array().notNull(),
    nonWorkingDates: date("non_working_dates", { mode: "string" }).array().notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
    updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "calendar_tenant_id_wbs_id_id_pk",
      columns: [table.tenantId, table.wbsId, table.id],
    }),
    foreignKey({
      name: "calendar_wbs_fk",
      columns: [table.tenantId, table.wbsId],
      foreignColumns: [wbs.tenantId, wbs.id],
    }).onDelete("cascade"),
    check("calendar_id_not_blank", sql`length(trim(${table.id})) > 0`),
    check("calendar_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check(
      "calendar_working_weekdays_known",
      sql`cardinality(${table.workingWeekdays}) > 0 and ${table.workingWeekdays} <@ array[1,2,3,4,5,6,7]::integer[]`,
    ),
  ],
);

export const member = pgTable(
  "member",
  {
    id: uuid().defaultRandom().notNull(),
    tenantId: uuid("tenant_id").notNull(),
    wbsId: uuid("wbs_id").notNull(),
    name: text().notNull(),
    calendarId: text("calendar_id").notNull(),
    dailyCapacityMinutes: integer("daily_capacity_minutes").notNull(),
    // Cost rate in the WBS currency's minor unit per person-hour (Design
    // 0010). Nullable on purpose: "not recorded" and "free" are different, and
    // only one of them may be summed.
    costRateMinorPerHour: integer("cost_rate_minor_per_hour"),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
    updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "member_tenant_id_wbs_id_id_pk",
      columns: [table.tenantId, table.wbsId, table.id],
    }),
    foreignKey({
      name: "member_wbs_fk",
      columns: [table.tenantId, table.wbsId],
      foreignColumns: [wbs.tenantId, wbs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "member_calendar_fk",
      columns: [table.tenantId, table.wbsId, table.calendarId],
      foreignColumns: [calendar.tenantId, calendar.wbsId, calendar.id],
    }).onDelete("restrict"),
    check("member_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check("member_daily_capacity_range", sql`${table.dailyCapacityMinutes} between 1 and 1440`),
    check(
      "member_cost_rate_non_negative",
      sql`${table.costRateMinorPerHour} is null or ${table.costRateMinorPerHour} >= 0`,
    ),
  ],
);

export const process = pgTable(
  "process",
  {
    id: uuid().defaultRandom().notNull(),
    tenantId: uuid("tenant_id").notNull(),
    wbsId: uuid("wbs_id").notNull(),
    name: text().notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
    updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "process_tenant_id_wbs_id_id_pk",
      columns: [table.tenantId, table.wbsId, table.id],
    }),
    foreignKey({
      name: "process_wbs_fk",
      columns: [table.tenantId, table.wbsId],
      foreignColumns: [wbs.tenantId, wbs.id],
    }).onDelete("cascade"),
    check("process_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check("process_sort_order_non_negative", sql`${table.sortOrder} >= 0`),
  ],
);

export const product = pgTable(
  "product",
  {
    id: uuid().defaultRandom().notNull(),
    tenantId: uuid("tenant_id").notNull(),
    wbsId: uuid("wbs_id").notNull(),
    name: text().notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
    updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "product_tenant_id_wbs_id_id_pk",
      columns: [table.tenantId, table.wbsId, table.id],
    }),
    foreignKey({
      name: "product_wbs_fk",
      columns: [table.tenantId, table.wbsId],
      foreignColumns: [wbs.tenantId, wbs.id],
    }).onDelete("cascade"),
    check("product_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check("product_sort_order_non_negative", sql`${table.sortOrder} >= 0`),
  ],
);

export const subtaskTemplate = pgTable(
  "subtask_template",
  {
    id: uuid().defaultRandom().notNull(),
    tenantId: uuid("tenant_id").notNull(),
    wbsId: uuid("wbs_id").notNull(),
    name: text().notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    subtasks: jsonb().notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
    updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "subtask_template_tenant_id_wbs_id_id_pk",
      columns: [table.tenantId, table.wbsId, table.id],
    }),
    foreignKey({
      name: "subtask_template_wbs_fk",
      columns: [table.tenantId, table.wbsId],
      foreignColumns: [wbs.tenantId, wbs.id],
    }).onDelete("cascade"),
    check("subtask_template_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check("subtask_template_sort_order_non_negative", sql`${table.sortOrder} >= 0`),
  ],
);

export const projectMembership = pgTable(
  "project_membership",
  {
    tenantId: uuid("tenant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    principalId: uuid("principal_id").notNull(),
    role: projectRole().notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "project_membership_tenant_id_project_id_principal_id_pk",
      columns: [table.tenantId, table.projectId, table.principalId],
    }),
    index("project_membership_principal_idx").on(table.principalId),
    foreignKey({
      name: "project_membership_project_fk",
      columns: [table.tenantId, table.projectId],
      foreignColumns: [project.tenantId, project.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "project_membership_tenant_membership_fk",
      columns: [table.tenantId, table.principalId],
      foreignColumns: [tenantMembership.tenantId, tenantMembership.principalId],
    }).onDelete("cascade"),
  ],
);

export const task = pgTable(
  "task",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    wbsId: uuid("wbs_id").notNull(),
    parentTaskId: uuid("parent_task_id"),
    sortOrder: integer("sort_order").notNull().default(0),
    // Immutable per-WBS display No. (Design 0003 §F-1), assigned from the
    // WBS's `nextTaskSeq` at creation and never renumbered on reorder/delete
    // (gaps allowed). Tasks and subtasks share this one per-WBS sequence. The
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
    // Dated expended effort (Design 0011): `"YYYY-MM-DD|<memberId>"` → minutes.
    // The actuals side's `daily_plan`, and stored the same way for the same
    // reason: the command unit of work rewrites every task row on every command,
    // so anything AC is derived from has to travel with the task or the next
    // unrelated edit writes a stale total back over it.
    datedActuals: jsonb("dated_actuals").notNull().default(sql`'{}'::jsonb`),
    actualStart: date("actual_start", { mode: "string" }),
    actualFinish: date("actual_finish", { mode: "string" }),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
    updatedAt: auditTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("task_tenant_wbs_id_unique").on(table.tenantId, table.wbsId, table.id),
    unique("task_tenant_wbs_seq_unique").on(table.tenantId, table.wbsId, table.seq),
    index("task_parent_idx").on(table.tenantId, table.wbsId, table.parentTaskId),
    index("task_sort_order_idx").on(table.tenantId, table.wbsId, table.sortOrder),
    foreignKey({
      name: "task_wbs_fk",
      columns: [table.tenantId, table.wbsId],
      foreignColumns: [wbs.tenantId, wbs.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "task_parent_fk",
      columns: [table.tenantId, table.wbsId, table.parentTaskId],
      foreignColumns: [table.tenantId, table.wbsId, table.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "task_assignee_fk",
      columns: [table.tenantId, table.wbsId, table.assigneeMemberId],
      foreignColumns: [member.tenantId, member.wbsId, member.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "task_process_fk",
      columns: [table.tenantId, table.wbsId, table.processId],
      foreignColumns: [process.tenantId, process.wbsId, process.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "task_product_fk",
      columns: [table.tenantId, table.wbsId, table.productId],
      foreignColumns: [product.tenantId, product.wbsId, product.id],
    }).onDelete("restrict"),
    check("task_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check("task_sort_order_non_negative", sql`${table.sortOrder} >= 0`),
    check("task_seq_positive", sql`${table.seq} >= 1`),
    check("task_planned_effort_non_negative", sql`${table.plannedEffortMinutes} >= 0`),
    check("task_actual_effort_non_negative", sql`${table.actualEffortMinutes} >= 0`),
    check(
      "task_progress_range",
      sql`${table.progressBasisPoints} between 0 and 10000`,
    ),
    check(
      "task_proration_weight_range",
      sql`${table.prorationWeightBp} is null or ${table.prorationWeightBp} between 0 and 10000`,
    ),
    check(
      "task_not_own_parent",
      sql`${table.parentTaskId} is null or ${table.parentTaskId} <> ${table.id}`,
    ),
    check(
      "task_actual_dates_ordered",
      sql`${table.actualStart} is null or ${table.actualFinish} is null or ${table.actualFinish} >= ${table.actualStart}`,
    ),
  ],
);

export const taskDependency = pgTable(
  "task_dependency",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    wbsId: uuid("wbs_id").notNull(),
    predecessorTaskId: uuid("predecessor_task_id").notNull(),
    successorTaskId: uuid("successor_task_id").notNull(),
    type: dependencyType().notNull().default("FS"),
    lagWorkingDays: integer("lag_working_days").notNull().default(0),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("task_dependency_edge_unique").on(
      table.tenantId,
      table.wbsId,
      table.predecessorTaskId,
      table.successorTaskId,
      table.type,
    ),
    index("task_dependency_successor_idx").on(
      table.tenantId,
      table.wbsId,
      table.successorTaskId,
    ),
    foreignKey({
      name: "task_dependency_predecessor_fk",
      columns: [table.tenantId, table.wbsId, table.predecessorTaskId],
      foreignColumns: [task.tenantId, task.wbsId, task.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "task_dependency_successor_fk",
      columns: [table.tenantId, table.wbsId, table.successorTaskId],
      foreignColumns: [task.tenantId, task.wbsId, task.id],
    }).onDelete("cascade"),
    check(
      "task_dependency_distinct_tasks",
      sql`${table.predecessorTaskId} <> ${table.successorTaskId}`,
    ),
    check("task_dependency_lag_non_negative", sql`${table.lagWorkingDays} >= 0`),
  ],
);

/**
 * An approved baseline: the plan as it stood when a human published it
 * (Design 0009, ADR 0007's surviving decisions re-expressed for the effort model).
 *
 * Rows here and in `baselineTask` are IMMUTABLE. That is enforced by a trigger
 * installed in the same migration, not by the repository declining to write —
 * "we never call update" is a convention, and a convention is what this table
 * exists to replace.
 */
export const baseline = pgTable(
  "baseline",
  {
    tenantId: uuid("tenant_id").notNull(),
    wbsId: uuid("wbs_id").notNull(),
    version: integer().notNull(),
    // The WBS revision the snapshot was taken AT — the command's
    // `expectedRevision`, so the contents correspond to that exact state.
    sourceRevision: bigint("source_revision", { mode: "bigint" }).notNull(),
    // Mirrors `audit_event`: actor type + a TEXT id, with no foreign key to
    // `principal`. The application's `AuditActor.id` is a plain string and its
    // type includes SYSTEM, which has no principal row at all — a uuid column
    // with an FK would reject a legitimate caller at runtime, which is a database
    // constraint stricter than the type that feeds it.
    publishedByActorType: auditActorType("published_by_actor_type").notNull(),
    publishedByActorId: text("published_by_actor_id").notNull(),
    publishedAt: auditTimestamp("published_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "baseline_pkey",
      columns: [table.tenantId, table.wbsId, table.version],
    }),
    foreignKey({
      columns: [table.tenantId, table.wbsId],
      foreignColumns: [wbs.tenantId, wbs.id],
      name: "baseline_wbs_fk",
    }).onDelete("restrict"),
    check("baseline_version_positive", sql`${table.version} >= 1`),
    check("baseline_source_revision_non_negative", sql`${table.sourceRevision} >= 0`),
  ],
);

/**
 * One frozen task per baseline. Deliberately small — see Design 0009 §3.
 *
 * `daily_plan` is the whole of the plan side: measured 2026-08-05, BAC and PV come
 * from Σ dailyPlan and NOT from `planned_effort_minutes`. The estimate is frozen
 * anyway for the K column and the "L ≠ Σdaily" consistency flag; `assignee_member_id`
 * so member-segment PV does not follow a later reassignment; `name`/`seq` purely so
 * a task DELETED after publishing can still be named in the variance it causes.
 *
 * **No foreign key to `task`.** A cascade would make the immutability trigger
 * refuse an ordinary task deletion, and a restrict would forbid it outright. A
 * baseline is a copy of a moment, not a reference to the present.
 */
export const baselineTask = pgTable(
  "baseline_task",
  {
    tenantId: uuid("tenant_id").notNull(),
    wbsId: uuid("wbs_id").notNull(),
    version: integer().notNull(),
    taskId: uuid("task_id").notNull(),
    parentTaskId: uuid("parent_task_id"),
    dailyPlan: jsonb("daily_plan").notNull().default(sql`'{}'::jsonb`),
    plannedEffortMinutes: integer("planned_effort_minutes").notNull().default(0),
    assigneeMemberId: uuid("assignee_member_id"),
    name: text().notNull(),
    seq: integer().notNull(),
  },
  (table) => [
    primaryKey({
      name: "baseline_task_pkey",
      columns: [table.tenantId, table.wbsId, table.version, table.taskId],
    }),
    foreignKey({
      columns: [table.tenantId, table.wbsId, table.version],
      foreignColumns: [baseline.tenantId, baseline.wbsId, baseline.version],
      name: "baseline_task_baseline_fk",
    }).onDelete("restrict"),
    index("baseline_task_wbs_version_idx").on(table.tenantId, table.wbsId, table.version),
    check("baseline_task_planned_effort_non_negative", sql`${table.plannedEffortMinutes} >= 0`),
    check("baseline_task_seq_positive", sql`${table.seq} >= 1`),
    check(
      "baseline_task_not_own_parent",
      sql`${table.parentTaskId} is null or ${table.parentTaskId} <> ${table.taskId}`,
    ),
  ],
);

export const auditEvent = pgTable(
  "audit_event",
  {
    sequence: bigserial({ mode: "bigint" }).primaryKey(),
    id: uuid().notNull().defaultRandom().unique("audit_event_id_unique"),
    tenantId: uuid("tenant_id").notNull(),
    wbsId: uuid("wbs_id").notNull(),
    wbsRevision: bigint("wbs_revision", { mode: "bigint" }).notNull(),
    actorType: auditActorType("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    commandType: text("command_type").notNull(),
    payload: jsonb().notNull(),
    occurredAt: auditTimestamp("occurred_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("audit_event_wbs_revision_unique").on(
      table.tenantId,
      table.wbsId,
      table.wbsRevision,
    ),
    foreignKey({
      name: "audit_event_wbs_fk",
      columns: [table.tenantId, table.wbsId],
      foreignColumns: [wbs.tenantId, wbs.id],
    }).onDelete("restrict"),
    check("audit_event_revision_positive", sql`${table.wbsRevision} > 0`),
    check("audit_event_actor_id_not_blank", sql`length(trim(${table.actorId})) > 0`),
    check("audit_event_command_type_not_blank", sql`length(trim(${table.commandType})) > 0`),
  ],
);

export const commandReceipt = pgTable(
  "command_receipt",
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").notNull(),
    wbsId: uuid("wbs_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: char("request_hash", { length: 64 }).notNull(),
    resultRevision: bigint("result_revision", { mode: "bigint" }).notNull(),
    createdAt: auditTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("command_receipt_wbs_key_unique").on(
      table.tenantId,
      table.wbsId,
      table.idempotencyKey,
    ),
    foreignKey({
      name: "command_receipt_wbs_fk",
      columns: [table.tenantId, table.wbsId],
      foreignColumns: [wbs.tenantId, wbs.id],
    }).onDelete("restrict"),
    check(
      "command_receipt_idempotency_key_length",
      sql`length(trim(${table.idempotencyKey})) between 1 and 200`,
    ),
    check("command_receipt_request_hash_hex", sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
    check("command_receipt_revision_positive", sql`${table.resultRevision} > 0`),
  ],
);

export const schema = {
  principal,
  tenant,
  tenantMembership,
  project,
  wbs,
  calendar,
  member,
  process,
  product,
  subtaskTemplate,
  projectMembership,
  task,
  taskDependency,
  auditEvent,
  commandReceipt,
};
