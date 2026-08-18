CREATE TABLE "warranty_registration" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ar_invoice_id" uuid NOT NULL,
	"ar_invoice_line_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"item_code" text NOT NULL,
	"serial_number" text,
	"batch_number" text,
	"quantity" numeric(24, 6) NOT NULL,
	"warranty_months" smallint NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "warranty_registration_quantity_positive" CHECK ("warranty_registration"."quantity" > 0),
	CONSTRAINT "warranty_registration_months_positive" CHECK ("warranty_registration"."warranty_months" > 0),
	CONSTRAINT "warranty_registration_ends_after_start" CHECK ("warranty_registration"."ends_on" > "warranty_registration"."starts_on"),
	CONSTRAINT "warranty_registration_serial_is_one" CHECK ("warranty_registration"."serial_number" is null or "warranty_registration"."quantity" = 1)
);
--> statement-breakpoint
ALTER TABLE "warranty_registration" ADD CONSTRAINT "warranty_registration_ar_invoice_id_ar_invoice_id_fk" FOREIGN KEY ("ar_invoice_id") REFERENCES "public"."ar_invoice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warranty_registration" ADD CONSTRAINT "warranty_registration_ar_invoice_line_id_ar_invoice_line_id_fk" FOREIGN KEY ("ar_invoice_line_id") REFERENCES "public"."ar_invoice_line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warranty_registration" ADD CONSTRAINT "warranty_registration_customer_id_business_partner_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warranty_registration" ADD CONSTRAINT "warranty_registration_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warranty_registration" ADD CONSTRAINT "warranty_registration_item_code_item_code_fk" FOREIGN KEY ("item_code") REFERENCES "public"."item"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warranty_registration" ADD CONSTRAINT "warranty_registration_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "warranty_registration_serial_uniq" ON "warranty_registration" USING btree ("item_code","serial_number") WHERE "warranty_registration"."serial_number" is not null;--> statement-breakpoint
CREATE INDEX "warranty_registration_serial_idx" ON "warranty_registration" USING btree ("serial_number") WHERE "warranty_registration"."serial_number" is not null;--> statement-breakpoint
CREATE INDEX "warranty_registration_invoice_idx" ON "warranty_registration" USING btree ("ar_invoice_id");--> statement-breakpoint
CREATE INDEX "warranty_registration_customer_idx" ON "warranty_registration" USING btree ("customer_id","ends_on");--> statement-breakpoint
CREATE INDEX "warranty_registration_expiry_idx" ON "warranty_registration" USING btree ("ends_on","branch_code");
-- ===========================================================================
-- Phase 06.7 — Warranty (§7.4, §9.3)
--
--   "Warranty starts on the A/R Invoice date. Warranty duration is maintained in
--    Item Master and the end date is calculated automatically."
--   "Warranty fields are optional."
--
-- Three properties, each built rather than promised:
--
--   *The end date is calculated.* A trigger recomputes it from the start date
--   and the stored duration on every write, so no route — service, import or
--   hand-written UPDATE — can extend a warranty by typing a date.
--
--   *The duration is copied, not looked up.* The item's warranty is master data
--   and may change next year; a customer who bought two years' cover keeps it.
--   Recomputing from today's item_master would rewrite history the first time
--   Product Management edited a row.
--
--   *An item with no duration has no row.* Blueprint 9.3 makes the fields optional,
--   and a zero-month record is not the same as no record — it claims the cover
--   expired the day it was sold. The CHECK above refuses one.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 06.7 gate — *"warranty end date = invoice date + item warranty duration,
-- computed automatically."*
--
-- The service computes it in `domain/warranty.ts`, which is where the rule is
-- readable and testable. This is the same arithmetic in the database, so that
-- the *stored* value is the computed one whatever wrote the row.
--
-- Not a generated column: the start date must equal the invoice's date, which is
-- a fact in another table, so the trigger checks both together.
-- ---------------------------------------------------------------------------
CREATE FUNCTION warranty_registration_dates_are_computed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_invoice_date date;
  v_invoice_no   text;
  v_expected     date;
BEGIN
  SELECT invoice_date, invoice_no INTO v_invoice_date, v_invoice_no
    FROM ar_invoice WHERE id = NEW.ar_invoice_id;

  -- Blueprint 7.4 - "warranty starts on the A/R Invoice date". Not on the day
  -- somebody registered it, and not on a date they chose.
  IF NEW.starts_on IS DISTINCT FROM v_invoice_date THEN
    RAISE EXCEPTION
      'A warranty starts on the A/R Invoice date (blueprint 7.4). Invoice % is dated % and this registration claims %.',
      v_invoice_no, v_invoice_date, NEW.starts_on
      USING ERRCODE = 'restrict_violation';
  END IF;

  v_expected := (NEW.starts_on + (NEW.warranty_months || ' months')::interval)::date;

  IF NEW.ends_on IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION
      'A warranty end date is calculated, not entered (blueprint 7.4). % months from % is %, not %.',
      NEW.warranty_months, NEW.starts_on, v_expected, NEW.ends_on
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER warranty_registration_dates_are_computed
  BEFORE INSERT OR UPDATE ON warranty_registration
  FOR EACH ROW EXECUTE FUNCTION warranty_registration_dates_are_computed();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The register is evidence, so it is append-only (blueprint 5.4, 24).
--
-- A warranty certificate the company can quietly shorten is not a warranty
-- certificate. A registration made in error is corrected by reversing the
-- invoice that created it, which removes the line and cascades.
-- ---------------------------------------------------------------------------
CREATE TRIGGER warranty_registration_append_only
  BEFORE UPDATE ON warranty_registration
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'warranty_registration', 'view'),
  ('accounting_officer', 'warranty_registration', 'print'),
  ('accounting_manager', 'warranty_registration', 'view'),
  ('accounting_manager', 'warranty_registration', 'print'),
  ('accounting_manager', 'warranty_registration', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist - grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON warranty_registration FROM erp_app;

  -- No UPDATE and no DELETE: the register is evidence, and the trigger above
  -- refuses an update from anyone at all, including the owner.
  GRANT SELECT, INSERT ON warranty_registration TO erp_app;
END;
$$;--> statement-breakpoint

-- D10 — the branch boundary.
ALTER TABLE warranty_registration ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE warranty_registration FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY warranty_registration_branch_scope ON warranty_registration
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));
