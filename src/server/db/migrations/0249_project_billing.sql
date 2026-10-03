-- ===========================================================================
-- REQ-PM-001 Stage PM-5 — Project System: billing, revenue recognition and
-- forecast (2026-10-02). Over Phase 11 (0148) and PM-1 to PM-4 (0245–0248).
--
--   project_billing_plan_line   a customer project's billing plan: per
--                               billing element, a line that falls due on a
--                               billing milestone or on a date, for a share
--                               of the contract value or an amount (§11)
--   project_certificate (+cols) the journal its approval posts, who posted
--                               it, and the plan line it came from (D-PM-11)
--   project_recognition_policy  the method Finance ratifies before anything
--                               posts (D-PM-1); seeded NOT ratified
--   project_recognition         one row per project and period end: the
--                               figures, the journal, and its reversal next
--                               period
--   project_etc                 the manager's estimate to complete, per
--                               element, dated and reasoned (§11 forecast)
--
-- Posting events projects.certificate and projects.recognition: the
-- customer receivable and the revenue lines copy the Sales Invoice's
-- mappings; WIP, deferred revenue and retention receivable are Finance's to
-- map on the Posting Mappings screen (a certificate with retention, or a
-- recognition run, refuses with the role it is missing until they are).
-- ===========================================================================

CREATE TABLE "project_billing_plan_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_code" text NOT NULL,
	"wbs_code" text NOT NULL,
	"line_no" smallint NOT NULL,
	"description" text NOT NULL,
	"due_trigger" text NOT NULL,
	"activity_id" uuid,
	"due_on" date,
	"basis" text NOT NULL,
	"percent_of_contract" numeric(9, 4),
	"amount_iqd" numeric(19, 4),
	"status" text DEFAULT 'planned' NOT NULL,
	"due_since" date,
	"certificate_id" uuid,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_billing_plan_line_no_uniq" UNIQUE ("project_code", "line_no"),
	CONSTRAINT "project_billing_plan_line_trigger" CHECK ("due_trigger" IN ('milestone', 'date')),
	CONSTRAINT "project_billing_plan_line_trigger_shape" CHECK (("due_trigger" = 'milestone') = ("activity_id" IS NOT NULL) AND ("due_trigger" = 'date') = ("due_on" IS NOT NULL)),
	CONSTRAINT "project_billing_plan_line_basis" CHECK ("basis" IN ('percent', 'amount')),
	CONSTRAINT "project_billing_plan_line_basis_shape" CHECK (("basis" = 'percent') = ("percent_of_contract" IS NOT NULL) AND ("basis" = 'amount') = ("amount_iqd" IS NOT NULL)),
	CONSTRAINT "project_billing_plan_line_values" CHECK (("percent_of_contract" IS NULL OR ("percent_of_contract" > 0 AND "percent_of_contract" <= 100)) AND ("amount_iqd" IS NULL OR "amount_iqd" > 0)),
	CONSTRAINT "project_billing_plan_line_status" CHECK ("status" IN ('planned', 'due', 'billed', 'cancelled')),
	CONSTRAINT "project_billing_plan_line_billed" CHECK (("status" = 'billed') = ("certificate_id" IS NOT NULL)),
	CONSTRAINT "project_billing_plan_line_cancel" CHECK (("cancelled_by" IS NULL) = ("cancelled_at" IS NULL) AND ("status" = 'cancelled') = ("cancelled_at" IS NOT NULL) AND ("cancelled_at" IS NULL OR coalesce(btrim("cancel_reason"), '') <> ''))
);--> statement-breakpoint
ALTER TABLE "project_billing_plan_line" ADD CONSTRAINT "project_billing_plan_line_project_code_fk" FOREIGN KEY ("project_code") REFERENCES "public"."project"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_billing_plan_line" ADD CONSTRAINT "project_billing_plan_line_wbs_fk" FOREIGN KEY ("project_code", "wbs_code") REFERENCES "public"."project_wbs"("project_code", "code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_billing_plan_line" ADD CONSTRAINT "project_billing_plan_line_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."project_activity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_billing_plan_line" ADD CONSTRAINT "project_billing_plan_line_certificate_id_fk" FOREIGN KEY ("certificate_id") REFERENCES "public"."project_certificate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_billing_plan_line" ADD CONSTRAINT "project_billing_plan_line_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_billing_plan_line" ADD CONSTRAINT "project_billing_plan_line_cancelled_by_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- A certificate settles one plan line.
CREATE UNIQUE INDEX "project_billing_plan_line_certificate_uniq" ON "project_billing_plan_line" USING btree ("certificate_id") WHERE "certificate_id" IS NOT NULL;--> statement-breakpoint

-- The certificate's posting (D-PM-11): approved by somebody other than its raiser.
ALTER TABLE "project_certificate" ADD COLUMN "journal_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "project_certificate" ADD CONSTRAINT "project_certificate_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_certificate" ADD COLUMN "basis" text DEFAULT 'progress' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_certificate" ADD CONSTRAINT "project_certificate_basis" CHECK ("basis" IN ('progress', 'billing_plan'));--> statement-breakpoint
ALTER TABLE "project_certificate" ADD CONSTRAINT "project_certificate_four_eyes" CHECK ("approved_by" IS NULL OR "approved_by" <> "created_by");--> statement-breakpoint
ALTER TABLE "project_certificate" ADD CONSTRAINT "project_certificate_posted_has_journal" CHECK ("status" <> 'posted' OR ("journal_entry_id" IS NOT NULL AND "approved_by" IS NOT NULL));--> statement-breakpoint
-- Phase 11's measured-progress rule (blueprint 10) holds for a certificate
-- raised from progress; one raised from a billing-plan line is evidenced by
-- its reached milestone or its contract date, not by a measurement.
CREATE OR REPLACE FUNCTION project_certificate_within_measured_progress() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_measured numeric(9,4);
BEGIN
  IF NEW.basis = 'billing_plan' THEN
    RETURN NEW;
  END IF;

  SELECT coalesce(avg(latest.percent_complete), 0) INTO v_measured
    FROM (
      SELECT DISTINCT ON (p.wbs_code) p.percent_complete
        FROM project_progress p
       WHERE p.project_code = NEW.project_code
         AND p.approved_at IS NOT NULL
         AND p.measured_on <= NEW.certified_on
       ORDER BY p.wbs_code, p.measured_on DESC
    ) latest;

  IF NEW.percent_complete > v_measured THEN
    RAISE EXCEPTION
      'Certificate claims %%% against %%% of approved measured progress on % (blueprint 10).',
      NEW.percent_complete, v_measured, NEW.project_code
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TABLE "project_recognition_policy" (
	"code" text PRIMARY KEY NOT NULL,
	"method" text NOT NULL,
	"description" text NOT NULL,
	"ratified_by" uuid,
	"ratified_at" timestamp with time zone,
	"ratified_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_recognition_policy_method" CHECK ("method" IN ('poc_cost_to_cost')),
	CONSTRAINT "project_recognition_policy_ratified" CHECK (("ratified_by" IS NULL) = ("ratified_at" IS NULL) AND ("ratified_at" IS NULL OR coalesce(btrim("ratified_note"), '') <> ''))
);--> statement-breakpoint
ALTER TABLE "project_recognition_policy" ADD CONSTRAINT "project_recognition_policy_ratified_by_fk" FOREIGN KEY ("ratified_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO "project_recognition_policy" (code, method, description) VALUES
	('DEFAULT', 'poc_cost_to_cost', 'Percentage of completion, cost to cost, at period end: contract value × actual cost ÷ estimate at completion, less what has been billed, to WIP or deferred revenue; reversed next period (REQ-PM-001 D-PM-1).')
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

CREATE TABLE "project_recognition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_code" text NOT NULL,
	"period_end" date NOT NULL,
	"contract_value_iqd" numeric(19, 4) NOT NULL,
	"actual_iqd" numeric(19, 4) NOT NULL,
	"eac_iqd" numeric(19, 4) NOT NULL,
	"percent_complete" numeric(9, 4) NOT NULL,
	"recognised_iqd" numeric(19, 4) NOT NULL,
	"billed_iqd" numeric(19, 4) NOT NULL,
	"adjustment_iqd" numeric(19, 4) NOT NULL,
	"journal_entry_id" uuid,
	"reversal_journal_entry_id" uuid,
	"reversed_on" date,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_recognition_period_uniq" UNIQUE ("project_code", "period_end"),
	CONSTRAINT "project_recognition_percent" CHECK ("percent_complete" BETWEEN 0 AND 100),
	CONSTRAINT "project_recognition_arithmetic" CHECK ("adjustment_iqd" = "recognised_iqd" - "billed_iqd"),
	CONSTRAINT "project_recognition_journal" CHECK (("adjustment_iqd" = 0) OR ("journal_entry_id" IS NOT NULL)),
	CONSTRAINT "project_recognition_reversal" CHECK (("reversal_journal_entry_id" IS NULL) = ("reversed_on" IS NULL))
);--> statement-breakpoint
ALTER TABLE "project_recognition" ADD CONSTRAINT "project_recognition_project_code_fk" FOREIGN KEY ("project_code") REFERENCES "public"."project"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_recognition" ADD CONSTRAINT "project_recognition_journal_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_recognition" ADD CONSTRAINT "project_recognition_reversal_fk" FOREIGN KEY ("reversal_journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_recognition" ADD CONSTRAINT "project_recognition_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE TABLE "project_etc" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_code" text NOT NULL,
	"wbs_code" text NOT NULL,
	"as_of" date NOT NULL,
	"etc_iqd" numeric(19, 4) NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_etc_amount" CHECK ("etc_iqd" >= 0),
	CONSTRAINT "project_etc_reason" CHECK (btrim("reason") <> '')
);--> statement-breakpoint
ALTER TABLE "project_etc" ADD CONSTRAINT "project_etc_project_code_fk" FOREIGN KEY ("project_code") REFERENCES "public"."project"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_etc" ADD CONSTRAINT "project_etc_wbs_fk" FOREIGN KEY ("project_code", "wbs_code") REFERENCES "public"."project_wbs"("project_code", "code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_etc" ADD CONSTRAINT "project_etc_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_etc_element_idx" ON "project_etc" USING btree ("project_code", "wbs_code", "as_of");--> statement-breakpoint

-- Row-level security.
DO $$
DECLARE t text;
BEGIN
	FOREACH t IN ARRAY ARRAY['project_billing_plan_line', 'project_recognition', 'project_etc'] LOOP
		EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
		EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
		EXECUTE format(
			'CREATE POLICY %I ON %I USING (EXISTS (SELECT 1 FROM project p WHERE p.code = project_code)) '
			'WITH CHECK (EXISTS (SELECT 1 FROM project p WHERE p.code = project_code))',
			t || '_scope', t);
	END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "project_recognition_policy" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_recognition_policy" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY project_recognition_policy_scope ON "project_recognition_policy" USING (app_signed_in()) WITH CHECK (app_signed_in());--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	GRANT SELECT, INSERT, UPDATE ON "project_billing_plan_line", "project_recognition", "project_recognition_policy" TO erp_app;
	GRANT SELECT, INSERT ON "project_etc" TO erp_app;
END $$;--> statement-breakpoint

-- The two posting events: the receivable and the revenue as the Sales Invoice maps them.
INSERT INTO posting_rule (event_type, line_role, account_id, is_active, created_by)
SELECT 'projects.certificate', CASE r.line_role WHEN 'sales_revenue' THEN 'project_revenue' ELSE r.line_role END, r.account_id, true, r.created_by
  FROM posting_rule r
 WHERE r.event_type = 'sales.ar_invoice' AND r.line_role IN ('customer_receivable', 'sales_revenue')
   AND r.is_active
   AND r.item_group IS NULL AND r.partner_group IS NULL AND r.warehouse_code IS NULL
   AND r.project_code IS NULL AND r.branch_code IS NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO posting_rule (event_type, line_role, account_id, is_active, created_by)
SELECT 'projects.recognition', 'project_revenue', r.account_id, true, r.created_by
  FROM posting_rule r
 WHERE r.event_type = 'sales.ar_invoice' AND r.line_role = 'sales_revenue'
   AND r.is_active
   AND r.item_group IS NULL AND r.partner_group IS NULL AND r.warehouse_code IS NULL
   AND r.project_code IS NULL AND r.branch_code IS NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
	('project_recognition', 'Revenue recognition', 'projects', 'A customer project''s revenue recognised to a period end by percentage of completion, cost to cost, against what was billed; reversed next period (REQ-PM-001 §11, D-PM-1).')
ON CONFLICT (code) DO NOTHING;
