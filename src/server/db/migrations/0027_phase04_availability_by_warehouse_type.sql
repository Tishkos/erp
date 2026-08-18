-- ===========================================================================
-- Availability follows the warehouse's type — Phase 04.1, 04.7, 04.9.
--
-- HAND-AUTHORED. Drizzle does not model views.
--
-- Section 9.1 gives warehouses six types: main, branch, transit, quarantine,
-- damaged_goods and returns. Section 8.4 says quarantine stock is unavailable
-- for sale; section 9.8 says damaged stock cannot be reserved or sold.
--
-- The first version of this view derived those buckets from *movement kinds* —
-- summing quarantine_in against quarantine_release, and so on. That was wrong
-- in a way worth naming: it made "is this stock saleable?" a question about the
-- history of how it got there, when it is really a question about where it is
-- standing. Stock in a quarantine warehouse is quarantined whether it arrived
-- by receipt, transfer or correction, and a movement kind that was mislabelled
-- once would leave it saleable forever.
--
-- So the buckets are read from the warehouse's type. The consequence is that
-- the domain formula does not change at all: for a quarantine warehouse,
-- on_hand and in_quarantine are the same figure, so
--
--   available = on_hand - reserved - quarantine - damaged
--
-- is zero there, and at company level the same subtraction removes exactly the
-- stock sitting in non-saleable warehouses. One rule, two places, no special
-- cases.
-- ===========================================================================

DROP VIEW IF EXISTS stock_position;--> statement-breakpoint

CREATE VIEW stock_position AS
WITH movements AS (
  SELECT item_code,
         warehouse_code,
         branch_code,
         sum(quantity) AS on_hand
    FROM inventory_movement
   GROUP BY item_code, warehouse_code, branch_code
),
reserved AS (
  SELECT item_code, warehouse_code, sum(quantity) AS reserved
    FROM stock_reservation
   WHERE released_at IS NULL
   GROUP BY item_code, warehouse_code
),
transit AS (
  -- Issued from a warehouse and not yet received at its destination: the
  -- section 9.4 gap, which belongs to neither end.
  SELECT i.item_code,
         sum(-i.quantity) - coalesce((
           SELECT sum(r.quantity) FROM inventory_movement r
            WHERE r.kind = 'transfer_receipt'
              AND r.item_code = i.item_code
              AND r.source_document_id = i.source_document_id), 0) AS in_transit
    FROM inventory_movement i
   WHERE i.kind = 'transfer_issue'
   GROUP BY i.item_code, i.source_document_id
)
SELECT m.item_code,
       m.warehouse_code,
       m.branch_code,
       m.on_hand,
       -- Saleable only where the warehouse is a place stock is sold from.
       CASE WHEN w.warehouse_type IN ('main', 'branch')
            THEN m.on_hand - coalesce(r.reserved, 0)
            ELSE 0
       END                                                     AS available,
       coalesce(r.reserved, 0)                                 AS reserved,
       coalesce((SELECT sum(t.in_transit) FROM transit t
                  WHERE t.item_code = m.item_code), 0)         AS in_transit,
       CASE WHEN w.warehouse_type = 'quarantine'     THEN m.on_hand ELSE 0 END AS in_quarantine,
       CASE WHEN w.warehouse_type = 'damaged_goods'  THEN m.on_hand ELSE 0 END AS damaged,
       CASE WHEN w.warehouse_type = 'returns'        THEN m.on_hand ELSE 0 END AS returns_stock
  FROM movements m
  JOIN warehouse w ON w.code = m.warehouse_code
  LEFT JOIN reserved r
    ON r.item_code = m.item_code AND r.warehouse_code = m.warehouse_code;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  GRANT SELECT ON stock_position TO erp_app;
END;
$$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 9.8 — damaged stock does not come back.
--
-- "Damaged goods cannot be reserved, sold or returned to saleable stock after
-- final damage approval." The first two follow from the view above: a
-- damaged_goods warehouse has no availability, so nothing can be promised or
-- issued from it for sale.
--
-- The third needs enforcement, because a transfer out of the damaged warehouse
-- into a main one would look like an ordinary movement. It is refused here
-- rather than in the service, so an import or a script cannot quietly do what a
-- user is forbidden to do. Stock leaves a damaged warehouse only by being
-- written off.
-- ---------------------------------------------------------------------------
CREATE FUNCTION inventory_damaged_stays_damaged() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_type warehouse_type;
BEGIN
  SELECT warehouse_type INTO v_type FROM warehouse WHERE code = NEW.warehouse_code;

  -- Stated as a rule about leaving, not about arriving. Matching a receipt to
  -- the issue that fed it would mean guessing at how the stock travelled, and
  -- anything that arrived by a route the guess did not cover would pass.
  -- Damaged stock leaves by write-off, or by a reversal of the damage approval
  -- itself — which is a controlled correction with its own audit trail — and by
  -- nothing else.
  IF v_type = 'damaged_goods' AND NEW.quantity < 0
     AND NEW.kind NOT IN ('write_off', 'reversal') THEN
    RAISE EXCEPTION
      'Item % cannot leave the damaged warehouse as a %: it was approved as damaged (blueprint 9.8). Damaged stock leaves only by write-off, or by reversing the damage approval.',
      NEW.item_code, NEW.kind
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER inventory_damaged_stays_damaged
  BEFORE INSERT ON inventory_movement
  FOR EACH ROW EXECUTE FUNCTION inventory_damaged_stays_damaged();
