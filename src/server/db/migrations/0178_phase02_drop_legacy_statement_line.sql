-- ===========================================================================
-- The legacy single mapping goes.
--
-- 0177 replaced `chart_of_account.statement_line` with one column per report
-- and left it in place for a release, so the version being replaced went on
-- working while the new one built. That release shipped a long time ago and
-- nothing has read the column since.
--
-- Leaving it was not free. Its foreign key still pointed at the mapping, so a
-- line no account reports on — the screen counts the four real columns and
-- says "0 accounts" — could not be removed: the delete was refused by a
-- constraint protecting a column the application had stopped using. A person
-- was told their line was in use by something they could not see.
--
-- The column and its key go together. No account changes hands, no journal is
-- touched: this drops a copy of an answer that is held properly elsewhere.
-- ===========================================================================

ALTER TABLE "chart_of_account"
  DROP CONSTRAINT IF EXISTS "chart_of_account_statement_line_fkey";

ALTER TABLE "chart_of_account"
  DROP COLUMN IF EXISTS "statement_line";
