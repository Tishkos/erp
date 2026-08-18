CREATE TABLE "logistics_carrier" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"business_partner_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"carrier_reference" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "logistics_carrier_mode" CHECK ("logistics_carrier"."mode" in ('road', 'rail', 'sea', 'air', 'courier', 'multimodal'))
);
--> statement-breakpoint
CREATE TABLE "logistics_route" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"origin" text NOT NULL,
	"destination" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "logistics_route_endpoints_differ" CHECK ("logistics_route"."origin" <> "logistics_route"."destination")
);
--> statement-breakpoint
CREATE TABLE "logistics_service_type" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "logistics_service_type_name" CHECK (btrim("logistics_service_type"."name") <> '')
);
--> statement-breakpoint
CREATE TABLE "logistics_service_type_evidence" (
	"service_type_code" text NOT NULL,
	"evidence_type" text NOT NULL,
	"note" text,
	CONSTRAINT "logistics_service_type_evidence_type" CHECK (btrim("logistics_service_type_evidence"."evidence_type") <> '')
);
--> statement-breakpoint
CREATE TABLE "logistics_funding_stage_role" (
	"job_status" "document_status" PRIMARY KEY NOT NULL,
	"line_role" text NOT NULL,
	"note" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "logistics_funding_stage_role_role" CHECK (btrim("logistics_funding_stage_role"."line_role") <> '')
);
--> statement-breakpoint
ALTER TABLE "logistics_carrier" ADD CONSTRAINT "logistics_carrier_business_partner_id_business_partner_id_fk" FOREIGN KEY ("business_partner_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_carrier" ADD CONSTRAINT "logistics_carrier_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_service_type_evidence" ADD CONSTRAINT "logistics_service_type_evidence_service_type_code_logistics_service_type_code_fk" FOREIGN KEY ("service_type_code") REFERENCES "public"."logistics_service_type"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_funding_stage_role" ADD CONSTRAINT "logistics_funding_stage_role_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "logistics_carrier_partner_idx" ON "logistics_carrier" USING btree ("business_partner_id");--> statement-breakpoint
CREATE INDEX "logistics_route_endpoints_idx" ON "logistics_route" USING btree ("origin","destination");--> statement-breakpoint
CREATE UNIQUE INDEX "logistics_service_type_evidence_uniq" ON "logistics_service_type_evidence" USING btree ("service_type_code","evidence_type");--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE. Everything above is generated.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Phase 10.3 / 10.7 — logistics masters and configuration, §11.1.
--
-- No row-level security on these four tables, deliberately. §4.1 scopes
-- *transactions* to a branch; a carrier, a route and a service type are company
-- masters, exactly like `item` and `warehouse`, which carry no branch either. A
-- branch policy here would mean a Basra job could not name the haulier Baghdad
-- set up, which is not a control anybody asked for — it is a data-entry problem
-- dressed as security. The documents that reference them are branch-scoped, and
-- that is where §22's scope is enforced.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- A carrier is a supplier.
--
-- §4.4 keeps one identity per counterparty. Two masters for the same haulier
-- would give it two ledgers, and 10.3's gate — "carrier payables reconcile to
-- the A/P subledger" — would be unreachable: the subledger is keyed on the
-- Business Partner, so a carrier that is not one has no payable to reconcile.
-- ---------------------------------------------------------------------------
CREATE FUNCTION logistics_carrier_is_supplier() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_is_supplier boolean;
  v_code        text;
BEGIN
  SELECT is_supplier, code INTO v_is_supplier, v_code
    FROM business_partner WHERE id = NEW.business_partner_id;

  IF NOT coalesce(v_is_supplier, false) THEN
    RAISE EXCEPTION
      'Business partner % is not a supplier, so it cannot be carrier % (blueprint 4.4). A carrier is paid, so its payable belongs in the A/P subledger.',
      coalesce(v_code, NEW.business_partner_id::text), NEW.code
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER logistics_carrier_is_supplier
  BEFORE INSERT OR UPDATE OF business_partner_id ON logistics_carrier
  FOR EACH ROW EXECUTE FUNCTION logistics_carrier_is_supplier();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §4.4 — masters are deactivated, never deleted.
--
-- A deleted carrier takes its jobs' history with it: the Carrier Payables and
-- Carrier Performance reports (§11.5) both read backwards over closed jobs.
-- ---------------------------------------------------------------------------
CREATE FUNCTION logistics_master_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'Records in % are deactivated, not deleted (blueprint 4.4). Set active = false; the reports read history that references it.',
    TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint

CREATE TRIGGER logistics_carrier_no_delete
  BEFORE DELETE ON logistics_carrier
  FOR EACH ROW EXECUTE FUNCTION logistics_master_no_delete();--> statement-breakpoint

CREATE TRIGGER logistics_route_no_delete
  BEFORE DELETE ON logistics_route
  FOR EACH ROW EXECUTE FUNCTION logistics_master_no_delete();--> statement-breakpoint

CREATE TRIGGER logistics_service_type_no_delete
  BEFORE DELETE ON logistics_service_type
  FOR EACH ROW EXECUTE FUNCTION logistics_master_no_delete();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §11.4's stage mapping — the table that is deliberately left empty.
--
-- §11.4: "Client Logistics Clearing / Deferred Service Balance **according to
-- document stage**". The blueprint names two accounts and says the choice
-- depends on the stage; it does not say which stage takes which. That is an
-- accounting outcome, and §28.1 puts it beyond the implementation team.
--
-- So nothing is seeded. Client funding cannot post until Finance says which
-- stage credits which role, and the failure is a sentence naming the open
-- question rather than a wrong number in the ledger. Being unable to post is
-- recoverable; posting to the wrong account for six months is not.
--
-- Only the statuses a job actually passes through are meaningful keys, so the
-- rest are refused at configuration time rather than silently never matching.
-- ---------------------------------------------------------------------------
CREATE FUNCTION logistics_funding_stage_role_valid_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.job_status NOT IN ('draft', 'approved', 'partially_executed', 'executed', 'settled') THEN
    RAISE EXCEPTION
      'A logistics job is never funded while it is ''%'' (Appendix B). Map the stages the job passes through: Draft, Approved, In Progress, Delivered or Settled.',
      NEW.job_status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER logistics_funding_stage_role_valid_status
  BEFORE INSERT OR UPDATE ON logistics_funding_stage_role
  FOR EACH ROW EXECUTE FUNCTION logistics_funding_stage_role_valid_status();--> statement-breakpoint

-- Permissions. §5.3 — masters and mappings are configuration, so the manager
-- configures and the officer reads.
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'logistics_carrier', 'view'),
  ('accounting_officer', 'logistics_route', 'view'),
  ('accounting_officer', 'logistics_service_type', 'view'),
  ('accounting_manager', 'logistics_carrier', 'view'),
  ('accounting_manager', 'logistics_carrier', 'create'),
  ('accounting_manager', 'logistics_carrier', 'configure'),
  ('accounting_manager', 'logistics_carrier', 'export'),
  ('accounting_manager', 'logistics_route', 'view'),
  ('accounting_manager', 'logistics_route', 'create'),
  ('accounting_manager', 'logistics_route', 'configure'),
  ('accounting_manager', 'logistics_service_type', 'view'),
  ('accounting_manager', 'logistics_service_type', 'create'),
  ('accounting_manager', 'logistics_service_type', 'configure')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON logistics_carrier, logistics_route, logistics_service_type,
                logistics_service_type_evidence, logistics_funding_stage_role
    FROM erp_app;

  -- Masters: created and amended, never deleted (the trigger above says so too).
  GRANT SELECT, INSERT, UPDATE ON logistics_carrier TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON logistics_route TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON logistics_service_type TO erp_app;

  -- The two configuration tables are lists that get rewritten: an evidence
  -- requirement is dropped when the process changes, and a stage mapping is
  -- withdrawn when Finance revises it. DELETE is how that is expressed, and
  -- §5.5's configuration review is what governs it.
  GRANT SELECT, INSERT, UPDATE, DELETE ON logistics_service_type_evidence TO erp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON logistics_funding_stage_role TO erp_app;
END;
$$;
