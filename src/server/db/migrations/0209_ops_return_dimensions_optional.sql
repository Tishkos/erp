-- Department is not asked of a sales return or an item reconciliation — the
-- same reasoning as 0201 gave the two invoices.
--
-- §4.2's account-type default makes Department mandatory on every expense
-- account, and both documents post to one: a sales return credits Cost of
-- Goods Sold when the goods come back (block 9), and a reconciliation debits
-- or credits the inventory adjustment account (block 7). Neither form carries
-- a Department, because the build lists none — so on an installation whose
-- expense accounts keep the default, both were refused at posting with a
-- message about a field the screen does not have.
--
-- The document-type layer sits above the account-type default, so this is the
-- place the rule belongs: an expense account still requires a Department on
-- every document except these.
-- The two block 7 documents join the register every other document is in.
INSERT INTO document_type (code, name, module, description) VALUES
  ('stock_transfer', 'Transfer', 'inventory',
   'Moves stock from one warehouse to another at the cost it carries (Operations block 7).'),
  ('stock_adjustment', 'Item Reconciliation', 'inventory',
   'Brings the system quantity to the actual quantity, In or Out (Operations block 7).')
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

INSERT INTO document_type_dimension (document_type_code, dimension, requirement) VALUES
  ('sales_return',     'department', 'optional'),
  ('stock_adjustment', 'department', 'optional')
ON CONFLICT (document_type_code, dimension) DO UPDATE SET requirement = 'optional';
