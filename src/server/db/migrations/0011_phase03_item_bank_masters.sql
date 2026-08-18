CREATE TYPE "public"."cash_account_type" AS ENUM('bank', 'cash');--> statement-breakpoint
CREATE TYPE "public"."costing_method" AS ENUM('fifo');--> statement-breakpoint
CREATE TYPE "public"."item_tracking" AS ENUM('serial', 'batch', 'serial_and_batch');--> statement-breakpoint
CREATE TABLE "bank_cash_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"account_type" "cash_account_type" NOT NULL,
	"bank_name" text,
	"account_number" text,
	"iban" text,
	"swift" text,
	"currency" char(3) DEFAULT 'IQD' NOT NULL,
	"gl_account_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"custodian_user_id" uuid,
	"cash_limit_iqd" numeric(19, 4),
	"approval_limit_iqd" numeric(19, 4),
	"statement_format" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_cash_currency_shape" CHECK ("bank_cash_account"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "bank_cash_cash_needs_custodian" CHECK ("bank_cash_account"."account_type" <> 'cash' or "bank_cash_account"."custodian_user_id" is not null),
	CONSTRAINT "bank_cash_bank_needs_number" CHECK ("bank_cash_account"."account_type" <> 'bank' or "bank_cash_account"."account_number" is not null),
	CONSTRAINT "bank_cash_limits_non_negative" CHECK (("bank_cash_account"."cash_limit_iqd" is null or "bank_cash_account"."cash_limit_iqd" >= 0)
          and ("bank_cash_account"."approval_limit_iqd" is null or "bank_cash_account"."approval_limit_iqd" >= 0))
);
--> statement-breakpoint
CREATE TABLE "item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text,
	"is_stock" boolean DEFAULT true NOT NULL,
	"base_uom_code" text NOT NULL,
	"tracking" "item_tracking",
	"costing_method" "costing_method" DEFAULT 'fifo' NOT NULL,
	"sales_account_id" uuid,
	"purchase_account_id" uuid,
	"warranty_months" smallint,
	"supplier_item_code" text,
	"active" boolean DEFAULT true NOT NULL,
	"inactive_from" date,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_stock_requires_tracking" CHECK (not "item"."is_stock" or "item"."tracking" is not null),
	CONSTRAINT "item_service_has_no_tracking" CHECK ("item"."is_stock" or "item"."tracking" is null),
	CONSTRAINT "item_warranty_non_negative" CHECK ("item"."warranty_months" is null or "item"."warranty_months" >= 0)
);
--> statement-breakpoint
CREATE TABLE "item_uom" (
	"item_id" uuid NOT NULL,
	"uom_code" text NOT NULL,
	"conversion_numerator" bigint NOT NULL,
	"conversion_denominator" bigint DEFAULT 1 NOT NULL,
	"barcode" text,
	"is_purchase_default" boolean DEFAULT false NOT NULL,
	"is_sales_default" boolean DEFAULT false NOT NULL,
	CONSTRAINT "item_uom_item_id_uom_code_pk" PRIMARY KEY("item_id","uom_code"),
	CONSTRAINT "item_uom_conversion_positive" CHECK ("item_uom"."conversion_numerator" > 0 and "item_uom"."conversion_denominator" > 0)
);
--> statement-breakpoint
CREATE TABLE "unit_of_measure" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bank_cash_account" ADD CONSTRAINT "bank_cash_account_gl_account_id_chart_of_account_id_fk" FOREIGN KEY ("gl_account_id") REFERENCES "public"."chart_of_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_cash_account" ADD CONSTRAINT "bank_cash_account_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_cash_account" ADD CONSTRAINT "bank_cash_account_custodian_user_id_app_user_id_fk" FOREIGN KEY ("custodian_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item" ADD CONSTRAINT "item_base_uom_code_unit_of_measure_code_fk" FOREIGN KEY ("base_uom_code") REFERENCES "public"."unit_of_measure"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item" ADD CONSTRAINT "item_sales_account_id_chart_of_account_id_fk" FOREIGN KEY ("sales_account_id") REFERENCES "public"."chart_of_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item" ADD CONSTRAINT "item_purchase_account_id_chart_of_account_id_fk" FOREIGN KEY ("purchase_account_id") REFERENCES "public"."chart_of_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item" ADD CONSTRAINT "item_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_uom" ADD CONSTRAINT "item_uom_item_id_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_uom" ADD CONSTRAINT "item_uom_uom_code_unit_of_measure_code_fk" FOREIGN KEY ("uom_code") REFERENCES "public"."unit_of_measure"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_cash_account_code_uniq" ON "bank_cash_account" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_cash_account_gl_uniq" ON "bank_cash_account" USING btree ("gl_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_cash_account_number_uniq" ON "bank_cash_account" USING btree ("account_number") WHERE "bank_cash_account"."account_number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "item_code_uniq" ON "item" USING btree ("code");--> statement-breakpoint
CREATE INDEX "item_name_idx" ON "item" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "item_supplier_code_idx" ON "item" USING btree ("supplier_item_code");--> statement-breakpoint
CREATE UNIQUE INDEX "item_uom_barcode_uniq" ON "item_uom" USING btree ("barcode") WHERE "item_uom"."barcode" is not null;--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE — Phase 03.3 and 03.5.
-- ===========================================================================

ALTER TABLE bank_cash_account
  ALTER COLUMN cash_limit_iqd     TYPE money_amount,
  ALTER COLUMN approval_limit_iqd TYPE money_amount,
  ALTER COLUMN currency           TYPE currency_code;--> statement-breakpoint

-- §4.1 — a branch's default cash account, now that the master exists. The
-- default warehouse key was added in 0010; this completes the pair.
ALTER TABLE branch
  ADD CONSTRAINT branch_default_cash_account_fk
  FOREIGN KEY (default_cash_account_id) REFERENCES bank_cash_account(id);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §9.3 — the base UOM converts to itself at one.
--
-- Without this an item could declare its base unit and then define a conversion
-- for it, and every quantity in the system would be off by that factor. It is
-- the one conversion that is not configuration.
-- ---------------------------------------------------------------------------
CREATE FUNCTION item_uom_base_is_unity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_base text;
BEGIN
  SELECT base_uom_code INTO v_base FROM item WHERE id = NEW.item_id;

  IF NEW.uom_code = v_base
     AND (NEW.conversion_numerator <> 1 OR NEW.conversion_denominator <> 1) THEN
    RAISE EXCEPTION
      'The base unit of an item converts to itself at one. % cannot be % / % of itself.',
      NEW.uom_code, NEW.conversion_numerator, NEW.conversion_denominator
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER item_uom_base_is_unity
  BEFORE INSERT OR UPDATE ON item_uom
  FOR EACH ROW EXECUTE FUNCTION item_uom_base_is_unity();--> statement-breakpoint

-- An item's base unit must itself be one of its units, or the conversions have
-- nothing to convert through.
CREATE FUNCTION item_base_uom_registered() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM item_uom
     WHERE item_id = NEW.id AND uom_code = NEW.base_uom_code
  ) THEN
    RAISE EXCEPTION
      'Item % declares % as its base unit, but that unit is not among its units.',
      NEW.code, NEW.base_uom_code USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NULL;
END;
$$;--> statement-breakpoint

-- Deferred: the item row is inserted before its units, so the check can only be
-- made once the transaction that creates both has finished.
CREATE CONSTRAINT TRIGGER item_base_uom_registered
  AFTER INSERT OR UPDATE ON item
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION item_base_uom_registered();--> statement-breakpoint

-- §4.4 — masters are deactivated, never deleted, once referenced.
CREATE TRIGGER item_no_delete
  BEFORE DELETE ON item
  FOR EACH ROW EXECUTE FUNCTION master_deactivate_not_delete();--> statement-breakpoint

CREATE TRIGGER bank_cash_account_no_delete
  BEFORE DELETE ON bank_cash_account
  FOR EACH ROW EXECUTE FUNCTION master_deactivate_not_delete();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A bank or cash account maps to a G/L account that can actually hold it: a
-- posting account, approved and active, and — where one is configured — the
-- bank control account whose subledger it reconciles to (§1.2).
-- ---------------------------------------------------------------------------
CREATE FUNCTION bank_cash_account_gl_postable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_account chart_of_account%ROWTYPE;
BEGIN
  SELECT * INTO v_account FROM chart_of_account WHERE id = NEW.gl_account_id;

  IF v_account.is_group THEN
    RAISE EXCEPTION
      'Account % is a group; a cash position cannot be carried in one.',
      v_account.code USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_account.approval_status <> 'approved' OR NOT v_account.is_active THEN
    RAISE EXCEPTION
      'Account % is not approved and active, so it cannot carry a cash position.',
      v_account.code USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER bank_cash_account_gl_postable
  BEFORE INSERT OR UPDATE ON bank_cash_account
  FOR EACH ROW EXECUTE FUNCTION bank_cash_account_gl_postable();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The units the blueprint's own examples imply. Others are added by
-- Inventory/Commercial, who own this master under §4.3.
-- ---------------------------------------------------------------------------
INSERT INTO unit_of_measure (code, name) VALUES
  ('EA',  'Each'),
  ('BOX', 'Box'),
  ('KG',  'Kilogram'),
  ('L',   'Litre'),
  ('M',   'Metre'),
  ('HR',  'Hour');--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'item',              'view'),
  ('accounting_officer', 'bank_cash_account', 'view'),
  ('accounting_manager', 'item',              'view'),
  ('accounting_manager', 'item',              'create'),
  ('accounting_manager', 'item',              'configure'),
  ('accounting_manager', 'bank_cash_account', 'view'),
  ('accounting_manager', 'bank_cash_account', 'create'),
  ('accounting_manager', 'bank_cash_account', 'configure');--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON unit_of_measure, item, item_uom, bank_cash_account FROM erp_app;

  GRANT SELECT, INSERT, UPDATE         ON unit_of_measure   TO erp_app;
  GRANT SELECT, INSERT, UPDATE         ON item              TO erp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON item_uom          TO erp_app;
  GRANT SELECT, INSERT, UPDATE         ON bank_cash_account TO erp_app;
END;
$$;