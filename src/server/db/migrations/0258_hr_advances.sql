-- REQ-HR-001 Stage HR-4 — advances & loans, and what a person holds (§10).
--
--   employee_advance           EADV-{BRANCH}-{YYYY}-{SERIAL}: money the company
--                              lends a person — a salary advance (one
--                              instalment) or a loan (several). draft →
--                              submitted → endorsed (their manager or the HR
--                              manager) → approved (Finance) → paid → settled;
--                              refused with a note, cancelled with a reason
--                              before it is paid. Neither approval is the
--                              requester's or the person's (database checks).
--   employee_advance_recovery  what came back, append-only: a payroll run's
--                              deduction (and its reversal), or cash handed in.
--                              The advance's `recovered_iqd` is their sum.
--   employee_asset             what a person holds — a fixed asset or another
--                              item, with its serial — handed out and returned
--                              with the condition each way; a leaver's
--                              clearance is what is still out.
--
-- A salary advance is not the petty-cash `cash_advance` (B-HR-18): that is a
-- custodian's float settled by receipts; this is the person's debt recovered
-- from pay. They share the posting engine, the bank and cash accounts and the
-- ageing buckets, not a table.
--
-- Payroll recovers it: the seeded deduction ADVANCE (`advance_recovery`)
-- takes what the schedule says is due by the month, never more than is owed,
-- never so much the net goes below nothing; posting the run writes the
-- recovery rows and credits `employee_advance`, reversing it writes them back.

ALTER TABLE "pay_component" DROP CONSTRAINT "pay_component_calculation";--> statement-breakpoint
ALTER TABLE "pay_component" ADD CONSTRAINT "pay_component_calculation"
	CHECK ("calculation" IN ('base_salary', 'fixed', 'percent_of_base', 'manual', 'absence', 'advance_recovery'));--> statement-breakpoint
ALTER TABLE "pay_component" DROP CONSTRAINT "pay_component_calculation_kind";--> statement-breakpoint
ALTER TABLE "pay_component" ADD CONSTRAINT "pay_component_calculation_kind"
	CHECK (("calculation" <> 'base_salary' OR "kind" = 'earning') AND ("calculation" NOT IN ('absence', 'advance_recovery') OR "kind" = 'deduction'));--> statement-breakpoint
DROP INDEX "pay_component_one_base";--> statement-breakpoint
CREATE UNIQUE INDEX "pay_component_one_base" ON "pay_component" ("calculation") WHERE "active" AND "calculation" IN ('base_salary', 'absence', 'advance_recovery');--> statement-breakpoint
INSERT INTO pay_component (code, name_en, name_ar, kind, calculation, default_value, taxable, sort_order) VALUES
	('ADVANCE', 'Advance and loan recovery', 'استرداد السلف والقروض', 'deduction', 'advance_recovery', 0, false, 65)
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

CREATE TABLE "employee_advance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"advance_no" text NOT NULL,
	"employee_id" uuid NOT NULL REFERENCES "employee"("id"),
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	"kind" text NOT NULL,
	"amount_iqd" numeric(20, 4) NOT NULL,
	"instalments" smallint NOT NULL DEFAULT 1,
	"first_recovery_month" date NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL DEFAULT 'draft',
	"recovered_iqd" numeric(20, 4) NOT NULL DEFAULT 0,
	"requested_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	"submitted_at" timestamptz,
	"endorsed_by" uuid REFERENCES "app_user"("id"),
	"endorsed_at" timestamptz,
	"approved_by" uuid REFERENCES "app_user"("id"),
	"approved_at" timestamptz,
	"decision_note" text,
	"refused_by" uuid REFERENCES "app_user"("id"),
	"refused_at" timestamptz,
	"paid_by" uuid REFERENCES "app_user"("id"),
	"paid_at" timestamptz,
	"paid_on" date,
	"bank_cash_account_id" uuid REFERENCES "bank_cash_account"("id"),
	"payment_reference" text,
	"journal_entry_id" uuid REFERENCES "journal_entry"("id"),
	"settled_at" timestamptz,
	"cancelled_by" uuid REFERENCES "app_user"("id"),
	"cancelled_at" timestamptz,
	"cancel_reason" text,
	CONSTRAINT "employee_advance_kind" CHECK ("kind" IN ('advance', 'loan')),
	CONSTRAINT "employee_advance_status" CHECK ("status" IN ('draft', 'submitted', 'endorsed', 'approved', 'paid', 'settled', 'refused', 'cancelled')),
	CONSTRAINT "employee_advance_amount" CHECK ("amount_iqd" > 0),
	CONSTRAINT "employee_advance_instalments" CHECK ("instalments" BETWEEN 1 AND 60),
	CONSTRAINT "employee_advance_month" CHECK ("first_recovery_month" = date_trunc('month', "first_recovery_month")::date),
	CONSTRAINT "employee_advance_recovered" CHECK ("recovered_iqd" >= 0 AND "recovered_iqd" <= "amount_iqd"),
	CONSTRAINT "employee_advance_settled" CHECK (("status" = 'settled') = ("recovered_iqd" = "amount_iqd" AND "paid_at" IS NOT NULL)),
	CONSTRAINT "employee_advance_paid_has_journal" CHECK ("status" NOT IN ('paid', 'settled') OR "journal_entry_id" IS NOT NULL),
	CONSTRAINT "employee_advance_endorser_not_requester" CHECK ("endorsed_by" IS NULL OR "endorsed_by" <> "requested_by"),
	CONSTRAINT "employee_advance_approver_not_requester" CHECK ("approved_by" IS NULL OR ("approved_by" <> "requested_by" AND "approved_by" <> "endorsed_by")),
	CONSTRAINT "employee_advance_refusal_has_note" CHECK ("status" <> 'refused' OR nullif(btrim("decision_note"), '') IS NOT NULL),
	CONSTRAINT "employee_advance_cancel_has_reason" CHECK ("status" <> 'cancelled' OR nullif(btrim("cancel_reason"), '') IS NOT NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX "employee_advance_no_uniq" ON "employee_advance" ("advance_no");--> statement-breakpoint
CREATE INDEX "employee_advance_employee_idx" ON "employee_advance" ("employee_id", "status");--> statement-breakpoint
CREATE INDEX "employee_advance_status_idx" ON "employee_advance" ("status", "branch_code");--> statement-breakpoint

CREATE TABLE "employee_advance_recovery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"advance_id" uuid NOT NULL REFERENCES "employee_advance"("id"),
	"source" text NOT NULL,
	"month" date NOT NULL,
	"amount_iqd" numeric(20, 4) NOT NULL,
	"run_id" uuid REFERENCES "payroll_run"("id"),
	"line_id" uuid REFERENCES "payroll_line"("id"),
	"bank_cash_account_id" uuid REFERENCES "bank_cash_account"("id"),
	"journal_entry_id" uuid REFERENCES "journal_entry"("id"),
	"reference" text,
	"recorded_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"recorded_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "employee_advance_recovery_source" CHECK ("source" IN ('payroll', 'payroll_reversal', 'cash')),
	CONSTRAINT "employee_advance_recovery_sign" CHECK (("source" = 'payroll_reversal') = ("amount_iqd" < 0) AND "amount_iqd" <> 0),
	CONSTRAINT "employee_advance_recovery_payroll" CHECK ("source" = 'cash' OR "run_id" IS NOT NULL),
	CONSTRAINT "employee_advance_recovery_cash" CHECK ("source" <> 'cash' OR ("bank_cash_account_id" IS NOT NULL AND "journal_entry_id" IS NOT NULL))
);--> statement-breakpoint
CREATE INDEX "employee_advance_recovery_advance_idx" ON "employee_advance_recovery" ("advance_id", "month");--> statement-breakpoint
CREATE INDEX "employee_advance_recovery_run_idx" ON "employee_advance_recovery" ("run_id");--> statement-breakpoint
CREATE TRIGGER "employee_advance_recovery_append_only"
	BEFORE UPDATE OR DELETE ON "employee_advance_recovery"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

CREATE TABLE "employee_asset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL REFERENCES "employee"("id"),
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	"asset_kind" text NOT NULL,
	"fixed_asset_id" uuid REFERENCES "fixed_asset"("id"),
	"description" text NOT NULL,
	"serial_no" text,
	"handed_out_on" date NOT NULL,
	"out_condition" text,
	"handed_out_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"returned_on" date,
	"return_condition" text,
	"returned_by" uuid REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "employee_asset_kind" CHECK ("asset_kind" IN ('fixed_asset', 'item')),
	CONSTRAINT "employee_asset_fixed_named" CHECK (("asset_kind" = 'fixed_asset') = ("fixed_asset_id" IS NOT NULL)),
	CONSTRAINT "employee_asset_return" CHECK (("returned_on" IS NULL) = ("returned_by" IS NULL) AND ("returned_on" IS NULL OR "returned_on" >= "handed_out_on"))
);--> statement-breakpoint
CREATE INDEX "employee_asset_employee_idx" ON "employee_asset" ("employee_id", "returned_on");--> statement-breakpoint
-- One person holds a fixed asset at a time.
CREATE UNIQUE INDEX "employee_asset_out_uniq" ON "employee_asset" ("fixed_asset_id") WHERE "returned_on" IS NULL AND "fixed_asset_id" IS NOT NULL;--> statement-breakpoint

-- Row security: by branch, as every document, and — as a leave request — the
-- person and their manager through `app_employee_reach`.
ALTER TABLE "employee_advance" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "employee_advance" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY employee_advance_scope ON "employee_advance"
	USING (app_is_super_user() OR app_branch_allowed("branch_code") OR app_employee_reach("employee_id"))
	WITH CHECK (app_is_super_user() OR app_branch_allowed("branch_code") OR app_employee_reach("employee_id"));--> statement-breakpoint
ALTER TABLE "employee_advance_recovery" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "employee_advance_recovery" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY employee_advance_recovery_scope ON "employee_advance_recovery"
	USING (EXISTS (SELECT 1 FROM employee_advance a WHERE a.id = "advance_id"))
	WITH CHECK (EXISTS (SELECT 1 FROM employee_advance a WHERE a.id = "advance_id"));--> statement-breakpoint
ALTER TABLE "employee_asset" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "employee_asset" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY employee_asset_scope ON "employee_asset"
	USING (app_is_super_user() OR app_branch_allowed("branch_code") OR app_employee_reach("employee_id"))
	WITH CHECK (app_is_super_user() OR app_branch_allowed("branch_code"));--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	GRANT SELECT, INSERT, UPDATE ON "employee_advance", "employee_asset" TO erp_app;
	GRANT SELECT, INSERT ON "employee_advance_recovery" TO erp_app;
END $$;--> statement-breakpoint

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('EMPLOYEE_ADVANCE', 'EADV', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 5, true, true)
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
	('employee_advance', 'Employee advance or loan', 'hr', 'Money lent to a person, recovered from their pay or handed back (REQ-HR-001 §10).'),
	('employee_advance_repayment', 'Advance repaid in cash', 'hr', 'Cash a person hands back against their advance or loan (REQ-HR-001 §10).'),
	('employee_asset', 'Employee asset', 'hr', 'Equipment a person holds: handed out and returned, with its condition (REQ-HR-001 §10).')
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

-- D-HR-1: an advance is endorsed by the person's manager (by the link) or an
-- HR manager, approved by the accounting manager, paid by Finance. HR enters
-- requests and keeps the equipment register; the CEO reads.
INSERT INTO role_grant (role_code, object, verb)
SELECT r.role_code, o.object, v.verb
  FROM (VALUES ('hr_officer'), ('hr_manager')) AS r(role_code)
 CROSS JOIN unnest(ARRAY['employee_advance', 'employee_asset']) AS o(object)
 CROSS JOIN unnest(ARRAY['view', 'create', 'edit_draft', 'print', 'export']::permission_verb[]) AS v(verb)
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
	('hr_manager',         'employee_advance', 'approve'),
	('accounting_manager', 'employee_advance', 'view'),
	('accounting_manager', 'employee_advance', 'post'),
	('accounting_manager', 'employee_advance', 'execute'),
	('accounting_manager', 'employee_advance', 'print'),
	('accounting_manager', 'employee_advance', 'export'),
	('accounting_manager', 'employee_asset',   'view'),
	('ceo',                'employee_advance', 'view'),
	('ceo',                'employee_advance', 'print'),
	('ceo',                'employee_asset',   'view')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- The sweep tells the HR managers of an advance its recoveries are behind.
INSERT INTO notification_rule (code, description, event_type, recipient_role, channels) VALUES
	('hr_advance_behind', 'An employee advance or loan is behind its recovery schedule (REQ-HR-001 HR-4).', 'hr.advance_behind', 'hr_manager', ARRAY['in_app'])
ON CONFLICT (code) DO NOTHING;
