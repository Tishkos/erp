-- Phase 00 — a draft is allowed to be unfinished.
--
-- Pressing "New invoice" should open the document, with its number already
-- allocated, the way an ERP does — not a dialog demanding every field before
-- it will let you begin. That means an empty draft has to be a legal row.
--
-- The rules do not soften: they move to the moment they belong at. A draft may
-- have no customer and no lines; an invoice being *submitted* may have
-- neither, and the service refuses it in words the person can act on.

ALTER TABLE invoice DROP CONSTRAINT invoice_customer_present;--> statement-breakpoint

ALTER TABLE invoice ADD CONSTRAINT invoice_customer_present_unless_draft
  CHECK (status = 'draft' OR length(btrim(customer_name)) > 0);--> statement-breakpoint

COMMENT ON CONSTRAINT invoice_customer_present_unless_draft ON invoice IS
  'A draft may be unfinished; anything past draft names its customer.';--> statement-breakpoint
