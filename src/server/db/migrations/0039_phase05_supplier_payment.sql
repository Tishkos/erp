CREATE TABLE "supplier_payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"supplier_id" uuid NOT NULL,
	"bank_cash_account_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"payment_date" date NOT NULL,
	"currency" text DEFAULT 'IQD' NOT NULL,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"allocated_amount_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"reference" text,
	"note" text,
	"blocked_override_by" uuid,
	"blocked_override_at" timestamp with time zone,
	"blocked_override_reason" text,
	"journal_entry_id" uuid,
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
	CONSTRAINT "supplier_payment_amount_positive" CHECK ("supplier_payment"."amount_iqd" > 0),
	CONSTRAINT "supplier_payment_not_over_allocated" CHECK ("supplier_payment"."allocated_amount_iqd" >= 0 and "supplier_payment"."allocated_amount_iqd" <= "supplier_payment"."amount_iqd"),
	CONSTRAINT "supplier_payment_override_complete" CHECK (("supplier_payment"."blocked_override_by" is null and "supplier_payment"."blocked_override_at" is null
           and "supplier_payment"."blocked_override_reason" is null)
          or ("supplier_payment"."blocked_override_by" is not null and "supplier_payment"."blocked_override_at" is not null
              and coalesce(btrim("supplier_payment"."blocked_override_reason"), '') <> '')),
	CONSTRAINT "supplier_payment_reversal_has_reason" CHECK (("supplier_payment"."reversed_by" is null and "supplier_payment"."reversed_at" is null)
          or ("supplier_payment"."reversed_by" is not null and "supplier_payment"."reversed_at" is not null
              and coalesce(btrim("supplier_payment"."reversal_reason"), '') <> ''))
);
--> statement-breakpoint
CREATE TABLE "supplier_payment_allocation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_payment_id" uuid NOT NULL,
	"ap_invoice_id" uuid NOT NULL,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"allocated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"allocated_by" uuid NOT NULL,
	"reversed_by" uuid,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	CONSTRAINT "supplier_payment_allocation_amount_positive" CHECK ("supplier_payment_allocation"."amount_iqd" > 0)
);
--> statement-breakpoint
ALTER TABLE "supplier_payment" ADD CONSTRAINT "supplier_payment_supplier_id_business_partner_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment" ADD CONSTRAINT "supplier_payment_bank_cash_account_id_bank_cash_account_id_fk" FOREIGN KEY ("bank_cash_account_id") REFERENCES "public"."bank_cash_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment" ADD CONSTRAINT "supplier_payment_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment" ADD CONSTRAINT "supplier_payment_blocked_override_by_app_user_id_fk" FOREIGN KEY ("blocked_override_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment" ADD CONSTRAINT "supplier_payment_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment" ADD CONSTRAINT "supplier_payment_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment" ADD CONSTRAINT "supplier_payment_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment" ADD CONSTRAINT "supplier_payment_posted_by_app_user_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment" ADD CONSTRAINT "supplier_payment_reversed_by_app_user_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocation" ADD CONSTRAINT "supplier_payment_allocation_supplier_payment_id_supplier_payment_id_fk" FOREIGN KEY ("supplier_payment_id") REFERENCES "public"."supplier_payment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocation" ADD CONSTRAINT "supplier_payment_allocation_ap_invoice_id_ap_invoice_id_fk" FOREIGN KEY ("ap_invoice_id") REFERENCES "public"."ap_invoice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocation" ADD CONSTRAINT "supplier_payment_allocation_allocated_by_app_user_id_fk" FOREIGN KEY ("allocated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocation" ADD CONSTRAINT "supplier_payment_allocation_reversed_by_app_user_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_payment_no_uniq" ON "supplier_payment" USING btree ("payment_no");--> statement-breakpoint
CREATE INDEX "supplier_payment_supplier_idx" ON "supplier_payment" USING btree ("supplier_id","status");--> statement-breakpoint
CREATE INDEX "supplier_payment_date_idx" ON "supplier_payment" USING btree ("payment_date","branch_code");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_payment_allocation_pair_uniq" ON "supplier_payment_allocation" USING btree ("supplier_payment_id","ap_invoice_id") WHERE reversed_at is null;--> statement-breakpoint
CREATE INDEX "supplier_payment_allocation_invoice_idx" ON "supplier_payment_allocation" USING btree ("ap_invoice_id");
-- ---------------------------------------------------------------------------
-- Section 15 - an allocation never exceeds either balance, and the two move
-- together.
--
-- The CHECK constraints bound each side on its own. What no CHECK can see is
-- the pair: that this allocation is available on the payment AND owed on the
-- invoice at the moment it is written. Two clerks allocating the same payment
-- to two invoices would each pass a per-row check and together over-allocate.
--
-- Rows are locked in a fixed order - payment, then invoice - so two concurrent
-- allocations queue rather than deadlock.
-- ---------------------------------------------------------------------------
CREATE FUNCTION supplier_payment_allocation_within_balances() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_unallocated numeric(19,4);
  v_owed        numeric(19,4);
  v_pay_no      text;
  v_inv_no      text;
BEGIN
  SELECT payment_no, amount_iqd - allocated_amount_iqd
    INTO v_pay_no, v_unallocated
    FROM supplier_payment WHERE id = NEW.supplier_payment_id FOR UPDATE;

  SELECT invoice_no, total_iqd - settled_amount_iqd
    INTO v_inv_no, v_owed
    FROM ap_invoice WHERE id = NEW.ap_invoice_id FOR UPDATE;

  IF NEW.amount_iqd > v_unallocated THEN
    RAISE EXCEPTION
      'Allocating % would exceed what is left of payment % (% unallocated) - blueprint 15.',
      NEW.amount_iqd, v_pay_no, v_unallocated
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.amount_iqd > v_owed THEN
    RAISE EXCEPTION
      'Allocating % would exceed what is still owed on invoice % (% owed) - blueprint 15.',
      NEW.amount_iqd, v_inv_no, v_owed
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER supplier_payment_allocation_within_balances
  BEFORE INSERT ON supplier_payment_allocation
  FOR EACH ROW EXECUTE FUNCTION supplier_payment_allocation_within_balances();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A posted payment is history: the money has left the bank.
--
-- What may still change is the allocation - deciding *which* invoices a payment
-- settles is a bookkeeping act that can be corrected, and it does not alter the
-- fact or the amount of the payment.
-- ---------------------------------------------------------------------------
CREATE FUNCTION supplier_payment_posted_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'posted' THEN
    RETURN NEW;
  END IF;

  IF NEW.supplier_id           IS DISTINCT FROM OLD.supplier_id
  OR NEW.bank_cash_account_id  IS DISTINCT FROM OLD.bank_cash_account_id
  OR NEW.amount_iqd            IS DISTINCT FROM OLD.amount_iqd
  OR NEW.payment_date          IS DISTINCT FROM OLD.payment_date
  OR NEW.branch_code           IS DISTINCT FROM OLD.branch_code
  OR NEW.currency              IS DISTINCT FROM OLD.currency
  OR NEW.journal_entry_id      IS DISTINCT FROM OLD.journal_entry_id THEN
    RAISE EXCEPTION
      'Payment % has posted and the money has left the bank (blueprint 3.2). Reverse it; it is not edited.',
      OLD.payment_no USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER supplier_payment_posted_is_final
  BEFORE UPDATE ON supplier_payment
  FOR EACH ROW EXECUTE FUNCTION supplier_payment_posted_is_final();--> statement-breakpoint

-- Numbering, document type, statuses and permissions.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('SUPPLIER_PAYMENT', 'PAY', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('supplier_payment', 'Supplier Payment', 'purchasing',
   'Money paid to a supplier and allocated to approved open items (Appendix C). Posts Dr Supplier A/P / Cr Bank. Payment proposal, batch and bank reconciliation are Phase 07.');--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('supplier_payment', 'draft',     'approved'),
  ('supplier_payment', 'draft',     'posted'),
  ('supplier_payment', 'draft',     'cancelled'),
  ('supplier_payment', 'approved',  'posted'),
  ('supplier_payment', 'approved',  'cancelled'),
  ('supplier_payment', 'posted',    'reversed');--> statement-breakpoint

INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('supplier_payment', 'supplier_id',
   'Decides whose debts this money settles.'),
  ('supplier_payment', 'amount_iqd',
   'The money leaving the bank. Changed after approval, it would be paid without having been approved.'),
  ('supplier_payment', 'bank_cash_account_id',
   'Decides which cash position falls, and must match the payment currency (blueprint 17).'),
  ('supplier_payment', 'payment_date',
   'Decides the period the bank movement lands in.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Section 8.6 - Supplier Payment is owned by Finance / Treasury.
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'supplier_payment', 'view'),
  ('accounting_officer', 'supplier_payment', 'create'),
  ('accounting_officer', 'supplier_payment', 'edit_draft'),
  ('accounting_officer', 'supplier_payment', 'submit'),
  ('accounting_officer', 'supplier_payment', 'print'),
  ('accounting_manager', 'supplier_payment', 'view'),
  ('accounting_manager', 'supplier_payment', 'create'),
  ('accounting_manager', 'supplier_payment', 'edit_draft'),
  ('accounting_manager', 'supplier_payment', 'submit'),
  ('accounting_manager', 'supplier_payment', 'approve'),
  ('accounting_manager', 'supplier_payment', 'post'),
  ('accounting_manager', 'supplier_payment', 'reverse_cancel'),
  ('accounting_manager', 'supplier_payment', 'print'),
  ('accounting_manager', 'supplier_payment', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist - grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON supplier_payment, supplier_payment_allocation FROM erp_app;

  -- No DELETE on either: a payment is reversed, and Appendix C calls the
  -- allocation a history.
  GRANT SELECT, INSERT, UPDATE ON supplier_payment TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON supplier_payment_allocation TO erp_app;
END;
$$;--> statement-breakpoint

ALTER TABLE supplier_payment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE supplier_payment FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY supplier_payment_branch_scope ON supplier_payment
  USING (app_is_super_user() OR branch_code = app_current_branch())
  WITH CHECK (app_is_super_user() OR branch_code = app_current_branch());
