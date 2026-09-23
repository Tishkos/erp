-- An invoice may name the accounts it posts to — by direction, 2026-09-22.
--
-- §3.3 says the posting engine never chooses an account on its own, and the
-- mappings are how it is told. This adds the other half the sponsor asked for:
-- a document may say, for itself, which account the statement is kept on and
-- which account the income or the cost belongs to — the way a journal entry
-- names its own accounts.
--
-- Both are nullable, and null is the normal case: the mapping (and, for
-- revenue, the item's own account) still answers. A value here is an
-- exception somebody typed, and it is recorded on the document, in the audit
-- trail, and on the journal line it produced.
--
-- The guardrail lives in the service, not here, because it is a sentence a
-- person must be able to read: the statement account has to be the control
-- account of the right kind, or the subledger stops reconciling to the
-- ledger and the partner's statement quietly loses the document.
ALTER TABLE ar_invoice
  ADD COLUMN receivable_account_id uuid REFERENCES chart_of_account(id),
  ADD COLUMN revenue_account_id uuid REFERENCES chart_of_account(id);
--> statement-breakpoint
ALTER TABLE ap_invoice
  ADD COLUMN payable_account_id uuid REFERENCES chart_of_account(id),
  ADD COLUMN expense_account_id uuid REFERENCES chart_of_account(id);
--> statement-breakpoint
COMMENT ON COLUMN ar_invoice.receivable_account_id IS
  'Chosen on the invoice; null means the sales.ar_invoice customer_receivable mapping. Must be a customer control account.';
--> statement-breakpoint
COMMENT ON COLUMN ar_invoice.revenue_account_id IS
  'Chosen on the invoice; null means the item''s sales account, then the sales_revenue mapping.';
--> statement-breakpoint
COMMENT ON COLUMN ap_invoice.payable_account_id IS
  'Chosen on the invoice; null means the purchasing.ap_invoice supplier_payable mapping. Must be a supplier control account.';
--> statement-breakpoint
COMMENT ON COLUMN ap_invoice.expense_account_id IS
  'Chosen on the invoice; null means the expense mapping. Service lines only — a stock line debits the item''s inventory account so the warehouse and the ledger hold one figure.';
--> statement-breakpoint
-- Changing them after the document has left draft would move a posted figure
-- without a trail, so the same guard the accounting dimensions have.
INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('ar_invoice', 'receivable_account_id', 'The account this invoice is kept on; changing it requires draft status and fresh approval.'),
  ('ar_invoice', 'revenue_account_id',    'Where this invoice''s income is posted; changing it requires draft status and fresh approval.'),
  ('ap_invoice', 'payable_account_id',    'The account this invoice is kept on; changing it requires draft status and fresh approval.'),
  ('ap_invoice', 'expense_account_id',    'Where this invoice''s cost is posted; changing it requires draft status and fresh approval.')
ON CONFLICT DO NOTHING;
