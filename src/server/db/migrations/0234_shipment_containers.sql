-- ===========================================================================
-- Payables — Stage 5, shipment & warehouse (REQ-AP-001 §17, §18, §21.9).
-- HAND-AUTHORED. Everything additive.
--
--   port                              ports of discharge (Aqaba, Umm Qasr …)
--   container_status                  not loaded · on the sea · at port ·
--                                     customs cleared · received · late ·
--                                     missing/damaged — with the flags the
--                                     rules read; editable (R4)
--   bill_of_lading                    unlimited per import
--   shipment_container                every container on its own: own ETA,
--                                     own dates, own status
--   shipment_container_status_history append-only
--   shipment_container_line           container × model: planned, received,
--                                     damaged, short
--   container_receipt (+ _line)       the receipt of one container into a
--                                     warehouse; its id is the form's
--                                     one-time document id (AGENTS.md)
--   warehouse                         the shipment-stage warehouses become
--                                     transit: owned, not available for sale
-- ===========================================================================

CREATE TABLE "port" (
	"code" text PRIMARY KEY,
	"name" text NOT NULL,
	"locode" text,
	"country" char(2),
	"active" boolean NOT NULL DEFAULT true,
	"created_by" uuid REFERENCES "app_user"("id"),
	CONSTRAINT "port_locode_shape" CHECK ("locode" IS NULL OR "locode" ~ '^[A-Z]{2}[A-Z0-9]{3}$')
);
--> statement-breakpoint
INSERT INTO "port" ("code", "name", "locode", "country") VALUES
	('PRT-0001', 'Umm Qasr', 'IQUQR', 'IQ'),
	('PRT-0002', 'Aqaba',    'JOAQJ', 'JO');
--> statement-breakpoint
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year) VALUES
	('PORT_CODE', 'PRT', '{PREFIX}-{SERIAL}', 4, false, false),
	('CONTAINER_RECEIPT', 'CREC', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
DO $$
DECLARE
	seq text := doc_sequence_name('PORT_CODE', '');
BEGIN
	IF to_regclass(seq) IS NULL THEN
		EXECUTE format('CREATE SEQUENCE %I START 1', seq);
	END IF;
	PERFORM setval(seq, 2, true);
END $$;
--> statement-breakpoint

CREATE TABLE "container_status" (
	"code" text PRIMARY KEY,
	"name" text NOT NULL,
	"sequence" smallint NOT NULL,
	"counts_as_received" boolean NOT NULL DEFAULT false,
	"is_exception" boolean NOT NULL DEFAULT false,
	"active" boolean NOT NULL DEFAULT true,
	"created_by" uuid REFERENCES "app_user"("id")
);
--> statement-breakpoint
INSERT INTO "container_status" ("code", "name", "sequence", "counts_as_received", "is_exception") VALUES
	('not_loaded',      'Not loaded',          1, false, false),
	('on_sea',          'On the sea',          2, false, false),
	('at_port',         'At port',             3, false, false),
	('customs_cleared', 'Customs cleared',     4, false, false),
	('received',        'Received',            5, true,  false),
	('late',            'Late — ETA passed',   6, false, true),
	('missing_damaged', 'Missing / damaged',   7, true,  true);
--> statement-breakpoint

CREATE TABLE "bill_of_lading" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"payable_id" uuid NOT NULL REFERENCES "payable"("id"),
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	"bl_no" text NOT NULL,
	"bl_date" date NOT NULL,
	"shipping_line" text,
	"vessel" text,
	"voyage" text,
	"port_of_loading" text,
	"port_of_discharge_code" text REFERENCES "port"("code"),
	"eta" date,
	"cancelled_at" timestamptz,
	"cancelled_by" uuid REFERENCES "app_user"("id"),
	"cancel_reason" text,
	"source" text NOT NULL DEFAULT 'erp',
	"source_row" text,
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "bill_of_lading_no_not_blank" CHECK (btrim("bl_no") <> ''),
	CONSTRAINT "bill_of_lading_cancel_has_reason" CHECK (
		"cancelled_at" IS NULL OR coalesce(btrim("cancel_reason"), '') <> ''
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bill_of_lading_no_uniq" ON "bill_of_lading" ("bl_no");
--> statement-breakpoint
CREATE INDEX "bill_of_lading_payable_idx" ON "bill_of_lading" ("payable_id");
--> statement-breakpoint

CREATE TABLE "shipment_container" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"bl_id" uuid NOT NULL REFERENCES "bill_of_lading"("id"),
	"payable_id" uuid NOT NULL REFERENCES "payable"("id"),
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	"container_no" text NOT NULL,
	"size_type" text,
	"status_code" text NOT NULL DEFAULT 'not_loaded' REFERENCES "container_status"("code"),
	"status_date" date,
	"eta" date,
	"departed_on" date,
	"arrived_port_on" date,
	"customs_cleared_on" date,
	"port_file_sent_on" date,
	"received_on" date,
	"warehouse_code" text REFERENCES "warehouse"("code"),
	"container_receipt_id" uuid,
	-- The B/L total spread over its containers when no detail was given —
	-- the warehouse confirms it (§24.3).
	"lines_estimated" boolean NOT NULL DEFAULT false,
	"cancelled_at" timestamptz,
	"cancelled_by" uuid REFERENCES "app_user"("id"),
	"cancel_reason" text,
	"source" text NOT NULL DEFAULT 'erp',
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	-- ISO 6346: owner code (3 letters + category letter) and 7 digits; a row
	-- migrated from the four-stage shipment carries MIGRATED-<invoice no>.
	CONSTRAINT "shipment_container_no_shape" CHECK (
		"container_no" ~ '^[A-Z]{4}[0-9]{7}$' OR "container_no" LIKE 'MIGRATED-%'
	),
	CONSTRAINT "shipment_container_cancel_has_reason" CHECK (
		"cancelled_at" IS NULL OR coalesce(btrim("cancel_reason"), '') <> ''
	),
	CONSTRAINT "shipment_container_received_has_receipt" CHECK (
		"received_on" IS NULL OR "container_receipt_id" IS NOT NULL OR "source" <> 'erp'
	)
);
--> statement-breakpoint
-- §17.2 — a number is on one live B/L at a time; once received it may recur
-- on a later import.
CREATE UNIQUE INDEX "shipment_container_live_no_uniq" ON "shipment_container" ("container_no")
	WHERE "received_on" IS NULL AND "cancelled_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "shipment_container_bl_idx" ON "shipment_container" ("bl_id");
--> statement-breakpoint
CREATE INDEX "shipment_container_payable_idx" ON "shipment_container" ("payable_id");
--> statement-breakpoint
CREATE INDEX "shipment_container_eta_idx" ON "shipment_container" ("eta") WHERE "received_on" IS NULL;
--> statement-breakpoint

CREATE TABLE "shipment_container_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"container_id" uuid NOT NULL REFERENCES "shipment_container"("id"),
	"status_code" text NOT NULL REFERENCES "container_status"("code"),
	"effective_date" date NOT NULL,
	"note" text,
	"source" text NOT NULL DEFAULT 'user',
	"recorded_by" uuid REFERENCES "app_user"("id"),
	"recorded_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
	CONSTRAINT "shipment_container_status_history_source" CHECK (
		"source" IN ('user', 'receipt', 'sweep', 'sheet_import', 'shipment_migration')
	)
);
--> statement-breakpoint
CREATE INDEX "shipment_container_status_history_idx" ON "shipment_container_status_history" ("container_id", "recorded_at");
--> statement-breakpoint
CREATE TRIGGER "shipment_container_status_history_append_only"
	BEFORE UPDATE OR DELETE ON "shipment_container_status_history"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint

CREATE TABLE "shipment_container_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"container_id" uuid NOT NULL REFERENCES "shipment_container"("id"),
	"line_no" integer NOT NULL,
	"item_code" text REFERENCES "item"("code"),
	"description" text NOT NULL,
	"planned_qty" numeric(24,6) NOT NULL,
	"uom_code" text REFERENCES "unit_of_measure"("code"),
	"received_qty" numeric(24,6),
	"damaged_qty" numeric(24,6),
	"short_qty" numeric(24,6),
	"warehouse_code" text REFERENCES "warehouse"("code"),
	"superseded_at" timestamptz,
	"superseded_by" uuid REFERENCES "app_user"("id"),
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "shipment_container_line_quantities" CHECK (
		"planned_qty" >= 0
		AND coalesce("received_qty", 0) >= 0
		AND coalesce("damaged_qty", 0) >= 0
		AND coalesce("short_qty", 0) >= 0
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_container_line_no_uniq" ON "shipment_container_line" ("container_id", "line_no")
	WHERE "superseded_at" IS NULL;
--> statement-breakpoint

CREATE TABLE "container_receipt" (
	-- The form's one-time document id (AGENTS.md): a repeated submit answers
	-- with this receipt instead of receiving the container twice.
	"id" uuid PRIMARY KEY,
	"receipt_no" text NOT NULL,
	"container_id" uuid NOT NULL REFERENCES "shipment_container"("id"),
	"payable_id" uuid NOT NULL REFERENCES "payable"("id"),
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	"warehouse_code" text NOT NULL REFERENCES "warehouse"("code"),
	"receipt_date" date NOT NULL,
	"variance_reason" text,
	"note" text,
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "container_receipt_no_uniq" ON "container_receipt" ("receipt_no");
--> statement-breakpoint
-- One receipt per container (§18).
CREATE UNIQUE INDEX "container_receipt_container_uniq" ON "container_receipt" ("container_id");
--> statement-breakpoint
ALTER TABLE "shipment_container"
	ADD CONSTRAINT "shipment_container_receipt_fk" FOREIGN KEY ("container_receipt_id") REFERENCES "container_receipt"("id");
--> statement-breakpoint

CREATE TABLE "container_receipt_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"receipt_id" uuid NOT NULL REFERENCES "container_receipt"("id"),
	"container_line_id" uuid NOT NULL REFERENCES "shipment_container_line"("id"),
	"line_no" integer NOT NULL,
	"item_code" text REFERENCES "item"("code"),
	"planned_qty" numeric(24,6) NOT NULL,
	"received_qty" numeric(24,6) NOT NULL,
	"damaged_qty" numeric(24,6) NOT NULL DEFAULT 0,
	"short_qty" numeric(24,6) NOT NULL DEFAULT 0,
	-- What the ledger moved into the warehouse (the received quantity, when
	-- the invoice's goods were standing in transit).
	"moved_qty" numeric(24,6) NOT NULL DEFAULT 0,
	"cost_iqd" numeric(19,4) NOT NULL DEFAULT 0,
	CONSTRAINT "container_receipt_line_quantities" CHECK (
		"received_qty" >= 0 AND "damaged_qty" >= 0 AND "short_qty" >= 0 AND "moved_qty" >= 0
	)
);
--> statement-breakpoint
CREATE INDEX "container_receipt_line_receipt_idx" ON "container_receipt_line" ("receipt_id");
--> statement-breakpoint
-- A receipt is the record of what arrived: never edited, never deleted.
CREATE TRIGGER "container_receipt_append_only"
	BEFORE UPDATE OR DELETE ON "container_receipt"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint
CREATE TRIGGER "container_receipt_line_append_only"
	BEFORE UPDATE OR DELETE ON "container_receipt_line"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §17.4 — goods at sea are owned, not available: the shipment-stage
-- warehouses are transit warehouses.
-- ---------------------------------------------------------------------------
UPDATE "warehouse" SET "warehouse_type" = 'transit', "is_transit" = true
 WHERE "shipment_stage" IS NOT NULL AND "warehouse_type" <> 'transit';
--> statement-breakpoint

-- A receipt that differs from the plan opens a claim on the import (§18). It
-- is opened by the receipt itself, not by a clock.
INSERT INTO sweep_check (code, name, lane_code, active) VALUES
	('receipt_variance', 'Container received short or damaged — claim', 'warehouse', false)
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Branch scope.
-- ---------------------------------------------------------------------------
ALTER TABLE bill_of_lading ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE bill_of_lading FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY bill_of_lading_branch_scope ON bill_of_lading
	USING (app_branch_allowed(branch_code)) WITH CHECK (app_branch_allowed(branch_code));
--> statement-breakpoint
ALTER TABLE shipment_container ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE shipment_container FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY shipment_container_branch_scope ON shipment_container
	USING (app_branch_allowed(branch_code)) WITH CHECK (app_branch_allowed(branch_code));
--> statement-breakpoint
ALTER TABLE container_receipt ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE container_receipt FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY container_receipt_branch_scope ON container_receipt
	USING (app_branch_allowed(branch_code)) WITH CHECK (app_branch_allowed(branch_code));
--> statement-breakpoint
ALTER TABLE shipment_container_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE shipment_container_line FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY shipment_container_line_branch_scope ON shipment_container_line
	USING (app_is_super_user() OR EXISTS (SELECT 1 FROM shipment_container c
	        WHERE c.id = shipment_container_line.container_id AND app_branch_allowed(c.branch_code)))
	WITH CHECK (app_is_super_user() OR EXISTS (SELECT 1 FROM shipment_container c
	        WHERE c.id = shipment_container_line.container_id AND app_branch_allowed(c.branch_code)));
--> statement-breakpoint
ALTER TABLE shipment_container_status_history ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE shipment_container_status_history FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY shipment_container_status_history_branch_scope ON shipment_container_status_history
	USING (app_is_super_user() OR EXISTS (SELECT 1 FROM shipment_container c
	        WHERE c.id = shipment_container_status_history.container_id AND app_branch_allowed(c.branch_code)))
	WITH CHECK (app_is_super_user() OR EXISTS (SELECT 1 FROM shipment_container c
	        WHERE c.id = shipment_container_status_history.container_id AND app_branch_allowed(c.branch_code)));
--> statement-breakpoint
ALTER TABLE container_receipt_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE container_receipt_line FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY container_receipt_line_branch_scope ON container_receipt_line
	USING (app_is_super_user() OR EXISTS (SELECT 1 FROM container_receipt r
	        WHERE r.id = container_receipt_line.receipt_id AND app_branch_allowed(r.branch_code)))
	WITH CHECK (app_is_super_user() OR EXISTS (SELECT 1 FROM container_receipt r
	        WHERE r.id = container_receipt_line.receipt_id AND app_branch_allowed(r.branch_code)));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Permissions — D1: the logistics officer follows the containers; the
-- accounting officer holds the role's grants until users are assigned; the
-- warehouse receives (the existing goods-receipt grants decide who).
-- ---------------------------------------------------------------------------
INSERT INTO role_grant (role_code, object, verb) VALUES
	('logistics_officer',  'bill_of_lading',     'view'),
	('logistics_officer',  'bill_of_lading',     'create'),
	('logistics_officer',  'bill_of_lading',     'edit_draft'),
	('logistics_officer',  'shipment_container', 'view'),
	('logistics_officer',  'shipment_container', 'edit_draft'),
	('accounting_officer', 'bill_of_lading',     'view'),
	('accounting_officer', 'bill_of_lading',     'create'),
	('accounting_officer', 'bill_of_lading',     'edit_draft'),
	('accounting_officer', 'shipment_container', 'view'),
	('accounting_officer', 'shipment_container', 'edit_draft'),
	('accounting_officer', 'shipment_container', 'execute'),
	('accounting_manager', 'bill_of_lading',     'view'),
	('accounting_manager', 'bill_of_lading',     'create'),
	('accounting_manager', 'bill_of_lading',     'edit_draft'),
	('accounting_manager', 'bill_of_lading',     'reverse_cancel'),
	('accounting_manager', 'shipment_container', 'view'),
	('accounting_manager', 'shipment_container', 'edit_draft'),
	('accounting_manager', 'shipment_container', 'execute'),
	('accounting_manager', 'shipment_container', 'reverse_cancel'),
	('customs_officer',    'bill_of_lading',     'view'),
	('customs_officer',    'shipment_container', 'view'),
	('customs_officer',    'shipment_container', 'edit_draft'),
	('ceo',                'bill_of_lading',     'view'),
	('ceo',                'shipment_container', 'view')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	GRANT SELECT, INSERT, UPDATE ON port                              TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON container_status                  TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON bill_of_lading                    TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON shipment_container                TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON shipment_container_line           TO erp_app;
	GRANT SELECT, INSERT         ON shipment_container_status_history TO erp_app;
	GRANT SELECT, INSERT         ON container_receipt                 TO erp_app;
	GRANT SELECT, INSERT         ON container_receipt_line            TO erp_app;
END $$;
