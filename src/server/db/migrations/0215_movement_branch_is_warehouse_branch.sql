-- ===========================================================================
-- A stock movement is recorded under the branch of the warehouse that holds it.
--
-- HAND-AUTHORED. Drizzle does not model triggers.
--
-- `stock_position` groups by item, warehouse *and* branch; row-level security
-- scopes every read by branch; a warehouse belongs to exactly one branch. Until
-- now the movement's branch was whatever the caller passed — in practice the
-- signed-in user's — so a movement into a warehouse of another branch would be
-- stock that the warehouse's own branch could not see, and a position split
-- across two rows for one shelf. The service refuses that mismatch from
-- 2026-09-27; this holds the same rule for anything that does not come through
-- the service — an import, a script, a module written next year.
--
-- Stated on the cost layer too, for the same reason and because a layer's
-- branch is read by the Warehouses Report.
--
-- Existing rows are checked first, and the migration fails loudly if any
-- disagree: a rule that quietly exempts history is a rule with a hole in it,
-- and the person running the migration is the right person to decide what to
-- do about the rows it names.
-- ===========================================================================

DO $$
DECLARE
  v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad
    FROM inventory_movement m
    JOIN warehouse w ON w.code = m.warehouse_code
   WHERE m.branch_code <> w.branch_code;
  IF v_bad > 0 THEN
    RAISE EXCEPTION
      '% inventory_movement row(s) carry a branch other than their warehouse''s. Reconcile them before applying 0215 (see scripts/ops/stock-movement-trace.ts).',
      v_bad;
  END IF;

  SELECT count(*) INTO v_bad
    FROM cost_layer l
    JOIN warehouse w ON w.code = l.warehouse_code
   WHERE l.branch_code <> w.branch_code;
  IF v_bad > 0 THEN
    RAISE EXCEPTION
      '% cost_layer row(s) carry a branch other than their warehouse''s. Reconcile them before applying 0215.',
      v_bad;
  END IF;
END;
$$;--> statement-breakpoint

CREATE FUNCTION inventory_branch_is_warehouse_branch() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_branch text;
BEGIN
  SELECT branch_code INTO v_branch FROM warehouse WHERE code = NEW.warehouse_code;

  IF v_branch IS NULL THEN
    RAISE EXCEPTION 'No warehouse %.', NEW.warehouse_code
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW.branch_code <> v_branch THEN
    RAISE EXCEPTION
      'Stock in % is recorded under branch %, not % — a movement carries the branch of the warehouse that holds the goods (blueprint 9.5, 22).',
      NEW.warehouse_code, v_branch, NEW.branch_code
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER inventory_movement_branch_is_warehouse_branch
  BEFORE INSERT ON inventory_movement
  FOR EACH ROW EXECUTE FUNCTION inventory_branch_is_warehouse_branch();--> statement-breakpoint

CREATE TRIGGER cost_layer_branch_is_warehouse_branch
  BEFORE INSERT ON cost_layer
  FOR EACH ROW EXECUTE FUNCTION inventory_branch_is_warehouse_branch();
