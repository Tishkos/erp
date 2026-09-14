-- Finance owns the bank and cash master — Operations block 6 (2026-09-12).
--
-- `bank_account` has had no grant on it, to any role, since the master was
-- built in Phase 03. Only a super user could raise a bank account, edit one or
-- take one out of use — and a super user holds no role, so this was never a
-- deliberate restriction. It is the same gap found on `financial_statement`
-- in 0180, and it went unnoticed for the same reason: every review of the
-- screen was done as a super user, for whom it works.
--
-- An accounting manager already configures the chart of accounts, the posting
-- rules, the payment terms and the tax codes. Which bank the company banks
-- with, and which ledger account it carries, belongs in the same hands.
--
-- `view` goes wider: a payment or a receipt names a bank account, so anyone
-- raising one has to be able to see the list. An accounting officer does that
-- work and cannot be asked to guess.
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_manager',    'bank_account', 'view'),
  ('accounting_manager',    'bank_account', 'create'),
  ('accounting_manager',    'bank_account', 'configure'),
  ('accounting_manager',    'bank_account', 'administer'),
  ('accounting_officer',    'bank_account', 'view'),
  ('system_administrator',  'bank_account', 'view')
ON CONFLICT DO NOTHING;
