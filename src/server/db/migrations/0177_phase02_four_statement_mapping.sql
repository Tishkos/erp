-- ===========================================================================
-- Four statements, four layouts, four account mappings — by direction
-- 2026-09-03.
--
-- Each report gets its own hierarchy of headers and lines, and every posting
-- account carries one mapping per report. A revenue account explains the
-- period on the Income Statement, is presented inside Equity on the Balance
-- Sheet, lands in an operating line of the Cash Flow Statement, and appears
-- in the result row of Changes in Equity — four independent answers, chosen
-- on the account, none of them derived from the others.
--
-- ── Mapping is a mapping, not an accounting opinion ────────────────────────
-- The 0176 trigger refused a mapping the account type did not "fit". That is
-- the system arguing with the person who knows the chart. It is gone: any
-- posting account may be mapped to any posting line of any statement. What
-- the trigger still refuses is a mapping that cannot mean anything — a line
-- that does not exist, a line belonging to a different report, a header
-- (which holds the sum of its lines and takes no accounts of its own), and a
-- header *account* carrying a mapping at all.
--
-- ── Nothing has to be mapped ───────────────────────────────────────────────
-- An unmapped account still appears where its type says it belongs, so the
-- statements are complete from the first day and get more precise as Finance
-- works through the chart. Mapping overrides the default; it never has to
-- replace it.
--
-- ── statement_line is left where it is ─────────────────────────────────────
-- The running release reads it, and this migration is applied minutes before
-- that release is replaced. Emptying or dropping it here would break every
-- statement page for the length of the build for no gain. It keeps its rows,
-- this release stops reading and writing it, and a later migration drops it.
-- ===========================================================================

-- ── The two new report faces ───────────────────────────────────────────────
ALTER TABLE "financial_statement_line"
  DROP CONSTRAINT IF EXISTS "financial_statement_line_statement_check";
ALTER TABLE "financial_statement_line"
  ADD CONSTRAINT "financial_statement_line_statement_check"
  CHECK (statement IN ('income_statement', 'balance_sheet', 'cash_flow', 'changes_in_equity'));

-- Each report's own vocabulary. An income line names the role it plays so the
-- subtotals keep computing; a balance-sheet line names its side so the two
-- halves know where to print; a cash-flow line is either the cash itself or
-- one of the three activities; changes-in-equity lines need nothing further.
ALTER TABLE "financial_statement_line"
  DROP CONSTRAINT IF EXISTS "financial_statement_line_vocabulary_check";
ALTER TABLE "financial_statement_line"
  ADD CONSTRAINT "financial_statement_line_vocabulary_check"
  CHECK (
    (statement = 'income_statement'
      AND side IS NULL AND NOT is_cash
      AND (is_header OR role IS NOT NULL))
    OR
    (statement = 'balance_sheet'
      AND role IS NULL
      AND side IS NOT NULL)
    OR
    (statement = 'cash_flow'
      AND role IS NULL AND side IS NULL
      AND (is_header OR is_cash OR cash_flow_category IS NOT NULL)
      AND NOT (is_cash AND cash_flow_category IS NOT NULL))
    OR
    (statement = 'changes_in_equity'
      AND role IS NULL AND side IS NULL
      AND cash_flow_category IS NULL AND NOT is_cash)
  );

-- ── The lines each new report starts from ──────────────────────────────────
-- System lines: renameable, movable, never deletable, because the fallbacks
-- below name them.
INSERT INTO "financial_statement_line"
  (code, name, statement, ordinal, role, side, cash_flow_category, is_cash, is_system)
VALUES
  ('cash_flow_cash',      'Cash and cash equivalents', 'cash_flow',         10, NULL, NULL, NULL,        true,  true),
  ('cash_flow_operating', 'Operating activities',      'cash_flow',         20, NULL, NULL, 'operating', false, true),
  ('cash_flow_investing', 'Investing activities',      'cash_flow',         30, NULL, NULL, 'investing', false, true),
  ('cash_flow_financing', 'Financing activities',      'cash_flow',         40, NULL, NULL, 'financing', false, true),
  ('equity_movements',    'Equity',                    'changes_in_equity', 10, NULL, NULL, NULL,        false, true)
ON CONFLICT (code) DO NOTHING;

-- ── One mapping column per report ──────────────────────────────────────────
-- balance_sheet_line already exists from 0176, where it was the optional
-- equity presentation of a revenue or expense account. It becomes the Balance
-- Sheet mapping of *every* account, and the asset, liability and equity
-- accounts that had their choice in statement_line are moved into it below.
ALTER TABLE "chart_of_account"
  ADD COLUMN IF NOT EXISTS "income_statement_line"  text,
  ADD COLUMN IF NOT EXISTS "cash_flow_line"         text,
  ADD COLUMN IF NOT EXISTS "changes_in_equity_line" text;

DO $$ BEGIN
  ALTER TABLE "chart_of_account"
    ADD CONSTRAINT "chart_of_account_income_statement_line_fkey"
    FOREIGN KEY ("income_statement_line") REFERENCES "financial_statement_line"("code");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "chart_of_account"
    ADD CONSTRAINT "chart_of_account_cash_flow_line_fkey"
    FOREIGN KEY ("cash_flow_line") REFERENCES "financial_statement_line"("code");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "chart_of_account"
    ADD CONSTRAINT "chart_of_account_changes_in_equity_line_fkey"
    FOREIGN KEY ("changes_in_equity_line") REFERENCES "financial_statement_line"("code");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Every choice already made is carried across ────────────────────────────
-- The trigger is dropped first: these statements are moving choices that were
-- already valid, and the old rules would refuse some of them on the way.
DROP TRIGGER IF EXISTS chart_of_account_statement_mapping_valid ON chart_of_account;

-- A revenue or expense account's statement_line was its Income Statement line.
UPDATE chart_of_account a
   SET income_statement_line = a.statement_line
  FROM financial_statement_line l
 WHERE l.code = a.statement_line
   AND l.statement = 'income_statement'
   AND a.income_statement_line IS NULL;

-- An asset, liability or equity account's statement_line was its Balance
-- Sheet line. Where 0176 already recorded an equity presentation for a
-- revenue or expense account, that stays where it is.
UPDATE chart_of_account a
   SET balance_sheet_line = a.statement_line
  FROM financial_statement_line l
 WHERE l.code = a.statement_line
   AND l.statement = 'balance_sheet'
   AND a.balance_sheet_line IS NULL;

-- The Cash Flow classification was a property of the balance-sheet line the
-- account reported on. It becomes a mapping of the account itself, so it can
-- be changed for one account without moving every account beside it.
UPDATE chart_of_account a
   SET cash_flow_line = CASE
         WHEN coalesce(l.is_cash, false)            THEN 'cash_flow_cash'
         WHEN l.cash_flow_category = 'investing'    THEN 'cash_flow_investing'
         WHEN l.cash_flow_category = 'financing'    THEN 'cash_flow_financing'
         ELSE 'cash_flow_operating'
       END
  FROM financial_statement_line l
 WHERE NOT a.is_group
   AND a.cash_flow_line IS NULL
   AND l.code = coalesce(
         a.statement_line,
         CASE a.account_type
           WHEN 'asset'     THEN 'current_assets'
           WHEN 'liability' THEN 'current_liabilities'
           WHEN 'equity'    THEN 'equity'
           WHEN 'revenue'   THEN 'revenue'
           ELSE 'operating_expenses'
         END);

-- Equity accounts are the rows of Changes in Equity. Revenue and expense
-- accounts stay unmapped on purpose: until Finance says otherwise they belong
-- to the computed result row, which is what makes that statement agree with
-- the Balance Sheet.
UPDATE chart_of_account
   SET changes_in_equity_line = 'equity_movements'
 WHERE account_type = 'equity'
   AND NOT is_group
   AND changes_in_equity_line IS NULL;

-- ── What a mapping still has to be ─────────────────────────────────────────
-- Not "does this suit the account type" — that is Finance's judgement, and
-- the whole point of a mapping screen. Only: does it name something that can
-- carry accounts on the report it claims to be on.
CREATE OR REPLACE FUNCTION chart_of_account_statement_mapping_valid()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target text;
  found_statement text;
  found_header boolean;
  pair record;
BEGIN
  IF NEW.is_group AND (
       NEW.income_statement_line IS NOT NULL
    OR NEW.balance_sheet_line IS NOT NULL
    OR NEW.cash_flow_line IS NOT NULL
    OR NEW.changes_in_equity_line IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Header account % carries no statement mapping of its own; it prints the sum of the accounts beneath it.',
      NEW.code;
  END IF;

  FOR pair IN
    SELECT * FROM (VALUES
      (NEW.income_statement_line,  'income_statement',  'Income Statement'),
      (NEW.balance_sheet_line,     'balance_sheet',     'Balance Sheet'),
      (NEW.cash_flow_line,         'cash_flow',         'Cash Flow Statement'),
      (NEW.changes_in_equity_line, 'changes_in_equity', 'Changes in Equity')
    ) AS t(code, statement, title)
  LOOP
    CONTINUE WHEN pair.code IS NULL;

    SELECT statement, is_header INTO found_statement, found_header
      FROM financial_statement_line WHERE code = pair.code;

    IF NOT FOUND THEN
      RAISE EXCEPTION '% mapping "%" for account % names a line that does not exist.',
        pair.title, pair.code, NEW.code;
    END IF;
    IF found_statement <> pair.statement THEN
      RAISE EXCEPTION '% mapping "%" for account % belongs to another report.',
        pair.title, pair.code, NEW.code;
    END IF;
    IF found_header THEN
      RAISE EXCEPTION '% mapping "%" for account % is a header; accounts map to the lines beneath it.',
        pair.title, pair.code, NEW.code;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

CREATE TRIGGER chart_of_account_statement_mapping_valid
  BEFORE INSERT OR UPDATE OF
    is_group,
    income_statement_line,
    balance_sheet_line,
    cash_flow_line,
    changes_in_equity_line
  ON chart_of_account
  FOR EACH ROW EXECUTE FUNCTION chart_of_account_statement_mapping_valid();

COMMENT ON COLUMN chart_of_account.income_statement_line IS
  'The Income Statement line this account reports on. Null falls to its type''s default.';
COMMENT ON COLUMN chart_of_account.balance_sheet_line IS
  'The Balance Sheet line this account reports on. Null falls to its type''s default; a revenue or expense account with none is carried in the computed result under Equity.';
COMMENT ON COLUMN chart_of_account.cash_flow_line IS
  'The Cash Flow Statement line this account''s movements are attributed to.';
COMMENT ON COLUMN chart_of_account.changes_in_equity_line IS
  'The Changes in Equity line this account appears on. Null leaves a revenue or expense account in the computed result row.';
COMMENT ON COLUMN chart_of_account.statement_line IS
  'Legacy single mapping, superseded 2026-09-03 by the four per-report columns. No longer read or written; kept for one release and dropped after.';
