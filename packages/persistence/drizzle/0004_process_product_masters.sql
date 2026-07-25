CREATE TABLE "processes" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processes_tenant_id_project_id_id_pk" PRIMARY KEY("tenant_id","project_id","id"),
	CONSTRAINT "processes_name_not_blank" CHECK (length(trim("processes"."name")) > 0),
	CONSTRAINT "processes_sort_order_non_negative" CHECK ("processes"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_tenant_id_project_id_id_pk" PRIMARY KEY("tenant_id","project_id","id"),
	CONSTRAINT "products_name_not_blank" CHECK (length(trim("products"."name")) > 0),
	CONSTRAINT "products_sort_order_non_negative" CHECK ("products"."sort_order" >= 0)
);
--> statement-breakpoint
ALTER TABLE "processes" ADD CONSTRAINT "processes_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_project_fk" FOREIGN KEY ("tenant_id","project_id") REFERENCES "public"."projects"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "processes" ("id","tenant_id","project_id","name","sort_order")
	SELECT gen_random_uuid(), "tenant_id", "project_id", "name",
		(row_number() OVER (PARTITION BY "tenant_id","project_id" ORDER BY "name")) - 1
	FROM (SELECT DISTINCT "tenant_id","project_id","process" AS "name" FROM "tasks" WHERE length(trim("process")) > 0) AS "distinct_processes";--> statement-breakpoint
INSERT INTO "products" ("id","tenant_id","project_id","name","sort_order")
	SELECT gen_random_uuid(), "tenant_id", "project_id", "name",
		(row_number() OVER (PARTITION BY "tenant_id","project_id" ORDER BY "name")) - 1
	FROM (SELECT DISTINCT "tenant_id","project_id","product" AS "name" FROM "tasks" WHERE length(trim("product")) > 0) AS "distinct_products";--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "process_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "product_id" uuid;--> statement-breakpoint
UPDATE "tasks" AS "t" SET "process_id" = "p"."id"
	FROM "processes" AS "p"
	WHERE "p"."tenant_id" = "t"."tenant_id" AND "p"."project_id" = "t"."project_id" AND "p"."name" = "t"."process";--> statement-breakpoint
UPDATE "tasks" AS "t" SET "product_id" = "p"."id"
	FROM "products" AS "p"
	WHERE "p"."tenant_id" = "t"."tenant_id" AND "p"."project_id" = "t"."project_id" AND "p"."name" = "t"."product";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_process_fk" FOREIGN KEY ("tenant_id","project_id","process_id") REFERENCES "public"."processes"("tenant_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_product_fk" FOREIGN KEY ("tenant_id","project_id","product_id") REFERENCES "public"."products"("tenant_id","project_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "process";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "product";
