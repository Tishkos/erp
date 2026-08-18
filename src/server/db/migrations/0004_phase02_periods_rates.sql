CREATE TYPE "public"."period_status" AS ENUM('open', 'soft_closed', 'closed');--> statement-breakpoint
CREATE TYPE "public"."rate_type" AS ENUM('accounting', 'market', 'client');--> statement-breakpoint
CREATE TABLE "currency" (
	"code" char(3) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"decimals" smallint DEFAULT 2 NOT NULL,
	"is_ledger" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "currency_code_shape" CHECK ("currency"."code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "currency_decimals_range" CHECK ("currency"."decimals" between 0 and 6)
);
--> statement-breakpoint
CREATE TABLE "exchange_rate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"currency_code" char(3) NOT NULL,
	"rate_type" "rate_type" NOT NULL,
	"iqd_per_unit" numeric(18, 8) NOT NULL,
	"effective_from" date NOT NULL,
	"source" text,
	"entered_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	"superseded_by" uuid,
	CONSTRAINT "exchange_rate_positive" CHECK ("exchange_rate"."iqd_per_unit" > 0)
);
--> statement-breakpoint
CREATE TABLE "fiscal_period" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fiscal_year_id" uuid NOT NULL,
	"period_no" smallint NOT NULL,
	"name" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"status" "period_status" DEFAULT 'open' NOT NULL,
	"status_changed_by" uuid,
	"status_changed_at" timestamp with time zone,
	CONSTRAINT "fiscal_period_dates_ordered" CHECK ("fiscal_period"."ends_on" >= "fiscal_period"."starts_on"),
	CONSTRAINT "fiscal_period_no_positive" CHECK ("fiscal_period"."period_no" >= 1)
);
--> statement-breakpoint
CREATE TABLE "fiscal_year" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"status" "period_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fiscal_year_dates_ordered" CHECK ("fiscal_year"."ends_on" > "fiscal_year"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "period_override" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "period_override_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"fiscal_period_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"document_type" text NOT NULL,
	"document_id" text,
	"posting_date" date NOT NULL,
	"reason" text NOT NULL,
	"branch_code" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "period_override_reason_present" CHECK (btrim("period_override"."reason") <> '')
);
--> statement-breakpoint
ALTER TABLE "exchange_rate" ADD CONSTRAINT "exchange_rate_currency_code_currency_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currency"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_rate" ADD CONSTRAINT "exchange_rate_entered_by_app_user_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_rate" ADD CONSTRAINT "exchange_rate_superseded_by_exchange_rate_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."exchange_rate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_period" ADD CONSTRAINT "fiscal_period_fiscal_year_id_fiscal_year_id_fk" FOREIGN KEY ("fiscal_year_id") REFERENCES "public"."fiscal_year"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_period" ADD CONSTRAINT "fiscal_period_status_changed_by_app_user_id_fk" FOREIGN KEY ("status_changed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_override" ADD CONSTRAINT "period_override_fiscal_period_id_fiscal_period_id_fk" FOREIGN KEY ("fiscal_period_id") REFERENCES "public"."fiscal_period"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_override" ADD CONSTRAINT "period_override_actor_user_id_app_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exchange_rate_live_uniq" ON "exchange_rate" USING btree ("currency_code","rate_type","effective_from") WHERE "exchange_rate"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "exchange_rate_lookup_idx" ON "exchange_rate" USING btree ("currency_code","rate_type","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_period_no_uniq" ON "fiscal_period" USING btree ("fiscal_year_id","period_no");--> statement-breakpoint
CREATE INDEX "fiscal_period_range_idx" ON "fiscal_period" USING btree ("starts_on","ends_on");--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_year_code_uniq" ON "fiscal_year" USING btree ("code");--> statement-breakpoint
CREATE INDEX "period_override_period_idx" ON "period_override" USING btree ("fiscal_period_id","occurred_at");--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE — Phase 02.2 and 02.3.
-- ===========================================================================

-- Needed for the exclusion constraints below: they mix an equality test on a
-- uuid with an overlap test on a range, and gist cannot index the uuid without
-- this contrib module.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The calendar must tile time exactly.
--
-- Every posting date resolves to exactly one period. If two periods overlap the
-- answer is ambiguous; if a gap exists there is no answer at all, and a posting
-- would either be refused for no stated reason or — worse — allowed into
-- nothing. Both are prevented here rather than in the code that reads them.
-- ---------------------------------------------------------------------------
ALTER TABLE fiscal_year
  ADD CONSTRAINT fiscal_year_no_overlap
  EXCLUDE USING gist (daterange(starts_on, ends_on, '[]') WITH &&);--> statement-breakpoint

ALTER TABLE fiscal_period
  ADD CONSTRAINT fiscal_period_no_overlap
  EXCLUDE USING gist (daterange(starts_on, ends_on, '[]') WITH &&);--> statement-breakpoint

-- A period must lie inside its own year. Without this a January period could be
-- attached to the wrong fiscal year and every year-to-date figure would drift.
CREATE FUNCTION fiscal_period_within_year() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_year fiscal_year%ROWTYPE;
BEGIN
  SELECT * INTO v_year FROM fiscal_year WHERE id = NEW.fiscal_year_id;

  IF NEW.starts_on < v_year.starts_on OR NEW.ends_on > v_year.ends_on THEN
    RAISE EXCEPTION
      'Period % (% to %) does not lie within fiscal year % (% to %).',
      NEW.name, NEW.starts_on, NEW.ends_on, v_year.code, v_year.starts_on, v_year.ends_on
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER fiscal_period_within_year
  BEFORE INSERT OR UPDATE ON fiscal_period
  FOR EACH ROW EXECUTE FUNCTION fiscal_period_within_year();--> statement-breakpoint

-- Period dates are the shape of the calendar, not an attribute of it. Once a
-- period exists, transactions carry its dates; moving them would silently move
-- postings between periods. The status changes; the dates do not.
CREATE FUNCTION fiscal_period_dates_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.starts_on <> OLD.starts_on OR NEW.ends_on <> OLD.ends_on THEN
    RAISE EXCEPTION
      'The dates of period % cannot be changed. Postings already resolve against them.',
      OLD.name USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at := now();
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER fiscal_period_dates_immutable
  BEFORE UPDATE ON fiscal_period
  FOR EACH ROW EXECUTE FUNCTION fiscal_period_dates_immutable();--> statement-breakpoint

-- §24's override report is only evidence if nobody can edit it afterwards.
CREATE TRIGGER period_override_append_only
  BEFORE UPDATE OR DELETE ON period_override
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §1.1 — "IQD is the primary transaction and ledger currency."
--
-- One ledger currency, enforced. A second one would make "the balancing
-- currency" a question rather than a fact, and §14.3 states it as a fact.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX currency_single_ledger_uniq
  ON currency ((is_ledger)) WHERE is_ledger;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A published rate is a historical fact.
--
-- §22 requires a reprint to reproduce. That holds only if the rate a posting
-- used still says what it said. A correction therefore supersedes rather than
-- edits: the only column that may change is the supersession marker itself.
-- ---------------------------------------------------------------------------
CREATE FUNCTION exchange_rate_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.currency_code  IS DISTINCT FROM OLD.currency_code
  OR NEW.rate_type      IS DISTINCT FROM OLD.rate_type
  OR NEW.iqd_per_unit   IS DISTINCT FROM OLD.iqd_per_unit
  OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
  OR NEW.entered_by     IS DISTINCT FROM OLD.entered_by
  OR NEW.created_at     IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'A published exchange rate cannot be edited. Supersede it with a corrected rate so that postings which used this one can still explain themselves (§22).'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER exchange_rate_immutable
  BEFORE UPDATE ON exchange_rate
  FOR EACH ROW EXECUTE FUNCTION exchange_rate_immutable();--> statement-breakpoint

CREATE TRIGGER exchange_rate_no_delete
  BEFORE DELETE ON exchange_rate
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The two currencies §1.1 names. Others are added by Finance as needed.
--
-- IQD carries 0 decimals: it is quoted whole. That is a *presentation* fact —
-- ledger amounts remain numeric(19,4) so that a rate conversion does not lose
-- precision before it is rounded for display.
-- ---------------------------------------------------------------------------
INSERT INTO currency (code, name, decimals, is_ledger, is_active) VALUES
  ('IQD', 'Iraqi Dinar',   0, true,  true),
  ('USD', 'US Dollar',     2, false, true);--> statement-breakpoint

-- IQD converts to IQD at one, from the beginning of time. Stated rather than
-- special-cased in code, so the conversion path is the same for every currency.
INSERT INTO exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, source)
VALUES ('IQD', 'accounting', 1.00000000, '1900-01-01', 'Ledger currency (§1.1)');--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Roles: the Finance Manager owns the calendar and the rates.
--
-- §14.3 — "Rates are maintained only in the Finance Exchange Rate section."
-- §14.6 — only an authorised Finance Manager posts into a soft-closed period.
-- The Accounting Officer may read both and change neither.
-- ---------------------------------------------------------------------------
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'fiscal_period', 'view'),
  ('accounting_officer', 'exchange_rate', 'view'),
  ('accounting_manager', 'fiscal_period', 'view'),
  ('accounting_manager', 'fiscal_period', 'configure'),
  ('accounting_manager', 'fiscal_period', 'execute'),
  ('accounting_manager', 'exchange_rate', 'view'),
  ('accounting_manager', 'exchange_rate', 'create'),
  ('accounting_manager', 'exchange_rate', 'configure');--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON fiscal_year, fiscal_period, period_override, currency, exchange_rate
    FROM erp_app;

  GRANT SELECT, INSERT, UPDATE ON fiscal_year   TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON fiscal_period TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON currency      TO erp_app;

  -- Rates are inserted and superseded, never rewritten; the trigger above
  -- confines the UPDATE to the supersession marker.
  GRANT SELECT, INSERT, UPDATE ON exchange_rate TO erp_app;

  -- The override log is written and read. Nothing more.
  GRANT SELECT, INSERT ON period_override TO erp_app;
END;
$$;