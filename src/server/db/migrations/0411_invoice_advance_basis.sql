-- 0411 — an invoice's advance by percentage OR by amount (2026-10-06, by
-- direction: "choose either … 'no in-front payment' or 'payable by amount' or
-- 'payable amount by percentage' — one selection field; once you choose one of
-- them it makes a new field, either percentage or amount").
--
-- `advance_basis` says which: 'percent' (the share in `advance_percent`, as
-- 0270 kept it) or 'amount' (`advance_amount`, written in the currency the
-- invoice was agreed in — `agreed_currency`, else dinars). No basis is no
-- advance. An invoice entered before this release with a percentage is a
-- percentage advance, and is marked so here.
--
-- The CHECK holds the three shapes and nothing between them: no advance; a
-- percentage (0270's range still applies) and no amount; an amount above
-- nothing and no percentage. Never more than the invoice is the service's to
-- say — the total is the lines', which a CHECK on the header cannot read —
-- and the form's (`domain/payment-applications.invoiceAdvance`).
ALTER TABLE "ap_invoice" ADD COLUMN IF NOT EXISTS "advance_basis" text;
--> statement-breakpoint
ALTER TABLE "ap_invoice" ADD COLUMN IF NOT EXISTS "advance_amount" numeric(19, 4);
--> statement-breakpoint
SELECT set_config('app.is_super_user', 'true', true);
--> statement-breakpoint
UPDATE "ap_invoice"
   SET "advance_basis" = 'percent'
 WHERE "advance_percent" IS NOT NULL AND "advance_basis" IS NULL;
--> statement-breakpoint
SELECT set_config('app.is_super_user', '', true);
--> statement-breakpoint
ALTER TABLE "ap_invoice" DROP CONSTRAINT IF EXISTS "ap_invoice_advance_basis_shape";
--> statement-breakpoint
ALTER TABLE "ap_invoice" ADD CONSTRAINT "ap_invoice_advance_basis_shape" CHECK (
	("advance_basis" IS NULL AND "advance_percent" IS NULL AND "advance_amount" IS NULL)
	OR ("advance_basis" = 'percent' AND "advance_percent" IS NOT NULL AND "advance_amount" IS NULL)
	OR ("advance_basis" = 'amount' AND "advance_amount" > 0 AND "advance_percent" IS NULL)
);
