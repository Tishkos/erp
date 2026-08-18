CREATE TABLE "sales_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"customer_id" uuid NOT NULL,
	"price_list_code" text NOT NULL,
	"branch_code" text NOT NULL,
	"order_date" date NOT NULL,
	"requested_delivery_date" date,
	"currency" text DEFAULT 'IQD' NOT NULL,
	"payment_terms_code" text,
	"customer_reference" text,
	"note" text,
	"gross_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"discount_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"net_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"credit_override_by" uuid,
	"credit_override_at" timestamp with time zone,
	"credit_override_reason" text,
	"credit_override_amount_iqd" numeric(19, 4),
	"credit_override_expires_on" date,
	"created_by" uuid NOT NULL,
	"submitted_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_order_cancellation_has_reason" CHECK (("sales_order"."cancelled_by" is null and "sales_order"."cancelled_at" is null)
          or ("sales_order"."cancelled_by" is not null and "sales_order"."cancelled_at" is not null
              and coalesce(btrim("sales_order"."cancellation_reason"), '') <> '')),
	CONSTRAINT "sales_order_credit_override_complete" CHECK (("sales_order"."credit_override_by" is null and "sales_order"."credit_override_at" is null
           and "sales_order"."credit_override_reason" is null and "sales_order"."credit_override_amount_iqd" is null
           and "sales_order"."credit_override_expires_on" is null)
          or ("sales_order"."credit_override_by" is not null and "sales_order"."credit_override_at" is not null
              and coalesce(btrim("sales_order"."credit_override_reason"), '') <> ''
              and "sales_order"."credit_override_amount_iqd" is not null and "sales_order"."credit_override_amount_iqd" > 0
              and "sales_order"."credit_override_expires_on" is not null)),
	CONSTRAINT "sales_order_totals_consistent" CHECK ("sales_order"."net_iqd" = "sales_order"."gross_iqd" - "sales_order"."discount_iqd"
          and "sales_order"."discount_iqd" >= 0 and "sales_order"."gross_iqd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sales_order_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sales_order_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"item_code" text NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(24, 6) NOT NULL,
	"uom_code" text NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"price_list_item_id" uuid,
	"discount_percent" numeric(9, 4),
	"discount_amount_iqd" numeric(19, 4),
	"gross_iqd" numeric(19, 4) NOT NULL,
	"net_iqd" numeric(19, 4) NOT NULL,
	"branch_code" text NOT NULL,
	"warehouse_code" text NOT NULL,
	"delivery_location" text,
	"cost_centre_code" text,
	"reserved_quantity" numeric(24, 6) DEFAULT '0' NOT NULL,
	"delivered_quantity" numeric(24, 6) DEFAULT '0' NOT NULL,
	"invoiced_quantity" numeric(24, 6) DEFAULT '0' NOT NULL,
	"closed_quantity" numeric(24, 6) DEFAULT '0' NOT NULL,
	CONSTRAINT "sales_order_line_quantity_positive" CHECK ("sales_order_line"."quantity" > 0),
	CONSTRAINT "sales_order_line_price_not_negative" CHECK ("sales_order_line"."unit_price" >= 0),
	CONSTRAINT "sales_order_line_one_discount_form" CHECK ("sales_order_line"."discount_percent" is null or "sales_order_line"."discount_amount_iqd" is null),
	CONSTRAINT "sales_order_line_discount_range" CHECK (("sales_order_line"."discount_percent" is null or ("sales_order_line"."discount_percent" >= 0 and "sales_order_line"."discount_percent" <= 100))
          and ("sales_order_line"."discount_amount_iqd" is null
               or ("sales_order_line"."discount_amount_iqd" >= 0 and "sales_order_line"."discount_amount_iqd" <= "sales_order_line"."gross_iqd"))),
	CONSTRAINT "sales_order_line_net_consistent" CHECK ("sales_order_line"."net_iqd" <= "sales_order_line"."gross_iqd"),
	CONSTRAINT "sales_order_line_progress_ordered" CHECK ("sales_order_line"."delivered_quantity" >= 0 and "sales_order_line"."invoiced_quantity" >= 0
          and "sales_order_line"."closed_quantity" >= 0
          and "sales_order_line"."invoiced_quantity" <= "sales_order_line"."delivered_quantity"
          and "sales_order_line"."delivered_quantity" <= "sales_order_line"."quantity")
);
--> statement-breakpoint
ALTER TABLE "business_partner" ADD COLUMN "on_credit_hold" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "business_partner" ADD COLUMN "credit_hold_reason" text;--> statement-breakpoint
ALTER TABLE "business_partner" ADD COLUMN "credit_hold_by" uuid;--> statement-breakpoint
ALTER TABLE "business_partner" ADD COLUMN "credit_hold_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_customer_id_business_partner_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_price_list_code_price_list_code_fk" FOREIGN KEY ("price_list_code") REFERENCES "public"."price_list"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_credit_override_by_app_user_id_fk" FOREIGN KEY ("credit_override_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_submitted_by_app_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_cancelled_by_app_user_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_line" ADD CONSTRAINT "sales_order_line_sales_order_id_sales_order_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_line" ADD CONSTRAINT "sales_order_line_item_code_item_code_fk" FOREIGN KEY ("item_code") REFERENCES "public"."item"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_line" ADD CONSTRAINT "sales_order_line_uom_code_unit_of_measure_code_fk" FOREIGN KEY ("uom_code") REFERENCES "public"."unit_of_measure"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_line" ADD CONSTRAINT "sales_order_line_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_line" ADD CONSTRAINT "sales_order_line_warehouse_code_warehouse_code_fk" FOREIGN KEY ("warehouse_code") REFERENCES "public"."warehouse"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_line" ADD CONSTRAINT "sales_order_line_cost_centre_code_cost_centre_code_fk" FOREIGN KEY ("cost_centre_code") REFERENCES "public"."cost_centre"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_order_no_uniq" ON "sales_order" USING btree ("order_no");--> statement-breakpoint
CREATE INDEX "sales_order_customer_idx" ON "sales_order" USING btree ("customer_id","status");--> statement-breakpoint
CREATE INDEX "sales_order_status_idx" ON "sales_order" USING btree ("status","branch_code");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_order_line_no_uniq" ON "sales_order_line" USING btree ("sales_order_id","line_no");--> statement-breakpoint
CREATE INDEX "sales_order_line_item_idx" ON "sales_order_line" USING btree ("item_code","warehouse_code");--> statement-breakpoint
ALTER TABLE "business_partner" ADD CONSTRAINT "business_partner_credit_hold_by_app_user_id_fk" FOREIGN KEY ("credit_hold_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;
-- ---------------------------------------------------------------------------
-- Section 7.2 - the product-sale process carries product items only.
--
-- "Installation, transport and other services are not part of this workflow."
-- There is no line_type column to choose a service in; this refuses one that is
-- named anyway, by any path. A column with one legal value would only invite a
-- second.
-- ---------------------------------------------------------------------------
CREATE FUNCTION sales_order_line_is_a_product() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_is_stock boolean;
BEGIN
  SELECT is_stock INTO v_is_stock FROM item WHERE code = NEW.item_code;

  IF NOT coalesce(v_is_stock, false) THEN
    RAISE EXCEPTION
      '% is a service, and the product-sale process carries product items only (blueprint 7.2). Services are sold through their own route.',
      NEW.item_code
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER sales_order_line_is_a_product
  BEFORE INSERT OR UPDATE ON sales_order_line
  FOR EACH ROW EXECUTE FUNCTION sales_order_line_is_a_product();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 7.3 and 7.7 - the price comes from the customer's price list and the
-- control cannot be bypassed.
--
-- The service resolves the price and there is no field to submit one in, which
-- is the first line of defence. This is the second: whatever route wrote the
-- row, the unit price has to be the price the named price-list row carried. An
-- API that invented a price, an import that carried one, a hand-written UPDATE -
-- all end here.
--
-- Checked against the *recorded* price_list_item_id rather than re-resolved by
-- date, because section 7.4 locks the price list at approval: an order approved
-- last week must not fail this check because the list changed since.
-- ---------------------------------------------------------------------------
CREATE FUNCTION sales_order_line_price_from_list() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_price numeric(19,4);
  v_list  text;
BEGIN
  IF NEW.price_list_item_id IS NULL THEN
    RAISE EXCEPTION
      'Line % names no price-list row, so its price cannot be shown to have come from one (blueprint 7.3). Prices are retrieved from the customer''s Price List, never typed.',
      NEW.line_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT unit_price, price_list_code INTO v_price, v_list
    FROM price_list_item WHERE id = NEW.price_list_item_id;

  IF v_price IS DISTINCT FROM NEW.unit_price THEN
    RAISE EXCEPTION
      'Line % carries % but price list % says % (blueprint 7.3, 7.7). Unit prices cannot be edited in the Sales Order, and the control cannot be bypassed through the UI or API.',
      NEW.line_no, NEW.unit_price, v_list, v_price
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER sales_order_line_price_from_list
  BEFORE INSERT OR UPDATE ON sales_order_line
  FOR EACH ROW EXECUTE FUNCTION sales_order_line_price_from_list();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 7.4 - an approved order's commercial terms are fixed.
--
-- The reservation is made against what was approved, the delivery is matched to
-- it and the invoice is matched to the delivery. Quantity, price, item and
-- discount cannot move afterwards; the running totals - reserved, delivered,
-- invoiced, closed - are what the later documents maintain.
-- ---------------------------------------------------------------------------
CREATE FUNCTION sales_order_line_terms_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status document_status;
  v_no     text;
BEGIN
  SELECT status, order_no INTO v_status, v_no
    FROM sales_order WHERE id = coalesce(NEW.sales_order_id, OLD.sales_order_id);

  IF v_status = 'draft' THEN
    RETURN coalesce(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Sales order % has been submitted; its lines cannot be removed (blueprint 7.4). Cancel the order, or close the open balance.',
      v_no USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.quantity          IS DISTINCT FROM OLD.quantity
  OR NEW.unit_price        IS DISTINCT FROM OLD.unit_price
  OR NEW.item_code         IS DISTINCT FROM OLD.item_code
  OR NEW.uom_code          IS DISTINCT FROM OLD.uom_code
  OR NEW.discount_percent  IS DISTINCT FROM OLD.discount_percent
  OR NEW.discount_amount_iqd IS DISTINCT FROM OLD.discount_amount_iqd
  OR NEW.net_iqd           IS DISTINCT FROM OLD.net_iqd THEN
    RAISE EXCEPTION
      'Sales order % has been submitted, so what was sold cannot be changed (blueprint 7.4). The reservation and the delivery are matched against it.',
      v_no USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER sales_order_line_terms_fixed
  BEFORE UPDATE OR DELETE ON sales_order_line
  FOR EACH ROW EXECUTE FUNCTION sales_order_line_terms_fixed();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 16 acceptance criterion 3 - a credit hold takes effect immediately.
--
-- No order reaches 'approved' for a customer on hold, whatever their limit and
-- whatever override was recorded. Held in the database because "immediately"
-- means there is no window: a service check reads the flag and then approves,
-- and the hold could be applied in between.
-- ---------------------------------------------------------------------------
CREATE FUNCTION sales_order_respects_credit_hold() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_on_hold boolean;
  v_code    text;
BEGIN
  IF NEW.status <> 'approved' OR OLD.status = 'approved' THEN
    RETURN NEW;
  END IF;

  SELECT on_credit_hold, code INTO v_on_hold, v_code
    FROM business_partner WHERE id = NEW.customer_id FOR SHARE;

  IF v_on_hold THEN
    RAISE EXCEPTION
      '% is on credit hold, so order % cannot be approved on credit (blueprint 16). A credit-limit override does not lift a hold; only lifting the hold does.',
      v_code, NEW.order_no
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER sales_order_respects_credit_hold
  BEFORE UPDATE ON sales_order
  FOR EACH ROW EXECUTE FUNCTION sales_order_respects_credit_hold();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 16 - a credit hold is a decision, and a decision has a reason.
-- ---------------------------------------------------------------------------
ALTER TABLE business_partner
  ADD CONSTRAINT business_partner_credit_hold_has_reason
  CHECK (
    NOT on_credit_hold
    OR (coalesce(btrim(credit_hold_reason), '') <> ''
        AND credit_hold_by IS NOT NULL
        AND credit_hold_at IS NOT NULL)
  );--> statement-breakpoint

-- Appendix B - the Sales Order has no accounting effect. Stated as a table
-- property: there is no journal_entry_id column to fill in.

-- Numbering, document type, statuses and permissions.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('SALES_ORDER', 'SO', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('sales_order', 'Sales Order', 'sales',
   'Commits stock to a customer. Prices come from the customer''s price list and cannot be edited (blueprint 7.3). Effect: stock reservation only, no accounting entry (Appendix B).');--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('sales_order', 'draft',              'submitted'),
  ('sales_order', 'draft',              'approved'),
  ('sales_order', 'submitted',          'approved'),
  ('sales_order', 'submitted',          'rejected'),
  ('sales_order', 'submitted',          'draft'),
  ('sales_order', 'rejected',           'draft'),
  ('sales_order', 'draft',              'cancelled'),
  ('sales_order', 'submitted',          'cancelled'),
  ('sales_order', 'approved',           'cancelled'),
  ('sales_order', 'approved',           'partially_executed'),
  ('sales_order', 'approved',           'executed'),
  ('sales_order', 'partially_executed', 'executed'),
  ('sales_order', 'partially_executed', 'closed'),
  ('sales_order', 'executed',           'closed');--> statement-breakpoint

INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('sales_order', 'customer_id',
   'Decides whose credit is committed and whose price list applies.'),
  ('sales_order', 'price_list_code',
   'Blueprint 7.4 locks the price list at approval; changing it afterwards would reprice a quote the customer has accepted.'),
  ('sales_order', 'order_date',
   'Decides which price is effective (blueprint 7.3).'),
  ('sales_order', 'branch_code',
   'Decides the approval route and the scope the order is visible in.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Section 7.3 - "ordinary Sales users require Sales Manager approval; Sales
-- Manager orders finalise directly." Read off the grant: whoever holds 'approve'
-- on sales_order is the person a second approval would be asked of.
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'sales_order', 'view'),
  ('accounting_officer', 'sales_order', 'create'),
  ('accounting_officer', 'sales_order', 'edit_draft'),
  ('accounting_officer', 'sales_order', 'submit'),
  ('accounting_officer', 'sales_order', 'import'),
  ('accounting_officer', 'sales_order', 'print'),
  ('accounting_manager', 'sales_order', 'view'),
  ('accounting_manager', 'sales_order', 'create'),
  ('accounting_manager', 'sales_order', 'edit_draft'),
  ('accounting_manager', 'sales_order', 'submit'),
  ('accounting_manager', 'sales_order', 'approve'),
  ('accounting_manager', 'sales_order', 'reverse_cancel'),
  ('accounting_manager', 'sales_order', 'configure'),
  ('accounting_manager', 'sales_order', 'import'),
  ('accounting_manager', 'sales_order', 'print'),
  ('accounting_manager', 'sales_order', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist - grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON sales_order, sales_order_line FROM erp_app;

  -- No DELETE on the order: section 1.1 keeps saved documents. Draft lines are
  -- removable while the order is a draft, which the trigger above allows.
  GRANT SELECT, INSERT, UPDATE ON sales_order TO erp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON sales_order_line TO erp_app;
END;
$$;--> statement-breakpoint

ALTER TABLE sales_order ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE sales_order FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY sales_order_branch_scope ON sales_order
  USING (app_is_super_user() OR branch_code = app_current_branch())
  WITH CHECK (app_is_super_user() OR branch_code = app_current_branch());
