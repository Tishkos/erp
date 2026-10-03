-- ===========================================================================
-- REQ-HR-001 Stage HR-1 — People and organisation (2026-10-02).
--
--   position                 the organisation's seats (§5)
--   employee                 one record per person, where they are now (§4, R1)
--   employee_history         every dated change — append-only (R3)
--   employee_compensation    salary rows, dated, in their own table so the
--                            grant and the policy cover them apart from
--                            identity (R5, D-HR-7)
--   pay_component, leave_type, working_calendar, working_calendar_holiday
--                            configuration as master data (R4), seeded,
--                            inert until HR-2 and HR-3
--
-- Roles: hr_officer (identity), hr_manager (identity + compensation + the
-- settings). The accounting manager and the CEO read compensation (D-HR-7).
-- The compensation policy asks the database itself whether the session's
-- user holds the grant — app_has_grant — so the service's refusal and the
-- screen's hiding are backed by a row the database will not return (H2).
-- ===========================================================================

CREATE FUNCTION app_has_grant(p_object text, p_verb text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app_is_super_user()
      OR EXISTS (
           SELECT 1
             FROM user_role ur
             JOIN role_grant g ON g.role_code = ur.role_code
            WHERE ur.user_id = app_current_user()
              AND g.object = p_object
              AND g.verb::text = p_verb
         );
$$;--> statement-breakpoint

CREATE TABLE "position" (
	"code" text PRIMARY KEY,
	"title_en" text NOT NULL,
	"title_ar" text,
	"department_code" text NOT NULL REFERENCES "department"("code"),
	"reports_to_code" text REFERENCES "position"("code"),
	"active" boolean NOT NULL DEFAULT true,
	"created_by" uuid REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "position_not_own_parent" CHECK ("reports_to_code" IS NULL OR "reports_to_code" <> "code")
);--> statement-breakpoint
CREATE INDEX "position_department_idx" ON "position" ("department_code");--> statement-breakpoint

CREATE TABLE "employee" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"employee_no" text NOT NULL,
	"full_name_en" text NOT NULL,
	"full_name_ar" text,
	"national_id" text,
	"date_of_birth" date,
	"phone" text,
	"address" text,
	"emergency_contact" text,
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	"department_code" text NOT NULL REFERENCES "department"("code"),
	"position_code" text REFERENCES "position"("code"),
	"manager_employee_id" uuid REFERENCES "employee"("id"),
	"hire_date" date NOT NULL,
	"employment_kind" text NOT NULL DEFAULT 'permanent',
	"status" text NOT NULL DEFAULT 'active',
	"end_date" date,
	"end_reason" text,
	"app_user_id" uuid REFERENCES "app_user"("id"),
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "employee_kind" CHECK ("employment_kind" IN ('permanent', 'contract', 'daily')),
	CONSTRAINT "employee_status" CHECK ("status" IN ('active', 'suspended', 'ended')),
	CONSTRAINT "employee_ended_has_date" CHECK (("status" = 'ended') = ("end_date" IS NOT NULL)),
	CONSTRAINT "employee_not_own_manager" CHECK ("manager_employee_id" IS NULL OR "manager_employee_id" <> "id")
);--> statement-breakpoint
CREATE UNIQUE INDEX "employee_no_uniq" ON "employee" ("employee_no");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_app_user_uniq" ON "employee" ("app_user_id") WHERE "app_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "employee_branch_idx" ON "employee" ("branch_code", "status");--> statement-breakpoint
CREATE INDEX "employee_department_idx" ON "employee" ("department_code");--> statement-breakpoint
CREATE INDEX "employee_manager_idx" ON "employee" ("manager_employee_id");--> statement-breakpoint

CREATE TABLE "employee_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"employee_id" uuid NOT NULL REFERENCES "employee"("id"),
	"effective_from" date NOT NULL,
	"field" text NOT NULL,
	"before_value" text,
	"after_value" text,
	"reason" text,
	"recorded_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"recorded_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX "employee_history_employee_idx" ON "employee_history" ("employee_id", "effective_from", "recorded_at");--> statement-breakpoint
CREATE TRIGGER "employee_history_append_only"
	BEFORE UPDATE OR DELETE ON "employee_history"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

CREATE TABLE "employee_compensation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"employee_id" uuid NOT NULL REFERENCES "employee"("id"),
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	"effective_from" date NOT NULL,
	"base_salary_iqd" numeric(20, 4) NOT NULL,
	"pay_method" text NOT NULL DEFAULT 'bank',
	"bank_code" text REFERENCES "bank"("code"),
	"account_number" text,
	"iban" text,
	"note" text,
	"recorded_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"recorded_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "employee_compensation_salary_not_negative" CHECK ("base_salary_iqd" >= 0),
	CONSTRAINT "employee_compensation_method" CHECK ("pay_method" IN ('bank', 'cash'))
);--> statement-breakpoint
CREATE INDEX "employee_compensation_employee_idx" ON "employee_compensation" ("employee_id", "effective_from");--> statement-breakpoint
CREATE TRIGGER "employee_compensation_append_only"
	BEFORE UPDATE OR DELETE ON "employee_compensation"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

CREATE TABLE "pay_component" (
	"code" text PRIMARY KEY,
	"name_en" text NOT NULL,
	"name_ar" text,
	"kind" text NOT NULL,
	"calculation" text NOT NULL,
	"default_value" numeric(20, 4) NOT NULL DEFAULT 0,
	"taxable" boolean NOT NULL DEFAULT true,
	"active" boolean NOT NULL DEFAULT true,
	"sort_order" smallint NOT NULL DEFAULT 100,
	"created_by" uuid REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "pay_component_kind" CHECK ("kind" IN ('earning', 'deduction', 'employer_cost')),
	CONSTRAINT "pay_component_calculation" CHECK ("calculation" IN ('fixed', 'percent_of_base', 'manual'))
);--> statement-breakpoint

CREATE TABLE "leave_type" (
	"code" text PRIMARY KEY,
	"name_en" text NOT NULL,
	"name_ar" text,
	"days_per_year" numeric(6, 2) NOT NULL DEFAULT 0,
	"carry_over_days" numeric(6, 2) NOT NULL DEFAULT 0,
	"paid" boolean NOT NULL DEFAULT true,
	"requires_attachment" boolean NOT NULL DEFAULT false,
	"allowed_negative_days" numeric(6, 2) NOT NULL DEFAULT 0,
	"active" boolean NOT NULL DEFAULT true,
	"created_by" uuid REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "leave_type_days" CHECK ("days_per_year" >= 0 AND "carry_over_days" >= 0 AND "allowed_negative_days" >= 0)
);--> statement-breakpoint

CREATE TABLE "working_calendar" (
	"code" text PRIMARY KEY,
	"name_en" text NOT NULL,
	"name_ar" text,
	"year" integer NOT NULL,
	"working_days" text NOT NULL,
	"active" boolean NOT NULL DEFAULT true,
	"created_by" uuid REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "working_calendar_year" CHECK ("year" BETWEEN 2000 AND 2100)
);--> statement-breakpoint

CREATE TABLE "working_calendar_holiday" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"calendar_code" text NOT NULL REFERENCES "working_calendar"("code"),
	"holiday_date" date NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text
);--> statement-breakpoint
CREATE UNIQUE INDEX "working_calendar_holiday_uniq" ON "working_calendar_holiday" ("calendar_code", "holiday_date");--> statement-breakpoint

-- Row security: identity by branch, as every document; compensation by
-- branch and by the grant, asked of the database (H2); the masters by
-- sign-in.
ALTER TABLE "position" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "position" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY position_scope ON "position" USING (app_signed_in()) WITH CHECK (app_signed_in());--> statement-breakpoint

ALTER TABLE "employee" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "employee" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY employee_scope ON "employee"
	USING (app_is_super_user() OR app_branch_allowed("branch_code") OR "app_user_id" = app_current_user())
	WITH CHECK (app_is_super_user() OR app_branch_allowed("branch_code"));--> statement-breakpoint

ALTER TABLE "employee_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "employee_history" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY employee_history_scope ON "employee_history"
	USING (app_is_super_user() OR EXISTS (SELECT 1 FROM "employee" e WHERE e."id" = "employee_id"))
	WITH CHECK (app_signed_in());--> statement-breakpoint

ALTER TABLE "employee_compensation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "employee_compensation" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY employee_compensation_scope ON "employee_compensation"
	USING ((app_is_super_user() OR app_branch_allowed("branch_code")) AND app_has_grant('employee_compensation', 'view'))
	WITH CHECK ((app_is_super_user() OR app_branch_allowed("branch_code")) AND app_has_grant('employee_compensation', 'create'));--> statement-breakpoint

ALTER TABLE "pay_component" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pay_component" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY pay_component_scope ON "pay_component" USING (app_signed_in()) WITH CHECK (app_signed_in());--> statement-breakpoint
ALTER TABLE "leave_type" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "leave_type" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY leave_type_scope ON "leave_type" USING (app_signed_in()) WITH CHECK (app_signed_in());--> statement-breakpoint
ALTER TABLE "working_calendar" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "working_calendar" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY working_calendar_scope ON "working_calendar" USING (app_signed_in()) WITH CHECK (app_signed_in());--> statement-breakpoint
ALTER TABLE "working_calendar_holiday" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "working_calendar_holiday" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY working_calendar_holiday_scope ON "working_calendar_holiday" USING (app_signed_in()) WITH CHECK (app_signed_in());--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	GRANT EXECUTE ON FUNCTION app_has_grant(text, text) TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON "position", "employee", "pay_component", "leave_type", "working_calendar" TO erp_app;
	GRANT SELECT, INSERT, UPDATE, DELETE ON "working_calendar_holiday" TO erp_app;
	-- History and compensation: inserted, never changed (the trigger holds it for everyone else).
	GRANT SELECT, INSERT ON "employee_history", "employee_compensation" TO erp_app;
END $$;--> statement-breakpoint

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('EMPLOYEE', 'EMP', '{PREFIX}-{BRANCH}-{SERIAL}', 4, true, false)
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
	('employee', 'Employee', 'hr', 'One record per person: identity, where they work, dated history (REQ-HR-001 §4).')
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

INSERT INTO role (code, name, description, is_system, requires_mfa) VALUES
	('hr_officer', 'HR Officer', 'Maintains the employee register and the organisation; sees no salary (REQ-HR-001 D-HR-7).', true, false),
	('hr_manager', 'HR Manager', 'Maintains people, compensation and the HR settings; approves leave (REQ-HR-001 D-HR-1, D-HR-7).', true, true)
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb)
SELECT r.role_code, o.object, v.verb
  FROM (VALUES ('hr_officer'), ('hr_manager')) AS r(role_code)
 CROSS JOIN unnest(ARRAY['employee', 'org_structure']) AS o(object)
 CROSS JOIN unnest(ARRAY['view', 'create', 'edit_draft', 'configure', 'print', 'export']::permission_verb[]) AS v(verb)
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
	('hr_manager',         'employee',              'administer'),
	('hr_manager',         'employee_compensation', 'view'),
	('hr_manager',         'employee_compensation', 'create'),
	('hr_manager',         'hr_setting',            'view'),
	('hr_manager',         'hr_setting',            'configure'),
	('hr_officer',         'hr_setting',            'view'),
	('accounting_manager', 'employee',              'view'),
	('accounting_manager', 'employee_compensation', 'view'),
	('accounting_manager', 'org_structure',         'view'),
	('ceo',                'employee',              'view'),
	('ceo',                'employee_compensation', 'view'),
	('ceo',                'org_structure',         'view'),
	('ceo',                'hr_setting',            'view'),
	('system_administrator', 'hr_setting',          'view'),
	('system_administrator', 'hr_setting',          'configure')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- The configuration, seeded as rows the HR manager edits (R4). The
-- statutory rates are D-HR-3's proposed defaults, to be confirmed by the
-- accountant before HR-3 is built.
INSERT INTO pay_component (code, name_en, name_ar, kind, calculation, default_value, taxable, sort_order) VALUES
	('BASE',        'Base salary',                     'الراتب الأساسي',              'earning',       'fixed',           0,  true,  10),
	('HOUSING',     'Housing allowance',               'بدل السكن',                   'earning',       'fixed',           0,  true,  20),
	('TRANSPORT',   'Transport allowance',             'بدل النقل',                   'earning',       'fixed',           0,  true,  30),
	('OVERTIME',    'Overtime',                        'عمل إضافي',                   'earning',       'manual',          0,  true,  40),
	('ABSENCE',     'Absence deduction',               'خصم الغياب',                  'deduction',     'manual',          0,  false, 50),
	('SS_EMPLOYEE', 'Social security — employee share','الضمان الاجتماعي — حصة الموظف','deduction',     'percent_of_base', 5,  false, 60),
	('INCOME_TAX',  'Income tax',                      'ضريبة الدخل',                 'deduction',     'manual',          0,  false, 70),
	('SS_EMPLOYER', 'Social security — employer share','الضمان الاجتماعي — حصة الشركة','employer_cost', 'percent_of_base', 12, false, 80)
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

INSERT INTO leave_type (code, name_en, name_ar, days_per_year, carry_over_days, paid, requires_attachment, allowed_negative_days) VALUES
	('ANNUAL', 'Annual leave', 'إجازة سنوية', 30, 10, true, false, 0),
	('SICK',   'Sick leave',   'إجازة مرضية', 30, 0,  true, true,  5),
	('UNPAID', 'Unpaid leave', 'إجازة بدون راتب', 0, 0, false, false, 0)
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

INSERT INTO working_calendar (code, name_en, name_ar, year, working_days) VALUES
	('IQ-2026', 'Iraq 2026', 'العراق 2026', 2026, 'sun,mon,tue,wed,thu')
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

INSERT INTO working_calendar_holiday (calendar_code, holiday_date, name_en, name_ar) VALUES
	('IQ-2026', '2026-01-01', 'New Year''s Day', 'رأس السنة الميلادية'),
	('IQ-2026', '2026-01-06', 'Army Day', 'عيد الجيش'),
	('IQ-2026', '2026-03-21', 'Nowruz', 'نوروز'),
	('IQ-2026', '2026-05-01', 'Labour Day', 'عيد العمال'),
	('IQ-2026', '2026-10-03', 'National Day', 'اليوم الوطني'),
	('IQ-2026', '2026-12-25', 'Christmas Day', 'عيد الميلاد')
ON CONFLICT DO NOTHING;
