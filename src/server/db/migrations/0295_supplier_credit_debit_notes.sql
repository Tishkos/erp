-- REQ-PAY-001 PAY8 / PAY9 — supplier credit notes without a return, the
-- credit's applications, the memo bug's correction, and the debit note.
--
-- ── PAY8: a credit note stands on its own ────────────────────────────────
-- Until now a `supplier_credit_memo` existed only behind a goods return. A
-- supplier also credits a price, a rebate or a damaged delivery it does not
-- want back, and that credit had nowhere to go. The return link becomes
-- optional; the invoice link stays required (a credit note is against an
-- invoice). A standalone note is raised as a draft, approved by somebody other
-- than its raiser (the super user excepted, as everywhere since 0278) and
-- posted: Dr Supplier A/P / Cr the account it names, purchase variance when it
-- names none (D-PAY-3). What it credits beyond what the invoice still owes
-- stays on the supplier's account as an unapplied credit, applied later.
--
-- ── Where a credit went: supplier_credit_application ────────────────────
-- One row per piece of a credit put against an invoice. `allocated_amount_iqd`
-- on the memo is their sum; the invoice's `settled_amount_iqd` carries each.
--
-- ── The bug, and its correction ─────────────────────────────────────────
-- `goods-return.creditMemo` added the memo to the invoice's settled amount and
-- left `allocated_amount_iqd` at 0, so `supplier-payment.supplierAccount`
-- counted the same money a second time as an unapplied credit. Every memo it
-- wrote was applied in full to its invoice (the invoice's CHECK refuses
-- settling past the total, so a larger one could not have been written). The
-- correction says so: allocated = amount, and the application row each one
-- should have had, dated when it posted. Run as the super user for this one
-- statement, so the branch policies do not hide rows from the owner where it
-- is not a superuser; the flag is cleared straight after.
--
-- ── PAY9: a debit note is a purchase invoice (D-PAY-2) ──────────────────
-- `ap_invoice.adjusts_invoice_id` names the invoice it adjusts. It is
-- approved, posted, aged, stated and paid like any bill. Its §15 evidence is
-- the invoice it adjusts and the reason written on it; its second person is the
-- one who posts it — the reasoning 0231 gave the expense.

ALTER TABLE "supplier_credit_memo" ALTER COLUMN "goods_return_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "supplier_credit_memo"
	ADD COLUMN IF NOT EXISTS "credit_account_id" uuid REFERENCES "chart_of_account"("id"),
	ADD COLUMN IF NOT EXISTS "approved_by" uuid REFERENCES "app_user"("id"),
	ADD COLUMN IF NOT EXISTS "approved_at" timestamptz,
	ADD COLUMN IF NOT EXISTS "reversed_by" uuid REFERENCES "app_user"("id"),
	ADD COLUMN IF NOT EXISTS "reversed_at" timestamptz,
	ADD COLUMN IF NOT EXISTS "reversal_reason" text,
	ADD COLUMN IF NOT EXISTS "reversal_journal_entry_id" uuid REFERENCES "journal_entry"("id");
--> statement-breakpoint

-- C-41-style four eyes: approved by somebody other than the raiser, unless the
-- approver is the super user (0278's function).
ALTER TABLE "supplier_credit_memo" DROP CONSTRAINT IF EXISTS "supplier_credit_memo_four_eyes";
--> statement-breakpoint
ALTER TABLE "supplier_credit_memo" ADD CONSTRAINT "supplier_credit_memo_four_eyes"
	CHECK ("approved_by" IS NULL OR "approved_by" <> "created_by" OR app_user_is_super("approved_by"));
--> statement-breakpoint
ALTER TABLE "supplier_credit_memo" DROP CONSTRAINT IF EXISTS "supplier_credit_memo_reversal_has_reason";
--> statement-breakpoint
ALTER TABLE "supplier_credit_memo" ADD CONSTRAINT "supplier_credit_memo_reversal_has_reason"
	CHECK (
		("reversed_by" IS NULL AND "reversed_at" IS NULL)
		OR ("reversed_by" IS NOT NULL AND "reversed_at" IS NOT NULL
			AND coalesce(btrim("reversal_reason"), '') <> '')
	);
--> statement-breakpoint
-- A credit note with no return says why it was raised.
ALTER TABLE "supplier_credit_memo" DROP CONSTRAINT IF EXISTS "supplier_credit_memo_standalone_has_reason";
--> statement-breakpoint
ALTER TABLE "supplier_credit_memo" ADD CONSTRAINT "supplier_credit_memo_standalone_has_reason"
	CHECK ("goods_return_id" IS NOT NULL OR coalesce(btrim("note"), '') <> '');
--> statement-breakpoint

-- A posted memo is final: what it credited, to whom, when and where is
-- corrected by reversing it, never by editing it. What may still move is how
-- much of it has been applied, and the reversal itself.
CREATE OR REPLACE FUNCTION supplier_credit_memo_posted_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.status NOT IN ('posted', 'settled', 'reversed') THEN
		RETURN NEW;
	END IF;
	IF NEW.supplier_id       IS DISTINCT FROM OLD.supplier_id
	OR NEW.ap_invoice_id     IS DISTINCT FROM OLD.ap_invoice_id
	OR NEW.goods_return_id   IS DISTINCT FROM OLD.goods_return_id
	OR NEW.branch_code       IS DISTINCT FROM OLD.branch_code
	OR NEW.memo_date         IS DISTINCT FROM OLD.memo_date
	OR NEW.amount_iqd        IS DISTINCT FROM OLD.amount_iqd
	OR NEW.credit_account_id IS DISTINCT FROM OLD.credit_account_id
	OR NEW.journal_entry_id  IS DISTINCT FROM OLD.journal_entry_id
	OR (OLD.status = 'reversed' AND NEW.status IS DISTINCT FROM OLD.status) THEN
		RAISE EXCEPTION
			'Credit memo % has posted to the supplier ledger and the General Ledger. Reverse it; it is not edited.',
			OLD.memo_no USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "supplier_credit_memo_posted_is_final" ON "supplier_credit_memo";
--> statement-breakpoint
CREATE TRIGGER "supplier_credit_memo_posted_is_final"
	BEFORE UPDATE ON "supplier_credit_memo"
	FOR EACH ROW EXECUTE FUNCTION supplier_credit_memo_posted_is_final();
--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
	('supplier_credit_memo', 'draft', 'cancelled')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- A supplier's credit belongs to no department: the variance account it
-- credits is an expense, which asks for one by type default (§4.2), and the
-- note has none to give. The same answer 0279 gave the loan.
INSERT INTO document_type_dimension (document_type_code, dimension, requirement) VALUES
	('supplier_credit_memo', 'department', 'optional'),
	('supplier_credit_memo', 'business_line', 'optional')
ON CONFLICT (document_type_code, dimension) DO UPDATE SET requirement = 'optional';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "supplier_credit_application" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_credit_memo_id" uuid NOT NULL REFERENCES "supplier_credit_memo"("id"),
	"ap_invoice_id" uuid NOT NULL REFERENCES "ap_invoice"("id"),
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	"amount_iqd" numeric(19, 4) NOT NULL,
	"applied_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"applied_at" timestamptz DEFAULT now() NOT NULL,
	"reversed_by" uuid REFERENCES "app_user"("id"),
	"reversed_at" timestamptz,
	"reversal_reason" text,
	CONSTRAINT "supplier_credit_application_amount_positive" CHECK ("amount_iqd" > 0),
	CONSTRAINT "supplier_credit_application_reversal_complete" CHECK (
		("reversed_by" IS NULL AND "reversed_at" IS NULL)
		OR ("reversed_by" IS NOT NULL AND "reversed_at" IS NOT NULL
			AND coalesce(btrim("reversal_reason"), '') <> '')
	)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_credit_application_memo_idx" ON "supplier_credit_application" ("supplier_credit_memo_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "supplier_credit_application_invoice_idx" ON "supplier_credit_application" ("ap_invoice_id");
--> statement-breakpoint

-- An application is a fact: never deleted, and changed only once — when it is
-- undone, by naming who, when and why.
CREATE OR REPLACE FUNCTION supplier_credit_application_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'A credit application is a record; it is undone by reversing it, not deleted.'
			USING ERRCODE = 'restrict_violation';
	END IF;
	IF OLD.reversed_at IS NOT NULL
	OR NEW.supplier_credit_memo_id IS DISTINCT FROM OLD.supplier_credit_memo_id
	OR NEW.ap_invoice_id  IS DISTINCT FROM OLD.ap_invoice_id
	OR NEW.branch_code    IS DISTINCT FROM OLD.branch_code
	OR NEW.amount_iqd     IS DISTINCT FROM OLD.amount_iqd
	OR NEW.applied_by     IS DISTINCT FROM OLD.applied_by
	OR NEW.applied_at     IS DISTINCT FROM OLD.applied_at THEN
		RAISE EXCEPTION 'A credit application is final; only its reversal is recorded on it, once.'
			USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "supplier_credit_application_frozen" ON "supplier_credit_application";
--> statement-breakpoint
CREATE TRIGGER "supplier_credit_application_frozen"
	BEFORE UPDATE OR DELETE ON "supplier_credit_application"
	FOR EACH ROW EXECUTE FUNCTION supplier_credit_application_frozen();
--> statement-breakpoint

ALTER TABLE "supplier_credit_application" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "supplier_credit_application" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "supplier_credit_application_branch_scope" ON "supplier_credit_application";
--> statement-breakpoint
CREATE POLICY "supplier_credit_application_branch_scope" ON "supplier_credit_application"
	USING (app_branch_allowed(branch_code))
	WITH CHECK (app_branch_allowed(branch_code));
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		GRANT SELECT, INSERT, UPDATE ON "supplier_credit_application" TO "erp_app";
	END IF;
END;
$$;
--> statement-breakpoint

-- The correction. Every memo the return route wrote was applied whole to its
-- invoice; the column and the application row now say so.
SELECT set_config('app.is_super_user', 'true', true);
--> statement-breakpoint
INSERT INTO "supplier_credit_application"
	("supplier_credit_memo_id", "ap_invoice_id", "branch_code", "amount_iqd", "applied_by", "applied_at")
SELECT m.id, m.ap_invoice_id, m.branch_code, m.amount_iqd,
       coalesce(m.posted_by, m.created_by), coalesce(m.posted_at, m.created_at)
  FROM "supplier_credit_memo" m
 WHERE m.goods_return_id IS NOT NULL
   AND m.status = 'posted'
   AND m.allocated_amount_iqd = 0
   AND NOT EXISTS (SELECT 1 FROM "supplier_credit_application" a WHERE a.supplier_credit_memo_id = m.id);
--> statement-breakpoint
UPDATE "supplier_credit_memo"
   SET "allocated_amount_iqd" = "amount_iqd"
 WHERE "goods_return_id" IS NOT NULL
   AND "status" = 'posted'
   AND "allocated_amount_iqd" = 0;
--> statement-breakpoint
SELECT set_config('app.is_super_user', '', true);
--> statement-breakpoint

-- PAY9 — the debit note.
ALTER TABLE "ap_invoice" ADD COLUMN IF NOT EXISTS "adjusts_invoice_id" uuid REFERENCES "ap_invoice"("id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ap_invoice_adjusts_idx" ON "ap_invoice" ("adjusts_invoice_id");
--> statement-breakpoint
ALTER TABLE "ap_invoice" DROP CONSTRAINT IF EXISTS "ap_invoice_adjusts_another";
--> statement-breakpoint
ALTER TABLE "ap_invoice" ADD CONSTRAINT "ap_invoice_adjusts_another"
	CHECK ("adjusts_invoice_id" IS NULL OR "adjusts_invoice_id" <> "id");
--> statement-breakpoint
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
		OR (
			"adjusts_invoice_id" IS NOT NULL
			AND coalesce(btrim("non_po_justification"), '') <> ''
		)
	);
--> statement-breakpoint

-- What a posted invoice says is final (0037); the invoice a debit note adjusts
-- is part of what it says.
CREATE OR REPLACE FUNCTION ap_invoice_posted_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status NOT IN ('posted', 'partially_executed', 'settled') THEN
    RETURN NEW;
  END IF;

  IF NEW.supplier_id          IS DISTINCT FROM OLD.supplier_id
  OR NEW.supplier_invoice_no  IS DISTINCT FROM OLD.supplier_invoice_no
  OR NEW.purchase_order_id    IS DISTINCT FROM OLD.purchase_order_id
  OR NEW.invoice_date         IS DISTINCT FROM OLD.invoice_date
  OR NEW.branch_code          IS DISTINCT FROM OLD.branch_code
  OR NEW.currency             IS DISTINCT FROM OLD.currency
  OR NEW.total_iqd            IS DISTINCT FROM OLD.total_iqd
  OR NEW.journal_entry_id     IS DISTINCT FROM OLD.journal_entry_id
  OR NEW.adjusts_invoice_id   IS DISTINCT FROM OLD.adjusts_invoice_id THEN
    RAISE EXCEPTION
      'Invoice % has posted to the supplier ledger and the General Ledger (blueprint 3.2). Reverse it; it is not edited.',
      OLD.invoice_no USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- PAY4 — the purchase documents that gained a print model are printed by
-- whoever reads them; the manager also takes the workbook.
INSERT INTO role_grant (role_code, object, verb) VALUES
	('accounting_officer', 'purchase_order', 'print'),
	('accounting_manager', 'purchase_order', 'print'),
	('accounting_officer', 'recurring_contract', 'print'),
	('accounting_manager', 'recurring_contract', 'print'),
	('accounting_manager', 'recurring_contract', 'export'),
	('accounting_officer', 'supplier_credit_memo', 'print'),
	('accounting_manager', 'supplier_credit_memo', 'print')
ON CONFLICT DO NOTHING;
