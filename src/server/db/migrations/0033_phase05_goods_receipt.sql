CREATE TABLE "purchase_receipt_tolerance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_code" text,
	"over_receipt_percent" numeric(9, 4) DEFAULT '0' NOT NULL,
	"note" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_receipt_tolerance_range" CHECK ("purchase_receipt_tolerance"."over_receipt_percent" >= 0 and "purchase_receipt_tolerance"."over_receipt_percent" <= 100)
);--> statement-breakpoint

CREATE TABLE "goods_receipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"receipt_date" date NOT NULL,
	"supplier_delivery_note" text,
	"note" text,
	"tolerance_override_by" uuid,
	"tolerance_override_at" timestamp with time zone,
	"tolerance_override_reason" text,
	"created_by" uuid NOT NULL,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"reversed_by" uuid,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goods_receipt_override_complete" CHECK (("goods_receipt"."tolerance_override_by" is null and "goods_receipt"."tolerance_override_at" is null
           and "goods_receipt"."tolerance_override_reason" is null)
          or ("goods_receipt"."tolerance_override_by" is not null and "goods_receipt"."tolerance_override_at" is not null
              and coalesce(btrim("goods_receipt"."tolerance_override_reason"), '') <> '')),
	CONSTRAINT "goods_receipt_reversal_has_reason" CHECK (("goods_receipt"."reversed_by" is null and "goods_receipt"."reversed_at" is null)
          or ("goods_receipt"."reversed_by" is not null and "goods_receipt"."reversed_at" is not null
              and coalesce(btrim("goods_receipt"."reversal_reason"), '') <> ''))
);--> statement-breakpoint

CREATE TABLE "goods_receipt_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goods_receipt_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"purchase_order_line_id" uuid NOT NULL,
	"item_code" text NOT NULL,
	"quantity" numeric(24, 6) NOT NULL,
	"uom_code" text NOT NULL,
	"warehouse_code" text NOT NULL,
	"warehouse_variance" boolean DEFAULT false NOT NULL,
	"serial_number" text,
	"batch_number" text,
	"expiry_date" date,
	"manufactured_on" date,
	"movement_id" uuid,
	CONSTRAINT "goods_receipt_line_quantity_positive" CHECK ("goods_receipt_line"."quantity" > 0)
);--> statement-breakpoint

ALTER TABLE "purchase_receipt_tolerance" ADD CONSTRAINT "purchase_receipt_tolerance_item_code_item_code_fk" FOREIGN KEY ("item_code") REFERENCES "public"."item"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_receipt_tolerance" ADD CONSTRAINT "purchase_receipt_tolerance_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "goods_receipt" ADD CONSTRAINT "goods_receipt_purchase_order_id_purchase_order_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt" ADD CONSTRAINT "goods_receipt_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt" ADD CONSTRAINT "goods_receipt_tolerance_override_by_app_user_id_fk" FOREIGN KEY ("tolerance_override_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt" ADD CONSTRAINT "goods_receipt_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt" ADD CONSTRAINT "goods_receipt_posted_by_app_user_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt" ADD CONSTRAINT "goods_receipt_reversed_by_app_user_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "goods_receipt_line" ADD CONSTRAINT "goods_receipt_line_goods_receipt_id_goods_receipt_id_fk" FOREIGN KEY ("goods_receipt_id") REFERENCES "public"."goods_receipt"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_line" ADD CONSTRAINT "goods_receipt_line_purchase_order_line_id_purchase_order_line_id_fk" FOREIGN KEY ("purchase_order_line_id") REFERENCES "public"."purchase_order_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_line" ADD CONSTRAINT "goods_receipt_line_item_code_item_code_fk" FOREIGN KEY ("item_code") REFERENCES "public"."item"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_line" ADD CONSTRAINT "goods_receipt_line_uom_code_unit_of_measure_code_fk" FOREIGN KEY ("uom_code") REFERENCES "public"."unit_of_measure"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_line" ADD CONSTRAINT "goods_receipt_line_warehouse_code_warehouse_code_fk" FOREIGN KEY ("warehouse_code") REFERENCES "public"."warehouse"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_line" ADD CONSTRAINT "goods_receipt_line_movement_id_inventory_movement_id_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."inventory_movement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "purchase_receipt_tolerance_item_uniq" ON "purchase_receipt_tolerance" USING btree ("item_code") WHERE item_code is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_receipt_tolerance_default_uniq" ON "purchase_receipt_tolerance" USING btree ((true)) WHERE item_code is null;--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipt_no_uniq" ON "goods_receipt" USING btree ("receipt_no");--> statement-breakpoint
CREATE INDEX "goods_receipt_order_idx" ON "goods_receipt" USING btree ("purchase_order_id","status");--> statement-breakpoint
CREATE INDEX "goods_receipt_date_idx" ON "goods_receipt" USING btree ("receipt_date","branch_code");--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipt_line_no_uniq" ON "goods_receipt_line" USING btree ("goods_receipt_id","line_no");--> statement-breakpoint
CREATE INDEX "goods_receipt_line_po_line_idx" ON "goods_receipt_line" USING btree ("purchase_order_line_id");--> statement-breakpoint
CREATE INDEX "goods_receipt_line_item_idx" ON "goods_receipt_line" USING btree ("item_code","warehouse_code");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The company-wide default tolerance: zero.
--
-- Section 8.4 calls the tolerance configurable, so Purchasing sets it. Until
-- they do, every over-receipt needs a manager's decision — which is the safe
-- direction for the default to be wrong in. A generous default would let
-- over-receipts through silently and nobody would discover it until the
-- three-way match failed at invoice.
-- ---------------------------------------------------------------------------
INSERT INTO purchase_receipt_tolerance (item_code, over_receipt_percent, note)
VALUES (NULL, 0,
  'Company default. Section 8.4 — set by Purchasing; zero until they do, so every over-receipt is a decision.');--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A receipt line must belong to a line of the receipt's own order.
--
-- The two foreign keys are independent: without this, a receipt against order A
-- could carry a line belonging to order B, and the three-way match would
-- reconcile against the wrong commitment. Checked in the database because it is
-- a relationship between two columns, which no single foreign key can express.
-- ---------------------------------------------------------------------------
CREATE FUNCTION goods_receipt_line_belongs_to_order() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_order_id  uuid;
  v_line_order uuid;
  v_receipt_no text;
BEGIN
  SELECT purchase_order_id, receipt_no INTO v_order_id, v_receipt_no
    FROM goods_receipt WHERE id = NEW.goods_receipt_id;

  SELECT purchase_order_id INTO v_line_order
    FROM purchase_order_line WHERE id = NEW.purchase_order_line_id;

  IF v_line_order IS DISTINCT FROM v_order_id THEN
    RAISE EXCEPTION
      'Receipt % is against one purchase order; line % belongs to a different one (blueprint 8.4). Receive each order separately.',
      coalesce(v_receipt_no, '(new)'), NEW.line_no
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER goods_receipt_line_belongs_to_order
  BEFORE INSERT OR UPDATE ON goods_receipt_line
  FOR EACH ROW EXECUTE FUNCTION goods_receipt_line_belongs_to_order();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Goods are received against an approved order, and only an approved one.
--
-- Section 8.2's flow is PO -> receipt. Receiving against a draft order means the
-- goods arrived before anyone agreed to buy them; receiving against a cancelled
-- one means they arrived after the company said no. Both happen in real
-- warehouses, and both are business events that need a decision rather than a
-- quiet insert.
-- ---------------------------------------------------------------------------
CREATE FUNCTION goods_receipt_order_is_receivable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status document_status;
  v_no     text;
BEGIN
  SELECT status, order_no INTO v_status, v_no
    FROM purchase_order WHERE id = NEW.purchase_order_id;

  IF v_status NOT IN ('approved', 'partially_executed') THEN
    RAISE EXCEPTION
      'Purchase order % is %, so nothing can be received against it (blueprint 8.2). An approved order is what authorises the receipt.',
      v_no, v_status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER goods_receipt_order_is_receivable
  BEFORE INSERT ON goods_receipt
  FOR EACH ROW EXECUTE FUNCTION goods_receipt_order_is_receivable();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A posted receipt is history.
--
-- Section 1.1 and section 3.2: a receipt that has moved stock and posted to the
-- ledger is corrected by reversal, never by editing. The reversal fields are the
-- exception — they are how the correction is recorded.
-- ---------------------------------------------------------------------------
CREATE FUNCTION goods_receipt_posted_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'executed' THEN
    RETURN NEW;
  END IF;

  IF NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id
  OR NEW.receipt_date      IS DISTINCT FROM OLD.receipt_date
  OR NEW.branch_code       IS DISTINCT FROM OLD.branch_code
  OR NEW.receipt_no        IS DISTINCT FROM OLD.receipt_no THEN
    RAISE EXCEPTION
      'Goods receipt % has posted; stock moved and the ledger recorded it (blueprint 3.2). Reverse it and receive again.',
      OLD.receipt_no USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER goods_receipt_posted_is_final
  BEFORE UPDATE ON goods_receipt
  FOR EACH ROW EXECUTE FUNCTION goods_receipt_posted_is_final();--> statement-breakpoint

-- A posted receipt line is the record of what physically arrived. It never
-- changes; quantities are corrected by reversing the receipt.
CREATE FUNCTION goods_receipt_line_posted_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status document_status;
  v_no     text;
BEGIN
  SELECT status, receipt_no INTO v_status, v_no
    FROM goods_receipt WHERE id = coalesce(NEW.goods_receipt_id, OLD.goods_receipt_id);

  IF v_status <> 'executed' THEN
    RETURN coalesce(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Goods receipt % has posted; its lines are what arrived (blueprint 1.1). Reverse the receipt.',
      v_no USING ERRCODE = 'restrict_violation';
  END IF;

  -- movement_id is written as the receipt posts, in the same statement that
  -- moves it to 'executed'. Everything else is fixed from that moment.
  IF NEW.quantity      IS DISTINCT FROM OLD.quantity
  OR NEW.item_code     IS DISTINCT FROM OLD.item_code
  OR NEW.warehouse_code IS DISTINCT FROM OLD.warehouse_code
  OR NEW.purchase_order_line_id IS DISTINCT FROM OLD.purchase_order_line_id THEN
    RAISE EXCEPTION
      'Goods receipt % has posted; what arrived cannot be edited (blueprint 3.2). Reverse it and receive again.',
      v_no USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER goods_receipt_line_posted_is_final
  BEFORE UPDATE OR DELETE ON goods_receipt_line
  FOR EACH ROW EXECUTE FUNCTION goods_receipt_line_posted_is_final();--> statement-breakpoint

-- Numbering, document type, statuses and permissions.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('GOODS_RECEIPT', 'GRN', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('goods_receipt', 'Goods Receipt', 'purchasing',
   'Records goods physically received against a purchase order. Posts Dr Inventory / Cr GRNI and creates the FIFO layer (Appendix C).');--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('goods_receipt', 'draft',     'submitted'),
  ('goods_receipt', 'submitted', 'executed'),
  ('goods_receipt', 'submitted', 'rejected'),
  ('goods_receipt', 'submitted', 'draft'),
  ('goods_receipt', 'rejected',  'draft'),
  ('goods_receipt', 'draft',     'cancelled'),
  ('goods_receipt', 'executed',  'reversed');--> statement-breakpoint

-- Section 24 — fields frozen once the document leaves draft.
INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('goods_receipt', 'purchase_order_id',
   'Decides which commitment the receipt discharges and what the three-way match compares.'),
  ('goods_receipt', 'receipt_date',
   'Decides the accounting period the inventory and GRNI land in.'),
  ('goods_receipt', 'branch_code',
   'A receipt posts to one branch (section 14.3).')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Section 8.6 — Goods Receipt is owned by Warehouse. The tolerance override is
-- a manager's decision, held separately from the act of receiving.
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'goods_receipt', 'view'),
  ('accounting_officer', 'goods_receipt', 'create'),
  ('accounting_officer', 'goods_receipt', 'edit_draft'),
  ('accounting_officer', 'goods_receipt', 'submit'),
  ('accounting_officer', 'goods_receipt', 'print'),
  ('accounting_manager', 'goods_receipt', 'view'),
  ('accounting_manager', 'goods_receipt', 'create'),
  ('accounting_manager', 'goods_receipt', 'edit_draft'),
  ('accounting_manager', 'goods_receipt', 'submit'),
  ('accounting_manager', 'goods_receipt', 'approve'),
  ('accounting_manager', 'goods_receipt', 'reverse_cancel'),
  ('accounting_manager', 'goods_receipt', 'configure'),
  ('accounting_manager', 'goods_receipt', 'print'),
  ('accounting_manager', 'goods_receipt', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON goods_receipt, goods_receipt_line, purchase_receipt_tolerance FROM erp_app;

  -- No DELETE on the receipt: section 1.1 keeps saved documents. Draft lines are
  -- removable while the receipt is a draft, which the trigger above allows.
  GRANT SELECT, INSERT, UPDATE ON goods_receipt TO erp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON goods_receipt_line TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON purchase_receipt_tolerance TO erp_app;
END;
$$;--> statement-breakpoint

ALTER TABLE goods_receipt ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE goods_receipt FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY goods_receipt_branch_scope ON goods_receipt
  USING (app_is_super_user() OR branch_code = app_current_branch())
  WITH CHECK (app_is_super_user() OR branch_code = app_current_branch());
