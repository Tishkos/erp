-- ---------------------------------------------------------------------------
-- Notifications for money falling due — §15, §16 and §21.
--
-- Five events, on both sides. An invoice about to fall due, one falling due
-- today, one gone past its date, money arriving against one, and one that was
-- settled late. The last is not a chase — it is the record a credit controller
-- needs about a customer who always pays, eventually.
--
-- Who each goes to is the person whose job it is:
--
--   receivable events  → the Accounting Officer, who chases the customer
--   payable events     → the Accounting Manager, who decides what to pay and
--                        whose signature is on it being late
--
-- Only `in_app` to start with. E-mail on a daily sweep of every open invoice
-- is how people learn to filter a system into a folder they never open; the
-- channel is a column, so adding it later is a row change rather than a code
-- change.
--
-- No escalation. An escalation on "this invoice is due tomorrow" would fire
-- every day for every invoice and mean nothing by the end of the week. The
-- sweep re-raising it daily is the reminder, and the dedupe key keeps it to
-- one per invoice per day.
-- ---------------------------------------------------------------------------
INSERT INTO notification_rule
  (code, description, event_type, recipient_role, channels)
VALUES
  ('ar_invoice_due_soon',
   'A customer invoice falls due within the week.',
   'ar_invoice.due_soon', 'accounting_officer', ARRAY['in_app']),
  ('ar_invoice_due_today',
   'A customer invoice falls due today.',
   'ar_invoice.due_today', 'accounting_officer', ARRAY['in_app']),
  ('ar_invoice_overdue',
   'A customer invoice has passed its due date and is still unpaid.',
   'ar_invoice.overdue', 'accounting_officer', ARRAY['in_app']),
  ('ar_invoice_paid_late',
   'A customer invoice was settled after its due date — what the account actually does, rather than what its terms say.',
   'ar_invoice.paid_late', 'accounting_officer', ARRAY['in_app']),
  ('customer_receipt_received',
   'Money has arrived from a customer.',
   'customer_receipt.received', 'accounting_officer', ARRAY['in_app']),

  ('ap_invoice_due_soon',
   'A supplier invoice falls due within the week.',
   'ap_invoice.due_soon', 'accounting_manager', ARRAY['in_app']),
  ('ap_invoice_due_today',
   'A supplier invoice falls due today.',
   'ap_invoice.due_today', 'accounting_manager', ARRAY['in_app']),
  ('ap_invoice_overdue',
   'A supplier invoice has passed its due date and is still unpaid.',
   'ap_invoice.overdue', 'accounting_manager', ARRAY['in_app']),
  ('ap_invoice_paid_late',
   'A supplier invoice was settled after its due date.',
   'ap_invoice.paid_late', 'accounting_manager', ARRAY['in_app']),
  ('supplier_payment_made',
   'A payment has gone out to a supplier.',
   'supplier_payment.made', 'accounting_manager', ARRAY['in_app'])
ON CONFLICT (code) DO NOTHING;
