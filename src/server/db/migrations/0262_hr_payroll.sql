-- REQ-HR-001 Stage HR-3 — payroll (§6, §9).
--
--   pay_component            two calculations that read the facts instead of a
--                            typed figure: `base_salary` (the compensation row
--                            in force) and `absence` (the day sheet's absences
--                            and unpaid leave, at the day's rate). Two optional
--                            accounts: where an earning or an employer cost is
--                            expensed, where a deduction or an employer cost is
--                            owed. Empty, the posting mapping decides (§3.3).
--   employee_pay_component   a person's own figure for a component — an
--                            allowance, a different rate — or its stop; dated,
--                            append-only, under the compensation grant (R5).
--   payroll_run              PAY-{BRANCH}-{YYYY}-{SERIAL}: one live run per
--                            branch per month. draft → submitted → approved →
--                            posted → paid; reversed whole, cancelled before
--                            posting. Whoever prepared or sent it never
--                            approves it (a database check).
--   payroll_line             one person's month: the days the sheet read, the
--                            figures, and — once posted — the payslip number.
--   payroll_line_component   each component of the line, as computed or (a
--                            manual one) typed with its note.
--   payroll_payment          the net pay of one pay method (bank or cash)
--                            leaving one bank or cash account: its journal.
--
-- Lines and their components are frozen once the run posts (a trigger): a
-- posted payslip is a fact, and a wrong run is reversed and run again (R3).
--
-- Row security: a run and its lines by branch *and* the payroll grant, asked
-- of the database (`app_has_grant`) as the compensation rows are; a person
-- reads their own posted payslip (R5) through `app_own_payslip`, and of its
-- run only what the payslip prints (`app_payslip_header`) — never the run's
-- totals, which are the branch's whole pay.

ALTER TABLE "pay_component" ADD COLUMN "expense_account_id" uuid REFERENCES "chart_of_account"("id");--> statement-breakpoint
ALTER TABLE "pay_component" ADD COLUMN "liability_account_id" uuid REFERENCES "chart_of_account"("id");--> statement-breakpoint
ALTER TABLE "pay_component" DROP CONSTRAINT "pay_component_calculation";--> statement-breakpoint
ALTER TABLE "pay_component" ADD CONSTRAINT "pay_component_calculation"
	CHECK ("calculation" IN ('base_salary', 'fixed', 'percent_of_base', 'manual', 'absence'));--> statement-breakpoint
-- The seeded base salary and absence deduction read the facts from now on.
UPDATE "pay_component" SET "calculation" = 'base_salary', "updated_at" = now() WHERE "code" = 'BASE' AND "calculation" = 'fixed';--> statement-breakpoint
UPDATE "pay_component" SET "calculation" = 'absence', "updated_at" = now() WHERE "code" = 'ABSENCE' AND "calculation" = 'manual';--> statement-breakpoint
ALTER TABLE "pay_component" ADD CONSTRAINT "pay_component_calculation_kind"
	CHECK (("calculation" <> 'base_salary' OR "kind" = 'earning') AND ("calculation" <> 'absence' OR "kind" = 'deduction'));--> statement-breakpoint
-- One base and one absence deduction at a time: two would pay or take twice.
CREATE UNIQUE INDEX "pay_component_one_base" ON "pay_component" ("calculation") WHERE "active" AND "calculation" IN ('base_salary', 'absence');--> statement-breakpoint

CREATE TABLE "employee_pay_component" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL REFERENCES "employee"("id"),
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	"component_code" text NOT NULL REFERENCES "pay_component"("code"),
	"effective_from" date NOT NULL,
	-- IQD a month for a fixed component, a percentage for a percent one; null with a stop.
	"amount" numeric(20, 4),
	"stopped" boolean NOT NULL DEFAULT false,
	"note" text,
	"recorded_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"recorded_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "employee_pay_component_amount_or_stop" CHECK ("stopped" = ("amount" IS NULL)),
	CONSTRAINT "employee_pay_component_not_negative" CHECK ("amount" IS NULL OR "amount" >= 0)
);--> statement-breakpoint
CREATE INDEX "employee_pay_component_idx" ON "employee_pay_component" ("employee_id", "component_code", "effective_from");--> statement-breakpoint
CREATE TRIGGER "employee_pay_component_append_only"
	BEFORE UPDATE OR DELETE ON "employee_pay_component"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

CREATE TABLE "payroll_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_no" text NOT NULL,
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	"period_month" date NOT NULL,
	"period_end" date NOT NULL,
	"pay_date" date NOT NULL,
	"status" text NOT NULL DEFAULT 'draft',
	"working_days" smallint NOT NULL,
	"employees" integer NOT NULL DEFAULT 0,
	"gross_iqd" numeric(20, 4) NOT NULL DEFAULT 0,
	"deductions_iqd" numeric(20, 4) NOT NULL DEFAULT 0,
	"net_iqd" numeric(20, 4) NOT NULL DEFAULT 0,
	"employer_cost_iqd" numeric(20, 4) NOT NULL DEFAULT 0,
	"paid_iqd" numeric(20, 4) NOT NULL DEFAULT 0,
	"note" text,
	"computed_at" timestamptz NOT NULL DEFAULT now(),
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	"submitted_by" uuid REFERENCES "app_user"("id"),
	"submitted_at" timestamptz,
	"returned_by" uuid REFERENCES "app_user"("id"),
	"returned_at" timestamptz,
	"return_note" text,
	"approved_by" uuid REFERENCES "app_user"("id"),
	"approved_at" timestamptz,
	"posted_by" uuid REFERENCES "app_user"("id"),
	"posted_at" timestamptz,
	"journal_entry_id" uuid REFERENCES "journal_entry"("id"),
	"reversed_by" uuid REFERENCES "app_user"("id"),
	"reversed_at" timestamptz,
	"reversal_reason" text,
	"reversal_journal_entry_id" uuid REFERENCES "journal_entry"("id"),
	"cancelled_by" uuid REFERENCES "app_user"("id"),
	"cancelled_at" timestamptz,
	"cancel_reason" text,
	CONSTRAINT "payroll_run_status" CHECK ("status" IN ('draft', 'submitted', 'approved', 'posted', 'paid', 'reversed', 'cancelled')),
	CONSTRAINT "payroll_run_month" CHECK ("period_month" = date_trunc('month', "period_month")::date AND "period_end" = ("period_month" + interval '1 month' - interval '1 day')::date),
	CONSTRAINT "payroll_run_working_days" CHECK ("working_days" >= 0 AND "working_days" <= 31),
	CONSTRAINT "payroll_run_approver_not_preparer" CHECK ("approved_by" IS NULL OR ("approved_by" <> "created_by" AND "approved_by" IS DISTINCT FROM "submitted_by")),
	CONSTRAINT "payroll_run_posted_has_journal" CHECK ("status" NOT IN ('posted', 'paid', 'reversed') OR "journal_entry_id" IS NOT NULL),
	CONSTRAINT "payroll_run_reversal" CHECK ("status" <> 'reversed' OR (nullif(btrim("reversal_reason"), '') IS NOT NULL AND "reversal_journal_entry_id" IS NOT NULL)),
	CONSTRAINT "payroll_run_cancel_has_reason" CHECK ("status" <> 'cancelled' OR nullif(btrim("cancel_reason"), '') IS NOT NULL),
	CONSTRAINT "payroll_run_paid_within_net" CHECK ("paid_iqd" >= 0 AND "paid_iqd" <= "net_iqd")
);--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_run_no_uniq" ON "payroll_run" ("run_no");--> statement-breakpoint
-- One live run per branch per month; a reversed or cancelled one leaves room for the rerun.
CREATE UNIQUE INDEX "payroll_run_live_uniq" ON "payroll_run" ("branch_code", "period_month") WHERE "status" NOT IN ('reversed', 'cancelled');--> statement-breakpoint
CREATE INDEX "payroll_run_status_idx" ON "payroll_run" ("status", "branch_code");--> statement-breakpoint

CREATE TABLE "payroll_payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL REFERENCES "payroll_run"("id"),
	"pay_method" text NOT NULL,
	"bank_cash_account_id" uuid NOT NULL REFERENCES "bank_cash_account"("id"),
	"paid_on" date NOT NULL,
	"reference" text,
	"amount_iqd" numeric(20, 4) NOT NULL,
	"lines" integer NOT NULL,
	"journal_entry_id" uuid NOT NULL REFERENCES "journal_entry"("id"),
	"paid_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"paid_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "payroll_payment_method" CHECK ("pay_method" IN ('bank', 'cash')),
	CONSTRAINT "payroll_payment_amount" CHECK ("amount_iqd" > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_payment_run_method_uniq" ON "payroll_payment" ("run_id", "pay_method");--> statement-breakpoint
CREATE TRIGGER "payroll_payment_append_only"
	BEFORE UPDATE OR DELETE ON "payroll_payment"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

CREATE TABLE "payroll_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL REFERENCES "payroll_run"("id"),
	"employee_id" uuid NOT NULL REFERENCES "employee"("id"),
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	"employee_no" text NOT NULL,
	"full_name_en" text NOT NULL,
	"full_name_ar" text,
	"department_code" text NOT NULL REFERENCES "department"("code"),
	"position_title" text,
	"compensation_id" uuid REFERENCES "employee_compensation"("id"),
	"pay_method" text NOT NULL DEFAULT 'bank',
	"bank_code" text,
	"account_number" text,
	"iban" text,
	"working_days" smallint NOT NULL,
	"employed_days" smallint NOT NULL,
	"present_days" smallint NOT NULL DEFAULT 0,
	"absent_days" smallint NOT NULL DEFAULT 0,
	"unrecorded_days" smallint NOT NULL DEFAULT 0,
	"paid_leave_days" numeric(6, 2) NOT NULL DEFAULT 0,
	"unpaid_leave_days" numeric(6, 2) NOT NULL DEFAULT 0,
	"base_salary_iqd" numeric(20, 4) NOT NULL DEFAULT 0,
	"gross_iqd" numeric(20, 4) NOT NULL DEFAULT 0,
	"deductions_iqd" numeric(20, 4) NOT NULL DEFAULT 0,
	"net_iqd" numeric(20, 4) NOT NULL DEFAULT 0,
	"employer_cost_iqd" numeric(20, 4) NOT NULL DEFAULT 0,
	"payslip_no" text,
	"issued_at" timestamptz,
	"payment_id" uuid REFERENCES "payroll_payment"("id"),
	CONSTRAINT "payroll_line_method" CHECK ("pay_method" IN ('bank', 'cash')),
	CONSTRAINT "payroll_line_net" CHECK ("net_iqd" = "gross_iqd" - "deductions_iqd"),
	CONSTRAINT "payroll_line_days" CHECK ("employed_days" >= 0 AND "employed_days" <= "working_days")
);--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_line_run_employee_uniq" ON "payroll_line" ("run_id", "employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_line_payslip_uniq" ON "payroll_line" ("payslip_no") WHERE "payslip_no" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payroll_line_employee_idx" ON "payroll_line" ("employee_id");--> statement-breakpoint

CREATE TABLE "payroll_line_component" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_id" uuid NOT NULL REFERENCES "payroll_line"("id"),
	"component_code" text NOT NULL REFERENCES "pay_component"("code"),
	"name_en" text NOT NULL,
	"name_ar" text,
	"kind" text NOT NULL,
	"calculation" text NOT NULL,
	-- The percentage a percent component applied; the days (hundredths) an absence counted.
	"rate" numeric(9, 4),
	"quantity" numeric(8, 2),
	"amount_iqd" numeric(20, 4) NOT NULL DEFAULT 0,
	"note" text,
	"sort_order" smallint NOT NULL DEFAULT 100,
	CONSTRAINT "payroll_line_component_kind" CHECK ("kind" IN ('earning', 'deduction', 'employer_cost')),
	CONSTRAINT "payroll_line_component_amount" CHECK ("amount_iqd" >= 0),
	-- A typed figure says why (§9: "typed on the line with a note").
	CONSTRAINT "payroll_line_component_manual_note" CHECK ("calculation" <> 'manual' OR "amount_iqd" = 0 OR nullif(btrim("note"), '') IS NOT NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_line_component_uniq" ON "payroll_line_component" ("line_id", "component_code");--> statement-breakpoint

-- A posted run's lines are its payslips: their figures do not change, and
-- nothing is taken out. Only the payment that settled a line is written on it.
CREATE FUNCTION payroll_line_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	v_status text;
	v_run uuid;
BEGIN
	IF TG_TABLE_NAME = 'payroll_line' THEN
		v_run := OLD.run_id;
	ELSE
		SELECT l.run_id INTO v_run FROM payroll_line l WHERE l.id = OLD.line_id;
	END IF;
	SELECT r.status INTO v_status FROM payroll_run r WHERE r.id = v_run;
	IF v_status IN ('posted', 'paid', 'reversed') THEN
		IF TG_OP = 'DELETE' THEN
			RAISE EXCEPTION 'Payroll run % is %: its lines are payslips and are not removed (REQ-HR-001 R3).', v_run, v_status
				USING ERRCODE = 'restrict_violation';
		END IF;
		IF TG_TABLE_NAME = 'payroll_line_component' THEN
			RAISE EXCEPTION 'Payroll run % is %: a payslip''s components do not change (REQ-HR-001 R3).', v_run, v_status
				USING ERRCODE = 'restrict_violation';
		END IF;
		IF (NEW.employee_id, NEW.gross_iqd, NEW.deductions_iqd, NEW.net_iqd, NEW.employer_cost_iqd, NEW.base_salary_iqd, NEW.pay_method, NEW.payslip_no)
		   IS DISTINCT FROM (OLD.employee_id, OLD.gross_iqd, OLD.deductions_iqd, OLD.net_iqd, OLD.employer_cost_iqd, OLD.base_salary_iqd, OLD.pay_method, OLD.payslip_no)
		   AND OLD.payslip_no IS NOT NULL THEN
			RAISE EXCEPTION 'Payroll run % is %: a payslip''s figures do not change (REQ-HR-001 R3).', v_run, v_status
				USING ERRCODE = 'restrict_violation';
		END IF;
	END IF;
	RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "payroll_line_frozen"
	BEFORE UPDATE OR DELETE ON "payroll_line"
	FOR EACH ROW EXECUTE FUNCTION payroll_line_frozen();--> statement-breakpoint
CREATE TRIGGER "payroll_line_component_frozen"
	BEFORE UPDATE OR DELETE ON "payroll_line_component"
	FOR EACH ROW EXECUTE FUNCTION payroll_line_frozen();--> statement-breakpoint

-- The person's own payslip: a line of a posted run that is theirs. A definer
-- function, so the payslip reads whatever the person's branches; it answers
-- yes or no, nothing of the rows.
CREATE FUNCTION app_own_payslip(p_line uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT EXISTS (
		SELECT 1
		  FROM payroll_line l
		  JOIN payroll_run r ON r.id = l.run_id
		  JOIN employee e ON e.id = l.employee_id
		 WHERE l.id = p_line
		   AND l.payslip_no IS NOT NULL
		   AND r.status IN ('posted', 'paid', 'reversed')
		   AND e.app_user_id = app_current_user()
	);
$$;--> statement-breakpoint

-- Treasury's forecast reads the pay still to go out — approved and posted
-- runs, by pay date — without reading a salary: totals only, by the
-- reader's branches (REQ-HR-001 HR-3, the cash forecast's payroll source).
CREATE FUNCTION app_payroll_outflows(p_from date, p_to date, p_branch text)
RETURNS TABLE (pay_date date, amount_iqd numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT r.pay_date, sum(r.net_iqd - r.paid_iqd)
	  FROM payroll_run r
	 WHERE r.status IN ('approved', 'posted')
	   AND r.net_iqd > r.paid_iqd
	   AND r.pay_date BETWEEN p_from AND p_to
	   AND (p_branch IS NULL OR r.branch_code = p_branch)
	   AND (app_is_super_user() OR app_branch_allowed(r.branch_code))
	 GROUP BY r.pay_date;
$$;--> statement-breakpoint

-- The month's close asks whether every branch that employed anybody has its
-- payroll posted: the branches without a posted run, and the runs still on
-- their way. Read the same whoever runs the checklist.
CREATE FUNCTION app_payroll_month_gaps(p_month date)
RETURNS TABLE (branch_code text, run_no text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT b.branch_code, r.run_no, coalesce(r.status, 'none')
	  FROM (SELECT DISTINCT e.branch_code
	          FROM employee e
	         WHERE e.hire_date <= (p_month + interval '1 month' - interval '1 day')::date
	           AND (e.end_date IS NULL OR e.end_date >= p_month)
	           AND e.status <> 'suspended') b
	  LEFT JOIN payroll_run r
	    ON r.branch_code = b.branch_code AND r.period_month = p_month AND r.status NOT IN ('reversed', 'cancelled')
	 WHERE r.id IS NULL OR r.status NOT IN ('posted', 'paid')
	 ORDER BY b.branch_code;
$$;--> statement-breakpoint

ALTER TABLE "employee_pay_component" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "employee_pay_component" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY employee_pay_component_scope ON "employee_pay_component"
	USING ((app_is_super_user() OR app_branch_allowed("branch_code")) AND app_has_grant('employee_compensation', 'view'))
	WITH CHECK ((app_is_super_user() OR app_branch_allowed("branch_code")) AND app_has_grant('employee_compensation', 'create'));--> statement-breakpoint

ALTER TABLE "payroll_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payroll_run" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY payroll_run_scope ON "payroll_run"
	USING ((app_is_super_user() OR app_branch_allowed("branch_code")) AND app_has_grant('payroll_run', 'view'))
	WITH CHECK ((app_is_super_user() OR app_branch_allowed("branch_code")) AND app_has_grant('payroll_run', 'view'));--> statement-breakpoint

-- What a payslip says of its run — the number, the month, the status, the
-- pay date and the day it was paid — without opening the run (whose totals
-- are the branch's whole pay) to the person reading their own payslip.
CREATE FUNCTION app_payslip_header(p_line uuid)
RETURNS TABLE (run_no text, status text, branch_code text, period_month date, period_end date, pay_date date, paid_on date, payment_reference text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT r.run_no, r.status, r.branch_code, r.period_month, r.period_end, r.pay_date, p.paid_on, p.reference
	  FROM payroll_line l
	  JOIN payroll_run r ON r.id = l.run_id
	  LEFT JOIN payroll_payment p ON p.id = l.payment_id
	 WHERE l.id = p_line
	   AND (app_own_payslip(l.id)
	        OR ((app_is_super_user() OR app_branch_allowed(r.branch_code)) AND app_has_grant('payroll_run', 'view')));
$$;--> statement-breakpoint

ALTER TABLE "payroll_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payroll_line" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY payroll_line_scope ON "payroll_line"
	USING (((app_is_super_user() OR app_branch_allowed("branch_code")) AND app_has_grant('payroll_run', 'view')) OR app_own_payslip("id"))
	WITH CHECK ((app_is_super_user() OR app_branch_allowed("branch_code")) AND app_has_grant('payroll_run', 'view'));--> statement-breakpoint

ALTER TABLE "payroll_line_component" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payroll_line_component" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY payroll_line_component_scope ON "payroll_line_component"
	USING (EXISTS (SELECT 1 FROM payroll_line l WHERE l.id = "line_id"))
	WITH CHECK (EXISTS (SELECT 1 FROM payroll_line l WHERE l.id = "line_id"));--> statement-breakpoint

ALTER TABLE "payroll_payment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payroll_payment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY payroll_payment_scope ON "payroll_payment"
	USING (EXISTS (SELECT 1 FROM payroll_run r WHERE r.id = "run_id"))
	WITH CHECK (EXISTS (SELECT 1 FROM payroll_run r WHERE r.id = "run_id"));--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	GRANT EXECUTE ON FUNCTION app_own_payslip(uuid), app_payslip_header(uuid), app_payroll_outflows(date, date, text), app_payroll_month_gaps(date) TO erp_app;
	GRANT SELECT, INSERT ON "employee_pay_component", "payroll_payment" TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON "payroll_run" TO erp_app;
	-- A draft's lines are recomputed whole; the trigger keeps a posted run's.
	GRANT SELECT, INSERT, UPDATE, DELETE ON "payroll_line", "payroll_line_component" TO erp_app;
END $$;--> statement-breakpoint

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year) VALUES
	('PAYROLL_RUN', 'PAY', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 4, true, true),
	('PAYSLIP', 'PSL', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true)
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
	('payroll_run', 'Payroll run', 'hr', 'One branch''s month of pay: computed from compensation, components and attendance, posted to the ledger (REQ-HR-001 §9).'),
	('payroll_payment', 'Payroll payment', 'hr', 'The net pay of one pay method leaving a bank or cash account (REQ-HR-001 §9).'),
	('payslip', 'Payslip', 'hr', 'One person''s line of a posted payroll run (REQ-HR-001 §9).')
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

-- D-HR-1 read with D-HR-7 (B-HR-13): the run is a sheet of salaries, so it is
-- prepared by whoever reads compensation — the HR manager; it is approved by
-- the accounting manager or the CEO (never by its preparer, a database check)
-- and posted and paid by Finance. The CEO reads.
INSERT INTO role_grant (role_code, object, verb) VALUES
	('hr_manager',         'payroll_run', 'view'),
	('hr_manager',         'payroll_run', 'create'),
	('hr_manager',         'payroll_run', 'edit_draft'),
	('hr_manager',         'payroll_run', 'submit'),
	('hr_manager',         'payroll_run', 'print'),
	('hr_manager',         'payroll_run', 'export'),
	('accounting_manager', 'payroll_run', 'view'),
	('accounting_manager', 'payroll_run', 'approve'),
	('accounting_manager', 'payroll_run', 'post'),
	('accounting_manager', 'payroll_run', 'execute'),
	('accounting_manager', 'payroll_run', 'reverse_cancel'),
	('accounting_manager', 'payroll_run', 'print'),
	('accounting_manager', 'payroll_run', 'export'),
	('ceo',                'payroll_run', 'view'),
	('ceo',                'payroll_run', 'approve'),
	('ceo',                'payroll_run', 'print'),
	('ceo',                'payroll_run', 'export')
ON CONFLICT DO NOTHING;
