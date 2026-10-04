-- Receivables — credit notes, debit notes and the application of customer
-- credits (2026-10-04, by direction: "Final Receivables navbar").
--
-- Three things the module lacked, and nothing it already had rebuilt:
--
--   1. customer_note — a credit or debit note raised against a customer on
--      its own, not through a returned delivery. The return-driven credit
--      memo (0050) stays exactly what it is: Appendix C requires an accepted
--      return behind it, and that NOT NULL is a control, not a gap. A price
--      allowance or an extra charge has no goods behind it, so it is its own
--      document. It posts through the existing engine under two new events
--      whose rules are copied from the documents that already map the same
--      roles (the memo's and the invoice's), so a database that posts a
--      credit memo today posts a credit note too.
--
--   2. customer_credit_application — a customer's credit (an unapplied
--      receipt, a memo's remainder, a credit note) put against something the
--      customer owes (an invoice, a debit note). A receipt against an invoice
--      keeps its own table (customer_receipt_allocation) and is refused here,
--      so each settlement is recorded in exactly one place.
--
--   3. customer_receipt.payment_method_code — the payment method master,
--      named on the receipt.

-- ---------------------------------------------------------------------------
-- 1. customer_note
-- ---------------------------------------------------------------------------
CREATE TABLE "customer_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"note_no" text NOT NULL,
	"kind" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"customer_id" uuid NOT NULL REFERENCES "business_partner"("id"),
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	-- The invoice it corrects, when it corrects one. Optional: a debit note for
	-- a late-payment charge answers to no single invoice.
	"ar_invoice_id" uuid REFERENCES "ar_invoice"("id"),
	"note_date" date NOT NULL,
	-- A debit note is owed by a date and ages from it; a credit note is
	-- available the day it is issued, so its due date is its date.
	"due_date" date NOT NULL,
	"payment_terms_code" text REFERENCES "payment_terms"("code"),
	"currency" text DEFAULT 'IQD' NOT NULL,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"allocated_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"reason" text NOT NULL,
	"description" text,
	-- The other side of the entry, when the note names it; null is "as
	-- configured" (the event's posting rule), exactly as on the invoice.
	"account_id" uuid REFERENCES "chart_of_account"("id"),
	"journal_entry_id" uuid REFERENCES "journal_entry"("id"),
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"approved_by" uuid REFERENCES "app_user"("id"),
	"approved_at" timestamp with time zone,
	"posted_by" uuid REFERENCES "app_user"("id"),
	"posted_at" timestamp with time zone,
	"reversed_by" uuid REFERENCES "app_user"("id"),
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	"reversal_journal_entry_id" uuid REFERENCES "journal_entry"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_note_kind" CHECK ("kind" in ('credit', 'debit')),
	CONSTRAINT "customer_note_amount_positive" CHECK ("amount_iqd" > 0),
	CONSTRAINT "customer_note_allocation_within_amount" CHECK ("allocated_iqd" >= 0 and "allocated_iqd" <= "amount_iqd"),
	CONSTRAINT "customer_note_reason_present" CHECK (btrim("reason") <> ''),
	CONSTRAINT "customer_note_due_after_issue" CHECK ("due_date" >= "note_date"),
	CONSTRAINT "customer_note_credit_due_on_issue" CHECK ("kind" = 'debit' or "due_date" = "note_date"),
	CONSTRAINT "customer_note_posting_matches_status" CHECK (("journal_entry_id" is null) = ("posted_at" is null)),
	CONSTRAINT "customer_note_reversal_has_reason" CHECK (
		("reversed_by" is null and "reversed_at" is null and "reversal_journal_entry_id" is null)
		or ("reversed_by" is not null and "reversed_at" is not null and "reversal_journal_entry_id" is not null
		    and coalesce(btrim("reversal_reason"), '') <> '')),
	CONSTRAINT "customer_note_stamps_in_order" CHECK (
		("posted_at" is null or "approved_at" is not null)
		and ("posted_at" is null or "approved_at" <= "posted_at")
		and ("reversed_at" is null or "posted_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "customer_note_no_uniq" ON "customer_note" ("note_no");--> statement-breakpoint
CREATE INDEX "customer_note_customer_idx" ON "customer_note" ("customer_id", "status");--> statement-breakpoint
CREATE INDEX "customer_note_invoice_idx" ON "customer_note" ("ar_invoice_id");--> statement-breakpoint
CREATE INDEX "customer_note_due_idx" ON "customer_note" ("due_date", "status");--> statement-breakpoint
CREATE INDEX "customer_note_journal_idx" ON "customer_note" ("journal_entry_id");--> statement-breakpoint

-- A note's invoice is the same customer's. Held here as well as in the
-- service, because a note against another customer's invoice would move one
-- account's balance on the strength of another's document.
CREATE FUNCTION customer_note_invoice_same_customer() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_customer uuid;
  v_invoice  text;
BEGIN
  IF NEW.ar_invoice_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT customer_id, invoice_no INTO v_customer, v_invoice FROM ar_invoice WHERE id = NEW.ar_invoice_id;
  IF v_customer IS DISTINCT FROM NEW.customer_id THEN
    RAISE EXCEPTION
      'Note % names invoice %, which belongs to a different customer. A note corrects its own customer''s account.',
      NEW.note_no, v_invoice
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER customer_note_invoice_same_customer
  BEFORE INSERT OR UPDATE OF ar_invoice_id, customer_id ON customer_note
  FOR EACH ROW EXECUTE FUNCTION customer_note_invoice_same_customer();--> statement-breakpoint

-- Once posted, what the note is for is fixed: the journal already says it.
CREATE FUNCTION customer_note_frozen_after_posting() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.posted_at IS NOT NULL AND (
       NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
    OR NEW.branch_code IS DISTINCT FROM OLD.branch_code
    OR NEW.ar_invoice_id IS DISTINCT FROM OLD.ar_invoice_id
    OR NEW.note_date IS DISTINCT FROM OLD.note_date
    OR NEW.due_date IS DISTINCT FROM OLD.due_date
    OR NEW.amount_iqd IS DISTINCT FROM OLD.amount_iqd
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id
  ) THEN
    RAISE EXCEPTION
      'Note % is posted. A posted note is reversed, never edited (blueprint 3.2).', OLD.note_no
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER customer_note_frozen_after_posting
  BEFORE UPDATE ON customer_note
  FOR EACH ROW EXECUTE FUNCTION customer_note_frozen_after_posting();--> statement-breakpoint

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year) VALUES
  ('CUSTOMER_CREDIT_NOTE', 'CRN', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true),
  ('CUSTOMER_DEBIT_NOTE',  'DBN', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true)
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('customer_note', 'Customer Credit / Debit Note', 'sales',
   'A credit note reduces what a customer owes (Dr Sales Returns & Allowances / Cr Customer A/R); a debit note increases it (Dr Customer A/R / Cr Revenue). Raised on its own, not from returned goods - those are the Credit Memo''s.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('customer_note', 'draft',              'approved'),
  ('customer_note', 'draft',              'cancelled'),
  ('customer_note', 'approved',           'draft'),
  ('customer_note', 'approved',           'posted'),
  ('customer_note', 'posted',             'partially_executed'),
  ('customer_note', 'posted',             'settled'),
  ('customer_note', 'partially_executed', 'settled'),
  ('customer_note', 'posted',             'reversed')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('customer_note', 'amount_iqd',
   'Decides how much the customer''s balance moves. Fixed once posted; a wrong note is reversed.'),
  ('customer_note', 'ar_invoice_id',
   'Ties the note to the invoice it corrects, so the correction can be traced from either side.'),
  ('customer_note', 'reason',
   'The only record of why the account was adjusted (blueprint 5.4).')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- The notes are customer credits and debits, so they are governed by the
-- object that already governs customer credits: the Credit Memo's. The roles
-- that may raise, approve and post a memo may do the same with a note, and
-- D-HD-5's second factor already applies to its approvers.

-- The two events, copied from the documents that already map the same roles.
INSERT INTO posting_rule (event_type, line_role, account_id, is_active, created_by)
SELECT 'sales.customer_credit_note', r.line_role, r.account_id, true, r.created_by
  FROM posting_rule r
 WHERE r.event_type = 'sales.customer_credit_memo'
   AND r.line_role in ('customer_receivable', 'sales_returns')
   AND r.is_active
   AND r.item_group IS NULL AND r.partner_group IS NULL AND r.warehouse_code IS NULL
   AND r.project_code IS NULL AND r.branch_code IS NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO posting_rule (event_type, line_role, account_id, is_active, created_by)
SELECT 'sales.customer_debit_note', r.line_role, r.account_id, true, r.created_by
  FROM posting_rule r
 WHERE r.event_type = 'sales.ar_invoice'
   AND r.line_role in ('customer_receivable', 'sales_revenue')
   AND r.is_active
   AND r.item_group IS NULL AND r.partner_group IS NULL AND r.warehouse_code IS NULL
   AND r.project_code IS NULL AND r.branch_code IS NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. customer_credit_application
-- ---------------------------------------------------------------------------
CREATE TABLE "customer_credit_application" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL REFERENCES "business_partner"("id"),
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	-- The credit being used — exactly one.
	"customer_receipt_id" uuid REFERENCES "customer_receipt"("id"),
	"customer_credit_memo_id" uuid REFERENCES "customer_credit_memo"("id"),
	"credit_note_id" uuid REFERENCES "customer_note"("id"),
	-- What it settles — exactly one.
	"ar_invoice_id" uuid REFERENCES "ar_invoice"("id"),
	"debit_note_id" uuid REFERENCES "customer_note"("id"),
	"amount_iqd" numeric(19, 4) NOT NULL,
	"applied_on" date NOT NULL,
	"applied_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	CONSTRAINT "customer_credit_application_amount_positive" CHECK ("amount_iqd" > 0),
	CONSTRAINT "customer_credit_application_one_source" CHECK (num_nonnulls("customer_receipt_id", "customer_credit_memo_id", "credit_note_id") = 1),
	CONSTRAINT "customer_credit_application_one_target" CHECK (num_nonnulls("ar_invoice_id", "debit_note_id") = 1),
	-- A receipt against an invoice is customer_receipt_allocation's, so a
	-- settlement is never recorded in two places.
	CONSTRAINT "customer_credit_application_receipt_invoice_elsewhere" CHECK ("customer_receipt_id" is null or "ar_invoice_id" is null)
);
--> statement-breakpoint
CREATE INDEX "customer_credit_application_customer_idx" ON "customer_credit_application" ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_credit_application_receipt_idx" ON "customer_credit_application" ("customer_receipt_id");--> statement-breakpoint
CREATE INDEX "customer_credit_application_memo_idx" ON "customer_credit_application" ("customer_credit_memo_id");--> statement-breakpoint
CREATE INDEX "customer_credit_application_credit_note_idx" ON "customer_credit_application" ("credit_note_id");--> statement-breakpoint
CREATE INDEX "customer_credit_application_invoice_idx" ON "customer_credit_application" ("ar_invoice_id");--> statement-breakpoint
CREATE INDEX "customer_credit_application_debit_note_idx" ON "customer_credit_application" ("debit_note_id");--> statement-breakpoint

-- One customer's credit settles that customer's debt, and neither side can be
-- taken past what it is for — whatever route wrote the row.
CREATE FUNCTION customer_credit_application_within_balances() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_source_customer uuid;
  v_source_no       text;
  v_source_status   text;
  v_source_amount   numeric(19,4);
  v_source_used     numeric(19,4);
  v_target_customer uuid;
  v_target_no       text;
  v_target_status   text;
  v_kind            text;
BEGIN
  -- The source.
  IF NEW.customer_receipt_id IS NOT NULL THEN
    SELECT customer_id, receipt_no, status::text, amount_iqd
      INTO v_source_customer, v_source_no, v_source_status, v_source_amount
      FROM customer_receipt WHERE id = NEW.customer_receipt_id;
    SELECT coalesce((SELECT sum(amount_iqd) FROM customer_receipt_allocation
                      WHERE customer_receipt_id = NEW.customer_receipt_id), 0)
         + coalesce((SELECT sum(amount_iqd) FROM customer_credit_application
                      WHERE customer_receipt_id = NEW.customer_receipt_id AND id <> NEW.id), 0)
      INTO v_source_used;
  ELSIF NEW.customer_credit_memo_id IS NOT NULL THEN
    SELECT customer_id, memo_no, status::text, amount_iqd, allocated_iqd
      INTO v_source_customer, v_source_no, v_source_status, v_source_amount, v_source_used
      FROM customer_credit_memo WHERE id = NEW.customer_credit_memo_id;
    -- The memo keeps its own running total, which the service has already
    -- raised by this row; the check below is against the memo's own column.
    v_source_used := v_source_used - NEW.amount_iqd;
  ELSE
    SELECT customer_id, note_no, status::text, amount_iqd, kind
      INTO v_source_customer, v_source_no, v_source_status, v_source_amount, v_kind
      FROM customer_note WHERE id = NEW.credit_note_id;
    IF v_kind <> 'credit' THEN
      RAISE EXCEPTION 'Note % is a debit note. Only a credit can be applied to what a customer owes.', v_source_no
        USING ERRCODE = 'restrict_violation';
    END IF;
    SELECT coalesce(sum(amount_iqd), 0) INTO v_source_used
      FROM customer_credit_application
     WHERE credit_note_id = NEW.credit_note_id AND id <> NEW.id;
  END IF;

  IF v_source_status NOT IN ('posted', 'partially_executed', 'settled') THEN
    RAISE EXCEPTION 'Credit % is %, and a credit is applied once it has been posted.', v_source_no, v_source_status
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_source_customer IS DISTINCT FROM NEW.customer_id THEN
    RAISE EXCEPTION 'Credit % belongs to a different customer. One customer''s credit does not settle another''s debt (blueprint 16).', v_source_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_source_used + NEW.amount_iqd > v_source_amount THEN
    RAISE EXCEPTION 'Credit % has % left to apply and this application is %. A credit cannot give back more than it is for.',
      v_source_no, v_source_amount - v_source_used, NEW.amount_iqd
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The target.
  IF NEW.ar_invoice_id IS NOT NULL THEN
    SELECT customer_id, invoice_no, status::text INTO v_target_customer, v_target_no, v_target_status
      FROM ar_invoice WHERE id = NEW.ar_invoice_id;
  ELSE
    SELECT customer_id, note_no, status::text, kind INTO v_target_customer, v_target_no, v_target_status, v_kind
      FROM customer_note WHERE id = NEW.debit_note_id;
    IF v_kind <> 'debit' THEN
      RAISE EXCEPTION 'Note % is a credit note; a credit is applied to an invoice or a debit note.', v_target_no
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF v_target_customer IS DISTINCT FROM NEW.customer_id THEN
    RAISE EXCEPTION '% belongs to a different customer than the credit applied to it (blueprint 16).', v_target_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_target_status NOT IN ('posted', 'partially_executed', 'settled') THEN
    RAISE EXCEPTION '% is %, and only a posted document is owed.', v_target_no, v_target_status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER customer_credit_application_within_balances
  BEFORE INSERT ON customer_credit_application
  FOR EACH ROW EXECUTE FUNCTION customer_credit_application_within_balances();--> statement-breakpoint

-- Blueprint 5.4 — an application is kept, never removed or rewritten.
CREATE TRIGGER customer_credit_application_append_only
  BEFORE UPDATE OR DELETE ON customer_credit_application
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

-- A receipt's ceiling now counts what it settled through either table.
CREATE OR REPLACE FUNCTION customer_receipt_allocation_within_balances() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_receipt_no   text;
  v_receipt_amt  numeric(19,4);
  v_receipt_used numeric(19,4);
  v_receipt_cust uuid;
  v_receipt_stat text;
  v_invoice_no   text;
  v_invoice_amt  numeric(19,4);
  v_invoice_used numeric(19,4);
  v_invoice_cust uuid;
BEGIN
  SELECT receipt_no, amount_iqd, customer_id, status::text
    INTO v_receipt_no, v_receipt_amt, v_receipt_cust, v_receipt_stat
    FROM customer_receipt WHERE id = NEW.customer_receipt_id;

  SELECT invoice_no, net_iqd, customer_id
    INTO v_invoice_no, v_invoice_amt, v_invoice_cust
    FROM ar_invoice WHERE id = NEW.ar_invoice_id;

  IF v_receipt_cust IS NULL THEN
    RAISE EXCEPTION
      'Receipt % has no customer, so it cannot settle an invoice. Money that arrives without a payer sits in the clearing account until somebody works out whose it is (blueprint 16).',
      v_receipt_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_receipt_cust IS DISTINCT FROM v_invoice_cust THEN
    RAISE EXCEPTION
      'Receipt % is from a different customer than invoice %. One customer''s money does not settle another''s debt (blueprint 16).',
      v_receipt_no, v_invoice_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_receipt_stat NOT IN ('posted', 'settled') THEN
    RAISE EXCEPTION
      'Receipt % is %, and money is allocated once it has been posted. Before that it is a document, not a payment.',
      v_receipt_no, v_receipt_stat
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT coalesce((SELECT sum(amount_iqd) FROM customer_receipt_allocation
                    WHERE customer_receipt_id = NEW.customer_receipt_id AND id <> NEW.id), 0)
       + coalesce((SELECT sum(amount_iqd) FROM customer_credit_application
                    WHERE customer_receipt_id = NEW.customer_receipt_id), 0)
    INTO v_receipt_used;

  IF v_receipt_used + NEW.amount_iqd > v_receipt_amt THEN
    RAISE EXCEPTION
      'Receipt % has % left to apply and this allocation is %. A receipt cannot pay out more than the customer paid in (blueprint 16).',
      v_receipt_no, v_receipt_amt - v_receipt_used, NEW.amount_iqd
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT coalesce(sum(amount_iqd), 0) INTO v_invoice_used
    FROM customer_receipt_allocation
   WHERE ar_invoice_id = NEW.ar_invoice_id AND id <> NEW.id;

  IF v_invoice_used + NEW.amount_iqd > v_invoice_amt THEN
    RAISE EXCEPTION
      'Allocating % to invoice % exceeds its balance of %. Money received beyond an invoice is a customer credit, not a larger invoice (blueprint 16).',
      NEW.amount_iqd, v_invoice_no, v_invoice_amt - v_invoice_used
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. The receipt's payment method
-- ---------------------------------------------------------------------------
ALTER TABLE "customer_receipt"
  ADD COLUMN "payment_method_code" text REFERENCES "payment_method"("code");--> statement-breakpoint
CREATE INDEX "customer_receipt_payment_method_idx" ON "customer_receipt" ("payment_method_code");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Privileges and the branch boundary (D10)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist - grants skipped.';
    RETURN;
  END IF;
  REVOKE ALL ON customer_note, customer_credit_application FROM erp_app;
  GRANT SELECT, INSERT, UPDATE ON customer_note TO erp_app;
  -- No UPDATE or DELETE on an application: the trigger refuses them to
  -- everyone, and withholding the privilege says so before the attempt.
  GRANT SELECT, INSERT ON customer_credit_application TO erp_app;
END;
$$;--> statement-breakpoint

ALTER TABLE customer_note ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE customer_note FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY customer_note_branch_scope ON customer_note
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

ALTER TABLE customer_credit_application ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE customer_credit_application FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY customer_credit_application_branch_scope ON customer_credit_application
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));
