-- ---------------------------------------------------------------------------
-- Operations build, block 7 — Transfer and Item Reconciliation.
--
--   Transfer              Items can be transferred between warehouses.
--   Item Reconciliation   Item Name; Warehouse; In/Out; Adjustment Quantity.
--                         The adjustment is entered as In or Out to match the
--                         actual inventory quantity.
--
-- Both had services built for the blueprint's longer workflows — a transfer
-- request that is approved, issued, carried in transit and received; a stock
-- count that is planned, counted, recounted and variance-approved — and no
-- screen at all. The build asks for neither workflow. It asks for a transfer
-- and an adjustment, so each is one document that moves the stock when it is
-- saved.
--
-- Each keeps a numbered record, because "correctly records the movement" means
-- a person can find the transfer afterwards by its number, and the Stock
-- Movement report needs something to name as the source.
-- ---------------------------------------------------------------------------

CREATE TABLE "stock_transfer" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "transfer_no" text NOT NULL,
  "item_code" text NOT NULL REFERENCES "item"("code"),
  "from_warehouse_code" text NOT NULL REFERENCES "warehouse"("code"),
  "to_warehouse_code" text NOT NULL REFERENCES "warehouse"("code"),
  "quantity" numeric(24, 6) NOT NULL,
  -- What the goods cost where they came from, carried to where they went.
  "cost_iqd" numeric(19, 4) NOT NULL,
  "transfer_date" date NOT NULL,
  "branch_code" text NOT NULL REFERENCES "branch"("code"),
  "created_by" uuid NOT NULL REFERENCES "app_user"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "stock_transfer_no_uniq" UNIQUE ("transfer_no"),
  CONSTRAINT "stock_transfer_quantity_positive" CHECK ("quantity" > 0),
  CONSTRAINT "stock_transfer_two_warehouses" CHECK ("from_warehouse_code" <> "to_warehouse_code")
);--> statement-breakpoint

CREATE TABLE "stock_adjustment" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "adjustment_no" text NOT NULL,
  "item_code" text NOT NULL REFERENCES "item"("code"),
  "warehouse_code" text NOT NULL REFERENCES "warehouse"("code"),
  -- In: stock found that the system did not have. Out: stock the system had
  -- that is not there.
  "direction" text NOT NULL,
  "quantity" numeric(24, 6) NOT NULL,
  "cost_iqd" numeric(19, 4) NOT NULL,
  "adjustment_date" date NOT NULL,
  "journal_entry_id" uuid REFERENCES "journal_entry"("id"),
  "branch_code" text NOT NULL REFERENCES "branch"("code"),
  "created_by" uuid NOT NULL REFERENCES "app_user"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "stock_adjustment_no_uniq" UNIQUE ("adjustment_no"),
  CONSTRAINT "stock_adjustment_direction_known" CHECK ("direction" IN ('in', 'out')),
  CONSTRAINT "stock_adjustment_quantity_positive" CHECK ("quantity" > 0)
);--> statement-breakpoint

CREATE INDEX "stock_transfer_date_idx" ON "stock_transfer" ("transfer_date");--> statement-breakpoint
CREATE INDEX "stock_adjustment_date_idx" ON "stock_adjustment" ("adjustment_date");--> statement-breakpoint

ALTER TABLE "stock_transfer" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_transfer" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "stock_transfer_branch" ON "stock_transfer"
  USING (
    app_is_super_user()
    OR "branch_code" IN (
      SELECT branch_code FROM user_branch_scope
       WHERE user_id = current_setting('app.user_id', true)::uuid
    )
  );--> statement-breakpoint

ALTER TABLE "stock_adjustment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_adjustment" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "stock_adjustment_branch" ON "stock_adjustment"
  USING (
    app_is_super_user()
    OR "branch_code" IN (
      SELECT branch_code FROM user_branch_scope
       WHERE user_id = current_setting('app.user_id', true)::uuid
    )
  );--> statement-breakpoint

-- Append-only: a transfer or an adjustment that was wrong is corrected by
-- another one, the way every stock movement is.
GRANT SELECT, INSERT ON "stock_transfer" TO erp_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "stock_adjustment" TO erp_app;--> statement-breakpoint

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year) VALUES
  ('STOCK_ADJUSTMENT', 'ADJ', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true)
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint

-- Who may use the two screens, and read the Stock Movement report. A transfer
-- was already `create` for both roles on `warehouse_transfer`.
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_manager', 'stock_reconciliation', 'view'),
  ('accounting_manager', 'stock_reconciliation', 'create'),
  ('accounting_officer', 'stock_reconciliation', 'view'),
  ('accounting_manager', 'stock_movement', 'view'),
  ('accounting_officer', 'stock_movement', 'view')
ON CONFLICT DO NOTHING;
