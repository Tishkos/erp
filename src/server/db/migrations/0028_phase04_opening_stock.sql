CREATE TABLE "opening_stock" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"branch_code" text NOT NULL,
	"warehouse_code" text NOT NULL,
	"document_date" date NOT NULL,
	"description" text,
	"created_by" uuid NOT NULL,
	"submitted_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"journal_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opening_stock_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opening_stock_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"item_code" text NOT NULL,
	"quantity" numeric(24, 6) NOT NULL,
	"uom_code" text NOT NULL,
	"unit_cost_iqd" numeric(19, 4) NOT NULL,
	"cost_layer_date" date NOT NULL,
	"serial_number" text,
	"batch_number" text,
	"manufactured_on" date,
	"expiry_date" date,
	"warranty_months" smallint,
	"movement_id" uuid,
	CONSTRAINT "opening_stock_line_quantity_positive" CHECK ("opening_stock_line"."quantity" > 0),
	CONSTRAINT "opening_stock_line_cost_not_negative" CHECK ("opening_stock_line"."unit_cost_iqd" >= 0),
	CONSTRAINT "opening_stock_line_expiry_after_manufacture" CHECK ("opening_stock_line"."expiry_date" is null or "opening_stock_line"."manufactured_on" is null or "opening_stock_line"."expiry_date" >= "opening_stock_line"."manufactured_on")
);
--> statement-breakpoint
ALTER TABLE "opening_stock" ADD CONSTRAINT "opening_stock_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_stock" ADD CONSTRAINT "opening_stock_warehouse_code_warehouse_code_fk" FOREIGN KEY ("warehouse_code") REFERENCES "public"."warehouse"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_stock" ADD CONSTRAINT "opening_stock_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_stock" ADD CONSTRAINT "opening_stock_submitted_by_app_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_stock" ADD CONSTRAINT "opening_stock_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_stock" ADD CONSTRAINT "opening_stock_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_stock_line" ADD CONSTRAINT "opening_stock_line_opening_stock_id_opening_stock_id_fk" FOREIGN KEY ("opening_stock_id") REFERENCES "public"."opening_stock"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_stock_line" ADD CONSTRAINT "opening_stock_line_item_code_item_code_fk" FOREIGN KEY ("item_code") REFERENCES "public"."item"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_stock_line" ADD CONSTRAINT "opening_stock_line_uom_code_unit_of_measure_code_fk" FOREIGN KEY ("uom_code") REFERENCES "public"."unit_of_measure"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "opening_stock_no_uniq" ON "opening_stock" USING btree ("document_no");--> statement-breakpoint
CREATE INDEX "opening_stock_status_idx" ON "opening_stock" USING btree ("status","branch_code");--> statement-breakpoint
CREATE UNIQUE INDEX "opening_stock_line_no_uniq" ON "opening_stock_line" USING btree ("opening_stock_id","line_no");--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE — Phase 04.5, section 9.7.
-- ===========================================================================

ALTER TABLE opening_stock_line
  ADD CONSTRAINT opening_stock_line_movement_fk
  FOREIGN KEY (movement_id) REFERENCES inventory_movement(id);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- An approved opening stock document is final (sections 1.1, 14.4).
--
-- Its lines became FIFO layers the moment it was approved, and every margin
-- computed since rests on them. Editing it afterwards would change the cost of
-- goods already sold — silently, because nothing recomputes.
-- ---------------------------------------------------------------------------
CREATE FUNCTION opening_stock_approved_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'approved' AND TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION
      'Opening stock % is approved and cannot be changed. Its lines are the FIFO layers every margin since has been computed against; correct it with an inventory adjustment (blueprint 9.6).',
      OLD.document_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Opening stock % cannot be deleted (blueprint 1.1). Cancel it while it is a draft, or reverse its effect with an adjustment.',
      OLD.document_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER opening_stock_approved_is_final
  BEFORE UPDATE OR DELETE ON opening_stock
  FOR EACH ROW EXECUTE FUNCTION opening_stock_approved_is_final();--> statement-breakpoint

-- A line of an approved document is equally fixed.
CREATE FUNCTION opening_stock_line_follows_document() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status document_status;
  v_no     text;
BEGIN
  SELECT status, document_no INTO v_status, v_no
    FROM opening_stock
   WHERE id = coalesce(NEW.opening_stock_id, OLD.opening_stock_id);

  -- The movement id is written by the approval itself, in the same transaction,
  -- so that one update is allowed through.
  IF v_status = 'approved' AND TG_OP = 'UPDATE'
     AND (OLD.movement_id IS NOT NULL OR NEW.movement_id IS NULL) THEN
    RAISE EXCEPTION
      'Opening stock % is approved; its lines cannot be changed (blueprint 1.1).', v_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_status = 'approved' AND TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Opening stock % is approved; its lines cannot be removed (blueprint 1.1).', v_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN coalesce(NEW, OLD);
END;
$$;--> statement-breakpoint

CREATE TRIGGER opening_stock_line_follows_document
  BEFORE UPDATE OR DELETE ON opening_stock_line
  FOR EACH ROW EXECUTE FUNCTION opening_stock_line_follows_document();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Numbering, document type and permissions.
-- ---------------------------------------------------------------------------
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('OPENING_STOCK', 'OPN', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('opening_stock', 'Opening Stock', 'inventory',
   'Brings existing stock onto the system with its FIFO cost and layer date (section 9.7).');--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('opening_stock', 'draft',     'submitted'),
  ('opening_stock', 'submitted', 'approved'),
  ('opening_stock', 'submitted', 'rejected'),
  ('opening_stock', 'submitted', 'draft'),
  ('opening_stock', 'rejected',  'draft'),
  ('opening_stock', 'draft',     'cancelled');--> statement-breakpoint

-- Section 14.4's maker-checker: the officer raises it, the manager approves it.
-- Approval writes the layers and the journal, so it carries the same weight as
-- approving a journal entry.
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'opening_stock', 'view'),
  ('accounting_officer', 'opening_stock', 'create'),
  ('accounting_officer', 'opening_stock', 'edit_draft'),
  ('accounting_officer', 'opening_stock', 'submit'),
  ('accounting_manager', 'opening_stock', 'view'),
  ('accounting_manager', 'opening_stock', 'create'),
  ('accounting_manager', 'opening_stock', 'edit_draft'),
  ('accounting_manager', 'opening_stock', 'submit'),
  ('accounting_manager', 'opening_stock', 'approve');--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON opening_stock, opening_stock_line FROM erp_app;

  -- No DELETE: section 1.1 keeps saved documents. A mistaken draft is cancelled.
  GRANT SELECT, INSERT, UPDATE ON opening_stock      TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON opening_stock_line TO erp_app;
END;
$$;--> statement-breakpoint

ALTER TABLE opening_stock ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE opening_stock FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY opening_stock_branch_scope ON opening_stock
  USING (app_is_super_user() OR branch_code = app_current_branch())
  WITH CHECK (app_is_super_user() OR branch_code = app_current_branch());
