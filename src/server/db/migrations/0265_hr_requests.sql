-- REQ-HR-001 Stage HR-6 — employee requests and employee documents (§10,
-- §11a "Employee Requests", "Documents").
--
--   employee_request         one table, four kinds, each with its own series:
--                              expense_claim  ECLM-{BRANCH}-{YYYY}-{SERIAL}: lines by expense
--                                             category with their receipts; approved, then
--                                             reimbursed by Finance from a bank or cash
--                                             account (hr.expense_claim) — net of the trip's
--                                             advance when it names one (D-HR-5, B-HR-28)
--                              travel         TRV-…: destination, dates, estimated cost;
--                                             approved, it may open an employee advance
--                              letter         LTR-…: an employment or experience letter;
--                                             approved, issued by HR with its text kept
--                              other          ERQ-…: anything else, approved or refused
--                            draft → submitted → approved / refused; approved → paid (a
--                            claim) or issued (a letter); cancelled with a reason until then.
--                            Asked by HR or by the person (R5); decided by the person's
--                            manager (the link) or an HR manager — never by the asker or the
--                            person (a check and a trigger).
--   employee_request_line    a claim's lines — changed only while it is a draft (trigger).
--   employee_document        EDOC-{BRANCH}-{SERIAL}: a person's contract, ID, passport,
--                            permit, certificate… its file kept with the attachments; its
--                            expiry raised by the sweep; renewed by a new row that
--                            supersedes it, withdrawn with a reason — never deleted.
--   employee_advance_recovery  gains `claim`: a claim that settles a trip's advance.

CREATE TABLE "employee_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_no" text NOT NULL,
	"kind" text NOT NULL,
	"employee_id" uuid NOT NULL REFERENCES "employee"("id"),
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	"subject" text NOT NULL,
	"details" text,
	"destination" text,
	"travel_from" date,
	"travel_to" date,
	"estimated_iqd" numeric(20, 4),
	"letter_type" text,
	"addressed_to" text,
	"amount_iqd" numeric(20, 4) NOT NULL DEFAULT 0,
	"travel_request_id" uuid REFERENCES "employee_request"("id"),
	"advance_id" uuid REFERENCES "employee_advance"("id"),
	"status" text NOT NULL DEFAULT 'draft',
	"requested_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	"submitted_at" timestamptz,
	"decided_by" uuid REFERENCES "app_user"("id"),
	"decided_at" timestamptz,
	"decision_note" text,
	"paid_by" uuid REFERENCES "app_user"("id"),
	"paid_at" timestamptz,
	"paid_on" date,
	"bank_cash_account_id" uuid REFERENCES "bank_cash_account"("id"),
	"payment_reference" text,
	"advance_offset_iqd" numeric(20, 4) NOT NULL DEFAULT 0,
	"journal_entry_id" uuid REFERENCES "journal_entry"("id"),
	"issued_by" uuid REFERENCES "app_user"("id"),
	"issued_at" timestamptz,
	"issued_text" text,
	"cancelled_by" uuid REFERENCES "app_user"("id"),
	"cancelled_at" timestamptz,
	"cancel_reason" text,
	CONSTRAINT "employee_request_kind" CHECK ("kind" IN ('expense_claim', 'travel', 'letter', 'other')),
	CONSTRAINT "employee_request_status" CHECK ("status" IN ('draft', 'submitted', 'approved', 'refused', 'paid', 'issued', 'cancelled')),
	CONSTRAINT "employee_request_paid_is_claim" CHECK ("status" <> 'paid' OR ("kind" = 'expense_claim' AND "journal_entry_id" IS NOT NULL AND "paid_on" IS NOT NULL)),
	CONSTRAINT "employee_request_issued_is_letter" CHECK ("status" <> 'issued' OR ("kind" = 'letter' AND nullif(btrim("issued_text"), '') IS NOT NULL)),
	CONSTRAINT "employee_request_travel" CHECK ("kind" <> 'travel' OR (nullif(btrim("destination"), '') IS NOT NULL AND "travel_from" IS NOT NULL AND "travel_to" IS NOT NULL AND "travel_to" >= "travel_from")),
	CONSTRAINT "employee_request_letter" CHECK ("kind" <> 'letter' OR "letter_type" IN ('employment', 'experience', 'other')),
	CONSTRAINT "employee_request_amounts" CHECK ("amount_iqd" >= 0 AND ("estimated_iqd" IS NULL OR "estimated_iqd" >= 0) AND "advance_offset_iqd" >= 0 AND "advance_offset_iqd" <= "amount_iqd"),
	CONSTRAINT "employee_request_decider_not_requester" CHECK ("decided_by" IS NULL OR "decided_by" <> "requested_by"),
	CONSTRAINT "employee_request_refusal_has_note" CHECK ("status" <> 'refused' OR nullif(btrim("decision_note"), '') IS NOT NULL),
	CONSTRAINT "employee_request_cancel_has_reason" CHECK ("status" <> 'cancelled' OR nullif(btrim("cancel_reason"), '') IS NOT NULL),
	CONSTRAINT "employee_request_trip_is_claims" CHECK ("travel_request_id" IS NULL OR "kind" = 'expense_claim'),
	CONSTRAINT "employee_request_advance_is_trips" CHECK ("advance_id" IS NULL OR "kind" = 'travel')
);--> statement-breakpoint
CREATE UNIQUE INDEX "employee_request_no_uniq" ON "employee_request" ("request_no");--> statement-breakpoint
CREATE INDEX "employee_request_employee_idx" ON "employee_request" ("employee_id", "status");--> statement-breakpoint
CREATE INDEX "employee_request_status_idx" ON "employee_request" ("status", "branch_code");--> statement-breakpoint
-- One advance per trip.
CREATE UNIQUE INDEX "employee_request_advance_uniq" ON "employee_request" ("advance_id") WHERE "advance_id" IS NOT NULL;--> statement-breakpoint

CREATE TABLE "employee_request_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL REFERENCES "employee_request"("id"),
	"line_no" smallint NOT NULL,
	"spent_on" date NOT NULL,
	"expense_category_code" text NOT NULL REFERENCES "expense_category"("code"),
	"description" text NOT NULL,
	"amount_iqd" numeric(20, 4) NOT NULL,
	CONSTRAINT "employee_request_line_amount" CHECK ("amount_iqd" > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "employee_request_line_uniq" ON "employee_request_line" ("request_id", "line_no");--> statement-breakpoint

-- The person on a request neither decides it nor pays it to themself.
CREATE FUNCTION employee_request_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
	person uuid;
BEGIN
	SELECT e.app_user_id INTO person FROM employee e WHERE e.id = NEW.employee_id;
	IF person IS NOT NULL AND (NEW.decided_by = person OR NEW.paid_by = person) THEN
		RAISE EXCEPTION 'A person does not decide or pay their own request (%).', NEW.request_no USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "employee_request_guard"
	BEFORE INSERT OR UPDATE ON "employee_request"
	FOR EACH ROW EXECUTE FUNCTION employee_request_guard();--> statement-breakpoint

-- A claim's lines are what was submitted: changed only on a draft.
CREATE FUNCTION employee_request_line_frozen() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
	request_status text;
	request uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.request_id ELSE NEW.request_id END;
BEGIN
	SELECT r.status INTO request_status FROM employee_request r WHERE r.id = request;
	IF request_status IS DISTINCT FROM 'draft' THEN
		RAISE EXCEPTION 'The request is %; its lines change only while it is a draft.', request_status USING ERRCODE = 'check_violation';
	END IF;
	RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "employee_request_line_frozen"
	BEFORE INSERT OR UPDATE OR DELETE ON "employee_request_line"
	FOR EACH ROW EXECUTE FUNCTION employee_request_line_frozen();--> statement-breakpoint

CREATE TABLE "employee_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_no" text NOT NULL,
	"employee_id" uuid NOT NULL REFERENCES "employee"("id"),
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	"doc_type" text NOT NULL,
	"title" text NOT NULL,
	"reference_no" text,
	"issued_on" date,
	"expires_on" date,
	"note" text,
	"status" text NOT NULL DEFAULT 'valid',
	"replaces_id" uuid REFERENCES "employee_document"("id"),
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	"withdrawn_by" uuid REFERENCES "app_user"("id"),
	"withdrawn_at" timestamptz,
	"withdraw_reason" text,
	CONSTRAINT "employee_document_type" CHECK ("doc_type" IN ('contract', 'national_id', 'passport', 'residence', 'work_permit', 'certificate', 'licence', 'handover', 'other')),
	CONSTRAINT "employee_document_status" CHECK ("status" IN ('valid', 'superseded', 'withdrawn')),
	CONSTRAINT "employee_document_dates" CHECK ("expires_on" IS NULL OR "issued_on" IS NULL OR "expires_on" >= "issued_on"),
	CONSTRAINT "employee_document_withdrawn" CHECK ("status" <> 'withdrawn' OR nullif(btrim("withdraw_reason"), '') IS NOT NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX "employee_document_no_uniq" ON "employee_document" ("document_no");--> statement-breakpoint
CREATE INDEX "employee_document_employee_idx" ON "employee_document" ("employee_id", "status");--> statement-breakpoint
CREATE INDEX "employee_document_expiry_idx" ON "employee_document" ("expires_on") WHERE "status" = 'valid';--> statement-breakpoint
-- A document is renewed once: one successor each.
CREATE UNIQUE INDEX "employee_document_replaces_uniq" ON "employee_document" ("replaces_id") WHERE "replaces_id" IS NOT NULL;--> statement-breakpoint

-- Whether the reader is the person themself — their own documents, not their manager's reading.
CREATE FUNCTION app_is_employee(p_employee uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT EXISTS (SELECT 1 FROM employee e WHERE e.id = p_employee AND e.app_user_id = app_current_user());
$$;--> statement-breakpoint

-- A claim that settles its trip's advance is a recovery too (HR-6).
ALTER TABLE "employee_advance_recovery" ADD COLUMN "request_id" uuid REFERENCES "employee_request"("id");--> statement-breakpoint
ALTER TABLE "employee_advance_recovery" DROP CONSTRAINT "employee_advance_recovery_source";--> statement-breakpoint
ALTER TABLE "employee_advance_recovery" ADD CONSTRAINT "employee_advance_recovery_source" CHECK ("source" IN ('payroll', 'payroll_reversal', 'cash', 'claim'));--> statement-breakpoint
ALTER TABLE "employee_advance_recovery" DROP CONSTRAINT "employee_advance_recovery_payroll";--> statement-breakpoint
ALTER TABLE "employee_advance_recovery" ADD CONSTRAINT "employee_advance_recovery_payroll" CHECK ("source" IN ('cash', 'claim') OR "run_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "employee_advance_recovery" ADD CONSTRAINT "employee_advance_recovery_claim" CHECK ("source" <> 'claim' OR ("request_id" IS NOT NULL AND "journal_entry_id" IS NOT NULL));--> statement-breakpoint

ALTER TABLE "employee_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "employee_request" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- A claim is somebody's spending: HR and Finance by their grant and branch,
-- the person and their manager (the link) — not everybody in the branch.
CREATE POLICY employee_request_scope ON "employee_request"
	USING (app_is_super_user() OR (app_branch_allowed("branch_code") AND app_has_grant('employee_request', 'view')) OR app_employee_reach("employee_id"))
	WITH CHECK (app_is_super_user() OR (app_branch_allowed("branch_code") AND app_has_grant('employee_request', 'view')) OR app_employee_reach("employee_id"));--> statement-breakpoint
ALTER TABLE "employee_request_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "employee_request_line" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY employee_request_line_scope ON "employee_request_line"
	USING (EXISTS (SELECT 1 FROM employee_request r WHERE r.id = "request_id"))
	WITH CHECK (EXISTS (SELECT 1 FROM employee_request r WHERE r.id = "request_id"));--> statement-breakpoint
-- A person's papers: HR by its grant and branch, and the person — not everybody in the branch.
ALTER TABLE "employee_document" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "employee_document" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY employee_document_scope ON "employee_document"
	USING (app_is_super_user() OR (app_branch_allowed("branch_code") AND app_has_grant('employee_document', 'view')) OR app_is_employee("employee_id"))
	WITH CHECK (app_is_super_user() OR (app_branch_allowed("branch_code") AND app_has_grant('employee_document', 'view')));--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	GRANT EXECUTE ON FUNCTION app_is_employee(uuid) TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON "employee_request", "employee_document" TO erp_app;
	-- A draft claim's lines are replaced as the form sends them; the trigger keeps a submitted one's.
	GRANT SELECT, INSERT, UPDATE, DELETE ON "employee_request_line" TO erp_app;
END $$;--> statement-breakpoint

INSERT INTO hr_parameter ("key", "value") VALUES ('document_expiry_warning_days', 30) ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year) VALUES
	('EXPENSE_CLAIM', 'ECLM', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 5, true, true),
	('TRAVEL_REQUEST', 'TRV', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 5, true, true),
	('HR_LETTER', 'LTR', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 5, true, true),
	('EMPLOYEE_REQUEST', 'ERQ', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 5, true, true),
	('EMPLOYEE_DOCUMENT', 'EDOC', '{PREFIX}-{BRANCH}-{SERIAL}', 5, true, false)
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
	('expense_claim', 'Expense claim', 'hr', 'What a person spent for the company, reimbursed once approved (REQ-HR-001 §10).'),
	('travel_request', 'Travel request', 'hr', 'A trip asked for and approved; it may open an advance its claim settles (REQ-HR-001 §10).'),
	('hr_letter', 'HR letter', 'hr', 'An employment or experience letter, issued by HR (REQ-HR-001 HR-6).'),
	('employee_request', 'Employee request', 'hr', 'Anything else a person asks HR for (REQ-HR-001 HR-6).'),
	('employee_document', 'Employee document', 'hr', 'A person''s contract, ID, passport, permit or certificate, with its expiry (REQ-HR-001 HR-6).')
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

-- D-HR-1 read for requests: HR enters and the person may ask (no grant); the
-- manager (the link) or the HR manager decides; Finance reimburses a claim.
-- HR keeps the documents; HR, Finance and the CEO read the HR reports.
INSERT INTO role_grant (role_code, object, verb)
SELECT r.role_code, o.object, v.verb
  FROM (VALUES ('hr_officer'), ('hr_manager')) AS r(role_code)
 CROSS JOIN unnest(ARRAY['employee_request', 'employee_document']) AS o(object)
 CROSS JOIN unnest(ARRAY['view', 'create', 'edit_draft', 'print', 'export']::permission_verb[]) AS v(verb)
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb)
SELECT r.role_code, 'hr_report', v.verb
  FROM (VALUES ('hr_officer'), ('hr_manager'), ('accounting_manager'), ('ceo')) AS r(role_code)
 CROSS JOIN unnest(ARRAY['view', 'print', 'export']::permission_verb[]) AS v(verb)
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
	('hr_manager',         'employee_request', 'approve'),
	('accounting_manager', 'employee_request', 'view'),
	('accounting_manager', 'employee_request', 'execute'),
	('accounting_manager', 'employee_request', 'print'),
	('accounting_manager', 'employee_request', 'export'),
	('ceo',                'employee_request', 'view'),
	('ceo',                'employee_document', 'view')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- The sweep tells the HR managers of a document about to expire.
INSERT INTO notification_rule (code, description, event_type, recipient_role, channels) VALUES
	('hr_document_expiring', 'An employee''s document expires soon (REQ-HR-001 HR-6).', 'hr.document_expiring', 'hr_manager', ARRAY['in_app'])
ON CONFLICT (code) DO NOTHING;
