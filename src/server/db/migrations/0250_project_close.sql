-- ===========================================================================
-- REQ-PM-001 Stage PM-6 — Project System: close, settlement, labour
-- (2026-10-02). Over Phase 11 (0148) and PM-1 to PM-5 (0245–0249).
--
--   project_settlement      one per project (D-PM-7), at technical
--                           completion: an investment project's cost moved
--                           to the asset under construction, an internal or
--                           customer project's WIP / deferred revenue
--                           cleared; drafted by one person, posted by
--                           another; refuses every later cost
--   project_cost (+col)     settlement_id — the settlement that took the row
--   project_timesheet       hours booked by an employee on an element, by
--                           one person, approved by another (D-PM-8)
--   project_timesheet_run   a month's approved hours posted at the employee's
--                           base salary ÷ the calendar's working days ÷ 8
--
-- Posting events (the map in domain/posting-map.ts):
--   projects.material_issue  Dr project_material_cost / Cr inventory (the
--                            item's own account) — a Material Issue document
--                            now posts; a return the other way (D-PM-13)
--   projects.timesheet       Dr project_labour / Cr labour_absorption
--   projects.settlement      Dr project_auc / Cr project_cost (the accounts
--                            the costs sit in, named line by line)
-- project_material_cost and project_labour copy the purchase invoice's
-- expense mapping where one exists; labour_absorption and project_auc are
-- Finance's to map.
-- ===========================================================================

CREATE TABLE "project_settlement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"settlement_no" text NOT NULL,
	"project_code" text NOT NULL,
	"branch_code" text NOT NULL,
	"kind" text NOT NULL,
	"settled_on" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"cost_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"gl_cost_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"billed_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"journal_entry_id" uuid,
	"recognition_reversal_entry_id" uuid,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	CONSTRAINT "project_settlement_no_uniq" UNIQUE ("settlement_no"),
	CONSTRAINT "project_settlement_kind" CHECK ("kind" IN ('asset', 'result')),
	CONSTRAINT "project_settlement_status" CHECK ("status" IN ('draft', 'posted', 'cancelled')),
	CONSTRAINT "project_settlement_posted" CHECK (("status" = 'posted') = ("posted_at" IS NOT NULL) AND ("posted_by" IS NULL) = ("posted_at" IS NULL)),
	CONSTRAINT "project_settlement_four_eyes" CHECK ("posted_by" IS NULL OR "posted_by" <> "created_by"),
	CONSTRAINT "project_settlement_cancel" CHECK (("status" = 'cancelled') = ("cancelled_at" IS NOT NULL) AND ("cancelled_by" IS NULL) = ("cancelled_at" IS NULL) AND ("cancelled_at" IS NULL OR coalesce(btrim("cancel_reason"), '') <> ''))
);--> statement-breakpoint
ALTER TABLE "project_settlement" ADD CONSTRAINT "project_settlement_project_code_fk" FOREIGN KEY ("project_code") REFERENCES "public"."project"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_settlement" ADD CONSTRAINT "project_settlement_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_settlement" ADD CONSTRAINT "project_settlement_journal_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_settlement" ADD CONSTRAINT "project_settlement_recognition_fk" FOREIGN KEY ("recognition_reversal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_settlement" ADD CONSTRAINT "project_settlement_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_settlement" ADD CONSTRAINT "project_settlement_posted_by_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_settlement" ADD CONSTRAINT "project_settlement_cancelled_by_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- D-PM-7 — one settlement per project (a cancelled draft leaves room for the next).
CREATE UNIQUE INDEX "project_settlement_one_per_project" ON "project_settlement" USING btree ("project_code") WHERE "status" <> 'cancelled';--> statement-breakpoint

ALTER TABLE "project_cost" ADD COLUMN "settlement_id" uuid;--> statement-breakpoint
-- D-PM-13 — the Material Issue document's own journal.
ALTER TABLE "project_material_issue" ADD COLUMN "journal_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "project_material_issue" ADD CONSTRAINT "project_material_issue_journal_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_cost" ADD CONSTRAINT "project_cost_settlement_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."project_settlement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE TABLE "project_timesheet_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_code" text NOT NULL,
	"month" date NOT NULL,
	"posted_on" date NOT NULL,
	"hours" numeric(9, 2) NOT NULL,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_timesheet_run_month" CHECK (extract(day from "month") = 1),
	CONSTRAINT "project_timesheet_run_amounts" CHECK ("hours" > 0 AND "amount_iqd" > 0)
);--> statement-breakpoint
ALTER TABLE "project_timesheet_run" ADD CONSTRAINT "project_timesheet_run_project_code_fk" FOREIGN KEY ("project_code") REFERENCES "public"."project"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_timesheet_run" ADD CONSTRAINT "project_timesheet_run_journal_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_timesheet_run" ADD CONSTRAINT "project_timesheet_run_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE TABLE "project_timesheet" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_code" text NOT NULL,
	"wbs_code" text NOT NULL,
	"cost_code" text NOT NULL,
	"employee_id" uuid NOT NULL,
	"work_date" date NOT NULL,
	"hours" numeric(5, 2) NOT NULL,
	"note" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"run_id" uuid,
	"rate_iqd" numeric(19, 4),
	"amount_iqd" numeric(19, 4),
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	CONSTRAINT "project_timesheet_hours" CHECK ("hours" > 0 AND "hours" <= 24),
	CONSTRAINT "project_timesheet_status" CHECK ("status" IN ('draft', 'approved', 'posted', 'cancelled')),
	CONSTRAINT "project_timesheet_approved" CHECK (("approved_by" IS NULL) = ("approved_at" IS NULL) AND ("status" NOT IN ('approved', 'posted') OR "approved_at" IS NOT NULL) AND ("status" <> 'draft' OR "approved_at" IS NULL)),
	CONSTRAINT "project_timesheet_four_eyes" CHECK ("approved_by" IS NULL OR "approved_by" <> "created_by"),
	CONSTRAINT "project_timesheet_posted" CHECK (("status" = 'posted') = ("run_id" IS NOT NULL) AND ("run_id" IS NULL) = ("amount_iqd" IS NULL) AND ("run_id" IS NULL) = ("rate_iqd" IS NULL)),
	CONSTRAINT "project_timesheet_cancel" CHECK (("status" = 'cancelled') = ("cancelled_at" IS NOT NULL) AND ("cancelled_at" IS NULL OR coalesce(btrim("cancel_reason"), '') <> ''))
);--> statement-breakpoint
ALTER TABLE "project_timesheet" ADD CONSTRAINT "project_timesheet_project_code_fk" FOREIGN KEY ("project_code") REFERENCES "public"."project"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_timesheet" ADD CONSTRAINT "project_timesheet_wbs_fk" FOREIGN KEY ("project_code", "wbs_code") REFERENCES "public"."project_wbs"("project_code", "code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_timesheet" ADD CONSTRAINT "project_timesheet_cost_code_fk" FOREIGN KEY ("cost_code") REFERENCES "public"."project_cost_code"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_timesheet" ADD CONSTRAINT "project_timesheet_employee_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employee"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_timesheet" ADD CONSTRAINT "project_timesheet_run_fk" FOREIGN KEY ("run_id") REFERENCES "public"."project_timesheet_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_timesheet" ADD CONSTRAINT "project_timesheet_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_timesheet" ADD CONSTRAINT "project_timesheet_approved_by_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_timesheet" ADD CONSTRAINT "project_timesheet_cancelled_by_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_timesheet_project_idx" ON "project_timesheet" USING btree ("project_code", "work_date");--> statement-breakpoint
CREATE INDEX "project_timesheet_employee_idx" ON "project_timesheet" USING btree ("employee_id", "work_date");--> statement-breakpoint

-- A day has 24 hours, across every project an employee books to.
CREATE FUNCTION project_timesheet_day_within_24() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_total numeric(9, 2);
BEGIN
  SELECT coalesce(sum(t.hours), 0) INTO v_total
    FROM project_timesheet t
   WHERE t.employee_id = NEW.employee_id AND t.work_date = NEW.work_date
     AND t.status <> 'cancelled' AND t.id <> NEW.id;
  IF NEW.status <> 'cancelled' AND v_total + NEW.hours > 24 THEN
    RAISE EXCEPTION 'An employee''s day holds 24 hours; % are booked on % and this adds %.', v_total, NEW.work_date, NEW.hours
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER project_timesheet_day_within_24
  BEFORE INSERT OR UPDATE OF hours, status, work_date, employee_id ON project_timesheet
  FOR EACH ROW EXECUTE FUNCTION project_timesheet_day_within_24();--> statement-breakpoint

-- Row-level security: the project's rows, as for every PM table.
DO $$
DECLARE t text;
BEGIN
	FOREACH t IN ARRAY ARRAY['project_settlement', 'project_timesheet', 'project_timesheet_run'] LOOP
		EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
		EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
		EXECUTE format(
			'CREATE POLICY %I ON %I USING (EXISTS (SELECT 1 FROM project p WHERE p.code = project_code)) '
			'WITH CHECK (EXISTS (SELECT 1 FROM project p WHERE p.code = project_code))',
			t || '_scope', t);
	END LOOP;
END $$;--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	GRANT SELECT, INSERT, UPDATE ON "project_settlement", "project_timesheet" TO erp_app;
	GRANT SELECT, INSERT ON "project_timesheet_run" TO erp_app;
END $$;--> statement-breakpoint

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year) VALUES
	('PROJECT_SETTLEMENT', 'PST', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true)
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
	('project_settlement', 'Project settlement', 'projects', 'At technical completion: an investment project''s cost moved to the asset under construction; an internal or customer project''s WIP and deferred revenue cleared, the result left in the P&L (REQ-PM-001 §12, D-PM-7).'),
	('project_timesheet', 'Project timesheet', 'projects', 'Hours an employee worked on a project element, approved by somebody else and posted monthly at the employee''s rate (REQ-PM-001 §8, D-PM-8).')
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

-- The material and labour cost roles copy the purchase invoice's expense mapping, where one exists.
INSERT INTO posting_rule (event_type, line_role, account_id, is_active, created_by)
SELECT e.event_type, e.line_role, r.account_id, true, r.created_by
  FROM posting_rule r
 CROSS JOIN (VALUES ('projects.material_issue', 'project_material_cost'), ('projects.timesheet', 'project_labour')) AS e(event_type, line_role)
 WHERE r.event_type = 'purchasing.ap_invoice' AND r.line_role = 'expense'
   AND r.is_active
   AND r.item_group IS NULL AND r.partner_group IS NULL AND r.warehouse_code IS NULL
   AND r.project_code IS NULL AND r.branch_code IS NULL
ON CONFLICT DO NOTHING;
