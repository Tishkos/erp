-- Printing and exporting every Operations Build document and report.
--
-- The export routes authorise on the document's own object with the verbs the
-- permission model already has: `print` for the PDF, `export` for the Excel
-- and Word files. The invoices, payments, receipts and returns already carried
-- them. The screens Operations added later — Transfer, Opening Stock, Item
-- Reconciliation, Stock Movement, Invoice Status Tracking — and the reports
-- that were only ever read on screen had neither, so nobody but a Super User
-- could have printed them.
--
-- The same split as every existing grant: whoever reads the screen may print
-- it (the Accounting Manager and the officer); a working copy of the data
-- leaves with the manager's `export`.
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_manager', 'warehouse_transfer', 'print'),
  ('accounting_officer', 'warehouse_transfer', 'print'),
  ('accounting_manager', 'warehouse_transfer', 'export'),
  ('accounting_manager', 'opening_stock', 'print'),
  ('accounting_officer', 'opening_stock', 'print'),
  ('accounting_manager', 'opening_stock', 'export'),
  ('accounting_manager', 'stock_reconciliation', 'print'),
  ('accounting_officer', 'stock_reconciliation', 'print'),
  ('accounting_manager', 'stock_reconciliation', 'export'),
  ('accounting_manager', 'stock_movement', 'print'),
  ('accounting_officer', 'stock_movement', 'print'),
  ('accounting_manager', 'stock_movement', 'export'),
  ('accounting_manager', 'supplier_shipment', 'print'),
  ('accounting_officer', 'supplier_shipment', 'print'),
  ('accounting_manager', 'supplier_shipment', 'export'),
  -- The customer and supplier Account Statements authorise on the partner.
  ('accounting_manager', 'business_partner', 'print'),
  ('accounting_officer', 'business_partner', 'print'),
  ('accounting_manager', 'business_partner', 'export'),
  -- The Bank/Cash Account Statement, on the account's own record.
  ('accounting_manager', 'bank_account', 'print'),
  ('accounting_officer', 'bank_account', 'print'),
  ('accounting_manager', 'bank_account', 'export'),
  -- The finance reports: the manager could already export them.
  ('accounting_manager', 'trial_balance', 'print'),
  ('accounting_officer', 'trial_balance', 'print'),
  ('accounting_manager', 'financial_statement', 'print'),
  ('accounting_officer', 'financial_statement', 'print'),
  ('accounting_manager', 'gl_inquiry', 'print'),
  ('accounting_officer', 'gl_inquiry', 'print')
ON CONFLICT DO NOTHING;
