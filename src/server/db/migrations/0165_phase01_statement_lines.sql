-- Phase 1 requirement 5 — "Accounts can be assigned to the correct financial
-- statement lines."
--
-- One column, because that is what the requirement is: a property of the
-- account, decided once by Finance, read by every statement afterwards. A
-- separate mapping table would let the same account appear on two lines, and
-- an account that appears twice on a statement is a statement that does not
-- add up.
--
-- Nullable on purpose. An account with no line assigned still reports — it
-- falls to its type's default line (see `domain/financial-statements.ts`), so
-- the statements are right on the first day and become more precise as Finance
-- works through the chart. Making it NOT NULL would mean guessing a line for
-- every account that already exists, and a guess stored in the database is
-- indistinguishable from a decision.

ALTER TABLE chart_of_account ADD COLUMN IF NOT EXISTS statement_line text;--> statement-breakpoint

ALTER TABLE chart_of_account ADD CONSTRAINT chart_of_account_statement_line_known
  CHECK (statement_line IS NULL OR statement_line IN (
    'non_current_assets', 'current_assets', 'cash_and_equivalents',
    'equity', 'non_current_liabilities', 'current_liabilities',
    'revenue', 'cost_of_sales', 'other_income',
    'operating_expenses', 'finance_costs', 'tax_expense'
  ));--> statement-breakpoint

-- The line has to belong to the same statement the account's type does. A
-- revenue account on 'current_assets' would be a silent hole in both
-- statements at once, so the database refuses it rather than the screen.
ALTER TABLE chart_of_account ADD CONSTRAINT chart_of_account_statement_line_fits_type
  CHECK (
    statement_line IS NULL
    OR (account_type = 'asset'     AND statement_line IN ('non_current_assets', 'current_assets', 'cash_and_equivalents'))
    OR (account_type = 'liability' AND statement_line IN ('non_current_liabilities', 'current_liabilities'))
    OR (account_type = 'equity'    AND statement_line = 'equity')
    OR (account_type = 'revenue'   AND statement_line IN ('revenue', 'other_income'))
    OR (account_type = 'expense'   AND statement_line IN ('cost_of_sales', 'operating_expenses', 'finance_costs', 'tax_expense'))
  );--> statement-breakpoint

COMMENT ON COLUMN chart_of_account.statement_line IS
  'Phase 1 §5 — the line of the Statement of Profit or Loss or Statement of Financial Position this account reports on. NULL falls to the account type default.';--> statement-breakpoint

-- Phase 1 §3 — a reversal is created and posted in one act.
--
-- It is not a document anybody drafts and submits: it is the mirror of one
-- that has already been approved, and the authority to reverse is the
-- authority to post it. The status machine should say so rather than leave the
-- reversal path looking like a hole somebody forgot to close.
INSERT INTO document_status_transition (document_type_code, from_status, to_status)
VALUES ('journal_entry', 'draft', 'posted')
ON CONFLICT DO NOTHING;--> statement-breakpoint
