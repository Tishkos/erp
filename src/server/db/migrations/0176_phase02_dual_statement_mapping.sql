-- ===========================================================================
-- Independent Income Statement and Balance Sheet account mappings.
--
-- A revenue or expense account keeps its primary Income Statement line in
-- statement_line and may additionally be presented on a configured equity
-- line through balance_sheet_line. The two choices must not overwrite each
-- other, and direct SQL receives the same validation as the service layer.
-- ===========================================================================

ALTER TABLE "chart_of_account"
  ADD COLUMN IF NOT EXISTS "balance_sheet_line" text;

-- These constraints belonged to the original hard-coded twelve-line list.
-- Finance can now create its own lines, so validity must be read from the
-- financial_statement_line table instead.
ALTER TABLE "chart_of_account"
  DROP CONSTRAINT IF EXISTS "chart_of_account_statement_line_known";
ALTER TABLE "chart_of_account"
  DROP CONSTRAINT IF EXISTS "chart_of_account_statement_line_fits_type";

DO $$ BEGIN
  ALTER TABLE "chart_of_account"
    ADD CONSTRAINT "chart_of_account_balance_sheet_line_fkey"
    FOREIGN KEY ("balance_sheet_line") REFERENCES "financial_statement_line"("code");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION chart_of_account_statement_mapping_valid()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  primary_statement text;
  primary_role text;
  primary_side text;
  primary_header boolean;
  balance_statement text;
  balance_side text;
  balance_header boolean;
BEGIN
  IF NEW.is_group AND (NEW.statement_line IS NOT NULL OR NEW.balance_sheet_line IS NOT NULL) THEN
    RAISE EXCEPTION
      'Header account % cannot carry a financial statement mapping; map its posting accounts instead.',
      NEW.code;
  END IF;

  IF NEW.statement_line IS NOT NULL THEN
    SELECT statement, role, side, is_header
      INTO primary_statement, primary_role, primary_side, primary_header
      FROM financial_statement_line
     WHERE code = NEW.statement_line;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Financial statement line % does not exist.', NEW.statement_line;
    END IF;
    IF primary_header THEN
      RAISE EXCEPTION 'Account % cannot map to header line %.', NEW.code, NEW.statement_line;
    END IF;
    IF NOT (
      (NEW.account_type = 'asset' AND primary_statement = 'balance_sheet' AND primary_side = 'asset')
      OR (NEW.account_type = 'liability' AND primary_statement = 'balance_sheet' AND primary_side = 'liability')
      OR (NEW.account_type = 'equity' AND primary_statement = 'balance_sheet' AND primary_side = 'equity')
      OR (NEW.account_type = 'revenue' AND primary_statement = 'income_statement'
          AND primary_role IN ('revenue', 'other_income'))
      OR (NEW.account_type = 'expense' AND primary_statement = 'income_statement'
          AND primary_role IN ('cost_of_sales', 'operating_expenses', 'finance_costs', 'tax_expense'))
    ) THEN
      RAISE EXCEPTION
        'Primary statement line % does not fit % account %.',
        NEW.statement_line, NEW.account_type, NEW.code;
    END IF;
  END IF;

  IF NEW.balance_sheet_line IS NOT NULL THEN
    IF NEW.account_type NOT IN ('revenue', 'expense') THEN
      RAISE EXCEPTION
        'Only revenue and expense accounts can have a second Balance Sheet mapping; account % is %.',
        NEW.code, NEW.account_type;
    END IF;

    SELECT statement, side, is_header
      INTO balance_statement, balance_side, balance_header
      FROM financial_statement_line
     WHERE code = NEW.balance_sheet_line;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Balance Sheet line % does not exist.', NEW.balance_sheet_line;
    END IF;
    IF balance_header OR balance_statement <> 'balance_sheet' OR balance_side <> 'equity' THEN
      RAISE EXCEPTION
        'Balance Sheet mapping % for account % must be a posting line under Equity.',
        NEW.balance_sheet_line, NEW.code;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chart_of_account_statement_mapping_valid
  ON chart_of_account;
CREATE TRIGGER chart_of_account_statement_mapping_valid
  BEFORE INSERT OR UPDATE OF account_type, is_group, statement_line, balance_sheet_line
  ON chart_of_account
  FOR EACH ROW EXECUTE FUNCTION chart_of_account_statement_mapping_valid();

COMMENT ON COLUMN chart_of_account.balance_sheet_line IS
  'Optional equity presentation for a revenue or expense account, independent of its Income Statement line.';
