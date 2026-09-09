-- ===========================================================================
-- The role goes; a computed line takes its place — by direction 2026-09-09.
--
-- A line carried a `role` — revenue, cost of sales, operating expenses… —
-- and the Income Statement's subtotals were worked out from it in code. Two
-- things were wrong with that. It asked the person building the layout to
-- answer a question about the arithmetic on every line they made, and it put
-- the shape of the statement in the code rather than in the layout the shape
-- is supposed to live in.
--
-- Neither is needed. Which way a figure goes is already known from the
-- account: a revenue account is credit-normal and adds to the result, an
-- expense account is debit-normal and takes away. And a subtotal is a *line*,
-- placed where it belongs — "Gross Profit" after revenue and cost of sales,
-- "Net Income (Loss)" at the foot — carrying the running total of everything
-- above it. Move it and the statement changes; that is the point.
--
-- So the three kinds a line can be are: a header that groups, a line that
-- carries accounts, and a subtotal that adds up what came before it.
-- ===========================================================================

ALTER TABLE "financial_statement_line"
  ADD COLUMN IF NOT EXISTS "is_subtotal" boolean NOT NULL DEFAULT false;

-- A line is at most one of the three kinds.
DO $$ BEGIN
  ALTER TABLE "financial_statement_line"
    ADD CONSTRAINT "financial_statement_line_one_kind"
    CHECK (NOT (is_header AND is_subtotal));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A subtotal carries no accounts, so nothing may report on one.
CREATE OR REPLACE FUNCTION chart_of_account_statement_mapping_valid()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  found_statement text;
  found_header boolean;
  found_subtotal boolean;
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

    SELECT statement, is_header, is_subtotal
      INTO found_statement, found_header, found_subtotal
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
    IF found_subtotal THEN
      RAISE EXCEPTION '% mapping "%" for account % is a computed total; it adds up the lines above it.',
        pair.title, pair.code, NEW.code;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

-- ── The vocabulary each report still needs ─────────────────────────────────
-- `role` is gone from it. A balance-sheet line keeps its side, because that
-- says which half of the sheet it prints on and no account can say it; a
-- cash-flow line keeps its activity for the same reason.
-- 0175 seeded the income lines with a cash-flow activity, back when one
-- mapping served every report. The Cash Flow Statement has had lines and a
-- mapping of its own since 0177, so the value has been meaningless for two
-- releases and the check below is where it finally gets in the way.
UPDATE "financial_statement_line"
   SET cash_flow_category = NULL, is_cash = false
 WHERE statement IN ('income_statement', 'changes_in_equity');

ALTER TABLE "financial_statement_line"
  DROP CONSTRAINT IF EXISTS "financial_statement_line_vocabulary_check";
ALTER TABLE "financial_statement_line"
  ADD CONSTRAINT "financial_statement_line_vocabulary_check"
  CHECK (
    (statement = 'income_statement'
      AND side IS NULL AND NOT is_cash AND cash_flow_category IS NULL)
    OR
    (statement = 'balance_sheet'
      AND (side IS NOT NULL OR is_subtotal))
    OR
    (statement = 'cash_flow'
      AND side IS NULL
      AND (is_header OR is_subtotal OR is_cash OR cash_flow_category IS NOT NULL)
      AND NOT (is_cash AND cash_flow_category IS NOT NULL))
    OR
    (statement = 'changes_in_equity'
      AND side IS NULL
      AND cash_flow_category IS NULL AND NOT is_cash)
  );

ALTER TABLE "financial_statement_line" DROP CONSTRAINT IF EXISTS "financial_statement_line_role_check";
ALTER TABLE "financial_statement_line" DROP COLUMN IF EXISTS "role";

-- ── The two figures the Income Statement is read for ───────────────────────
-- Seeded so a fresh install prints a result, and ordinary lines otherwise:
-- rename them, move them, remove one if this company does not report it.
INSERT INTO "financial_statement_line"
  (code, name, statement, ordinal, side, cash_flow_category, is_cash, is_header, is_subtotal, is_system)
VALUES
  -- The result sits far below everything else so that a line added later
  -- lands above it, not after the figure it is meant to be part of.
  ('gross_profit',  'Gross Profit',       'income_statement',   25, NULL, NULL, false, false, true, true),
  ('net_income',    'Net Income (Loss)',  'income_statement', 9000, NULL, NULL, false, false, true, true)
ON CONFLICT (code) DO NOTHING;
