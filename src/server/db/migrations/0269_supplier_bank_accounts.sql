-- IMPROVEMENT-002 — a supplier's bank accounts, set up on the supplier's
-- profile (sponsor, 2026-10-03: "I cannot verify a supplier SWIFT account
-- anywhere … suppliers can have multiple SWIFT and IBAN accounts … full account
-- set up in their profile").
--
--   * The account in full: the bank (from the bank list, or named), its branch
--     and address, the beneficiary, the account number and/or IBAN, the
--     SWIFT/BIC, the currency, an intermediary bank, a note.
--   * Several accounts may be payable at once — a supplier banks in dinars and
--     in dollars — each verified by somebody other than the person who entered
--     it (the 0010 workflow, unchanged). One of them is the default: what a
--     payment run pays to, and what a payment application offers first.
--   * An account is taken out of use with a reason, never deleted.
--   * The new payable fields (the bank from the list, the intermediary) are
--     frozen once approved, like the number and the SWIFT, and bump the
--     revision like the old ones, so a payment approved against an account
--     still sees any change before it is sent. The holder's name stays as
--     Phase 07 left it: editable, and an edit un-approves the set.
ALTER TABLE "partner_bank_account"
	ADD COLUMN IF NOT EXISTS "bank_code" text REFERENCES "bank"("code"),
	ADD COLUMN IF NOT EXISTS "bank_branch" text,
	ADD COLUMN IF NOT EXISTS "bank_address" text,
	ADD COLUMN IF NOT EXISTS "intermediary_bank" text,
	ADD COLUMN IF NOT EXISTS "intermediary_swift" text,
	ADD COLUMN IF NOT EXISTS "note" text,
	ADD COLUMN IF NOT EXISTS "is_default" boolean NOT NULL DEFAULT false,
	ADD COLUMN IF NOT EXISTS "deactivated_at" timestamp with time zone,
	ADD COLUMN IF NOT EXISTS "deactivated_by" uuid REFERENCES "app_user"("id"),
	ADD COLUMN IF NOT EXISTS "deactivation_reason" text;--> statement-breakpoint

-- Until now one account per partner was payable; it becomes the default.
UPDATE "partner_bank_account" SET "is_default" = true
 WHERE "id" IN (
	SELECT DISTINCT ON ("partner_id") "id" FROM "partner_bank_account"
	 WHERE "is_active" AND "approval_status" = 'approved'
	 ORDER BY "partner_id", "approved_at" DESC NULLS LAST, "created_at" DESC
 );--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "partner_bank_one_default" ON "partner_bank_account" ("partner_id") WHERE "is_default";--> statement-breakpoint
ALTER TABLE "partner_bank_account" DROP CONSTRAINT IF EXISTS "partner_bank_default_is_payable";--> statement-breakpoint
ALTER TABLE "partner_bank_account" ADD CONSTRAINT "partner_bank_default_is_payable" CHECK (NOT "is_default" OR "is_active");--> statement-breakpoint
ALTER TABLE "partner_bank_account" DROP CONSTRAINT IF EXISTS "partner_bank_deactivation_reason";--> statement-breakpoint
ALTER TABLE "partner_bank_account" ADD CONSTRAINT "partner_bank_deactivation_reason" CHECK (
	"deactivated_at" IS NULL OR (NOT "is_active" AND "deactivation_reason" IS NOT NULL AND btrim("deactivation_reason") <> '')
);--> statement-breakpoint

CREATE OR REPLACE FUNCTION partner_bank_account_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.approval_status <> 'approved' THEN
    RETURN NEW;
  END IF;

  IF NEW.bank_name          IS DISTINCT FROM OLD.bank_name
  OR NEW.account_number     IS DISTINCT FROM OLD.account_number
  OR NEW.iban               IS DISTINCT FROM OLD.iban
  OR NEW.swift              IS DISTINCT FROM OLD.swift
  OR NEW.currency           IS DISTINCT FROM OLD.currency
  OR NEW.bank_code          IS DISTINCT FROM OLD.bank_code
  OR NEW.intermediary_swift IS DISTINCT FROM OLD.intermediary_swift
  OR NEW.intermediary_bank  IS DISTINCT FROM OLD.intermediary_bank THEN
    RAISE EXCEPTION
      'Approved bank details cannot be edited. Add a new set and have it approved — the old set stays as history (§15).'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Taken out of use is final: a deactivated account comes back as a new set.
  IF OLD.deactivated_at IS NOT NULL AND NEW.is_active THEN
    RAISE EXCEPTION 'A deactivated bank account is not used again. Add it as a new set and have it verified.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION partner_bank_account_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.bank_name, NEW.account_number, NEW.iban, NEW.swift, NEW.currency, NEW.account_holder,
         NEW.bank_code, NEW.intermediary_swift, NEW.intermediary_bank)
     IS DISTINCT FROM
     ROW(OLD.bank_name, OLD.account_number, OLD.iban, OLD.swift, OLD.currency, OLD.account_holder,
         OLD.bank_code, OLD.intermediary_swift, OLD.intermediary_bank)
  THEN
    NEW.revision        := OLD.revision + 1;
    NEW.approval_status := 'draft';
    NEW.is_active       := false;
    NEW.is_default      := false;
    NEW.approved_by     := NULL;
    NEW.approved_at     := NULL;
  ELSE
    NEW.revision := OLD.revision;
  END IF;

  RETURN NEW;
END;
$$;
