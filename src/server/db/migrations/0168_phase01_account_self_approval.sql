-- ---------------------------------------------------------------------------
-- An accountant may approve the account they opened.
--
-- The Chart of Accounts route was seeded with `allow_self_approval = false`, so
-- the person who raises an account can never be the person who approves it.
-- That is a segregation-of-duties control, and it is the right one for a
-- finance team with a manager and an officer in it — but it is not what Phase 1
-- asks for, and it deadlocks a company that has one accountant: every account
-- they open waits forever for a second person who does not exist.
--
-- It is also inconsistent. `journal_entry` — a document that moves money — has
-- allowed self-approval since 0006. An account is a label that a journal points
-- at. Holding the label to a stricter standard than the money is backwards.
--
-- Tighten this again when a phase introduces segregation of duties properly:
-- flip the flag back and the maker-checker returns, with no other change.
-- ---------------------------------------------------------------------------
UPDATE workflow_step
   SET allow_self_approval = true
 WHERE definition_id = '00000000-0000-4000-8000-000000000001'
   AND sequence = 1;
