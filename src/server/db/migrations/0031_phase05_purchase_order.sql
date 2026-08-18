CREATE TYPE "public"."purchase_line_type" AS ENUM('inventory_item', 'service', 'fixed_asset', 'expense');--> statement-breakpoint
CREATE TABLE "purchase_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"supplier_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"order_date" date NOT NULL,
	"expected_date" date,
	"currency" text DEFAULT 'IQD' NOT NULL,
	"payment_terms_code" text,
	"reference" text,
	"note" text,
	"created_by" uuid NOT NULL,
	"submitted_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_order_cancellation_has_reason" CHECK (("purchase_order"."cancelled_by" is null and "purchase_order"."cancelled_at" is null)
          or ("purchase_order"."cancelled_by" is not null and "purchase_order"."cancelled_at" is not null
              and coalesce(btrim("purchase_order"."cancellation_reason"), '') <> ''))
);
--> statement-breakpoint
CREATE TABLE "purchase_order_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"line_type" "purchase_line_type" NOT NULL,
	"item_code" text,
	"description" text NOT NULL,
	"quantity" numeric(24, 6) NOT NULL,
	"uom_code" text NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"branch_code" text NOT NULL,
	"warehouse_code" text,
	"cost_centre_code" text,
	"received_quantity" numeric(24, 6) DEFAULT '0' NOT NULL,
	"invoiced_quantity" numeric(24, 6) DEFAULT '0' NOT NULL,
	"closed_quantity" numeric(24, 6) DEFAULT '0' NOT NULL,
	CONSTRAINT "purchase_order_line_quantity_positive" CHECK ("purchase_order_line"."quantity" > 0),
	CONSTRAINT "purchase_order_line_price_not_negative" CHECK ("purchase_order_line"."unit_price" >= 0),
	CONSTRAINT "purchase_order_line_received_not_negative" CHECK ("purchase_order_line"."received_quantity" >= 0),
	CONSTRAINT "purchase_order_line_stock_needs_warehouse" CHECK ("purchase_order_line"."line_type" <> 'inventory_item' or "purchase_order_line"."warehouse_code" is not null),
	CONSTRAINT "purchase_order_line_stock_needs_item" CHECK ("purchase_order_line"."line_type" <> 'inventory_item' or "purchase_order_line"."item_code" is not null)
);
--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_supplier_id_business_partner_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_submitted_by_app_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_cancelled_by_app_user_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD CONSTRAINT "purchase_order_line_purchase_order_id_purchase_order_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD CONSTRAINT "purchase_order_line_item_code_item_code_fk" FOREIGN KEY ("item_code") REFERENCES "public"."item"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD CONSTRAINT "purchase_order_line_uom_code_unit_of_measure_code_fk" FOREIGN KEY ("uom_code") REFERENCES "public"."unit_of_measure"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD CONSTRAINT "purchase_order_line_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD CONSTRAINT "purchase_order_line_warehouse_code_warehouse_code_fk" FOREIGN KEY ("warehouse_code") REFERENCES "public"."warehouse"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_line" ADD CONSTRAINT "purchase_order_line_cost_centre_code_cost_centre_code_fk" FOREIGN KEY ("cost_centre_code") REFERENCES "public"."cost_centre"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_no_uniq" ON "purchase_order" USING btree ("order_no");--> statement-breakpoint
CREATE INDEX "purchase_order_supplier_idx" ON "purchase_order" USING btree ("supplier_id","status");--> statement-breakpoint
CREATE INDEX "purchase_order_status_idx" ON "purchase_order" USING btree ("status","branch_code");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_order_line_no_uniq" ON "purchase_order_line" USING btree ("purchase_order_id","line_no");--> statement-breakpoint
CREATE INDEX "purchase_order_line_item_idx" ON "purchase_order_line" USING btree ("item_code");--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE — Phase 05.1, section 8.3.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Section 8.3 — the supplier must be an active Business Partner holding the
-- Supplier role.
--
-- The service checks it and says so readably. This is the layer that holds when
-- the order arrives from an import or a script: a purchase order against a
-- customer, or against a supplier who was blocked last week, is not a data-entry
-- mistake to be corrected later — it is a commitment to pay someone the company
-- has decided not to buy from.
-- ---------------------------------------------------------------------------
CREATE FUNCTION purchase_order_supplier_is_usable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_partner business_partner%ROWTYPE;
BEGIN
  SELECT * INTO v_partner FROM business_partner WHERE id = NEW.supplier_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No business partner with that id.' USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT v_partner.is_supplier THEN
    RAISE EXCEPTION
      'Business partner % is not a supplier, so nothing can be purchased from them (blueprint 6). Give them the supplier role, or choose another partner.',
      v_partner.code USING ERRCODE = 'restrict_violation';
  END IF;

  IF NOT v_partner.active OR v_partner.status <> 'active' THEN
    RAISE EXCEPTION
      'Supplier % is %, so a purchase order cannot be raised against them (blueprint 6). Only an active supplier may be ordered from.',
      v_partner.code,
      CASE WHEN NOT v_partner.active THEN 'deactivated' ELSE v_partner.status::text END
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER purchase_order_supplier_is_usable
  BEFORE INSERT OR UPDATE OF supplier_id ON purchase_order
  FOR EACH ROW EXECUTE FUNCTION purchase_order_supplier_is_usable();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- An approved order is a commitment, and its commercial terms are fixed.
--
-- Appendix B gives an approved PO the effect "commitment only". What was
-- approved is what the supplier will be held to and what the receipt will be
-- matched against, so quantity, price and item cannot move afterwards. The
-- quantities that *do* move — received, invoiced, closed — are the running
-- totals receipts and invoices maintain.
-- ---------------------------------------------------------------------------
CREATE FUNCTION purchase_order_line_terms_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status document_status;
  v_no     text;
BEGIN
  SELECT status, order_no INTO v_status, v_no
    FROM purchase_order WHERE id = coalesce(NEW.purchase_order_id, OLD.purchase_order_id);

  IF v_status = 'draft' THEN
    RETURN coalesce(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Purchase order % has been submitted; its lines cannot be removed (blueprint 8.3). Cancel the order, or close the open balance.',
      v_no USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.quantity     IS DISTINCT FROM OLD.quantity
  OR NEW.unit_price   IS DISTINCT FROM OLD.unit_price
  OR NEW.item_code    IS DISTINCT FROM OLD.item_code
  OR NEW.line_type    IS DISTINCT FROM OLD.line_type
  OR NEW.uom_code     IS DISTINCT FROM OLD.uom_code THEN
    RAISE EXCEPTION
      'Purchase order % has been submitted, so what was ordered cannot be changed (blueprint 8.3). The receipt is matched against it. Cancel the line and raise a new order.',
      v_no USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER purchase_order_line_terms_fixed
  BEFORE UPDATE OR DELETE ON purchase_order_line
  FOR EACH ROW EXECUTE FUNCTION purchase_order_line_terms_fixed();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Appendix B — an approved purchase order has NO accounting effect.
--
-- Stated as a table property: there is no journal_entry_id column to fill in.
-- Nothing to enforce and nothing to forget, which is the strongest form the
-- rule can take.
-- ---------------------------------------------------------------------------

-- Numbering, document type and permissions.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('PURCHASE_ORDER', 'PO', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('purchase_order', 'Purchase Order', 'purchasing',
   'Commits the company to buy from one supplier. Commitment only; no accounting entry (Appendix B).');--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('purchase_order', 'draft',              'submitted'),
  ('purchase_order', 'submitted',          'approved'),
  ('purchase_order', 'submitted',          'rejected'),
  ('purchase_order', 'submitted',          'draft'),
  ('purchase_order', 'rejected',           'draft'),
  ('purchase_order', 'approved',           'partially_executed'),
  ('purchase_order', 'approved',           'executed'),
  ('purchase_order', 'partially_executed', 'executed'),
  ('purchase_order', 'partially_executed', 'closed'),
  ('purchase_order', 'executed',           'closed'),
  ('purchase_order', 'draft',              'cancelled'),
  ('purchase_order', 'approved',           'cancelled');--> statement-breakpoint

-- Section 8.6 — the Purchasing employee raises the order; approval is a
-- separate act, because an approved order is a commitment to spend money.
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'purchase_order', 'view'),
  ('accounting_officer', 'purchase_order', 'create'),
  ('accounting_officer', 'purchase_order', 'edit_draft'),
  ('accounting_officer', 'purchase_order', 'submit'),
  ('accounting_officer', 'purchase_order', 'import'),
  ('accounting_manager', 'purchase_order', 'view'),
  ('accounting_manager', 'purchase_order', 'create'),
  ('accounting_manager', 'purchase_order', 'edit_draft'),
  ('accounting_manager', 'purchase_order', 'submit'),
  ('accounting_manager', 'purchase_order', 'approve'),
  ('accounting_manager', 'purchase_order', 'reverse_cancel'),
  ('accounting_manager', 'purchase_order', 'import'),
  ('accounting_manager', 'purchase_order', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON purchase_order, purchase_order_line FROM erp_app;

  -- No DELETE: section 1.1 keeps saved documents. A draft line is removed while
  -- the order is still a draft, which the trigger above allows.
  GRANT SELECT, INSERT, UPDATE ON purchase_order      TO erp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON purchase_order_line TO erp_app;
END;
$$;--> statement-breakpoint

ALTER TABLE purchase_order ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE purchase_order FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY purchase_order_branch_scope ON purchase_order
  USING (app_is_super_user() OR branch_code = app_current_branch())
  WITH CHECK (app_is_super_user() OR branch_code = app_current_branch());
