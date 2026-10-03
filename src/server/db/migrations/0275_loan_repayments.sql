-- What was actually repaid, and the status that follows from it.
--
-- By direction, 2026-10-03: "don't use 'fully repaid' based only on the number
-- of payments… the company could make an early payment, make a partial
-- payment, overpay, miss an instalment, pay additional principal, have bank
-- fees outstanding. Your system should calculate the status from actual posted
-- transactions."
--
-- It did not. `fully_repaid` was reached when no instalment row was left
-- unpaid — a count, not a balance. A loan whose principal was repaid early sat
-- `active` with rows nobody would ever pay; a loan with an instalment marked
-- paid but nothing posted would have read as settled.
--
-- `bank_loan_repayment` is the ledger the status is read from: one row per
-- posted repayment, saying what of it went to principal, to interest and to
-- fees, with the journal that posted it. An instalment payment writes one; so
-- does an extra payment of principal, and so does an early settlement. The
-- outstanding principal is the loan's principal less the principal on these
-- rows, and nothing else — not a count of instalments, not a status somebody
-- typed.
--
-- Append-only by trigger, like every other ledger here: a repayment that was
-- wrong is reversed by its journal and a correcting row, never edited away.

CREATE TABLE IF NOT EXISTS "bank_loan_repayment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_id" uuid NOT NULL REFERENCES "bank_loan"("id"),
	-- The instalment it settles, when it settles one. An extra payment of
	-- principal and an early settlement name none.
	"instalment_id" uuid REFERENCES "bank_loan_instalment"("id"),
	"kind" text NOT NULL,
	"paid_date" date NOT NULL,
	"principal_txn" numeric(19, 4) DEFAULT '0' NOT NULL,
	"interest_txn" numeric(19, 4) DEFAULT '0' NOT NULL,
	"fees_txn" numeric(19, 4) DEFAULT '0' NOT NULL,
	"total_txn" numeric(19, 4) NOT NULL,
	"total_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"reference" text NOT NULL,
	"journal_entry_id" uuid REFERENCES "journal_entry"("id"),
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "bank_loan_repayment_kind" CHECK (
		"kind" IN ('instalment', 'extra_principal', 'settlement')
	),
	CONSTRAINT "bank_loan_repayment_parts" CHECK (
		"principal_txn" >= 0 AND "interest_txn" >= 0 AND "fees_txn" >= 0
		AND "total_txn" = "principal_txn" + "interest_txn" + "fees_txn"
		AND "total_txn" > 0
	),
	CONSTRAINT "bank_loan_repayment_said" CHECK (coalesce(btrim("reference"), '') <> '')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_loan_repayment_loan_idx" ON "bank_loan_repayment" ("loan_id", "paid_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_loan_repayment_instalment_idx" ON "bank_loan_repayment" ("instalment_id");
--> statement-breakpoint

-- The day the loan came to nothing, stamped when it does and read back on the
-- record. Null while anything is outstanding.
ALTER TABLE "bank_loan"
  ADD COLUMN IF NOT EXISTS "repaid_on" date,
  -- What an early settlement cost beyond the principal and the interest: the
  -- bank's own charge for ending it early, as its letter quotes it.
  ADD COLUMN IF NOT EXISTS "settlement_fee_txn" numeric(19, 4);
--> statement-breakpoint

-- Append-only: a posted repayment is history.
CREATE OR REPLACE FUNCTION "bank_loan_repayment_append_only"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'Table % is append-only: % is not permitted. A repayment that was wrong is reversed by its journal and a correcting row.',
		TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "bank_loan_repayment_no_change" ON "bank_loan_repayment";
--> statement-breakpoint
CREATE TRIGGER "bank_loan_repayment_no_change"
	BEFORE UPDATE OR DELETE ON "bank_loan_repayment"
	FOR EACH ROW EXECUTE FUNCTION "bank_loan_repayment_append_only"();
--> statement-breakpoint

-- Scoped like the loan it belongs to, the way the allocations are scoped like
-- the import they fund.
ALTER TABLE "bank_loan_repayment" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bank_loan_repayment" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "bank_loan_repayment_branch_scope" ON "bank_loan_repayment";
--> statement-breakpoint
CREATE POLICY "bank_loan_repayment_branch_scope" ON "bank_loan_repayment"
	USING (
		app_is_super_user()
		OR EXISTS (SELECT 1 FROM bank_loan l
		            WHERE l.id = bank_loan_repayment.loan_id
		              AND app_branch_allowed(l.branch_code))
	)
	WITH CHECK (
		app_is_super_user()
		OR EXISTS (SELECT 1 FROM bank_loan l
		            WHERE l.id = bank_loan_repayment.loan_id
		              AND app_branch_allowed(l.branch_code))
	);
--> statement-breakpoint
GRANT SELECT, INSERT ON "bank_loan_repayment" TO "erp_app";
