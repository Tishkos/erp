-- Items carry the two accounts a stock movement needs — Operations build,
-- block 1 (2026-09-12).
--
-- An item already names where its sales go and where its purchases go. Selling
-- one moves two more figures that the item alone can answer for:
--
--   inventory_account  the stock it is held in, credited as it leaves
--   cogs_account       what it cost, debited as it is sold
--
-- Both are held on the item rather than derived, because two items on one
-- invoice can belong to different stock and cost accounts, and the journal has
-- to know which for each line. Both are optional here: an item may be raised
-- before Finance has decided, and the document that needs them is what
-- refuses to post without them.
ALTER TABLE "item" ADD COLUMN IF NOT EXISTS "inventory_account_id" uuid;
ALTER TABLE "item" ADD COLUMN IF NOT EXISTS "cogs_account_id" uuid;

ALTER TABLE "item" DROP CONSTRAINT IF EXISTS "item_inventory_account_id_fk";
ALTER TABLE "item"
  ADD CONSTRAINT "item_inventory_account_id_fk"
  FOREIGN KEY ("inventory_account_id") REFERENCES "chart_of_account"("id");

ALTER TABLE "item" DROP CONSTRAINT IF EXISTS "item_cogs_account_id_fk";
ALTER TABLE "item"
  ADD CONSTRAINT "item_cogs_account_id_fk"
  FOREIGN KEY ("cogs_account_id") REFERENCES "chart_of_account"("id");

COMMENT ON COLUMN "item"."inventory_account_id" IS
  'The stock account this item is held in. Credited when it is sold, debited when it is bought.';
COMMENT ON COLUMN "item"."cogs_account_id" IS
  'The cost-of-goods-sold account this item is charged to when it is sold.';
