CREATE TYPE "public"."partner_status" AS ENUM('prospect', 'active', 'on_hold', 'blocked', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."warehouse_type" AS ENUM('main', 'branch', 'transit', 'quarantine', 'damaged_goods', 'returns');--> statement-breakpoint
CREATE TABLE "bin" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"warehouse_code" text NOT NULL,
	"code" text NOT NULL,
	"name" text,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "business_line" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_line_code_shape" CHECK ("business_line"."code" ~ '^[A-Z0-9_]+$')
);
--> statement-breakpoint
CREATE TABLE "business_partner" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"legal_name" text NOT NULL,
	"trade_name" text,
	"is_customer" boolean DEFAULT false NOT NULL,
	"is_supplier" boolean DEFAULT false NOT NULL,
	"status" "partner_status" DEFAULT 'prospect' NOT NULL,
	"registration_no" text,
	"tax_identifier" text,
	"email" text,
	"phone" text,
	"address" text,
	"credit_limit_iqd" numeric(19, 4),
	"credit_terms_days" numeric(5, 0),
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_partner_has_role" CHECK ("business_partner"."is_customer" or "business_partner"."is_supplier"),
	CONSTRAINT "business_partner_credit_limit_non_negative" CHECK ("business_partner"."credit_limit_iqd" is null or "business_partner"."credit_limit_iqd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "company" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"legal_name" text NOT NULL,
	"trade_name" text,
	"registration_no" text,
	"tax_identifier" text,
	"base_currency" char(3) DEFAULT 'IQD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_base_currency_shape" CHECK ("company"."base_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "cost_centre" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" uuid,
	"branch_code" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_bank_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid NOT NULL,
	"bank_name" text NOT NULL,
	"account_number" text NOT NULL,
	"iban" text,
	"swift" text,
	"currency" char(3) DEFAULT 'IQD' NOT NULL,
	"account_holder" text,
	"approval_status" "document_status" DEFAULT 'draft' NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partner_bank_currency_shape" CHECK ("partner_bank_account"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "partner_bank_active_requires_approval" CHECK (not ("partner_bank_account"."is_active" and "partner_bank_account"."approval_status" <> 'approved'))
);
--> statement-breakpoint
CREATE TABLE "partner_role_required_field" (
	"role" text NOT NULL,
	"field_name" text NOT NULL,
	CONSTRAINT "partner_role_required_field_role" CHECK ("partner_role_required_field"."role" in ('customer','supplier'))
);
--> statement-breakpoint
CREATE TABLE "project" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"partner_id" uuid,
	"branch_code" text,
	"business_line_code" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "warehouse" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"branch_code" text NOT NULL,
	"warehouse_type" "warehouse_type" NOT NULL,
	"is_transit" boolean DEFAULT false NOT NULL,
	"allow_negative_stock" boolean DEFAULT false NOT NULL,
	"responsible_user_id" uuid,
	"address" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warehouse_no_negative_stock" CHECK ("warehouse"."allow_negative_stock" = false),
	CONSTRAINT "warehouse_transit_consistent" CHECK ("warehouse"."is_transit" = ("warehouse"."warehouse_type" = 'transit'))
);
--> statement-breakpoint
ALTER TABLE "branch" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "branch" ADD COLUMN "manager_user_id" uuid;--> statement-breakpoint
ALTER TABLE "branch" ADD COLUMN "default_warehouse_code" text;--> statement-breakpoint
ALTER TABLE "branch" ADD COLUMN "default_cash_account_id" uuid;--> statement-breakpoint
ALTER TABLE "department" ADD COLUMN "parent_code" text;--> statement-breakpoint
ALTER TABLE "department" ADD COLUMN "manager_user_id" uuid;--> statement-breakpoint
ALTER TABLE "bin" ADD CONSTRAINT "bin_warehouse_code_warehouse_code_fk" FOREIGN KEY ("warehouse_code") REFERENCES "public"."warehouse"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_partner" ADD CONSTRAINT "business_partner_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_centre" ADD CONSTRAINT "cost_centre_owner_user_id_app_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_centre" ADD CONSTRAINT "cost_centre_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_bank_account" ADD CONSTRAINT "partner_bank_account_partner_id_business_partner_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."business_partner"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_bank_account" ADD CONSTRAINT "partner_bank_account_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_bank_account" ADD CONSTRAINT "partner_bank_account_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_partner_id_business_partner_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_business_line_code_business_line_code_fk" FOREIGN KEY ("business_line_code") REFERENCES "public"."business_line"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_responsible_user_id_app_user_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bin_code_uniq" ON "bin" USING btree ("warehouse_code","code");--> statement-breakpoint
CREATE UNIQUE INDEX "business_partner_code_uniq" ON "business_partner" USING btree ("code");--> statement-breakpoint
CREATE INDEX "business_partner_name_idx" ON "business_partner" USING btree (lower("legal_name"));--> statement-breakpoint
CREATE INDEX "business_partner_registration_idx" ON "business_partner" USING btree ("registration_no");--> statement-breakpoint
CREATE INDEX "business_partner_contact_idx" ON "business_partner" USING btree ("email","phone");--> statement-breakpoint
CREATE UNIQUE INDEX "company_code_uniq" ON "company" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "company_singleton" ON "company" USING btree ((true));--> statement-breakpoint
CREATE INDEX "partner_bank_account_partner_idx" ON "partner_bank_account" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "partner_bank_account_number_idx" ON "partner_bank_account" USING btree ("account_number");--> statement-breakpoint
CREATE UNIQUE INDEX "partner_role_required_field_uniq" ON "partner_role_required_field" USING btree ("role","field_name");--> statement-breakpoint
CREATE INDEX "warehouse_branch_idx" ON "warehouse" USING btree ("branch_code");--> statement-breakpoint
ALTER TABLE "department" ADD CONSTRAINT "department_parent_code_department_code_fk" FOREIGN KEY ("parent_code") REFERENCES "public"."department"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "department" ADD CONSTRAINT "department_manager_user_id_app_user_id_fk" FOREIGN KEY ("manager_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE — Phase 03.1, 03.2 and 03.4.
-- ===========================================================================

-- Branch and warehouse each reference the other: a warehouse belongs to a
-- branch, and a branch has a default warehouse. The database expresses that
-- without difficulty; a TypeScript schema would have to import in a circle,
-- which is why this key is declared here.
ALTER TABLE branch
  ADD CONSTRAINT branch_default_warehouse_fk
  FOREIGN KEY (default_warehouse_code) REFERENCES warehouse(code);--> statement-breakpoint

ALTER TABLE branch
  ADD CONSTRAINT branch_manager_fk
  FOREIGN KEY (manager_user_id) REFERENCES app_user(id);--> statement-breakpoint

ALTER TABLE business_partner
  ALTER COLUMN credit_limit_iqd TYPE money_amount;--> statement-breakpoint

ALTER TABLE partner_bank_account
  ALTER COLUMN currency TYPE currency_code;--> statement-breakpoint

ALTER TABLE company
  ALTER COLUMN base_currency TYPE currency_code;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §4.1 — the department hierarchy, without cycles.
--
-- A cycle would make "which department does this roll up to?" unanswerable and
-- would hang any report that walks the tree.
-- ---------------------------------------------------------------------------
CREATE FUNCTION department_no_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_ancestor text := NEW.parent_code;
  v_walked   int  := 0;
BEGIN
  IF NEW.parent_code IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.parent_code = NEW.code THEN
    RAISE EXCEPTION 'Department % cannot be its own parent.', NEW.code
      USING ERRCODE = 'restrict_violation';
  END IF;

  WHILE v_ancestor IS NOT NULL LOOP
    IF v_ancestor = NEW.code THEN
      RAISE EXCEPTION
        'Department % cannot sit beneath itself — the hierarchy would loop.', NEW.code
        USING ERRCODE = 'restrict_violation';
    END IF;
    SELECT parent_code INTO v_ancestor FROM department WHERE code = v_ancestor;
    v_walked := v_walked + 1;
    EXIT WHEN v_walked > 100;
  END LOOP;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER department_no_cycle
  BEFORE INSERT OR UPDATE ON department
  FOR EACH ROW EXECUTE FUNCTION department_no_cycle();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §4.4 — masters are deactivated, never deleted, once referenced.
--
-- The referencing foreign keys already refuse the delete; these triggers give
-- the refusal a sentence that says what to do instead, rather than a constraint
-- name the user has to interpret.
-- ---------------------------------------------------------------------------
CREATE FUNCTION master_deactivate_not_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'A % record is deactivated, never deleted — its code appears on documents that must stay readable (§1.1, §4.4).',
    TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint

CREATE TRIGGER business_partner_no_delete
  BEFORE DELETE ON business_partner
  FOR EACH ROW EXECUTE FUNCTION master_deactivate_not_delete();--> statement-breakpoint

CREATE TRIGGER warehouse_no_delete
  BEFORE DELETE ON warehouse
  FOR EACH ROW EXECUTE FUNCTION master_deactivate_not_delete();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §4.4 / §15 — approved bank details are frozen.
--
-- "Supplier bank detail changes require independent verification and approval
-- before payment." A change to an approved set is not an edit; it is a new set
-- that must be approved in its own right, so the old one stays visible next to
-- the new one and the substitution is on the record.
-- ---------------------------------------------------------------------------
CREATE FUNCTION partner_bank_account_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.approval_status <> 'approved' THEN
    RETURN NEW;
  END IF;

  IF NEW.bank_name      IS DISTINCT FROM OLD.bank_name
  OR NEW.account_number IS DISTINCT FROM OLD.account_number
  OR NEW.iban           IS DISTINCT FROM OLD.iban
  OR NEW.swift          IS DISTINCT FROM OLD.swift
  OR NEW.currency       IS DISTINCT FROM OLD.currency THEN
    RAISE EXCEPTION
      'Approved bank details cannot be edited. Add a new set and have it approved — the old set stays as history (§15).'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER partner_bank_account_immutable
  BEFORE UPDATE ON partner_bank_account
  FOR EACH ROW EXECUTE FUNCTION partner_bank_account_immutable();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The dimensions these masters unlock (Phase 02.4).
--
-- Business Line, Business Partner, Warehouse and Project were registered in
-- migration 0005 with no source, which made them unusable — a value could not
-- be validated, so it was refused. Their masters now exist.
--
-- Employee remains unregistered: its master is Phase 15.
-- ---------------------------------------------------------------------------
UPDATE dimension_definition
   SET source_table = 'business_line', source_code_column = 'code', source_active_column = 'active'
 WHERE dimension = 'business_line';--> statement-breakpoint

UPDATE dimension_definition
   SET source_table = 'business_partner', source_code_column = 'code', source_active_column = 'active'
 WHERE dimension = 'business_partner';--> statement-breakpoint

UPDATE dimension_definition
   SET source_table = 'warehouse', source_code_column = 'code', source_active_column = 'active'
 WHERE dimension = 'warehouse';--> statement-breakpoint

UPDATE dimension_definition
   SET source_table = 'project', source_code_column = 'code', source_active_column = 'active'
 WHERE dimension = 'project';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §2.2 — the six business lines, and §2.1's departments.
--
-- Both lists are stated in the blueprint, so they are seeded rather than left
-- to be typed. §2.1 is explicit that there is **no Legal Department**; the
-- absence is deliberate and is recorded here so nobody adds one back as an
-- oversight.
-- ---------------------------------------------------------------------------
INSERT INTO business_line (code, name) VALUES
  ('PRODUCT_SALES',  'Product Sales'),
  ('CONTRACTING',    'Contracting'),
  ('PROJECTS',       'Projects'),
  ('LOGISTICS',      'Logistics'),
  ('INVESTMENTS',    'Investments'),
  ('MONEY_TRANSFER', 'Money Transfer');--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Master data governance — §4.4: "Create/change/deactivate permissions are
-- separate from transaction entry."
--
-- The Accounting Officer may raise a partner and submit it; only the Manager
-- approves bank details. Neither grant carries transaction entry, and no
-- transaction-entry grant carries these.
-- ---------------------------------------------------------------------------
INSERT INTO document_type (code, name, module, description) VALUES
  ('partner_bank_account', 'Partner Bank Account', 'master_data',
   'Bank details for a business partner. Requires independent approval before payment (§15).');--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('partner_bank_account', 'draft',     'submitted'),
  ('partner_bank_account', 'draft',     'cancelled'),
  ('partner_bank_account', 'submitted', 'approved'),
  ('partner_bank_account', 'submitted', 'rejected'),
  ('partner_bank_account', 'submitted', 'draft'),
  ('partner_bank_account', 'rejected',  'draft');--> statement-breakpoint

INSERT INTO workflow_definition (id, document_type_code, version, is_active)
VALUES ('00000000-0000-4000-8000-000000000003', 'partner_bank_account', 1, true);--> statement-breakpoint

-- §15 requires *independent* verification: the person who entered the details
-- is not the person who approves them.
INSERT INTO workflow_step (definition_id, sequence, approver_role, allow_self_approval)
VALUES ('00000000-0000-4000-8000-000000000003', 1, 'accounting_manager', false);--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'business_partner', 'view'),
  ('accounting_officer', 'business_partner', 'create'),
  ('accounting_officer', 'business_partner', 'edit_draft'),
  ('accounting_officer', 'business_partner', 'submit'),
  ('accounting_officer', 'warehouse',        'view'),
  ('accounting_officer', 'organisation',     'view'),
  ('accounting_manager', 'business_partner', 'view'),
  ('accounting_manager', 'business_partner', 'create'),
  ('accounting_manager', 'business_partner', 'edit_draft'),
  ('accounting_manager', 'business_partner', 'submit'),
  ('accounting_manager', 'business_partner', 'approve'),
  ('accounting_manager', 'business_partner', 'configure'),
  ('accounting_manager', 'warehouse',        'view'),
  ('accounting_manager', 'warehouse',        'create'),
  ('accounting_manager', 'warehouse',        'configure'),
  ('accounting_manager', 'organisation',     'view'),
  ('accounting_manager', 'organisation',     'create'),
  ('accounting_manager', 'organisation',     'configure');--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON company, business_line, cost_centre, warehouse, bin,
                business_partner, partner_bank_account, partner_role_required_field, project
    FROM erp_app;

  -- Masters are created and amended, never deleted (§4.4).
  GRANT SELECT, INSERT, UPDATE ON company             TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON business_line       TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON cost_centre         TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON warehouse           TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON bin                 TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON business_partner    TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON partner_bank_account TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON project             TO erp_app;

  -- Role-field configuration is maintained from a screen.
  GRANT SELECT, INSERT, DELETE ON partner_role_required_field TO erp_app;
END;
$$;