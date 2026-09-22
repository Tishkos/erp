-- Business Line and Department are not asked of an invoice — by direction,
-- 2026-09-22.
--
-- §4.2 makes a dimension "mandatory or optional by account and document type",
-- and §4.2's own table makes Business Line mandatory for revenue and direct
-- cost *by account type*. That default is what reached the sponsor: block 5's
-- header carries the invoice number, the two dates and the customer, so a
-- direct invoice had no business line to give, and the posting refused it
-- until the screen grew two fields the block never asked for.
--
-- The document type is the layer §4.2 provides for exactly this, and it sits
-- above the account-type default (see domain/dimensions.ts). So the rule is
-- written where the blueprint says it belongs rather than removed from the
-- chart, and an account that requires Business Line still does — on every
-- document except these.
INSERT INTO document_type_dimension (document_type_code, dimension, requirement) VALUES
  ('ar_invoice', 'business_line', 'optional'),
  ('ar_invoice', 'department',    'optional'),
  ('ap_invoice', 'business_line', 'optional'),
  ('ap_invoice', 'department',    'optional')
ON CONFLICT (document_type_code, dimension) DO UPDATE SET requirement = 'optional';
