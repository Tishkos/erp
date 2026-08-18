-- ---------------------------------------------------------------------------
-- D7 — one currency per posting account. Decided 2026-08-17.
--
--   "Each Chart of Accounts account is limited to one currency only. When
--    creating a new account, the ERP should ask for the Account Currency at the
--    beginning of the setup. The currency should not be assumed automatically.
--    … If Accounting needs the same type of account in another currency, they
--    should create a separate account for that currency."
--
-- `currency_restriction` was introduced in 0003 as an optional narrowing —
-- "null is unrestricted". Unrestricted is the one state the decision rules out.
-- The column stays nullable because groups exist and hold no balance; the CHECK
-- is what makes it required where a balance can actually accumulate.
--
-- Deliberately NOT done here: backfilling existing posting accounts with 'IQD'.
-- A backfill is the assumption the decision forbids, made once and invisibly for
-- every account at once. Any account already carrying a balance must be assigned
-- its currency by Accounting. Development and test data is recreated from
-- scratch by db:reset, so in practice this affects nothing but seeds.
-- ---------------------------------------------------------------------------

-- Seed and fixture accounts predate the rule. They are all IQD by construction
-- (§1.1 — IQD is the functional currency), and none of them carry a balance
-- anyone has reconciled. Named individually rather than swept, so that an
-- account this migration does not know about fails the constraint loudly
-- instead of being quietly assumed into a currency.
UPDATE chart_of_account
   SET currency_restriction = 'IQD'
 WHERE is_group = false
   AND currency_restriction IS NULL
   AND code IN ('A100001');
--> statement-breakpoint

DO $$
DECLARE
  v_unassigned int;
BEGIN
  SELECT count(*) INTO v_unassigned
    FROM chart_of_account
   WHERE is_group = false AND currency_restriction IS NULL;

  IF v_unassigned > 0 THEN
    RAISE EXCEPTION
      'D7: % posting account(s) have no currency. Assign each one before this migration can apply — '
      'the currency of an account holding a balance is an accounting decision, not a default.',
      v_unassigned;
  END IF;
END;
$$;--> statement-breakpoint

-- A group summarises children in whatever currencies they hold; giving it one
-- of its own would imply its total means something it does not.
UPDATE chart_of_account
   SET currency_restriction = NULL
 WHERE is_group = true AND currency_restriction IS NOT NULL;
--> statement-breakpoint

ALTER TABLE chart_of_account
  ADD CONSTRAINT chart_of_account_posting_needs_currency
  CHECK (
    (is_group = true  AND currency_restriction IS NULL)
    OR
    (is_group = false AND currency_restriction IS NOT NULL)
  );
--> statement-breakpoint

COMMENT ON COLUMN chart_of_account.currency_restriction IS
  'D7 (2026-08-17): the one currency this posting account holds. Required on a '
  'posting account, forbidden on a group. Same account, second currency = second account.';
