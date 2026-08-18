CREATE TYPE "public"."match_status" AS ENUM('matched', 'exception');--> statement-breakpoint
CREATE TYPE "public"."variance_kind" AS ENUM('quantity', 'price', 'value');--> statement-breakpoint
CREATE TABLE "ap_invoice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_no" text NOT NULL,
	"supplier_invoice_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"match_status" "match_status" DEFAULT 'exception' NOT NULL,
	"supplier_id" uuid NOT NULL,
	"purchase_order_id" uuid,
	"branch_code" text NOT NULL,
	"invoice_date" date NOT NULL,
	"due_date" date NOT NULL,
	"currency" text DEFAULT 'IQD' NOT NULL,
	"note" text,
	"variance_value_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"variance_approved_by" uuid,
	"variance_approved_at" timestamp with time zone,
	"variance_approval_reason" text,
	"duplicate_approved_by" uuid,
	"duplicate_approved_at" timestamp with time zone,
	"duplicate_approval_reason" text,
	"non_po_justification" text,
	"non_po_approved_by" uuid,
	"non_po_approved_at" timestamp with time zone,
	"journal_entry_id" uuid,
	"created_by" uuid NOT NULL,
	"submitted_by" uuid,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"reversed_by" uuid,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ap_invoice_variance_approval_complete" CHECK (("ap_invoice"."variance_approved_by" is null and "ap_invoice"."variance_approved_at" is null
           and "ap_invoice"."variance_approval_reason" is null)
          or ("ap_invoice"."variance_approved_by" is not null and "ap_invoice"."variance_approved_at" is not null
              and coalesce(btrim("ap_invoice"."variance_approval_reason"), '') <> '')),
	CONSTRAINT "ap_invoice_duplicate_approval_complete" CHECK (("ap_invoice"."duplicate_approved_by" is null and "ap_invoice"."duplicate_approved_at" is null
           and "ap_invoice"."duplicate_approval_reason" is null)
          or ("ap_invoice"."duplicate_approved_by" is not null and "ap_invoice"."duplicate_approved_at" is not null
              and coalesce(btrim("ap_invoice"."duplicate_approval_reason"), '') <> '')),
	CONSTRAINT "ap_invoice_non_po_needs_justification" CHECK ("ap_invoice"."purchase_order_id" is not null
          or (coalesce(btrim("ap_invoice"."non_po_justification"), '') <> ''
              and "ap_invoice"."non_po_approved_by" is not null
              and "ap_invoice"."non_po_approved_at" is not null)),
	CONSTRAINT "ap_invoice_reversal_has_reason" CHECK (("ap_invoice"."reversed_by" is null and "ap_invoice"."reversed_at" is null)
          or ("ap_invoice"."reversed_by" is not null and "ap_invoice"."reversed_at" is not null
              and coalesce(btrim("ap_invoice"."reversal_reason"), '') <> '')),
	CONSTRAINT "ap_invoice_due_not_before_invoice" CHECK ("ap_invoice"."due_date" >= "ap_invoice"."invoice_date")
);
--> statement-breakpoint
CREATE TABLE "ap_invoice_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ap_invoice_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"purchase_order_line_id" uuid,
	"item_code" text,
	"description" text NOT NULL,
	"quantity" numeric(24, 6) NOT NULL,
	"uom_code" text NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"is_inventory" boolean DEFAULT false NOT NULL,
	"cost_centre_code" text,
	"match_status" "match_status" DEFAULT 'exception' NOT NULL,
	"received_quantity" numeric(24, 6) DEFAULT '0' NOT NULL,
	"variance_value_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "ap_invoice_line_quantity_positive" CHECK ("ap_invoice_line"."quantity" > 0),
	CONSTRAINT "ap_invoice_line_price_not_negative" CHECK ("ap_invoice_line"."unit_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ap_match_exception" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ap_invoice_id" uuid NOT NULL,
	"ap_invoice_line_id" uuid,
	"kind" "variance_kind" NOT NULL,
	"expected" numeric(24, 6) NOT NULL,
	"actual" numeric(24, 6) NOT NULL,
	"difference" numeric(24, 6) NOT NULL,
	"reason" text NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"resolution_reason" text,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ap_match_exception_resolution_complete" CHECK (("ap_match_exception"."resolved_by" is null and "ap_match_exception"."resolved_at" is null and "ap_match_exception"."resolution" is null)
          or ("ap_match_exception"."resolved_by" is not null and "ap_match_exception"."resolved_at" is not null
              and "ap_match_exception"."resolution" in ('approved', 'corrected')
              and coalesce(btrim("ap_match_exception"."resolution_reason"), '') <> ''))
);
--> statement-breakpoint
CREATE TABLE "ap_match_tolerance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_id" uuid,
	"quantity_percent" numeric(9, 4) DEFAULT '0' NOT NULL,
	"price_percent" numeric(9, 4) DEFAULT '0' NOT NULL,
	"value_percent" numeric(9, 4) DEFAULT '0' NOT NULL,
	"note" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ap_match_tolerance_range" CHECK ("ap_match_tolerance"."quantity_percent" between 0 and 100
          and "ap_match_tolerance"."price_percent" between 0 and 100
          and "ap_match_tolerance"."value_percent" between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "ap_invoice" ADD CONSTRAINT "ap_invoice_supplier_id_business_partner_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_invoice" ADD CONSTRAINT "ap_invoice_purchase_order_id_purchase_order_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_invoice" ADD CONSTRAINT "ap_invoice_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_invoice" ADD CONSTRAINT "ap_invoice_variance_approved_by_app_user_id_fk" FOREIGN KEY ("variance_approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_invoice" ADD CONSTRAINT "ap_invoice_duplicate_approved_by_app_user_id_fk" FOREIGN KEY ("duplicate_approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_invoice" ADD CONSTRAINT "ap_invoice_non_po_approved_by_app_user_id_fk" FOREIGN KEY ("non_po_approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_invoice" ADD CONSTRAINT "ap_invoice_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_invoice" ADD CONSTRAINT "ap_invoice_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_invoice" ADD CONSTRAINT "ap_invoice_submitted_by_app_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_invoice" ADD CONSTRAINT "ap_invoice_posted_by_app_user_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_invoice" ADD CONSTRAINT "ap_invoice_reversed_by_app_user_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_invoice_line" ADD CONSTRAINT "ap_invoice_line_ap_invoice_id_ap_invoice_id_fk" FOREIGN KEY ("ap_invoice_id") REFERENCES "public"."ap_invoice"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_invoice_line" ADD CONSTRAINT "ap_invoice_line_purchase_order_line_id_purchase_order_line_id_fk" FOREIGN KEY ("purchase_order_line_id") REFERENCES "public"."purchase_order_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_invoice_line" ADD CONSTRAINT "ap_invoice_line_item_code_item_code_fk" FOREIGN KEY ("item_code") REFERENCES "public"."item"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_invoice_line" ADD CONSTRAINT "ap_invoice_line_uom_code_unit_of_measure_code_fk" FOREIGN KEY ("uom_code") REFERENCES "public"."unit_of_measure"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_invoice_line" ADD CONSTRAINT "ap_invoice_line_cost_centre_code_cost_centre_code_fk" FOREIGN KEY ("cost_centre_code") REFERENCES "public"."cost_centre"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_match_exception" ADD CONSTRAINT "ap_match_exception_ap_invoice_id_ap_invoice_id_fk" FOREIGN KEY ("ap_invoice_id") REFERENCES "public"."ap_invoice"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_match_exception" ADD CONSTRAINT "ap_match_exception_ap_invoice_line_id_ap_invoice_line_id_fk" FOREIGN KEY ("ap_invoice_line_id") REFERENCES "public"."ap_invoice_line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_match_exception" ADD CONSTRAINT "ap_match_exception_resolved_by_app_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_match_tolerance" ADD CONSTRAINT "ap_match_tolerance_supplier_id_business_partner_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_match_tolerance" ADD CONSTRAINT "ap_match_tolerance_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ap_invoice_no_uniq" ON "ap_invoice" USING btree ("invoice_no");--> statement-breakpoint
CREATE INDEX "ap_invoice_supplier_idx" ON "ap_invoice" USING btree ("supplier_id","status");--> statement-breakpoint
CREATE INDEX "ap_invoice_match_idx" ON "ap_invoice" USING btree ("match_status","status");--> statement-breakpoint
CREATE INDEX "ap_invoice_order_idx" ON "ap_invoice" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ap_invoice_supplier_number_uniq" ON "ap_invoice" USING btree ("supplier_id","supplier_invoice_no") WHERE duplicate_approved_by is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ap_invoice_line_no_uniq" ON "ap_invoice_line" USING btree ("ap_invoice_id","line_no");--> statement-breakpoint
CREATE INDEX "ap_invoice_line_po_line_idx" ON "ap_invoice_line" USING btree ("purchase_order_line_id");--> statement-breakpoint
CREATE INDEX "ap_match_exception_invoice_idx" ON "ap_match_exception" USING btree ("ap_invoice_id");--> statement-breakpoint
CREATE INDEX "ap_match_exception_open_idx" ON "ap_match_exception" USING btree ("resolved_at","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "ap_match_tolerance_supplier_uniq" ON "ap_match_tolerance" USING btree ("supplier_id") WHERE supplier_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ap_match_tolerance_default_uniq" ON "ap_match_tolerance" USING btree ((true)) WHERE supplier_id is null;
-- ---------------------------------------------------------------------------
-- Section 8.4 - the mandatory half of the three-way match.
--
--   "Every A/P Invoice must be created from both a Purchase Order and Goods
--    Receipt, or from a Purchase Order and Service Receipt / Expense
--    Confirmation."
--
-- Enforced in the database because the gate says "verified on UI, API and
-- import": three routes into the same table, and a rule held in one service is
-- a rule the other two can miss. A missing receipt is not a variance somebody
-- may approve - it is an invoice for goods nobody has confirmed arrived.
--
-- The section 15 non-PO route is exempt by construction: it has no purchase
-- order line to check, and it pays for that exemption with a justification and
-- a second approver (the ap_invoice_non_po_needs_justification check).
-- ---------------------------------------------------------------------------
CREATE FUNCTION ap_invoice_line_needs_receipt() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_line_type   purchase_line_type;
  v_line_no     integer;
  v_order_no    text;
  v_order_id    uuid;
  v_invoice_ord uuid;
  v_evidence    numeric(24,6);
BEGIN
  IF NEW.purchase_order_line_id IS NULL THEN
    RETURN NEW;  -- section 15 non-PO route; guarded by its own check.
  END IF;

  SELECT l.line_type, l.line_no, o.order_no, o.id
    INTO v_line_type, v_line_no, v_order_no, v_order_id
    FROM purchase_order_line l
    JOIN purchase_order o ON o.id = l.purchase_order_id
   WHERE l.id = NEW.purchase_order_line_id;

  SELECT purchase_order_id INTO v_invoice_ord
    FROM ap_invoice WHERE id = NEW.ap_invoice_id;

  IF v_invoice_ord IS DISTINCT FROM v_order_id THEN
    RAISE EXCEPTION
      'Invoice line % belongs to a different purchase order from the invoice (blueprint 8.4). An invoice covers one order.',
      NEW.line_no
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_line_type = 'inventory_item' THEN
    -- Goods: what the warehouse posted.
    SELECT coalesce(sum(l.quantity), 0) INTO v_evidence
      FROM goods_receipt_line l
      JOIN goods_receipt r ON r.id = l.goods_receipt_id
     WHERE l.purchase_order_line_id = NEW.purchase_order_line_id
       AND r.status = 'executed';
  ELSE
    -- Services and expenses: what the benefiting department confirmed.
    SELECT coalesce(sum(l.quantity), 0) INTO v_evidence
      FROM service_receipt_line l
      JOIN service_receipt r ON r.id = l.service_receipt_id
     WHERE l.purchase_order_line_id = NEW.purchase_order_line_id
       AND r.status = 'approved';
  END IF;

  IF v_evidence <= 0 THEN
    RAISE EXCEPTION
      'Line % of % has nothing received against it, so it cannot be invoiced (blueprint 8.4). %',
      v_line_no, v_order_no,
      CASE WHEN v_line_type = 'inventory_item'
           THEN 'The warehouse records a Goods Receipt first.'
           ELSE 'The benefiting department confirms the service first (blueprint 8.6).' END
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER ap_invoice_line_needs_receipt
  BEFORE INSERT OR UPDATE ON ap_invoice_line
  FOR EACH ROW EXECUTE FUNCTION ap_invoice_line_needs_receipt();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 8.4 - "variances are allowed only after manager approval."
--
-- An invoice in exception does not post. It posts when the exception has been
-- resolved, or when a manager has accepted the variance in writing - and the
-- database is what makes "in writing" mean something, because a service can be
-- bypassed and a check constraint cannot.
-- ---------------------------------------------------------------------------
CREATE FUNCTION ap_invoice_exception_blocks_posting() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_open integer;
BEGIN
  IF NEW.status <> 'posted' OR OLD.status = 'posted' THEN
    RETURN NEW;
  END IF;

  IF NEW.match_status = 'exception' AND NEW.variance_approved_by IS NULL THEN
    RAISE EXCEPTION
      'Invoice % is in exception and no manager has accepted the variance (blueprint 8.4). Resolve the exception or record the approval, then post.',
      NEW.invoice_no USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT count(*) INTO v_open
    FROM ap_match_exception
   WHERE ap_invoice_id = NEW.id AND resolved_at IS NULL;

  IF v_open > 0 THEN
    RAISE EXCEPTION
      'Invoice % has % unresolved match exception(s) (blueprint 8.4). Each one is a decision somebody has to record before the invoice posts.',
      NEW.invoice_no, v_open USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER ap_invoice_exception_blocks_posting
  BEFORE UPDATE ON ap_invoice
  FOR EACH ROW EXECUTE FUNCTION ap_invoice_exception_blocks_posting();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 1.1 and 3.2 - a posted invoice is history.
--
-- It has moved the supplier ledger and the General Ledger. Payment status is
-- the one thing that still changes, because being paid is something that
-- happens to a posted invoice rather than a change to what it says.
-- ---------------------------------------------------------------------------
CREATE FUNCTION ap_invoice_posted_is_final() RETURNS trigger
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
  OR NEW.journal_entry_id     IS DISTINCT FROM OLD.journal_entry_id THEN
    RAISE EXCEPTION
      'Invoice % has posted to the supplier ledger and the General Ledger (blueprint 3.2). Reverse it; it is not edited.',
      OLD.invoice_no USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER ap_invoice_posted_is_final
  BEFORE UPDATE ON ap_invoice
  FOR EACH ROW EXECUTE FUNCTION ap_invoice_posted_is_final();--> statement-breakpoint

CREATE FUNCTION ap_invoice_line_posted_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status document_status;
  v_no     text;
BEGIN
  SELECT status, invoice_no INTO v_status, v_no
    FROM ap_invoice WHERE id = coalesce(NEW.ap_invoice_id, OLD.ap_invoice_id);

  IF v_status NOT IN ('posted', 'partially_executed', 'settled') THEN
    RETURN coalesce(NEW, OLD);
  END IF;

  RAISE EXCEPTION
    'Invoice % has posted; what it charges cannot be changed (blueprint 3.2). Reverse it and raise a corrected invoice.',
    v_no USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint

CREATE TRIGGER ap_invoice_line_posted_is_final
  BEFORE UPDATE OR DELETE ON ap_invoice_line
  FOR EACH ROW EXECUTE FUNCTION ap_invoice_line_posted_is_final();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A resolved exception is a record of a decision, and is never removed.
--
-- An *open* exception is different in kind: it is derived state, recomputed
-- every time the match runs, and replacing it when the invoice or the receipts
-- change is exactly right. The distinction matters because the two look
-- identical in the table and only one of them is evidence - somebody accepted a
-- variance, gave a reason, and put their name to it (blueprint 5.4).
--
-- So DELETE is granted and this trigger draws the line, rather than the grant
-- drawing it in the wrong place.
-- ---------------------------------------------------------------------------
CREATE FUNCTION ap_match_exception_resolved_is_permanent() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION
      'That match exception was resolved by a person who gave a reason (blueprint 5.4); it is part of the record and is not deleted.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint

CREATE TRIGGER ap_match_exception_resolved_is_permanent
  BEFORE DELETE ON ap_match_exception
  FOR EACH ROW EXECUTE FUNCTION ap_match_exception_resolved_is_permanent();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The company-wide match tolerance: zero on all three.
--
-- Section 8.4 allows no variance without a manager. The row exists so Finance
-- can relax it without a code change; it starts at the value the blueprint
-- states, and a default that quietly permitted a variance would be the
-- implementation team deciding what "small" means.
-- ---------------------------------------------------------------------------
INSERT INTO ap_match_tolerance (supplier_id, quantity_percent, price_percent, value_percent, note)
VALUES (NULL, 0, 0, 0,
  'Company default. Blueprint 8.4 allows quantity, price and value variances only after manager approval, so nothing is absorbed until Finance says otherwise.');--> statement-breakpoint

-- Numbering, document type, statuses and permissions.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('AP_INVOICE', 'API', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('ap_invoice', 'A/P Invoice', 'purchasing',
   'The supplier charge, matched against the purchase order and the receipt (blueprint 8.4). Owned by Finance (blueprint 8.6). Posts Dr GRNI or Expense and approved variances / Cr Supplier A/P.');--> statement-breakpoint

-- Appendix B: Draft, Matched, Exception, Pending Approval, Posted, Partially
-- Paid, Paid, Reversed. Matched and Exception are the match axis and live in
-- match_status; the rest map onto section 3.2's shared vocabulary.
INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('ap_invoice', 'draft',              'submitted'),
  ('ap_invoice', 'submitted',          'posted'),
  ('ap_invoice', 'submitted',          'rejected'),
  ('ap_invoice', 'submitted',          'draft'),
  ('ap_invoice', 'rejected',           'draft'),
  ('ap_invoice', 'draft',              'cancelled'),
  ('ap_invoice', 'posted',             'partially_executed'),
  ('ap_invoice', 'posted',             'settled'),
  ('ap_invoice', 'partially_executed', 'settled'),
  ('ap_invoice', 'posted',             'reversed');--> statement-breakpoint

INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('ap_invoice', 'supplier_id',
   'Decides who is owed the money and which subledger moves.'),
  ('ap_invoice', 'supplier_invoice_no',
   'The supplier''s own number, unique per supplier (blueprint 15). Changing it after submission would defeat the duplicate control.'),
  ('ap_invoice', 'purchase_order_id',
   'Decides what the three-way match compares the invoice against (blueprint 8.4).'),
  ('ap_invoice', 'invoice_date',
   'Decides the accounting period and, with the payment terms, the due date.'),
  ('ap_invoice', 'branch_code',
   'An invoice posts to one branch (blueprint 14.3).')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Section 8.6 - the A/P Invoice is owned by Finance. The officer raises and
-- submits; the manager accepts variances and posts.
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'ap_invoice', 'view'),
  ('accounting_officer', 'ap_invoice', 'create'),
  ('accounting_officer', 'ap_invoice', 'edit_draft'),
  ('accounting_officer', 'ap_invoice', 'submit'),
  ('accounting_officer', 'ap_invoice', 'import'),
  ('accounting_officer', 'ap_invoice', 'print'),
  ('accounting_manager', 'ap_invoice', 'view'),
  ('accounting_manager', 'ap_invoice', 'create'),
  ('accounting_manager', 'ap_invoice', 'edit_draft'),
  ('accounting_manager', 'ap_invoice', 'submit'),
  ('accounting_manager', 'ap_invoice', 'approve'),
  ('accounting_manager', 'ap_invoice', 'post'),
  ('accounting_manager', 'ap_invoice', 'reverse_cancel'),
  ('accounting_manager', 'ap_invoice', 'configure'),
  ('accounting_manager', 'ap_invoice', 'import'),
  ('accounting_manager', 'ap_invoice', 'print'),
  ('accounting_manager', 'ap_invoice', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist - grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON ap_invoice, ap_invoice_line, ap_match_exception, ap_match_tolerance FROM erp_app;

  GRANT SELECT, INSERT, UPDATE ON ap_invoice TO erp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ap_invoice_line TO erp_app;
  -- DELETE is granted, and the trigger above is what limits it: an *open*
  -- exception is derived state and is replaced whenever the match is re-run; a
  -- *resolved* one is the record of a decision and can never be removed.
  GRANT SELECT, INSERT, UPDATE, DELETE ON ap_match_exception TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON ap_match_tolerance TO erp_app;
END;
$$;--> statement-breakpoint

ALTER TABLE ap_invoice ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ap_invoice FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY ap_invoice_branch_scope ON ap_invoice
  USING (app_is_super_user() OR branch_code = app_current_branch())
  WITH CHECK (app_is_super_user() OR branch_code = app_current_branch());
