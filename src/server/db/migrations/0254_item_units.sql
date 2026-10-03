-- REQ-FIX-001 FIX-4 — units of measure that work.
--
-- An item's other units (a carton of 24, a roll of 100 m) were possible in
-- `item_uom` since Phase 3 and never offered. They are kept, never deleted:
-- a unit a document was written in must still be readable, so a unit is
-- deactivated with its reason. The base unit cannot be deactivated (it is the
-- unit every quantity is converted through), and an item has at most one
-- purchase default and one sales default among its active units.

ALTER TABLE "item_uom" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "item_uom" ADD COLUMN "deactivated_reason" text;--> statement-breakpoint
ALTER TABLE "item_uom" ADD COLUMN "deactivated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "item_uom" ADD COLUMN "deactivated_by" uuid REFERENCES "app_user"("id");--> statement-breakpoint
ALTER TABLE "item_uom" ADD CONSTRAINT "item_uom_deactivated_has_reason"
	CHECK ("active" OR coalesce(btrim("deactivated_reason"), '') <> '');--> statement-breakpoint

CREATE UNIQUE INDEX "item_uom_one_purchase_default" ON "item_uom" USING btree ("item_id") WHERE "is_purchase_default" AND "active";--> statement-breakpoint
CREATE UNIQUE INDEX "item_uom_one_sales_default" ON "item_uom" USING btree ("item_id") WHERE "is_sales_default" AND "active";--> statement-breakpoint

CREATE FUNCTION item_uom_base_stays_active() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NOT NEW.active AND EXISTS (SELECT 1 FROM item WHERE id = NEW.item_id AND base_uom_code = NEW.uom_code) THEN
		RAISE EXCEPTION 'The base unit of an item stays active: every quantity of the item is converted through it.'
			USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER item_uom_base_stays_active
	BEFORE UPDATE ON item_uom
	FOR EACH ROW EXECUTE FUNCTION item_uom_base_stays_active();
--> statement-breakpoint

-- Until now every quantity was treated as the item's base unit, whatever unit
-- code the line carried (a purchase order line defaulted to EA). The lines
-- naming a unit their item does not keep are put in the item's base unit —
-- which is how their quantities were moved — so converting them from now on
-- changes nothing that already happened. A posted document's lines are final
-- by trigger and the rest are re-validated on every update; the unit code was
-- a default nobody chose, so the user triggers of these tables stand aside
-- for this one correction, which touches nothing else.
ALTER TABLE ap_invoice_line DISABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE purchase_order_line DISABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE goods_receipt_line DISABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE goods_return_line DISABLE TRIGGER USER;--> statement-breakpoint
UPDATE ap_invoice_line l SET uom_code = i.base_uom_code
  FROM item i
 WHERE i.code = l.item_code
   AND NOT EXISTS (SELECT 1 FROM item_uom u WHERE u.item_id = i.id AND u.uom_code = l.uom_code);--> statement-breakpoint
UPDATE purchase_order_line l SET uom_code = i.base_uom_code
  FROM item i
 WHERE i.code = l.item_code
   AND NOT EXISTS (SELECT 1 FROM item_uom u WHERE u.item_id = i.id AND u.uom_code = l.uom_code);--> statement-breakpoint
UPDATE goods_receipt_line l SET uom_code = i.base_uom_code
  FROM item i
 WHERE i.code = l.item_code
   AND NOT EXISTS (SELECT 1 FROM item_uom u WHERE u.item_id = i.id AND u.uom_code = l.uom_code);--> statement-breakpoint
UPDATE goods_return_line l SET uom_code = i.base_uom_code
  FROM item i
 WHERE i.code = l.item_code
   AND NOT EXISTS (SELECT 1 FROM item_uom u WHERE u.item_id = i.id AND u.uom_code = l.uom_code);--> statement-breakpoint
UPDATE payable_order_line l SET uom_code = i.base_uom_code
  FROM item i
 WHERE i.code = l.item_code AND l.uom_code IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM item_uom u WHERE u.item_id = i.id AND u.uom_code = l.uom_code);--> statement-breakpoint
ALTER TABLE ap_invoice_line ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE purchase_order_line ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE goods_receipt_line ENABLE TRIGGER USER;--> statement-breakpoint
ALTER TABLE goods_return_line ENABLE TRIGGER USER;
