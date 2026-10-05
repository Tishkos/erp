-- ===========================================================================
-- Platform phase · Agent 10 — Workflow automation: what automation made
-- (2026-10-05). HAND-AUTHORED. Everything additive; no applied migration is touched.
--
--   automation_made   append-only. One row for each record an automation action
--                     created (today: the task a `create_task` action raises;
--                     the finding a `create_exception` action raises is listed
--                     too, for the trail). It is the loop guard's memory: a
--                     record automation made must not wake automation without
--                     limit. The runner reads it before it lets a rule act on an
--                     event about a record, and refuses
--                       * a rule acting on a record that rule itself made, and
--                       * any rule acting on a record made two steps from a person
--                         (`depth` 2 = made from something automation made).
--                     A person's own record has no row here (depth 0).
--
--   One row per record: a record is made once. The run that made it is named, so
--   the log says "this task came from AUT-004, run 31".
--
--   Who may read: `view` on `automation`. Who writes: the runner, as the system
--   operator (a super user), in the same transaction as the run it belongs to.
-- ===========================================================================

CREATE TABLE "automation_made" (
	"record_type" text NOT NULL,
	"record_id" text NOT NULL,
	"record_label" text NOT NULL,
	"rule_id" uuid NOT NULL REFERENCES "automation_rule"("id"),
	"run_id" bigint NOT NULL REFERENCES "automation_run"("id"),
	"depth" integer NOT NULL,
	"made_at" timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY ("record_type", "record_id"),
	CONSTRAINT "automation_made_type_known" CHECK ("record_type" IN ('task', 'exception')),
	CONSTRAINT "automation_made_depth_range" CHECK ("depth" BETWEEN 1 AND 5),
	CONSTRAINT "automation_made_label_present" CHECK (nullif(btrim("record_label"), '') IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX "automation_made_rule_idx" ON "automation_made" ("rule_id", "made_at" DESC);--> statement-breakpoint
CREATE INDEX "automation_made_run_idx" ON "automation_made" ("run_id");--> statement-breakpoint
CREATE TRIGGER "automation_made_append_only"
	BEFORE UPDATE OR DELETE ON "automation_made"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

ALTER TABLE "automation_made" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "automation_made" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY automation_made_scope ON "automation_made"
	USING (app_signed_in() AND (app_is_super_user() OR app_has_grant('automation', 'view')))
	WITH CHECK (app_signed_in() AND app_is_super_user());--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	GRANT SELECT, INSERT ON "automation_made" TO erp_app;
END $$;
