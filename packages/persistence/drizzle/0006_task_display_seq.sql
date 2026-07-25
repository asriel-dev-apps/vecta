ALTER TABLE "projects" ADD COLUMN "next_task_seq" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- Add the immutable display-No. column nullable first so existing rows never
-- violate NOT NULL, then backfill every task with a per-(tenant,project)
-- sequence ordered by sort_order then id (the grid's own order) via
-- row_number(): a project's tasks number 1..N, so the live prod project's 48
-- tasks become 1..48 (Design 0003 §F-1). Tasks and subtasks share the sequence.
ALTER TABLE "tasks" ADD COLUMN "seq" integer;--> statement-breakpoint
UPDATE "tasks" AS "t" SET "seq" = "numbered"."seq"
	FROM (
		SELECT "id",
			row_number() OVER (PARTITION BY "tenant_id","project_id" ORDER BY "sort_order","id") AS "seq"
		FROM "tasks"
	) AS "numbered"
	WHERE "t"."id" = "numbered"."id";--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "seq" SET NOT NULL;--> statement-breakpoint
-- Seed each project's counter to one past its highest assigned No. (1 when the
-- project has no tasks), so the next created task continues the sequence.
UPDATE "projects" AS "p" SET "next_task_seq" =
	COALESCE((SELECT max("t"."seq") FROM "tasks" AS "t"
		WHERE "t"."tenant_id" = "p"."tenant_id" AND "t"."project_id" = "p"."id"), 0) + 1;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_tenant_project_seq_unique" UNIQUE("tenant_id","project_id","seq");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_next_task_seq_positive" CHECK ("projects"."next_task_seq" >= 1);--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_seq_positive" CHECK ("tasks"."seq" >= 1);
