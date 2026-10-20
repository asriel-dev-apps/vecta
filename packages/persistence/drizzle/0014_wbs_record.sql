-- Design 0016 §3.4. A content write commits only when its marker `<w>:<r>`
-- names a WBS whose revision is r and this transaction wrote the wbs_change
-- row for that revision. A revision update advances by exactly one. An INSERT
-- into wbs commits only with the change row at the inserted revision.
--
-- Existing rows are not re-checked: a WBS migrated through 0010–0013 has no
-- creation change, and these triggers fire on the new statement only.
--
-- The content check is deferred so the unit of work can write rows, then
-- advance the revision, then insert wbs_change, and still commit. The marker
-- trigger from 0012 still refuses a missing or mis-aimed marker at statement
-- time. `pg_xact_status(...) = 'in progress'` is how a previously committed
-- change at the current revision stops authorising a later content write.
--
-- wbs_change, wbs_snapshot and wbs_verified_range are append-only.
-- `vecta_reject_mutation` does not fit: its message and SQLSTATE describe an
-- approved baseline. Deleting a WBS cascades into these tables, so the
-- append-only triggers refuse that cascade. No application path deletes a WBS.
-- Tests that must tamper set `session_replication_role = replica` inside the
-- test transaction.

CREATE OR REPLACE FUNCTION "vecta_wbs_revision_requires_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.revision IS DISTINCT FROM OLD.revision + 1 THEN
		RAISE EXCEPTION 'wbs revision must advance by one'
			USING ERRCODE = 'P0001';
	END IF;
	IF NOT EXISTS (
		SELECT 1
		FROM public.wbs_change
		WHERE tenant_id = NEW.tenant_id
			AND wbs_id = NEW.id
			AND revision = NEW.revision
	) THEN
		RAISE EXCEPTION 'wbs_change missing for wbs % revision %', NEW.id, NEW.revision
			USING ERRCODE = 'P0001';
	END IF;
	RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "vecta_wbs_insert_requires_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM public.wbs_change
		WHERE tenant_id = NEW.tenant_id
			AND wbs_id = NEW.id
			AND revision = NEW.revision
	) THEN
		RAISE EXCEPTION 'wbs_change missing for wbs % revision %', NEW.id, NEW.revision
			USING ERRCODE = 'P0001';
	END IF;
	RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "wbs_insert_requires_change"
	AFTER INSERT ON "wbs"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW
	EXECUTE FUNCTION "vecta_wbs_insert_requires_change"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "vecta_wbs_content_write_matches_revision"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	marker text := btrim(current_setting('vecta.wbs_write', true));
	wbs_part text;
	rev_part bigint;
	row_wbs uuid;
	wbs_tenant uuid;
	matches boolean;
BEGIN
	IF marker IS NULL OR marker = '' OR marker !~ '^[^:]+:[0-9]+$' THEN
		RAISE EXCEPTION 'wbs write marker revision is missing or malformed'
			USING ERRCODE = 'P0001';
	END IF;
	wbs_part := lower(split_part(marker, ':', 1));
	rev_part := split_part(marker, ':', 2)::bigint;

	IF TG_OP = 'DELETE' THEN
		row_wbs := OLD.wbs_id;
		wbs_tenant := OLD.tenant_id;
	ELSE
		row_wbs := NEW.wbs_id;
		wbs_tenant := NEW.tenant_id;
	END IF;

	IF wbs_part IS DISTINCT FROM row_wbs::text THEN
		RAISE EXCEPTION 'wbs write marker revision does not name wbs %', row_wbs
			USING ERRCODE = 'P0001';
	END IF;

	SELECT EXISTS (
		SELECT 1
		FROM public.wbs AS w
		JOIN public.wbs_change AS c
			ON c.tenant_id = w.tenant_id
			AND c.wbs_id = w.id
			AND c.revision = rev_part
		WHERE w.tenant_id = wbs_tenant
			AND w.id = row_wbs
			AND w.revision = rev_part
			AND pg_xact_status(w.xmin::text::xid8) = 'in progress'
			AND pg_xact_status(c.xmin::text::xid8) = 'in progress'
	) INTO matches;

	IF NOT matches THEN
		RAISE EXCEPTION 'wbs write marker revision % has no change written for wbs %', rev_part, row_wbs
			USING ERRCODE = 'P0001';
	END IF;
	RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "wbs_content_matches_revision"
	AFTER INSERT OR UPDATE OR DELETE ON "task"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW
	EXECUTE FUNCTION "vecta_wbs_content_write_matches_revision"();--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "wbs_content_matches_revision"
	AFTER INSERT OR UPDATE OR DELETE ON "task_dependency"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW
	EXECUTE FUNCTION "vecta_wbs_content_write_matches_revision"();--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "wbs_content_matches_revision"
	AFTER INSERT OR UPDATE OR DELETE ON "member"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW
	EXECUTE FUNCTION "vecta_wbs_content_write_matches_revision"();--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "wbs_content_matches_revision"
	AFTER INSERT OR UPDATE OR DELETE ON "calendar"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW
	EXECUTE FUNCTION "vecta_wbs_content_write_matches_revision"();--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "wbs_content_matches_revision"
	AFTER INSERT OR UPDATE OR DELETE ON "process"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW
	EXECUTE FUNCTION "vecta_wbs_content_write_matches_revision"();--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "wbs_content_matches_revision"
	AFTER INSERT OR UPDATE OR DELETE ON "product"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW
	EXECUTE FUNCTION "vecta_wbs_content_write_matches_revision"();--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "wbs_content_matches_revision"
	AFTER INSERT OR UPDATE OR DELETE ON "subtask_template"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW
	EXECUTE FUNCTION "vecta_wbs_content_write_matches_revision"();--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "wbs_content_matches_revision"
	AFTER INSERT OR UPDATE OR DELETE ON "baseline"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW
	EXECUTE FUNCTION "vecta_wbs_content_write_matches_revision"();--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "wbs_content_matches_revision"
	AFTER INSERT OR UPDATE OR DELETE ON "baseline_task"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW
	EXECUTE FUNCTION "vecta_wbs_content_write_matches_revision"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "vecta_reject_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% on % is refused', TG_OP, TG_TABLE_NAME
		USING ERRCODE = 'P0001';
END;
$$;--> statement-breakpoint

CREATE TRIGGER "wbs_change_append_only"
	BEFORE UPDATE OR DELETE ON "wbs_change"
	FOR EACH ROW
	EXECUTE FUNCTION "vecta_reject_append_only"();--> statement-breakpoint

DROP TRIGGER "wbs_snapshot_immutable" ON "wbs_snapshot";--> statement-breakpoint

CREATE TRIGGER "wbs_snapshot_immutable"
	BEFORE UPDATE OR DELETE ON "wbs_snapshot"
	FOR EACH ROW
	EXECUTE FUNCTION "vecta_wbs_snapshot_immutable"();--> statement-breakpoint

CREATE TRIGGER "wbs_verified_range_append_only"
	BEFORE UPDATE OR DELETE ON "wbs_verified_range"
	FOR EACH ROW
	EXECUTE FUNCTION "vecta_reject_append_only"();
