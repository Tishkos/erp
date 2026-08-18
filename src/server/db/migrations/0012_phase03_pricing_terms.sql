CREATE TYPE "public"."due_date_basis" AS ENUM('document_date', 'end_of_month');--> statement-breakpoint
CREATE TYPE "public"."payment_method_kind" AS ENUM('bank', 'cash', 'transfer');--> statement-breakpoint
CREATE TABLE "payment_method" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" "payment_method_kind" NOT NULL,
	"fee_percent" numeric(9, 6) DEFAULT '0' NOT NULL,
	"fee_account_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "payment_method_fee_non_negative" CHECK ("payment_method"."fee_percent" >= 0),
	CONSTRAINT "payment_method_fee_needs_account" CHECK ("payment_method"."fee_percent" = 0 or "payment_method"."fee_account_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "payment_term_instalment" (
	"terms_code" text NOT NULL,
	"sequence" smallint NOT NULL,
	"days_after" smallint NOT NULL,
	"percentage" numeric(5, 2) NOT NULL,
	CONSTRAINT "payment_term_instalment_terms_code_sequence_pk" PRIMARY KEY("terms_code","sequence"),
	CONSTRAINT "payment_term_instalment_sequence_positive" CHECK ("payment_term_instalment"."sequence" >= 1),
	CONSTRAINT "payment_term_instalment_days_non_negative" CHECK ("payment_term_instalment"."days_after" >= 0),
	CONSTRAINT "payment_term_instalment_percentage_range" CHECK ("payment_term_instalment"."percentage" > 0 and "payment_term_instalment"."percentage" <= 100)
);
--> statement-breakpoint
CREATE TABLE "payment_terms" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"basis" "due_date_basis" DEFAULT 'document_date' NOT NULL,
	"due_days" smallint DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "payment_terms_due_days_non_negative" CHECK ("payment_terms"."due_days" >= 0)
);
--> statement-breakpoint
CREATE TABLE "price_list" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"currency" char(3) DEFAULT 'IQD' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_list_currency_shape" CHECK ("price_list"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "price_list_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"price_list_code" text NOT NULL,
	"item_id" uuid NOT NULL,
	"uom_code" text NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"effective_from" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_list_item_price_non_negative" CHECK ("price_list_item"."unit_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tax_code" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"is_recoverable" boolean NOT NULL,
	"account_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_rate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tax_code" text NOT NULL,
	"rate_percent" numeric(9, 6) NOT NULL,
	"effective_from" date NOT NULL,
	CONSTRAINT "tax_rate_non_negative" CHECK ("tax_rate"."rate_percent" >= 0)
);
--> statement-breakpoint
ALTER TABLE "business_partner" ADD COLUMN "price_list_code" text;--> statement-breakpoint
ALTER TABLE "business_partner" ADD COLUMN "payment_terms_code" text;--> statement-breakpoint
ALTER TABLE "payment_method" ADD CONSTRAINT "payment_method_fee_account_id_chart_of_account_id_fk" FOREIGN KEY ("fee_account_id") REFERENCES "public"."chart_of_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_term_instalment" ADD CONSTRAINT "payment_term_instalment_terms_code_payment_terms_code_fk" FOREIGN KEY ("terms_code") REFERENCES "public"."payment_terms"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_item" ADD CONSTRAINT "price_list_item_price_list_code_price_list_code_fk" FOREIGN KEY ("price_list_code") REFERENCES "public"."price_list"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_item" ADD CONSTRAINT "price_list_item_item_id_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_item" ADD CONSTRAINT "price_list_item_uom_code_unit_of_measure_code_fk" FOREIGN KEY ("uom_code") REFERENCES "public"."unit_of_measure"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_code" ADD CONSTRAINT "tax_code_account_id_chart_of_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."chart_of_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rate" ADD CONSTRAINT "tax_rate_tax_code_tax_code_code_fk" FOREIGN KEY ("tax_code") REFERENCES "public"."tax_code"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "price_list_item_effective_uniq" ON "price_list_item" USING btree ("price_list_code","item_id","uom_code","effective_from");--> statement-breakpoint
CREATE INDEX "price_list_item_lookup_idx" ON "price_list_item" USING btree ("price_list_code","item_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_rate_effective_uniq" ON "tax_rate" USING btree ("tax_code","effective_from");--> statement-breakpoint
ALTER TABLE "business_partner" ADD CONSTRAINT "business_partner_price_list_code_price_list_code_fk" FOREIGN KEY ("price_list_code") REFERENCES "public"."price_list"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_partner" ADD CONSTRAINT "business_partner_payment_terms_code_payment_terms_code_fk" FOREIGN KEY ("payment_terms_code") REFERENCES "public"."payment_terms"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE — Phase 03.6, 03.7 and the 03.1 branch-defaults gate.
-- ===========================================================================

ALTER TABLE price_list
  ALTER COLUMN currency TYPE currency_code;--> statement-breakpoint

ALTER TABLE price_list_item
  ALTER COLUMN unit_price TYPE money_amount;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §4.3 — recoverable and non-recoverable tax post to different accounts.
--
-- Recoverable tax is an asset that is reclaimed; non-recoverable tax is a cost.
-- One account serving both makes the reclaimable balance unknowable, and it is
-- discovered at the first tax return rather than at configuration.
-- ---------------------------------------------------------------------------
CREATE FUNCTION tax_code_account_separation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM tax_code
     WHERE account_id = NEW.account_id
       AND code <> NEW.code
       AND is_recoverable <> NEW.is_recoverable
  ) THEN
    RAISE EXCEPTION
      'Account is already mapped to a % tax code. Recoverable tax is an asset and non-recoverable tax is a cost; one account cannot be both (§4.3).',
      CASE WHEN NEW.is_recoverable THEN 'non-recoverable' ELSE 'recoverable' END
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER tax_code_account_separation
  BEFORE INSERT OR UPDATE ON tax_code
  FOR EACH ROW EXECUTE FUNCTION tax_code_account_separation();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §16 — a term's instalments must total the whole invoice.
--
-- Deferred, because the rows arrive one at a time and only the finished set can
-- be judged. Without it a term could leave part of an invoice never falling
-- due, and nobody would notice until the balance aged.
-- ---------------------------------------------------------------------------
CREATE FUNCTION payment_term_instalments_total() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_code  text := COALESCE(NEW.terms_code, OLD.terms_code);
  v_count int;
  v_total numeric;
BEGIN
  SELECT count(*), coalesce(sum(percentage), 0)
    INTO v_count, v_total
    FROM payment_term_instalment WHERE terms_code = v_code;

  IF v_count = 0 THEN
    RETURN NULL; -- a single-payment term, which is legitimate
  END IF;

  IF v_total <> 100 THEN
    RAISE EXCEPTION
      'Payment terms % have instalments totalling %%%, not 100%%. Every part of the invoice must fall due on some date (§16).',
      v_code, v_total USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER payment_term_instalments_total
  AFTER INSERT OR UPDATE OR DELETE ON payment_term_instalment
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION payment_term_instalments_total();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §7.3 — a price list may only price an item in a unit that item actually has.
--
-- A price per box on an item sold only in pieces is a price nothing can use,
-- and the error surfaces on the order rather than on the price list.
-- ---------------------------------------------------------------------------
CREATE FUNCTION price_list_item_uom_valid() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM item_uom WHERE item_id = NEW.item_id AND uom_code = NEW.uom_code
  ) THEN
    RAISE EXCEPTION
      'That item is not sold in %; price it in one of its own units (§9.3).', NEW.uom_code
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER price_list_item_uom_valid
  BEFORE INSERT OR UPDATE ON price_list_item
  FOR EACH ROW EXECUTE FUNCTION price_list_item_uom_valid();--> statement-breakpoint

-- Masters are deactivated, never deleted (§4.4).
CREATE TRIGGER price_list_no_delete
  BEFORE DELETE ON price_list
  FOR EACH ROW EXECUTE FUNCTION master_deactivate_not_delete();--> statement-breakpoint

CREATE TRIGGER tax_code_no_delete
  BEFORE DELETE ON tax_code
  FOR EACH ROW EXECUTE FUNCTION master_deactivate_not_delete();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §4.1 — "A branch cannot be created without a default warehouse and default
-- cash account."
--
-- DEFERRED, and it has to be: a branch cannot have a warehouse at the instant
-- it is created, because a warehouse belongs to a branch. The three are created
-- in one transaction and judged at COMMIT — the same shape as the journal
-- balance rule, for the same reason.
--
-- This lands now rather than in 0010 because the cash account master did not
-- exist until 0011, and half a rule enforced early is a rule people learn to
-- work around.
-- ---------------------------------------------------------------------------
CREATE FUNCTION branch_has_defaults() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_branch branch%ROWTYPE;
BEGIN
  -- The row is re-read rather than taken from NEW. A deferred trigger carries
  -- the row as it was when the statement ran, and the whole point of deferring
  -- is that the branch is completed later in the same transaction: the INSERT
  -- genuinely has no warehouse, and the UPDATE that gives it one comes after.
  SELECT * INTO v_branch FROM branch WHERE code = NEW.code;

  IF NOT FOUND THEN
    RETURN NULL; -- deleted later in the same transaction
  END IF;

  IF v_branch.default_warehouse_code IS NULL THEN
    RAISE EXCEPTION
      'Branch % has no default warehouse. Create the branch, its warehouse and its cash account together (§4.1).',
      v_branch.code USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_branch.default_cash_account_id IS NULL THEN
    RAISE EXCEPTION
      'Branch % has no default cash account. Create the branch, its warehouse and its cash account together (§4.1).',
      v_branch.code USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER branch_has_defaults
  AFTER INSERT OR UPDATE ON branch
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION branch_has_defaults();--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'price_list',    'view'),
  ('accounting_officer', 'tax_code',      'view'),
  ('accounting_officer', 'payment_terms', 'view'),
  ('accounting_manager', 'price_list',    'view'),
  ('accounting_manager', 'price_list',    'create'),
  ('accounting_manager', 'price_list',    'configure'),
  ('accounting_manager', 'tax_code',      'view'),
  ('accounting_manager', 'tax_code',      'create'),
  ('accounting_manager', 'tax_code',      'configure'),
  ('accounting_manager', 'payment_terms', 'view'),
  ('accounting_manager', 'payment_terms', 'create'),
  ('accounting_manager', 'payment_terms', 'configure');--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON price_list, price_list_item, tax_code, tax_rate,
                payment_terms, payment_term_instalment, payment_method
    FROM erp_app;

  GRANT SELECT, INSERT, UPDATE         ON price_list              TO erp_app;
  GRANT SELECT, INSERT, UPDATE         ON price_list_item         TO erp_app;
  GRANT SELECT, INSERT, UPDATE         ON tax_code                TO erp_app;
  GRANT SELECT, INSERT                 ON tax_rate                TO erp_app;
  GRANT SELECT, INSERT, UPDATE         ON payment_terms           TO erp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON payment_term_instalment TO erp_app;
  GRANT SELECT, INSERT, UPDATE         ON payment_method          TO erp_app;
END;
$$;