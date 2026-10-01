-- ===========================================================================
-- Payables — D12 / D13 (REQ-AP-001 §8, §21.2, §28): the import is born at the
-- purchase invoice, and expenses are purchase invoices.
-- HAND-AUTHORED. Everything additive; nothing posted changes meaning.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- D13 — the accountant enters the supplier's PDF as a purchase invoice and
-- ticks Import; the application is created behind it. The tick is a fact of
-- the invoice, so it lives on the invoice.
-- ---------------------------------------------------------------------------
ALTER TABLE "ap_invoice" ADD COLUMN "is_import" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- An import invoice always has its application; the application is what the
-- tick means. (Nullable payable_id stays for every other invoice.)
ALTER TABLE "ap_invoice" ADD CONSTRAINT "ap_invoice_import_has_application" CHECK (
	NOT "is_import" OR "payable_id" IS NOT NULL
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- D12 — the rent, the forwarder, the broker, the utility bill are purchase
-- invoices. The type of fee is the expense category; a contract period is an
-- invoice that knows its contract and its period.
-- ---------------------------------------------------------------------------
ALTER TABLE "ap_invoice" ADD COLUMN "expense_category_code" text REFERENCES "expense_category"("code");
--> statement-breakpoint
ALTER TABLE "ap_invoice" ADD COLUMN "recurring_contract_id" uuid REFERENCES "recurring_contract"("id");
--> statement-breakpoint
ALTER TABLE "ap_invoice" ADD COLUMN "period_start" date;
--> statement-breakpoint
ALTER TABLE "ap_invoice" ADD COLUMN "period_end" date;
--> statement-breakpoint
-- One invoice per contract per period, ever — the generator is idempotent by
-- construction, not by care.
CREATE UNIQUE INDEX "ap_invoice_contract_period_uniq" ON "ap_invoice" ("recurring_contract_id", "period_start")
	WHERE "recurring_contract_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "ap_invoice_expense_category_idx" ON "ap_invoice" ("expense_category_code")
	WHERE "expense_category_code" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "ap_invoice_is_import_idx" ON "ap_invoice" ("is_import") WHERE "is_import";
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- D12 — "Overdue — add a note". The note is the whole of "where is it stopped
-- and why" for an expense: a dated, signed line that is never edited.
-- ---------------------------------------------------------------------------
CREATE TABLE "ap_invoice_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"ap_invoice_id" uuid NOT NULL REFERENCES "ap_invoice"("id"),
	"note" text NOT NULL,
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
	CONSTRAINT "ap_invoice_note_not_blank" CHECK (btrim("note") <> '')
);
--> statement-breakpoint
CREATE INDEX "ap_invoice_note_invoice_idx" ON "ap_invoice_note" ("ap_invoice_id", "created_at");
--> statement-breakpoint
CREATE TRIGGER "ap_invoice_note_append_only"
	BEFORE UPDATE OR DELETE ON "ap_invoice_note"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		GRANT SELECT, INSERT ON "ap_invoice_note" TO erp_app;
	END IF;
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- D12 / D13 — the payable record is for imports. The other types stay as rows
-- (nothing is deleted, R3) but are no longer offered: an expense is an
-- invoice, a rent is a contract's invoice, local goods are a PO's invoice, an
-- advance is a supplier advance.
-- ---------------------------------------------------------------------------
UPDATE "payable_type" SET "active" = false
	WHERE "code" IN ('service', 'recurring', 'local_goods', 'advance');
--> statement-breakpoint

-- The two checks that watched service / recurring payables have nothing left
-- to watch: an overdue expense is a red row on Purchase Invoices (D12), and
-- the existing due-notices sweep already notifies on it. The rows stay
-- (history, settings continuity) and are switched off.
UPDATE "sweep_check" SET "active" = false WHERE "code" IN ('service_unconfirmed', 'recurring_overdue');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- D12 — the §15 non-PO rule gains exactly one route: an expense. It still
-- states why (the justification is required and names the type of fee), and
-- its second person is the one who posts it — posting needs `approve` and
-- `post`, which the raiser does not hold. Same reasoning as 0196's own-stock
-- invoice. Nothing that was refused before is refused less on any other path.
-- ---------------------------------------------------------------------------
ALTER TABLE "ap_invoice" DROP CONSTRAINT IF EXISTS "ap_invoice_non_po_needs_justification";
--> statement-breakpoint
ALTER TABLE "ap_invoice"
  ADD CONSTRAINT "ap_invoice_non_po_needs_justification"
  CHECK (
    "purchase_order_id" IS NOT NULL
    OR "receives_own_stock"
    OR (
      coalesce(btrim("non_po_justification"), '') <> ''
      AND "non_po_approved_by" IS NOT NULL
      AND "non_po_approved_at" IS NOT NULL
    )
    OR (
      "expense_category_code" IS NOT NULL
      AND coalesce(btrim("non_po_justification"), '') <> ''
    )
  );
