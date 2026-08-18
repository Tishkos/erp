CREATE TABLE "logistics_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"import_file_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"service_type_code" text NOT NULL,
	"route_code" text,
	"branch_code" text NOT NULL,
	"department_code" text NOT NULL,
	"job_date" date NOT NULL,
	"promised_delivery_date" date,
	"delivered_on" date,
	"currency_code" text DEFAULT 'IQD' NOT NULL,
	"description" text,
	"note" text,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "logistics_job_approval_complete" CHECK (("logistics_job"."approved_by" is null and "logistics_job"."approved_at" is null)
          or ("logistics_job"."approved_by" is not null and "logistics_job"."approved_at" is not null)),
	CONSTRAINT "logistics_job_cancellation_has_reason" CHECK (("logistics_job"."cancelled_by" is null and "logistics_job"."cancelled_at" is null)
          or ("logistics_job"."cancelled_by" is not null and "logistics_job"."cancelled_at" is not null
              and coalesce(btrim("logistics_job"."cancellation_reason"), '') <> '')),
	CONSTRAINT "logistics_job_delivered_has_date" CHECK ("logistics_job"."delivered_on" is null
          or "logistics_job"."status" in ('executed', 'settled', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "logistics_job_leg" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"leg_no" integer NOT NULL,
	"carrier_code" text NOT NULL,
	"mode" text NOT NULL,
	"origin" text NOT NULL,
	"destination" text NOT NULL,
	"planned_departure" date,
	"planned_arrival" date,
	"actual_departure" date,
	"actual_arrival" date,
	"transport_document_no" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "logistics_job_leg_status" CHECK ("logistics_job_leg"."status" in ('planned', 'in_transit', 'completed', 'cancelled')),
	CONSTRAINT "logistics_job_leg_mode" CHECK ("logistics_job_leg"."mode" in ('road', 'rail', 'sea', 'air', 'courier', 'multimodal')),
	CONSTRAINT "logistics_job_leg_endpoints_differ" CHECK ("logistics_job_leg"."origin" <> "logistics_job_leg"."destination"),
	CONSTRAINT "logistics_job_leg_completed_has_arrival" CHECK ("logistics_job_leg"."status" <> 'completed' or "logistics_job_leg"."actual_arrival" is not null),
	CONSTRAINT "logistics_job_leg_arrival_after_departure" CHECK ("logistics_job_leg"."actual_departure" is null or "logistics_job_leg"."actual_arrival" is null
          or "logistics_job_leg"."actual_arrival" >= "logistics_job_leg"."actual_departure")
);
--> statement-breakpoint
ALTER TABLE "logistics_job" ADD CONSTRAINT "logistics_job_import_file_id_client_import_file_id_fk" FOREIGN KEY ("import_file_id") REFERENCES "public"."logistics_client_import_file"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_job" ADD CONSTRAINT "logistics_job_client_id_business_partner_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_job" ADD CONSTRAINT "logistics_job_service_type_code_logistics_service_type_code_fk" FOREIGN KEY ("service_type_code") REFERENCES "public"."logistics_service_type"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_job" ADD CONSTRAINT "logistics_job_route_code_logistics_route_code_fk" FOREIGN KEY ("route_code") REFERENCES "public"."logistics_route"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_job" ADD CONSTRAINT "logistics_job_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_job" ADD CONSTRAINT "logistics_job_department_code_department_code_fk" FOREIGN KEY ("department_code") REFERENCES "public"."department"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_job" ADD CONSTRAINT "logistics_job_currency_code_currency_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currency"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_job" ADD CONSTRAINT "logistics_job_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_job" ADD CONSTRAINT "logistics_job_cancelled_by_app_user_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_job" ADD CONSTRAINT "logistics_job_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_job_leg" ADD CONSTRAINT "logistics_job_leg_job_id_logistics_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."logistics_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_job_leg" ADD CONSTRAINT "logistics_job_leg_carrier_code_logistics_carrier_code_fk" FOREIGN KEY ("carrier_code") REFERENCES "public"."logistics_carrier"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "logistics_job_no_uniq" ON "logistics_job" USING btree ("job_no");--> statement-breakpoint
CREATE INDEX "logistics_job_file_idx" ON "logistics_job" USING btree ("import_file_id");--> statement-breakpoint
CREATE INDEX "logistics_job_client_idx" ON "logistics_job" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "logistics_job_branch_idx" ON "logistics_job" USING btree ("branch_code","job_date");--> statement-breakpoint
CREATE INDEX "logistics_job_status_idx" ON "logistics_job" USING btree ("status","job_date");--> statement-breakpoint
CREATE UNIQUE INDEX "logistics_job_leg_no_uniq" ON "logistics_job_leg" USING btree ("job_id","leg_no");--> statement-breakpoint
CREATE INDEX "logistics_job_leg_carrier_idx" ON "logistics_job_leg" USING btree ("carrier_code","status");--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE. Everything above is generated.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Phase 10.2 / 10.3 — the logistics job, §11.2, and its route legs.
--
-- §11.2's workflow: Client Request -> Logistics Job -> Service Charge / Client
-- Funding -> Carrier and Third-Party Execution -> Cost Recording -> Delivery
-- Evidence -> Client Settlement / Billing -> Job Close.
--
-- Appendix B: Draft, Approved, In Progress, Delivered, Settled, Closed,
-- Cancelled — and no Pending Approval, which Purchase Order, Goods Receipt and
-- A/P Invoice all have. That absence is honoured rather than filled in: approval
-- here is §5.2's `approve` verb exercised on a draft, not a state the document
-- waits in.
--
-- Note what this table cannot say. There is no item, no quantity, no warehouse
-- and no unit of measure anywhere in Phase 10. §11.3 — "Goods imported for a
-- client do not enter company warehouses" — is therefore not a rule the service
-- layer applies; it is a sentence the schema cannot express. A logistics job
-- cannot move stock because it cannot name any.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The job's client is the import file's client.
--
-- Two columns naming a party invite two answers. The client is denormalised onto
-- the job so reports and RLS need no join, and this keeps the copy honest: §11's
-- cross-reference is between documents *about the same client's shipment*, and a
-- job whose client differs from its file's would make the Client Balances report
-- (§11.5) attribute a balance to whichever of the two it happened to read.
-- ---------------------------------------------------------------------------
CREATE FUNCTION logistics_job_client_matches_file() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_file_client uuid;
  v_file_no     text;
  v_file_status text;
BEGIN
  SELECT client_id, file_no, status INTO v_file_client, v_file_no, v_file_status
    FROM logistics_client_import_file WHERE id = NEW.import_file_id;

  IF v_file_client IS DISTINCT FROM NEW.client_id THEN
    RAISE EXCEPTION
      'Job % names a different client from import file % (blueprint 11). One shipment has one client; correct the job or open the right file.',
      NEW.job_no, coalesce(v_file_no, '(unknown)')
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF TG_OP = 'INSERT' AND v_file_status = 'closed' THEN
    RAISE EXCEPTION
      'Client import file % is closed, so no new job can be raised against it (blueprint 11). Reopen the file first.',
      v_file_no USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER logistics_job_client_matches_file
  BEFORE INSERT OR UPDATE OF import_file_id, client_id ON logistics_job
  FOR EACH ROW EXECUTE FUNCTION logistics_job_client_matches_file();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Appendix B's order, enforced as a property of the table.
--
-- 10.2's gate: "The job progresses through every status in the defined order and
-- rejects skips." `document_status_transition` (seeded below) already refuses
-- moves nobody designed for, but it is a *pair* table: it cannot say "one step
-- at a time" without a row per legal pair, and it cannot express that
-- cancellation narrows as the job progresses. This trigger says both, and it
-- says them to the owner and to any future migration as well as to the app.
--
-- Cancellation is allowed only from Draft and Approved. Appendix B lists
-- Cancelled without saying which states reach it; from In Progress onward a job
-- may carry posted costs and client funding, and what becomes of that money on
-- cancellation — refund, write-off, retained fee — is an accounting outcome
-- §28.1 reserves to the Business Process Owner. Refusing is the recoverable
-- direction: see docs/open-questions-phase-10.md, Q10-3.
-- ---------------------------------------------------------------------------
CREATE FUNCTION logistics_job_status_follows_order() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_order text[] := ARRAY['draft', 'approved', 'partially_executed', 'executed', 'settled', 'closed'];
  v_from  int;
  v_to    int;
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF OLD.status IN ('cancelled', 'closed') THEN
    RAISE EXCEPTION
      'Logistics job % is %; it has reached the end of its life and cannot move again (Appendix B).',
      OLD.job_no, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.status = 'cancelled' THEN
    IF OLD.status NOT IN ('draft', 'approved') THEN
      RAISE EXCEPTION
        'Logistics job % is already under way, so it cannot simply be cancelled (Appendix B, blueprint 28.1). Costs or client funding may have posted against it, and what happens to that money is a Finance decision — see open question Q10-3.',
        OLD.job_no
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  v_from := array_position(v_order, OLD.status::text);
  v_to   := array_position(v_order, NEW.status::text);

  IF v_from IS NULL OR v_to IS NULL THEN
    RAISE EXCEPTION
      'Status ''%'' is not part of a logistics job''s life (Appendix B gives Draft, Approved, In Progress, Delivered, Settled, Closed, Cancelled).',
      NEW.status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_to <> v_from + 1 THEN
    RAISE EXCEPTION
      'Logistics job % cannot go from % to % (Appendix B). The workflow runs Draft, Approved, In Progress, Delivered, Settled, Closed — one step at a time, forwards.',
      OLD.job_no, OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER logistics_job_status_follows_order
  BEFORE UPDATE ON logistics_job
  FOR EACH ROW EXECUTE FUNCTION logistics_job_status_follows_order();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- An approved job's commercial terms are fixed.
--
-- §3.2 and §24: once a document leaves draft, the fields everything downstream
-- measures against stop moving. Here that is the client, the import file, the
-- branch and the service type — the last because the evidence a job must produce
-- before it settles (10.7) is a property of its service type, and a job that
-- could change type mid-flight could shed a proof-of-delivery requirement after
-- the goods had already gone.
-- ---------------------------------------------------------------------------
CREATE FUNCTION logistics_job_terms_fixed_after_draft() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  IF NEW.import_file_id    IS DISTINCT FROM OLD.import_file_id
  OR NEW.client_id         IS DISTINCT FROM OLD.client_id
  OR NEW.branch_code       IS DISTINCT FROM OLD.branch_code
  OR NEW.service_type_code IS DISTINCT FROM OLD.service_type_code
  OR NEW.department_code   IS DISTINCT FROM OLD.department_code
  OR NEW.currency_code     IS DISTINCT FROM OLD.currency_code
  OR NEW.job_no            IS DISTINCT FROM OLD.job_no THEN
    RAISE EXCEPTION
      'Logistics job % has been approved; its client, file, branch, service type and currency are fixed from that point (blueprint 3.2). Cancel it and raise a new one.',
      OLD.job_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER logistics_job_terms_fixed_after_draft
  BEFORE UPDATE ON logistics_job
  FOR EACH ROW EXECUTE FUNCTION logistics_job_terms_fixed_after_draft();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Legs belong to a job that is still running.
--
-- A leg added to a settled or closed job is a carrier movement that happened
-- after the client was billed — its cost would fall outside the margin the G/L
-- already reported (10.8's gate that "job margin reconciles to the G/L").
-- ---------------------------------------------------------------------------
CREATE FUNCTION logistics_job_leg_job_is_open() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status document_status;
  v_no     text;
BEGIN
  SELECT status, job_no INTO v_status, v_no
    FROM logistics_job WHERE id = NEW.job_id;

  IF v_status IN ('settled', 'closed', 'cancelled') THEN
    RAISE EXCEPTION
      'Logistics job % is %; no further route legs can be recorded against it (blueprint 11.2). A movement after settlement falls outside the margin already reported.',
      v_no, v_status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER logistics_job_leg_job_is_open
  BEFORE INSERT ON logistics_job_leg
  FOR EACH ROW EXECUTE FUNCTION logistics_job_leg_job_is_open();--> statement-breakpoint

-- Numbering, document type, statuses and permissions.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('LOGISTICS_JOB', 'LJB', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('logistics_job', 'Logistics Job', 'logistics',
   'A customer import or shipping service job. Appendix B effect: job cost and service revenue. Carries no inventory quantity — section 11.3.');--> statement-breakpoint

-- Appendix B's list, and only Appendix B's list.
INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('logistics_job', 'draft',              'approved'),
  ('logistics_job', 'draft',              'cancelled'),
  ('logistics_job', 'approved',           'partially_executed'),
  ('logistics_job', 'approved',           'cancelled'),
  ('logistics_job', 'partially_executed', 'executed'),
  ('logistics_job', 'executed',           'settled'),
  ('logistics_job', 'settled',            'closed');--> statement-breakpoint

-- §24 — frozen once the job leaves draft.
INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('logistics_job', 'import_file_id',
   'Decides which shipment the job belongs to, and therefore what the cross-reference report shows.'),
  ('logistics_job', 'client_id',
   'Decides whose client balance and whose margin this job lands in (section 11.5).'),
  ('logistics_job', 'service_type_code',
   'Decides the delivery evidence the job must hold before it can settle (10.7).'),
  ('logistics_job', 'branch_code',
   'A job posts to one branch (section 14.3).'),
  ('logistics_job', 'department_code',
   'Section 4.2 makes Department mandatory on operating expense accounts; every job cost carries this one.'),
  ('logistics_job', 'currency_code',
   'Charges, costs and the settlement are all measured in it.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- §11.1 — the Logistics department owns this document. The blueprint's full role
-- matrix (§5.1: Logistics is one of the named departments) arrives with the role
-- build-out; until then the two roles that exist carry the grants, exactly as
-- Phase 05 did for the warehouse-owned Goods Receipt.
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'logistics_job', 'view'),
  ('accounting_officer', 'logistics_job', 'create'),
  ('accounting_officer', 'logistics_job', 'edit_draft'),
  ('accounting_officer', 'logistics_job', 'submit'),
  ('accounting_officer', 'logistics_job', 'print'),
  ('accounting_manager', 'logistics_job', 'view'),
  ('accounting_manager', 'logistics_job', 'create'),
  ('accounting_manager', 'logistics_job', 'edit_draft'),
  ('accounting_manager', 'logistics_job', 'submit'),
  ('accounting_manager', 'logistics_job', 'approve'),
  ('accounting_manager', 'logistics_job', 'execute'),
  ('accounting_manager', 'logistics_job', 'reverse_cancel'),
  ('accounting_manager', 'logistics_job', 'configure'),
  ('accounting_manager', 'logistics_job', 'print'),
  ('accounting_manager', 'logistics_job', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON logistics_job, logistics_job_leg FROM erp_app;

  -- §1.1 keeps saved documents: no DELETE on the job. Legs are removable while
  -- the job is still running, which the trigger above scopes.
  GRANT SELECT, INSERT, UPDATE ON logistics_job TO erp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON logistics_job_leg TO erp_app;
END;
$$;--> statement-breakpoint

ALTER TABLE logistics_job ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE logistics_job FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY logistics_job_branch_scope ON logistics_job
  USING (app_is_super_user() OR branch_code = app_current_branch())
  WITH CHECK (app_is_super_user() OR branch_code = app_current_branch());--> statement-breakpoint

ALTER TABLE logistics_job_leg ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE logistics_job_leg FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

-- The leg takes its scope from its job rather than carrying a branch of its own:
-- one answer to "which branch is this?", not two that can drift.
CREATE POLICY logistics_job_leg_branch_scope ON logistics_job_leg
  USING (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM logistics_job j
       WHERE j.id = logistics_job_leg.job_id AND j.branch_code = app_current_branch()
    )
  )
  WITH CHECK (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM logistics_job j
       WHERE j.id = logistics_job_leg.job_id AND j.branch_code = app_current_branch()
    )
  );
