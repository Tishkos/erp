-- ---------------------------------------------------------------------------
-- Throwing away a draft.
--
-- Nothing in this system has ever been deleted: `erp_app` holds SELECT, INSERT
-- and UPDATE and no DELETE at all, so a document could only ever gain a status.
-- That is the right default and it stays the default. What it also did was keep
-- every abandoned draft for ever, so a list of real invoices filled up with
-- half-typed attempts nobody could clear.
--
-- §7 is about *documents* — things that entered the flow and that somebody may
-- later be asked to account for. A draft entered nothing. So the grant is
-- given, and then immediately fenced:
--
--   * the delete guards below refuse anything that is not a draft, so the rule
--     holds even for a caller that never goes through the service;
--   * the services write the audit event *before* the rows go, so the trail
--     still says the document existed, what number it held, and who threw it
--     away;
--   * the number is not returned to its series — §4.3 and §14.2 both say a
--     number is never reused, and the gap is the honest record of an abandoned
--     draft.
--
-- `journal_entry_reject_delete` already existed and refused a **posted** or
-- reversed entry. It is widened here rather than joined by a second trigger:
-- two guards on one table fire in name order and the loser's message is never
-- seen, so a reader would be told a half-truth about which rule stopped them.
-- The posted wording is kept exactly, because that is the case people meet.
-- ---------------------------------------------------------------------------

GRANT DELETE ON journal_entry, journal_line, invoice, invoice_line TO erp_app;--> statement-breakpoint
GRANT DELETE ON attachment, attachment_access TO erp_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION journal_entry_reject_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('posted', 'reversed') THEN
    RAISE EXCEPTION
      'Journal % is posted and cannot be deleted (§14.4, §1.1). Correct it by full reversal.',
      OLD.entry_no USING ERRCODE = 'restrict_violation';
  END IF;

  -- Submitted, approved, rejected, cancelled: all documents, none of them a
  -- draft. Only the unfinished thing may go.
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION
      'Journal % is %, not a draft, so it cannot be deleted (§7). Only a draft can be thrown away.',
      OLD.entry_no, OLD.status USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN OLD;
END;
$$;--> statement-breakpoint

-- The same for an invoice, which had no delete guard at all — it did not need
-- one while nobody could delete anything.
--
-- SECURITY DEFINER, for the reason 0164 gives: a guard that cannot see the row
-- it is guarding silently passes, and that is the one failure a guard must not
-- have. Its lines are already covered by `invoice_line_draft_only`.
CREATE OR REPLACE FUNCTION invoice_reject_delete() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION
      'Invoice % is %, not a draft, so it cannot be deleted (§7). An approved invoice is cancelled or reversed, which leaves it on the record.',
      OLD.document_no, OLD.status USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint

CREATE TRIGGER invoice_reject_delete
  BEFORE DELETE ON invoice
  FOR EACH ROW EXECUTE FUNCTION invoice_reject_delete();--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION invoice_reject_delete() FROM public;--> statement-breakpoint

-- An attachment is never deleted on its own — §21's retention rules decide
-- that, and `dispose` is how it happens. The grant above exists only so a draft
-- can take its own attachments with it, and a legal hold is checked in the
-- service before any of them are touched.
