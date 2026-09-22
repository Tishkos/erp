ALTER TABLE ar_invoice
  ADD COLUMN business_line_code text,
  ADD COLUMN department_code text;
--> statement-breakpoint
ALTER TABLE ar_invoice
  ADD CONSTRAINT ar_invoice_business_line_code_business_line_code_fk
    FOREIGN KEY (business_line_code) REFERENCES business_line(code),
  ADD CONSTRAINT ar_invoice_department_code_department_code_fk
    FOREIGN KEY (department_code) REFERENCES department(code);
--> statement-breakpoint
CREATE FUNCTION ar_invoice_accounting_dimensions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.business_line_code IS DISTINCT FROM OLD.business_line_code
        OR NEW.department_code IS DISTINCT FROM OLD.department_code)
       AND (OLD.status <> 'draft' OR OLD.journal_entry_id IS NOT NULL OR OLD.posted_at IS NOT NULL) THEN
      RAISE EXCEPTION
        'Accounting dimensions can only be changed on a draft invoice. Return an approved invoice to draft and obtain fresh approval; posted invoices are immutable.'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF (NEW.sales_order_id IS NOT NULL OR NEW.delivery_note_id IS NOT NULL)
     AND (NEW.business_line_code IS NOT NULL OR NEW.department_code IS NOT NULL) THEN
    RAISE EXCEPTION
      'A source-linked invoice inherits its accounting dimensions from the sales order; direct-invoice overrides are not allowed.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ar_invoice_accounting_dimensions_guard
  BEFORE INSERT OR UPDATE OF business_line_code, department_code, sales_order_id, delivery_note_id
  ON ar_invoice FOR EACH ROW
  EXECUTE FUNCTION ar_invoice_accounting_dimensions_guard();
--> statement-breakpoint
INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('ar_invoice', 'business_line_code', 'Direct invoice accounting classification; changing it requires draft status and fresh approval.'),
  ('ar_invoice', 'department_code', 'Direct invoice cost attribution; changing it requires draft status and fresh approval.')
ON CONFLICT DO NOTHING;
