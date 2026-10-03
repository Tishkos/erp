-- A bank whose name is its own SWIFT code.
--
-- 0232 seeded the five banks the PD sheet names, and four of them carry the
-- name a person would say: Mansour Bank, Arab Bank, National Bank of Iraq,
-- Rafidain Bank. The fifth was entered as `BABIIQBA` — which is its SWIFT
-- code, not its name — so every Bank field in the system offers
-- "BABIIQBA · BABIIQBAXXX" and reads as a placeholder somebody forgot to
-- fill in. Reported from the Register PD screen, 2026-10-02.
--
-- BABIIQBA is Bank of Baghdad. Only the row that still carries the wrong name
-- is touched, so a name the treasury has since corrected on the Banks screen
-- is left exactly as they left it.

UPDATE "bank"
   SET "name" = 'Bank of Baghdad'
 WHERE "swift_bic" = 'BABIIQBAXXX'
   AND "name" = 'BABIIQBA';
