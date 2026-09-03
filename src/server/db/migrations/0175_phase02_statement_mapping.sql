-- ===========================================================================
-- The financial statement mapping, owned by Finance — by direction 2026-09-03.
--
-- The statement lines move out of the code and into a table Finance edits:
-- headers and lines per statement, in the order the statement prints them.
-- The twelve original lines are seeded as system lines (renameable, movable,
-- never deletable) so the type defaults and the running subtotals keep their
-- anchors; everything else is Finance's to create.
--
-- One mapping, four statements: an account reports on exactly one line, the
-- Cash Flow Statement classifies each line (operating/investing/financing),
-- and Changes in Equity is the equity side of the Balance Sheet. Separate
-- mapping tables per report would let the four disagree.
--
-- HAND-AUTHORED: the seed and the retrofit foreign key are not things a
-- schema diff generates.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS "financial_statement_line" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code"               text NOT NULL,
  "name"               text NOT NULL,
  "statement"          text NOT NULL,
  "parent_id"          uuid REFERENCES "financial_statement_line"("id"),
  "is_header"          boolean NOT NULL DEFAULT false,
  "ordinal"            integer NOT NULL,
  "role"               text,
  "side"               text,
  "cash_flow_category" text,
  "is_cash"            boolean NOT NULL DEFAULT false,
  "is_system"          boolean NOT NULL DEFAULT false,

  CONSTRAINT "financial_statement_line_statement_check"
    CHECK (statement IN ('income_statement', 'balance_sheet')),
  CONSTRAINT "financial_statement_line_role_check"
    CHECK (role IS NULL OR role IN
      ('revenue', 'cost_of_sales', 'other_income', 'operating_expenses', 'finance_costs', 'tax_expense')),
  CONSTRAINT "financial_statement_line_side_check"
    CHECK (side IS NULL OR side IN ('asset', 'equity', 'liability')),
  CONSTRAINT "financial_statement_line_category_check"
    CHECK (cash_flow_category IS NULL OR cash_flow_category IN ('operating', 'investing', 'financing')),
  -- A line knows its statement's vocabulary: income lines carry a role and no
  -- side; balance-sheet lines a side and no role. Headers carry the side (it
  -- decides where the branch prints) but never a role of their own.
  CONSTRAINT "financial_statement_line_vocabulary_check"
    CHECK (
      (statement = 'income_statement' AND side IS NULL AND (is_header OR role IS NOT NULL))
      OR
      (statement = 'balance_sheet' AND role IS NULL AND side IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "financial_statement_line_code_key"
  ON "financial_statement_line" ("code");
CREATE INDEX IF NOT EXISTS "financial_statement_line_parent_idx"
  ON "financial_statement_line" ("parent_id");
CREATE INDEX IF NOT EXISTS "financial_statement_line_statement_idx"
  ON "financial_statement_line" ("statement");

-- ── The twelve lines every install starts from ─────────────────────────────
-- The same codes the chart already references, so nothing moves.
INSERT INTO "financial_statement_line"
  (code, name, statement, ordinal, role, side, cash_flow_category, is_cash, is_system)
VALUES
  ('non_current_assets',      'Non-current assets',        'balance_sheet',    10, NULL, 'asset',     'investing', false, true),
  ('current_assets',          'Current assets',            'balance_sheet',    20, NULL, 'asset',     'operating', false, true),
  ('cash_and_equivalents',    'Cash and cash equivalents', 'balance_sheet',    30, NULL, 'asset',     NULL,        true,  true),
  ('equity',                  'Equity',                    'balance_sheet',    40, NULL, 'equity',    'financing', false, true),
  ('non_current_liabilities', 'Non-current liabilities',   'balance_sheet',    50, NULL, 'liability', 'financing', false, true),
  ('current_liabilities',     'Current liabilities',       'balance_sheet',    60, NULL, 'liability', 'operating', false, true),
  ('revenue',                 'Revenue',                   'income_statement', 10, 'revenue',            NULL, 'operating', false, true),
  ('cost_of_sales',           'Cost of sales',             'income_statement', 20, 'cost_of_sales',      NULL, 'operating', false, true),
  ('other_income',            'Other income',              'income_statement', 30, 'other_income',       NULL, 'operating', false, true),
  ('operating_expenses',      'Operating expenses',        'income_statement', 40, 'operating_expenses', NULL, 'operating', false, true),
  ('finance_costs',           'Finance costs',             'income_statement', 50, 'finance_costs',      NULL, 'operating', false, true),
  ('tax_expense',             'Tax',                       'income_statement', 60, 'tax_expense',        NULL, 'operating', false, true)
ON CONFLICT (code) DO NOTHING;

-- ── The chart now answers to the mapping ───────────────────────────────────
-- Any assignment that names a line that does not exist falls back to the type
-- default (NULL), which is what the reports were already doing with it.
UPDATE "chart_of_account"
   SET "statement_line" = NULL
 WHERE "statement_line" IS NOT NULL
   AND "statement_line" NOT IN (SELECT code FROM "financial_statement_line");

DO $$ BEGIN
  ALTER TABLE "chart_of_account"
    ADD CONSTRAINT "chart_of_account_statement_line_fkey"
    FOREIGN KEY ("statement_line") REFERENCES "financial_statement_line"("code");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Company-wide configuration, like the fiscal calendar: no row-level scope.
-- DELETE is granted because a line nobody reports on may be removed; the
-- foreign keys above are what stop a referenced or parented line from going.
GRANT SELECT, INSERT, UPDATE, DELETE ON "financial_statement_line" TO erp_app;
