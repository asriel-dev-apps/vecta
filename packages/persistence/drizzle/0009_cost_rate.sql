-- Design 0010 — the cost layer.
--
-- EXPAND ONLY: one nullable column and its check. No existing column, constraint,
-- index or trigger is touched, so the OLD Worker keeps serving against this
-- schema (it never selects the column) and a Worker rollback needs no schema
-- rollback — `operations/release-and-rollback.md` is forward-only.
--
-- NULLABLE is the design decision, not an oversight. A default of 0 would make
-- every member's work cost nothing and be summed silently; `null` means "no rate
-- recorded" and takes that member's leaves OUT of the money aggregate with a
-- count on screen. The same shape as an empty daily plot in Design 0009 §3.1,
-- where a silent zero baked a permanent hole into the budget.
--
-- SENSITIVE (ADR 0011 Decision 7). It is projected out of the GENERAL read model
-- at the structure level, and a test scans the built client bundle for the name.
ALTER TABLE "members" ADD COLUMN "cost_rate_minor_per_hour" integer;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_cost_rate_non_negative" CHECK ("members"."cost_rate_minor_per_hour" is null or "members"."cost_rate_minor_per_hour" >= 0);
