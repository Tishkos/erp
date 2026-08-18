CREATE TABLE "logistics_job_cost" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cost_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"job_id" uuid NOT NULL,
	"leg_id" uuid,
	"branch_code" text NOT NULL,
	"cost_date" date NOT NULL,
	"cost_type" text NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"currency_code" text NOT NULL,
	"settlement_mode" text NOT NULL,
	"bank_cash_account_id" uuid,
	"supplier_id" uuid,
	"journal_entry_id" uuid,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"supplier_reference" text,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "logistics_job_cost_amount_positive" CHECK ("logistics_job_cost"."amount" > 0),
	CONSTRAINT "logistics_job_cost_settlement_mode" CHECK ("logistics_job_cost"."settlement_mode" in ('bank', 'supplier_payable')),
	CONSTRAINT "logistics_job_cost_counterparty_matches_mode" CHECK (("logistics_job_cost"."settlement_mode" = 'bank'
             and "logistics_job_cost"."bank_cash_account_id" is not null and "logistics_job_cost"."supplier_id" is null)
          or ("logistics_job_cost"."settlement_mode" = 'supplier_payable'
             and "logistics_job_cost"."supplier_id" is not null and "logistics_job_cost"."bank_cash_account_id" is null)),
	CONSTRAINT "logistics_job_cost_type" CHECK ("logistics_job_cost"."cost_type" in ('freight', 'customs_duty', 'clearance', 'handling', 'storage',
                            'insurance', 'documentation', 'other')),
	CONSTRAINT "logistics_job_cost_posted_complete" CHECK (("logistics_job_cost"."posted_by" is null and "logistics_job_cost"."posted_at" is null and "logistics_job_cost"."journal_entry_id" is null)
          or ("logistics_job_cost"."posted_by" is not null and "logistics_job_cost"."posted_at" is not null
              and "logistics_job_cost"."journal_entry_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "logistics_job_cost" ADD CONSTRAINT "logistics_job_cost_job_id_logistics_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."logistics_job"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_job_cost" ADD CONSTRAINT "logistics_job_cost_leg_id_logistics_job_leg_id_fk" FOREIGN KEY ("leg_id") REFERENCES "public"."logistics_job_leg"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_job_cost" ADD CONSTRAINT "logistics_job_cost_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_job_cost" ADD CONSTRAINT "logistics_job_cost_currency_code_currency_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currency"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_job_cost" ADD CONSTRAINT "logistics_job_cost_bank_cash_account_id_bank_cash_account_id_fk" FOREIGN KEY ("bank_cash_account_id") REFERENCES "public"."bank_cash_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_job_cost" ADD CONSTRAINT "logistics_job_cost_supplier_id_business_partner_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_job_cost" ADD CONSTRAINT "logistics_job_cost_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_job_cost" ADD CONSTRAINT "logistics_job_cost_posted_by_app_user_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_job_cost" ADD CONSTRAINT "logistics_job_cost_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "logistics_job_cost_no_uniq" ON "logistics_job_cost" USING btree ("cost_no");--> statement-breakpoint
CREATE INDEX "logistics_job_cost_job_idx" ON "logistics_job_cost" USING btree ("job_id","status");--> statement-breakpoint
CREATE INDEX "logistics_job_cost_leg_idx" ON "logistics_job_cost" USING btree ("leg_id");--> statement-breakpoint
CREATE INDEX "logistics_job_cost_supplier_idx" ON "logistics_job_cost" USING btree ("supplier_id","status");--> statement-breakpoint
CREATE INDEX "logistics_job_cost_branch_idx" ON "logistics_job_cost" USING btree ("branch_code","cost_date");--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE. Everything above is generated.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Phase 10.5 — third-party direct cost, §11.3 and §11.4.
--
-- §11.3: "The company does not absorb logistics costs; direct logistics expenses
-- are allocated to the job and deducted from the logistics service charge to
-- determine job margin."
-- Appendix C, Logistics direct cost: Logistics Job Cost | Bank / Supplier A/P |
-- **"Job link mandatory."**
--
-- The mandatory job link is `job_id uuid NOT NULL REFERENCES logistics_job(id)`,
-- and that is the whole enforcement. A service-layer check would be a rule
-- somebody could route around by inserting directly, by importing a batch, or by
-- writing a second code path in a hurry. A NOT NULL column cannot be routed
-- around: there is no state of this table in which an unallocated logistics cost
-- exists, so 10.5's gate — "a logistics cost without a job link cannot be
-- posted" — is not a behaviour, it is a property.
--
-- The companion gate, "no logistics cost lands in a general overhead account",
-- is enforced one layer up: this document posts under the single line role
-- `logistics_job_cost`, and §3.3's mapping resolves that role to whichever
-- account Finance nominates. The service has no code path that emits a generic
-- expense role, and the integration test asserts the debit account of every
-- posted cost is the one the `logistics_job_cost` rule names.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- A cost's leg belongs to the cost's own job.
--
-- The two foreign keys are independent, so without this a cost on job A could
-- name a leg of job B and the Carrier Payables report (§11.5) would bill the
-- wrong job's margin for it. A relationship between two columns is something no
-- single foreign key can express, so it is a trigger.
-- ---------------------------------------------------------------------------
CREATE FUNCTION logistics_job_cost_leg_belongs_to_job() RETURNS trigger
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
      'Cost % names a route leg belonging to a different job (blueprint 11.3). A cost is allocated to one job; the leg must be one of its own.',
      NEW.cost_no
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER logistics_job_cost_leg_belongs_to_job
  BEFORE INSERT OR UPDATE OF leg_id, job_id ON logistics_job_cost
  FOR EACH ROW EXECUTE FUNCTION logistics_job_cost_leg_belongs_to_job();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Costs land on a job that has been approved and has not yet been settled.
--
-- Before approval there is no agreed service to allocate against; after
-- settlement the margin has been reported to the G/L and a late cost would make
-- 10.8's "job margin reconciles to the G/L" quietly false. §11.2's workflow puts
-- Cost Recording between Carrier Execution and Client Settlement, and this is
-- that ordering made real.
-- ---------------------------------------------------------------------------
CREATE FUNCTION logistics_job_cost_job_is_costable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status document_status;
  v_no     text;
BEGIN
  SELECT status, job_no INTO v_status, v_no
    FROM logistics_job WHERE id = NEW.job_id;

  IF v_status = 'draft' THEN
    RAISE EXCEPTION
      'Logistics job % is still a draft, so nothing can be spent against it yet (blueprint 11.2). Approve the job first — the approval is what authorises the spend.',
      v_no USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_status IN ('settled', 'closed', 'cancelled') THEN
    RAISE EXCEPTION
      'Logistics job % is %; its margin has already been reported (blueprint 11.3). A cost recorded now would never reach the margin the G/L shows.',
      v_no, v_status USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER logistics_job_cost_job_is_costable
  BEFORE INSERT ON logistics_job_cost
  FOR EACH ROW EXECUTE FUNCTION logistics_job_cost_job_is_costable();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A supplier on a cost is a supplier.
--
-- 10.3's gate is that carrier payables reconcile to the A/P subledger, and the
-- subledger is keyed on the Business Partner. A cost accrued against a party
-- with no supplier role would create a payable with no ledger to reconcile to.
-- ---------------------------------------------------------------------------
CREATE FUNCTION logistics_job_cost_supplier_is_supplier() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_is_supplier boolean;
  v_code        text;
BEGIN
  IF NEW.supplier_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT is_supplier, code INTO v_is_supplier, v_code
    FROM business_partner WHERE id = NEW.supplier_id;

  IF NOT coalesce(v_is_supplier, false) THEN
    RAISE EXCEPTION
      'Business partner % is not a supplier, so cost % cannot be accrued to it (blueprint 4.4, 15). The A/P subledger has no ledger for a party that is not a supplier.',
      coalesce(v_code, NEW.supplier_id::text), NEW.cost_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER logistics_job_cost_supplier_is_supplier
  BEFORE INSERT OR UPDATE OF supplier_id ON logistics_job_cost
  FOR EACH ROW EXECUTE FUNCTION logistics_job_cost_supplier_is_supplier();--> statement-breakpoint

-- §3.2 — a posted cost is history, corrected by reversal.
CREATE FUNCTION logistics_job_cost_posted_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'posted' THEN
    RETURN NEW;
  END IF;

  IF NEW.amount               IS DISTINCT FROM OLD.amount
  OR NEW.currency_code        IS DISTINCT FROM OLD.currency_code
  OR NEW.job_id               IS DISTINCT FROM OLD.job_id
  OR NEW.leg_id               IS DISTINCT FROM OLD.leg_id
  OR NEW.cost_date            IS DISTINCT FROM OLD.cost_date
  OR NEW.cost_type            IS DISTINCT FROM OLD.cost_type
  OR NEW.settlement_mode      IS DISTINCT FROM OLD.settlement_mode
  OR NEW.supplier_id          IS DISTINCT FROM OLD.supplier_id
  OR NEW.bank_cash_account_id IS DISTINCT FROM OLD.bank_cash_account_id
  OR NEW.journal_entry_id     IS DISTINCT FROM OLD.journal_entry_id
  OR NEW.branch_code          IS DISTINCT FROM OLD.branch_code
  OR NEW.cost_no              IS DISTINCT FROM OLD.cost_no THEN
    RAISE EXCEPTION
      'Logistics cost % has posted; it is part of the job margin the ledger reports (blueprint 3.2). Reverse it and record the correction.',
      OLD.cost_no USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER logistics_job_cost_posted_is_final
  BEFORE UPDATE ON logistics_job_cost
  FOR EACH ROW EXECUTE FUNCTION logistics_job_cost_posted_is_final();--> statement-breakpoint

-- Numbering, document type, statuses and permissions.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('LOGISTICS_JOB_COST', 'LJC', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('logistics_job_cost', 'Logistics Direct Cost', 'logistics',
   'A third-party expense allocated to a logistics job. Dr Logistics Job Cost / Cr Bank or Supplier A/P (Appendix C). Job link is mandatory and enforced by the column.');--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('logistics_job_cost', 'draft',  'posted'),
  ('logistics_job_cost', 'draft',  'cancelled'),
  ('logistics_job_cost', 'posted', 'reversed');--> statement-breakpoint

INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('logistics_job_cost', 'job_id',
   'Appendix C makes the job link mandatory: it decides whose margin bears the cost.'),
  ('logistics_job_cost', 'amount',
   'Deducted from the service charge to determine job margin (section 11.3).'),
  ('logistics_job_cost', 'settlement_mode',
   'Decides the credit side: the bank, or the supplier''s A/P.'),
  ('logistics_job_cost', 'cost_date',
   'Decides the accounting period the cost lands in.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'logistics_job_cost', 'view'),
  ('accounting_officer', 'logistics_job_cost', 'create'),
  ('accounting_officer', 'logistics_job_cost', 'edit_draft'),
  ('accounting_officer', 'logistics_job_cost', 'submit'),
  ('accounting_manager', 'logistics_job_cost', 'view'),
  ('accounting_manager', 'logistics_job_cost', 'create'),
  ('accounting_manager', 'logistics_job_cost', 'edit_draft'),
  ('accounting_manager', 'logistics_job_cost', 'submit'),
  ('accounting_manager', 'logistics_job_cost', 'approve'),
  ('accounting_manager', 'logistics_job_cost', 'post'),
  ('accounting_manager', 'logistics_job_cost', 'reverse_cancel'),
  ('accounting_manager', 'logistics_job_cost', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON logistics_job_cost FROM erp_app;

  -- §1.1 keeps saved documents: no DELETE. A cost raised in error is cancelled
  -- while it is a draft and reversed once it has posted.
  GRANT SELECT, INSERT, UPDATE ON logistics_job_cost TO erp_app;
END;
$$;--> statement-breakpoint

ALTER TABLE logistics_job_cost ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE logistics_job_cost FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY logistics_job_cost_branch_scope ON logistics_job_cost
  USING (app_is_super_user() OR branch_code = app_current_branch())
  WITH CHECK (app_is_super_user() OR branch_code = app_current_branch());
