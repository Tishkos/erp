CREATE TABLE "service_receipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"department_code" text NOT NULL,
	"branch_code" text NOT NULL,
	"service_date" date NOT NULL,
	"supplier_reference" text,
	"note" text,
	"created_by" uuid NOT NULL,
	"submitted_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"reversed_by" uuid,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_receipt_approval_complete" CHECK (("service_receipt"."approved_by" is null and "service_receipt"."approved_at" is null)
          or ("service_receipt"."approved_by" is not null and "service_receipt"."approved_at" is not null)),
	CONSTRAINT "service_receipt_reversal_has_reason" CHECK (("service_receipt"."reversed_by" is null and "service_receipt"."reversed_at" is null)
          or ("service_receipt"."reversed_by" is not null and "service_receipt"."reversed_at" is not null
              and coalesce(btrim("service_receipt"."reversal_reason"), '') <> ''))
);
--> statement-breakpoint
CREATE TABLE "service_receipt_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_receipt_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"purchase_order_line_id" uuid NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(24, 6) NOT NULL,
	"uom_code" text NOT NULL,
	"cost_centre_code" text,
	CONSTRAINT "service_receipt_line_quantity_positive" CHECK ("service_receipt_line"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "service_receipt" ADD CONSTRAINT "service_receipt_purchase_order_id_purchase_order_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_receipt" ADD CONSTRAINT "service_receipt_department_code_department_code_fk" FOREIGN KEY ("department_code") REFERENCES "public"."department"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_receipt" ADD CONSTRAINT "service_receipt_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_receipt" ADD CONSTRAINT "service_receipt_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_receipt" ADD CONSTRAINT "service_receipt_submitted_by_app_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_receipt" ADD CONSTRAINT "service_receipt_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_receipt" ADD CONSTRAINT "service_receipt_reversed_by_app_user_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_receipt_line" ADD CONSTRAINT "service_receipt_line_service_receipt_id_service_receipt_id_fk" FOREIGN KEY ("service_receipt_id") REFERENCES "public"."service_receipt"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_receipt_line" ADD CONSTRAINT "service_receipt_line_purchase_order_line_id_purchase_order_line_id_fk" FOREIGN KEY ("purchase_order_line_id") REFERENCES "public"."purchase_order_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_receipt_line" ADD CONSTRAINT "service_receipt_line_uom_code_unit_of_measure_code_fk" FOREIGN KEY ("uom_code") REFERENCES "public"."unit_of_measure"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_receipt_line" ADD CONSTRAINT "service_receipt_line_cost_centre_code_cost_centre_code_fk" FOREIGN KEY ("cost_centre_code") REFERENCES "public"."cost_centre"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "service_receipt_no_uniq" ON "service_receipt" USING btree ("receipt_no");--> statement-breakpoint
CREATE INDEX "service_receipt_order_idx" ON "service_receipt" USING btree ("purchase_order_id","status");--> statement-breakpoint
CREATE INDEX "service_receipt_department_idx" ON "service_receipt" USING btree ("department_code","status");--> statement-breakpoint
CREATE UNIQUE INDEX "service_receipt_line_no_uniq" ON "service_receipt_line" USING btree ("service_receipt_id","line_no");--> statement-breakpoint
CREATE INDEX "service_receipt_line_po_line_idx" ON "service_receipt_line" USING btree ("purchase_order_line_id");--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- A confirmation line answers to a line of the confirmation's own order.
--
-- Two independent foreign keys cannot say this between them: without the check,
-- a confirmation against order A could carry a line belonging to order B, and
-- the three-way match (section 8.4) would reconcile against the wrong
-- commitment.
-- ---------------------------------------------------------------------------
CREATE FUNCTION service_receipt_line_belongs_to_order() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_order_id   uuid;
  v_line_order uuid;
  v_line_type  purchase_line_type;
  v_receipt_no text;
BEGIN
  SELECT purchase_order_id, receipt_no INTO v_order_id, v_receipt_no
    FROM service_receipt WHERE id = NEW.service_receipt_id;

  SELECT purchase_order_id, line_type INTO v_line_order, v_line_type
    FROM purchase_order_line WHERE id = NEW.purchase_order_line_id;

  IF v_line_order IS DISTINCT FROM v_order_id THEN
    RAISE EXCEPTION
      'Confirmation % is against one purchase order; line % belongs to a different one (blueprint 8.2). Confirm each order separately.',
      coalesce(v_receipt_no, '(new)'), NEW.line_no
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Section 8.2 splits the two flows deliberately: goods are received into a
  -- warehouse and post to GRNI; services and expenses are confirmed by the
  -- department that asked for them. An inventory line confirmed here would
  -- produce an A/P Invoice matched against a document that moved no stock, and
  -- the stock would never arrive in the ledger at all.
  IF v_line_type = 'inventory_item' THEN
    RAISE EXCEPTION
      'Line % is an inventory item (blueprint 8.2). Goods are received on a Goods Receipt, not confirmed here.',
      NEW.line_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER service_receipt_line_belongs_to_order
  BEFORE INSERT OR UPDATE ON service_receipt_line
  FOR EACH ROW EXECUTE FUNCTION service_receipt_line_belongs_to_order();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 8.2 — a confirmation is made against an approved order.
--
-- Confirming work against a draft order says the department accepted something
-- nobody agreed to buy. That happens in real organisations, and it is a
-- business event needing a decision rather than a quiet insert.
-- ---------------------------------------------------------------------------
CREATE FUNCTION service_receipt_order_is_confirmable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status document_status;
  v_no     text;
BEGIN
  SELECT status, order_no INTO v_status, v_no
    FROM purchase_order WHERE id = NEW.purchase_order_id;

  IF v_status NOT IN ('approved', 'partially_executed') THEN
    RAISE EXCEPTION
      'Purchase order % is %, so nothing can be confirmed against it (blueprint 8.2). An approved order is what authorises the work.',
      v_no, v_status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER service_receipt_order_is_confirmable
  BEFORE INSERT ON service_receipt
  FOR EACH ROW EXECUTE FUNCTION service_receipt_order_is_confirmable();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 8.6 — the benefiting department owns this document, and only somebody
-- from that department may confirm the work.
--
-- Checked here as well as in the service because it is the whole point of the
-- document: Purchasing agreed the price and Finance will pay the invoice, but
-- neither of them knows whether the work was done. An approval recorded by
-- someone outside the department is a signature with nothing behind it.
--
-- A Super User is exempt (section 5.1), and that exemption is deliberate rather
-- than accidental: somebody has to be able to unstick a document when the
-- department has no active member left.
-- ---------------------------------------------------------------------------
CREATE FUNCTION service_receipt_confirmed_by_department() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_member boolean;
BEGIN
  IF NEW.approved_by IS NULL OR NEW.approved_by IS NOT DISTINCT FROM OLD.approved_by THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM user_department_scope
     WHERE user_id = NEW.approved_by AND department_code = NEW.department_code
  ) OR EXISTS (
    SELECT 1 FROM app_user WHERE id = NEW.approved_by AND is_super_user
  ) INTO v_member;

  IF NOT v_member THEN
    RAISE EXCEPTION
      'Confirmation % is owned by department % (blueprint 8.6), and the approver does not belong to it. Only the benefiting department can confirm that the work was done.',
      NEW.receipt_no, NEW.department_code
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER service_receipt_confirmed_by_department
  BEFORE INSERT OR UPDATE ON service_receipt
  FOR EACH ROW EXECUTE FUNCTION service_receipt_confirmed_by_department();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- An approved confirmation is evidence. It is corrected by reversal (Appendix B
-- gives this document a Reversed status and no Cancelled one), never by editing
-- what it says happened.
-- ---------------------------------------------------------------------------
CREATE FUNCTION service_receipt_approved_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'approved' THEN
    RETURN NEW;
  END IF;

  IF NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id
  OR NEW.department_code   IS DISTINCT FROM OLD.department_code
  OR NEW.service_date      IS DISTINCT FROM OLD.service_date
  OR NEW.branch_code       IS DISTINCT FROM OLD.branch_code
  OR NEW.receipt_no        IS DISTINCT FROM OLD.receipt_no THEN
    RAISE EXCEPTION
      'Confirmation % has been approved and the A/P Invoice will be matched against it (blueprint 8.4). Reverse it and confirm again.',
      OLD.receipt_no USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER service_receipt_approved_is_final
  BEFORE UPDATE ON service_receipt
  FOR EACH ROW EXECUTE FUNCTION service_receipt_approved_is_final();--> statement-breakpoint

CREATE FUNCTION service_receipt_line_approved_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status document_status;
  v_no     text;
BEGIN
  SELECT status, receipt_no INTO v_status, v_no
    FROM service_receipt WHERE id = coalesce(NEW.service_receipt_id, OLD.service_receipt_id);

  IF v_status <> 'approved' THEN
    RETURN coalesce(NEW, OLD);
  END IF;

  RAISE EXCEPTION
    'Confirmation % has been approved; what it says was delivered cannot be changed (blueprint 3.2). Reverse it and confirm again.',
    v_no USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint

CREATE TRIGGER service_receipt_line_approved_is_final
  BEFORE UPDATE OR DELETE ON service_receipt_line
  FOR EACH ROW EXECUTE FUNCTION service_receipt_line_approved_is_final();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Appendix C has no posting row for this document.
--
-- The expense reaches the ledger at the A/P Invoice: "A/P Invoice -
-- service/expense | Expense / Service Cost | Supplier A/P | PO and Service
-- Receipt required." Appendix B calls this document's effect "receipt evidence
-- / accrual", and whether a period-end accrual is also required for confirmed
-- but uninvoiced services is an open question for the Business Process Owner
-- (D11) - not one the implementation team may answer by writing a journal.
--
-- Stated as a table property: there is no journal_entry_id column to fill in,
-- and no inventory movement column either.
-- ---------------------------------------------------------------------------

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('SERVICE_RECEIPT', 'SRV', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('service_receipt', 'Service Receipt / Expense Confirmation', 'purchasing',
   'Confirms that a purchased service or expense was actually delivered. Owned by the benefiting department (blueprint 8.6). Receipt evidence; no posting of its own.');--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('service_receipt', 'draft',     'submitted'),
  ('service_receipt', 'submitted', 'approved'),
  ('service_receipt', 'submitted', 'rejected'),
  ('service_receipt', 'submitted', 'draft'),
  ('service_receipt', 'rejected',  'draft'),
  ('service_receipt', 'draft',     'cancelled'),
  ('service_receipt', 'approved',  'reversed');--> statement-breakpoint

INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('service_receipt', 'purchase_order_id',
   'Decides which commitment the confirmation discharges and what the three-way match compares.'),
  ('service_receipt', 'department_code',
   'Decides who may confirm the work (blueprint 8.6). Changing it after submission would move the accountability.'),
  ('service_receipt', 'service_date',
   'The date the work was delivered, which decides the period the eventual expense belongs to.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Section 8.6 - owned by the benefiting department. Both seeded roles can raise
-- and submit; approval is the department's act, and the trigger above is what
-- makes "the department's" mean something.
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'service_receipt', 'view'),
  ('accounting_officer', 'service_receipt', 'create'),
  ('accounting_officer', 'service_receipt', 'edit_draft'),
  ('accounting_officer', 'service_receipt', 'submit'),
  ('accounting_officer', 'service_receipt', 'print'),
  ('accounting_manager', 'service_receipt', 'view'),
  ('accounting_manager', 'service_receipt', 'create'),
  ('accounting_manager', 'service_receipt', 'edit_draft'),
  ('accounting_manager', 'service_receipt', 'submit'),
  ('accounting_manager', 'service_receipt', 'approve'),
  ('accounting_manager', 'service_receipt', 'reverse_cancel'),
  ('accounting_manager', 'service_receipt', 'print'),
  ('accounting_manager', 'service_receipt', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist - grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON service_receipt, service_receipt_line FROM erp_app;

  GRANT SELECT, INSERT, UPDATE ON service_receipt TO erp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON service_receipt_line TO erp_app;
END;
$$;--> statement-breakpoint

ALTER TABLE service_receipt ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE service_receipt FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY service_receipt_branch_scope ON service_receipt
  USING (app_is_super_user() OR branch_code = app_current_branch())
  WITH CHECK (app_is_super_user() OR branch_code = app_current_branch());
