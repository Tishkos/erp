ALTER TABLE ap_invoice
  ADD COLUMN document_discount_percent numeric(9,4),
  ADD COLUMN document_discount_amount_iqd numeric(19,4),
  ADD CONSTRAINT ap_invoice_document_discount_form CHECK (document_discount_percent IS NULL OR document_discount_amount_iqd IS NULL),
  ADD CONSTRAINT ap_invoice_document_discount_range CHECK ((document_discount_percent IS NULL OR document_discount_percent BETWEEN 0 AND 100) AND (document_discount_amount_iqd IS NULL OR document_discount_amount_iqd >= 0));
--> statement-breakpoint
ALTER TABLE ar_invoice
  ADD COLUMN document_discount_percent numeric(9,4),
  ADD COLUMN document_discount_amount_iqd numeric(19,4),
  ADD CONSTRAINT ar_invoice_document_discount_form CHECK (document_discount_percent IS NULL OR document_discount_amount_iqd IS NULL),
  ADD CONSTRAINT ar_invoice_document_discount_range CHECK ((document_discount_percent IS NULL OR document_discount_percent BETWEEN 0 AND 100) AND (document_discount_amount_iqd IS NULL OR document_discount_amount_iqd >= 0));
--> statement-breakpoint
ALTER TABLE ap_invoice_line
  ADD COLUMN discount_percent numeric(9,4),
  ADD COLUMN document_discount_iqd numeric(19,4) NOT NULL DEFAULT 0,
  ADD CONSTRAINT ap_invoice_line_discount_percent_range CHECK (discount_percent IS NULL OR discount_percent BETWEEN 0 AND 100),
  ADD CONSTRAINT ap_invoice_line_document_discount_range CHECK (document_discount_iqd >= 0 AND discount_iqd + document_discount_iqd <= trunc(quantity * unit_price, 4));
--> statement-breakpoint
ALTER TABLE ar_invoice_line
  ADD COLUMN document_discount_iqd numeric(19,4) NOT NULL DEFAULT 0,
  ADD CONSTRAINT ar_invoice_line_document_discount_range CHECK (document_discount_iqd >= 0 AND document_discount_iqd <= gross_iqd - CASE WHEN discount_percent IS NOT NULL THEN trunc(gross_iqd * discount_percent / 100, 4) ELSE coalesce(discount_amount_iqd, 0) END);
--> statement-breakpoint
CREATE FUNCTION invoice_document_discount_draft_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (
    NEW.document_discount_percent IS DISTINCT FROM OLD.document_discount_percent
    OR NEW.document_discount_amount_iqd IS DISTINCT FROM OLD.document_discount_amount_iqd
  ) THEN
    RAISE EXCEPTION 'Invoice discounts can only be changed while the invoice is a draft.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ap_invoice_document_discount_draft_guard
  BEFORE UPDATE ON ap_invoice
  FOR EACH ROW EXECUTE FUNCTION invoice_document_discount_draft_guard();
--> statement-breakpoint
CREATE TRIGGER ar_invoice_document_discount_draft_guard
  BEFORE UPDATE ON ar_invoice
  FOR EACH ROW EXECUTE FUNCTION invoice_document_discount_draft_guard();
