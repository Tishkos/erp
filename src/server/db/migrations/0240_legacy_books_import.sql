-- ===========================================================================
-- REQ-LEGACY-001 — the legacy books import (2026-10-02).
--
-- The accountant's old system is exported as ten workbooks: the partners
-- with their balances in dinars and dollars, the stock by warehouse, and
-- the registers of sales, purchases, receipts and payments. The import
-- creates the partners, items and warehouses the ERP does not have, posts
-- the partners' balances as the opening position, raises the opening stock
-- for review, and keeps every old document as read-only history linked to
-- its partner.
--
--   legacy_import_run   every dry run and apply, with its report
--   legacy_document     the old registers, one row per line
--
-- The opening position posts under its own event, legacy.opening_balance,
-- whose three roles already exist on other documents; the rules are copied
-- from them so a live system needs no new mapping before the first apply.
-- ===========================================================================

CREATE TABLE "legacy_import_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"mode" text NOT NULL,
	"file_names" jsonb NOT NULL,
	"set_sha256" text NOT NULL,
	"cut_over_date" date NOT NULL,
	"report" jsonb NOT NULL,
	"run_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"run_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "legacy_import_run_mode" CHECK ("mode" IN ('dry_run', 'apply'))
);--> statement-breakpoint
CREATE INDEX "legacy_import_run_set_idx" ON "legacy_import_run" ("set_sha256", "mode");--> statement-breakpoint

CREATE TABLE "legacy_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"kind" text NOT NULL,
	"legacy_no" text NOT NULL,
	"line_no" integer NOT NULL DEFAULT 1,
	"legacy_account_no" text,
	"party_name" text NOT NULL,
	"partner_id" uuid REFERENCES "business_partner"("id"),
	"document_date" date,
	"item_name" text,
	"quantity" text,
	"unit" text,
	"unit_cost_iqd" text,
	"unit_price_iqd" text,
	"amount" text,
	"currency" text,
	"operation" text,
	"source_file" text NOT NULL,
	"source_row" integer NOT NULL,
	"import_run_id" uuid NOT NULL REFERENCES "legacy_import_run"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "legacy_document_kind" CHECK ("kind" IN ('sale', 'purchase', 'receipt', 'payment'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_document_key_uniq" ON "legacy_document" ("kind", "legacy_no", "line_no", "source_row");--> statement-breakpoint
CREATE INDEX "legacy_document_partner_idx" ON "legacy_document" ("partner_id", "kind");--> statement-breakpoint
CREATE INDEX "legacy_document_account_idx" ON "legacy_document" ("legacy_account_no");--> statement-breakpoint

-- History is read by whoever may read the partner; written only by the import.
ALTER TABLE "legacy_import_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legacy_import_run" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY legacy_import_run_scope ON "legacy_import_run" USING (app_signed_in()) WITH CHECK (app_signed_in());--> statement-breakpoint
ALTER TABLE "legacy_document" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "legacy_document" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY legacy_document_scope ON "legacy_document" USING (app_signed_in()) WITH CHECK (app_signed_in());--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	-- Runs and history are records: inserted (a run completes its own report), never deleted.
	GRANT SELECT, INSERT, UPDATE ON legacy_import_run TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON legacy_document TO erp_app;
END $$;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
	('accounting_manager',   'legacy_import', 'view'),
	('accounting_manager',   'legacy_import', 'import'),
	('system_administrator', 'legacy_import', 'view'),
	('system_administrator', 'legacy_import', 'import')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- The opening position's rules, copied from the documents that already map
-- the same roles: the customer and supplier control accounts from the two
-- invoices, the equity side from Opening Stock.
INSERT INTO posting_rule (event_type, line_role, account_id, is_active, created_by)
SELECT 'legacy.opening_balance', r.line_role, r.account_id, true, r.created_by
  FROM posting_rule r
 WHERE ((r.event_type = 'sales.ar_invoice' AND r.line_role = 'customer_receivable')
    OR (r.event_type = 'purchasing.ap_invoice' AND r.line_role = 'supplier_payable')
    OR (r.event_type = 'inventory.opening_stock' AND r.line_role = 'opening_balance'))
   AND r.is_active
   AND r.item_group IS NULL AND r.partner_group IS NULL AND r.warehouse_code IS NULL
   AND r.project_code IS NULL AND r.branch_code IS NULL
ON CONFLICT DO NOTHING;
