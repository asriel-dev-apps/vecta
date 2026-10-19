-- M1 table foundation: singular names, projects → wbs, and a project above each wbs.
--
-- One transaction. Renames keep existing rows; each current wbs gets its own
-- project (same tenant, same name) and per-wbs membership is folded onto that
-- project (OWNER > EDITOR > VIEWER). Empty databases and 0009-era data both apply.
ALTER TABLE "principals" RENAME TO "principal";--> statement-breakpoint
ALTER TABLE "tenants" RENAME TO "tenant";--> statement-breakpoint
ALTER TABLE "tenant_memberships" RENAME TO "tenant_membership";--> statement-breakpoint
ALTER TABLE "projects" RENAME TO "wbs";--> statement-breakpoint
ALTER TABLE "project_calendars" RENAME TO "calendar";--> statement-breakpoint
ALTER TABLE "members" RENAME TO "member";--> statement-breakpoint
ALTER TABLE "processes" RENAME TO "process";--> statement-breakpoint
ALTER TABLE "products" RENAME TO "product";--> statement-breakpoint
ALTER TABLE "subtask_templates" RENAME TO "subtask_template";--> statement-breakpoint
ALTER TABLE "tasks" RENAME TO "task";--> statement-breakpoint
ALTER TABLE "task_dependencies" RENAME TO "task_dependency";--> statement-breakpoint
ALTER TABLE "project_baselines" RENAME TO "baseline";--> statement-breakpoint
ALTER TABLE "baseline_tasks" RENAME TO "baseline_task";--> statement-breakpoint
ALTER TABLE "audit_events" RENAME TO "audit_event";--> statement-breakpoint
ALTER TABLE "command_receipts" RENAME TO "command_receipt";--> statement-breakpoint
ALTER TABLE "calendar" RENAME COLUMN "project_id" TO "wbs_id";--> statement-breakpoint
ALTER TABLE "member" RENAME COLUMN "project_id" TO "wbs_id";--> statement-breakpoint
ALTER TABLE "process" RENAME COLUMN "project_id" TO "wbs_id";--> statement-breakpoint
ALTER TABLE "product" RENAME COLUMN "project_id" TO "wbs_id";--> statement-breakpoint
ALTER TABLE "subtask_template" RENAME COLUMN "project_id" TO "wbs_id";--> statement-breakpoint
ALTER TABLE "task" RENAME COLUMN "project_id" TO "wbs_id";--> statement-breakpoint
ALTER TABLE "task_dependency" RENAME COLUMN "project_id" TO "wbs_id";--> statement-breakpoint
ALTER TABLE "baseline" RENAME COLUMN "project_id" TO "wbs_id";--> statement-breakpoint
ALTER TABLE "baseline_task" RENAME COLUMN "project_id" TO "wbs_id";--> statement-breakpoint
ALTER TABLE "audit_event" RENAME COLUMN "project_id" TO "wbs_id";--> statement-breakpoint
ALTER TABLE "audit_event" RENAME COLUMN "project_revision" TO "wbs_revision";--> statement-breakpoint
ALTER TABLE "command_receipt" RENAME COLUMN "project_id" TO "wbs_id";--> statement-breakpoint
ALTER TABLE "principal" RENAME CONSTRAINT "principals_pkey" TO "principal_pkey";--> statement-breakpoint
ALTER TABLE "principal" RENAME CONSTRAINT "principals_issuer_not_blank" TO "principal_issuer_not_blank";--> statement-breakpoint
ALTER TABLE "principal" RENAME CONSTRAINT "principals_subject_not_blank" TO "principal_subject_not_blank";--> statement-breakpoint
ALTER TABLE "principal" RENAME CONSTRAINT "principals_display_name_not_blank" TO "principal_display_name_not_blank";--> statement-breakpoint
ALTER TABLE "principal" RENAME CONSTRAINT "principals_allowed_scopes_known" TO "principal_allowed_scopes_known";--> statement-breakpoint
ALTER TABLE "principal" RENAME CONSTRAINT "principals_human_scopes_empty" TO "principal_human_scopes_empty";--> statement-breakpoint
ALTER TABLE "tenant" RENAME CONSTRAINT "tenants_pkey" TO "tenant_pkey";--> statement-breakpoint
ALTER TABLE "tenant_membership" RENAME CONSTRAINT "tenant_memberships_tenant_id_principal_id_pk" TO "tenant_membership_tenant_id_principal_id_pk";--> statement-breakpoint
ALTER TABLE "tenant_membership" RENAME CONSTRAINT "tenant_memberships_tenant_id_tenants_id_fk" TO "tenant_membership_tenant_id_tenant_id_fk";--> statement-breakpoint
ALTER TABLE "tenant_membership" RENAME CONSTRAINT "tenant_memberships_principal_id_principals_id_fk" TO "tenant_membership_principal_id_principal_id_fk";--> statement-breakpoint
ALTER TABLE "wbs" RENAME CONSTRAINT "projects_pkey" TO "wbs_pkey";--> statement-breakpoint
ALTER TABLE "wbs" RENAME CONSTRAINT "projects_tenant_id_id_unique" TO "wbs_tenant_id_id_unique";--> statement-breakpoint
ALTER TABLE "wbs" RENAME CONSTRAINT "projects_tenant_id_tenants_id_fk" TO "wbs_tenant_id_tenant_id_fk";--> statement-breakpoint
ALTER TABLE "wbs" RENAME CONSTRAINT "projects_name_not_blank" TO "wbs_name_not_blank";--> statement-breakpoint
ALTER TABLE "wbs" RENAME CONSTRAINT "projects_currency_uppercase" TO "wbs_currency_uppercase";--> statement-breakpoint
ALTER TABLE "wbs" RENAME CONSTRAINT "projects_revision_non_negative" TO "wbs_revision_non_negative";--> statement-breakpoint
ALTER TABLE "wbs" RENAME CONSTRAINT "projects_next_task_seq_positive" TO "wbs_next_task_seq_positive";--> statement-breakpoint
ALTER TABLE "wbs" RENAME CONSTRAINT "projects_next_baseline_version_positive" TO "wbs_next_baseline_version_positive";--> statement-breakpoint
ALTER TABLE "wbs" RENAME CONSTRAINT "projects_status_after_start" TO "wbs_status_after_start";--> statement-breakpoint
ALTER TABLE "calendar" RENAME CONSTRAINT "project_calendars_tenant_id_project_id_id_pk" TO "calendar_tenant_id_wbs_id_id_pk";--> statement-breakpoint
ALTER TABLE "calendar" RENAME CONSTRAINT "project_calendars_project_fk" TO "calendar_wbs_fk";--> statement-breakpoint
ALTER TABLE "calendar" RENAME CONSTRAINT "project_calendars_id_not_blank" TO "calendar_id_not_blank";--> statement-breakpoint
ALTER TABLE "calendar" RENAME CONSTRAINT "project_calendars_name_not_blank" TO "calendar_name_not_blank";--> statement-breakpoint
ALTER TABLE "calendar" RENAME CONSTRAINT "project_calendars_working_weekdays_known" TO "calendar_working_weekdays_known";--> statement-breakpoint
ALTER TABLE "member" RENAME CONSTRAINT "members_tenant_id_project_id_id_pk" TO "member_tenant_id_wbs_id_id_pk";--> statement-breakpoint
ALTER TABLE "member" RENAME CONSTRAINT "members_project_fk" TO "member_wbs_fk";--> statement-breakpoint
ALTER TABLE "member" RENAME CONSTRAINT "members_calendar_fk" TO "member_calendar_fk";--> statement-breakpoint
ALTER TABLE "member" RENAME CONSTRAINT "members_name_not_blank" TO "member_name_not_blank";--> statement-breakpoint
ALTER TABLE "member" RENAME CONSTRAINT "members_daily_capacity_range" TO "member_daily_capacity_range";--> statement-breakpoint
ALTER TABLE "member" RENAME CONSTRAINT "members_cost_rate_non_negative" TO "member_cost_rate_non_negative";--> statement-breakpoint
ALTER TABLE "process" RENAME CONSTRAINT "processes_tenant_id_project_id_id_pk" TO "process_tenant_id_wbs_id_id_pk";--> statement-breakpoint
ALTER TABLE "process" RENAME CONSTRAINT "processes_project_fk" TO "process_wbs_fk";--> statement-breakpoint
ALTER TABLE "process" RENAME CONSTRAINT "processes_name_not_blank" TO "process_name_not_blank";--> statement-breakpoint
ALTER TABLE "process" RENAME CONSTRAINT "processes_sort_order_non_negative" TO "process_sort_order_non_negative";--> statement-breakpoint
ALTER TABLE "product" RENAME CONSTRAINT "products_tenant_id_project_id_id_pk" TO "product_tenant_id_wbs_id_id_pk";--> statement-breakpoint
ALTER TABLE "product" RENAME CONSTRAINT "products_project_fk" TO "product_wbs_fk";--> statement-breakpoint
ALTER TABLE "product" RENAME CONSTRAINT "products_name_not_blank" TO "product_name_not_blank";--> statement-breakpoint
ALTER TABLE "product" RENAME CONSTRAINT "products_sort_order_non_negative" TO "product_sort_order_non_negative";--> statement-breakpoint
ALTER TABLE "subtask_template" RENAME CONSTRAINT "subtask_templates_tenant_id_project_id_id_pk" TO "subtask_template_tenant_id_wbs_id_id_pk";--> statement-breakpoint
ALTER TABLE "subtask_template" RENAME CONSTRAINT "subtask_templates_project_fk" TO "subtask_template_wbs_fk";--> statement-breakpoint
ALTER TABLE "subtask_template" RENAME CONSTRAINT "subtask_templates_name_not_blank" TO "subtask_template_name_not_blank";--> statement-breakpoint
ALTER TABLE "subtask_template" RENAME CONSTRAINT "subtask_templates_sort_order_non_negative" TO "subtask_template_sort_order_non_negative";--> statement-breakpoint
ALTER TABLE "task" RENAME CONSTRAINT "tasks_pkey" TO "task_pkey";--> statement-breakpoint
ALTER TABLE "task" RENAME CONSTRAINT "tasks_tenant_project_id_unique" TO "task_tenant_wbs_id_unique";--> statement-breakpoint
ALTER TABLE "task" RENAME CONSTRAINT "tasks_tenant_project_seq_unique" TO "task_tenant_wbs_seq_unique";--> statement-breakpoint
ALTER TABLE "task" RENAME CONSTRAINT "tasks_project_fk" TO "task_wbs_fk";--> statement-breakpoint
ALTER TABLE "task" RENAME CONSTRAINT "tasks_parent_fk" TO "task_parent_fk";--> statement-breakpoint
ALTER TABLE "task" RENAME CONSTRAINT "tasks_assignee_fk" TO "task_assignee_fk";--> statement-breakpoint
ALTER TABLE "task" RENAME CONSTRAINT "tasks_process_fk" TO "task_process_fk";--> statement-breakpoint
ALTER TABLE "task" RENAME CONSTRAINT "tasks_product_fk" TO "task_product_fk";--> statement-breakpoint
ALTER TABLE "task" RENAME CONSTRAINT "tasks_name_not_blank" TO "task_name_not_blank";--> statement-breakpoint
ALTER TABLE "task" RENAME CONSTRAINT "tasks_sort_order_non_negative" TO "task_sort_order_non_negative";--> statement-breakpoint
ALTER TABLE "task" RENAME CONSTRAINT "tasks_seq_positive" TO "task_seq_positive";--> statement-breakpoint
ALTER TABLE "task" RENAME CONSTRAINT "tasks_planned_effort_non_negative" TO "task_planned_effort_non_negative";--> statement-breakpoint
ALTER TABLE "task" RENAME CONSTRAINT "tasks_actual_effort_non_negative" TO "task_actual_effort_non_negative";--> statement-breakpoint
ALTER TABLE "task" RENAME CONSTRAINT "tasks_progress_range" TO "task_progress_range";--> statement-breakpoint
ALTER TABLE "task" RENAME CONSTRAINT "tasks_proration_weight_range" TO "task_proration_weight_range";--> statement-breakpoint
ALTER TABLE "task" RENAME CONSTRAINT "tasks_not_own_parent" TO "task_not_own_parent";--> statement-breakpoint
ALTER TABLE "task" RENAME CONSTRAINT "tasks_actual_dates_ordered" TO "task_actual_dates_ordered";--> statement-breakpoint
ALTER TABLE "task_dependency" RENAME CONSTRAINT "task_dependencies_pkey" TO "task_dependency_pkey";--> statement-breakpoint
ALTER TABLE "task_dependency" RENAME CONSTRAINT "task_dependencies_predecessor_fk" TO "task_dependency_predecessor_fk";--> statement-breakpoint
ALTER TABLE "task_dependency" RENAME CONSTRAINT "task_dependencies_successor_fk" TO "task_dependency_successor_fk";--> statement-breakpoint
ALTER TABLE "task_dependency" RENAME CONSTRAINT "task_dependencies_distinct_tasks" TO "task_dependency_distinct_tasks";--> statement-breakpoint
ALTER TABLE "task_dependency" RENAME CONSTRAINT "task_dependencies_lag_non_negative" TO "task_dependency_lag_non_negative";--> statement-breakpoint
ALTER TABLE "baseline" RENAME CONSTRAINT "project_baselines_pkey" TO "baseline_pkey";--> statement-breakpoint
ALTER TABLE "baseline" RENAME CONSTRAINT "project_baselines_project_fk" TO "baseline_wbs_fk";--> statement-breakpoint
ALTER TABLE "baseline" RENAME CONSTRAINT "project_baselines_version_positive" TO "baseline_version_positive";--> statement-breakpoint
ALTER TABLE "baseline" RENAME CONSTRAINT "project_baselines_source_revision_non_negative" TO "baseline_source_revision_non_negative";--> statement-breakpoint
ALTER TABLE "baseline_task" RENAME CONSTRAINT "baseline_tasks_pkey" TO "baseline_task_pkey";--> statement-breakpoint
ALTER TABLE "baseline_task" RENAME CONSTRAINT "baseline_tasks_baseline_fk" TO "baseline_task_baseline_fk";--> statement-breakpoint
ALTER TABLE "baseline_task" RENAME CONSTRAINT "baseline_tasks_planned_effort_non_negative" TO "baseline_task_planned_effort_non_negative";--> statement-breakpoint
ALTER TABLE "baseline_task" RENAME CONSTRAINT "baseline_tasks_seq_positive" TO "baseline_task_seq_positive";--> statement-breakpoint
ALTER TABLE "baseline_task" RENAME CONSTRAINT "baseline_tasks_not_own_parent" TO "baseline_task_not_own_parent";--> statement-breakpoint
ALTER TABLE "audit_event" RENAME CONSTRAINT "audit_events_pkey" TO "audit_event_pkey";--> statement-breakpoint
ALTER TABLE "audit_event" RENAME CONSTRAINT "audit_events_id_unique" TO "audit_event_id_unique";--> statement-breakpoint
ALTER TABLE "audit_event" RENAME CONSTRAINT "audit_events_project_fk" TO "audit_event_wbs_fk";--> statement-breakpoint
ALTER TABLE "audit_event" RENAME CONSTRAINT "audit_events_revision_positive" TO "audit_event_revision_positive";--> statement-breakpoint
ALTER TABLE "audit_event" RENAME CONSTRAINT "audit_events_actor_id_not_blank" TO "audit_event_actor_id_not_blank";--> statement-breakpoint
ALTER TABLE "audit_event" RENAME CONSTRAINT "audit_events_command_type_not_blank" TO "audit_event_command_type_not_blank";--> statement-breakpoint
ALTER TABLE "command_receipt" RENAME CONSTRAINT "command_receipts_pkey" TO "command_receipt_pkey";--> statement-breakpoint
ALTER TABLE "command_receipt" RENAME CONSTRAINT "command_receipts_project_key_unique" TO "command_receipt_wbs_key_unique";--> statement-breakpoint
ALTER TABLE "command_receipt" RENAME CONSTRAINT "command_receipts_project_fk" TO "command_receipt_wbs_fk";--> statement-breakpoint
ALTER TABLE "command_receipt" RENAME CONSTRAINT "command_receipts_idempotency_key_length" TO "command_receipt_idempotency_key_length";--> statement-breakpoint
ALTER TABLE "command_receipt" RENAME CONSTRAINT "command_receipts_request_hash_hex" TO "command_receipt_request_hash_hex";--> statement-breakpoint
ALTER TABLE "command_receipt" RENAME CONSTRAINT "command_receipts_revision_positive" TO "command_receipt_revision_positive";--> statement-breakpoint
ALTER TRIGGER "audit_events_immutable" ON "audit_event" RENAME TO "audit_event_immutable";--> statement-breakpoint
ALTER TRIGGER "command_receipts_immutable" ON "command_receipt" RENAME TO "command_receipt_immutable";--> statement-breakpoint
ALTER TRIGGER "project_baselines_immutable" ON "baseline" RENAME TO "baseline_immutable";--> statement-breakpoint
ALTER TRIGGER "baseline_tasks_immutable" ON "baseline_task" RENAME TO "baseline_task_immutable";--> statement-breakpoint
ALTER SEQUENCE "audit_events_sequence_seq" RENAME TO "audit_event_sequence_seq";--> statement-breakpoint
DO $$
DECLARE
  pair text[];
  pairs text[][] := ARRAY[
    ARRAY['principals_issuer_subject_unique', 'principal_issuer_subject_unique'],
    ARRAY['principals_pkey', 'principal_pkey'],
    ARRAY['tenants_pkey', 'tenant_pkey'],
    ARRAY['tenant_memberships_tenant_id_principal_id_pk', 'tenant_membership_tenant_id_principal_id_pk'],
    ARRAY['tenant_memberships_principal_idx', 'tenant_membership_principal_idx'],
    ARRAY['projects_pkey', 'wbs_pkey'],
    ARRAY['projects_tenant_id_id_unique', 'wbs_tenant_id_id_unique'],
    ARRAY['projects_tenant_id_idx', 'wbs_tenant_id_idx'],
    ARRAY['project_calendars_tenant_id_project_id_id_pk', 'calendar_tenant_id_wbs_id_id_pk'],
    ARRAY['members_tenant_id_project_id_id_pk', 'member_tenant_id_wbs_id_id_pk'],
    ARRAY['processes_tenant_id_project_id_id_pk', 'process_tenant_id_wbs_id_id_pk'],
    ARRAY['products_tenant_id_project_id_id_pk', 'product_tenant_id_wbs_id_id_pk'],
    ARRAY['subtask_templates_tenant_id_project_id_id_pk', 'subtask_template_tenant_id_wbs_id_id_pk'],
    ARRAY['tasks_pkey', 'task_pkey'],
    ARRAY['tasks_tenant_project_id_unique', 'task_tenant_wbs_id_unique'],
    ARRAY['tasks_tenant_project_seq_unique', 'task_tenant_wbs_seq_unique'],
    ARRAY['tasks_parent_idx', 'task_parent_idx'],
    ARRAY['tasks_sort_order_idx', 'task_sort_order_idx'],
    ARRAY['task_dependencies_pkey', 'task_dependency_pkey'],
    ARRAY['task_dependencies_edge_unique', 'task_dependency_edge_unique'],
    ARRAY['task_dependencies_successor_idx', 'task_dependency_successor_idx'],
    ARRAY['project_baselines_pkey', 'baseline_pkey'],
    ARRAY['baseline_tasks_pkey', 'baseline_task_pkey'],
    ARRAY['baseline_tasks_project_version_idx', 'baseline_task_wbs_version_idx'],
    ARRAY['audit_events_pkey', 'audit_event_pkey'],
    ARRAY['audit_events_id_unique', 'audit_event_id_unique'],
    ARRAY['audit_events_project_revision_unique', 'audit_event_wbs_revision_unique'],
    ARRAY['command_receipts_pkey', 'command_receipt_pkey'],
    ARRAY['command_receipts_project_key_unique', 'command_receipt_wbs_key_unique']
  ];
BEGIN
  FOREACH pair SLICE 1 IN ARRAY pairs LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_class AS c
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'i' AND c.relname = pair[1]
    ) THEN
      EXECUTE format('ALTER INDEX %I RENAME TO %I', pair[1], pair[2]);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
CREATE TABLE "project" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"order_amount_minor" bigint,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_tenant_id_id_unique" UNIQUE("tenant_id","id"),
	CONSTRAINT "project_name_not_blank" CHECK (length(trim("name")) > 0)
);--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_tenant_id_idx" ON "project" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "wbs" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "wbs" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
UPDATE "wbs" SET "project_id" = gen_random_uuid() WHERE "project_id" IS NULL;--> statement-breakpoint
INSERT INTO "project" ("id", "tenant_id", "name", "created_at", "updated_at")
SELECT "project_id", "tenant_id", "name", "created_at", "updated_at" FROM "wbs";--> statement-breakpoint
ALTER TABLE "wbs" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "wbs" ADD CONSTRAINT "wbs_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."project"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "project_membership" (
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"role" "project_role" NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_membership_tenant_id_project_id_principal_id_pk" PRIMARY KEY("tenant_id","project_id","principal_id")
);--> statement-breakpoint
ALTER TABLE "project_membership" ADD CONSTRAINT "project_membership_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."project"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_membership" ADD CONSTRAINT "project_membership_tenant_membership_fk" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "public"."tenant_membership"("tenant_id","principal_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_membership_principal_idx" ON "project_membership" USING btree ("principal_id");--> statement-breakpoint
INSERT INTO "project_membership" ("tenant_id", "project_id", "principal_id", "role", "created_at")
SELECT DISTINCT ON ("pm"."tenant_id", "w"."project_id", "pm"."principal_id")
	"pm"."tenant_id",
	"w"."project_id",
	"pm"."principal_id",
	"pm"."role",
	"pm"."created_at"
FROM "project_memberships" AS "pm"
INNER JOIN "wbs" AS "w"
	ON "w"."tenant_id" = "pm"."tenant_id" AND "w"."id" = "pm"."project_id"
ORDER BY
	"pm"."tenant_id",
	"w"."project_id",
	"pm"."principal_id",
	CASE "pm"."role" WHEN 'OWNER' THEN 0 WHEN 'EDITOR' THEN 1 ELSE 2 END,
	"pm"."created_at";--> statement-breakpoint
DROP TABLE "project_memberships";
