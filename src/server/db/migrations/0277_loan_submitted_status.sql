-- A loan may be waiting for approval.
--
-- 0273 put `submitted` between draft and approved — the step where the bank's
-- offer and its schedule sit with somebody else — and added the service, the
-- status list and the transitions. It did not touch the CHECK that 0235 wrote
-- on the column, which still named five statuses, so the first loan anybody
-- sent for approval was refused by the database:
--
--   new row for relation "bank_loan" violates check constraint "bank_loan_status"
--
-- The constraint is the backstop, and a backstop that disagrees with the
-- application is worse than none: it refuses the right thing for the wrong
-- reason, at the moment somebody is trying to work. It knows the sixth status
-- now.

ALTER TABLE "bank_loan" DROP CONSTRAINT IF EXISTS "bank_loan_status";
--> statement-breakpoint
ALTER TABLE "bank_loan"
  ADD CONSTRAINT "bank_loan_status"
  CHECK ("status" IN ('draft', 'submitted', 'approved', 'active', 'fully_repaid', 'cancelled'));
