CREATE TABLE "subtask_templates" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"subtasks" jsonb NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subtask_templates_tenant_id_project_id_id_pk" PRIMARY KEY("tenant_id","project_id","id"),
	CONSTRAINT "subtask_templates_name_not_blank" CHECK (length(trim("subtask_templates"."name")) > 0),
	CONSTRAINT "subtask_templates_sort_order_non_negative" CHECK ("subtask_templates"."sort_order" >= 0)
);
--> statement-breakpoint
ALTER TABLE "subtask_templates" ADD CONSTRAINT "subtask_templates_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "subtask_templates" ("id","tenant_id","project_id","name","sort_order","subtasks")
	SELECT gen_random_uuid(), "tenant_id", "id", 'Standard build', 0,
		'[{"name":"Design","weightBp":2000},{"name":"Review","weightBp":1000,"dependsOnPrev":{"type":"FS","lagWorkingDays":1}},{"name":"Rework","weightBp":1000,"dependsOnPrev":{"type":"FS","lagWorkingDays":0}},{"name":"Build","weightBp":4000,"dependsOnPrev":{"type":"FS","lagWorkingDays":0}},{"name":"Test","weightBp":2000,"dependsOnPrev":{"type":"FS","lagWorkingDays":0}}]'::jsonb
	FROM "projects";--> statement-breakpoint
INSERT INTO "subtask_templates" ("id","tenant_id","project_id","name","sort_order","subtasks")
	SELECT gen_random_uuid(), "tenant_id", "id", 'Design and review', 1,
		'[{"name":"Design","weightBp":7000},{"name":"Review","weightBp":3000,"dependsOnPrev":{"type":"FS","lagWorkingDays":1}}]'::jsonb
	FROM "projects";
