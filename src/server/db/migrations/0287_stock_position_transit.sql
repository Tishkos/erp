-- IMPROVEMENT-002 — goods in a transit warehouse are not on hand.
--
-- HAND-AUTHORED. Drizzle does not model views.
--
-- An import's goods stand in the stage warehouses (`warehouse.is_transit`,
-- `shipment_stage`) from the invoice until the container receipt moves them
-- into a store. The view counted them in that warehouse's `on_hand` (with
-- `available` 0), and its `in_transit` knew only the gap of a warehouse
-- transfer issued and not yet received. So every "On Hand" total that did not
-- exclude transit warehouses was wrong, and Logistics could not say "500
-- shipped, 300 received: 300 on hand, 200 in transit" from the one view.
--
-- Now, for a transit warehouse, `on_hand` is 0 and the goods are `in_transit`
-- on that warehouse's own row. `held` is new: the physical quantity in the
-- warehouse whatever its type — what the negative-stock rule reads, because
-- nothing leaves a warehouse that is not in it, a transit warehouse included.
-- Everything else is as 0027 and 0215 left it.
CREATE OR REPLACE VIEW stock_position AS
WITH movements AS (
  SELECT item_code,
         warehouse_code,
         branch_code,
         sum(quantity) AS held
    FROM inventory_movement
   GROUP BY item_code, warehouse_code, branch_code
),
reserved AS (
  SELECT item_code,
         warehouse_code,
         sum(quantity) AS reserved
    FROM stock_reservation
   WHERE released_at IS NULL
   GROUP BY item_code, warehouse_code
),
transit AS (
  -- A warehouse transfer issued and not wholly received: the units on the way.
  SELECT i.item_code,
         sum(-i.quantity) - COALESCE((
           SELECT sum(r_1.quantity)
             FROM inventory_movement r_1
            WHERE r_1.kind = 'transfer_receipt'::inventory_movement_kind
              AND r_1.item_code = i.item_code
              AND r_1.source_document_id = i.source_document_id), 0::numeric) AS in_transit
    FROM inventory_movement i
   WHERE i.kind = 'transfer_issue'::inventory_movement_kind
   GROUP BY i.item_code, i.source_document_id
)
SELECT m.item_code,
       m.warehouse_code,
       m.branch_code,
       CASE WHEN w.is_transit THEN 0::numeric ELSE m.held END AS on_hand,
       CASE
         WHEN w.warehouse_type = ANY (ARRAY['main'::warehouse_type, 'branch'::warehouse_type]) THEN m.held - COALESCE(r.reserved, 0::numeric)
         ELSE 0::numeric
       END AS available,
       COALESCE(r.reserved, 0::numeric) AS reserved,
       COALESCE((SELECT sum(t.in_transit) FROM transit t WHERE t.item_code = m.item_code), 0::numeric)
         + CASE WHEN w.is_transit THEN m.held ELSE 0::numeric END AS in_transit,
       CASE WHEN w.warehouse_type = 'quarantine'::warehouse_type THEN m.held ELSE 0::numeric END AS in_quarantine,
       CASE WHEN w.warehouse_type = 'damaged_goods'::warehouse_type THEN m.held ELSE 0::numeric END AS damaged,
       CASE WHEN w.warehouse_type = 'returns'::warehouse_type THEN m.held ELSE 0::numeric END AS returns_stock,
       m.held
  FROM movements m
  JOIN warehouse w ON w.code = m.warehouse_code
  LEFT JOIN reserved r ON r.item_code = m.item_code AND r.warehouse_code = m.warehouse_code;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT ON stock_position TO erp_app;
  END IF;
END $$;
