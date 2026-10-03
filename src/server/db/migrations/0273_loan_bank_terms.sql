-- A loan as the bank's letter states it — by direction, 2026-10-03.
--
-- The register held a principal, a commission percentage, a rate and a count of
-- instalments. A bank's letter says more than that, and the parts it adds are
-- the parts that decide what the company actually owes:
--
--   * **How the principal comes back.** "Four instalments" does not say whether
--     that is 12,500 four times, nothing then 50,000, or a level payment. Those
--     are different loans.
--   * **How interest is worked out.** The same 8% is a different figure flat on
--     the original principal than on the reducing balance, and banks here quote
--     both.
--   * **Whether the rate stands.** A variable rate follows a published one plus
--     a spread, and the letter names which.
--   * **A grace period**, and whether it holds off principal, interest or both.
--   * **The facility's reference**, which is how the bank will refer to it.
--   * **What the money is for** — the purpose. The column already here held an
--     accounting instruction ("capitalise the commission"), which is a
--     treatment, not a purpose; `commission_capitalised` is where that lives.
--
-- Every column is optional and every default is what the register already did,
-- so the loans already entered keep the terms they were entered with: equal
-- principal, interest on the reducing balance, a fixed rate, no grace.
--
-- `submitted` joins the status list: a loan is drafted, sent for approval,
-- approved, then disbursed. Before approval the offer and its schedule may be
-- retyped; after it, a change is an amendment with a trail.

ALTER TABLE "bank_loan"
  ADD COLUMN IF NOT EXISTS "facility_reference" text,
  ADD COLUMN IF NOT EXISTS "principal_method" text NOT NULL DEFAULT 'equal_principal',
  ADD COLUMN IF NOT EXISTS "interest_basis" text NOT NULL DEFAULT 'reducing',
  ADD COLUMN IF NOT EXISTS "interest_type" text NOT NULL DEFAULT 'fixed',
  ADD COLUMN IF NOT EXISTS "interest_reference_rate" text,
  ADD COLUMN IF NOT EXISTS "interest_spread_pct" numeric(9, 4),
  ADD COLUMN IF NOT EXISTS "commission_basis" text NOT NULL DEFAULT 'percentage',
  ADD COLUMN IF NOT EXISTS "other_fees_txn" numeric(19, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "grace_kind" text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS "grace_until" date,
  ADD COLUMN IF NOT EXISTS "purpose_code" text,
  ADD COLUMN IF NOT EXISTS "expected_disbursement_date" date,
  ADD COLUMN IF NOT EXISTS "submitted_by" uuid REFERENCES "app_user"("id"),
  ADD COLUMN IF NOT EXISTS "submitted_at" timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_loan_principal_method') THEN
    ALTER TABLE "bank_loan" ADD CONSTRAINT "bank_loan_principal_method"
      CHECK ("principal_method" IN ('equal_principal', 'equal_instalments', 'bullet', 'custom'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_loan_interest_basis') THEN
    ALTER TABLE "bank_loan" ADD CONSTRAINT "bank_loan_interest_basis"
      CHECK ("interest_basis" IN ('reducing', 'flat'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_loan_interest_type') THEN
    ALTER TABLE "bank_loan" ADD CONSTRAINT "bank_loan_interest_type"
      CHECK ("interest_type" IN ('fixed', 'variable'));
  END IF;

  -- A variable rate follows something: the letter names it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_loan_variable_names_its_rate') THEN
    ALTER TABLE "bank_loan" ADD CONSTRAINT "bank_loan_variable_names_its_rate"
      CHECK ("interest_type" <> 'variable' OR "interest_reference_rate" IS NOT NULL);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_loan_commission_basis') THEN
    ALTER TABLE "bank_loan" ADD CONSTRAINT "bank_loan_commission_basis"
      CHECK ("commission_basis" IN ('percentage', 'fixed', 'none'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_loan_grace_kind') THEN
    ALTER TABLE "bank_loan" ADD CONSTRAINT "bank_loan_grace_kind"
      CHECK ("grace_kind" IN ('none', 'principal', 'interest', 'both'));
  END IF;

  -- A grace period runs to a date; without one it covers nothing.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_loan_grace_has_a_date') THEN
    ALTER TABLE "bank_loan" ADD CONSTRAINT "bank_loan_grace_has_a_date"
      CHECK (("grace_kind" = 'none') = ("grace_until" IS NULL));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_loan_other_fees_not_negative') THEN
    ALTER TABLE "bank_loan" ADD CONSTRAINT "bank_loan_other_fees_not_negative"
      CHECK ("other_fees_txn" >= 0);
  END IF;
END $$;
