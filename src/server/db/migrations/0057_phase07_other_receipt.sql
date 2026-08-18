CREATE TABLE "other_receipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"bank_cash_account_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"receipt_date" date NOT NULL,
	"currency" text DEFAULT 'IQD' NOT NULL,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"credit_account_id" uuid NOT NULL,
	"department_code" text,
	"business_line_code" text,
	"payer" text NOT NULL,
	"reference" text,
	"note" text,
	"journal_entry_id" uuid,
	"created_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "other_receipt_amount_positive" CHECK ("other_receipt"."amount_iqd" > 0),
	CONSTRAINT "other_receipt_payer_present" CHECK (btrim("other_receipt"."payer") <> ''),
	CONSTRAINT "other_receipt_posting_matches_status" CHECK (("other_receipt"."journal_entry_id" is null) = ("other_receipt"."posted_at" is null)),
	CONSTRAINT "other_receipt_posted_after_approval" CHECK ("other_receipt"."posted_at" is null
          or ("other_receipt"."approved_at" is not null and "other_receipt"."approved_at" <= "other_receipt"."posted_at"))
);
--> statement-breakpoint
ALTER TABLE "other_receipt" ADD CONSTRAINT "other_receipt_bank_cash_account_id_bank_cash_account_id_fk" FOREIGN KEY ("bank_cash_account_id") REFERENCES "public"."bank_cash_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "other_receipt" ADD CONSTRAINT "other_receipt_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "other_receipt" ADD CONSTRAINT "other_receipt_credit_account_id_chart_of_account_id_fk" FOREIGN KEY ("credit_account_id") REFERENCES "public"."chart_of_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "other_receipt" ADD CONSTRAINT "other_receipt_department_code_department_code_fk" FOREIGN KEY ("department_code") REFERENCES "public"."department"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "other_receipt" ADD CONSTRAINT "other_receipt_business_line_code_business_line_code_fk" FOREIGN KEY ("business_line_code") REFERENCES "public"."business_line"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "other_receipt" ADD CONSTRAINT "other_receipt_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "other_receipt" ADD CONSTRAINT "other_receipt_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "other_receipt" ADD CONSTRAINT "other_receipt_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "other_receipt" ADD CONSTRAINT "other_receipt_posted_by_app_user_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "other_receipt_no_uniq" ON "other_receipt" USING btree ("receipt_no");--> statement-breakpoint
CREATE INDEX "other_receipt_account_idx" ON "other_receipt" USING btree ("bank_cash_account_id","receipt_date");--> statement-breakpoint
CREATE INDEX "other_receipt_status_idx" ON "other_receipt" USING btree ("status","branch_code");--> statement-breakpoint

-- ===========================================================================
-- Phase 07.4 — Other Receipt (blueprint 17)
--
-- Money in that is not a customer settling an invoice: a supplier refund,
-- interest, the sale of something small, an insurance settlement.
--
-- It is a different document from the Customer Receipt on purpose. A customer
-- receipt settles a receivable and belongs to the A/R subledger; this one
-- credits an account somebody names and belongs to no subledger at all. One
-- document doing both would mean a receipt could go either way depending on how
-- it was filled in, and the control account would stop tying to the subledger
-- the first time somebody filled it in the other way.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Section 16 - an Other Receipt cannot credit a subledger control account.
--
-- The service refuses it too. This is the half a future code path cannot
-- forget, and it is the whole reason the document is separate: money from a
-- customer is a Customer Receipt, which allocates to their invoices; money from
-- a supplier refund belongs on their account through a credit memo. Either way
-- the subledger and the control account stay in step.
-- ---------------------------------------------------------------------------
CREATE FUNCTION other_receipt_not_to_a_control_account() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_control text;
  v_code    text;
BEGIN
  SELECT control_account::text, code INTO v_control, v_code
    FROM chart_of_account WHERE id = NEW.credit_account_id;

  IF v_control IS NOT NULL THEN
    RAISE EXCEPTION
      '% is the control account for the % subledger, and an Other Receipt cannot credit one (blueprint 16). Money from a customer is a Customer Receipt; a supplier refund belongs on their account through a credit memo.',
      v_code, v_control
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER other_receipt_not_to_a_control_account
  BEFORE INSERT OR UPDATE ON other_receipt
  FOR EACH ROW EXECUTE FUNCTION other_receipt_not_to_a_control_account();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 17 - the receipt arrives in an account of its own branch, and the
-- currency recorded is that account's own.
-- ---------------------------------------------------------------------------
CREATE FUNCTION other_receipt_matches_its_account() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_branch text;
  v_ccy    text;
  v_code   text;
BEGIN
  SELECT branch_code, currency, code INTO v_branch, v_ccy, v_code
    FROM bank_cash_account WHERE id = NEW.bank_cash_account_id;

  IF NEW.branch_code IS DISTINCT FROM v_branch THEN
    RAISE EXCEPTION
      'Receipt is in branch % but % belongs to %.', NEW.branch_code, v_code, v_branch
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.currency IS DISTINCT FROM v_ccy THEN
    RAISE EXCEPTION
      'Receipt says it arrived in % but % is held in %.', NEW.currency, v_code, v_ccy
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER other_receipt_matches_its_account
  BEFORE INSERT OR UPDATE ON other_receipt
  FOR EACH ROW EXECUTE FUNCTION other_receipt_matches_its_account();--> statement-breakpoint

-- Numbering, document type, statuses and permissions.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('OTHER_RECEIPT', 'ORC', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('other_receipt', 'Other Receipt', 'treasury',
   'Money in that is not a customer settling an invoice - a refund, interest, a small sale (blueprint 17). It credits the account somebody names, with that account''s required dimensions, and cannot credit a subledger control account.');--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('other_receipt', 'draft',    'approved'),
  ('other_receipt', 'draft',    'cancelled'),
  ('other_receipt', 'approved', 'draft'),
  ('other_receipt', 'approved', 'cancelled'),
  ('other_receipt', 'approved', 'posted'),
  ('other_receipt', 'posted',   'reversed');--> statement-breakpoint

INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('other_receipt', 'amount_iqd',
   'What arrived. It is what the approver signed for.'),
  ('other_receipt', 'credit_account_id',
   'What the money was for. Changing it after approval would move the income somewhere nobody agreed.'),
  ('other_receipt', 'bank_cash_account_id',
   'Which account it arrived in.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'other_receipt', 'view'),
  ('accounting_officer', 'other_receipt', 'create'),
  ('accounting_officer', 'other_receipt', 'submit'),
  ('accounting_officer', 'other_receipt', 'print'),
  ('accounting_manager', 'other_receipt', 'view'),
  ('accounting_manager', 'other_receipt', 'create'),
  ('accounting_manager', 'other_receipt', 'approve'),
  ('accounting_manager', 'other_receipt', 'post'),
  ('accounting_manager', 'other_receipt', 'reverse_cancel'),
  ('accounting_manager', 'other_receipt', 'print'),
  ('accounting_manager', 'other_receipt', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist - grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON other_receipt FROM erp_app;
  GRANT SELECT, INSERT, UPDATE ON other_receipt TO erp_app;
END;
$$;--> statement-breakpoint

-- D10 - the branch boundary.
ALTER TABLE other_receipt ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE other_receipt FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY other_receipt_branch_scope ON other_receipt
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));
