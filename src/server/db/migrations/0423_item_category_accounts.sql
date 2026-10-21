-- ===========================================================================
-- Item category accounts (2026-10-21, by direction: "the system asks me to
-- select a Cost of Goods Sold account for the item … assign the appropriate
-- COGS account to each item, or configure a default account for the item
-- group, so invoices can be posted"). HAND-AUTHORED. Additive.
--
-- A sale posts Dr COGS / Cr Inventory to the item's own two accounts (0183),
-- and refuses an item that names none. Items brought in by an import or a
-- script carried none, so their invoices could be approved and never posted.
--
-- One row per item category, and one row with `category` NULL — the company's
-- default for an item whose category has none. Setting a row fills every item
-- of that category (every item, for the company default) that names no
-- inventory or COGS account, one audit row per item; a new item takes it as it
-- is made. The item stays the one place a posting reads: this table is never
-- asked at posting time (`domain/posting-map.ts`).
--
-- Never deleted: a default is changed, and the change is audited.
-- ===========================================================================

CREATE TABLE "item_category_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	-- The item's category text, exactly; NULL is the company default.
	"category" text,
	"inventory_account_id" uuid REFERENCES "chart_of_account"("id"),
	"cogs_account_id" uuid REFERENCES "chart_of_account"("id"),
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "item_category_account_category_present" CHECK ("category" IS NULL OR btrim("category") <> '')
);
--> statement-breakpoint
-- One row per category, and one company default (NULL folds to '').
CREATE UNIQUE INDEX "item_category_account_category_uniq" ON "item_category_account" (coalesce("category", ''));
--> statement-breakpoint
CREATE TRIGGER "item_category_account_no_delete"
	BEFORE DELETE ON "item_category_account"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	GRANT SELECT, INSERT, UPDATE ON item_category_account TO erp_app;
END;
$$;
