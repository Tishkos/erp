-- "A new payment term can be defined whenever required." — Operations build,
-- blocks 2 and 3.
--
-- Nobody but a Super User could: `payment_term` had no grants at all, so the
-- accounting staff who create customers and suppliers had to stop and find an
-- administrator every time a partner came with terms the list did not have.
-- The Accounting Manager, who already maintains the partners, now maintains
-- their terms too; the officer can see them.
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_manager', 'payment_term', 'view'),
  ('accounting_manager', 'payment_term', 'create'),
  ('accounting_manager', 'payment_term', 'configure'),
  ('accounting_officer', 'payment_term', 'view')
ON CONFLICT DO NOTHING;
