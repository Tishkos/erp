-- The Sales Invoice sells stock — Operations build, block 5 (2026-09-12).
--
-- The sponsor's document:
--
--   Lines    Item Code; Item Name; Quantity; Unit Price; Discount;
--            Total Price; Supplier; Warehouse.
--   Effect   A Sales Invoice decreases stock from the selected warehouse.
--   Journal  Accounts Receivable Dr. / Revenue Cr. / Inventory Cr. / COGS Dr.
--   COGS     FIFO. "The item cost follows the selected item, supplier and
--            warehouse stock."
--
-- Three things have to change for that sentence to be true.
--
-- ── A cost layer remembers who supplied it ─────────────────────────────────
-- FIFO has always been per item and per warehouse. The sponsor adds a third
-- key: the same panel bought from two suppliers is two pools of stock, and a
-- line that names a supplier must consume that supplier's layers and no
-- others. Without this column the cost would be the oldest stock of *any*
-- supplier, which is a different — and, for a company that reports margin by
-- supplier, a wrong — number.
--
-- Null where the stock came in without a supplier: opening stock, a transfer,
-- a reconciliation. A line that names no supplier consumes oldest-first across
-- them all, which is the behaviour that came before.
ALTER TABLE "cost_layer" ADD COLUMN IF NOT EXISTS "supplier_id" uuid;

ALTER TABLE "cost_layer" DROP CONSTRAINT IF EXISTS "cost_layer_supplier_id_fk";
ALTER TABLE "cost_layer"
  ADD CONSTRAINT "cost_layer_supplier_id_fk"
  FOREIGN KEY ("supplier_id") REFERENCES "business_partner"("id");

CREATE INDEX IF NOT EXISTS "cost_layer_supplier_idx"
  ON "cost_layer" ("item_code", "warehouse_code", "supplier_id");

COMMENT ON COLUMN "cost_layer"."supplier_id" IS
  'Who supplied this stock. FIFO consumes within one supplier when a sale names one; '
  'null for stock that arrived without one — opening, a transfer, a reconciliation.';--> statement-breakpoint

-- ── An invoice can stand on its own ────────────────────────────────────────
-- The A/R Invoice has always followed a Sales Order and a Delivery Note, and
-- its lines could not exist without both. The sponsor's invoice is the first
-- document in the chain: it sells the stock itself.
--
-- The references stay, and stay checked — an invoice that *does* come from a
-- delivery still points at it, and everything the sales cycle does is
-- unchanged. They simply stop being compulsory, so one document can be raised
-- without inventing an order and a delivery that nobody made.
ALTER TABLE "ar_invoice" ALTER COLUMN "delivery_note_id" DROP NOT NULL;
ALTER TABLE "ar_invoice" ALTER COLUMN "sales_order_id" DROP NOT NULL;
ALTER TABLE "ar_invoice_line" ALTER COLUMN "delivery_note_line_id" DROP NOT NULL;
ALTER TABLE "ar_invoice_line" ALTER COLUMN "sales_order_line_id" DROP NOT NULL;--> statement-breakpoint

-- ── Where the stock leaves from, and whose it is ───────────────────────────
-- Both on the line, not the document. The sponsor is explicit that "the same
-- item can be entered on separate invoice lines under different suppliers",
-- and one invoice may equally ship from two warehouses.
ALTER TABLE "ar_invoice_line" ADD COLUMN IF NOT EXISTS "warehouse_code" text;
ALTER TABLE "ar_invoice_line" ADD COLUMN IF NOT EXISTS "supplier_id" uuid;

ALTER TABLE "ar_invoice_line" DROP CONSTRAINT IF EXISTS "ar_invoice_line_warehouse_code_fk";
ALTER TABLE "ar_invoice_line"
  ADD CONSTRAINT "ar_invoice_line_warehouse_code_fk"
  FOREIGN KEY ("warehouse_code") REFERENCES "warehouse"("code");

ALTER TABLE "ar_invoice_line" DROP CONSTRAINT IF EXISTS "ar_invoice_line_supplier_id_fk";
ALTER TABLE "ar_invoice_line"
  ADD CONSTRAINT "ar_invoice_line_supplier_id_fk"
  FOREIGN KEY ("supplier_id") REFERENCES "business_partner"("id");

-- A supplier without a warehouse names a pool of stock but not where it is.
ALTER TABLE "ar_invoice_line" DROP CONSTRAINT IF EXISTS "ar_invoice_line_supplier_needs_warehouse";
ALTER TABLE "ar_invoice_line"
  ADD CONSTRAINT "ar_invoice_line_supplier_needs_warehouse"
  CHECK ("supplier_id" IS NULL OR "warehouse_code" IS NOT NULL);

-- A line is delivered or it is direct. Both would move the stock twice.
ALTER TABLE "ar_invoice_line" DROP CONSTRAINT IF EXISTS "ar_invoice_line_one_source";
ALTER TABLE "ar_invoice_line"
  ADD CONSTRAINT "ar_invoice_line_one_source"
  CHECK ("delivery_note_line_id" IS NULL OR "warehouse_code" IS NULL);

COMMENT ON COLUMN "ar_invoice_line"."warehouse_code" IS
  'Where this line takes stock from. Null when a Delivery Note already shipped it.';
COMMENT ON COLUMN "ar_invoice_line"."supplier_id" IS
  'Whose stock is being sold, when the cost is to follow one supplier. Null consumes oldest-first across all.';
