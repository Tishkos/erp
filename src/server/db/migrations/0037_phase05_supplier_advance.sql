CREATE TABLE "supplier_advance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"advance_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"request_date" date NOT NULL,
	"paid_date" date,
	"currency" text DEFAULT 'IQD' NOT NULL,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"settled_amount_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"refunded_amount_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"reason" text,
	"journal_entry_id" uuid,
	"created_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"paid_by" uuid,
	"paid_at" timestamp with time zone,
	"reversed_by" uuid,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_advance_amount_positive" CHECK ("supplier_advance"."amount_iqd" > 0),
	CONSTRAINT "supplier_advance_settled_not_negative" CHECK ("supplier_advance"."settled_amount_iqd" >= 0),
	CONSTRAINT "supplier_advance_refunded_not_negative" CHECK ("supplier_advance"."refunded_amount_iqd" >= 0),
	CONSTRAINT "supplier_advance_not_over_consumed" CHECK ("supplier_advance"."settled_amount_iqd" + "supplier_advance"."refunded_amount_iqd" <= "supplier_advance"."amount_iqd"),
	CONSTRAINT "supplier_advance_reversal_has_reason" CHECK (("supplier_advance"."reversed_by" is null and "supplier_advance"."reversed_at" is null)
          or ("supplier_advance"."reversed_by" is not null and "supplier_advance"."reversed_at" is not null
              and coalesce(btrim("supplier_advance"."reversal_reason"), '') <> ''))
);
--> statement-breakpoint
CREATE TABLE "supplier_advance_settlement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_advance_id" uuid NOT NULL,
	"ap_invoice_id" uuid NOT NULL,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"settlement_date" date NOT NULL,
	"automatic" text DEFAULT 'manual' NOT NULL,
	"journal_entry_id" uuid,
	"settled_by" uuid NOT NULL,
	"settled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_by" uuid,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	CONSTRAINT "supplier_advance_settlement_amount_positive" CHECK ("supplier_advance_settlement"."amount_iqd" > 0),
	CONSTRAINT "supplier_advance_settlement_reversal_has_reason" CHECK (("supplier_advance_settlement"."reversed_by" is null and "supplier_advance_settlement"."reversed_at" is null)
          or ("supplier_advance_settlement"."reversed_by" is not null and "supplier_advance_settlement"."reversed_at" is not null
              and coalesce(btrim("supplier_advance_settlement"."reversal_reason"), '') <> ''))
);
--> statement-breakpoint
ALTER TABLE "ap_invoice" ADD COLUMN "total_iqd" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "ap_invoice" ADD COLUMN "settled_amount_iqd" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_advance" ADD CONSTRAINT "supplier_advance_purchase_order_id_purchase_order_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_advance" ADD CONSTRAINT "supplier_advance_supplier_id_business_partner_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_advance" ADD CONSTRAINT "supplier_advance_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_advance" ADD CONSTRAINT "supplier_advance_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_advance" ADD CONSTRAINT "supplier_advance_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_advance" ADD CONSTRAINT "supplier_advance_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_advance" ADD CONSTRAINT "supplier_advance_paid_by_app_user_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_advance" ADD CONSTRAINT "supplier_advance_reversed_by_app_user_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_advance_settlement" ADD CONSTRAINT "supplier_advance_settlement_supplier_advance_id_supplier_advance_id_fk" FOREIGN KEY ("supplier_advance_id") REFERENCES "public"."supplier_advance"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_advance_settlement" ADD CONSTRAINT "supplier_advance_settlement_ap_invoice_id_ap_invoice_id_fk" FOREIGN KEY ("ap_invoice_id") REFERENCES "public"."ap_invoice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_advance_settlement" ADD CONSTRAINT "supplier_advance_settlement_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_advance_settlement" ADD CONSTRAINT "supplier_advance_settlement_settled_by_app_user_id_fk" FOREIGN KEY ("settled_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_advance_settlement" ADD CONSTRAINT "supplier_advance_settlement_reversed_by_app_user_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_advance_no_uniq" ON "supplier_advance" USING btree ("advance_no");--> statement-breakpoint
CREATE INDEX "supplier_advance_supplier_idx" ON "supplier_advance" USING btree ("supplier_id","status");--> statement-breakpoint
CREATE INDEX "supplier_advance_order_idx" ON "supplier_advance" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_advance_settlement_pair_uniq" ON "supplier_advance_settlement" USING btree ("supplier_advance_id","ap_invoice_id") WHERE reversed_at is null;--> statement-breakpoint
CREATE INDEX "supplier_advance_settlement_invoice_idx" ON "supplier_advance_settlement" USING btree ("ap_invoice_id");--> statement-breakpoint
ALTER TABLE "ap_invoice" ADD CONSTRAINT "ap_invoice_not_over_settled" CHECK ("ap_invoice"."settled_amount_iqd" >= 0 and "ap_invoice"."settled_amount_iqd" <= "ap_invoice"."total_iqd");
-- ---------------------------------------------------------------------------
-- The invoice total joins the fields a posted invoice cannot change.
--
-- It is the denominator of every A/P question - the ageing, the payment run,
-- and what an advance may settle against (blueprint 8.5). What may still move
-- is `settled_amount_iqd`, because being settled is something that happens to a
-- posted invoice rather than a change to what it says.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ap_invoice_posted_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status NOT IN ('posted', 'partially_executed', 'settled') THEN
    RETURN NEW;
  END IF;

  IF NEW.supplier_id          IS DISTINCT FROM OLD.supplier_id
  OR NEW.supplier_invoice_no  IS DISTINCT FROM OLD.supplier_invoice_no
  OR NEW.purchase_order_id    IS DISTINCT FROM OLD.purchase_order_id
  OR NEW.invoice_date         IS DISTINCT FROM OLD.invoice_date
  OR NEW.branch_code          IS DISTINCT FROM OLD.branch_code
  OR NEW.currency             IS DISTINCT FROM OLD.currency
  OR NEW.total_iqd            IS DISTINCT FROM OLD.total_iqd
  OR NEW.journal_entry_id     IS DISTINCT FROM OLD.journal_entry_id THEN
    RAISE EXCEPTION
      'Invoice % has posted to the supplier ledger and the General Ledger (blueprint 3.2). Reverse it; it is not edited.',
      OLD.invoice_no USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 8.5 - an advance is paid against a purchase order the company has
-- actually committed to.
--
-- The foreign key says an order exists; this says it is one somebody approved.
-- Paying an advance against a draft order is money leaving the company for a
-- purchase nobody has agreed to make, which is the single control this document
-- provides.
-- ---------------------------------------------------------------------------
CREATE FUNCTION supplier_advance_order_is_committed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status   document_status;
  v_no       text;
  v_supplier uuid;
BEGIN
  SELECT status, order_no, supplier_id INTO v_status, v_no, v_supplier
    FROM purchase_order WHERE id = NEW.purchase_order_id;

  IF v_status IN ('draft', 'cancelled', 'rejected') THEN
    RAISE EXCEPTION
      'Purchase order % is %, so no advance can be paid against it (blueprint 8.5). An advance is paid against a commitment the company has made.',
      v_no, v_status
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The supplier comes from the order, never from the request. An advance paid
  -- to a different supplier from the one on the order is exactly the failure
  -- the link exists to prevent.
  IF NEW.supplier_id IS DISTINCT FROM v_supplier THEN
    RAISE EXCEPTION
      'Advance % names a different supplier from purchase order % (blueprint 8.5). The advance belongs to the supplier on the order.',
      NEW.advance_no, v_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER supplier_advance_order_is_committed
  BEFORE INSERT OR UPDATE ON supplier_advance
  FOR EACH ROW EXECUTE FUNCTION supplier_advance_order_is_committed();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 8.5 - a settlement never exceeds either balance, and the two balances
-- move together.
--
-- The CHECK constraints on each table bound each side on its own. What no CHECK
-- can see is the *pair*: that this settlement's amount is available on the
-- advance AND owed on the invoice at the moment it is written. Two clerks
-- settling the same advance against two different invoices would each pass a
-- per-row check and together over-consume it.
--
-- Rows are locked in a fixed order - advance, then invoice - so two concurrent
-- settlements queue rather than deadlock.
-- ---------------------------------------------------------------------------
CREATE FUNCTION supplier_advance_settlement_within_balances() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_available numeric(19,4);
  v_owed      numeric(19,4);
  v_adv_no    text;
  v_inv_no    text;
BEGIN
  SELECT advance_no, amount_iqd - settled_amount_iqd - refunded_amount_iqd
    INTO v_adv_no, v_available
    FROM supplier_advance WHERE id = NEW.supplier_advance_id FOR UPDATE;

  SELECT invoice_no, total_iqd - settled_amount_iqd
    INTO v_inv_no, v_owed
    FROM ap_invoice WHERE id = NEW.ap_invoice_id FOR UPDATE;

  IF NEW.amount_iqd > v_available THEN
    RAISE EXCEPTION
      'Settling % would exceed what is left of advance % (% available) - blueprint 8.5.',
      NEW.amount_iqd, v_adv_no, v_available
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.amount_iqd > v_owed THEN
    RAISE EXCEPTION
      'Settling % would exceed what is still owed on invoice % (% owed) - blueprint 8.5.',
      NEW.amount_iqd, v_inv_no, v_owed
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER supplier_advance_settlement_within_balances
  BEFORE INSERT ON supplier_advance_settlement
  FOR EACH ROW EXECUTE FUNCTION supplier_advance_settlement_within_balances();--> statement-breakpoint

-- Numbering, document type, statuses and permissions.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('SUPPLIER_ADVANCE', 'ADV', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('supplier_advance', 'Supplier Advance', 'purchasing',
   'Money paid to a supplier before delivery, against a purchase order (blueprint 8.5). An asset until it is settled against an invoice or refunded.');--> statement-breakpoint

-- Appendix B: Draft, Approved, Paid, Partially Settled, Settled, Refunded,
-- Reversed - mapped onto section 3.2's shared vocabulary.
INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('supplier_advance', 'draft',              'approved'),
  ('supplier_advance', 'draft',              'rejected'),
  ('supplier_advance', 'draft',              'cancelled'),
  ('supplier_advance', 'rejected',           'draft'),
  ('supplier_advance', 'approved',           'posted'),
  ('supplier_advance', 'approved',           'cancelled'),
  ('supplier_advance', 'posted',             'partially_executed'),
  ('supplier_advance', 'posted',             'settled'),
  ('supplier_advance', 'posted',             'closed'),
  ('supplier_advance', 'partially_executed', 'settled'),
  ('supplier_advance', 'partially_executed', 'closed'),
  ('supplier_advance', 'posted',             'reversed');--> statement-breakpoint

INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('supplier_advance', 'purchase_order_id',
   'Decides which commitment the advance is paid against (blueprint 8.5). It also decides the supplier.'),
  ('supplier_advance', 'amount_iqd',
   'The money leaving the company. Changed after approval, it would be paid without having been approved.'),
  ('supplier_advance', 'branch_code',
   'An advance posts to one branch (blueprint 14.3).')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Section 8.6 - Supplier Advance and Supplier Payment are owned by Finance /
-- Treasury. The officer requests; the manager approves and pays.
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'supplier_advance', 'view'),
  ('accounting_officer', 'supplier_advance', 'create'),
  ('accounting_officer', 'supplier_advance', 'edit_draft'),
  ('accounting_officer', 'supplier_advance', 'submit'),
  ('accounting_officer', 'supplier_advance', 'print'),
  ('accounting_manager', 'supplier_advance', 'view'),
  ('accounting_manager', 'supplier_advance', 'create'),
  ('accounting_manager', 'supplier_advance', 'edit_draft'),
  ('accounting_manager', 'supplier_advance', 'submit'),
  ('accounting_manager', 'supplier_advance', 'approve'),
  ('accounting_manager', 'supplier_advance', 'post'),
  ('accounting_manager', 'supplier_advance', 'reverse_cancel'),
  ('accounting_manager', 'supplier_advance', 'print'),
  ('accounting_manager', 'supplier_advance', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist - grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON supplier_advance, supplier_advance_settlement FROM erp_app;

  -- No DELETE on either: an advance is cancelled or reversed, and a settlement
  -- is reversed. Appendix C calls the settlement history a record, and a record
  -- that can be deleted is not one.
  GRANT SELECT, INSERT, UPDATE ON supplier_advance TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON supplier_advance_settlement TO erp_app;
END;
$$;--> statement-breakpoint

ALTER TABLE supplier_advance ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE supplier_advance FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY supplier_advance_branch_scope ON supplier_advance
  USING (app_is_super_user() OR branch_code = app_current_branch())
  WITH CHECK (app_is_super_user() OR branch_code = app_current_branch());
