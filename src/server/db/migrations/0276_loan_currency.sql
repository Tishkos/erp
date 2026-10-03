-- A loan is owed in its own currency, whatever account the money landed in.
--
-- By direction, 2026-10-03: "loan currency and receiving-account currency must
-- be independent… Do not convert the loan itself permanently into IQD just
-- because the receiving account is IQD."
--
-- `bank_loan.currency` has been here since 0235 and was always set to the
-- receiving account's — so a 50,000 USD facility paid into a Rafidain dinar
-- account was recorded as a dinar loan, and the debt to the bank, which is in
-- dollars and stays in dollars however the rate moves, was gone the moment it
-- was entered. The column now holds the loan's own currency, chosen on the
-- form; the account keeps its own, as it always did.
--
-- Nothing new is built for the rates. The conversions go through
-- `services/exchange-rates` — the same `rateOn`/`convertOn` every other module
-- uses, the same `exchange_rate` rows Finance publishes on Currencies & Rates,
-- the same money scales.
--
-- ── What the ledger carries ─────────────────────────────────────────────
-- The liability's dinar value is not stored: it is the balance of the loan
-- control account for this loan (`journal_line.loan_no`), which is where every
-- posting has always put it. A revaluation moves that balance to what the
-- outstanding foreign currency is worth on the day, and the difference is a
-- gain or a loss through the accounts Finance already maps for exchange
-- differences. `bank_loan_revaluation` records each one so the movement can be
-- read back without re-deriving it from the journal.

ALTER TABLE "bank_loan"
  ADD COLUMN IF NOT EXISTS "revalued_on" date;
--> statement-breakpoint

DO $$
BEGIN
  -- The loan's currency is one Finance has defined, like every other.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_loan_currency_fk') THEN
    ALTER TABLE "bank_loan"
      ADD CONSTRAINT "bank_loan_currency_fk"
      FOREIGN KEY ("currency") REFERENCES "currency"("code");
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "bank_loan_revaluation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_id" uuid NOT NULL REFERENCES "bank_loan"("id"),
	"on_date" date NOT NULL,
	"rate_id" uuid REFERENCES "exchange_rate"("id"),
	-- What was still owed, in the loan's own currency, on that day.
	"outstanding_txn" numeric(19, 4) NOT NULL,
	"iqd_per_unit" numeric(18, 8) NOT NULL,
	"carrying_before_iqd" numeric(19, 4) NOT NULL,
	"carrying_after_iqd" numeric(19, 4) NOT NULL,
	-- Positive: the debt grew in dinars, which is a loss. Negative: a gain.
	"difference_iqd" numeric(19, 4) NOT NULL,
	"journal_entry_id" uuid REFERENCES "journal_entry"("id"),
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "bank_loan_revaluation_moves" CHECK (
		"difference_iqd" <> 0
		AND "carrying_after_iqd" = "carrying_before_iqd" + "difference_iqd"
	),
	CONSTRAINT "bank_loan_revaluation_once_a_day" UNIQUE ("loan_id", "on_date")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bank_loan_revaluation_loan_idx" ON "bank_loan_revaluation" ("loan_id", "on_date");
--> statement-breakpoint

-- Append-only, as the repayments are: a revaluation that was wrong is undone
-- by another revaluation, never edited.
CREATE OR REPLACE FUNCTION "bank_loan_revaluation_append_only"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'Table % is append-only: % is not permitted. A revaluation is corrected by a later one.',
		TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "bank_loan_revaluation_no_change" ON "bank_loan_revaluation";
--> statement-breakpoint
CREATE TRIGGER "bank_loan_revaluation_no_change"
	BEFORE UPDATE OR DELETE ON "bank_loan_revaluation"
	FOR EACH ROW EXECUTE FUNCTION "bank_loan_revaluation_append_only"();
--> statement-breakpoint

ALTER TABLE "bank_loan_revaluation" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bank_loan_revaluation" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "bank_loan_revaluation_branch_scope" ON "bank_loan_revaluation";
--> statement-breakpoint
CREATE POLICY "bank_loan_revaluation_branch_scope" ON "bank_loan_revaluation"
	USING (
		app_is_super_user()
		OR EXISTS (SELECT 1 FROM bank_loan l
		            WHERE l.id = bank_loan_revaluation.loan_id
		              AND app_branch_allowed(l.branch_code))
	)
	WITH CHECK (
		app_is_super_user()
		OR EXISTS (SELECT 1 FROM bank_loan l
		            WHERE l.id = bank_loan_revaluation.loan_id
		              AND app_branch_allowed(l.branch_code))
	);
--> statement-breakpoint
GRANT SELECT, INSERT ON "bank_loan_revaluation" TO "erp_app";
--> statement-breakpoint
