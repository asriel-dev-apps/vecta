-- Design 0016 §2.1. One row per committed WBS revision. No triggers in this unit.
CREATE TABLE "wbs_change" (
	"tenant_id" uuid NOT NULL,
	"wbs_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"operation_id" text NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" text NOT NULL,
	"format" smallint NOT NULL,
	"change" jsonb NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wbs_change_pkey" PRIMARY KEY("tenant_id","wbs_id","revision"),
	CONSTRAINT "wbs_change_operation_unique" UNIQUE("tenant_id","wbs_id","operation_id"),
	CONSTRAINT "wbs_change_revision_positive" CHECK ("revision" >= 1),
	CONSTRAINT "wbs_change_operation_id_not_blank" CHECK (length(trim("operation_id")) > 0),
	CONSTRAINT "wbs_change_actor_id_not_blank" CHECK (length(trim("actor_id")) > 0)
);
--> statement-breakpoint
ALTER TABLE "wbs_change" ADD CONSTRAINT "wbs_change_wbs_fk" FOREIGN KEY ("tenant_id","wbs_id") REFERENCES "public"."wbs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
