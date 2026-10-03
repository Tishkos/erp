-- Bank and cash accounts are company-wide masters. Each money movement keeps
-- its own branch; the account itself does not belong to one branch.
ALTER TABLE bank_cash_account
  DROP CONSTRAINT bank_cash_account_branch_code_branch_code_fk,
  DROP COLUMN branch_code;--> statement-breakpoint

-- Keep document type checks while allowing a company account to be used from
-- any branch. Branch ownership remains on each count, statement, and advance.
CREATE OR REPLACE FUNCTION cash_count_is_of_a_cash_account() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_type text;
  v_code text;
BEGIN
  SELECT account_type::text, code
    INTO v_type, v_code
    FROM bank_cash_account WHERE id = NEW.bank_cash_account_id;

  IF v_type IS DISTINCT FROM 'cash' THEN
    RAISE EXCEPTION
      '% is a % account. A physical count is of cash in a drawer; a bank account is agreed against a statement instead (blueprint 17).',
      v_code, coalesce(v_type, 'missing')
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION bank_statement_is_of_a_bank_account() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_type text;
  v_code text;
BEGIN
  SELECT account_type::text, code
    INTO v_type, v_code
    FROM bank_cash_account WHERE id = NEW.bank_cash_account_id;

  IF v_type IS DISTINCT FROM 'bank' THEN
    RAISE EXCEPTION
      '% is a % account. A statement comes from a bank; a cash float is agreed by counting it instead (blueprint 17).',
      v_code, coalesce(v_type, 'missing')
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION cash_advance_is_from_a_float() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_type text;
  v_code text;
BEGIN
  SELECT account_type::text, code
    INTO v_type, v_code
    FROM bank_cash_account WHERE id = NEW.bank_cash_account_id;

  IF v_type IS DISTINCT FROM 'cash' THEN
    RAISE EXCEPTION
      '% is a % account. A petty cash advance comes out of a float; money sent from a bank account is a payment, with its own approval and beneficiary checks (blueprint 17).',
      v_code, coalesce(v_type, 'missing')
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION other_receipt_matches_its_account() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_ccy text;
  v_code text;
BEGIN
  SELECT currency, code INTO v_ccy, v_code
    FROM bank_cash_account WHERE id = NEW.bank_cash_account_id;

  IF NEW.currency IS DISTINCT FROM v_ccy THEN
    RAISE EXCEPTION
      'Receipt says it arrived in % but % is held in %.', NEW.currency, v_code, v_ccy
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
