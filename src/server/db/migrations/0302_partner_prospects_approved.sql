-- 0302 — the partners the Customers and Suppliers screens entered are approved.
--
-- §6: a business partner is usable on a purchase order or a sales order once it
-- is approved (status 'active'); a prospect is refused (0031's trigger,
-- `purchase-order.assertSupplierUsable`, `sales-order`). Until 2026-10-04 the
-- screens (`partners.createInRole`) never set the status, so every partner
-- they made was born a 'prospect' — and nothing in the application could
-- approve one. The screens showed the in-use flag as a green "Active" while
-- the purchase order said "SUP-000001 is prospect, so a purchase order cannot
-- be raised against them". From this release a partner entered by somebody who
-- holds `approve` on business_partner is entered approved, and a prospect is
-- approved on its record (`partners.approve`).
--
-- The partners entered before are corrected here, because nobody chose their
-- status: master data entered them on the only screens there were, they are
-- already named on invoices and receipts, and the document pickers now offer
-- approved partners only — left as prospects they would vanish from every
-- form. A prospect somebody did choose is left alone: one created by a data
-- import whose file gave a status column (`import_row.raw_values.status`).
--
-- Each correction is an append-only audit row, with no actor (the release
-- made it), so the trail says why the status moved.
SELECT set_config('app.is_super_user', 'true', true);
--> statement-breakpoint
WITH corrected AS (
	UPDATE "business_partner" bp
	   SET "status" = 'active', "updated_at" = now()
	 WHERE bp."status" = 'prospect'
	   AND NOT EXISTS (
		SELECT 1
		  FROM "import_row" r
		  JOIN "import_batch" b ON b.id = r.batch_id
		 WHERE b.definition_key = 'business_partner'
		   AND r.target_id = bp.id::text
		   AND coalesce(btrim(r.raw_values ->> 'status'), '') <> ''
	   )
	RETURNING bp.id, bp.code
)
INSERT INTO "audit_event" ("action", "object_type", "object_id", "before_value", "after_value", "reason", "outcome")
SELECT 'business_partner.updated',
       'business_partner',
       c.id::text,
       jsonb_build_object('status', 'prospect'),
       jsonb_build_object('status', 'active', 'code', c.code),
       'Migration 0302: entered on the Customers/Suppliers screens before they could approve a partner (§6); approved by the release that added the step.',
       'success'
  FROM corrected c;
--> statement-breakpoint
SELECT set_config('app.is_super_user', '', true);
