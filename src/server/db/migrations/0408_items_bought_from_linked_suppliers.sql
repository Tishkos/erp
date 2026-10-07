-- 0408 — an item is bought only from the suppliers linked to it (2026-10-06,
-- by direction: "an item needed to be linked to a supplier before buying so in
-- the table should have an option which supplier we are buying from").
--
-- `item_supplier` (0174) already says which suppliers sell an item, with one of
-- them the default and the supplier's own code for it. From this release a
-- purchase names only an item linked to its supplier: a purchase invoice line,
-- a draft line typed in place and a purchase order line are refused otherwise
-- (`items.assertBoughtFrom`, called by `ap-invoice.create`, `ap-invoice.saveLine`
-- and `purchase-order.create`), and the line pickers offer only those items.
--
-- What the table gains:
--
--   1. A link is taken out of use with its reason, by whom and when — never
--      deleted. The service no longer deletes one, and the application role
--      loses DELETE on the table, so the trail of who could sell what stays.
--      A link that was already out of use is given a reason that says so.
--   2. Who made a link.
--   3. Every pair already bought — an item on a purchase invoice line or a
--      purchase order line of that supplier — is linked here, so no supplier
--      the company already buys from loses an item, and no draft stops saving.
--      An item that had no supplier gets its first one as the default, as the
--      Items screen does. Each link made here is an append-only audit row with
--      no actor (the release made it).
ALTER TABLE "item_supplier" ADD COLUMN IF NOT EXISTS "created_by" uuid REFERENCES "app_user" ("id");
--> statement-breakpoint
ALTER TABLE "item_supplier" ADD COLUMN IF NOT EXISTS "deactivated_reason" text;
--> statement-breakpoint
ALTER TABLE "item_supplier" ADD COLUMN IF NOT EXISTS "deactivated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "item_supplier" ADD COLUMN IF NOT EXISTS "deactivated_by" uuid REFERENCES "app_user" ("id");
--> statement-breakpoint
UPDATE "item_supplier"
   SET "deactivated_reason" = 'Out of use before reasons were recorded (migration 0408).'
 WHERE NOT "active" AND coalesce(btrim("deactivated_reason"), '') = '';
--> statement-breakpoint
ALTER TABLE "item_supplier" DROP CONSTRAINT IF EXISTS "item_supplier_deactivated_has_reason";
--> statement-breakpoint
ALTER TABLE "item_supplier" ADD CONSTRAINT "item_supplier_deactivated_has_reason"
	CHECK ("active" OR coalesce(btrim("deactivated_reason"), '') <> '');
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		REVOKE DELETE ON "item_supplier" FROM "erp_app";
	END IF;
END $$;
--> statement-breakpoint
SELECT set_config('app.is_super_user', 'true', true);
--> statement-breakpoint
WITH bought AS (
	SELECT it.id AS item_id, i.supplier_id
	  FROM "ap_invoice_line" l
	  JOIN "ap_invoice" i ON i.id = l.ap_invoice_id
	  JOIN "item" it ON it.code = l.item_code
	 WHERE l.item_code IS NOT NULL
	UNION
	SELECT it.id AS item_id, o.supplier_id
	  FROM "purchase_order_line" l
	  JOIN "purchase_order" o ON o.id = l.purchase_order_id
	  JOIN "item" it ON it.code = l.item_code
	 WHERE l.item_code IS NOT NULL
),
linked AS (
	INSERT INTO "item_supplier" ("item_id", "supplier_id", "is_default", "active")
	SELECT b.item_id, b.supplier_id, false, true
	  FROM bought b
	  JOIN "business_partner" bp ON bp.id = b.supplier_id AND bp.is_supplier
	ON CONFLICT ("item_id", "supplier_id") DO NOTHING
	RETURNING "item_id", "supplier_id"
)
INSERT INTO "audit_event" ("action", "object_type", "object_id", "before_value", "after_value", "reason", "outcome")
SELECT 'item.supplier_linked',
       'item',
       it.code,
       NULL,
       jsonb_build_object('supplier', bp.code, 'supplierItemCode', NULL, 'isDefault', false),
       'Migration 0408: already bought from this supplier on a purchase invoice or a purchase order before an item had to be linked to its supplier.',
       'success'
  FROM linked k
  JOIN "item" it ON it.id = k.item_id
  JOIN "business_partner" bp ON bp.id = k.supplier_id;
--> statement-breakpoint
WITH pick AS (
	SELECT DISTINCT ON (s.item_id) s.item_id, s.supplier_id, bp.code AS supplier_code
	  FROM "item_supplier" s
	  JOIN "business_partner" bp ON bp.id = s.supplier_id
	 WHERE s.active
	   AND NOT EXISTS (SELECT 1 FROM "item_supplier" d WHERE d.item_id = s.item_id AND d.is_default)
	 ORDER BY s.item_id, bp.code
),
made AS (
	UPDATE "item_supplier" s
	   SET "is_default" = true
	  FROM pick
	 WHERE s.item_id = pick.item_id AND s.supplier_id = pick.supplier_id
	RETURNING s.item_id, pick.supplier_code
)
INSERT INTO "audit_event" ("action", "object_type", "object_id", "before_value", "after_value", "reason", "outcome")
SELECT 'item.supplier_updated',
       'item',
       it.code,
       jsonb_build_object('supplier', m.supplier_code, 'isDefault', false),
       jsonb_build_object('supplier', m.supplier_code, 'isDefault', true),
       'Migration 0408: the item''s only supplier, or the first by code, made its default supplier.',
       'success'
  FROM made m
  JOIN "item" it ON it.id = m.item_id;
--> statement-breakpoint
SELECT set_config('app.is_super_user', '', true);
