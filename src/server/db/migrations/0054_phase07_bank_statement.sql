CREATE TYPE "public"."statement_match_status" AS ENUM('unmatched', 'suggested', 'matched', 'ignored');--> statement-breakpoint
CREATE TABLE "bank_statement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"statement_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"bank_cash_account_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"bank_reference" text,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"currency" text DEFAULT 'IQD' NOT NULL,
	"opening_balance_iqd" numeric(19, 4) NOT NULL,
	"closing_balance_iqd" numeric(19, 4) NOT NULL,
	"import_batch_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_statement_period_ordered" CHECK ("bank_statement"."period_to" >= "bank_statement"."period_from")
);
--> statement-breakpoint
CREATE TABLE "bank_statement_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"statement_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"import_key" text NOT NULL,
	"booking_date" date NOT NULL,
	"value_date" date NOT NULL,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"reference" text,
	"counterparty" text,
	"description" text,
	"match_status" "statement_match_status" DEFAULT 'unmatched' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_statement_line_amount_not_zero" CHECK ("bank_statement_line"."amount_iqd" <> 0),
	CONSTRAINT "bank_statement_line_value_date_not_before" CHECK ("bank_statement_line"."value_date" >= "bank_statement_line"."booking_date")
);
--> statement-breakpoint
CREATE TABLE "bank_statement_rejected_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"statement_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"raw_text" text NOT NULL,
	"problem" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_statement_rejected_problem_present" CHECK (btrim("bank_statement_rejected_line"."problem") <> '')
);
--> statement-breakpoint
ALTER TABLE "bank_statement" ADD CONSTRAINT "bank_statement_bank_cash_account_id_bank_cash_account_id_fk" FOREIGN KEY ("bank_cash_account_id") REFERENCES "public"."bank_cash_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement" ADD CONSTRAINT "bank_statement_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement" ADD CONSTRAINT "bank_statement_import_batch_id_import_batch_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."import_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement" ADD CONSTRAINT "bank_statement_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_line" ADD CONSTRAINT "bank_statement_line_statement_id_bank_statement_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."bank_statement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_rejected_line" ADD CONSTRAINT "bank_statement_rejected_line_statement_id_bank_statement_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."bank_statement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statement_no_uniq" ON "bank_statement" USING btree ("statement_no");--> statement-breakpoint
CREATE INDEX "bank_statement_account_idx" ON "bank_statement" USING btree ("bank_cash_account_id","period_to");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statement_bank_ref_uniq" ON "bank_statement" USING btree ("bank_cash_account_id","bank_reference") WHERE bank_reference is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statement_period_uniq" ON "bank_statement" USING btree ("bank_cash_account_id","period_from","period_to") WHERE status <> 'cancelled';--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statement_line_import_key_uniq" ON "bank_statement_line" USING btree ("import_key");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statement_line_no_uniq" ON "bank_statement_line" USING btree ("statement_id","line_no");--> statement-breakpoint
CREATE INDEX "bank_statement_line_match_idx" ON "bank_statement_line" USING btree ("match_status","booking_date");--> statement-breakpoint
CREATE INDEX "bank_statement_line_amount_idx" ON "bank_statement_line" USING btree ("amount_iqd","booking_date");--> statement-breakpoint
CREATE INDEX "bank_statement_rejected_statement_idx" ON "bank_statement_rejected_line" USING btree ("statement_id");
--> statement-breakpoint

-- ===========================================================================
-- Phase 07.6 — bank statement import (blueprint 17, 23, Appendix B)
--
-- A statement is the bank's account of what happened. Nothing here posts and
-- nothing here has a journal link: the company's own entries were made when the
-- payments and receipts were raised, and a statement line that posted would be
-- the second recording of a movement already recorded. That is how a bank
-- account comes to be double-counted.
--
-- The unique import key is the whole of "importing the same statement twice does
-- not duplicate lines". It is a fingerprint of the transaction - account, date,
-- amount, reference and which occurrence it is - rather than a row number,
-- because a row number is a fact about the file and changes when the same
-- statement is exported over a different date range.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Section 17 - a statement belongs to a *bank* account, and to its branch.
--
-- A cash float is agreed by counting it (07.5), not by reading a statement, and
-- letting one document mean both would make the exception report meaningless.
-- ---------------------------------------------------------------------------
CREATE FUNCTION bank_statement_is_of_a_bank_account() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_type   text;
  v_code   text;
  v_branch text;
BEGIN
  SELECT account_type::text, code, branch_code
    INTO v_type, v_code, v_branch
    FROM bank_cash_account WHERE id = NEW.bank_cash_account_id;

  IF v_type IS DISTINCT FROM 'bank' THEN
    RAISE EXCEPTION
      '% is a % account. A statement comes from a bank; a cash float is agreed by counting it instead (blueprint 17).',
      v_code, coalesce(v_type, 'missing')
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.branch_code IS DISTINCT FROM v_branch THEN
    RAISE EXCEPTION
      'Statement is in branch % but % belongs to %.',
      NEW.branch_code, v_code, v_branch
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER bank_statement_is_of_a_bank_account
  BEFORE INSERT OR UPDATE ON bank_statement
  FOR EACH ROW EXECUTE FUNCTION bank_statement_is_of_a_bank_account();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 17 - a statement line falls inside its statement's period.
--
-- A line dated outside the period it was imported under is a line that will be
-- reconciled against the wrong closing balance. The check is on the booking
-- date, which is the date the bank moved the money; the value date may fall
-- after the period end and legitimately does.
-- ---------------------------------------------------------------------------
CREATE FUNCTION bank_statement_line_within_period() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_from date;
  v_to   date;
  v_no   text;
BEGIN
  SELECT period_from, period_to, statement_no INTO v_from, v_to, v_no
    FROM bank_statement WHERE id = NEW.statement_id;

  IF NEW.booking_date < v_from OR NEW.booking_date > v_to THEN
    RAISE EXCEPTION
      'Line dated % is outside statement % (% to %). A line reconciled against the wrong period is reconciled against the wrong closing balance (blueprint 17).',
      NEW.booking_date, v_no, v_from, v_to
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER bank_statement_line_within_period
  BEFORE INSERT OR UPDATE ON bank_statement_line
  FOR EACH ROW EXECUTE FUNCTION bank_statement_line_within_period();--> statement-breakpoint

-- Numbering, document type, statuses and permissions.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('BANK_STATEMENT', 'BST', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('bank_statement', 'Bank Statement', 'treasury',
   'The bank''s own account of what happened on an account, held exactly as given (blueprint 17). It posts nothing - the company''s entries were made when the payments and receipts were raised. Each line carries a unique import key, so the same statement imported twice adds nothing.');--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('bank_statement', 'draft',    'approved'),
  ('bank_statement', 'draft',    'cancelled'),
  ('bank_statement', 'approved', 'draft'),
  ('bank_statement', 'approved', 'closed');--> statement-breakpoint

INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('bank_statement', 'opening_balance_iqd',
   'The bank''s figure. It is the claim the lines are checked against, so it cannot move to fit them.'),
  ('bank_statement', 'closing_balance_iqd',
   'The same, at the other end. A closing balance derived from the lines would agree with them by construction, which is exactly what has to be proved instead.'),
  ('bank_statement', 'bank_cash_account_id',
   'Whose account this is. Changing it would move a whole statement to another bank.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'bank_statement', 'view'),
  ('accounting_officer', 'bank_statement', 'create'),
  ('accounting_officer', 'bank_statement', 'import'),
  ('accounting_officer', 'bank_statement', 'print'),
  ('accounting_manager', 'bank_statement', 'view'),
  ('accounting_manager', 'bank_statement', 'create'),
  ('accounting_manager', 'bank_statement', 'import'),
  ('accounting_manager', 'bank_statement', 'approve'),
  ('accounting_manager', 'bank_statement', 'reverse_cancel'),
  ('accounting_manager', 'bank_statement', 'print'),
  ('accounting_manager', 'bank_statement', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist - grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON bank_statement, bank_statement_line, bank_statement_rejected_line FROM erp_app;

  GRANT SELECT, INSERT, UPDATE ON bank_statement               TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON bank_statement_line          TO erp_app;
  GRANT SELECT, INSERT         ON bank_statement_rejected_line TO erp_app;
END;
$$;--> statement-breakpoint

-- D10 - the branch boundary. Lines and rejected rows reach through the header.
ALTER TABLE bank_statement ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE bank_statement FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY bank_statement_branch_scope ON bank_statement
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

ALTER TABLE bank_statement_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE bank_statement_line FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY bank_statement_line_branch_scope ON bank_statement_line
  USING (EXISTS (SELECT 1 FROM bank_statement h
                  WHERE h.id = bank_statement_line.statement_id
                    AND app_branch_allowed(h.branch_code)))
  WITH CHECK (EXISTS (SELECT 1 FROM bank_statement h
                       WHERE h.id = bank_statement_line.statement_id
                         AND app_branch_allowed(h.branch_code)));--> statement-breakpoint

ALTER TABLE bank_statement_rejected_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE bank_statement_rejected_line FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY bank_statement_rejected_branch_scope ON bank_statement_rejected_line
  USING (EXISTS (SELECT 1 FROM bank_statement h
                  WHERE h.id = bank_statement_rejected_line.statement_id
                    AND app_branch_allowed(h.branch_code)))
  WITH CHECK (EXISTS (SELECT 1 FROM bank_statement h
                       WHERE h.id = bank_statement_rejected_line.statement_id
                         AND app_branch_allowed(h.branch_code)));
