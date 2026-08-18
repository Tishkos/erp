CREATE TABLE "logistics_job_settlement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"settlement_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"job_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"settlement_date" date NOT NULL,
	"recognised_amount" numeric(19, 4) NOT NULL,
	"from_clearing_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"from_receivable_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"currency_code" text NOT NULL,
	"journal_entry_id" uuid,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "logistics_job_settlement_amount_positive" CHECK ("logistics_job_settlement"."recognised_amount" > 0),
	CONSTRAINT "logistics_job_settlement_split_non_negative" CHECK ("logistics_job_settlement"."from_clearing_amount" >= 0 and "logistics_job_settlement"."from_receivable_amount" >= 0),
	CONSTRAINT "logistics_job_settlement_split_totals" CHECK ("logistics_job_settlement"."from_clearing_amount" + "logistics_job_settlement"."from_receivable_amount" = "logistics_job_settlement"."recognised_amount"),
	CONSTRAINT "logistics_job_settlement_posted_complete" CHECK (("logistics_job_settlement"."posted_by" is null and "logistics_job_settlement"."posted_at" is null and "logistics_job_settlement"."journal_entry_id" is null)
          or ("logistics_job_settlement"."posted_by" is not null and "logistics_job_settlement"."posted_at" is not null
              and "logistics_job_settlement"."journal_entry_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "logistics_job_settlement" ADD CONSTRAINT "logistics_job_settlement_job_id_logistics_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."logistics_job"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_job_settlement" ADD CONSTRAINT "logistics_job_settlement_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_job_settlement" ADD CONSTRAINT "logistics_job_settlement_currency_code_currency_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currency"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_job_settlement" ADD CONSTRAINT "logistics_job_settlement_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_job_settlement" ADD CONSTRAINT "logistics_job_settlement_posted_by_app_user_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_job_settlement" ADD CONSTRAINT "logistics_job_settlement_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "logistics_job_settlement_no_uniq" ON "logistics_job_settlement" USING btree ("settlement_no");--> statement-breakpoint
CREATE INDEX "logistics_job_settlement_job_idx" ON "logistics_job_settlement" USING btree ("job_id","status");--> statement-breakpoint
CREATE INDEX "logistics_job_settlement_branch_idx" ON "logistics_job_settlement" USING btree ("branch_code","settlement_date");--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE. Everything above is generated.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Phase 10.8 — settlement, billing and close, §11.4.
--
-- §11.4's third row: Service completion and recognition | Client Logistics
-- Clearing / Client A/R | Logistics Revenue.
-- Appendix C: Logistics service recognition — **"Separate from Money Transfer
-- margin."**
--
-- This is the only place logistics revenue reaches the ledger, and revenue
-- recognises here because this is where *service completion* is recorded. A job
-- that has been funded but not delivered has money in a clearing account and no
-- revenue, which is what §11.4's second column is for.
-- ---------------------------------------------------------------------------

-- The charge's link to the settlement that billed it, added now that the
-- settlement table exists. Declared in Drizzle as a plain uuid: the two tables
-- reference each other in opposite directions across two migrations, and a
-- forward reference in the schema file would be a cycle Drizzle cannot order.
ALTER TABLE "logistics_client_charge" ADD CONSTRAINT "logistics_client_charge_settlement_id_logistics_job_settlement_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."logistics_job_settlement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A settlement belongs to a delivered job that holds its required evidence.
--
-- 10.7's gate: "a job cannot settle without the delivery evidence its type
-- requires". 10.2's: the job "progresses through every status in the defined
-- order". Both are checked here, at the moment the settlement is raised, because
-- that is when they must be true and because a check that lives only in the
-- service is a check a direct insert walks past.
--
-- The required set comes from `logistics_service_type_evidence`, which Logistics
-- configures. A service type with no configured evidence requires none — that is
-- a decision the department makes by leaving the list empty, not one this
-- migration makes by seeding a default.
-- ---------------------------------------------------------------------------
CREATE FUNCTION logistics_settlement_job_is_deliverable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status  document_status;
  v_no      text;
  v_type    text;
  v_missing text[];
BEGIN
  SELECT status, job_no, service_type_code INTO v_status, v_no, v_type
    FROM logistics_job WHERE id = NEW.job_id;

  IF v_status <> 'executed' THEN
    RAISE EXCEPTION
      'Logistics job % is ''%'', not Delivered (Appendix B). Section 11.4 recognises revenue on service completion, so the job is delivered before it is settled.',
      v_no, v_status USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT coalesce(array_agg(e.evidence_type ORDER BY e.evidence_type), '{}')
    INTO v_missing
    FROM logistics_service_type_evidence e
   WHERE e.service_type_code = v_type
     AND NOT EXISTS (
       SELECT 1 FROM logistics_delivery_evidence d
        WHERE d.job_id = NEW.job_id AND d.evidence_type = e.evidence_type
     );

  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'Logistics job % cannot settle: service type % still requires %(blueprint 11.2). Record the delivery evidence first.',
      v_no, v_type, array_to_string(v_missing, ', ')
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER logistics_settlement_job_is_deliverable
  BEFORE INSERT ON logistics_job_settlement
  FOR EACH ROW EXECUTE FUNCTION logistics_settlement_job_is_deliverable();--> statement-breakpoint

-- One live settlement per job.
--
-- Two settlements would recognise the same service twice, and the second would
-- be posted against a clearing balance the first had already discharged. A
-- partial unique index rather than a plain one, so a reversed settlement can be
-- replaced by a corrected one.
CREATE UNIQUE INDEX logistics_job_settlement_one_live_per_job
  ON logistics_job_settlement (job_id)
  WHERE status <> 'reversed' AND status <> 'cancelled';--> statement-breakpoint

-- §3.2 — a posted settlement is history.
CREATE FUNCTION logistics_settlement_posted_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'posted' THEN
    RETURN NEW;
  END IF;

  IF NEW.recognised_amount      IS DISTINCT FROM OLD.recognised_amount
  OR NEW.from_clearing_amount   IS DISTINCT FROM OLD.from_clearing_amount
  OR NEW.from_receivable_amount IS DISTINCT FROM OLD.from_receivable_amount
  OR NEW.currency_code          IS DISTINCT FROM OLD.currency_code
  OR NEW.job_id                 IS DISTINCT FROM OLD.job_id
  OR NEW.settlement_date        IS DISTINCT FROM OLD.settlement_date
  OR NEW.journal_entry_id       IS DISTINCT FROM OLD.journal_entry_id
  OR NEW.branch_code            IS DISTINCT FROM OLD.branch_code
  OR NEW.settlement_no          IS DISTINCT FROM OLD.settlement_no THEN
    RAISE EXCEPTION
      'Settlement % has posted; it is the logistics revenue the ledger reports (blueprint 3.2). Reverse it and settle again.',
      OLD.settlement_no USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER logistics_settlement_posted_is_final
  BEFORE UPDATE ON logistics_job_settlement
  FOR EACH ROW EXECUTE FUNCTION logistics_settlement_posted_is_final();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A job closes only when nothing is left outstanding.
--
-- 10.2's gate: "A job cannot close with unsettled costs or unbilled charges."
-- 10.8's: "A job cannot close with an open client balance or unrecorded cost."
--
-- Five separate questions, all asked here rather than in the service, because a
-- close is the last moment anybody looks at the job. After it, the margin is
-- history and an omission found later has no document left to correct.
--
--   unbilled charges   a charge with no settlement is revenue nobody decided to
--                      forgo
--   draft costs        a cost still in draft never reached the margin the G/L
--                      reports
--   client balance     funded minus recognised, which must be nil: money left in
--                      a clearing account belongs to somebody
--   open legs          a movement still running is a carrier payable not yet
--                      landed
--   open claims        a delivery exception with money attached
--
-- The domain module computes the same five in `closeBlockers` so the refusal can
-- list all of them at once; this is what makes the refusal true.
-- ---------------------------------------------------------------------------
CREATE FUNCTION logistics_job_close_is_clean() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_unbilled     numeric(19,4);
  v_draft_costs  numeric(19,4);
  v_funded       numeric(19,4);
  v_recognised   numeric(19,4);
  v_open_legs    int;
  v_open_claims  int;
BEGIN
  IF NEW.status <> 'closed' OR OLD.status = 'closed' THEN
    RETURN NEW;
  END IF;

  SELECT coalesce(sum(amount), 0) INTO v_unbilled
    FROM logistics_client_charge
   WHERE job_id = NEW.id AND settlement_id IS NULL;

  IF v_unbilled <> 0 THEN
    RAISE EXCEPTION
      'Logistics job % has % of client charges that were never billed (blueprint 11.4). Bill them on the settlement, or remove them.',
      NEW.job_no, v_unbilled USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT coalesce(sum(amount), 0) INTO v_draft_costs
    FROM logistics_job_cost
   WHERE job_id = NEW.id AND status = 'draft';

  IF v_draft_costs <> 0 THEN
    RAISE EXCEPTION
      'Logistics job % has % of third-party cost still in draft (blueprint 11.3). Post it or cancel it — an unposted cost never reaches the job margin.',
      NEW.job_no, v_draft_costs USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT coalesce(sum(amount), 0) INTO v_funded
    FROM logistics_client_funding
   WHERE job_id = NEW.id AND status = 'posted';

  SELECT coalesce(sum(recognised_amount), 0) INTO v_recognised
    FROM logistics_job_settlement
   WHERE job_id = NEW.id AND status = 'posted';

  IF v_funded <> v_recognised THEN
    RAISE EXCEPTION
      'Logistics job % still has a client balance: % funded against % recognised (blueprint 11.4). Settle or refund the difference — a closed job with a live balance is a balance nobody owns.',
      NEW.job_no, v_funded, v_recognised USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT count(*) INTO v_open_legs
    FROM logistics_job_leg
   WHERE job_id = NEW.id AND status NOT IN ('completed', 'cancelled');

  IF v_open_legs > 0 THEN
    RAISE EXCEPTION
      'Logistics job % has % route leg(s) still running (blueprint 11.5). Carrier payables are measured per leg; complete or cancel them first.',
      NEW.job_no, v_open_legs USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT count(*) INTO v_open_claims
    FROM logistics_claim
   WHERE job_id = NEW.id AND status IN ('open', 'under_review');

  IF v_open_claims > 0 THEN
    RAISE EXCEPTION
      'Logistics job % has % open claim(s) (blueprint 11.5). A claim is a delivery exception with money attached; resolve or reject it before the job closes.',
      NEW.job_no, v_open_claims USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

-- Runs after the ordering trigger, so an out-of-order close is refused for the
-- reason a clerk will understand before this one starts counting money. Trigger
-- names fire alphabetically per timing, and `logistics_job_status_follows_order`
-- sorts after `logistics_job_close_is_clean` — so this one is named to sort last
-- deliberately.
CREATE TRIGGER logistics_job_zz_close_is_clean
  BEFORE UPDATE ON logistics_job
  FOR EACH ROW EXECUTE FUNCTION logistics_job_close_is_clean();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- An import file closes when its logistics jobs have finished with it.
--
-- The logistics half of the rule migration 0140 could not state, because
-- `logistics_job` did not exist then. Phase 09 adds its own half for money
-- transfers when it lands: each module answers for its own documents rather than
-- one migration knowing them all.
-- ---------------------------------------------------------------------------
CREATE FUNCTION client_import_file_close_needs_jobs_done() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_open int;
BEGIN
  IF NEW.status <> 'closed' OR OLD.status = 'closed' THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_open
    FROM logistics_job
   WHERE import_file_id = NEW.id AND status NOT IN ('closed', 'cancelled');

  IF v_open > 0 THEN
    RAISE EXCEPTION
      'Client import file % still has % logistics job(s) running (blueprint 11). Close or cancel them first — a closed file with a live job hides the job from the Import File Status report.',
      NEW.file_no, v_open USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER client_import_file_close_needs_jobs_done
  BEFORE UPDATE ON logistics_client_import_file
  FOR EACH ROW EXECUTE FUNCTION client_import_file_close_needs_jobs_done();--> statement-breakpoint

-- Numbering, document type, statuses and permissions.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('LOGISTICS_JOB_SETTLEMENT', 'LJS', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('logistics_job_settlement', 'Logistics Job Settlement', 'logistics',
   'Recognises the logistics service on completion. Dr Client Logistics Clearing and/or Client A/R, Cr Logistics Revenue (section 11.4) — separate from Money Transfer margin (Appendix C).');--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('logistics_job_settlement', 'draft',  'posted'),
  ('logistics_job_settlement', 'draft',  'cancelled'),
  ('logistics_job_settlement', 'posted', 'reversed');--> statement-breakpoint

INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('logistics_job_settlement', 'job_id',
   'Decides whose margin and whose revenue this recognition belongs to.'),
  ('logistics_job_settlement', 'recognised_amount',
   'The logistics revenue posted (section 11.4). The two debit halves must add back to it.'),
  ('logistics_job_settlement', 'settlement_date',
   'Decides the accounting period the revenue lands in.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'logistics_job_settlement', 'view'),
  ('accounting_officer', 'logistics_job_settlement', 'create'),
  ('accounting_officer', 'logistics_job_settlement', 'edit_draft'),
  ('accounting_officer', 'logistics_job_settlement', 'submit'),
  ('accounting_manager', 'logistics_job_settlement', 'view'),
  ('accounting_manager', 'logistics_job_settlement', 'create'),
  ('accounting_manager', 'logistics_job_settlement', 'edit_draft'),
  ('accounting_manager', 'logistics_job_settlement', 'submit'),
  ('accounting_manager', 'logistics_job_settlement', 'approve'),
  ('accounting_manager', 'logistics_job_settlement', 'post'),
  ('accounting_manager', 'logistics_job_settlement', 'reverse_cancel'),
  ('accounting_manager', 'logistics_job_settlement', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON logistics_job_settlement FROM erp_app;

  -- §1.1 keeps saved documents: no DELETE.
  GRANT SELECT, INSERT, UPDATE ON logistics_job_settlement TO erp_app;
END;
$$;--> statement-breakpoint

ALTER TABLE logistics_job_settlement ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE logistics_job_settlement FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY logistics_job_settlement_branch_scope ON logistics_job_settlement
  USING (app_is_super_user() OR branch_code = app_current_branch())
  WITH CHECK (app_is_super_user() OR branch_code = app_current_branch());
