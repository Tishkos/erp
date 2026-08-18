CREATE TABLE "goods_return" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"ap_invoice_id" uuid,
	"goods_receipt_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"return_date" date NOT NULL,
	"reason" text NOT NULL,
	"supplier_reference" text,
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
	CONSTRAINT "goods_return_reason_not_blank" CHECK (coalesce(btrim("goods_return"."reason"), '') <> ''),
	CONSTRAINT "goods_return_reversal_has_reason" CHECK (("goods_return"."reversed_by" is null and "goods_return"."reversed_at" is null)
          or ("goods_return"."reversed_by" is not null and "goods_return"."reversed_at" is not null
              and coalesce(btrim("goods_return"."reversal_reason"), '') <> ''))
);
--> statement-breakpoint
CREATE TABLE "goods_return_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goods_return_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"goods_receipt_line_id" uuid NOT NULL,
	"ap_invoice_line_id" uuid,
	"item_code" text NOT NULL,
	"quantity" numeric(24, 6) NOT NULL,
	"uom_code" text NOT NULL,
	"warehouse_code" text NOT NULL,
	"cost_layer_id" uuid,
	"cost_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"movement_id" uuid,
	CONSTRAINT "goods_return_line_quantity_positive" CHECK ("goods_return_line"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "supplier_credit_memo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memo_no" text NOT NULL,
	"supplier_memo_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"goods_return_id" uuid NOT NULL,
	"ap_invoice_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"memo_date" date NOT NULL,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"allocated_amount_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"note" text,
	"journal_entry_id" uuid,
	"created_by" uuid NOT NULL,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_credit_memo_amount_positive" CHECK ("supplier_credit_memo"."amount_iqd" > 0),
	CONSTRAINT "supplier_credit_memo_not_over_allocated" CHECK ("supplier_credit_memo"."allocated_amount_iqd" >= 0 and "supplier_credit_memo"."allocated_amount_iqd" <= "supplier_credit_memo"."amount_iqd")
);
--> statement-breakpoint
ALTER TABLE "goods_return" ADD CONSTRAINT "goods_return_ap_invoice_id_ap_invoice_id_fk" FOREIGN KEY ("ap_invoice_id") REFERENCES "public"."ap_invoice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_return" ADD CONSTRAINT "goods_return_goods_receipt_id_goods_receipt_id_fk" FOREIGN KEY ("goods_receipt_id") REFERENCES "public"."goods_receipt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_return" ADD CONSTRAINT "goods_return_supplier_id_business_partner_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_return" ADD CONSTRAINT "goods_return_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_return" ADD CONSTRAINT "goods_return_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_return" ADD CONSTRAINT "goods_return_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_return" ADD CONSTRAINT "goods_return_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_return" ADD CONSTRAINT "goods_return_posted_by_app_user_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_return" ADD CONSTRAINT "goods_return_reversed_by_app_user_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_return_line" ADD CONSTRAINT "goods_return_line_goods_return_id_goods_return_id_fk" FOREIGN KEY ("goods_return_id") REFERENCES "public"."goods_return"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_return_line" ADD CONSTRAINT "goods_return_line_goods_receipt_line_id_goods_receipt_line_id_fk" FOREIGN KEY ("goods_receipt_line_id") REFERENCES "public"."goods_receipt_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_return_line" ADD CONSTRAINT "goods_return_line_ap_invoice_line_id_ap_invoice_line_id_fk" FOREIGN KEY ("ap_invoice_line_id") REFERENCES "public"."ap_invoice_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_return_line" ADD CONSTRAINT "goods_return_line_item_code_item_code_fk" FOREIGN KEY ("item_code") REFERENCES "public"."item"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_return_line" ADD CONSTRAINT "goods_return_line_uom_code_unit_of_measure_code_fk" FOREIGN KEY ("uom_code") REFERENCES "public"."unit_of_measure"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_return_line" ADD CONSTRAINT "goods_return_line_warehouse_code_warehouse_code_fk" FOREIGN KEY ("warehouse_code") REFERENCES "public"."warehouse"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_return_line" ADD CONSTRAINT "goods_return_line_cost_layer_id_cost_layer_id_fk" FOREIGN KEY ("cost_layer_id") REFERENCES "public"."cost_layer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_return_line" ADD CONSTRAINT "goods_return_line_movement_id_inventory_movement_id_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."inventory_movement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_memo" ADD CONSTRAINT "supplier_credit_memo_goods_return_id_goods_return_id_fk" FOREIGN KEY ("goods_return_id") REFERENCES "public"."goods_return"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_memo" ADD CONSTRAINT "supplier_credit_memo_ap_invoice_id_ap_invoice_id_fk" FOREIGN KEY ("ap_invoice_id") REFERENCES "public"."ap_invoice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_memo" ADD CONSTRAINT "supplier_credit_memo_supplier_id_business_partner_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_memo" ADD CONSTRAINT "supplier_credit_memo_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_memo" ADD CONSTRAINT "supplier_credit_memo_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_memo" ADD CONSTRAINT "supplier_credit_memo_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_credit_memo" ADD CONSTRAINT "supplier_credit_memo_posted_by_app_user_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goods_return_no_uniq" ON "goods_return" USING btree ("return_no");--> statement-breakpoint
CREATE INDEX "goods_return_supplier_idx" ON "goods_return" USING btree ("supplier_id","status");--> statement-breakpoint
CREATE INDEX "goods_return_receipt_idx" ON "goods_return" USING btree ("goods_receipt_id");--> statement-breakpoint
CREATE INDEX "goods_return_invoice_idx" ON "goods_return" USING btree ("ap_invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goods_return_line_no_uniq" ON "goods_return_line" USING btree ("goods_return_id","line_no");--> statement-breakpoint
CREATE INDEX "goods_return_line_receipt_line_idx" ON "goods_return_line" USING btree ("goods_receipt_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_credit_memo_no_uniq" ON "supplier_credit_memo" USING btree ("memo_no");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_credit_memo_supplier_number_uniq" ON "supplier_credit_memo" USING btree ("supplier_id","supplier_memo_no");--> statement-breakpoint
CREATE INDEX "supplier_credit_memo_return_idx" ON "supplier_credit_memo" USING btree ("goods_return_id");--> statement-breakpoint
CREATE INDEX "supplier_credit_memo_invoice_idx" ON "supplier_credit_memo" USING btree ("ap_invoice_id");
-- ---------------------------------------------------------------------------
-- Section 8.7 - a return line answers to a line of the return's own delivery.
--
-- Two independent foreign keys cannot say this between them: without the check,
-- a return against delivery A could carry a line from delivery B, and the
-- available-quantity arithmetic would be measured against the wrong receipt.
-- ---------------------------------------------------------------------------
CREATE FUNCTION goods_return_line_belongs_to_receipt() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_receipt_id  uuid;
  v_line_receipt uuid;
  v_return_no   text;
BEGIN
  SELECT goods_receipt_id, return_no INTO v_receipt_id, v_return_no
    FROM goods_return WHERE id = NEW.goods_return_id;

  SELECT goods_receipt_id INTO v_line_receipt
    FROM goods_receipt_line WHERE id = NEW.goods_receipt_line_id;

  IF v_line_receipt IS DISTINCT FROM v_receipt_id THEN
    RAISE EXCEPTION
      'Return % is against one delivery; line % belongs to a different one (blueprint 8.7). Return each delivery on its own document.',
      coalesce(v_return_no, '(new)'), NEW.line_no
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER goods_return_line_belongs_to_receipt
  BEFORE INSERT OR UPDATE ON goods_return_line
  FOR EACH ROW EXECUTE FUNCTION goods_return_line_belongs_to_receipt();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Appendix C - "quantity cannot exceed available return quantity".
--
-- Held in the database as well as in the service, because the arithmetic spans
-- rows the service reads separately: what the delivery brought in, less what
-- has already shipped back on it. Two returns raised at the same moment would
-- each read the same "already returned" figure and both pass.
--
-- Only shipped returns count. A draft is somebody thinking about it, and two
-- drafts for the same goods must not between them reserve more than exists.
-- ---------------------------------------------------------------------------
CREATE FUNCTION goods_return_line_within_available() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_received  numeric(24,6);
  v_returned  numeric(24,6);
  v_item      text;
  v_status    document_status;
BEGIN
  SELECT status INTO v_status FROM goods_return WHERE id = NEW.goods_return_id;

  -- Judged when the return ships, not when it is typed: a draft reserves
  -- nothing, and the check that matters is the one at the moment stock moves.
  IF v_status IS DISTINCT FROM 'posted' THEN
    RETURN NEW;
  END IF;

  SELECT quantity, item_code INTO v_received, v_item
    FROM goods_receipt_line WHERE id = NEW.goods_receipt_line_id FOR UPDATE;

  SELECT coalesce(sum(l.quantity), 0) INTO v_returned
    FROM goods_return_line l
    JOIN goods_return r ON r.id = l.goods_return_id
   WHERE l.goods_receipt_line_id = NEW.goods_receipt_line_id
     AND l.id <> NEW.id
     AND r.status IN ('posted', 'closed');

  IF v_returned + NEW.quantity > v_received THEN
    RAISE EXCEPTION
      'Returning % of % would exceed what that delivery brought in (% received, % already returned) - blueprint 8.7.',
      NEW.quantity, v_item, v_received, v_returned
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER goods_return_line_within_available
  BEFORE INSERT OR UPDATE ON goods_return_line
  FOR EACH ROW EXECUTE FUNCTION goods_return_line_within_available();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A shipped return is history. The stock has left and the ledger says so.
-- ---------------------------------------------------------------------------
CREATE FUNCTION goods_return_posted_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status NOT IN ('posted', 'closed') THEN
    RETURN NEW;
  END IF;

  IF NEW.goods_receipt_id IS DISTINCT FROM OLD.goods_receipt_id
  OR NEW.ap_invoice_id    IS DISTINCT FROM OLD.ap_invoice_id
  OR NEW.supplier_id      IS DISTINCT FROM OLD.supplier_id
  OR NEW.return_date      IS DISTINCT FROM OLD.return_date
  OR NEW.branch_code      IS DISTINCT FROM OLD.branch_code
  OR NEW.return_no        IS DISTINCT FROM OLD.return_no THEN
    RAISE EXCEPTION
      'Goods return % has shipped and posted (blueprint 3.2). Reverse it; it is not edited.',
      OLD.return_no USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER goods_return_posted_is_final
  BEFORE UPDATE ON goods_return
  FOR EACH ROW EXECUTE FUNCTION goods_return_posted_is_final();--> statement-breakpoint

-- Numbering, document types, statuses and permissions.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('GOODS_RETURN', 'GRT', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true),
       ('SUPPLIER_CREDIT_MEMO', 'SCM', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('goods_return', 'Goods Return', 'purchasing',
   'Goods going back to the supplier, against the delivery they arrived on (blueprint 8.7). Posts Dr Return Clearing / Cr Inventory. No replacement: a replacement requires a new Purchase Order.'),
  ('supplier_credit_memo', 'Supplier Credit Memo', 'purchasing',
   'The supplier agreeing to credit a return (blueprint 8.2). Links to both the Goods Return and the original A/P Invoice. Posts Dr Supplier A/P / Cr Return Clearing.');--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('goods_return', 'draft',     'submitted'),
  ('goods_return', 'draft',     'approved'),
  ('goods_return', 'submitted', 'approved'),
  ('goods_return', 'submitted', 'rejected'),
  ('goods_return', 'submitted', 'draft'),
  ('goods_return', 'rejected',  'draft'),
  ('goods_return', 'draft',     'cancelled'),
  ('goods_return', 'approved',  'posted'),
  ('goods_return', 'approved',  'cancelled'),
  ('goods_return', 'posted',    'closed'),
  ('goods_return', 'posted',    'reversed'),
  ('supplier_credit_memo', 'draft',    'approved'),
  ('supplier_credit_memo', 'approved', 'posted'),
  ('supplier_credit_memo', 'posted',   'settled'),
  ('supplier_credit_memo', 'posted',   'reversed');--> statement-breakpoint

INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('goods_return', 'goods_receipt_id',
   'Decides the available return quantity and the cost layer the goods came in on (blueprint 8.7).'),
  ('goods_return', 'ap_invoice_id',
   'Decides which debt the credit memo will reduce.'),
  ('goods_return', 'return_date',
   'Decides the period the inventory credit lands in.'),
  ('supplier_credit_memo', 'goods_return_id',
   'One half of the link the 05.7 gate requires: what physically went back.'),
  ('supplier_credit_memo', 'ap_invoice_id',
   'The other half: which invoice is being credited.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Section 8.6 - Goods Return is owned by Warehouse, the Supplier Credit Memo by
-- Finance. Both seeded roles can raise; the manager approves and posts.
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'goods_return', 'view'),
  ('accounting_officer', 'goods_return', 'create'),
  ('accounting_officer', 'goods_return', 'edit_draft'),
  ('accounting_officer', 'goods_return', 'submit'),
  ('accounting_officer', 'goods_return', 'print'),
  ('accounting_manager', 'goods_return', 'view'),
  ('accounting_manager', 'goods_return', 'create'),
  ('accounting_manager', 'goods_return', 'edit_draft'),
  ('accounting_manager', 'goods_return', 'submit'),
  ('accounting_manager', 'goods_return', 'approve'),
  ('accounting_manager', 'goods_return', 'post'),
  ('accounting_manager', 'goods_return', 'reverse_cancel'),
  ('accounting_manager', 'goods_return', 'print'),
  ('accounting_manager', 'goods_return', 'export'),
  ('accounting_officer', 'supplier_credit_memo', 'view'),
  ('accounting_officer', 'supplier_credit_memo', 'create'),
  ('accounting_manager', 'supplier_credit_memo', 'view'),
  ('accounting_manager', 'supplier_credit_memo', 'create'),
  ('accounting_manager', 'supplier_credit_memo', 'approve'),
  ('accounting_manager', 'supplier_credit_memo', 'post'),
  ('accounting_manager', 'supplier_credit_memo', 'reverse_cancel'),
  ('accounting_manager', 'supplier_credit_memo', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist - grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON goods_return, goods_return_line, supplier_credit_memo FROM erp_app;

  GRANT SELECT, INSERT, UPDATE ON goods_return TO erp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON goods_return_line TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON supplier_credit_memo TO erp_app;
END;
$$;--> statement-breakpoint

ALTER TABLE goods_return ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE goods_return FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY goods_return_branch_scope ON goods_return
  USING (app_is_super_user() OR branch_code = app_current_branch())
  WITH CHECK (app_is_super_user() OR branch_code = app_current_branch());--> statement-breakpoint

ALTER TABLE supplier_credit_memo ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE supplier_credit_memo FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY supplier_credit_memo_branch_scope ON supplier_credit_memo
  USING (app_is_super_user() OR branch_code = app_current_branch())
  WITH CHECK (app_is_super_user() OR branch_code = app_current_branch());
