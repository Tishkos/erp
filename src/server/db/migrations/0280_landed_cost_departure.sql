-- IMPROVEMENT-002 — where every dinar of a landed-cost lock went.
--
-- A lock spreads an import's charges over the layers its containers created.
-- What is still on hand is restated into its unit cost; the share of units that
-- had already left follows the business event that took them (sponsor,
-- 2026-10-04): a sale to cost of sales with the sale's dimensions, a project
-- material issue through that issue's own project-cost path, a transfer to the
-- destination layer, a write-off to inventory loss, a supplier return to
-- purchase variance (or return clearing when the supplier reimburses the landed
-- cost), an Item Reconciliation or Stock Count to inventory adjustment. Never
-- "everything that left is cost of sales".
--
--   * `landed_cost_departure` — one row per lock × layer × departed movement:
--     the quantity, the amount, the source transaction, and the account and
--     dimensions it was posted to. A unit that comes back (sale reversed, sales
--     or project return) writes a negative row pointing at the departure it
--     undoes. A rounding residue with no movement behind it is its own row.
--     Generic: it names the inventory movement, never a project or a sale.
--   * The lock's `cogs_iqd` keeps its name (an applied column is not renamed)
--     and means "the part that had already left stock": the deferred check
--     below holds it equal to the lock's departure and rounding rows.
--   * `cost_layer.origin_layer_id` — the layer a relocated layer's stock came
--     from, written by the relocation itself, so a lock follows a transfer by
--     fact rather than by matching quantities.
--   * `goods_return.reimburses_landed_cost` — whether the supplier also pays
--     back the landed cost of what is returned; default no, frozen once posted.
CREATE TABLE IF NOT EXISTS "landed_cost_departure" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"lock_id" uuid NOT NULL REFERENCES "landed_cost_lock"("id"),
	"payable_id" uuid NOT NULL REFERENCES "payable"("id"),
	"kind" text NOT NULL,
	"cost_layer_id" uuid NOT NULL REFERENCES "cost_layer"("id"),
	-- The departed movement (a departure), or the one that brought the stock
	-- back (a return). Null only on a rounding row.
	"movement_id" uuid REFERENCES "inventory_movement"("id"),
	"movement_kind" text,
	"source_document_type" text,
	"source_document_id" text,
	"source_line_id" text,
	"quantity" numeric(24,6) NOT NULL,
	"amount_iqd" numeric(19,4) NOT NULL,
	"destination_role" text NOT NULL,
	"account_id" uuid NOT NULL REFERENCES "chart_of_account"("id"),
	"dimensions" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"journal_entry_id" uuid NOT NULL REFERENCES "journal_entry"("id"),
	"returns_departure_id" uuid REFERENCES "landed_cost_departure"("id"),
	-- The layer the returned units went into (a sales return's new layer, or the
	-- original layer for a reversal).
	"to_layer_id" uuid REFERENCES "cost_layer"("id"),
	"post_settlement" boolean NOT NULL DEFAULT false,
	"departed_on" date NOT NULL,
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "landed_cost_departure_kind" CHECK ("kind" IN ('departure', 'return', 'rounding')),
	CONSTRAINT "landed_cost_departure_shape" CHECK (
		("kind" = 'departure' AND "movement_id" IS NOT NULL AND "quantity" > 0 AND "amount_iqd" >= 0 AND "returns_departure_id" IS NULL)
		OR ("kind" = 'return' AND "movement_id" IS NOT NULL AND "quantity" < 0 AND "amount_iqd" <= 0 AND "returns_departure_id" IS NOT NULL)
		OR ("kind" = 'rounding' AND "movement_id" IS NULL AND "quantity" = 0 AND "amount_iqd" >= 0 AND "returns_departure_id" IS NULL)
	)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "landed_cost_departure_lock_idx" ON "landed_cost_departure" ("lock_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "landed_cost_departure_payable_idx" ON "landed_cost_departure" ("payable_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "landed_cost_departure_movement_idx" ON "landed_cost_departure" ("movement_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "landed_cost_departure_returns_idx" ON "landed_cost_departure" ("returns_departure_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "landed_cost_departure_layer_idx" ON "landed_cost_departure" ("cost_layer_id");
--> statement-breakpoint
DROP TRIGGER IF EXISTS "landed_cost_departure_append_only" ON "landed_cost_departure";
--> statement-breakpoint
CREATE TRIGGER "landed_cost_departure_append_only"
	BEFORE UPDATE OR DELETE ON "landed_cost_departure"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint

-- A return never gives back more than its departure took.
CREATE OR REPLACE FUNCTION landed_cost_departure_return_within() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	v_departed numeric;
	v_departed_amount numeric;
	v_returned numeric;
	v_returned_amount numeric;
BEGIN
	IF NEW.kind <> 'return' THEN
		RETURN NEW;
	END IF;
	SELECT quantity, amount_iqd INTO v_departed, v_departed_amount
	  FROM landed_cost_departure WHERE id = NEW.returns_departure_id AND kind = 'departure';
	IF v_departed IS NULL THEN
		RAISE EXCEPTION 'A landed-cost return must point at a departure.' USING ERRCODE = 'check_violation';
	END IF;
	SELECT coalesce(sum(-quantity), 0), coalesce(sum(-amount_iqd), 0) INTO v_returned, v_returned_amount
	  FROM landed_cost_departure WHERE returns_departure_id = NEW.returns_departure_id;
	IF v_returned - NEW.quantity > v_departed OR v_returned_amount - NEW.amount_iqd > v_departed_amount THEN
		RAISE EXCEPTION 'More of this landed cost would come back than left (% of %).', v_returned - NEW.quantity, v_departed
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "landed_cost_departure_return_within" ON "landed_cost_departure";
--> statement-breakpoint
CREATE TRIGGER "landed_cost_departure_return_within"
	BEFORE INSERT ON "landed_cost_departure"
	FOR EACH ROW EXECUTE FUNCTION landed_cost_departure_return_within();
--> statement-breakpoint

-- Every lock is fully accounted for: what it restated into stock plus what it
-- sent after departed stock equals its total. Checked at commit, because the
-- lock, its layer rows and its departure rows are written in one transaction.
CREATE OR REPLACE FUNCTION landed_cost_lock_accounted() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	v_lock record;
	v_departed numeric;
	v_inventory numeric;
	v_lock_id uuid;
BEGIN
	-- Each branch reads only the field its table has: PL/pgSQL would plan a
	-- CASE over both and refuse the one the row does not carry.
	IF TG_TABLE_NAME = 'landed_cost_lock' THEN
		v_lock_id := NEW.id;
	ELSE
		v_lock_id := NEW.lock_id;
	END IF;
	SELECT * INTO v_lock FROM landed_cost_lock WHERE id = v_lock_id;
	IF v_lock IS NULL THEN
		RETURN NULL;
	END IF;
	SELECT coalesce(sum(amount_iqd), 0) INTO v_departed
	  FROM landed_cost_departure WHERE lock_id = v_lock_id AND kind IN ('departure', 'rounding');
	SELECT coalesce(sum(inventory_iqd), 0) INTO v_inventory
	  FROM landed_cost_layer_adjustment WHERE lock_id = v_lock_id;
	IF v_departed <> v_lock.cogs_iqd OR v_inventory <> v_lock.inventory_iqd THEN
		RAISE EXCEPTION 'Landed-cost lock % is not fully accounted for: % into stock and % departed, against % and % on the lock.',
			v_lock.sequence, v_inventory, v_departed, v_lock.inventory_iqd, v_lock.cogs_iqd
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "landed_cost_lock_accounted" ON "landed_cost_lock";
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "landed_cost_lock_accounted"
	AFTER INSERT ON "landed_cost_lock"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW EXECUTE FUNCTION landed_cost_lock_accounted();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "landed_cost_departure_accounted" ON "landed_cost_departure";
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "landed_cost_departure_accounted"
	AFTER INSERT ON "landed_cost_departure"
	DEFERRABLE INITIALLY DEFERRED
	FOR EACH ROW EXECUTE FUNCTION landed_cost_lock_accounted();
--> statement-breakpoint

ALTER TABLE landed_cost_departure ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE landed_cost_departure FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS landed_cost_departure_branch_scope ON landed_cost_departure;--> statement-breakpoint
CREATE POLICY landed_cost_departure_branch_scope ON landed_cost_departure
	USING (
		app_is_super_user()
		OR EXISTS (SELECT 1 FROM payable p
		            WHERE p.id = landed_cost_departure.payable_id
		              AND app_branch_allowed(p.branch_code))
	)
	WITH CHECK (
		app_is_super_user()
		OR EXISTS (SELECT 1 FROM payable p
		            WHERE p.id = landed_cost_departure.payable_id
		              AND app_branch_allowed(p.branch_code))
	);
--> statement-breakpoint

-- The relocated layer's origin.
ALTER TABLE "cost_layer" ADD COLUMN IF NOT EXISTS "origin_layer_id" uuid REFERENCES "cost_layer"("id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_layer_origin_idx" ON "cost_layer" ("origin_layer_id") WHERE "origin_layer_id" IS NOT NULL;
--> statement-breakpoint

-- Whether the supplier pays back the landed cost of returned goods.
ALTER TABLE "goods_return" ADD COLUMN IF NOT EXISTS "reimburses_landed_cost" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION goods_return_posted_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status NOT IN ('posted', 'closed') THEN
    RETURN NEW;
  END IF;

  IF NEW.goods_receipt_id      IS DISTINCT FROM OLD.goods_receipt_id
  OR NEW.ap_invoice_id         IS DISTINCT FROM OLD.ap_invoice_id
  OR NEW.supplier_id           IS DISTINCT FROM OLD.supplier_id
  OR NEW.return_date           IS DISTINCT FROM OLD.return_date
  OR NEW.branch_code           IS DISTINCT FROM OLD.branch_code
  OR NEW.return_no             IS DISTINCT FROM OLD.return_no
  OR NEW.reimburses_landed_cost IS DISTINCT FROM OLD.reimburses_landed_cost THEN
    RAISE EXCEPTION
      'Goods return % has shipped and posted (blueprint 3.2). Reverse it; it is not edited.',
      OLD.return_no USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	-- Append-only: no UPDATE, no DELETE.
	GRANT SELECT, INSERT ON landed_cost_departure TO erp_app;
END $$;
