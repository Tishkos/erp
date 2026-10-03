-- The advance a purchase invoice is paid in front — REQ-AP-001 §15.3.
--
-- By direction (2026-10-03): the accountant writes "20" on the invoice and the
-- system works out what 20 per cent of it is and asks the bank for exactly
-- that, against that invoice, the moment the invoice posts.
--
-- The supplier's own words on the Shenzhen invoice are the case this is for:
--
--   20% ADVANCE PAYMENT. THE REMAINING 80% SHALL BE PAID BEFORE PICKUP.
--
-- ── Why on the invoice ─────────────────────────────────────────────────────
-- An import application already carries instalments with their own percents
-- (`payable_instalment.percent`), and they remain the right place for a
-- schedule somebody plans. This is the other thing: one figure, written on the
-- invoice that states the goods, so that the advance is derived from the
-- invoice's own total rather than typed twice and reconciled later.
--
-- ── What it is not ────────────────────────────────────────────────────────
-- Not a commission. The field it replaces in the sponsor's description was
-- called one, and a commission is what a bank charges for its own service; an
-- advance is part of the price of the goods, paid early. They post to
-- different places and the name mattered enough to correct.
--
-- `paid_from_account_id` and `payment_method_code` are here for the same
-- reason the percent is: a payment application cannot exist without saying
-- where the money leaves from and how it travels, and asking for them on the
-- invoice is what lets the application be raised without a second form.
--
-- Nullable throughout, and nothing is created when the percent is absent: an
-- invoice with no advance behaves exactly as it did before this migration.

ALTER TABLE "ap_invoice"
	ADD COLUMN IF NOT EXISTS "advance_percent" numeric(9, 4),
	ADD COLUMN IF NOT EXISTS "advance_paid_from_account_id" uuid REFERENCES "bank_cash_account"("id"),
	ADD COLUMN IF NOT EXISTS "advance_payment_method_code" text REFERENCES "payment_method"("code"),
	-- The application it raised, so the invoice and the request are one thing
	-- on screen and a second posting cannot raise a second advance.
	ADD COLUMN IF NOT EXISTS "advance_application_id" uuid REFERENCES "payment_application"("id");--> statement-breakpoint

-- A percentage is a percentage: nought to a hundred. Zero is allowed and means
-- the same as none, because a form that has been cleared should not be refused.
ALTER TABLE "ap_invoice"
	ADD CONSTRAINT "ap_invoice_advance_percent_range"
	CHECK ("advance_percent" IS NULL OR ("advance_percent" >= 0 AND "advance_percent" <= 100));--> statement-breakpoint

-- An advance worth asking for names where it is paid from and how. Without
-- both there is nothing to raise, and a percent sitting alone would read as a
-- promise the system had quietly failed to keep.
ALTER TABLE "ap_invoice"
	ADD CONSTRAINT "ap_invoice_advance_needs_an_account"
	CHECK (
		"advance_percent" IS NULL
		OR "advance_percent" = 0
		OR ("advance_paid_from_account_id" IS NOT NULL AND "advance_payment_method_code" IS NOT NULL)
	);--> statement-breakpoint

-- One invoice, one advance.
CREATE UNIQUE INDEX IF NOT EXISTS "ap_invoice_advance_application_uniq"
	ON "ap_invoice" ("advance_application_id")
	WHERE "advance_application_id" IS NOT NULL;
--> statement-breakpoint

-- The two things the posting can say about an advance, so both appear on the
-- import's own event log where the accountant is already looking rather than
-- only in the audit trail.
INSERT INTO payable_event_code (code, lane_code, name) VALUES
	('ADVANCE_RAISED',     'payment', 'Advance raised'),
	('ADVANCE_NOT_RAISED', 'payment', 'Advance not raised')
ON CONFLICT (code) DO NOTHING;
