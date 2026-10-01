-- ===========================================================================
-- Payables — Stage 7, the landed cost (REQ-AP-001 §20.1, §20.2).
-- HAND-AUTHORED. Everything additive; nothing posted changes meaning.
--
--   landed_cost_basis      by value (seed default) · by quantity · by weight
--                          · by volume · manual — a master (R4); weight and
--                          volume wait for the item master to carry them
--   landed_cost_charge     + the lock that consumed it, + a reason (an
--                          `other` charge says what it is)
--   landed_cost_lock       one row per lock of an import's cost — the first,
--                          and every dated adjustment after it; append-only
--   landed_cost_layer_adjustment   what each lock did to each FIFO layer the
--                          import's containers created: the share still on
--                          hand restates the layer's unit cost (Dr Inventory),
--                          the share already gone is cost of sales (Dr COGS);
--                          append-only
--
-- The value-only restatement is its own record, not a zero-quantity movement:
-- the ledger refuses a movement of nothing (inventory_movement_quantity_not_
-- zero) and quantities are all it holds (AGENTS.md, "one ledger"). The layer
-- row and its adjustment are written in one transaction with the journal.
-- ===========================================================================

CREATE TABLE "landed_cost_basis" (
	"code" text PRIMARY KEY,
	"name" text NOT NULL,
	"is_default" boolean NOT NULL DEFAULT false,
	"sort_order" smallint NOT NULL DEFAULT 0,
	"active" boolean NOT NULL DEFAULT true,
	"created_by" uuid REFERENCES "app_user"("id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "landed_cost_basis_one_default" ON "landed_cost_basis" ("is_default") WHERE "is_default";
--> statement-breakpoint
INSERT INTO "landed_cost_basis" ("code", "name", "is_default", "sort_order", "active") VALUES
	('by_value',    'By value',    true,  1, true),
	('by_quantity', 'By quantity', false, 2, true),
	-- The item master carries no weight or volume yet; seeded so the setting
	-- exists, inactive until it can be honoured.
	('by_weight',   'By weight',   false, 3, false),
	('by_volume',   'By volume',   false, 4, false),
	('manual',      'Manual',      false, 5, true);
--> statement-breakpoint

CREATE TABLE "landed_cost_lock" (
	"id" uuid PRIMARY KEY,
	"payable_id" uuid NOT NULL REFERENCES "payable"("id"),
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	-- 1 is the lock; 2, 3 … are the dated adjustments a late charge makes.
	"sequence" smallint NOT NULL,
	"lock_date" date NOT NULL,
	"basis_code" text NOT NULL REFERENCES "landed_cost_basis"("code"),
	"total_iqd" numeric(19,4) NOT NULL,
	"inventory_iqd" numeric(19,4) NOT NULL,
	"cogs_iqd" numeric(19,4) NOT NULL,
	"journal_entry_id" uuid NOT NULL REFERENCES "journal_entry"("id"),
	"note" text,
	"locked_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"locked_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "landed_cost_lock_sequence_positive" CHECK ("sequence" > 0),
	CONSTRAINT "landed_cost_lock_total" CHECK (
		"total_iqd" > 0 AND "inventory_iqd" >= 0 AND "cogs_iqd" >= 0
		AND "total_iqd" = "inventory_iqd" + "cogs_iqd"
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "landed_cost_lock_sequence_uniq" ON "landed_cost_lock" ("payable_id", "sequence");
--> statement-breakpoint
CREATE TRIGGER "landed_cost_lock_append_only"
	BEFORE UPDATE OR DELETE ON "landed_cost_lock"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint

ALTER TABLE "landed_cost_charge" ADD COLUMN "lock_id" uuid REFERENCES "landed_cost_lock"("id");
--> statement-breakpoint
ALTER TABLE "landed_cost_charge" ADD COLUMN "reason" text;
--> statement-breakpoint
-- A locked charge is part of the cost; it is not cancelled, it is adjusted.
ALTER TABLE "landed_cost_charge" ADD CONSTRAINT "landed_cost_charge_locked_not_cancelled" CHECK (
	"lock_id" IS NULL OR "cancelled_at" IS NULL
);
--> statement-breakpoint
CREATE INDEX "landed_cost_charge_unlocked_idx" ON "landed_cost_charge" ("payable_id")
	WHERE "lock_id" IS NULL AND "cancelled_at" IS NULL;
--> statement-breakpoint

CREATE TABLE "landed_cost_layer_adjustment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"lock_id" uuid NOT NULL REFERENCES "landed_cost_lock"("id"),
	"payable_id" uuid NOT NULL REFERENCES "payable"("id"),
	"cost_layer_id" uuid NOT NULL REFERENCES "cost_layer"("id"),
	"item_code" text NOT NULL REFERENCES "item"("code"),
	"warehouse_code" text NOT NULL REFERENCES "warehouse"("code"),
	-- What this layer was given of the lock, and how it was spent.
	"allocated_iqd" numeric(19,4) NOT NULL,
	"on_hand_qty" numeric(24,6) NOT NULL,
	"unit_cost_before" numeric(19,4) NOT NULL,
	"unit_cost_after" numeric(19,4) NOT NULL,
	"inventory_iqd" numeric(19,4) NOT NULL,
	"cogs_iqd" numeric(19,4) NOT NULL,
	-- The layer a transfer carried part of this one's stock to, if the share
	-- followed it there.
	"via_layer_id" uuid REFERENCES "cost_layer"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "landed_cost_layer_adjustment_amounts" CHECK (
		"allocated_iqd" >= 0 AND "on_hand_qty" >= 0 AND "inventory_iqd" >= 0 AND "cogs_iqd" >= 0
		AND "allocated_iqd" = "inventory_iqd" + "cogs_iqd"
		AND "unit_cost_after" >= "unit_cost_before"
	)
);
--> statement-breakpoint
CREATE INDEX "landed_cost_layer_adjustment_lock_idx" ON "landed_cost_layer_adjustment" ("lock_id");
--> statement-breakpoint
CREATE INDEX "landed_cost_layer_adjustment_layer_idx" ON "landed_cost_layer_adjustment" ("cost_layer_id");
--> statement-breakpoint
CREATE TRIGGER "landed_cost_layer_adjustment_append_only"
	BEFORE UPDATE OR DELETE ON "landed_cost_layer_adjustment"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint

-- The journal names its document type (§4.2's first layer of dimension rules).
INSERT INTO document_type (code, name, module, description) VALUES
	('landed_cost_lock', 'Landed Cost Lock', 'payables',
	 'REQ-AP-001 §20.2 — an import''s landed cost allocated to the stock it bought.')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Branch scope, through the import.
-- ---------------------------------------------------------------------------
ALTER TABLE landed_cost_lock ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE landed_cost_lock FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY landed_cost_lock_branch_scope ON landed_cost_lock
	USING (app_branch_allowed(branch_code)) WITH CHECK (app_branch_allowed(branch_code));
--> statement-breakpoint
ALTER TABLE landed_cost_layer_adjustment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE landed_cost_layer_adjustment FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY landed_cost_layer_adjustment_branch_scope ON landed_cost_layer_adjustment
	USING (
		app_is_super_user()
		OR EXISTS (SELECT 1 FROM payable p
		            WHERE p.id = landed_cost_layer_adjustment.payable_id
		              AND app_branch_allowed(p.branch_code))
	)
	WITH CHECK (
		app_is_super_user()
		OR EXISTS (SELECT 1 FROM payable p
		            WHERE p.id = landed_cost_layer_adjustment.payable_id
		              AND app_branch_allowed(p.branch_code))
	);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Permissions: the officer records a charge; the manager locks the cost.
-- ---------------------------------------------------------------------------
INSERT INTO role_grant (role_code, object, verb) VALUES
	('accounting_officer', 'landed_cost', 'view'),
	('accounting_officer', 'landed_cost', 'create'),
	('accounting_officer', 'landed_cost', 'edit_draft'),
	('accounting_manager', 'landed_cost', 'view'),
	('accounting_manager', 'landed_cost', 'create'),
	('accounting_manager', 'landed_cost', 'edit_draft'),
	('accounting_manager', 'landed_cost', 'post'),
	('accounting_manager', 'landed_cost', 'reverse_cancel'),
	('ceo',                'landed_cost', 'view')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	GRANT SELECT, INSERT, UPDATE ON landed_cost_basis            TO erp_app;
	-- Append-only records: no UPDATE, no DELETE.
	GRANT SELECT, INSERT         ON landed_cost_lock             TO erp_app;
	GRANT SELECT, INSERT         ON landed_cost_layer_adjustment TO erp_app;
END $$;
