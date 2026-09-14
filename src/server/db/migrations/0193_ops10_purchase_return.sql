-- Purchase Return — Operations build, block 10 (2026-09-14).
--
--   Header   Supplier Name; Supplier Code; Date; Offset Account (Accounts
--            Payable or Bank — one must be selected); Original Purchase
--            Invoice Number.
--   Lines    Item Name; Item Code; Return Quantity; Item Price from the
--            original invoice; Warehouse from which the item will be returned.
--   Control  The return quantity cannot exceed the remaining returnable
--            quantity from the original Purchase Invoice after considering
--            previous returns.
--   Journal  Accounts Payable or Bank Dr. / Inventory Cr.
--
-- Two changes, and they are the same two the Sales Return needed.
--
-- ── The offset ────────────────────────────────────────────────────────────
-- The mirror of block 9, and the sign is the other way round: goods going back
-- to a supplier either shrink what the company owes them, or the supplier
-- refunds the money and it arrives in a bank. Accounts Payable Dr. in the first
-- case, Bank Dr. in the second. Booking a refund as a reduced payable leaves
-- the company still expecting to pay a debt that is already settled.
--
-- ── A return against the invoice, and not only the delivery ───────────────
-- The module was built for the chain the specification describes — purchase
-- order, goods receipt, invoice — and keyed the return to the receipt line,
-- because that is the line that carries the cost layer.
--
-- Block 4 added the sponsor's own route, where a Purchase Invoice books stock
-- straight into a warehouse and there is no receipt at all. A return against
-- one of those invoices could not be raised: the column it needed was NOT NULL
-- and there was nothing to put in it. The sponsor is explicit about which
-- document the quantity is controlled against — *"the remaining returnable
-- quantity from the original Purchase Invoice"* — so the receipt becomes
-- optional and the invoice line carries the return when there is no receipt.
--
-- A line may still name both — the receipt says what came in, the invoice line
-- says what to credit — but it must name at least one, or the return has no
-- cost layer to value it and no quantity to control it against.

ALTER TABLE "goods_return"
  ADD COLUMN IF NOT EXISTS "offset_kind" text NOT NULL DEFAULT 'payable';
--> statement-breakpoint

ALTER TABLE "goods_return"
  ADD COLUMN IF NOT EXISTS "offset_bank_account_id" uuid
    REFERENCES "bank_cash_account"("id");
--> statement-breakpoint

COMMENT ON COLUMN "goods_return"."offset_kind" IS
  'Which side the debit lands on: ''payable'' reduces what the company owes the '
  'supplier, ''bank'' takes their refund into a named bank or cash account.';
--> statement-breakpoint

ALTER TABLE "goods_return"
  ADD CONSTRAINT "goods_return_offset_one_of"
  CHECK (
    "offset_kind" IN ('payable', 'bank')
    AND ("offset_kind" = 'bank') = ("offset_bank_account_id" IS NOT NULL)
  );
--> statement-breakpoint

ALTER TABLE "goods_return" ALTER COLUMN "offset_kind" DROP DEFAULT;
--> statement-breakpoint

-- The receipt becomes optional, and then the header must name one source or
-- the other. Every row already there named a receipt, so the constraint holds
-- on arrival.
ALTER TABLE "goods_return" ALTER COLUMN "goods_receipt_id" DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE "goods_return"
  ADD CONSTRAINT "goods_return_has_a_source"
  CHECK ("goods_receipt_id" IS NOT NULL OR "ap_invoice_id" IS NOT NULL);
--> statement-breakpoint

ALTER TABLE "goods_return_line" ALTER COLUMN "goods_receipt_line_id" DROP NOT NULL;
--> statement-breakpoint

-- At least one source per line. A line naming neither has no cost layer behind
-- it and no remaining quantity to check against, so it could return anything.
ALTER TABLE "goods_return_line"
  ADD CONSTRAINT "goods_return_line_one_source"
  CHECK (
    ("goods_receipt_line_id" IS NOT NULL)::int
    + ("ap_invoice_line_id" IS NOT NULL)::int
    >= 1
  );
