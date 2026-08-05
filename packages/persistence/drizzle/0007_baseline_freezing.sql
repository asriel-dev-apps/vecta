-- Design 0009 — baseline freezing.
--
-- EXPAND ONLY. Two new tables and one new column; no existing column, constraint
-- or index changes. So the OLD Worker keeps working against this schema (it just
-- does not know the tables exist), and a Worker rollback needs no schema rollback
-- — which matters because `operations/release-and-rollback.md` is forward-only and
-- there is no down migration.
ALTER TABLE "projects" ADD COLUMN "next_baseline_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_next_baseline_version_positive" CHECK ("projects"."next_baseline_version" >= 1);--> statement-breakpoint

CREATE TABLE "project_baselines" (
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"source_revision" bigint NOT NULL,
	"published_by_actor_type" "audit_actor_type" NOT NULL,
	"published_by_actor_id" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_baselines_pkey" PRIMARY KEY("tenant_id","project_id","version"),
	CONSTRAINT "project_baselines_version_positive" CHECK ("project_baselines"."version" >= 1),
	CONSTRAINT "project_baselines_source_revision_non_negative" CHECK ("project_baselines"."source_revision" >= 0)
);--> statement-breakpoint

CREATE TABLE "baseline_tasks" (
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"task_id" uuid NOT NULL,
	"parent_task_id" uuid,
	"daily_plan" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"planned_effort_minutes" integer DEFAULT 0 NOT NULL,
	"assignee_member_id" uuid,
	"name" text NOT NULL,
	"seq" integer NOT NULL,
	CONSTRAINT "baseline_tasks_pkey" PRIMARY KEY("tenant_id","project_id","version","task_id"),
	CONSTRAINT "baseline_tasks_planned_effort_non_negative" CHECK ("baseline_tasks"."planned_effort_minutes" >= 0),
	CONSTRAINT "baseline_tasks_seq_positive" CHECK ("baseline_tasks"."seq" >= 1),
	CONSTRAINT "baseline_tasks_not_own_parent" CHECK ("baseline_tasks"."parent_task_id" is null or "baseline_tasks"."parent_task_id" <> "baseline_tasks"."task_id")
);--> statement-breakpoint

ALTER TABLE "project_baselines" ADD CONSTRAINT "project_baselines_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "baseline_tasks" ADD CONSTRAINT "baseline_tasks_baseline_fk" FOREIGN KEY ("tenant_id","project_id","version") REFERENCES "public"."project_baselines"("tenant_id","project_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "baseline_tasks_project_version_idx" ON "baseline_tasks" USING btree ("tenant_id","project_id","version");--> statement-breakpoint

-- There is deliberately NO foreign key from `baseline_tasks.task_id` to `tasks`.
-- A cascade would make the immutability trigger below REFUSE an ordinary task
-- deletion (the cascade is a DELETE on a frozen row), and a restrict would forbid
-- deleting a task that has ever been baselined. A baseline is a copy of a moment,
-- not a reference to the present, and a task that no longer exists is exactly the
-- case the frozen `name`/`seq` columns are here to render.

-- Immutability, enforced by the database rather than by the repository declining
-- to write. "We never call update" is a convention, and a convention is the thing
-- these tables exist to replace: an approved baseline that can be edited is not a
-- baseline. Same reasoning as the client/server boundary, where a filename makes
-- the build fail rather than a rule asking people to remember.
--
-- Written by hand because drizzle-kit generates neither functions nor triggers
-- from `schema.ts`.
CREATE OR REPLACE FUNCTION "vecta_reject_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION
		'% on % is refused: an approved baseline is immutable (Design 0009)',
		TG_OP, TG_TABLE_NAME
		USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint

CREATE TRIGGER "project_baselines_immutable"
	BEFORE UPDATE OR DELETE ON "project_baselines"
	FOR EACH ROW EXECUTE FUNCTION "vecta_reject_mutation"();--> statement-breakpoint

CREATE TRIGGER "baseline_tasks_immutable"
	BEFORE UPDATE OR DELETE ON "baseline_tasks"
	FOR EACH ROW EXECUTE FUNCTION "vecta_reject_mutation"();
