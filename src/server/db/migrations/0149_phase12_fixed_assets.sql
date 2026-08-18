CREATE TYPE "public"."fixed_asset_status" AS ENUM('draft', 'approved', 'available_for_use', 'active', 'disposed', 'closed', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."depreciation_method" AS ENUM('straight_line', 'reducing_balance');--> statement-breakpoint
CREATE TABLE "asset_category" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"default_useful_life_months" integer,
	"default_residual_percent" numeric(9, 4),
	"default_method" "depreciation_method" DEFAULT 'straight_line' NOT NULL,
	"cost_account_role" text DEFAULT 'fixed_asset_cost' NOT NULL,
	"depreciation_expense_role" text DEFAULT 'depreciation_expense' NOT NULL,
	"accumulated_depreciation_role" text DEFAULT 'accumulated_depreciation' NOT NULL,
	"impairment_role" text DEFAULT 'impairment_loss' NOT NULL,
	"disposal_gain_role" text DEFAULT 'disposal_gain' NOT NULL,
	"disposal_loss_role" text DEFAULT 'disposal_loss' NOT NULL,
	"active" text DEFAULT 'true' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_category_code_shape" CHECK ("asset_category"."code" ~ '^[A-Z0-9_-]+$'),
	CONSTRAINT "asset_category_name_present" CHECK (btrim("asset_category"."name") <> ''),
	CONSTRAINT "asset_category_life_positive" CHECK ("asset_category"."default_useful_life_months" is null or "asset_category"."default_useful_life_months" > 0),
	CONSTRAINT "asset_category_residual_range" CHECK ("asset_category"."default_residual_percent" is null
          or ("asset_category"."default_residual_percent" >= 0 and "asset_category"."default_residual_percent" < 100))
);
--> statement-breakpoint
CREATE TABLE "asset_depreciation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"charge_iqd" numeric(19, 4) NOT NULL,
	"accumulated_after_iqd" numeric(19, 4) NOT NULL,
	"branch_code" text,
	"department_code" text,
	"cost_centre_code" text,
	"journal_entry_id" uuid,
	"posted_by" uuid NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_depreciation_charge_not_negative" CHECK ("asset_depreciation"."charge_iqd" >= 0),
	CONSTRAINT "asset_depreciation_period_ordered" CHECK ("asset_depreciation"."period_end" >= "asset_depreciation"."period_start")
);
--> statement-breakpoint
CREATE TABLE "asset_impairment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"impaired_on" date NOT NULL,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"carrying_value_before_iqd" numeric(19, 4) NOT NULL,
	"reason" text NOT NULL,
	"journal_entry_id" uuid,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_impairment_amount_positive" CHECK ("asset_impairment"."amount_iqd" > 0),
	CONSTRAINT "asset_impairment_reason_present" CHECK (btrim("asset_impairment"."reason") <> ''),
	CONSTRAINT "asset_impairment_within_carrying_value" CHECK ("asset_impairment"."amount_iqd" <= "asset_impairment"."carrying_value_before_iqd")
);
--> statement-breakpoint
CREATE TABLE "asset_transfer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"transferred_on" date NOT NULL,
	"from_branch_code" text,
	"from_department_code" text,
	"from_cost_centre_code" text,
	"from_location" text,
	"from_custodian_user_id" uuid,
	"to_branch_code" text,
	"to_department_code" text,
	"to_cost_centre_code" text,
	"to_location" text,
	"to_custodian_user_id" uuid,
	"reason" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_transfer_reason_present" CHECK (btrim("asset_transfer"."reason") <> ''),
	CONSTRAINT "asset_transfer_approver_is_another" CHECK ("asset_transfer"."approved_by" <> "asset_transfer"."requested_by")
);
--> statement-breakpoint
CREATE TABLE "asset_verification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"verified_on" date NOT NULL,
	"found" text NOT NULL,
	"found_location" text,
	"found_custodian_user_id" uuid,
	"note" text,
	"verified_by" uuid NOT NULL,
	"variance_approved_by" uuid,
	"variance_approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_verification_found_shape" CHECK ("asset_verification"."found" in ('present', 'missing', 'moved')),
	CONSTRAINT "asset_verification_variance_complete" CHECK (("asset_verification"."variance_approved_by" is null) = ("asset_verification"."variance_approved_at" is null)),
	CONSTRAINT "asset_verification_variance_is_explained" CHECK ("asset_verification"."found" = 'present' or coalesce(btrim("asset_verification"."note"), '') <> '')
);
--> statement-breakpoint
CREATE TABLE "fixed_asset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_code" text NOT NULL,
	"status" "fixed_asset_status" DEFAULT 'draft' NOT NULL,
	"description" text NOT NULL,
	"category_code" text NOT NULL,
	"branch_code" text NOT NULL,
	"department_code" text,
	"cost_centre_code" text,
	"location" text,
	"custodian_user_id" uuid,
	"acquisition_cost_iqd" numeric(19, 4) NOT NULL,
	"acquired_on" date NOT NULL,
	"useful_life_months" integer NOT NULL,
	"residual_value_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"depreciation_method" "depreciation_method" NOT NULL,
	"available_for_use_on" date NOT NULL,
	"ap_invoice_id" uuid,
	"supplier_reference" text,
	"journal_entry_id" uuid,
	"disposed_on" date,
	"disposal_proceeds_iqd" numeric(19, 4),
	"created_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixed_asset_description_present" CHECK (btrim("fixed_asset"."description") <> ''),
	CONSTRAINT "fixed_asset_cost_positive" CHECK ("fixed_asset"."acquisition_cost_iqd" > 0),
	CONSTRAINT "fixed_asset_life_positive" CHECK ("fixed_asset"."useful_life_months" > 0),
	CONSTRAINT "fixed_asset_residual_below_cost" CHECK ("fixed_asset"."residual_value_iqd" >= 0 and "fixed_asset"."residual_value_iqd" < "fixed_asset"."acquisition_cost_iqd"),
	CONSTRAINT "fixed_asset_available_after_acquired" CHECK ("fixed_asset"."available_for_use_on" >= "fixed_asset"."acquired_on"),
	CONSTRAINT "fixed_asset_disposal_complete" CHECK (("fixed_asset"."disposed_on" is null) = ("fixed_asset"."disposal_proceeds_iqd" is null)),
	CONSTRAINT "fixed_asset_disposed_has_date" CHECK ("fixed_asset"."status" <> 'disposed' or "fixed_asset"."disposed_on" is not null)
);
--> statement-breakpoint
ALTER TABLE "asset_depreciation" ADD CONSTRAINT "asset_depreciation_asset_id_fixed_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."fixed_asset"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_depreciation" ADD CONSTRAINT "asset_depreciation_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_depreciation" ADD CONSTRAINT "asset_depreciation_department_code_department_code_fk" FOREIGN KEY ("department_code") REFERENCES "public"."department"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_depreciation" ADD CONSTRAINT "asset_depreciation_cost_centre_code_cost_centre_code_fk" FOREIGN KEY ("cost_centre_code") REFERENCES "public"."cost_centre"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_depreciation" ADD CONSTRAINT "asset_depreciation_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_depreciation" ADD CONSTRAINT "asset_depreciation_posted_by_app_user_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_impairment" ADD CONSTRAINT "asset_impairment_asset_id_fixed_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."fixed_asset"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_impairment" ADD CONSTRAINT "asset_impairment_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_impairment" ADD CONSTRAINT "asset_impairment_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_transfer" ADD CONSTRAINT "asset_transfer_asset_id_fixed_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."fixed_asset"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_transfer" ADD CONSTRAINT "asset_transfer_from_branch_code_branch_code_fk" FOREIGN KEY ("from_branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_transfer" ADD CONSTRAINT "asset_transfer_from_department_code_department_code_fk" FOREIGN KEY ("from_department_code") REFERENCES "public"."department"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_transfer" ADD CONSTRAINT "asset_transfer_from_cost_centre_code_cost_centre_code_fk" FOREIGN KEY ("from_cost_centre_code") REFERENCES "public"."cost_centre"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_transfer" ADD CONSTRAINT "asset_transfer_from_custodian_user_id_app_user_id_fk" FOREIGN KEY ("from_custodian_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_transfer" ADD CONSTRAINT "asset_transfer_to_branch_code_branch_code_fk" FOREIGN KEY ("to_branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_transfer" ADD CONSTRAINT "asset_transfer_to_department_code_department_code_fk" FOREIGN KEY ("to_department_code") REFERENCES "public"."department"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_transfer" ADD CONSTRAINT "asset_transfer_to_cost_centre_code_cost_centre_code_fk" FOREIGN KEY ("to_cost_centre_code") REFERENCES "public"."cost_centre"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_transfer" ADD CONSTRAINT "asset_transfer_to_custodian_user_id_app_user_id_fk" FOREIGN KEY ("to_custodian_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_transfer" ADD CONSTRAINT "asset_transfer_requested_by_app_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_transfer" ADD CONSTRAINT "asset_transfer_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_verification" ADD CONSTRAINT "asset_verification_asset_id_fixed_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."fixed_asset"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_verification" ADD CONSTRAINT "asset_verification_found_custodian_user_id_app_user_id_fk" FOREIGN KEY ("found_custodian_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_verification" ADD CONSTRAINT "asset_verification_verified_by_app_user_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_verification" ADD CONSTRAINT "asset_verification_variance_approved_by_app_user_id_fk" FOREIGN KEY ("variance_approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset" ADD CONSTRAINT "fixed_asset_category_code_asset_category_code_fk" FOREIGN KEY ("category_code") REFERENCES "public"."asset_category"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset" ADD CONSTRAINT "fixed_asset_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset" ADD CONSTRAINT "fixed_asset_department_code_department_code_fk" FOREIGN KEY ("department_code") REFERENCES "public"."department"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset" ADD CONSTRAINT "fixed_asset_cost_centre_code_cost_centre_code_fk" FOREIGN KEY ("cost_centre_code") REFERENCES "public"."cost_centre"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset" ADD CONSTRAINT "fixed_asset_custodian_user_id_app_user_id_fk" FOREIGN KEY ("custodian_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset" ADD CONSTRAINT "fixed_asset_ap_invoice_id_ap_invoice_id_fk" FOREIGN KEY ("ap_invoice_id") REFERENCES "public"."ap_invoice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset" ADD CONSTRAINT "fixed_asset_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset" ADD CONSTRAINT "fixed_asset_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset" ADD CONSTRAINT "fixed_asset_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_depreciation_period_uniq" ON "asset_depreciation" USING btree ("asset_id","period_end");--> statement-breakpoint
CREATE INDEX "asset_depreciation_period_idx" ON "asset_depreciation" USING btree ("period_end");--> statement-breakpoint
CREATE INDEX "asset_impairment_asset_idx" ON "asset_impairment" USING btree ("asset_id","impaired_on");--> statement-breakpoint
CREATE INDEX "asset_transfer_asset_idx" ON "asset_transfer" USING btree ("asset_id","transferred_on");--> statement-breakpoint
CREATE INDEX "asset_verification_asset_idx" ON "asset_verification" USING btree ("asset_id","verified_on");--> statement-breakpoint
CREATE UNIQUE INDEX "fixed_asset_code_uniq" ON "fixed_asset" USING btree ("asset_code");--> statement-breakpoint
CREATE INDEX "fixed_asset_category_idx" ON "fixed_asset" USING btree ("category_code","status");--> statement-breakpoint
CREATE INDEX "fixed_asset_branch_idx" ON "fixed_asset" USING btree ("branch_code","status");--> statement-breakpoint
CREATE INDEX "fixed_asset_custodian_idx" ON "fixed_asset" USING btree ("custodian_user_id");
--> statement-breakpoint

-- ===========================================================================
-- Phase 12 — fixed assets (blueprint 18, Appendix B, C, E / IAS 16)
--
-- Section 18.2 states that "No Asset Clearing Account is required by the
-- approved company workflow": Finance creates the Fixed Asset Document directly
-- from approved purchasing evidence, and recognition posts Dr Fixed Asset Cost /
-- Cr the source account with nothing in between.
--
-- There is therefore no clearing-account column, no clearing role and no code
-- path that could introduce one. Adding it because other ERPs have one would be
-- an unapproved change under section 28 - and the reason to record that here is
-- that a future reader will otherwise assume the omission was an oversight.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Section 18.5 - depreciation cannot begin before the Available for Use Date.
--
-- The service refuses it and the domain returns nothing for such a period. This
-- is the half that survives a code path nobody has written yet: a charge dated
-- before the asset was available cannot be stored at all.
-- ---------------------------------------------------------------------------
CREATE FUNCTION asset_depreciation_not_before_available() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_available date;
  v_code      text;
BEGIN
  SELECT available_for_use_on, asset_code INTO v_available, v_code
    FROM fixed_asset WHERE id = NEW.asset_id;

  IF NEW.period_end < v_available THEN
    RAISE EXCEPTION
      '% becomes available for use on %, after the period ending % (blueprint 18.5). Depreciation is the using-up of an asset; an asset nobody can use yet is not being used up.',
      v_code, v_available, NEW.period_end
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER asset_depreciation_not_before_available
  BEFORE INSERT OR UPDATE ON asset_depreciation
  FOR EACH ROW EXECUTE FUNCTION asset_depreciation_not_before_available();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 18 - depreciation never takes an asset below its residual value.
--
-- Accumulated depreciation is a sum of charges rather than a maintained column,
-- so this checks the sum after the charge. An asset depreciated past its
-- residual would report a carrying value the company does not believe.
-- ---------------------------------------------------------------------------
CREATE FUNCTION asset_depreciation_stops_at_residual() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_depreciable numeric(19,4);
  v_accumulated numeric(19,4);
  v_code        text;
BEGIN
  SELECT a.acquisition_cost_iqd - a.residual_value_iqd, a.asset_code
    INTO v_depreciable, v_code
    FROM fixed_asset a WHERE a.id = NEW.asset_id;

  SELECT coalesce(sum(d.charge_iqd), 0) INTO v_accumulated
    FROM asset_depreciation d WHERE d.asset_id = NEW.asset_id;

  IF v_accumulated > v_depreciable THEN
    RAISE EXCEPTION
      'Depreciating % by that much would take it below its residual value: % charged against a depreciable amount of % (blueprint 18).',
      v_code, v_accumulated, v_depreciable
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER asset_depreciation_stops_at_residual
  AFTER INSERT OR UPDATE ON asset_depreciation
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION asset_depreciation_stops_at_residual();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 18.3 - a disposed asset takes no further charge.
--
-- The lifecycle is document → available for use → depreciation → transfer or
-- impairment → disposal → closed. Depreciating something the company no longer
-- owns would put cost against an asset that is not there.
-- ---------------------------------------------------------------------------
CREATE FUNCTION asset_no_movement_after_disposal() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_code   text;
BEGIN
  SELECT status::text, asset_code INTO v_status, v_code
    FROM fixed_asset WHERE id = NEW.asset_id;

  IF v_status IN ('disposed', 'closed') THEN
    RAISE EXCEPTION
      '% is % and takes no further depreciation or impairment (blueprint 18.3).',
      v_code, v_status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER asset_depreciation_not_after_disposal
  BEFORE INSERT ON asset_depreciation
  FOR EACH ROW EXECUTE FUNCTION asset_no_movement_after_disposal();--> statement-breakpoint

CREATE TRIGGER asset_impairment_not_after_disposal
  BEFORE INSERT ON asset_impairment
  FOR EACH ROW EXECUTE FUNCTION asset_no_movement_after_disposal();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 18.1 - a category an asset uses cannot be removed.
--
-- Section 4.4's rule for every master: deactivate rather than delete. A deleted
-- category would leave assets whose defaults and account roles no longer resolve.
-- ---------------------------------------------------------------------------
CREATE FUNCTION asset_category_no_delete_when_used() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM fixed_asset WHERE category_code = OLD.code) THEN
    RAISE EXCEPTION
      'Category % is used by assets on the register and cannot be deleted (blueprint 4.4, 18.1). Deactivate it instead: the assets keep the account roles they were recognised under.',
      OLD.code
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint

CREATE TRIGGER asset_category_no_delete_when_used
  BEFORE DELETE ON asset_category
  FOR EACH ROW EXECUTE FUNCTION asset_category_no_delete_when_used();--> statement-breakpoint

-- Numbering, document types, statuses and permissions.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('FIXED_ASSET', 'FA', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('fixed_asset', 'Fixed Asset Document', 'assets',
   'Created by Finance directly from approved purchasing evidence (blueprint 18.2). Recognition posts Dr Fixed Asset Cost / Cr the source account - the approved company workflow uses no Asset Clearing Account, and there is no column here for one. Depreciation starts from the Available for Use Date and not before.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('fixed_asset', 'available_for_use_on',
   'The earliest date depreciation may begin (blueprint 18.5). Moving it after recognition would move charges into periods that did not consume the asset.'),
  ('fixed_asset', 'acquisition_cost_iqd',
   'What the asset cost. It is what recognition posted, so it cannot move without the ledger moving.'),
  ('fixed_asset', 'useful_life_months',
   'How long it is expected to be used up over.'),
  ('fixed_asset', 'residual_value_iqd',
   'What it is expected to be worth at the end. Depreciation stops here.'),
  ('fixed_asset', 'depreciation_method',
   'How the charge is computed. Changing it mid-life changes every future charge.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'fixed_asset', 'view'),
  ('accounting_officer', 'fixed_asset', 'create'),
  ('accounting_officer', 'fixed_asset', 'edit_draft'),
  ('accounting_officer', 'fixed_asset', 'execute'),
  ('accounting_officer', 'fixed_asset', 'print'),
  ('accounting_manager', 'fixed_asset', 'view'),
  ('accounting_manager', 'fixed_asset', 'create'),
  ('accounting_manager', 'fixed_asset', 'edit_draft'),
  ('accounting_manager', 'fixed_asset', 'execute'),
  ('accounting_manager', 'fixed_asset', 'approve'),
  ('accounting_manager', 'fixed_asset', 'post'),
  ('accounting_manager', 'fixed_asset', 'configure'),
  ('accounting_manager', 'fixed_asset', 'reverse_cancel'),
  ('accounting_manager', 'fixed_asset', 'print'),
  ('accounting_manager', 'fixed_asset', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist - grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON asset_category, fixed_asset, asset_depreciation, asset_transfer,
                asset_impairment, asset_verification FROM erp_app;

  GRANT SELECT                  ON asset_category      TO erp_app;
  GRANT SELECT, INSERT, UPDATE  ON fixed_asset         TO erp_app;
  GRANT SELECT, INSERT, UPDATE  ON asset_depreciation  TO erp_app;
  GRANT SELECT, INSERT          ON asset_transfer      TO erp_app;
  GRANT SELECT, INSERT          ON asset_impairment    TO erp_app;
  GRANT SELECT, INSERT, UPDATE  ON asset_verification  TO erp_app;
END;
$$;--> statement-breakpoint

-- D10 - the branch boundary. The children reach through the asset.
ALTER TABLE fixed_asset ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE fixed_asset FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY fixed_asset_branch_scope ON fixed_asset
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

ALTER TABLE asset_depreciation ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE asset_depreciation FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY asset_depreciation_branch_scope ON asset_depreciation
  USING (EXISTS (SELECT 1 FROM fixed_asset a
                  WHERE a.id = asset_depreciation.asset_id
                    AND app_branch_allowed(a.branch_code)))
  WITH CHECK (EXISTS (SELECT 1 FROM fixed_asset a
                       WHERE a.id = asset_depreciation.asset_id
                         AND app_branch_allowed(a.branch_code)));--> statement-breakpoint

ALTER TABLE asset_transfer ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE asset_transfer FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY asset_transfer_branch_scope ON asset_transfer
  USING (EXISTS (SELECT 1 FROM fixed_asset a
                  WHERE a.id = asset_transfer.asset_id
                    AND app_branch_allowed(a.branch_code)))
  WITH CHECK (EXISTS (SELECT 1 FROM fixed_asset a
                       WHERE a.id = asset_transfer.asset_id
                         AND app_branch_allowed(a.branch_code)));--> statement-breakpoint

ALTER TABLE asset_impairment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE asset_impairment FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY asset_impairment_branch_scope ON asset_impairment
  USING (EXISTS (SELECT 1 FROM fixed_asset a
                  WHERE a.id = asset_impairment.asset_id
                    AND app_branch_allowed(a.branch_code)))
  WITH CHECK (EXISTS (SELECT 1 FROM fixed_asset a
                       WHERE a.id = asset_impairment.asset_id
                         AND app_branch_allowed(a.branch_code)));--> statement-breakpoint

ALTER TABLE asset_verification ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE asset_verification FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY asset_verification_branch_scope ON asset_verification
  USING (EXISTS (SELECT 1 FROM fixed_asset a
                  WHERE a.id = asset_verification.asset_id
                    AND app_branch_allowed(a.branch_code)))
  WITH CHECK (EXISTS (SELECT 1 FROM fixed_asset a
                       WHERE a.id = asset_verification.asset_id
                         AND app_branch_allowed(a.branch_code)));
