-- Bank and cash accounts are company-wide masters. Branches continue to carry
-- their own warehouse and each transaction carries its own branch dimension.
-- Remove the old branch-level default that forced a cash account to be created
-- with every branch and prevented retiring that cash account independently.
CREATE OR REPLACE FUNCTION branch_has_defaults() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_branch branch%ROWTYPE;
BEGIN
  SELECT * INTO v_branch FROM branch WHERE code = NEW.code;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_branch.default_warehouse_code IS NULL THEN
    RAISE EXCEPTION
      'Branch % has no default warehouse. Create the branch and its warehouse together.',
      v_branch.code USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NULL;
END;
$$;--> statement-breakpoint

ALTER TABLE branch
  DROP CONSTRAINT branch_default_cash_account_fk,
  DROP COLUMN default_cash_account_id;--> statement-breakpoint
