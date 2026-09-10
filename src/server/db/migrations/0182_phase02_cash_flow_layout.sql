-- The Statement of Cash Flows, by direction of 2026-09-10.
--
--   Operating Activities
--     Net Income
--     Add back: Depreciation
--     Accounts Receivable
--     Inventory
--     Accounts Payable
--     Net cash provided (used) by operating activities
--   Investing Activities
--     Equipment
--     Net cash used in investing activities
--   Financing Activities
--     Loan
--     Paid-In Capital
--     Net cash provided by financing activities
--   Net increase in cash
--   Cash at the beginning of the period
--   Cash at the end of the period
--
-- ── Why every figure is credits less debits ────────────────────────────────
-- Profit is not cash. The statement begins at Net Income and adjusts it by
-- what happened to every other account, and the sponsor set the adjustments
-- out one rule at a time:
--
--   an operating asset rises    → deduct     (receivables up: sold, not paid)
--   an operating asset falls    → add        (receivables down: collected)
--   an operating liability rises→ add        (payables up: bought, not paid)
--   an operating liability falls→ deduct     (paid the supplier)
--   a loan rises                → positive   (the bank lent)
--   a loan falls                → negative   (the bank was repaid)
--   equipment bought            → negative
--   equipment sold              → positive
--
-- Every one of those is the same arithmetic: **credits less debits over the
-- period**. An asset rising is a net debit and comes out negative; a liability
-- rising is a net credit and comes out positive. Net Income is that same sum
-- over the revenue and expense accounts.
--
-- It matters because it makes the statement tie by arithmetic rather than by
-- care. Every journal balances, so credits less debits across *all* accounts
-- is zero; therefore the same sum across every account except cash equals the
-- movement in cash. The statement cannot drift from the ledger — and where an
-- account has not been classified yet, its figure still appears, on a line of
-- its own, rather than quietly going missing.
--
-- ── What a line has to say for itself ──────────────────────────────────────
-- Nothing. Which activity a line belongs to is where it sits in the layout,
-- exactly as "Add:" and "Subtract:" work on the Statement of Changes in
-- Equity. `cash_flow_category` asked every line to name its activity a second
-- time, in a field that could disagree with the heading above it — the same
-- fault as the `role` dropped in 0179 — so it goes the same way.
--
-- `is_cash` stays. It is not a classification but a fact the statement cannot
-- work without: which accounts *are* the cash being explained.

-- ── Two more figures the ledger works out ─────────────────────────────────
ALTER TABLE "financial_statement_line"
  DROP CONSTRAINT IF EXISTS "financial_statement_line_computes_check";
ALTER TABLE "financial_statement_line"
  ADD CONSTRAINT "financial_statement_line_computes_check"
  CHECK (
    computes IS NULL
    OR (
      NOT is_header AND NOT is_subtotal
      AND (
        (statement = 'changes_in_equity' AND computes IN ('opening', 'result'))
        OR
        (statement = 'cash_flow' AND computes IN ('net_income', 'opening_cash', 'unclassified'))
      )
    )
  );

COMMENT ON COLUMN "financial_statement_line"."computes" IS
  'A line whose figure is worked out rather than mapped. Changes in Equity: '
  '''opening'' the equity the period began with, ''result'' the profit or loss it made. '
  'Cash Flow: ''net_income'' the result for the period, ''opening_cash'' the cash it '
  'started with, ''unclassified'' every account not yet given a line. No account '
  'reports on one.';--> statement-breakpoint

-- ── A cash-flow line names no activity ────────────────────────────────────
ALTER TABLE "financial_statement_line"
  DROP CONSTRAINT IF EXISTS "financial_statement_line_vocabulary_check";
ALTER TABLE "financial_statement_line"
  ADD CONSTRAINT "financial_statement_line_vocabulary_check"
  CHECK (
    (statement = 'income_statement' AND side IS NULL AND NOT is_cash)
    OR
    (statement = 'balance_sheet' AND (side IS NOT NULL OR is_subtotal))
    OR
    (statement = 'cash_flow' AND side IS NULL)
    OR
    (statement = 'changes_in_equity' AND side IS NULL AND NOT is_cash)
  );--> statement-breakpoint

ALTER TABLE "financial_statement_line" DROP COLUMN IF EXISTS "cash_flow_category";--> statement-breakpoint

-- ── The layout ────────────────────────────────────────────────────────────
-- The three lines seeded in 0177 — one per activity, holding nothing — are
-- replaced by the shape the sponsor's example shows. They carry no accounts
-- on any install, so nothing is stranded by removing them.
UPDATE "chart_of_account" SET cash_flow_line = NULL
 WHERE cash_flow_line IN ('cash_flow_operating', 'cash_flow_investing', 'cash_flow_financing');--> statement-breakpoint

DELETE FROM "financial_statement_line"
 WHERE code IN ('cash_flow_operating', 'cash_flow_investing', 'cash_flow_financing');--> statement-breakpoint

INSERT INTO "financial_statement_line"
  (code, name, statement, ordinal, parent_id, side, is_cash, is_header, is_subtotal, computes, is_system)
VALUES
  ('cf_operating',   'Operating Activities',                'cash_flow',   10, NULL, NULL, false, true,  false, NULL,           true),
  ('cf_investing',   'Investing Activities',                'cash_flow',   20, NULL, NULL, false, true,  false, NULL,           true),
  ('cf_financing',   'Financing Activities',                'cash_flow',   30, NULL, NULL, false, true,  false, NULL,           true),
  ('cf_unclassified','Not yet classified',                  'cash_flow',   40, NULL, NULL, false, false, false, 'unclassified', true),
  ('cf_net_change',  'Net increase in cash',                'cash_flow',   50, NULL, NULL, false, false, true,  NULL,           true),
  ('cf_opening',     'Cash at the beginning of the period', 'cash_flow',   60, NULL, NULL, false, false, false, 'opening_cash', true),
  ('cf_closing',     'Cash at the end of the period',       'cash_flow', 9000, NULL, NULL, false, false, true,  NULL,           true)
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

-- Operating: the result, the non-cash add-backs, the working capital, then the
-- section's own total.
INSERT INTO "financial_statement_line"
  (code, name, statement, ordinal, parent_id, side, is_cash, is_header, is_subtotal, computes, is_system)
SELECT v.code, v.name, 'cash_flow', v.ordinal, s.id, NULL, false, false, v.is_subtotal, v.computes, true
FROM (VALUES
  ('cf_net_income',    'Net Income',                                        10, false, 'net_income'),
  ('cf_depreciation',  'Add back: Depreciation',                            20, false, NULL),
  ('cf_receivables',   'Accounts Receivable',                               30, false, NULL),
  ('cf_inventory',     'Inventory',                                         40, false, NULL),
  ('cf_payables',      'Accounts Payable',                                  50, false, NULL),
  ('cf_operating_net', 'Net cash provided (used) by operating activities',  60, true,  NULL)
) AS v(code, name, ordinal, is_subtotal, computes)
CROSS JOIN (SELECT id FROM "financial_statement_line" WHERE code = 'cf_operating') AS s
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

INSERT INTO "financial_statement_line"
  (code, name, statement, ordinal, parent_id, side, is_cash, is_header, is_subtotal, computes, is_system)
SELECT v.code, v.name, 'cash_flow', v.ordinal, s.id, NULL, false, false, v.is_subtotal, NULL, true
FROM (VALUES
  ('cf_equipment',     'Equipment',                             10, false),
  ('cf_investing_net', 'Net cash used in investing activities', 20, true)
) AS v(code, name, ordinal, is_subtotal)
CROSS JOIN (SELECT id FROM "financial_statement_line" WHERE code = 'cf_investing') AS s
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

INSERT INTO "financial_statement_line"
  (code, name, statement, ordinal, parent_id, side, is_cash, is_header, is_subtotal, computes, is_system)
SELECT v.code, v.name, 'cash_flow', v.ordinal, s.id, NULL, false, false, v.is_subtotal, NULL, true
FROM (VALUES
  ('cf_loan',          'Loan',                                       10, false),
  ('cf_capital',       'Paid-In Capital',                            20, false),
  ('cf_financing_net', 'Net cash provided by financing activities',  30, true)
) AS v(code, name, ordinal, is_subtotal)
CROSS JOIN (SELECT id FROM "financial_statement_line" WHERE code = 'cf_financing') AS s
ON CONFLICT (code) DO NOTHING;
