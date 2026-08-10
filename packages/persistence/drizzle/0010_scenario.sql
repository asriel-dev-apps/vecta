-- Design 0015 — the scenario feature.
--
-- EXPAND ONLY. Three new tables and one new enum; no existing column, constraint
-- or index changes. So the OLD Worker keeps working against this schema (it just
-- does not know the tables exist), and a Worker rollback needs no schema rollback
-- — `operations/release-and-rollback.md` is forward-only and there is no down
-- migration.
--
-- There is deliberately NO runs table. ADR 0008 describes runs, algorithm
-- versions and canonical input hashes, but Design 0015 §3 assigns all of that to
-- feature 7 (forecasting): a scenario answers "what does this plan look like",
-- which is a computation over the existing pure projections, not a forecast.
CREATE TYPE "scenario_status" AS ENUM ('DRAFT', 'PUBLISHED', 'DISCARDED');--> statement-breakpoint

CREATE TABLE "project_scenarios" (
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "scenario_status" DEFAULT 'DRAFT' NOT NULL,
	-- The project revision this draft is pinned to. Editing and publishing fail
	-- closed unless it still equals `projects.revision` (Design 0015 §7); viewing
	-- deliberately does not, which is what the base snapshot is for.
	"base_revision" bigint NOT NULL,
	-- Rises on every edit. The PROJECT revision does not move until publish
	-- (ADR 0008 Decision 2).
	"scenario_revision" bigint DEFAULT 0 NOT NULL,
	"created_by_actor_type" "audit_actor_type" NOT NULL,
	"created_by_actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"terminal_at" timestamp with time zone,
	"terminal_by_actor_type" "audit_actor_type",
	"terminal_by_actor_id" text,
	CONSTRAINT "project_scenarios_pkey" PRIMARY KEY("tenant_id","project_id","id"),
	CONSTRAINT "project_scenarios_base_revision_non_negative" CHECK ("project_scenarios"."base_revision" >= 0),
	CONSTRAINT "project_scenarios_scenario_revision_non_negative" CHECK ("project_scenarios"."scenario_revision" >= 0),
	CONSTRAINT "project_scenarios_name_not_blank" CHECK (length(btrim("project_scenarios"."name")) > 0),
	-- A terminal scenario carries who ended it and when; a draft carries neither.
	-- Written as one constraint rather than three nullable columns nobody checks,
	-- so a half-written terminal row cannot exist.
	CONSTRAINT "project_scenarios_terminal_fields_together" CHECK (
		("project_scenarios"."status" = 'DRAFT'
			AND "project_scenarios"."terminal_at" IS NULL
			AND "project_scenarios"."terminal_by_actor_type" IS NULL
			AND "project_scenarios"."terminal_by_actor_id" IS NULL)
		OR ("project_scenarios"."status" <> 'DRAFT'
			AND "project_scenarios"."terminal_at" IS NOT NULL
			AND "project_scenarios"."terminal_by_actor_type" IS NOT NULL
			AND "project_scenarios"."terminal_by_actor_id" IS NOT NULL)
	)
);--> statement-breakpoint

-- The base state, whole, as one jsonb document.
--
-- `baseline_tasks` opened its snapshot into columns; this one does not, and the
-- difference is not inconsistency. Baseline rows are AGGREGATED in SQL (member and
-- parent segment PV), so the columns earn their keep. This snapshot is only ever
-- read whole and turned back into a `ProjectState` for `applyProjectCommand`, so
-- columns would buy nothing and would need a migration every time that type grows.
--
-- The member cost rate is NOT in here (Design 0015 §4.2, reserving what Design 0009
-- §8-5 predicted): `stripSensitiveMemberFields` is an allow-list, so a snapshot
-- carrying the rate would become a second read path for a sensitive field.
CREATE TABLE "scenario_base_snapshots" (
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"scenario_id" uuid NOT NULL,
	"state" jsonb NOT NULL,
	CONSTRAINT "scenario_base_snapshots_pkey" PRIMARY KEY("tenant_id","project_id","scenario_id")
);--> statement-breakpoint

-- The scenario's own edits, in order. Plain existing `ProjectCommand` payloads —
-- ADR 0008 Decision 1 defines a scenario as an ordered set of existing plan-only
-- commands, and publish applies them through the normal Application validation, so
-- no new command type and no new write path is introduced (ADR 0013).
CREATE TABLE "scenario_edits" (
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"scenario_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"command" jsonb NOT NULL,
	"created_by_actor_type" "audit_actor_type" NOT NULL,
	"created_by_actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scenario_edits_pkey" PRIMARY KEY("tenant_id","project_id","scenario_id","ordinal"),
	CONSTRAINT "scenario_edits_ordinal_non_negative" CHECK ("scenario_edits"."ordinal" >= 0)
);--> statement-breakpoint

ALTER TABLE "project_scenarios" ADD CONSTRAINT "project_scenarios_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenario_base_snapshots" ADD CONSTRAINT "scenario_base_snapshots_scenario_fk" FOREIGN KEY ("tenant_id","project_id","scenario_id") REFERENCES "public"."project_scenarios"("tenant_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenario_edits" ADD CONSTRAINT "scenario_edits_scenario_fk" FOREIGN KEY ("tenant_id","project_id","scenario_id") REFERENCES "public"."project_scenarios"("tenant_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_scenarios_project_status_idx" ON "project_scenarios" USING btree ("tenant_id","project_id","status");--> statement-breakpoint
CREATE INDEX "scenario_edits_scenario_ordinal_idx" ON "scenario_edits" USING btree ("tenant_id","project_id","scenario_id","ordinal");--> statement-breakpoint

-- There is deliberately NO foreign key from the snapshot or the edits to `tasks`
-- or `members`. Same reasoning as `baseline_tasks` (Design 0009 §4): a snapshot is
-- a copy of a moment, not a reference to the present, and a scenario must survive
-- the deletion of a task it names.

-- Immutability AFTER the scenario ends, enforced by the database.
--
-- This is NOT the unconditional trigger `baseline_tasks` carries, and the
-- difference is the point: a DRAFT has to stay mutable — that is what a draft is.
-- So the predicate is the parent's `status`, and a control has to measure BOTH
-- directions, because a trigger that refuses everything would pass a
-- "terminal rows are immutable" test while breaking the feature (Design 0015 §5).
-- INSERT is guarded as well as UPDATE and DELETE. Without it, a published
-- scenario could still be handed new edits — the rows already there would be
-- frozen while the list they belong to kept growing, which is the same defect
-- wearing a different shape.
CREATE OR REPLACE FUNCTION "vecta_reject_terminal_scenario_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	target_tenant uuid;
	target_project uuid;
	target_scenario uuid;
	parent_status "scenario_status";
BEGIN
	IF TG_OP = 'DELETE' THEN
		target_tenant := OLD."tenant_id";
		target_project := OLD."project_id";
		target_scenario := OLD."scenario_id";
	ELSE
		target_tenant := NEW."tenant_id";
		target_project := NEW."project_id";
		target_scenario := NEW."scenario_id";
	END IF;
	SELECT s."status" INTO parent_status
	FROM "project_scenarios" s
	WHERE s."tenant_id" = target_tenant
		AND s."project_id" = target_project
		AND s."id" = target_scenario;
	IF parent_status IS DISTINCT FROM 'DRAFT' THEN
		RAISE EXCEPTION
			'% on % is refused: scenario % is no longer a draft (Design 0015)',
			TG_OP, TG_TABLE_NAME, target_scenario
			USING ERRCODE = 'restrict_violation';
	END IF;
	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

-- On the scenario row itself the rule is one-way rather than absolute: DRAFT may
-- become terminal (that IS publish and discard), and a terminal row may not change
-- again or be deleted. Deleting a draft is refused too — discarding is the way a
-- scenario ends, and it leaves the audit trail a deletion would erase.
CREATE OR REPLACE FUNCTION "vecta_reject_terminal_scenario_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION
			'DELETE on % is refused: end a scenario by discarding it (Design 0015)',
			TG_TABLE_NAME
			USING ERRCODE = 'restrict_violation';
	END IF;
	IF OLD."status" <> 'DRAFT' THEN
		RAISE EXCEPTION
			'UPDATE on % is refused: scenario % is already % (Design 0015)',
			TG_TABLE_NAME, OLD."id", OLD."status"
			USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "scenario_base_snapshots_draft_only"
	BEFORE INSERT OR UPDATE OR DELETE ON "scenario_base_snapshots"
	FOR EACH ROW EXECUTE FUNCTION "vecta_reject_terminal_scenario_mutation"();--> statement-breakpoint

CREATE TRIGGER "scenario_edits_draft_only"
	BEFORE INSERT OR UPDATE OR DELETE ON "scenario_edits"
	FOR EACH ROW EXECUTE FUNCTION "vecta_reject_terminal_scenario_mutation"();--> statement-breakpoint

CREATE TRIGGER "project_scenarios_terminal_is_final"
	BEFORE UPDATE OR DELETE ON "project_scenarios"
	FOR EACH ROW EXECUTE FUNCTION "vecta_reject_terminal_scenario_change"();
