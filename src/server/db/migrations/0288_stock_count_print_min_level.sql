-- IMPROVEMENT-002 — the Stock Count screens, and a minimum stock level.
--
--   * The Stock Count record prints (print model `stock_count`): the roles
--     that read a count may print it, and the manager export it, as every
--     other inventory document (0213).
--   * `item.min_stock_level` — the level below which the Warehouses Report
--     calls a warehouse's holding of the item low, in the item's base unit.
--     Null means no level is set, so nothing is called low.
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_manager', 'stock_count', 'print'),
  ('accounting_manager', 'stock_count', 'export'),
  ('accounting_officer', 'stock_count', 'print'),
  ('ceo', 'stock_count', 'view'),
  ('ceo', 'stock_count', 'print')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE "item" ADD COLUMN IF NOT EXISTS "min_stock_level" numeric(24,6);
--> statement-breakpoint
ALTER TABLE "item" DROP CONSTRAINT IF EXISTS "item_min_stock_level_not_negative";
--> statement-breakpoint
ALTER TABLE "item" ADD CONSTRAINT "item_min_stock_level_not_negative" CHECK ("min_stock_level" IS NULL OR "min_stock_level" >= 0);
