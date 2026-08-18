CREATE TABLE "logistics_delivery_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"evidence_type" text NOT NULL,
	"attachment_id" uuid NOT NULL,
	"received_on" date NOT NULL,
	"note" text,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "logistics_delivery_evidence_type" CHECK (btrim("logistics_delivery_evidence"."evidence_type") <> '')
);
--> statement-breakpoint
CREATE TABLE "logistics_claim" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_no" text NOT NULL,
	"job_id" uuid NOT NULL,
	"leg_id" uuid,
	"claim_type" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"raised_on" date NOT NULL,
	"description" text NOT NULL,
	"estimated_amount" numeric(19, 4),
	"currency_code" text,
	"resolution" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"raised_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "logistics_claim_type" CHECK ("logistics_claim"."claim_type" in ('damage', 'loss', 'delay', 'shortage', 'documentation', 'other')),
	CONSTRAINT "logistics_claim_status" CHECK ("logistics_claim"."status" in ('open', 'under_review', 'resolved', 'rejected')),
	CONSTRAINT "logistics_claim_amount_positive" CHECK ("logistics_claim"."estimated_amount" is null or "logistics_claim"."estimated_amount" > 0),
	CONSTRAINT "logistics_claim_amount_has_currency" CHECK (("logistics_claim"."estimated_amount" is null) = ("logistics_claim"."currency_code" is null)),
	CONSTRAINT "logistics_claim_resolution_complete" CHECK (("logistics_claim"."status" in ('open', 'under_review')
             and "logistics_claim"."resolved_by" is null and "logistics_claim"."resolved_at" is null)
          or ("logistics_claim"."status" in ('resolved', 'rejected')
             and "logistics_claim"."resolved_by" is not null and "logistics_claim"."resolved_at" is not null
             and coalesce(btrim("logistics_claim"."resolution"), '') <> ''))
);
--> statement-breakpoint
ALTER TABLE "logistics_delivery_evidence" ADD CONSTRAINT "logistics_delivery_evidence_job_id_logistics_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."logistics_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_delivery_evidence" ADD CONSTRAINT "logistics_delivery_evidence_attachment_id_attachment_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_delivery_evidence" ADD CONSTRAINT "logistics_delivery_evidence_recorded_by_app_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_claim" ADD CONSTRAINT "logistics_claim_job_id_logistics_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."logistics_job"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_claim" ADD CONSTRAINT "logistics_claim_leg_id_logistics_job_leg_id_fk" FOREIGN KEY ("leg_id") REFERENCES "public"."logistics_job_leg"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_claim" ADD CONSTRAINT "logistics_claim_currency_code_currency_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currency"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_claim" ADD CONSTRAINT "logistics_claim_resolved_by_app_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_claim" ADD CONSTRAINT "logistics_claim_raised_by_app_user_id_fk" FOREIGN KEY ("raised_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "logistics_delivery_evidence_uniq" ON "logistics_delivery_evidence" USING btree ("job_id","evidence_type");--> statement-breakpoint
CREATE INDEX "logistics_delivery_evidence_attachment_idx" ON "logistics_delivery_evidence" USING btree ("attachment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "logistics_claim_no_uniq" ON "logistics_claim" USING btree ("claim_no");--> statement-breakpoint
CREATE INDEX "logistics_claim_job_idx" ON "logistics_claim" USING btree ("job_id","status");--> statement-breakpoint
CREATE INDEX "logistics_claim_leg_idx" ON "logistics_claim" USING btree ("leg_id");--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE. Everything above is generated.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Phase 10.7 — delivery evidence and claims, §11.1 and §11.2.
--
-- §11.2 puts "Delivery Evidence" between the carrier's execution and the
-- client's settlement, and 10.7's gate is that "a job cannot settle without the
-- delivery evidence its type requires". The requirement itself is configuration
-- (`logistics_service_type_evidence`, migration 0141) because the blueprint
-- nowhere says what an air-freight job must prove as against a customs-clearance
-- job — that belongs to the Logistics department, not to this migration.
--
-- The check that a job holds what it needs lives with the settlement, in
-- migration 0146, because that is the moment it must be true.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The evidence document belongs to this job.
--
-- §21 holds attachments against `(object_type, object_id)`. Without this check
-- a job could cite a scanned delivery note attached to a different job — the
-- proof-of-delivery file would exist, the settlement would pass its check, and
-- the evidence would be for someone else's shipment.
--
-- The scan status is checked too: §21 quarantines an attachment until it scans
-- clean, and evidence that has not cleared the scanner is a file nobody has been
-- allowed to open.
-- ---------------------------------------------------------------------------
CREATE FUNCTION logistics_delivery_evidence_attachment_matches_job() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_object_type text;
  v_object_id   text;
  v_scan        attachment_scan_status;
  v_job_no      text;
  v_job_status  document_status;
BEGIN
  SELECT job_no, status INTO v_job_no, v_job_status
    FROM logistics_job WHERE id = NEW.job_id;

  IF v_job_status IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION
      'Logistics job % is %; delivery evidence cannot be added to it now (blueprint 11.2).',
      v_job_no, v_job_status USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT object_type, object_id, scan_status
    INTO v_object_type, v_object_id, v_scan
    FROM attachment WHERE id = NEW.attachment_id;

  IF v_object_type IS DISTINCT FROM 'logistics_job'
  OR v_object_id   IS DISTINCT FROM NEW.job_id::text THEN
    RAISE EXCEPTION
      'That attachment is not held against logistics job % (blueprint 21). Upload the evidence to this job — proof of delivery for another job proves nothing about this one.',
      v_job_no USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_scan IS DISTINCT FROM 'clean' THEN
    RAISE EXCEPTION
      'The attachment for % has not cleared the malware scan (blueprint 21, scan status %). Evidence nobody may open is not evidence.',
      NEW.evidence_type, coalesce(v_scan::text, 'unknown')
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER logistics_delivery_evidence_attachment_matches_job
  BEFORE INSERT OR UPDATE ON logistics_delivery_evidence
  FOR EACH ROW EXECUTE FUNCTION logistics_delivery_evidence_attachment_matches_job();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Evidence a settlement has already relied on is not withdrawn.
--
-- A settled job was allowed to settle *because* the evidence was there. Removing
-- it afterwards would leave a posted revenue entry resting on a proof that no
-- longer exists, and the §11.5 Delivery Exceptions report would show nothing
-- wrong.
-- ---------------------------------------------------------------------------
CREATE FUNCTION logistics_delivery_evidence_settled_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status document_status;
  v_no     text;
BEGIN
  SELECT status, job_no INTO v_status, v_no
    FROM logistics_job WHERE id = coalesce(NEW.job_id, OLD.job_id);

  IF v_status IN ('settled', 'closed') THEN
    RAISE EXCEPTION
      'Logistics job % has settled on this evidence (blueprint 11.2); it cannot be withdrawn or altered now. Reverse the settlement first.',
      v_no USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN coalesce(NEW, OLD);
END;
$$;--> statement-breakpoint

CREATE TRIGGER logistics_delivery_evidence_settled_is_final
  BEFORE UPDATE OR DELETE ON logistics_delivery_evidence
  FOR EACH ROW EXECUTE FUNCTION logistics_delivery_evidence_settled_is_final();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A claim's leg belongs to the claim's job.
--
-- Same reasoning as the cost's leg: two independent foreign keys, and the
-- Delivery Exceptions report attributes the exception to a carrier through the
-- leg. A leg from another job would blame the wrong carrier.
-- ---------------------------------------------------------------------------
CREATE FUNCTION logistics_claim_leg_belongs_to_job() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_leg_job uuid;
BEGIN
  IF NEW.leg_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT job_id INTO v_leg_job FROM logistics_job_leg WHERE id = NEW.leg_id;

  IF v_leg_job IS DISTINCT FROM NEW.job_id THEN
    RAISE EXCEPTION
      'Claim % names a route leg belonging to a different job (blueprint 11.5). The exception is reported against the carrier that ran *this* job''s leg.',
      NEW.claim_no USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER logistics_claim_leg_belongs_to_job
  BEFORE INSERT OR UPDATE OF leg_id, job_id ON logistics_claim
  FOR EACH ROW EXECUTE FUNCTION logistics_claim_leg_belongs_to_job();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A resolved claim stays resolved.
--
-- §5.4 makes the outcome of a decision part of the record. Reopening a closed
-- claim by editing the row would erase who decided what, and the resolution text
-- with it; a new claim is raised instead.
-- ---------------------------------------------------------------------------
CREATE FUNCTION logistics_claim_resolution_is_permanent() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Claim % is part of the delivery exception record (blueprint 1.1, 11.5) and is not deleted. Resolve or reject it.',
      OLD.claim_no USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status IN ('open', 'under_review') THEN
    RETURN NEW;
  END IF;

  IF NEW.status         IS DISTINCT FROM OLD.status
  OR NEW.resolution     IS DISTINCT FROM OLD.resolution
  OR NEW.resolved_by    IS DISTINCT FROM OLD.resolved_by
  OR NEW.resolved_at    IS DISTINCT FROM OLD.resolved_at
  OR NEW.claim_type     IS DISTINCT FROM OLD.claim_type
  OR NEW.estimated_amount IS DISTINCT FROM OLD.estimated_amount THEN
    RAISE EXCEPTION
      'Claim % has been %; the decision and its reason are part of the record (blueprint 5.4). Raise a new claim if something further has come to light.',
      OLD.claim_no, OLD.status USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER logistics_claim_resolution_is_permanent
  BEFORE UPDATE OR DELETE ON logistics_claim
  FOR EACH ROW EXECUTE FUNCTION logistics_claim_resolution_is_permanent();--> statement-breakpoint

-- Numbering, document types and permissions.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('LOGISTICS_CLAIM', 'LCL', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('logistics_delivery_evidence', 'Logistics Delivery Evidence', 'logistics',
   'Proof that the goods reached the client. The document itself is held by the section 21 attachment service; this records that a required kind of evidence exists.'),
  ('logistics_claim', 'Logistics Claim', 'logistics',
   'A delivery exception — damage, loss, delay or shortage. Posts nothing: Appendix C has no row for a claim and its financial treatment is open question Q10-4.');--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'logistics_delivery_evidence', 'view'),
  ('accounting_officer', 'logistics_delivery_evidence', 'create'),
  ('accounting_officer', 'logistics_claim', 'view'),
  ('accounting_officer', 'logistics_claim', 'create'),
  ('accounting_officer', 'logistics_claim', 'edit_draft'),
  ('accounting_manager', 'logistics_delivery_evidence', 'view'),
  ('accounting_manager', 'logistics_delivery_evidence', 'create'),
  ('accounting_manager', 'logistics_delivery_evidence', 'edit_draft'),
  ('accounting_manager', 'logistics_delivery_evidence', 'export'),
  ('accounting_manager', 'logistics_claim', 'view'),
  ('accounting_manager', 'logistics_claim', 'create'),
  ('accounting_manager', 'logistics_claim', 'edit_draft'),
  ('accounting_manager', 'logistics_claim', 'approve'),
  ('accounting_manager', 'logistics_claim', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON logistics_delivery_evidence, logistics_claim FROM erp_app;

  -- Evidence can be withdrawn while the job is still open — a wrong file was
  -- cited — which the trigger above scopes. After settlement, neither.
  GRANT SELECT, INSERT, UPDATE, DELETE ON logistics_delivery_evidence TO erp_app;
  -- A claim is a record: §1.1, no DELETE.
  GRANT SELECT, INSERT, UPDATE ON logistics_claim TO erp_app;
END;
$$;--> statement-breakpoint

ALTER TABLE logistics_delivery_evidence ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE logistics_delivery_evidence FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY logistics_delivery_evidence_branch_scope ON logistics_delivery_evidence
  USING (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM logistics_job j
       WHERE j.id = logistics_delivery_evidence.job_id AND j.branch_code = app_current_branch()
    )
  )
  WITH CHECK (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM logistics_job j
       WHERE j.id = logistics_delivery_evidence.job_id AND j.branch_code = app_current_branch()
    )
  );--> statement-breakpoint

ALTER TABLE logistics_claim ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE logistics_claim FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY logistics_claim_branch_scope ON logistics_claim
  USING (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM logistics_job j
       WHERE j.id = logistics_claim.job_id AND j.branch_code = app_current_branch()
    )
  )
  WITH CHECK (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM logistics_job j
       WHERE j.id = logistics_claim.job_id AND j.branch_code = app_current_branch()
    )
  );
