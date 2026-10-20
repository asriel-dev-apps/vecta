-- Design 0016 §3.4. A WBS revision commits only with its wbs_change row, and a
-- content-table write commits only while vecta.wbs_write names that row's WBS.
-- The revision check is deferred: the unit of work updates wbs.revision and
-- inserts wbs_change later in the same transaction. The content check only
-- reads the setting. Neither writes a row.
--
-- `a_wbs_write_marker` sorts before `baseline_immutable` and
-- `baseline_task_immutable`. Same-event BEFORE triggers run in name order, so
-- a baseline mutation is refused for a missing marker before the immutability
-- trigger runs.
--
-- TRUNCATE does not fire these row triggers. A cascading DELETE does: it is a
-- row DELETE, so the marker must name that row's wbs_id.

CREATE OR REPLACE FUNCTION "vecta_wbs_revision_requires_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.revision IS NOT DISTINCT FROM OLD.revision THEN
		RETURN NULL;
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

CREATE CONSTRAINT TRIGGER "wbs_revision_requires_change"
	AFTER UPDATE OF revision ON "wbs"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW
	WHEN (OLD.revision IS DISTINCT FROM NEW.revision)
	EXECUTE FUNCTION "vecta_wbs_revision_requires_change"();--> statement-breakpoint

CREATE OR REPLACE FUNCTION "vecta_require_wbs_write_marker"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	marker text := btrim(current_setting('vecta.wbs_write', true));
	wbs_part text;
BEGIN
	IF marker IS NULL OR marker = '' OR marker !~ '^[^:]+:[0-9]+$' THEN
		RAISE EXCEPTION 'wbs write marker missing'
			USING ERRCODE = 'P0001';
	END IF;
	-- uuid::text is lowercase; the marker is whatever the writer passed.
	wbs_part := lower(split_part(marker, ':', 1));

	IF TG_OP = 'DELETE' THEN
		IF wbs_part IS DISTINCT FROM OLD.wbs_id::text THEN
			RAISE EXCEPTION 'wbs write marker does not name wbs %', OLD.wbs_id
				USING ERRCODE = 'P0001';
		END IF;
		RETURN OLD;
	END IF;

	IF wbs_part IS DISTINCT FROM NEW.wbs_id::text THEN
		RAISE EXCEPTION 'wbs write marker does not name wbs %', NEW.wbs_id
			USING ERRCODE = 'P0001';
	END IF;
	IF TG_OP = 'UPDATE'
		AND NEW.wbs_id IS DISTINCT FROM OLD.wbs_id
		AND wbs_part IS DISTINCT FROM OLD.wbs_id::text THEN
		RAISE EXCEPTION 'wbs write marker does not name wbs %', OLD.wbs_id
			USING ERRCODE = 'P0001';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "a_wbs_write_marker"
	BEFORE INSERT OR UPDATE OR DELETE ON "task"
	FOR EACH ROW EXECUTE FUNCTION "vecta_require_wbs_write_marker"();--> statement-breakpoint

CREATE TRIGGER "a_wbs_write_marker"
	BEFORE INSERT OR UPDATE OR DELETE ON "task_dependency"
	FOR EACH ROW EXECUTE FUNCTION "vecta_require_wbs_write_marker"();--> statement-breakpoint

CREATE TRIGGER "a_wbs_write_marker"
	BEFORE INSERT OR UPDATE OR DELETE ON "member"
	FOR EACH ROW EXECUTE FUNCTION "vecta_require_wbs_write_marker"();--> statement-breakpoint

CREATE TRIGGER "a_wbs_write_marker"
	BEFORE INSERT OR UPDATE OR DELETE ON "calendar"
	FOR EACH ROW EXECUTE FUNCTION "vecta_require_wbs_write_marker"();--> statement-breakpoint

CREATE TRIGGER "a_wbs_write_marker"
	BEFORE INSERT OR UPDATE OR DELETE ON "process"
	FOR EACH ROW EXECUTE FUNCTION "vecta_require_wbs_write_marker"();--> statement-breakpoint

CREATE TRIGGER "a_wbs_write_marker"
	BEFORE INSERT OR UPDATE OR DELETE ON "product"
	FOR EACH ROW EXECUTE FUNCTION "vecta_require_wbs_write_marker"();--> statement-breakpoint

CREATE TRIGGER "a_wbs_write_marker"
	BEFORE INSERT OR UPDATE OR DELETE ON "subtask_template"
	FOR EACH ROW EXECUTE FUNCTION "vecta_require_wbs_write_marker"();--> statement-breakpoint

CREATE TRIGGER "a_wbs_write_marker"
	BEFORE INSERT OR UPDATE OR DELETE ON "baseline"
	FOR EACH ROW EXECUTE FUNCTION "vecta_require_wbs_write_marker"();--> statement-breakpoint

CREATE TRIGGER "a_wbs_write_marker"
	BEFORE INSERT OR UPDATE OR DELETE ON "baseline_task"
	FOR EACH ROW EXECUTE FUNCTION "vecta_require_wbs_write_marker"();
