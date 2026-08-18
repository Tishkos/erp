CREATE TYPE "public"."dimension_requirement" AS ENUM('mandatory', 'optional');--> statement-breakpoint
CREATE TABLE "account_type_dimension_default" (
	"account_type" "account_type" NOT NULL,
	"dimension" "dimension_type" NOT NULL,
	CONSTRAINT "account_type_dimension_default_account_type_dimension_pk" PRIMARY KEY("account_type","dimension")
);
--> statement-breakpoint
CREATE TABLE "dimension_definition" (
	"dimension" "dimension_type" PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"source_table" text,
	"source_code_column" text,
	"source_active_column" text,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "dimension_definition_source_complete" CHECK (("dimension_definition"."source_table" is null) = ("dimension_definition"."source_code_column" is null)),
	CONSTRAINT "dimension_definition_identifier_shape" CHECK (("dimension_definition"."source_table" is null or "dimension_definition"."source_table" ~ '^[a-z_][a-z0-9_]*$')
          and ("dimension_definition"."source_code_column" is null or "dimension_definition"."source_code_column" ~ '^[a-z_][a-z0-9_]*$')
          and ("dimension_definition"."source_active_column" is null or "dimension_definition"."source_active_column" ~ '^[a-z_][a-z0-9_]*$'))
);
--> statement-breakpoint
CREATE TABLE "document_type_dimension" (
	"document_type_code" text NOT NULL,
	"dimension" "dimension_type" NOT NULL,
	"requirement" "dimension_requirement" NOT NULL,
	CONSTRAINT "document_type_dimension_document_type_code_dimension_pk" PRIMARY KEY("document_type_code","dimension")
);
--> statement-breakpoint
ALTER TABLE "document_type_dimension" ADD CONSTRAINT "document_type_dimension_document_type_code_document_type_code_fk" FOREIGN KEY ("document_type_code") REFERENCES "public"."document_type"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE — Phase 02.4, dimensions framework.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The registry: where each of the seven dimensions draws its values from.
--
-- Branch and Department have masters already (Phase 01). The rest are
-- registered with no source, which makes them unusable until the phase that
-- owns them registers one. §4.2 names all seven now; delivering them is spread
-- across later phases, and this table is where that dependency is visible
-- rather than assumed.
-- ---------------------------------------------------------------------------
INSERT INTO dimension_definition
  (dimension, label, source_table, source_code_column, source_active_column, is_active) VALUES
  ('branch',           'Branch',                  'branch',     'code', 'active', true),
  ('department',       'Department / Cost Centre','department', 'code', 'active', true),
  ('business_line',    'Business Line',            NULL,        NULL,   NULL,     true),
  ('project',          'Project',                  NULL,        NULL,   NULL,     true),
  ('warehouse',        'Warehouse',                NULL,        NULL,   NULL,     true),
  ('business_partner', 'Customer / Supplier',      NULL,        NULL,   NULL,     true),
  ('employee',         'Employee / Salesperson',   NULL,        NULL,   NULL,     true);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §4.2's validation column, as data.
--
-- The blueprint states these directly:
--   "Department/Cost Centre — mandatory for operating expense accounts"
--   "Business Line — mandatory for revenue and direct cost accounts"
--
-- Held as rows rather than as code so the Business Process Owner can change
-- them without a release, and so an auditor asking why a posting was refused
-- can be shown the rule rather than told about it.
--
-- Branch is not here: §4.2 makes it "mandatory for all operational
-- transactions", which is a property of the transaction and not of the account
-- type. It is set per document type instead, where it belongs.
-- ---------------------------------------------------------------------------
INSERT INTO account_type_dimension_default (account_type, dimension) VALUES
  ('expense', 'department'),
  ('expense', 'business_line'),
  ('revenue', 'business_line');--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Does a dimension value exist, and is it usable?
--
-- Resolves through the registry rather than against a fixed list of tables, so
-- Phase 03 can deliver Business Line and Phase 04 Warehouse without this
-- function being rewritten each time.
--
-- SECURITY DEFINER with a fixed search_path, and the identifiers it interpolates
-- are constrained by a CHECK on dimension_definition — a registry row cannot
-- carry anything that is not a plain lower-case identifier.
-- ---------------------------------------------------------------------------
CREATE FUNCTION dimension_value_exists(p_dimension dimension_type, p_code text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_def   dimension_definition%ROWTYPE;
  v_found boolean;
BEGIN
  SELECT * INTO v_def FROM dimension_definition WHERE dimension = p_dimension;

  IF NOT FOUND OR NOT v_def.is_active OR v_def.source_table IS NULL THEN
    RAISE EXCEPTION
      'The % dimension has no master data yet, so a value cannot be validated against it.',
      p_dimension USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_def.source_active_column IS NULL THEN
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE %I = $1)',
                   v_def.source_table, v_def.source_code_column)
      INTO v_found USING p_code;
  ELSE
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE %I = $1 AND %I)',
                   v_def.source_table, v_def.source_code_column, v_def.source_active_column)
      INTO v_found USING p_code;
  END IF;

  RETURN v_found;
END;
$$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- An account cannot require a dimension that has no master data.
--
-- Without this an account could be configured to demand a Warehouse before
-- warehouses exist, and every posting to it would fail with no way to satisfy
-- the requirement.
-- ---------------------------------------------------------------------------
CREATE FUNCTION account_required_dimension_available() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_def dimension_definition%ROWTYPE;
BEGIN
  SELECT * INTO v_def FROM dimension_definition WHERE dimension = NEW.dimension;

  IF NOT FOUND OR NOT v_def.is_active OR v_def.source_table IS NULL THEN
    RAISE EXCEPTION
      'The % dimension has no master data yet and cannot be made mandatory. It becomes available when the phase that delivers it registers a source.',
      NEW.dimension USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER account_required_dimension_available
  BEFORE INSERT OR UPDATE ON account_required_dimension
  FOR EACH ROW EXECUTE FUNCTION account_required_dimension_available();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §4.2 — "Branch: mandatory for all operational transactions."
--
-- Set on the document type, because it is a property of the transaction rather
-- than of the account it posts to. Chart of Account is master data, not an
-- operational transaction, so it is not listed here; Journal Entry picks this
-- up when Phase 02.5 registers it.
-- ---------------------------------------------------------------------------
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'dimension', 'view'),
  ('accounting_manager', 'dimension', 'view'),
  ('accounting_manager', 'dimension', 'configure');--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON dimension_definition, document_type_dimension, account_type_dimension_default
    FROM erp_app;

  -- The registry is configuration the application reads; a phase registers its
  -- master through a migration, not at runtime.
  GRANT SELECT ON dimension_definition TO erp_app;

  -- These two are maintained from the configuration screens.
  GRANT SELECT, INSERT, UPDATE, DELETE ON document_type_dimension        TO erp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON account_type_dimension_default TO erp_app;

  GRANT EXECUTE ON FUNCTION dimension_value_exists(dimension_type, text) TO erp_app;
END;
$$;