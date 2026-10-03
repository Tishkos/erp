-- ===========================================================================
-- Payables — Stage 8, migration & go-live (REQ-AP-001 §24.3, §24.4).
-- HAND-AUTHORED. Everything additive; nothing posted changes meaning.
--
--   payable.legacy_cleared        the sheet's "Clear?" column, kept for the
--                                 §20.1 comparison the accountant signs off
--   payment_application.source    'erp' | 'sheet_import' (+ source_row): a
--                                 migrated SWIFT was confirmed before the ERP
--                                 knew it, so its proof is the sheet row, not
--                                 a document this system posted
--   payables_migration_run        every dry run and apply of the sheet, with
--                                 its report, and the accountant's sign-off
--   PD_LINKED                     a holding-list PD named to its import
--
-- Nothing here deletes. Re-running the import adds what is missing and
-- reports what was already there.
-- ===========================================================================

ALTER TABLE "payable" ADD COLUMN "legacy_cleared" boolean;
--> statement-breakpoint

ALTER TABLE "payment_application" ADD COLUMN "source" text NOT NULL DEFAULT 'erp';
--> statement-breakpoint
ALTER TABLE "payment_application" ADD COLUMN "source_row" text;
--> statement-breakpoint
ALTER TABLE "payment_application" ADD CONSTRAINT "payment_application_source_known" CHECK (
	"source" IN ('erp', 'sheet_import', 'shipment_migration')
);
--> statement-breakpoint
-- A confirmed application names the document that posted the money — unless
-- the money moved before the ERP existed and the sheet row is its record.
ALTER TABLE "payment_application" DROP CONSTRAINT "payment_application_confirmed_has_proof";
--> statement-breakpoint
ALTER TABLE "payment_application" ADD CONSTRAINT "payment_application_confirmed_has_proof" CHECK (
	"status" NOT IN ('confirmed', 'debited')
	OR ("confirmed_on" IS NOT NULL
		AND coalesce(btrim("confirmation_reference"), '') <> ''
		AND ("supplier_payment_id" IS NOT NULL OR "supplier_advance_id" IS NOT NULL OR "source" <> 'erp'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_application_source_row_uniq" ON "payment_application" ("source", "source_row")
	WHERE "source_row" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE "payables_migration_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"mode" text NOT NULL,
	"file_name" text NOT NULL,
	"file_sha256" text NOT NULL,
	"report" jsonb NOT NULL,
	"run_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"run_at" timestamptz NOT NULL DEFAULT now(),
	-- §20.1 — the accountant reads the cleared comparison and signs it off.
	"signed_off_by" uuid REFERENCES "app_user"("id"),
	"signed_off_at" timestamptz,
	"sign_off_note" text,
	CONSTRAINT "payables_migration_run_mode" CHECK ("mode" IN ('dry_run', 'apply')),
	CONSTRAINT "payables_migration_run_sign_off" CHECK (
		("signed_off_at" IS NULL AND "signed_off_by" IS NULL)
		OR ("mode" = 'apply' AND "signed_off_at" IS NOT NULL AND "signed_off_by" IS NOT NULL)
	)
);
--> statement-breakpoint
CREATE INDEX "payables_migration_run_file_idx" ON "payables_migration_run" ("file_sha256", "mode");
--> statement-breakpoint

-- The customs officer links a holding-list PD to its import (§24.3).
INSERT INTO payable_event_code (code, lane_code, name) VALUES
	('PD_LINKED', 'pd', 'PD linked from the holding list')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
	('accounting_manager',   'payables_migration', 'view'),
	('accounting_manager',   'payables_migration', 'import'),
	('accounting_manager',   'payables_migration', 'approve'),
	('system_administrator', 'payables_migration', 'view'),
	('system_administrator', 'payables_migration', 'import')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	-- A run is a record: inserted, signed off, never deleted.
	GRANT SELECT, INSERT, UPDATE ON payables_migration_run TO erp_app;
END $$;
