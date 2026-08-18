CREATE TABLE "customer_receipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"customer_id" uuid,
	"branch_code" text NOT NULL,
	"receipt_date" date NOT NULL,
	"bank_cash_account_id" uuid NOT NULL,
	"currency" text DEFAULT 'IQD' NOT NULL,
	"bank_reference" text,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"allocated_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"cash_sale_invoice_id" uuid,
	"journal_entry_id" uuid,
	"note" text,
	"created_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"reversed_by" uuid,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_receipt_amount_positive" CHECK ("customer_receipt"."amount_iqd" > 0),
	CONSTRAINT "customer_receipt_allocation_within_amount" CHECK ("customer_receipt"."allocated_iqd" >= 0 and "customer_receipt"."allocated_iqd" <= "customer_receipt"."amount_iqd"),
	CONSTRAINT "customer_receipt_unidentified_is_unapplied" CHECK ("customer_receipt"."customer_id" is not null or "customer_receipt"."allocated_iqd" = 0),
	CONSTRAINT "customer_receipt_reversal_has_reason" CHECK (("customer_receipt"."reversed_by" is null and "customer_receipt"."reversed_at" is null)
          or ("customer_receipt"."reversed_by" is not null and "customer_receipt"."reversed_at" is not null
              and coalesce(btrim("customer_receipt"."reversal_reason"), '') <> '')),
	CONSTRAINT "customer_receipt_posting_matches_status" CHECK (("customer_receipt"."journal_entry_id" is null) = ("customer_receipt"."posted_at" is null)),
	CONSTRAINT "customer_receipt_stamps_in_order" CHECK (("customer_receipt"."posted_at" is null or "customer_receipt"."approved_at" is not null)
          and ("customer_receipt"."posted_at" is null or "customer_receipt"."approved_at" <= "customer_receipt"."posted_at")
          and ("customer_receipt"."reversed_at" is null or "customer_receipt"."posted_at" is not null)
          and ("customer_receipt"."reversed_at" is null or "customer_receipt"."posted_at" <= "customer_receipt"."reversed_at"))
);
--> statement-breakpoint
CREATE TABLE "customer_receipt_allocation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_receipt_id" uuid NOT NULL,
	"ar_invoice_id" uuid NOT NULL,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"allocated_by" uuid NOT NULL,
	"allocated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	CONSTRAINT "customer_receipt_allocation_amount_positive" CHECK ("customer_receipt_allocation"."amount_iqd" > 0)
);
--> statement-breakpoint
ALTER TABLE "customer_receipt" ADD CONSTRAINT "customer_receipt_customer_id_business_partner_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_receipt" ADD CONSTRAINT "customer_receipt_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_receipt" ADD CONSTRAINT "customer_receipt_bank_cash_account_id_bank_cash_account_id_fk" FOREIGN KEY ("bank_cash_account_id") REFERENCES "public"."bank_cash_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_receipt" ADD CONSTRAINT "customer_receipt_cash_sale_invoice_id_ar_invoice_id_fk" FOREIGN KEY ("cash_sale_invoice_id") REFERENCES "public"."ar_invoice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_receipt" ADD CONSTRAINT "customer_receipt_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_receipt" ADD CONSTRAINT "customer_receipt_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_receipt" ADD CONSTRAINT "customer_receipt_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_receipt" ADD CONSTRAINT "customer_receipt_posted_by_app_user_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_receipt" ADD CONSTRAINT "customer_receipt_reversed_by_app_user_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_receipt_allocation" ADD CONSTRAINT "customer_receipt_allocation_customer_receipt_id_customer_receipt_id_fk" FOREIGN KEY ("customer_receipt_id") REFERENCES "public"."customer_receipt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_receipt_allocation" ADD CONSTRAINT "customer_receipt_allocation_ar_invoice_id_ar_invoice_id_fk" FOREIGN KEY ("ar_invoice_id") REFERENCES "public"."ar_invoice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_receipt_allocation" ADD CONSTRAINT "customer_receipt_allocation_allocated_by_app_user_id_fk" FOREIGN KEY ("allocated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_receipt_no_uniq" ON "customer_receipt" USING btree ("receipt_no");--> statement-breakpoint
CREATE INDEX "customer_receipt_customer_idx" ON "customer_receipt" USING btree ("customer_id","status");--> statement-breakpoint
CREATE INDEX "customer_receipt_date_idx" ON "customer_receipt" USING btree ("receipt_date","branch_code");--> statement-breakpoint
CREATE INDEX "customer_receipt_unidentified_idx" ON "customer_receipt" USING btree ("branch_code","receipt_date") WHERE "customer_receipt"."customer_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_receipt_cash_sale_uniq" ON "customer_receipt" USING btree ("cash_sale_invoice_id") WHERE "customer_receipt"."cash_sale_invoice_id" is not null;--> statement-breakpoint
CREATE INDEX "customer_receipt_allocation_receipt_idx" ON "customer_receipt_allocation" USING btree ("customer_receipt_id");--> statement-breakpoint
CREATE INDEX "customer_receipt_allocation_invoice_idx" ON "customer_receipt_allocation" USING btree ("ar_invoice_id");
-- ===========================================================================
-- Phase 06.10 — Customer Receipt and allocation (§16, Appendix B, Appendix C)
--
-- Appendix B: "Customer Receipt / Cash Sale Receipt | Finance/Treasury | Draft,
-- Approved, Posted, Allocated, Reversed | Customer / Invoice | Bank/cash and
-- A/R." One document type for both, which is why 06.8's cash sale settles
-- through this rather than through a second mechanism of its own (blueprint 24).
--
-- Built here ahead of 06.8 deliberately: "cash sales use the same inventory and
-- invoice controls" is only true by construction if there is one set of controls
-- to use. Building the cash case first and the general one afterwards is how the
-- two end up differing.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- §16 — *"Receipt allocation cannot exceed invoice or available receipt
-- balance."*
--
-- Both ceilings, in the database as well as in the service. An allocation that
-- satisfied one and not the other leaves either an over-paid invoice or a
-- receipt that paid out money nobody sent, and the two are different mistakes.
--
-- The running totals on the two parents are maintained by the service; this
-- refuses the row whose sum would break either of them, whatever route wrote it.
-- ---------------------------------------------------------------------------
CREATE FUNCTION customer_receipt_allocation_within_balances() RETURNS trigger
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

  SELECT coalesce(sum(amount_iqd), 0) INTO v_receipt_used
    FROM customer_receipt_allocation
   WHERE customer_receipt_id = NEW.customer_receipt_id AND id <> NEW.id;

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

CREATE TRIGGER customer_receipt_allocation_within_balances
  BEFORE INSERT OR UPDATE ON customer_receipt_allocation
  FOR EACH ROW EXECUTE FUNCTION customer_receipt_allocation_within_balances();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Blueprint 5.4 — an allocation is kept, never removed.
--
-- "Why was this invoice marked paid in March?" is exactly the question an audit
-- asks, and an allocation that could be deleted is a history that could be
-- edited. Undoing one is a reversal: a new row with the opposite meaning, which
-- leaves both facts visible.
-- ---------------------------------------------------------------------------
CREATE TRIGGER customer_receipt_allocation_append_only
  BEFORE UPDATE OR DELETE ON customer_receipt_allocation
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

-- Numbering, document type, statuses and permissions.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('CUSTOMER_RECEIPT', 'RCT', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('customer_receipt', 'Customer Receipt', 'sales',
   'Money received from a customer, allocated to invoices. Posts Dr Bank/Cash / Cr Customer A/R - or Cr Customer Clearing when the payer is not yet known (blueprint 16). Also the settlement half of a cash sale (Appendix B).');--> statement-breakpoint

-- Appendix B: Draft, Approved, Posted, Allocated, Reversed. No partial state, so
-- a half-applied receipt is still Posted and the unapplied balance is a figure.
INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('customer_receipt', 'draft',    'approved'),
  ('customer_receipt', 'draft',    'cancelled'),
  ('customer_receipt', 'approved', 'draft'),
  ('customer_receipt', 'approved', 'posted'),
  ('customer_receipt', 'posted',   'settled'),
  ('customer_receipt', 'settled',  'posted'),
  ('customer_receipt', 'posted',   'reversed'),
  ('customer_receipt', 'settled',  'reversed');--> statement-breakpoint

INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('customer_receipt', 'amount_iqd',
   'Decides how much can be applied to invoices. Changing it after posting would settle debts with money that never arrived.'),
  ('customer_receipt', 'bank_cash_account_id',
   'Decides which bank or cash account reconciles to this receipt.'),
  ('customer_receipt', 'receipt_date',
   'Decides the accounting period the money lands in.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'customer_receipt', 'view'),
  ('accounting_officer', 'customer_receipt', 'create'),
  ('accounting_officer', 'customer_receipt', 'edit_draft'),
  ('accounting_officer', 'customer_receipt', 'print'),
  ('accounting_manager', 'customer_receipt', 'view'),
  ('accounting_manager', 'customer_receipt', 'create'),
  ('accounting_manager', 'customer_receipt', 'edit_draft'),
  ('accounting_manager', 'customer_receipt', 'approve'),
  ('accounting_manager', 'customer_receipt', 'post'),
  ('accounting_manager', 'customer_receipt', 'execute'),
  ('accounting_manager', 'customer_receipt', 'reverse_cancel'),
  ('accounting_manager', 'customer_receipt', 'configure'),
  ('accounting_manager', 'customer_receipt', 'print'),
  ('accounting_manager', 'customer_receipt', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist - grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON customer_receipt, customer_receipt_allocation FROM erp_app;

  GRANT SELECT, INSERT, UPDATE ON customer_receipt TO erp_app;
  -- No UPDATE or DELETE on an allocation: the trigger above refuses them to
  -- everyone, and withholding the privilege says so before the attempt.
  GRANT SELECT, INSERT ON customer_receipt_allocation TO erp_app;
END;
$$;--> statement-breakpoint

-- D10 — the branch boundary.
ALTER TABLE customer_receipt ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE customer_receipt FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY customer_receipt_branch_scope ON customer_receipt
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

ALTER TABLE customer_receipt_allocation ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE customer_receipt_allocation FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY customer_receipt_allocation_branch_scope ON customer_receipt_allocation
  USING (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM customer_receipt r
       WHERE r.id = customer_receipt_allocation.customer_receipt_id
         AND app_branch_allowed(r.branch_code)
    )
  )
  WITH CHECK (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM customer_receipt r
       WHERE r.id = customer_receipt_allocation.customer_receipt_id
         AND app_branch_allowed(r.branch_code)
    )
  );
