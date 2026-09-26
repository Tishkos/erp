-- ---------------------------------------------------------------------------
-- The Bank/Cash number is minted, not typed — Operations build, block 6.
--
-- The build says it in the field list itself:
--
--   6. Banks and Cash Master Data
--      Fields  Bank/Cash Name; Bank Number (automatically generated);
--              Type (Cash or Bank); Related Account.
--
-- It was a slug of the name with a prefix — BANK_QI_BANK, CASH_HQ — typed over
-- whenever somebody preferred something else. "Automatically generated" is not
-- a description of that.
--
-- Two counters rather than one, the way the chart of accounts keeps one per
-- type: a cash box and a bank account are different things to a treasurer, and
-- a number that says which is a number that answers a question before it is
-- asked.
-- ---------------------------------------------------------------------------
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year) VALUES
  ('BANK_ACCOUNT_CODE', 'BANK', '{PREFIX}-{SERIAL}', 6, false, false),
  ('CASH_ACCOUNT_CODE', 'CASH', '{PREFIX}-{SERIAL}', 6, false, false)
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint

-- Nothing is renamed: CASH-HQ is on documents that have already posted. Each
-- counter starts past the highest code already in its minted shape, so a code
-- somebody typed in that shape cannot be handed out a second time.
DO $$
DECLARE
  spec record;
  highest bigint;
  seq     text;
BEGIN
  FOR spec IN
    SELECT 'BANK_ACCOUNT_CODE' AS key, '^BANK-([0-9]+)$' AS shape
    UNION ALL
    SELECT 'CASH_ACCOUNT_CODE', '^CASH-([0-9]+)$'
  LOOP
    seq := doc_sequence_name(spec.key, '');
    IF to_regclass(seq) IS NULL THEN
      EXECUTE format('CREATE SEQUENCE %I START 1', seq);
    END IF;

    SELECT coalesce(max(substring(code from spec.shape)::bigint), 0)
      INTO highest
      FROM bank_cash_account;

    IF highest > 0 THEN
      PERFORM setval(seq, highest, true);
    END IF;
  END LOOP;
END $$;
