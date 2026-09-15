-- A Purchase Invoice that receives its own stock — Operations block 4.
--
-- §15 asks an invoice with no purchase order for a written justification and a
-- second approver, because *"the three-way match cannot protect a charge that
-- no order and no receipt describe"*. The database holds that as a CHECK.
--
-- Block 4's invoice describes the receipt. Every line names the warehouse its
-- goods arrive in, and posting puts them there: the evidence §15 wants is the
-- document being approved. What is left unguarded is the charge, and block 4
-- holds that behind *"the invoice is not posted until CEO approval"* — a
-- separate verb the person who raised it does not hold.
--
-- Without this the sponsor's screen could not raise a single invoice. The form
-- has one person on it, and the rule refuses an approver who is the raiser, so
-- every attempt failed on a control that was already satisfied by the posting
-- approval underneath it.
--
-- ── Why a column and not a looser check ───────────────────────────────────
-- The evidence lives on the lines — each one's warehouse — and a CHECK on the
-- header cannot see them. So the header states which route it took, the service
-- sets it from the lines it just wrote, and the constraint reads one field
-- rather than trusting the application to have looked.

ALTER TABLE "ap_invoice"
  ADD COLUMN IF NOT EXISTS "receives_own_stock" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

COMMENT ON COLUMN "ap_invoice"."receives_own_stock" IS
  'True when every line names a warehouse, so the invoice is itself the receipt '
  'and §15''s non-PO evidence is the document. Set by the service from the lines.';
--> statement-breakpoint

ALTER TABLE "ap_invoice" DROP CONSTRAINT IF EXISTS "ap_invoice_non_po_needs_justification";
--> statement-breakpoint

ALTER TABLE "ap_invoice"
  ADD CONSTRAINT "ap_invoice_non_po_needs_justification"
  CHECK (
    "purchase_order_id" IS NOT NULL
    OR "receives_own_stock"
    OR (
      coalesce(btrim("non_po_justification"), '') <> ''
      AND "non_po_approved_by" IS NOT NULL
      AND "non_po_approved_at" IS NOT NULL
    )
  );
