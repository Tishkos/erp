CREATE TYPE "public"."inventory_movement_kind" AS ENUM('opening_stock', 'goods_receipt', 'goods_return', 'transfer_issue', 'transfer_receipt', 'delivery', 'sales_return', 'quarantine_in', 'quarantine_release', 'quarantine_reject', 'damage', 'write_off', 'count_adjustment', 'reversal');--> statement-breakpoint
CREATE TABLE "cost_layer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_code" text NOT NULL,
	"warehouse_code" text NOT NULL,
	"branch_code" text NOT NULL,
	"layer_date" date NOT NULL,
	"sequence" integer NOT NULL,
	"original_quantity" numeric(24, 6) NOT NULL,
	"remaining_quantity" numeric(24, 6) NOT NULL,
	"unit_cost_iqd" numeric(19, 4) NOT NULL,
	"created_by_movement_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_layer_original_positive" CHECK ("cost_layer"."original_quantity" > 0),
	CONSTRAINT "cost_layer_cost_not_negative" CHECK ("cost_layer"."unit_cost_iqd" >= 0),
	CONSTRAINT "cost_layer_remaining_within_original" CHECK ("cost_layer"."remaining_quantity" >= 0 and "cost_layer"."remaining_quantity" <= "cost_layer"."original_quantity")
);
--> statement-breakpoint
CREATE TABLE "cost_layer_consumption" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "cost_layer_consumption_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"movement_id" uuid NOT NULL,
	"layer_id" uuid NOT NULL,
	"quantity" numeric(24, 6) NOT NULL,
	"unit_cost_iqd" numeric(19, 4) NOT NULL,
	"cost_iqd" numeric(19, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_layer_consumption_quantity_not_zero" CHECK ("cost_layer_consumption"."quantity" <> 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_movement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_code" text NOT NULL,
	"warehouse_code" text NOT NULL,
	"branch_code" text NOT NULL,
	"kind" "inventory_movement_kind" NOT NULL,
	"quantity" numeric(24, 6) NOT NULL,
	"movement_date" date NOT NULL,
	"source_document_type" text,
	"source_document_id" text,
	"source_line_id" text,
	"journal_entry_id" uuid,
	"serial_number" text,
	"batch_number" text,
	"expiry_date" date,
	"manufactured_on" date,
	"reverses_movement_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_movement_quantity_not_zero" CHECK ("inventory_movement"."quantity" <> 0)
);
--> statement-breakpoint
CREATE TABLE "stock_reservation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_code" text NOT NULL,
	"warehouse_code" text NOT NULL,
	"branch_code" text NOT NULL,
	"quantity" numeric(24, 6) NOT NULL,
	"document_type" text NOT NULL,
	"document_id" text NOT NULL,
	"document_line_id" text,
	"reserved_by" uuid NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"release_reason" text,
	CONSTRAINT "stock_reservation_quantity_positive" CHECK ("stock_reservation"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "cost_layer" ADD CONSTRAINT "cost_layer_item_code_item_code_fk" FOREIGN KEY ("item_code") REFERENCES "public"."item"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_layer" ADD CONSTRAINT "cost_layer_warehouse_code_warehouse_code_fk" FOREIGN KEY ("warehouse_code") REFERENCES "public"."warehouse"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_layer" ADD CONSTRAINT "cost_layer_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_layer" ADD CONSTRAINT "cost_layer_created_by_movement_id_inventory_movement_id_fk" FOREIGN KEY ("created_by_movement_id") REFERENCES "public"."inventory_movement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_layer_consumption" ADD CONSTRAINT "cost_layer_consumption_movement_id_inventory_movement_id_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."inventory_movement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_layer_consumption" ADD CONSTRAINT "cost_layer_consumption_layer_id_cost_layer_id_fk" FOREIGN KEY ("layer_id") REFERENCES "public"."cost_layer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_item_code_item_code_fk" FOREIGN KEY ("item_code") REFERENCES "public"."item"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_warehouse_code_warehouse_code_fk" FOREIGN KEY ("warehouse_code") REFERENCES "public"."warehouse"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservation" ADD CONSTRAINT "stock_reservation_item_code_item_code_fk" FOREIGN KEY ("item_code") REFERENCES "public"."item"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservation" ADD CONSTRAINT "stock_reservation_warehouse_code_warehouse_code_fk" FOREIGN KEY ("warehouse_code") REFERENCES "public"."warehouse"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservation" ADD CONSTRAINT "stock_reservation_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservation" ADD CONSTRAINT "stock_reservation_reserved_by_app_user_id_fk" FOREIGN KEY ("reserved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cost_layer_fifo_idx" ON "cost_layer" USING btree ("item_code","warehouse_code","layer_date","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "cost_layer_sequence_uniq" ON "cost_layer" USING btree ("item_code","warehouse_code","layer_date","sequence");--> statement-breakpoint
CREATE INDEX "cost_layer_consumption_movement_idx" ON "cost_layer_consumption" USING btree ("movement_id");--> statement-breakpoint
CREATE INDEX "cost_layer_consumption_layer_idx" ON "cost_layer_consumption" USING btree ("layer_id");--> statement-breakpoint
CREATE INDEX "inventory_movement_position_idx" ON "inventory_movement" USING btree ("item_code","warehouse_code","movement_date");--> statement-breakpoint
CREATE INDEX "inventory_movement_source_idx" ON "inventory_movement" USING btree ("source_document_type","source_document_id");--> statement-breakpoint
CREATE INDEX "inventory_movement_journal_idx" ON "inventory_movement" USING btree ("journal_entry_id");--> statement-breakpoint
CREATE INDEX "inventory_movement_serial_idx" ON "inventory_movement" USING btree ("item_code","serial_number");--> statement-breakpoint
CREATE INDEX "inventory_movement_batch_idx" ON "inventory_movement" USING btree ("item_code","batch_number");--> statement-breakpoint
CREATE INDEX "stock_reservation_live_idx" ON "stock_reservation" USING btree ("item_code","warehouse_code") WHERE "stock_reservation"."released_at" is null;--> statement-breakpoint
CREATE INDEX "stock_reservation_document_idx" ON "stock_reservation" USING btree ("document_type","document_id");--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE — Phase 04.1, 04.2, 04.4.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The ledger is append-only (§1.1, §9.9).
--
-- A movement is what happened. Correcting one is another movement that reverses
-- it, which is why `reverses_movement_id` exists — editing the original would
-- leave the FIFO layers describing a history that no longer matches the ledger.
-- ---------------------------------------------------------------------------
CREATE TRIGGER inventory_movement_append_only
  BEFORE UPDATE OR DELETE ON inventory_movement
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

CREATE TRIGGER cost_layer_consumption_append_only
  BEFORE UPDATE OR DELETE ON cost_layer_consumption
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

-- A reversal points at the movement it undoes. Self-referencing, so it is added
-- once the table exists.
ALTER TABLE inventory_movement
  ADD CONSTRAINT inventory_movement_reverses_fk
  FOREIGN KEY (reverses_movement_id) REFERENCES inventory_movement(id);--> statement-breakpoint

-- A movement is reversed at most once. A second reversal would restore the
-- stock twice, and the quantity would be wrong in a way no report flags (§9.2).
CREATE UNIQUE INDEX inventory_movement_reverses_uniq
  ON inventory_movement (reverses_movement_id)
  WHERE reverses_movement_id IS NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §9.2 — "Negative inventory is prohibited without exception."
--
-- The service checks availability before it writes, and produces a readable
-- message. This is the second layer, and it is the one that holds when the
-- write comes from an import, a script, or a module written next year: after
-- every movement, the running position for that item and warehouse must not be
-- negative.
--
-- A CONSTRAINT TRIGGER deferred to COMMIT, because a transfer writes an issue
-- and a receipt, and judging the issue alone would fail a transaction that is
-- correct by the time it commits.
-- ---------------------------------------------------------------------------
CREATE FUNCTION inventory_no_negative_stock() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_position numeric(24,6);
BEGIN
  SELECT coalesce(sum(quantity), 0) INTO v_position
    FROM inventory_movement
   WHERE item_code = NEW.item_code
     AND warehouse_code = NEW.warehouse_code;

  IF v_position < 0 THEN
    RAISE EXCEPTION
      'Item % in warehouse % would be left at %, and negative inventory is prohibited without exception (blueprint 9.2).',
      NEW.item_code, NEW.warehouse_code, v_position
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER inventory_no_negative_stock
  AFTER INSERT ON inventory_movement
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION inventory_no_negative_stock();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A cost layer's remaining quantity equals its original less what was consumed.
--
-- The CHECK on the table keeps the figure in range; this keeps it *correct*.
-- Deferred, because an issue writes the consumption rows and the new remaining
-- quantity as one act.
-- ---------------------------------------------------------------------------
CREATE FUNCTION cost_layer_remaining_matches_consumption() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_layer    cost_layer%ROWTYPE;
  v_consumed numeric(24,6);
BEGIN
  SELECT * INTO v_layer FROM cost_layer WHERE id = NEW.layer_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  SELECT coalesce(sum(quantity), 0) INTO v_consumed
    FROM cost_layer_consumption WHERE layer_id = NEW.layer_id;

  IF v_layer.remaining_quantity <> v_layer.original_quantity - v_consumed THEN
    RAISE EXCEPTION
      'Cost layer % says % remains of %, but % has been consumed from it. The layer and its consumption records disagree (blueprint 9.2).',
      v_layer.id, v_layer.remaining_quantity, v_layer.original_quantity, v_consumed
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER cost_layer_remaining_matches_consumption
  AFTER INSERT ON cost_layer_consumption
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cost_layer_remaining_matches_consumption();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 9.5 — the availability view.
--
-- Derived, never stored. Every figure comes from the movements and the live
-- reservations, so "the position" and "the movements that made it" cannot
-- disagree, which is what section 9.9's reconciliation requirement asks for.
--
-- Quarantine, damaged and returns are running balances of their own movement
-- kinds: stock goes into quarantine and later leaves it for a warehouse or a
-- return, and the bucket is the difference.
-- ---------------------------------------------------------------------------
CREATE VIEW stock_position AS
WITH movements AS (
  SELECT item_code,
         warehouse_code,
         branch_code,
         sum(quantity) AS on_hand,
         coalesce(sum(quantity) FILTER (
           WHERE kind IN ('quarantine_in','quarantine_release','quarantine_reject')), 0)
           AS in_quarantine,
         coalesce(sum(quantity) FILTER (WHERE kind IN ('damage','write_off')), 0) AS damaged_net,
         coalesce(sum(quantity) FILTER (WHERE kind IN ('goods_return','sales_return')), 0)
           AS returns_stock
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
       m.on_hand
         - coalesce(r.reserved, 0)
         - greatest(m.in_quarantine, 0)
         - greatest(-m.damaged_net, 0)                        AS available,
       coalesce(r.reserved, 0)                                AS reserved,
       coalesce((SELECT sum(t.in_transit) FROM transit t
                  WHERE t.item_code = m.item_code), 0)        AS in_transit,
       greatest(m.in_quarantine, 0)                           AS in_quarantine,
       greatest(-m.damaged_net, 0)                            AS damaged,
       greatest(m.returns_stock, 0)                           AS returns_stock
  FROM movements m
  LEFT JOIN reserved r
    ON r.item_code = m.item_code AND r.warehouse_code = m.warehouse_code;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON inventory_movement, cost_layer, cost_layer_consumption,
                stock_reservation, stock_position FROM erp_app;

  -- The ledger and the consumption record are append-only, so no UPDATE and no
  -- DELETE. A cost layer's remaining quantity is the one figure that moves.
  GRANT SELECT, INSERT         ON inventory_movement     TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON cost_layer             TO erp_app;
  GRANT SELECT, INSERT         ON cost_layer_consumption TO erp_app;
  -- A reservation is released by setting released_at, not by deleting the row:
  -- who promised this stock, and when it was let go, is an audit question.
  GRANT SELECT, INSERT, UPDATE ON stock_reservation      TO erp_app;
  GRANT SELECT                 ON stock_position         TO erp_app;
END;
$$;--> statement-breakpoint

-- Section 22 — branch scope, as on every other transactional table.
ALTER TABLE inventory_movement ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE inventory_movement FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE cost_layer         ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE cost_layer         FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE stock_reservation  ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE stock_reservation  FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY inventory_movement_branch_scope ON inventory_movement
  USING (app_is_super_user() OR branch_code = app_current_branch())
  WITH CHECK (app_is_super_user() OR branch_code = app_current_branch());--> statement-breakpoint

CREATE POLICY cost_layer_branch_scope ON cost_layer
  USING (app_is_super_user() OR branch_code = app_current_branch())
  WITH CHECK (app_is_super_user() OR branch_code = app_current_branch());--> statement-breakpoint

CREATE POLICY stock_reservation_branch_scope ON stock_reservation
  USING (app_is_super_user() OR branch_code = app_current_branch())
  WITH CHECK (app_is_super_user() OR branch_code = app_current_branch());
