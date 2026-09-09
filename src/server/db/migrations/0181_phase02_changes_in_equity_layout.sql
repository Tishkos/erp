-- The Statement of Changes in Equity, as Mr Issa set it out (2026-09-09).
--
--   Equity at the beginning of the period
--   Add:
--     Total Income
--     Additional Paid-In Capital
--   Subtract:
--     Dividends
--     Retained Earnings
--   Equity at the End of the Period
--
-- One column, read top to bottom: what equity was, what happened to it, what
-- it became. It replaces three columns of opening/movement/closing, which
-- said the same thing sideways and asked the reader to do the arithmetic.
--
-- ── Which way a figure goes ────────────────────────────────────────────────
-- "Add:" and "Subtract:" are headings, not instructions. The sign comes from
-- the ledger, exactly as it now does on the Income Statement: income credits
-- equity and prints as a positive, a dividend debits it and prints as
-- (500,000). That is what keeps the closing figure equal to the Equity
-- section of a Balance Sheet drawn on the same day — which is the check any
-- reader of this statement will make, and the one worth never breaking.
--
-- ── Two lines whose figure is not mapped ───────────────────────────────────
-- `computes` marks them:
--
--   opening  every account's balance as at the day before the period —
--            equity, and the profit of earlier periods that no year-end
--            close has moved into retained earnings. Together, the equity a
--            Balance Sheet would show the day before this statement starts.
--
--   result   the profit or loss of the period itself, from the revenue and
--            expense accounts not mapped to a line of this statement. Mr
--            Issa's "Total Income".
--
-- The closing line is an ordinary computed total — `is_subtotal`, the same
-- kind as Net Income (Loss) — carrying the running sum of everything above.

ALTER TABLE "financial_statement_line"
  ADD COLUMN IF NOT EXISTS "computes" text;

ALTER TABLE "financial_statement_line"
  DROP CONSTRAINT IF EXISTS "financial_statement_line_computes_check";
ALTER TABLE "financial_statement_line"
  ADD CONSTRAINT "financial_statement_line_computes_check"
  CHECK (
    computes IS NULL
    OR (
      computes IN ('opening', 'result')
      AND statement = 'changes_in_equity'
      AND NOT is_header
      AND NOT is_subtotal
    )
  );

COMMENT ON COLUMN "financial_statement_line"."computes" IS
  'Changes in Equity only: a line whose figure is worked out rather than mapped — '
  '''opening'' the equity the period began with, ''result'' the profit or loss it made. '
  'No account reports on one.';--> statement-breakpoint

-- ── The layout ─────────────────────────────────────────────────────────────
-- Built around the line that is already there. 0177 mapped every equity
-- account to `equity_movements`, so it is renamed and moved rather than
-- replaced: the accounts stay attached to it and nothing has to be mapped
-- again by hand.
INSERT INTO "financial_statement_line"
  (code, name, statement, ordinal, parent_id, side, cash_flow_category, is_cash, is_header, is_subtotal, computes, is_system)
VALUES
  ('equity_opening',  'Equity at the beginning of the period', 'changes_in_equity',    5, NULL, NULL, NULL, false, false, false, 'opening', true),
  ('equity_add',      'Add:',                                  'changes_in_equity',   10, NULL, NULL, NULL, false, true,  false, NULL,      true),
  ('equity_subtract', 'Subtract:',                             'changes_in_equity',   20, NULL, NULL, NULL, false, true,  false, NULL,      true),
  ('equity_closing',  'Equity at the End of the Period',       'changes_in_equity', 9000, NULL, NULL, NULL, false, false, true,  NULL,      true)
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

-- Total Income and Additional Paid-In Capital under "Add:".
INSERT INTO "financial_statement_line"
  (code, name, statement, ordinal, parent_id, side, cash_flow_category, is_cash, is_header, is_subtotal, computes, is_system)
SELECT
  v.code, v.name, 'changes_in_equity', v.ordinal, add_section.id, NULL, NULL, false, false, false, v.computes, true
FROM (VALUES
  ('equity_total_income', 'Total Income',               10, 'result'),
  ('equity_paid_in',      'Additional Paid-In Capital', 20, NULL)
) AS v(code, name, ordinal, computes)
CROSS JOIN (
  SELECT id FROM "financial_statement_line" WHERE code = 'equity_add'
) AS add_section
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

-- Dividends and Retained Earnings under "Subtract:".
INSERT INTO "financial_statement_line"
  (code, name, statement, ordinal, parent_id, side, cash_flow_category, is_cash, is_header, is_subtotal, computes, is_system)
SELECT
  v.code, v.name, 'changes_in_equity', v.ordinal, subtract_section.id, NULL, NULL, false, false, false, NULL, true
FROM (VALUES
  ('equity_dividends', 'Dividends',         10),
  ('equity_retained',  'Retained Earnings', 20)
) AS v(code, name, ordinal)
CROSS JOIN (
  SELECT id FROM "financial_statement_line" WHERE code = 'equity_subtract'
) AS subtract_section
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

-- The line every equity account already reports on becomes Additional Paid-In
-- Capital, which is where share capital belongs in this layout. Accounts
-- Finance has since moved elsewhere are left alone.
UPDATE "chart_of_account"
   SET changes_in_equity_line = 'equity_paid_in'
 WHERE changes_in_equity_line = 'equity_movements';--> statement-breakpoint

DELETE FROM "financial_statement_line" WHERE code = 'equity_movements';
