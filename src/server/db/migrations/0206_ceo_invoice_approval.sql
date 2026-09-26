-- ---------------------------------------------------------------------------
-- The invoices wait for the CEO — Operations build, blocks 4 and 5.
--
--   4. Purchase Invoice   Posting: The Purchase Invoice is not posted until
--                         it receives CEO approval.
--   5. Sales Invoice      Posting: The Sales Invoice is not posted until it
--                         receives CEO approval.
--
-- Until now the verb that stood for that approval, `approve`, was held by the
-- Accounting Manager — so the person who ran the accounts could raise, approve
-- and post an invoice with nobody above them seeing it. There was no CEO in
-- the system at all.
--
-- So there is one now, and the approval moves to it:
--
--   CEO                 view, approve, post and print on both invoices. On a
--                       purchase invoice approving *is* posting (the service
--                       asks for both verbs); on a sales invoice the CEO
--                       approves, and may post it straight after. And
--                       `execute` on stock movements, because posting either
--                       invoice moves its stock in the same transaction and
--                       the inventory service asks for it.
--
--   Accounting Manager  loses `approve` on both invoices, and `post` on the
--                       purchase invoice, which it could only ever use with
--                       `approve`. It keeps `post` on the sales invoice: once
--                       the CEO has approved one, booking it is an accounting
--                       task, and the status machine refuses to post a sales
--                       invoice that has not been approved.
--
-- `is_system` because the role is part of the build rather than something an
-- administrator made up — it cannot be deleted from the Roles screen, the same
-- as the three accounting roles beside it.
-- ---------------------------------------------------------------------------
INSERT INTO role (code, name, description, is_system) VALUES
  ('ceo', 'CEO',
   'Approves purchase and sales invoices. Neither invoice posts without it (Operations build, blocks 4 and 5).',
   true)
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('ceo', 'ap_invoice', 'view'),
  ('ceo', 'ap_invoice', 'approve'),
  ('ceo', 'ap_invoice', 'post'),
  ('ceo', 'ap_invoice', 'print'),
  ('ceo', 'ar_invoice', 'view'),
  ('ceo', 'ar_invoice', 'approve'),
  ('ceo', 'ar_invoice', 'post'),
  ('ceo', 'ar_invoice', 'print'),
  ('ceo', 'inventory_movement', 'execute')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DELETE FROM role_grant
 WHERE role_code = 'accounting_manager'
   AND ((object = 'ap_invoice' AND verb IN ('approve', 'post'))
     OR (object = 'ar_invoice' AND verb = 'approve'));
