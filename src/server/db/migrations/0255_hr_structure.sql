-- REQ-FIX-001 FIX-5 — HR structure and the user link.
--
-- A position's code is minted, never typed (Critical Rule 1, as departments
-- in 0208): the Positions screen asks for a title and a department. Codes
-- typed before this keep their value; the counter starts past the highest
-- code already in the minted shape.
--
-- The user → employee link needs no schema: `employee.app_user_id` and its
-- unique index are HR-1's (0241). The backfill of existing users is
-- `scripts/ops/ensure-user-employees.ts`, run by the deploy after the
-- migrations, because each employee takes a number from its branch's series
-- and an audit row through the application.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('POSITION_CODE', 'POS', '{PREFIX}-{SERIAL}', 4, false, false)
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint

DO $$
DECLARE
  seq text := doc_sequence_name('POSITION_CODE', '');
  highest bigint;
BEGIN
  IF to_regclass(seq) IS NULL THEN
    EXECUTE format('CREATE SEQUENCE %I START 1', seq);
  END IF;
  SELECT coalesce(max(substring(code from '^POS-([0-9]+)$')::bigint), 0) INTO highest FROM "position";
  IF highest > 0 THEN
    PERFORM setval(seq, highest, true);
  END IF;
END $$;
