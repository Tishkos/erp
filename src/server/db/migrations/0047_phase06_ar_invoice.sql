CREATE TABLE "ar_invoice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"delivery_note_id" uuid NOT NULL,
	"sales_order_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"invoice_date" date NOT NULL,
	"payment_terms_code" text,
	"due_date" date NOT NULL,
	"currency" text DEFAULT 'IQD' NOT NULL,
	"gross_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"discount_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"net_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"allocated_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
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
	CONSTRAINT "ar_invoice_reversal_has_reason" CHECK (("ar_invoice"."reversed_by" is null and "ar_invoice"."reversed_at" is null)
          or ("ar_invoice"."reversed_by" is not null and "ar_invoice"."reversed_at" is not null
              and coalesce(btrim("ar_invoice"."reversal_reason"), '') <> '')),
	CONSTRAINT "ar_invoice_totals_consistent" CHECK ("ar_invoice"."net_iqd" = "ar_invoice"."gross_iqd" - "ar_invoice"."discount_iqd"
          and "ar_invoice"."discount_iqd" >= 0 and "ar_invoice"."gross_iqd" >= 0),
	CONSTRAINT "ar_invoice_allocation_within_total" CHECK ("ar_invoice"."allocated_iqd" >= 0 and "ar_invoice"."allocated_iqd" <= "ar_invoice"."net_iqd"),
	CONSTRAINT "ar_invoice_due_after_issue" CHECK ("ar_invoice"."due_date" >= "ar_invoice"."invoice_date"),
	CONSTRAINT "ar_invoice_posting_matches_status" CHECK (("ar_invoice"."journal_entry_id" is null) = ("ar_invoice"."posted_at" is null)),
	CONSTRAINT "ar_invoice_stamps_in_order" CHECK (("ar_invoice"."posted_at" is null or "ar_invoice"."approved_at" is not null)
          and ("ar_invoice"."posted_at" is null or "ar_invoice"."approved_at" <= "ar_invoice"."posted_at")
          and ("ar_invoice"."reversed_at" is null or "ar_invoice"."posted_at" is not null)
          and ("ar_invoice"."reversed_at" is null or "ar_invoice"."posted_at" <= "ar_invoice"."reversed_at"))
);
--> statement-breakpoint
CREATE TABLE "ar_invoice_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ar_invoice_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"delivery_note_line_id" uuid NOT NULL,
	"sales_order_line_id" uuid NOT NULL,
	"item_code" text NOT NULL,
	"description" text NOT NULL,
	"uom_code" text NOT NULL,
	"quantity" numeric(24, 6) NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"discount_percent" numeric(9, 4),
	"discount_amount_iqd" numeric(19, 4),
	"gross_iqd" numeric(19, 4) NOT NULL,
	"net_iqd" numeric(19, 4) NOT NULL,
	CONSTRAINT "ar_invoice_line_quantity_positive" CHECK ("ar_invoice_line"."quantity" > 0),
	CONSTRAINT "ar_invoice_line_price_not_negative" CHECK ("ar_invoice_line"."unit_price" >= 0),
	CONSTRAINT "ar_invoice_line_one_discount_form" CHECK ("ar_invoice_line"."discount_percent" is null or "ar_invoice_line"."discount_amount_iqd" is null),
	CONSTRAINT "ar_invoice_line_net_consistent" CHECK ("ar_invoice_line"."net_iqd" <= "ar_invoice_line"."gross_iqd")
);
--> statement-breakpoint
ALTER TABLE "ar_invoice" ADD CONSTRAINT "ar_invoice_delivery_note_id_delivery_note_id_fk" FOREIGN KEY ("delivery_note_id") REFERENCES "public"."delivery_note"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_invoice" ADD CONSTRAINT "ar_invoice_sales_order_id_sales_order_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_invoice" ADD CONSTRAINT "ar_invoice_customer_id_business_partner_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_invoice" ADD CONSTRAINT "ar_invoice_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_invoice" ADD CONSTRAINT "ar_invoice_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_invoice" ADD CONSTRAINT "ar_invoice_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_invoice" ADD CONSTRAINT "ar_invoice_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_invoice" ADD CONSTRAINT "ar_invoice_posted_by_app_user_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_invoice" ADD CONSTRAINT "ar_invoice_reversed_by_app_user_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_invoice_line" ADD CONSTRAINT "ar_invoice_line_ar_invoice_id_ar_invoice_id_fk" FOREIGN KEY ("ar_invoice_id") REFERENCES "public"."ar_invoice"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_invoice_line" ADD CONSTRAINT "ar_invoice_line_delivery_note_line_id_delivery_note_line_id_fk" FOREIGN KEY ("delivery_note_line_id") REFERENCES "public"."delivery_note_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_invoice_line" ADD CONSTRAINT "ar_invoice_line_sales_order_line_id_sales_order_line_id_fk" FOREIGN KEY ("sales_order_line_id") REFERENCES "public"."sales_order_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_invoice_line" ADD CONSTRAINT "ar_invoice_line_item_code_item_code_fk" FOREIGN KEY ("item_code") REFERENCES "public"."item"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_invoice_line" ADD CONSTRAINT "ar_invoice_line_uom_code_unit_of_measure_code_fk" FOREIGN KEY ("uom_code") REFERENCES "public"."unit_of_measure"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ar_invoice_no_uniq" ON "ar_invoice" USING btree ("invoice_no");--> statement-breakpoint
CREATE UNIQUE INDEX "ar_invoice_delivery_uniq" ON "ar_invoice" USING btree ("delivery_note_id") WHERE "ar_invoice"."status" <> 'reversed';--> statement-breakpoint
CREATE INDEX "ar_invoice_customer_idx" ON "ar_invoice" USING btree ("customer_id","status");--> statement-breakpoint
CREATE INDEX "ar_invoice_due_idx" ON "ar_invoice" USING btree ("due_date","status");--> statement-breakpoint
CREATE INDEX "ar_invoice_order_idx" ON "ar_invoice" USING btree ("sales_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ar_invoice_line_no_uniq" ON "ar_invoice_line" USING btree ("ar_invoice_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "ar_invoice_line_delivery_line_uniq" ON "ar_invoice_line" USING btree ("ar_invoice_id","delivery_note_line_id");--> statement-breakpoint
CREATE INDEX "ar_invoice_line_order_line_idx" ON "ar_invoice_line" USING btree ("sales_order_line_id");--> statement-breakpoint
CREATE INDEX "ar_invoice_line_item_idx" ON "ar_invoice_line" USING btree ("item_code");
-- ===========================================================================
-- Phase 06.6 — A/R Invoice (§7.4, Appendix B, Appendix C)
--
--   "Every inventory A/R Invoice shall be created from an approved Delivery
--    Note. The A/R Invoice shall be issued on the same date as delivery."
--
-- Appendix B: Draft, Approved, Posted, Partially Paid, Paid, Reversed; source
-- Delivery Note; effect **A/R and revenue**.
--
-- **The cost is not posted here.** The Delivery Note posted Dr COGS / Cr
-- Inventory when the goods left (06.5). Appendix C's single "Sales delivery and
-- invoice" row describes the combined economic event across the two documents;
-- Appendix B is where the split is stated, and it is why this table has no COGS
-- column to record the double in.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 06.6 gate — *"An A/R Invoice without a source Delivery Note is impossible via
-- UI, API and import."*
--
-- `delivery_note_id` is NOT NULL above, which closes the "no delivery at all"
-- case by construction. This closes the rest: the delivery must have actually
-- delivered, and the invoice must belong to the same order and customer as the
-- delivery it names. A note that is merely approved is one on a van.
-- ---------------------------------------------------------------------------
CREATE FUNCTION ar_invoice_has_a_real_delivery() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status    text;
  v_order     uuid;
  v_note_no   text;
  v_date      date;
  v_branch    text;
  v_customer  uuid;
BEGIN
  SELECT n.status::text, n.sales_order_id, n.delivery_note_no, n.delivery_date, n.branch_code,
         o.customer_id
    INTO v_status, v_order, v_note_no, v_date, v_branch, v_customer
    FROM delivery_note n
    JOIN sales_order o ON o.id = n.sales_order_id
   WHERE n.id = NEW.delivery_note_id;

  IF v_status IS DISTINCT FROM 'executed' THEN
    RAISE EXCEPTION
      'Delivery Note % is %, and blueprint 7.4 requires every inventory A/R Invoice to come from an approved Delivery Note. A note that has not delivered has given the customer nothing to be billed for.',
      v_note_no, coalesce(v_status, 'missing')
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.sales_order_id IS DISTINCT FROM v_order THEN
    RAISE EXCEPTION
      'A/R Invoice names Sales Order % but Delivery Note % was raised against another. The invoice, the delivery and the order reconcile to each other (blueprint 7.7).',
      NEW.sales_order_id, v_note_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.customer_id IS DISTINCT FROM v_customer THEN
    RAISE EXCEPTION
      'A/R Invoice bills a different customer from the one Sales Order behind Delivery Note % was taken for.',
      v_note_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Blueprint 7.4 and Appendix C - "same delivery and invoice date". An equality,
  -- not a tolerance: the cost posted on the delivery date, and an invoice a week
  -- later puts the revenue in a different month from its own cost of sale.
  IF NEW.invoice_date IS DISTINCT FROM v_date THEN
    RAISE EXCEPTION
      'A/R Invoice is dated % but Delivery Note % was delivered on %. Blueprint 7.4 requires the invoice to be issued on the delivery date, so the cost and the revenue of a sale share a period.',
      NEW.invoice_date, v_note_no, v_date
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.branch_code IS DISTINCT FROM v_branch THEN
    RAISE EXCEPTION
      'A/R Invoice is in branch % but Delivery Note % was delivered from %.',
      NEW.branch_code, v_note_no, v_branch
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER ar_invoice_has_a_real_delivery
  BEFORE INSERT OR UPDATE ON ar_invoice
  FOR EACH ROW EXECUTE FUNCTION ar_invoice_has_a_real_delivery();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 06.6 gate — *"Invoice quantities cannot exceed delivered quantities"*, and
-- blueprint 7.3's price, which "cannot be edited" anywhere in the sales chain.
--
-- Both in the database as well as in the service, because blueprint 7.7 says the
-- sales controls cannot be bypassed through the UI or the API — and an import
-- is neither route.
-- ---------------------------------------------------------------------------
CREATE FUNCTION ar_invoice_line_within_delivered() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_delivered numeric(24,6);
  v_invoiced  numeric(24,6);
  v_note      uuid;
  v_order_ln  uuid;
  v_item      text;
  v_price     numeric(19,4);
  v_inv_note  uuid;
BEGIN
  SELECT l.quantity, l.delivery_note_id, l.sales_order_line_id, l.item_code
    INTO v_delivered, v_note, v_order_ln, v_item
    FROM delivery_note_line l WHERE l.id = NEW.delivery_note_line_id;

  SELECT delivery_note_id INTO v_inv_note FROM ar_invoice WHERE id = NEW.ar_invoice_id;

  IF v_note IS DISTINCT FROM v_inv_note THEN
    RAISE EXCEPTION
      'An A/R Invoice line bills a delivery line from another Delivery Note. One invoice bills one delivery (blueprint 7.4).'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.sales_order_line_id IS DISTINCT FROM v_order_ln THEN
    RAISE EXCEPTION
      'An A/R Invoice line names an order line the delivery did not deliver against (blueprint 7.7).'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.item_code IS DISTINCT FROM v_item THEN
    RAISE EXCEPTION
      'A/R Invoice line names % but the delivery carried %. The item is carried down the chain, not chosen at invoicing.',
      NEW.item_code, v_item
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Cumulative across invoices: one delivery may be billed in stages, and it is
  -- the last one that is too large rather than any one on its own.
  SELECT coalesce(sum(l.quantity), 0) INTO v_invoiced
    FROM ar_invoice_line l
    JOIN ar_invoice i ON i.id = l.ar_invoice_id
   WHERE l.delivery_note_line_id = NEW.delivery_note_line_id
     AND l.id <> NEW.id
     AND i.status <> 'reversed';

  IF v_invoiced + NEW.quantity > coalesce(v_delivered, 0) THEN
    RAISE EXCEPTION
      'Invoicing % of % would bill more than was delivered. Delivered: %; already invoiced: %. A customer is billed for what they received (blueprint 7.7).',
      NEW.quantity, v_item, coalesce(v_delivered, 0), v_invoiced
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Blueprint 7.3 - the price came from the customer's price list and was locked on
  -- the Sales Order. The invoice records it; it does not get to choose it.
  SELECT unit_price INTO v_price FROM sales_order_line WHERE id = NEW.sales_order_line_id;

  IF NEW.unit_price IS DISTINCT FROM v_price THEN
    RAISE EXCEPTION
      'A/R Invoice line prices % at % but the Sales Order locked it at %. Unit prices come from the customer''s Price List and cannot be edited in the sales chain (blueprint 7.3, 7.7).',
      v_item, NEW.unit_price, v_price
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER ar_invoice_line_within_delivered
  BEFORE INSERT OR UPDATE ON ar_invoice_line
  FOR EACH ROW EXECUTE FUNCTION ar_invoice_line_within_delivered();--> statement-breakpoint

-- Numbering, document type, statuses and permissions.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('AR_INVOICE', 'INV', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('ar_invoice', 'A/R Invoice', 'sales',
   'Bills a customer for an approved Delivery Note, on the delivery date (blueprint 7.4). Posts Dr Customer A/R / Cr Sales Revenue; the cost of sale posted on the delivery (Appendix B).');--> statement-breakpoint

-- Appendix B: Draft, Approved, Posted, Partially Paid, Paid, Reversed - the same
-- mapping the A/P Invoice uses in 0036, because they are one lifecycle seen from
-- the two sides of a ledger.
INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('ar_invoice', 'draft',              'approved'),
  ('ar_invoice', 'draft',              'cancelled'),
  ('ar_invoice', 'approved',           'draft'),
  ('ar_invoice', 'approved',           'posted'),
  ('ar_invoice', 'posted',             'partially_executed'),
  ('ar_invoice', 'posted',             'settled'),
  ('ar_invoice', 'partially_executed', 'settled'),
  ('ar_invoice', 'posted',             'reversed');--> statement-breakpoint

INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('ar_invoice', 'delivery_note_id',
   'Decides what is being billed. Blueprint 7.4 makes the delivery the source of the invoice; changing it would bill a customer for somebody else''s shipment.'),
  ('ar_invoice', 'invoice_date',
   'Fixed to the delivery date by blueprint 7.4, and it decides the accounting period and the due date.'),
  ('ar_invoice', 'customer_id',
   'Decides who owes the money and which subledger moves.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'ar_invoice', 'view'),
  ('accounting_officer', 'ar_invoice', 'create'),
  ('accounting_officer', 'ar_invoice', 'edit_draft'),
  ('accounting_officer', 'ar_invoice', 'print'),
  ('accounting_manager', 'ar_invoice', 'view'),
  ('accounting_manager', 'ar_invoice', 'create'),
  ('accounting_manager', 'ar_invoice', 'edit_draft'),
  ('accounting_manager', 'ar_invoice', 'approve'),
  ('accounting_manager', 'ar_invoice', 'post'),
  ('accounting_manager', 'ar_invoice', 'reverse_cancel'),
  ('accounting_manager', 'ar_invoice', 'configure'),
  ('accounting_manager', 'ar_invoice', 'print'),
  ('accounting_manager', 'ar_invoice', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist - grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON ar_invoice, ar_invoice_line FROM erp_app;

  GRANT SELECT, INSERT, UPDATE ON ar_invoice TO erp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ar_invoice_line TO erp_app;
END;
$$;--> statement-breakpoint

-- D10 — the branch boundary.
ALTER TABLE ar_invoice ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ar_invoice FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY ar_invoice_branch_scope ON ar_invoice
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

ALTER TABLE ar_invoice_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ar_invoice_line FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY ar_invoice_line_branch_scope ON ar_invoice_line
  USING (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM ar_invoice i
       WHERE i.id = ar_invoice_line.ar_invoice_id
         AND app_branch_allowed(i.branch_code)
    )
  )
  WITH CHECK (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM ar_invoice i
       WHERE i.id = ar_invoice_line.ar_invoice_id
         AND app_branch_allowed(i.branch_code)
    )
  );
