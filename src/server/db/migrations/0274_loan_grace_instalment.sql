-- An instalment inside a grace period asks for nothing, and that is a row.
--
-- 0235 held every instalment to `total_txn > 0`, which was right when every
-- schedule was equal principal: an instalment that asks for nothing is not an
-- instalment, and a zero row was a mistake somebody made.
--
-- 0273 let a loan carry the terms a bank's letter actually states, and two of
-- them produce a period where nothing is due: a grace that holds off both the
-- principal and the interest, and a bullet facility whose interest is held off
-- as well. The bank's own schedule lists those periods — "no payment due" —
-- and the register should list them too, because a schedule that silently
-- skips them no longer matches the letter it was typed from.
--
-- So the total may be nothing, and must still be exactly what its parts come
-- to. `instalmentState` leaves a row asking for nothing alone: there is nothing
-- to chase, nothing to pay, and nothing to fall overdue.

ALTER TABLE "bank_loan_instalment" DROP CONSTRAINT IF EXISTS "bank_loan_instalment_total";

ALTER TABLE "bank_loan_instalment"
  ADD CONSTRAINT "bank_loan_instalment_total"
  CHECK ("total_txn" >= 0 AND "total_txn" = "principal_txn" + "commission_txn" + "interest_txn");
