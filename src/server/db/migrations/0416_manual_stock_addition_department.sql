-- ===========================================================================
-- Manual Stock Addition (0415) — the department its journal is analysed by.
-- HAND-AUTHORED. Additive.
--
-- The inventory adjustment account an addition credits may ask for a
-- department (an expense account's §4.2 dimension); the first approval on the
-- development books was refused "Account … requires Department / Cost
-- Centre", exactly as a Stock Count's adjustment would be without its
-- department picker. The sheet now carries an optional Department, which the
-- journal's lines carry as their `department` dimension; like the rest of what
-- the document says, it is changed only in draft.
-- ===========================================================================

ALTER TABLE "manual_stock_addition" ADD COLUMN IF NOT EXISTS "department_code" text REFERENCES "department"("code");
--> statement-breakpoint

CREATE OR REPLACE FUNCTION manual_stock_addition_guard() RETURNS trigger
	LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.status IN ('approved', 'cancelled') THEN
		RAISE EXCEPTION 'Manual stock addition % is %; it does not change again.', OLD.addition_no, OLD.status
			USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
		(OLD.status = 'draft' AND NEW.status IN ('submitted', 'cancelled'))
		OR (OLD.status = 'submitted' AND NEW.status IN ('approved', 'rejected'))
		OR (OLD.status = 'rejected' AND NEW.status IN ('draft', 'cancelled'))
	) THEN
		RAISE EXCEPTION 'Manual stock addition % cannot go from % to %.', OLD.addition_no, OLD.status, NEW.status
			USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.addition_no IS DISTINCT FROM OLD.addition_no
		OR NEW.branch_code IS DISTINCT FROM OLD.branch_code
		OR NEW.created_by IS DISTINCT FROM OLD.created_by
		OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'Manual stock addition %: its number, branch and author never change.', OLD.addition_no
			USING ERRCODE = 'check_violation';
	END IF;
	IF OLD.status <> 'draft' AND (
		NEW.warehouse_code IS DISTINCT FROM OLD.warehouse_code
		OR NEW.posting_date IS DISTINCT FROM OLD.posting_date
		OR NEW.reason IS DISTINCT FROM OLD.reason
		OR NEW.offset_account_id IS DISTINCT FROM OLD.offset_account_id
		OR NEW.department_code IS DISTINCT FROM OLD.department_code
	) THEN
		RAISE EXCEPTION 'Manual stock addition % is %; what it says is changed only in draft.', OLD.addition_no, OLD.status
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END $$;
