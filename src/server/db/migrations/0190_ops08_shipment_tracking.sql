-- Invoice Status Tracking — Operations build, block 8 (2026-09-12).
--
--   In Process   A Purchase Invoice is automatically copied to this section
--                with all invoice details. The invoice items are booked to
--                the In Process warehouse.
--   On Board     the items are moved to the On Board warehouse.
--   On Port      the items are moved to the On Port warehouse.
--   In Bounded   a warehouse must be selected, and the items are moved there.
--   Notification Every status change notifies the selected system users.
--
-- Goods bought abroad are the company's for months before they arrive. They
-- are paid for, they are on a ship, and they are not in any warehouse a picker
-- can walk into — but they are stock, and a balance sheet that leaves them out
-- is wrong by whatever is at sea. This tracks them through the stages between
-- the invoice and the shelf.
--
-- ── Which warehouse is "the On Board warehouse" ────────────────────────────
-- A column on the warehouse, not a table mapping stages to warehouses.
--
-- The sponsor writes "the In Process warehouse" as though there is exactly
-- one, and there is: a stage is a property of the warehouse, the way being a
-- transit warehouse already is. Saying it here means two warehouses cannot
-- both claim to be the one goods land in, and the partial unique index below
-- is what makes that a fact rather than a convention.
CREATE TYPE "public"."shipment_stage" AS ENUM('in_process', 'on_board', 'on_port');--> statement-breakpoint

ALTER TABLE "warehouse" ADD COLUMN IF NOT EXISTS "shipment_stage" "shipment_stage";

CREATE UNIQUE INDEX IF NOT EXISTS "warehouse_shipment_stage_uniq"
  ON "warehouse" ("shipment_stage") WHERE "shipment_stage" IS NOT NULL;

COMMENT ON COLUMN "warehouse"."shipment_stage" IS
  'Which stage of an inbound shipment this warehouse holds. Null for an ordinary '
  'warehouse. At most one warehouse per stage.';--> statement-breakpoint

-- ── The shipment ──────────────────────────────────────────────────────────
-- One row per tracked purchase invoice. It carries no copy of the invoice:
-- "with all invoice details" is a screen reading the invoice it points at,
-- not a second set of figures that can disagree with the first.
CREATE TABLE "supplier_shipment" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,

  "ap_invoice_id" uuid NOT NULL REFERENCES "ap_invoice"("id"),

  -- Where the goods are now. 'in_bounded' is the end: they have arrived in a
  -- warehouse somebody chose, and the shipment stops being a shipment.
  "status" text NOT NULL DEFAULT 'in_process',

  -- The warehouse currently holding them. Moves with the status, and on the
  -- last move it becomes whichever warehouse was selected.
  "warehouse_code" text NOT NULL REFERENCES "warehouse"("code"),

  "branch_code" text NOT NULL REFERENCES "branch"("code"),

  "created_by" uuid REFERENCES "app_user"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "supplier_shipment_status_known"
    CHECK ("status" IN ('in_process', 'on_board', 'on_port', 'in_bounded')),

  -- One shipment per invoice. Tracking the same goods twice would move them
  -- twice.
  CONSTRAINT "supplier_shipment_invoice_uniq" UNIQUE ("ap_invoice_id")
);--> statement-breakpoint

CREATE INDEX "supplier_shipment_status_idx" ON "supplier_shipment" ("status");--> statement-breakpoint

-- ── Who is told ───────────────────────────────────────────────────────────
-- "Every status change sends a notification to the selected system users."
-- Selected once, per branch, rather than named on each shipment: the people
-- who need to know a container has docked are the same people every time, and
-- asking whoever moves the status to remember them is how somebody stops
-- being told.
CREATE TABLE "shipment_watcher" (
  "branch_code" text NOT NULL REFERENCES "branch"("code"),
  "user_id" uuid NOT NULL REFERENCES "app_user"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("branch_code", "user_id")
);--> statement-breakpoint

ALTER TABLE "supplier_shipment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "supplier_shipment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "supplier_shipment_branch" ON "supplier_shipment"
  USING (
    current_setting('app.is_super_user', true) = 'on'
    OR "branch_code" IN (
      SELECT branch_code FROM user_branch_scope
       WHERE user_id = current_setting('app.user_id', true)::uuid
    )
  );--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "supplier_shipment" TO erp_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "shipment_watcher" TO erp_app;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_manager', 'supplier_shipment', 'view'),
  ('accounting_manager', 'supplier_shipment', 'execute'),
  ('accounting_manager', 'supplier_shipment', 'configure'),
  ('accounting_officer', 'supplier_shipment', 'view'),
  ('accounting_officer', 'supplier_shipment', 'execute')
ON CONFLICT DO NOTHING;
