-- REQ-FIX-001 FIX-3 — the import and its invoices agree.
--
-- (1) The exchange difference of an import agreed in a foreign currency and
--     invoiced in dinars, booked once it is fully paid in its currency (FX8):
--     one row per document it closes, append-only, under the import's branch.
-- (2) The posting events the supplier advance has always posted under but
--     the Posting Mappings screen never listed, so Finance could not map them
--     and a deposit could not post: their supplier-payable line copied from
--     the purchase invoice's rule. The advance and bank lines, and the
--     exchange gain and loss, are Finance's to map; a posting that needs an
--     unmapped one refuses with its name.

CREATE TABLE "payable_exchange_difference" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payable_id" uuid NOT NULL REFERENCES "payable"("id"),
	"kind" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"source_no" text NOT NULL,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"journal_entry_id" uuid NOT NULL REFERENCES "journal_entry"("id"),
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payable_exchange_difference_kind" CHECK ("kind" in ('gain', 'loss')),
	CONSTRAINT "payable_exchange_difference_source" CHECK ("source_type" in ('ap_invoice', 'supplier_payment', 'supplier_advance')),
	CONSTRAINT "payable_exchange_difference_positive" CHECK ("amount_iqd" > 0)
);--> statement-breakpoint
CREATE INDEX "payable_exchange_difference_payable_idx" ON "payable_exchange_difference" USING btree ("payable_id");--> statement-breakpoint
CREATE INDEX "payable_exchange_difference_journal_idx" ON "payable_exchange_difference" USING btree ("journal_entry_id");--> statement-breakpoint

ALTER TABLE "payable_exchange_difference" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payable_exchange_difference" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY payable_exchange_difference_branch_scope ON "payable_exchange_difference"
	USING (app_is_super_user() OR EXISTS (SELECT 1 FROM payable p WHERE p.id = payable_exchange_difference.payable_id AND app_branch_allowed(p.branch_code)))
	WITH CHECK (app_is_super_user() OR EXISTS (SELECT 1 FROM payable p WHERE p.id = payable_exchange_difference.payable_id AND app_branch_allowed(p.branch_code)));--> statement-breakpoint

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	GRANT SELECT, INSERT ON "payable_exchange_difference" TO erp_app;
END $$;--> statement-breakpoint

INSERT INTO payable_event_code (code, lane_code, name) VALUES
	('EXCHANGE_DIFFERENCE', 'payment', 'Exchange difference')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
	('payable_exchange_difference', 'Import exchange difference', 'payables', 'The dinars an import agreed in a foreign currency closes on once it is fully paid in that currency: what its invoices still owed (a gain) or what was paid over them (a loss) (REQ-FIX-001 FX8).')
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

INSERT INTO posting_rule (event_type, line_role, account_id, is_active, created_by)
SELECT e.event_type, 'supplier_payable', r.account_id, true, r.created_by
  FROM posting_rule r
 CROSS JOIN (VALUES ('purchasing.supplier_advance_settlement'), ('payables.exchange_difference')) AS e(event_type)
 WHERE r.event_type = 'purchasing.ap_invoice' AND r.line_role = 'supplier_payable'
   AND r.is_active
   AND r.item_group IS NULL AND r.partner_group IS NULL AND r.warehouse_code IS NULL
   AND r.project_code IS NULL AND r.branch_code IS NULL
ON CONFLICT DO NOTHING;
