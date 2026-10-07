-- The PD as the bank's platform registers it (2026-10-07, by direction, from a
-- picture of the platform's register: "this is what should be for registering
-- a PD … the headers are inputs, saved in the system, for the import
-- application's status"). Its columns, right to left: registration no. (the PD
-- no.), registration date, registration year, importer code, financier, bank
-- code, bank name, bank identifier (SWIFT), invoice no., expiry date,
-- declarant code, status. Dates, year, bank and status were already the PD's;
-- these four were not.
--
-- Typed as the platform shows them and kept as text: codes, not numbers, so a
-- leading zero or a letter (2509106C) survives. Nullable — a PD entered before
-- today, or one read from the ASYCUDA list, has none — and every one of them
-- is the registration's own, written once with the row; a change is a
-- re-registration, as the dates and bank are.
ALTER TABLE customs_pd ADD COLUMN IF NOT EXISTS importer_code text;
--> statement-breakpoint
ALTER TABLE customs_pd ADD COLUMN IF NOT EXISTS financier text;
--> statement-breakpoint
ALTER TABLE customs_pd ADD COLUMN IF NOT EXISTS invoice_no text;
--> statement-breakpoint
ALTER TABLE customs_pd ADD COLUMN IF NOT EXISTS declarant_code text;
--> statement-breakpoint
COMMENT ON COLUMN customs_pd.importer_code IS 'رمز المستورد — the importer''s code on the bank''s platform, as typed.';
--> statement-breakpoint
COMMENT ON COLUMN customs_pd.financier IS 'المول — the financier named on the platform''s registration, as typed.';
--> statement-breakpoint
COMMENT ON COLUMN customs_pd.invoice_no IS 'رقم الفاتورة — the supplier invoice number the PD was registered against, as typed.';
--> statement-breakpoint
COMMENT ON COLUMN customs_pd.declarant_code IS 'رمز المصرح — the declarant''s (broker''s) code on the registration, as typed.';
