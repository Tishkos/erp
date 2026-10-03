-- REQ-HR-001 Stage HR-2 — time: leave and attendance (§7, §8).
--
--   leave_request        LVE-{BRANCH}-{YYYY}-{SERIAL}: draft → submitted →
--                        approved / refused; cancelled with a reason. The
--                        days are counted on the year's working calendar and
--                        stored on the request when it is submitted.
--   leave_balance_entry  an opening balance or an adjustment, dated by year,
--                        with its reason — append-only (R3). Entitlement and
--                        carry-over are never stored: they derive (R2).
--   attendance_day       what the day sheet recorded for one person on one
--                        day: present or absent, the optional in/out times.
--                        Leave and holidays are not rows: a day reads the
--                        approved leave over it, then the sheet, then the
--                        calendar (B-HR-9), so cancelling a leave deletes
--                        nothing.
--   hr_parameter         the sweep's limits as rows (R4).
--   employee.contract_end_date — a contract's end, history like the rest.
--   leave_type.warn_before_lapse — the types the year-end sweep warns about.
--
-- Row security: by branch, as every document, and — for a leave request — the
-- employee themself and their manager, through `app_employee_reach`, which
-- answers from the employee rows whatever the reader's branches.

ALTER TABLE "employee" ADD COLUMN "contract_end_date" date;--> statement-breakpoint
-- Which types the year-end sweep warns about (annual leave; not sick leave,
-- whose unused days are expected to lapse).
ALTER TABLE "leave_type" ADD COLUMN "warn_before_lapse" boolean NOT NULL DEFAULT false;--> statement-breakpoint
UPDATE "leave_type" SET "warn_before_lapse" = true WHERE "code" = 'ANNUAL';--> statement-breakpoint
ALTER TABLE "employee" ADD CONSTRAINT "employee_contract_end_after_hire"
	CHECK ("contract_end_date" IS NULL OR "contract_end_date" >= "hire_date");--> statement-breakpoint

CREATE TABLE "leave_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_no" text NOT NULL,
	"employee_id" uuid NOT NULL REFERENCES "employee"("id"),
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	"leave_type_code" text NOT NULL REFERENCES "leave_type"("code"),
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"half_day_start" boolean NOT NULL DEFAULT false,
	"half_day_end" boolean NOT NULL DEFAULT false,
	"days" numeric(6, 2) NOT NULL DEFAULT 0,
	"reason" text,
	"status" text NOT NULL DEFAULT 'draft',
	"requested_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"submitted_at" timestamptz,
	"decided_by" uuid REFERENCES "app_user"("id"),
	"decided_at" timestamptz,
	"decision_note" text,
	"cancelled_by" uuid REFERENCES "app_user"("id"),
	"cancelled_at" timestamptz,
	"cancel_reason" text,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "leave_request_status" CHECK ("status" IN ('draft', 'submitted', 'approved', 'refused', 'cancelled')),
	CONSTRAINT "leave_request_span" CHECK ("to_date" >= "from_date"),
	CONSTRAINT "leave_request_days" CHECK ("days" >= 0),
	CONSTRAINT "leave_request_refusal_has_note" CHECK ("status" <> 'refused' OR nullif(btrim("decision_note"), '') IS NOT NULL),
	CONSTRAINT "leave_request_cancel_has_reason" CHECK ("status" <> 'cancelled' OR nullif(btrim("cancel_reason"), '') IS NOT NULL),
	CONSTRAINT "leave_request_decider_not_requester" CHECK ("decided_by" IS NULL OR "decided_by" <> "requested_by")
);--> statement-breakpoint
CREATE UNIQUE INDEX "leave_request_no_uniq" ON "leave_request" ("request_no");--> statement-breakpoint
CREATE INDEX "leave_request_employee_idx" ON "leave_request" ("employee_id", "from_date");--> statement-breakpoint
CREATE INDEX "leave_request_status_idx" ON "leave_request" ("status", "branch_code");--> statement-breakpoint

CREATE TABLE "leave_balance_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL REFERENCES "employee"("id"),
	"leave_type_code" text NOT NULL REFERENCES "leave_type"("code"),
	"year" integer NOT NULL,
	"days" numeric(6, 2) NOT NULL,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"recorded_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"recorded_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "leave_balance_entry_kind" CHECK ("kind" IN ('opening', 'adjustment')),
	CONSTRAINT "leave_balance_entry_reason" CHECK (nullif(btrim("reason"), '') IS NOT NULL),
	CONSTRAINT "leave_balance_entry_not_zero" CHECK ("days" <> 0)
);--> statement-breakpoint
CREATE INDEX "leave_balance_entry_employee_idx" ON "leave_balance_entry" ("employee_id", "leave_type_code", "year");--> statement-breakpoint
CREATE TRIGGER "leave_balance_entry_append_only"
	BEFORE UPDATE OR DELETE ON "leave_balance_entry"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

CREATE TABLE "attendance_day" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL REFERENCES "employee"("id"),
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	"day" date NOT NULL,
	"status" text NOT NULL,
	"check_in" time,
	"check_out" time,
	"note" text,
	"recorded_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"recorded_at" timestamptz NOT NULL DEFAULT now(),
	"updated_by" uuid REFERENCES "app_user"("id"),
	"updated_at" timestamptz,
	CONSTRAINT "attendance_day_status" CHECK ("status" IN ('present', 'absent')),
	CONSTRAINT "attendance_day_times" CHECK ("check_in" IS NULL OR "check_out" IS NULL OR "check_out" >= "check_in"),
	CONSTRAINT "attendance_day_absent_has_no_times" CHECK ("status" <> 'absent' OR ("check_in" IS NULL AND "check_out" IS NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_day_employee_day_uniq" ON "attendance_day" ("employee_id", "day");--> statement-breakpoint
CREATE INDEX "attendance_day_branch_day_idx" ON "attendance_day" ("branch_code", "day");--> statement-breakpoint

CREATE TABLE "hr_parameter" (
	"key" text PRIMARY KEY NOT NULL,
	"value" integer NOT NULL,
	"updated_by" uuid REFERENCES "app_user"("id"),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "hr_parameter_value" CHECK ("value" >= 0 AND "value" <= 366)
);--> statement-breakpoint
INSERT INTO "hr_parameter" ("key", "value") VALUES
	('contract_expiry_warning_days', 30),
	('leave_pending_reminder_days', 3),
	('leave_lapse_warning_days', 45)
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

-- Who the employee is to the reader: themself, or their manager. A definer
-- function, so a manager in another branch still reaches their report's
-- request; it reveals a yes or a no, nothing of the rows.
CREATE FUNCTION app_employee_reach(p_employee uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT EXISTS (
		SELECT 1
		  FROM employee e
		  LEFT JOIN employee m ON m.id = e.manager_employee_id
		 WHERE e.id = p_employee
		   AND (e.app_user_id = app_current_user() OR m.app_user_id = app_current_user())
	);
$$;--> statement-breakpoint

ALTER TABLE "leave_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "leave_request" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY leave_request_scope ON "leave_request"
	USING (app_is_super_user() OR app_branch_allowed("branch_code") OR app_employee_reach("employee_id"))
	WITH CHECK (app_is_super_user() OR app_branch_allowed("branch_code") OR app_employee_reach("employee_id"));--> statement-breakpoint

ALTER TABLE "leave_balance_entry" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "leave_balance_entry" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY leave_balance_entry_scope ON "leave_balance_entry"
	USING (app_is_super_user() OR EXISTS (SELECT 1 FROM "employee" e WHERE e."id" = "employee_id") OR app_employee_reach("employee_id"))
	WITH CHECK (app_is_super_user() OR EXISTS (SELECT 1 FROM "employee" e WHERE e."id" = "employee_id"));--> statement-breakpoint

ALTER TABLE "attendance_day" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attendance_day" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY attendance_day_scope ON "attendance_day"
	USING (app_is_super_user() OR app_branch_allowed("branch_code") OR app_employee_reach("employee_id"))
	WITH CHECK (app_is_super_user() OR app_branch_allowed("branch_code"));--> statement-breakpoint

ALTER TABLE "hr_parameter" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hr_parameter" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY hr_parameter_scope ON "hr_parameter" USING (app_signed_in()) WITH CHECK (app_signed_in());--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	GRANT EXECUTE ON FUNCTION app_employee_reach(uuid) TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON "leave_request", "attendance_day", "hr_parameter" TO erp_app;
	-- Opening balances and adjustments: written, never changed (the trigger holds it).
	GRANT SELECT, INSERT ON "leave_balance_entry" TO erp_app;
END $$;--> statement-breakpoint

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('LEAVE_REQUEST', 'LVE', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true)
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
	('leave_request', 'Leave request', 'hr', 'A request for leave: counted on the working calendar, decided by the manager or the HR manager (REQ-HR-001 §8).'),
	('attendance', 'Attendance', 'hr', 'One person''s day as the day sheet recorded it (REQ-HR-001 §8).')
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

-- D-HR-1 and D-HR-7: the HR officer keeps time and enters requests; the HR
-- manager decides leave and corrects balances. The accounting manager and the
-- CEO read (payroll, HR-3, reads the same facts). The manager of the person
-- decides by the link, not by a grant. Attachments (a sick note) are filed
-- by HR as they are by accounting.
INSERT INTO role_grant (role_code, object, verb)
SELECT r.role_code, o.object, v.verb
  FROM (VALUES ('hr_officer'), ('hr_manager')) AS r(role_code)
 CROSS JOIN unnest(ARRAY['leave_request', 'attendance']) AS o(object)
 CROSS JOIN unnest(ARRAY['view', 'create', 'edit_draft', 'print', 'export']::permission_verb[]) AS v(verb)
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
	('hr_manager',         'leave_request', 'approve'),
	('hr_manager',         'leave_request', 'administer'),
	('hr_manager',         'hr_setting',    'administer'),
	('hr_officer',         'attachment',    'view'),
	('hr_officer',         'attachment',    'create'),
	('hr_manager',         'attachment',    'view'),
	('hr_manager',         'attachment',    'create'),
	('accounting_manager', 'leave_request', 'view'),
	('accounting_manager', 'attendance',    'view'),
	('ceo',                'leave_request', 'view'),
	('ceo',                'attendance',    'view')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- The sweep's notices go to the HR manager by rule; a leave decision goes to
-- named people (the requester, the person, their manager) directly.
INSERT INTO notification_rule (code, description, event_type, recipient_role, channels) VALUES
	('hr_contract_expiring', 'An employee''s contract ends soon (REQ-HR-001 HR-2).', 'hr.contract_expiring', 'hr_manager', ARRAY['in_app']),
	('hr_leave_lapsing', 'Annual leave above what carries over, near the year end (REQ-HR-001 HR-2).', 'hr.leave_lapsing', 'hr_manager', ARRAY['in_app'])
ON CONFLICT (code) DO NOTHING;
