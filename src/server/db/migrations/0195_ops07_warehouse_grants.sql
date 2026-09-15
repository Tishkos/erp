-- Who may set up a warehouse — Operations build, block 7 (2026-09-15).
--
-- `warehouse` was granted to system_administrator alone, back when warehouses
-- only came into being as a side effect of creating a branch. Nobody needed a
-- verb over them because nobody could make one on purpose.
--
-- Block 7 gives them a screen, and the people who use it are the people who
-- run operations. So the accounting manager gets the same three verbs they hold
-- over the rest of the operational master data, and the officer gets `view` —
-- which is what a picker on a Purchase Invoice needs to offer the list.
--
-- This is the third time a screen has been built against an object no business
-- role could reach (financial_statement, bank_account, and now this). The
-- pattern is always the same: the service is right, the tests pass because they
-- post as a super user, and the first real person to open the screen is told
-- they are not allowed. Worth naming here so the next screen checks its grants
-- before it checks anything else.
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_manager', 'warehouse', 'view'),
  ('accounting_manager', 'warehouse', 'create'),
  ('accounting_manager', 'warehouse', 'configure'),
  ('accounting_officer', 'warehouse', 'view')
ON CONFLICT DO NOTHING;
