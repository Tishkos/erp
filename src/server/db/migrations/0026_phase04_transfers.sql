CREATE TYPE "public"."warehouse_transfer_status" AS ENUM('requested', 'approved', 'issued', 'in_transit', 'partially_received', 'received', 'investigating', 'closed', 'cancelled');--> statement-breakpoint
CREATE TABLE "warehouse_transfer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transfer_no" text NOT NULL,
	"status" "warehouse_transfer_status" DEFAULT 'requested' NOT NULL,
	"source_warehouse_code" text NOT NULL,
	"destination_warehouse_code" text NOT NULL,
	"branch_code" text NOT NULL,
	"requested_on" date NOT NULL,
	"issued_on" date,
	"received_on" date,
	"reason" text,
	"requested_by" uuid NOT NULL,
	"approved_by" uuid,
	"issued_by" uuid,
	"received_by" uuid,
	"loss_approved_by" uuid,
	"loss_approved_at" timestamp with time zone,
	"loss_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warehouse_transfer_distinct_warehouses" CHECK ("warehouse_transfer"."source_warehouse_code" <> "warehouse_transfer"."destination_warehouse_code")
);
--> statement-breakpoint
CREATE TABLE "warehouse_transfer_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transfer_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"item_code" text NOT NULL,
	"requested_quantity" numeric(24, 6) NOT NULL,
	"issued_quantity" numeric(24, 6) DEFAULT '0' NOT NULL,
	"received_quantity" numeric(24, 6) DEFAULT '0' NOT NULL,
	"serial_number" text,
	"batch_number" text,
	"issue_movement_id" uuid,
	"receipt_movement_id" uuid,
	"loss_movement_id" uuid,
	CONSTRAINT "warehouse_transfer_line_requested_positive" CHECK ("warehouse_transfer_line"."requested_quantity" > 0),
	CONSTRAINT "warehouse_transfer_line_issued_not_negative" CHECK ("warehouse_transfer_line"."issued_quantity" >= 0),
	CONSTRAINT "warehouse_transfer_line_received_not_negative" CHECK ("warehouse_transfer_line"."received_quantity" >= 0),
	CONSTRAINT "warehouse_transfer_line_received_within_issued" CHECK ("warehouse_transfer_line"."received_quantity" <= "warehouse_transfer_line"."issued_quantity")
);
--> statement-breakpoint
ALTER TABLE "warehouse_transfer" ADD CONSTRAINT "warehouse_transfer_source_warehouse_code_warehouse_code_fk" FOREIGN KEY ("source_warehouse_code") REFERENCES "public"."warehouse"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_transfer" ADD CONSTRAINT "warehouse_transfer_destination_warehouse_code_warehouse_code_fk" FOREIGN KEY ("destination_warehouse_code") REFERENCES "public"."warehouse"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_transfer" ADD CONSTRAINT "warehouse_transfer_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_transfer" ADD CONSTRAINT "warehouse_transfer_requested_by_app_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_transfer" ADD CONSTRAINT "warehouse_transfer_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_transfer" ADD CONSTRAINT "warehouse_transfer_issued_by_app_user_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_transfer" ADD CONSTRAINT "warehouse_transfer_received_by_app_user_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_transfer" ADD CONSTRAINT "warehouse_transfer_loss_approved_by_app_user_id_fk" FOREIGN KEY ("loss_approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_transfer_line" ADD CONSTRAINT "warehouse_transfer_line_transfer_id_warehouse_transfer_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."warehouse_transfer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_transfer_line" ADD CONSTRAINT "warehouse_transfer_line_item_code_item_code_fk" FOREIGN KEY ("item_code") REFERENCES "public"."item"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "warehouse_transfer_no_uniq" ON "warehouse_transfer" USING btree ("transfer_no");--> statement-breakpoint
CREATE INDEX "warehouse_transfer_status_idx" ON "warehouse_transfer" USING btree ("status","branch_code");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouse_transfer_line_no_uniq" ON "warehouse_transfer_line" USING btree ("transfer_id","line_no");--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE — Phase 04.6, section 9.4.
-- ===========================================================================

-- The movements a transfer line produced, for drill-down (Appendix B).
ALTER TABLE warehouse_transfer_line
  ADD CONSTRAINT warehouse_transfer_line_issue_fk
  FOREIGN KEY (issue_movement_id) REFERENCES inventory_movement(id);--> statement-breakpoint
ALTER TABLE warehouse_transfer_line
  ADD CONSTRAINT warehouse_transfer_line_receipt_fk
  FOREIGN KEY (receipt_movement_id) REFERENCES inventory_movement(id);--> statement-breakpoint
ALTER TABLE warehouse_transfer_line
  ADD CONSTRAINT warehouse_transfer_line_loss_fk
  FOREIGN KEY (loss_movement_id) REFERENCES inventory_movement(id);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 9.4 — a difference is investigated, never absorbed.
--
-- A transfer may only close when everything that left has been accounted for:
-- received at the destination, or written off as a loss a Warehouse Manager
-- approved. The alternative is a transfer that closes with stock unaccounted
-- for, which reconciles by forgetting.
-- ---------------------------------------------------------------------------
CREATE FUNCTION warehouse_transfer_closes_accounted() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_unaccounted numeric(24,6);
BEGIN
  IF NEW.status <> 'closed' THEN
    RETURN NEW;
  END IF;

  SELECT coalesce(sum(issued_quantity - received_quantity), 0)
    INTO v_unaccounted
    FROM warehouse_transfer_line
   WHERE transfer_id = NEW.id
     AND loss_movement_id IS NULL;

  IF v_unaccounted <> 0 THEN
    RAISE EXCEPTION
      'Transfer % cannot be closed: % still unaccounted for. Complete the destination receipt, or have a Warehouse Manager approve the loss (blueprint 9.4).',
      NEW.transfer_no, v_unaccounted
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER warehouse_transfer_closes_accounted
  BEFORE UPDATE ON warehouse_transfer
  FOR EACH ROW EXECUTE FUNCTION warehouse_transfer_closes_accounted();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A loss needs a named approver and a reason (section 9.4, 5.4).
--
-- "Not found" is a decision someone takes, not a state a document drifts into.
-- ---------------------------------------------------------------------------
ALTER TABLE warehouse_transfer
  ADD CONSTRAINT warehouse_transfer_loss_is_approved
  CHECK (
    (loss_approved_by IS NULL AND loss_approved_at IS NULL AND loss_reason IS NULL)
    OR (loss_approved_by IS NOT NULL AND loss_approved_at IS NOT NULL
        AND coalesce(btrim(loss_reason), '') <> '')
  );--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON warehouse_transfer, warehouse_transfer_line FROM erp_app;

  -- No DELETE: a transfer is a document, and section 1.1 keeps saved documents.
  -- A transfer that should not have been raised is cancelled.
  GRANT SELECT, INSERT, UPDATE ON warehouse_transfer      TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON warehouse_transfer_line TO erp_app;
END;
$$;--> statement-breakpoint

-- Section 22 — branch scope, as on every other transactional table.
ALTER TABLE warehouse_transfer ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE warehouse_transfer FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY warehouse_transfer_branch_scope ON warehouse_transfer
  USING (app_is_super_user() OR branch_code = app_current_branch())
  WITH CHECK (app_is_super_user() OR branch_code = app_current_branch());--> statement-breakpoint

-- The line follows its transfer: a line whose transfer is invisible is invisible.
ALTER TABLE warehouse_transfer_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE warehouse_transfer_line FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY warehouse_transfer_line_branch_scope ON warehouse_transfer_line
  USING (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM warehouse_transfer t
       WHERE t.id = warehouse_transfer_line.transfer_id
         AND t.branch_code = app_current_branch()
    )
  )
  WITH CHECK (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM warehouse_transfer t
       WHERE t.id = warehouse_transfer_line.transfer_id
         AND t.branch_code = app_current_branch()
    )
  );
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The transfer's own numbering and document type — sections 14.2, 3.2.
--
-- Numbered per branch and per year, like every other operational document, so
-- "TRF-BGW-2026-000012" says where and when without opening it.
-- ---------------------------------------------------------------------------
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('WAREHOUSE_TRANSFER', 'TRF', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('warehouse_transfer', 'Warehouse Transfer', 'inventory',
   'Moves stock between warehouses through in-transit (section 9.4).');--> statement-breakpoint

-- Appendix B's statuses for this document, mapped onto the section 3.2
-- vocabulary. `submitted` is the request awaiting approval; `executed` is stock
-- issued and in transit; `settled` is fully received; `closed` ends it.
INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('warehouse_transfer', 'draft',              'submitted'),
  ('warehouse_transfer', 'submitted',          'approved'),
  ('warehouse_transfer', 'submitted',          'rejected'),
  ('warehouse_transfer', 'submitted',          'draft'),
  ('warehouse_transfer', 'approved',           'executed'),
  ('warehouse_transfer', 'executed',           'partially_executed'),
  ('warehouse_transfer', 'executed',           'settled'),
  ('warehouse_transfer', 'partially_executed', 'settled'),
  ('warehouse_transfer', 'partially_executed', 'closed'),
  ('warehouse_transfer', 'settled',            'closed'),
  ('warehouse_transfer', 'draft',              'cancelled'),
  ('warehouse_transfer', 'approved',           'cancelled');--> statement-breakpoint

-- Section 9.4 — approving a loss is a Warehouse Manager's act, and section 5.3
-- keeps `approve` separate from `execute` so moving stock and writing it off
-- are different permissions.
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_manager', 'warehouse_transfer', 'view'),
  ('accounting_manager', 'warehouse_transfer', 'create'),
  ('accounting_manager', 'warehouse_transfer', 'execute'),
  ('accounting_manager', 'warehouse_transfer', 'approve'),
  ('accounting_officer', 'warehouse_transfer', 'view'),
  ('accounting_officer', 'warehouse_transfer', 'create');
