-- Phase 00 — the line triggers have to be able to see the invoice.
--
-- Both functions read or write the parent `invoice` row, and both ran as the
-- calling role with row-level security in force. That is wrong in two
-- different ways, and only one of them is loud:
--
--   * `invoice_line_draft_only` could not always see the parent, read its
--     status as NULL, and refused a perfectly good line — a false alarm, but
--     at least an alarm.
--   * `invoice_retotal` would have updated **no rows** in the same situation,
--     leaving the invoice's total quietly stale while every line was correct.
--     A total that is silently wrong is worse than a refusal.
--
-- Neither function is an access control — the policy on `invoice_line`
-- already decides who may see a line, and it decides it by asking about the
-- parent. These two are integrity guards, so they run as the owner and read
-- what is actually there.

CREATE OR REPLACE FUNCTION invoice_retotal() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invoice uuid := COALESCE(NEW.invoice_id, OLD.invoice_id);
BEGIN
  UPDATE invoice
     SET amount     = COALESCE((SELECT sum(line_total) FROM invoice_line WHERE invoice_id = v_invoice), 0),
         updated_at = now()
   WHERE id = v_invoice;
  RETURN NULL;
END $$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION invoice_line_draft_only() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status document_status;
BEGIN
  SELECT status INTO v_status FROM invoice WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);

  -- No parent at all is a different fault from a parent past draft, and
  -- saying so saves somebody an hour.
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'That invoice does not exist, so a line cannot be put on it.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_status <> 'draft' THEN
    RAISE EXCEPTION
      'The lines of an invoice can only be changed while it is a draft; this one is %.', v_status
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION invoice_retotal() FROM public;--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION invoice_line_draft_only() FROM public;--> statement-breakpoint
