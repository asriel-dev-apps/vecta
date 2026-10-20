-- Design 0016 §2.3, §3.5. A snapshot is a fact about one revision, and a verdict
-- is a separate fact about a pair. Neither table carries a_wbs_write_marker:
-- a snapshot of r−1 written after r commits is not "this transaction writes
-- revision r", and a base snapshot does not advance the revision.
--
-- drizzle-kit generate stops at the 0006 snapshot and asks to reconcile every
-- later rename, so this file is written in the same shape as 0011. STORAGE
-- EXTERNAL and the immutability trigger are what drizzle cannot express.
CREATE TABLE "wbs_snapshot" (
	"tenant_id" uuid NOT NULL,
	"wbs_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"format" smallint NOT NULL,
	"sha256" text NOT NULL,
	"body" bytea NOT NULL,
	"body_bytes" integer NOT NULL,
	"raw_bytes" integer NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wbs_snapshot_pkey" PRIMARY KEY("tenant_id","wbs_id","revision"),
	CONSTRAINT "wbs_snapshot_revision_non_negative" CHECK ("revision" >= 0),
	CONSTRAINT "wbs_snapshot_format_positive" CHECK ("format" >= 1),
	CONSTRAINT "wbs_snapshot_sha256_hex" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "wbs_snapshot_body_bytes_positive" CHECK ("body_bytes" > 0),
	CONSTRAINT "wbs_snapshot_raw_bytes_positive" CHECK ("raw_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "wbs_snapshot" ADD CONSTRAINT "wbs_snapshot_wbs_fk" FOREIGN KEY ("tenant_id","wbs_id") REFERENCES "public"."wbs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "wbs_snapshot" ALTER COLUMN "body" SET STORAGE EXTERNAL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "vecta_wbs_snapshot_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'wbs_snapshot is immutable'
		USING ERRCODE = 'P0001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "wbs_snapshot_immutable"
	BEFORE UPDATE ON "wbs_snapshot"
	FOR EACH ROW
	EXECUTE FUNCTION "vecta_wbs_snapshot_immutable"();
--> statement-breakpoint
CREATE TABLE "wbs_verified_range" (
	"tenant_id" uuid NOT NULL,
	"wbs_id" uuid NOT NULL,
	"from_revision" bigint NOT NULL,
	"to_revision" bigint NOT NULL,
	"failure" text,
	"verified_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wbs_verified_range_pkey" PRIMARY KEY("tenant_id","wbs_id","from_revision","to_revision"),
	CONSTRAINT "wbs_verified_range_ordered" CHECK ("from_revision" < "to_revision")
);
--> statement-breakpoint
ALTER TABLE "wbs_verified_range" ADD CONSTRAINT "wbs_verified_range_from_fk" FOREIGN KEY ("tenant_id","wbs_id","from_revision") REFERENCES "public"."wbs_snapshot"("tenant_id","wbs_id","revision") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "wbs_verified_range" ADD CONSTRAINT "wbs_verified_range_to_fk" FOREIGN KEY ("tenant_id","wbs_id","to_revision") REFERENCES "public"."wbs_snapshot"("tenant_id","wbs_id","revision") ON DELETE cascade ON UPDATE no action;
