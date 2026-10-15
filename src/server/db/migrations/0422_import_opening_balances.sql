-- 0422 — the imports brought in from the sheet, on the supplier's account
-- (2026-10-15, by direction).
--
-- The sheet import (13 Oct) wrote tracking only: imports, applications, PDs,
-- B/Ls, containers — no invoice, no journal. So every supplier screen that
-- reads the ledger (Supplier Statements, Payables Ageing, the reconciliation,
-- the supplier's profile) showed the 23 suppliers owing nothing, and a payment
-- confirmed on one of those imports had nothing to post against. The owner
-- chose to post: what each import still owed at the cut-over becomes a posted
-- purchase invoice of the supplier, marked as the import's opening balance —
-- Cr the supplier, Dr the goods in transit — owed, aged, stated and paid as
-- any bill. The import's own reads (its stage, its goods journey, its stored
-- figures) leave it out, because it is not the goods' invoice.
--
-- Posted by `services/import-opening-balance.ts` and nothing else.

ALTER TABLE "ap_invoice" ADD COLUMN "is_import_opening" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

-- An opening is an import's, and the import is its one application.
ALTER TABLE "ap_invoice" ADD CONSTRAINT "ap_invoice_import_opening_is_import" CHECK (
	NOT "is_import_opening" OR ("is_import" AND "payable_id" IS NOT NULL)
);
--> statement-breakpoint

-- One live opening per import: a second would count the same debt twice.
CREATE UNIQUE INDEX "ap_invoice_one_import_opening" ON "ap_invoice" ("payable_id")
	WHERE "is_import_opening" AND "reversed_at" IS NULL;
--> statement-breakpoint

-- What an invoice is does not change once written: an ordinary invoice cannot
-- become an opening, nor an opening an ordinary invoice.
CREATE OR REPLACE FUNCTION ap_invoice_import_opening_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.is_import_opening IS DISTINCT FROM OLD.is_import_opening THEN
		RAISE EXCEPTION 'Invoice % is % an import''s opening balance, and that is fixed when it is written.',
			OLD.invoice_no, CASE WHEN OLD.is_import_opening THEN '' ELSE 'not' END
			USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "ap_invoice_import_opening_fixed"
	BEFORE UPDATE OF "is_import_opening" ON "ap_invoice"
	FOR EACH ROW EXECUTE FUNCTION ap_invoice_import_opening_fixed();
--> statement-breakpoint

-- What the opening counted as owed and is not, each with its journal:
--   paid_before_cut_over  money the bank's copy shows left before the cut-over,
--                         on an application the sheet left "sent" — it comes
--                         off the opening;
--   absorbed_by_invoice   the supplier's own invoice for the import, posted
--                         later: the opening already holds that debt, so the
--                         invoice is settled by it and the supplier is not
--                         owed it twice. Undone (once) when that invoice is
--                         reversed.
CREATE TABLE "import_opening_settlement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ap_invoice_id" uuid NOT NULL REFERENCES "ap_invoice"("id"),
	"kind" text NOT NULL,
	"payment_application_id" uuid REFERENCES "payment_application"("id"),
	"absorbed_invoice_id" uuid REFERENCES "ap_invoice"("id"),
	"amount_txn" numeric(19, 4) NOT NULL,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"journal_entry_id" uuid NOT NULL REFERENCES "journal_entry"("id"),
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversed_by" uuid REFERENCES "app_user"("id"),
	"reversal_journal_entry_id" uuid REFERENCES "journal_entry"("id"),
	CONSTRAINT "import_opening_settlement_kind" CHECK (
		("kind" = 'paid_before_cut_over' AND "payment_application_id" IS NOT NULL AND "absorbed_invoice_id" IS NULL)
		OR ("kind" = 'absorbed_by_invoice' AND "absorbed_invoice_id" IS NOT NULL AND "payment_application_id" IS NULL)
	),
	CONSTRAINT "import_opening_settlement_positive" CHECK ("amount_iqd" > 0 AND "amount_txn" > 0),
	CONSTRAINT "import_opening_settlement_reversal_complete" CHECK (
		("reversed_at" IS NULL AND "reversed_by" IS NULL AND "reversal_journal_entry_id" IS NULL)
		OR ("reversed_at" IS NOT NULL AND "reversed_by" IS NOT NULL AND "reversal_journal_entry_id" IS NOT NULL)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "import_opening_settlement_application_uniq" ON "import_opening_settlement" ("payment_application_id")
	WHERE "payment_application_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "import_opening_settlement_absorbed_uniq" ON "import_opening_settlement" ("absorbed_invoice_id")
	WHERE "absorbed_invoice_id" IS NOT NULL AND "reversed_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "import_opening_settlement_invoice_idx" ON "import_opening_settlement" ("ap_invoice_id");
--> statement-breakpoint

-- Never deleted; never changed but for its reversal, once, and only an absorption's.
CREATE OR REPLACE FUNCTION import_opening_settlement_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'UPDATE'
	   AND OLD.kind = 'absorbed_by_invoice'
	   AND OLD.reversed_at IS NULL
	   AND NEW.reversed_at IS NOT NULL
	   AND NEW.id = OLD.id AND NEW.ap_invoice_id = OLD.ap_invoice_id AND NEW.kind = OLD.kind
	   AND NEW.payment_application_id IS NOT DISTINCT FROM OLD.payment_application_id
	   AND NEW.absorbed_invoice_id IS NOT DISTINCT FROM OLD.absorbed_invoice_id
	   AND NEW.amount_txn = OLD.amount_txn AND NEW.amount_iqd = OLD.amount_iqd
	   AND NEW.journal_entry_id = OLD.journal_entry_id
	   AND NEW.created_by = OLD.created_by AND NEW.created_at = OLD.created_at THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'An opening balance''s settlement is final; only an invoice''s absorption is undone, once, when that invoice is reversed.'
		USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "import_opening_settlement_frozen"
	BEFORE UPDATE OR DELETE ON "import_opening_settlement"
	FOR EACH ROW EXECUTE FUNCTION import_opening_settlement_frozen();
--> statement-breakpoint

ALTER TABLE "import_opening_settlement" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "import_opening_settlement" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY import_opening_settlement_branch_scope ON "import_opening_settlement"
	USING (app_is_super_user() OR EXISTS (SELECT 1 FROM ap_invoice i WHERE i.id = import_opening_settlement.ap_invoice_id AND app_branch_allowed(i.branch_code)))
	WITH CHECK (app_is_super_user() OR EXISTS (SELECT 1 FROM ap_invoice i WHERE i.id = import_opening_settlement.ap_invoice_id AND app_branch_allowed(i.branch_code)));
--> statement-breakpoint

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	GRANT SELECT, INSERT, UPDATE ON "import_opening_settlement" TO erp_app;
END $$;
--> statement-breakpoint

INSERT INTO payable_event_code (code, lane_code, name) VALUES
	('OPENING_BALANCE', 'payment', 'Opening balance posted'),
	('OPENING_SETTLED', 'payment', 'Opening balance settled before the cut-over'),
	('OPENING_ABSORBED', 'payment', 'Supplier invoice settled by the opening balance'),
	('OPENING_ABSORPTION_UNDONE', 'payment', 'Supplier invoice reversed; its settlement by the opening balance undone')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- The supplier's side posts where every purchase invoice's does. The goods'
-- side is the accountant's to map (Posting Mappings), as every new role is.
INSERT INTO posting_rule (event_type, line_role, account_id, is_active, created_by)
SELECT 'payables.import_opening_balance', r.line_role, r.account_id, true, r.created_by
  FROM posting_rule r
 WHERE r.event_type = 'purchasing.ap_invoice' AND r.line_role = 'supplier_payable'
   AND r.is_active
   AND r.item_group IS NULL AND r.partner_group IS NULL AND r.warehouse_code IS NULL
   AND r.project_code IS NULL AND r.branch_code IS NULL
ON CONFLICT DO NOTHING;
