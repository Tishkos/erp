-- Phase 00 requirement 7 — the one common structure, applied literally.
--
--   "Future ERP documents follow one common structure: Draft, Pending
--    Approval where applicable, Approved/Final, Cancelled, and Reversed
--    where applicable. A saved record is not deleted; it remains in the
--    system history."
--
-- Five states, and no sixth. Migration 0160 gave the invoice a `rejected`
-- state, which is one more than the standard has — so a refused invoice now
-- goes back to **Draft**, where the person who raised it can correct and
-- resubmit it. Nothing is lost by that: the refusal, its reason and its
-- author are in the approval history and the audit trail, which is where the
-- standard says the record of what happened belongs.
--
-- The other half of the structure is `Reversed`, which is what happens to a
-- document that has already been approved. Cancellation is for one that has
-- not: a draft, or one still waiting on its approver.

DELETE FROM document_status_transition
 WHERE document_type_code = 'invoice'
   AND (to_status = 'rejected' OR from_status = 'rejected'
        OR (from_status = 'approved' AND to_status = 'cancelled'));--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  -- Withdrawn before anybody decided on it.
  ('invoice', 'submitted', 'cancelled'),
  -- §7 — an approved document is undone by reversal, never by editing or
  -- deleting it. The reversal is a new fact about the record, not the
  -- removal of an old one.
  ('invoice', 'approved',  'reversed')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- What the approver said when they sent it back. It lives on the invoice, not
-- only in the history, because the person who has to fix it needs to read it
-- on the record they are fixing — and it is cleared the moment they resubmit.
ALTER TABLE invoice ADD COLUMN IF NOT EXISTS returned_reason text;--> statement-breakpoint
