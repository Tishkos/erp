-- The Purchase Invoice receives stock — Operations build, block 4 (2026-09-12).
--
-- The sponsor's document:
--
--   Lines   Item Code; Item Name; Quantity; Unit Price; Discount;
--           Total Price; Warehouse.
--   Effect  A Purchase Invoice increases stock in the selected warehouse.
--   Journal Inventory Dr. / Accounts Payable Cr.
--
-- The A/P Invoice already carries the item, the quantity and the unit price.
-- Two fields are missing and this adds them.
--
-- ── warehouse_code ─────────────────────────────────────────────────────────
-- Where the stock lands. Null on every line that is not stock — a service, a
-- freight charge — and on an invoice that follows a Goods Receipt, because
-- the goods already arrived on that receipt and receiving them a second time
-- would double the stock. That is why this is a column on the line and not a
-- setting on the document: one invoice can carry both kinds.
--
-- ── discount_iqd ───────────────────────────────────────────────────────────
-- Held as an amount, not a percentage. A percentage has to be multiplied out
-- before it can be posted, and the rounding of that multiplication is then a
-- fact nobody recorded — two people reading the same invoice can compute two
-- different totals. The amount is what the supplier and the company agreed;
-- a screen may offer a percentage and work it out, but what is kept is the
-- money.
--
-- Total price is not stored. It is quantity × unit price − discount, and a
-- stored total is one more thing that can disagree with its own parts.
ALTER TABLE "ap_invoice_line" ADD COLUMN IF NOT EXISTS "warehouse_code" text;
ALTER TABLE "ap_invoice_line"
  ADD COLUMN IF NOT EXISTS "discount_iqd" numeric(19, 4) NOT NULL DEFAULT 0;

ALTER TABLE "ap_invoice_line" DROP CONSTRAINT IF EXISTS "ap_invoice_line_warehouse_code_fk";
ALTER TABLE "ap_invoice_line"
  ADD CONSTRAINT "ap_invoice_line_warehouse_code_fk"
  FOREIGN KEY ("warehouse_code") REFERENCES "warehouse"("code");

-- A discount cannot be negative, and cannot exceed what is being discounted:
-- either would make the line a credit note wearing an invoice's clothes.
ALTER TABLE "ap_invoice_line" DROP CONSTRAINT IF EXISTS "ap_invoice_line_discount_range";
ALTER TABLE "ap_invoice_line"
  ADD CONSTRAINT "ap_invoice_line_discount_range"
  CHECK ("discount_iqd" >= 0 AND "discount_iqd" <= "quantity" * "unit_price");

-- Only a stock line can name a warehouse.
ALTER TABLE "ap_invoice_line" DROP CONSTRAINT IF EXISTS "ap_invoice_line_warehouse_is_inventory";
ALTER TABLE "ap_invoice_line"
  ADD CONSTRAINT "ap_invoice_line_warehouse_is_inventory"
  CHECK ("warehouse_code" IS NULL OR "is_inventory");

COMMENT ON COLUMN "ap_invoice_line"."warehouse_code" IS
  'Where this line receives stock. Null when the line is not stock, or when a '
  'Goods Receipt already brought the goods in.';
COMMENT ON COLUMN "ap_invoice_line"."discount_iqd" IS
  'Money off this line. The total is quantity x unit price less this, and is not stored.';
