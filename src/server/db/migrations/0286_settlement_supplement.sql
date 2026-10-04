-- IMPROVEMENT-002 — what a landed-cost lock does to a project that is already
-- settled, and the link a project material return needs.
--
--   * `project_settlement_supplement` — a landed-cost share that reaches
--     material issued to a project after the project was settled. The project
--     is not reopened (one settlement per project, D-PM-7): the share is posted
--     to the same receiver the issue posted to, flagged `post_settlement` on its
--     departure row, and this supplement carries it on to where the settlement
--     put the project's cost — for an asset settlement a journal of its own
--     (Dr the asset under construction / Cr the cost), for an expense
--     settlement nothing more. One per departure. Append-only.
--   * `project_material_issue_line.returns_issue_line_id` — the issue line a
--     return line gives back. A return of material issued before a lock brings
--     the lock's share back with it, and only the issue line says which share.
CREATE TABLE IF NOT EXISTS "project_settlement_supplement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"settlement_id" uuid NOT NULL REFERENCES "project_settlement"("id"),
	"project_code" text NOT NULL REFERENCES "project"("code"),
	"lock_id" uuid NOT NULL REFERENCES "landed_cost_lock"("id"),
	"departure_id" uuid NOT NULL REFERENCES "landed_cost_departure"("id"),
	"material_issue_line_id" uuid REFERENCES "project_material_issue_line"("id"),
	"cost_id" uuid REFERENCES "project_cost"("id"),
	"amount_iqd" numeric(19,4) NOT NULL,
	"journal_entry_id" uuid REFERENCES "journal_entry"("id"),
	"posted_on" date NOT NULL,
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "project_settlement_supplement_amount" CHECK ("amount_iqd" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_settlement_supplement_departure_uniq" ON "project_settlement_supplement" ("departure_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_settlement_supplement_settlement_idx" ON "project_settlement_supplement" ("settlement_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_settlement_supplement_project_idx" ON "project_settlement_supplement" ("project_code");
--> statement-breakpoint
DROP TRIGGER IF EXISTS "project_settlement_supplement_append_only" ON "project_settlement_supplement";
--> statement-breakpoint
CREATE TRIGGER "project_settlement_supplement_append_only"
	BEFORE UPDATE OR DELETE ON "project_settlement_supplement"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint

ALTER TABLE project_settlement_supplement ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE project_settlement_supplement FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS project_settlement_supplement_scope ON project_settlement_supplement;--> statement-breakpoint
CREATE POLICY project_settlement_supplement_scope ON project_settlement_supplement
	USING (EXISTS (SELECT 1 FROM project p WHERE p.code = project_code))
	WITH CHECK (EXISTS (SELECT 1 FROM project p WHERE p.code = project_code));
--> statement-breakpoint

ALTER TABLE "project_material_issue_line" ADD COLUMN IF NOT EXISTS "returns_issue_line_id" uuid REFERENCES "project_material_issue_line"("id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_material_issue_line_returns_idx" ON "project_material_issue_line" ("returns_issue_line_id") WHERE "returns_issue_line_id" IS NOT NULL;
--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	GRANT SELECT, INSERT ON project_settlement_supplement TO erp_app;
END $$;
