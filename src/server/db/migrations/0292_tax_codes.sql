-- Tax Codes — REQ-ACC-001 Part D-5 (2026-10-04).
--
-- The tables have stood since 0012 (Phase 03.6) with their grants, the
-- recoverable/non-recoverable account separation and "deactivated, never
-- deleted"; nothing wrote them. The requirement asks a tax code for its code,
-- rate, **input/output treatment**, relevant account and active flag:
--
--   * `direction` — input (on purchases) or output (on sales). Every code
--     already in a database is an input tax (only purchases could have used
--     one), so the column defaults to it.
--   * The code is minted, never typed (Critical Rule 1): TAX-001, TAX-002 …
--     from a sequence of its own, kept by the test reset like every master's.
--   * `created_by` / `created_at`, so the record's history begins where it
--     does; the audit trail carries the rest.
--
-- Nothing else changes: the rates stay effective-dated rows that are added,
-- never edited (a filed return keeps its rate), and the 0012 trigger still
-- refuses one account serving recoverable and non-recoverable tax.

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year) VALUES
	('TAX_CODE', 'TAX', '{PREFIX}-{SERIAL}', 3, false, false)
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint

ALTER TABLE "tax_code" ADD COLUMN IF NOT EXISTS "direction" text DEFAULT 'input' NOT NULL;--> statement-breakpoint
ALTER TABLE "tax_code" ADD CONSTRAINT "tax_code_direction" CHECK ("direction" IN ('input', 'output'));--> statement-breakpoint
ALTER TABLE "tax_code" ADD COLUMN IF NOT EXISTS "created_by" uuid REFERENCES "app_user"("id");--> statement-breakpoint
ALTER TABLE "tax_code" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "tax_rate" ADD COLUMN IF NOT EXISTS "created_by" uuid REFERENCES "app_user"("id");--> statement-breakpoint
ALTER TABLE "tax_rate" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint

-- A rate, once written, is the rate a return was filed at: added, never
-- changed or removed. (The application role was never granted UPDATE or
-- DELETE on it; this says so to the owner too.)
CREATE TRIGGER "tax_rate_append_only"
	BEFORE UPDATE OR DELETE ON "tax_rate"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint

-- A tax code prints from its record like any other: whoever reads tax codes
-- may print one, the Accounting Manager export it.
INSERT INTO role_grant (role_code, object, verb) VALUES
	('accounting_officer', 'tax_code', 'print'),
	('accounting_manager', 'tax_code', 'print'),
	('accounting_manager', 'tax_code', 'export')
ON CONFLICT DO NOTHING;
