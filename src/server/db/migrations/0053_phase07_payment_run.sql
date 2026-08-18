CREATE TYPE "public"."batch_line_status" AS ENUM('pending', 'executed', 'failed', 'returned');--> statement-breakpoint
CREATE TYPE "public"."proposal_inclusion" AS ENUM('selected', 'deferred_funds', 'excluded_not_due', 'excluded_unapproved', 'excluded_settled', 'excluded_blocked', 'excluded_no_bank_details', 'excluded_currency');
--> statement-breakpoint
CREATE TABLE "payment_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"proposal_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"bank_cash_account_id" uuid NOT NULL,
	"payment_date" date NOT NULL,
	"currency" text DEFAULT 'IQD' NOT NULL,
	"total_iqd" numeric(19, 4) NOT NULL,
	"line_count" integer NOT NULL,
	"bank_instruction_ref" text,
	"high_risk" boolean NOT NULL,
	"risk_threshold_iqd" numeric(19, 4),
	"created_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"executed_by" uuid,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_batch_total_positive" CHECK ("payment_batch"."total_iqd" > 0),
	CONSTRAINT "payment_batch_line_count_positive" CHECK ("payment_batch"."line_count" > 0),
	CONSTRAINT "payment_batch_maker_checker" CHECK (not "payment_batch"."high_risk"
          or ("payment_batch"."approved_by" is null or "payment_batch"."approved_by" <> "payment_batch"."created_by")
             and ("payment_batch"."executed_by" is null or "payment_batch"."executed_by" <> "payment_batch"."created_by")
             and ("payment_batch"."executed_by" is null or "payment_batch"."approved_by" is null
                  or "payment_batch"."executed_by" <> "payment_batch"."approved_by")),
	CONSTRAINT "payment_batch_executed_after_approval" CHECK ("payment_batch"."executed_by" is null or "payment_batch"."approved_by" is not null),
	CONSTRAINT "payment_batch_execution_complete" CHECK (("payment_batch"."executed_by" is null and "payment_batch"."executed_at" is null)
          or ("payment_batch"."executed_by" is not null and "payment_batch"."executed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "payment_batch_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"supplier_id" uuid NOT NULL,
	"ap_invoice_id" uuid,
	"supplier_advance_id" uuid,
	"partner_bank_account_id" uuid NOT NULL,
	"approved_beneficiary_revision" integer,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"status" "batch_line_status" DEFAULT 'pending' NOT NULL,
	"supplier_payment_id" uuid,
	"failure_reason" text,
	"returned_at" timestamp with time zone,
	"returned_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_batch_line_one_source" CHECK (("payment_batch_line"."ap_invoice_id" is not null and "payment_batch_line"."supplier_advance_id" is null)
          or ("payment_batch_line"."ap_invoice_id" is null and "payment_batch_line"."supplier_advance_id" is not null)),
	CONSTRAINT "payment_batch_line_amount_positive" CHECK ("payment_batch_line"."amount_iqd" > 0),
	CONSTRAINT "payment_batch_line_executed_has_payment" CHECK (("payment_batch_line"."ap_invoice_id" is not null
           and ("payment_batch_line"."status" in ('executed', 'returned')) = ("payment_batch_line"."supplier_payment_id" is not null))
          or ("payment_batch_line"."supplier_advance_id" is not null and "payment_batch_line"."supplier_payment_id" is null)),
	CONSTRAINT "payment_batch_line_failure_has_reason" CHECK ("payment_batch_line"."status" not in ('failed', 'returned')
          or coalesce(btrim("payment_batch_line"."failure_reason"), '') <> ''),
	CONSTRAINT "payment_batch_line_return_complete" CHECK (("payment_batch_line"."returned_at" is null and "payment_batch_line"."returned_by" is null)
          or ("payment_batch_line"."returned_at" is not null and "payment_batch_line"."returned_by" is not null
              and "payment_batch_line"."status" = 'returned'))
);
--> statement-breakpoint
CREATE TABLE "payment_proposal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"branch_code" text NOT NULL,
	"bank_cash_account_id" uuid NOT NULL,
	"proposal_date" date NOT NULL,
	"pay_date" date NOT NULL,
	"currency" text DEFAULT 'IQD' NOT NULL,
	"available_funds_iqd" numeric(19, 4) NOT NULL,
	"selected_total_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"deferred_total_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"note" text,
	"created_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_proposal_funds_not_negative" CHECK ("payment_proposal"."available_funds_iqd" >= 0),
	CONSTRAINT "payment_proposal_within_available_cash" CHECK ("payment_proposal"."selected_total_iqd" <= "payment_proposal"."available_funds_iqd"),
	CONSTRAINT "payment_proposal_pay_date_not_before_built" CHECK ("payment_proposal"."pay_date" >= "payment_proposal"."proposal_date")
);
--> statement-breakpoint
CREATE TABLE "payment_proposal_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"ap_invoice_id" uuid,
	"supplier_advance_id" uuid,
	"partner_bank_account_id" uuid,
	"beneficiary_revision" integer,
	"reference" text NOT NULL,
	"due_date" date NOT NULL,
	"currency" text NOT NULL,
	"outstanding_iqd" numeric(19, 4) NOT NULL,
	"priority" smallint DEFAULT 5 NOT NULL,
	"discount_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"discount_deadline" date,
	"inclusion" "proposal_inclusion" NOT NULL,
	"reason" text,
	CONSTRAINT "payment_proposal_item_one_source" CHECK (("payment_proposal_item"."ap_invoice_id" is not null and "payment_proposal_item"."supplier_advance_id" is null)
          or ("payment_proposal_item"."ap_invoice_id" is null and "payment_proposal_item"."supplier_advance_id" is not null)),
	CONSTRAINT "payment_proposal_item_outstanding_positive" CHECK (case when "payment_proposal_item"."inclusion" = 'selected' then "payment_proposal_item"."outstanding_iqd" > 0
               else "payment_proposal_item"."outstanding_iqd" >= 0 end),
	CONSTRAINT "payment_proposal_item_discount_not_negative" CHECK ("payment_proposal_item"."discount_iqd" >= 0),
	CONSTRAINT "payment_proposal_item_priority_range" CHECK ("payment_proposal_item"."priority" between 1 and 9),
	CONSTRAINT "payment_proposal_item_reason_present" CHECK (("payment_proposal_item"."inclusion" = 'selected' and "payment_proposal_item"."reason" is null)
          or ("payment_proposal_item"."inclusion" <> 'selected' and coalesce(btrim("payment_proposal_item"."reason"), '') <> '')),
	CONSTRAINT "payment_proposal_item_selected_has_beneficiary" CHECK ("payment_proposal_item"."inclusion" <> 'selected' or "payment_proposal_item"."partner_bank_account_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "payment_risk_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_code" text,
	"high_risk_threshold_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"note" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_risk_policy_threshold_not_negative" CHECK ("payment_risk_policy"."high_risk_threshold_iqd" >= 0)
);
--> statement-breakpoint
ALTER TABLE "payment_batch" ADD CONSTRAINT "payment_batch_proposal_id_payment_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."payment_proposal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batch" ADD CONSTRAINT "payment_batch_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batch" ADD CONSTRAINT "payment_batch_bank_cash_account_id_bank_cash_account_id_fk" FOREIGN KEY ("bank_cash_account_id") REFERENCES "public"."bank_cash_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batch" ADD CONSTRAINT "payment_batch_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batch" ADD CONSTRAINT "payment_batch_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batch" ADD CONSTRAINT "payment_batch_executed_by_app_user_id_fk" FOREIGN KEY ("executed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batch_line" ADD CONSTRAINT "payment_batch_line_batch_id_payment_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."payment_batch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batch_line" ADD CONSTRAINT "payment_batch_line_supplier_id_business_partner_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batch_line" ADD CONSTRAINT "payment_batch_line_ap_invoice_id_ap_invoice_id_fk" FOREIGN KEY ("ap_invoice_id") REFERENCES "public"."ap_invoice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batch_line" ADD CONSTRAINT "payment_batch_line_supplier_advance_id_supplier_advance_id_fk" FOREIGN KEY ("supplier_advance_id") REFERENCES "public"."supplier_advance"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batch_line" ADD CONSTRAINT "payment_batch_line_partner_bank_account_id_partner_bank_account_id_fk" FOREIGN KEY ("partner_bank_account_id") REFERENCES "public"."partner_bank_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batch_line" ADD CONSTRAINT "payment_batch_line_supplier_payment_id_supplier_payment_id_fk" FOREIGN KEY ("supplier_payment_id") REFERENCES "public"."supplier_payment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_batch_line" ADD CONSTRAINT "payment_batch_line_returned_by_app_user_id_fk" FOREIGN KEY ("returned_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_proposal" ADD CONSTRAINT "payment_proposal_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_proposal" ADD CONSTRAINT "payment_proposal_bank_cash_account_id_bank_cash_account_id_fk" FOREIGN KEY ("bank_cash_account_id") REFERENCES "public"."bank_cash_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_proposal" ADD CONSTRAINT "payment_proposal_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_proposal" ADD CONSTRAINT "payment_proposal_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_proposal_item" ADD CONSTRAINT "payment_proposal_item_proposal_id_payment_proposal_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."payment_proposal"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_proposal_item" ADD CONSTRAINT "payment_proposal_item_supplier_id_business_partner_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_proposal_item" ADD CONSTRAINT "payment_proposal_item_ap_invoice_id_ap_invoice_id_fk" FOREIGN KEY ("ap_invoice_id") REFERENCES "public"."ap_invoice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_proposal_item" ADD CONSTRAINT "payment_proposal_item_supplier_advance_id_supplier_advance_id_fk" FOREIGN KEY ("supplier_advance_id") REFERENCES "public"."supplier_advance"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_proposal_item" ADD CONSTRAINT "payment_proposal_item_partner_bank_account_id_partner_bank_account_id_fk" FOREIGN KEY ("partner_bank_account_id") REFERENCES "public"."partner_bank_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_risk_policy" ADD CONSTRAINT "payment_risk_policy_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_risk_policy" ADD CONSTRAINT "payment_risk_policy_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_batch_no_uniq" ON "payment_batch" USING btree ("batch_no");--> statement-breakpoint
CREATE INDEX "payment_batch_proposal_idx" ON "payment_batch" USING btree ("proposal_id");--> statement-breakpoint
CREATE INDEX "payment_batch_account_idx" ON "payment_batch" USING btree ("bank_cash_account_id","payment_date");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_batch_instruction_uniq" ON "payment_batch" USING btree ("bank_instruction_ref") WHERE bank_instruction_ref is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_batch_line_no_uniq" ON "payment_batch_line" USING btree ("batch_id","line_no");--> statement-breakpoint
CREATE INDEX "payment_batch_line_supplier_idx" ON "payment_batch_line" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "payment_batch_line_invoice_idx" ON "payment_batch_line" USING btree ("ap_invoice_id");--> statement-breakpoint
CREATE INDEX "payment_batch_line_advance_idx" ON "payment_batch_line" USING btree ("supplier_advance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_batch_line_invoice_live_uniq" ON "payment_batch_line" USING btree ("ap_invoice_id") WHERE ap_invoice_id is not null and status in ('pending', 'executed');--> statement-breakpoint
CREATE UNIQUE INDEX "payment_batch_line_advance_live_uniq" ON "payment_batch_line" USING btree ("supplier_advance_id") WHERE supplier_advance_id is not null and status in ('pending', 'executed');--> statement-breakpoint
CREATE UNIQUE INDEX "payment_proposal_no_uniq" ON "payment_proposal" USING btree ("proposal_no");--> statement-breakpoint
CREATE INDEX "payment_proposal_account_idx" ON "payment_proposal" USING btree ("bank_cash_account_id","pay_date");--> statement-breakpoint
CREATE INDEX "payment_proposal_item_proposal_idx" ON "payment_proposal_item" USING btree ("proposal_id","inclusion");--> statement-breakpoint
CREATE INDEX "payment_proposal_item_invoice_idx" ON "payment_proposal_item" USING btree ("ap_invoice_id");--> statement-breakpoint
CREATE INDEX "payment_proposal_item_advance_idx" ON "payment_proposal_item" USING btree ("supplier_advance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_risk_policy_branch_uniq" ON "payment_risk_policy" USING btree ("branch_code") WHERE branch_code is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_risk_policy_default_uniq" ON "payment_risk_policy" USING btree ((true)) WHERE branch_code is null;
--> statement-breakpoint
ALTER TABLE "business_partner" ADD COLUMN "payment_priority" smallint DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "partner_bank_account" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_terms" ADD COLUMN "discount_percent" numeric(9, 4);--> statement-breakpoint
ALTER TABLE "payment_terms" ADD COLUMN "discount_days" smallint;
--> statement-breakpoint
ALTER TABLE "business_partner" ADD CONSTRAINT "business_partner_payment_priority_range" CHECK ("business_partner"."payment_priority" between 1 and 9);--> statement-breakpoint
ALTER TABLE "payment_terms" ADD CONSTRAINT "payment_terms_discount_complete" CHECK (("payment_terms"."discount_percent" is null and "payment_terms"."discount_days" is null)
          or ("payment_terms"."discount_percent" > 0 and "payment_terms"."discount_percent" <= 100 and "payment_terms"."discount_days" >= 0));--> statement-breakpoint

-- ===========================================================================
-- Phase 07.2 and 07.3 — payment proposal, payment batch and maker-checker
-- (blueprint 15 and 17)
--
-- Three documents and four hands: the proposal says what could be paid, the
-- batch says what will be, the execution says what was, and section 17 puts a
-- different person behind each of the last three transitions.
--
-- Nothing here posts a journal. Each executed batch line becomes a Phase 05
-- supplier_payment, which posts through the Phase 02 engine and allocates to the
-- invoice exactly as a hand-raised payment does. A batch that posted its own
-- entry would be a second way for money to leave the company, and the first
-- thing that would go wrong is that the two disagreed.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Section 15 - "supplier bank detail changes require independent verification
-- and approval before payment."
--
-- The revision is bumped by the database and never by the application, and a
-- change to a payable field puts the details back to draft. That is the whole
-- control: after this trigger exists there is no sequence of statements that
-- leaves a changed account number in an approved state, so "verification is
-- required" stops being a procedure somebody has to remember.
--
-- The batch line records which revision the approver saw. Comparing it at
-- execution catches the remaining case - a change that was itself re-approved
-- between approval and payment, where every row looks valid and the money is
-- still going somewhere nobody signed for.
-- ---------------------------------------------------------------------------
CREATE FUNCTION partner_bank_account_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.bank_name, NEW.account_number, NEW.iban, NEW.swift, NEW.currency, NEW.account_holder)
     IS DISTINCT FROM
     ROW(OLD.bank_name, OLD.account_number, OLD.iban, OLD.swift, OLD.currency, OLD.account_holder)
  THEN
    NEW.revision        := OLD.revision + 1;
    NEW.approval_status := 'draft';
    NEW.is_active       := false;
    NEW.approved_by     := NULL;
    NEW.approved_at     := NULL;
  ELSE
    -- The revision is the database's to set. An application that could write it
    -- could also freeze it, which is the one thing that would make the check at
    -- execution lie.
    NEW.revision := OLD.revision;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER partner_bank_account_revision
  BEFORE UPDATE ON partner_bank_account
  FOR EACH ROW EXECUTE FUNCTION partner_bank_account_revision();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 17 - a batch line is paid from the account the batch names, and it
-- belongs to the proposal the batch came from.
--
-- Both are things the application already does. They are written here because a
-- payment run assembled from another proposal's items is the shape a fraudulent
-- one takes, and application code is where that would be introduced.
-- ---------------------------------------------------------------------------
CREATE FUNCTION payment_batch_line_belongs_to_its_proposal() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_proposal uuid;
  v_batch_no text;
  v_ok       boolean;
BEGIN
  SELECT b.proposal_id, b.batch_no INTO v_proposal, v_batch_no
    FROM payment_batch b WHERE b.id = NEW.batch_id;

  SELECT EXISTS (
    SELECT 1 FROM payment_proposal_item i
     WHERE i.proposal_id = v_proposal
       AND i.inclusion = 'selected'
       AND (i.ap_invoice_id IS NOT DISTINCT FROM NEW.ap_invoice_id)
       AND (i.supplier_advance_id IS NOT DISTINCT FROM NEW.supplier_advance_id)
  ) INTO v_ok;

  IF NOT v_ok THEN
    RAISE EXCEPTION
      'Batch % line % is not a selected item of the proposal it came from. A batch is the executable form of a proposal somebody approved (blueprint 15, 17).',
      v_batch_no, NEW.line_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER payment_batch_line_belongs_to_its_proposal
  BEFORE INSERT ON payment_batch_line
  FOR EACH ROW EXECUTE FUNCTION payment_batch_line_belongs_to_its_proposal();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 15 - the selected total is bounded by the cash there was.
--
-- The header carries a CHECK that selected_total_iqd <= available_funds_iqd.
-- This is the other half of it: the header's total must actually be the sum of
-- its selected items, judged at COMMIT so the rows can arrive one at a time.
-- Without both, a run could report a total that its own lines do not support.
-- ---------------------------------------------------------------------------
CREATE FUNCTION payment_proposal_totals_match() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_selected numeric(19,4);
  v_deferred numeric(19,4);
  v_head     record;
BEGIN
  SELECT * INTO v_head FROM payment_proposal WHERE id = COALESCE(NEW.proposal_id, OLD.proposal_id);
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT coalesce(sum(outstanding_iqd) FILTER (WHERE inclusion = 'selected'), 0::numeric(19,4)),
         coalesce(sum(outstanding_iqd) FILTER (WHERE inclusion = 'deferred_funds'), 0::numeric(19,4))
    INTO v_selected, v_deferred
    FROM payment_proposal_item WHERE proposal_id = v_head.id;

  IF v_head.selected_total_iqd <> v_selected THEN
    RAISE EXCEPTION
      'Proposal % says it selected % but its items total % (blueprint 15).',
      v_head.proposal_no, v_head.selected_total_iqd, v_selected
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_head.deferred_total_iqd <> v_deferred THEN
    RAISE EXCEPTION
      'Proposal % says it deferred % but its deferred items total % (blueprint 15).',
      v_head.proposal_no, v_head.deferred_total_iqd, v_deferred
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER payment_proposal_totals_match
  AFTER INSERT OR UPDATE OR DELETE ON payment_proposal_item
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION payment_proposal_totals_match();--> statement-breakpoint

-- Numbering, document types, statuses and permissions.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('PAYMENT_PROPOSAL', 'PPR', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true),
       ('PAYMENT_BATCH',    'PBT', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('payment_proposal', 'Payment Proposal', 'treasury',
   'Due items selected for payment by due date, priority, discount and available cash (blueprint 15). It records every candidate it considered, including the ones it refused and why - a proposal that listed only what it paid could not answer the question Finance actually asks.'),
  ('payment_batch', 'Payment Batch', 'treasury',
   'The instruction sent to the bank, and the record of what came back (blueprint 17). Creator, approver and executor are different people for a high-risk payment.');--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('payment_proposal', 'draft',    'approved'),
  ('payment_proposal', 'draft',    'cancelled'),
  ('payment_proposal', 'approved', 'draft'),
  ('payment_proposal', 'approved', 'cancelled'),
  ('payment_batch',    'draft',    'approved'),
  ('payment_batch',    'draft',    'cancelled'),
  ('payment_batch',    'approved', 'draft'),
  ('payment_batch',    'approved', 'cancelled'),
  ('payment_batch',    'approved', 'executed');--> statement-breakpoint

INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('payment_batch', 'total_iqd',
   'What the approver signed for. A batch whose total could move after approval is a batch whose approval means nothing.'),
  ('payment_batch', 'bank_cash_account_id',
   'Which account the money leaves. Approval is of an amount from an account, not of an amount.'),
  ('payment_batch', 'payment_date',
   'When it goes. Moving it after approval moves the ledger date the approver saw.'),
  ('payment_proposal', 'bank_cash_account_id',
   'The account whose available cash bounded the run. Changing it would invalidate the selection.'),
  ('payment_proposal', 'pay_date',
   'The date eligibility and discount deadlines were judged against.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Section 17 requires three different *users*, not three different roles, so
-- both roles can execute: an officer raises, a manager approves, and a second
-- officer sends. Granting execution to managers only would have made the
-- control unsatisfiable in a branch with one manager - and a control that
-- cannot be satisfied is a control that gets switched off.
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'payment_batch', 'view'),
  ('accounting_officer', 'payment_batch', 'create'),
  ('accounting_officer', 'payment_batch', 'execute'),
  ('accounting_officer', 'payment_batch', 'print'),
  ('accounting_manager', 'payment_batch', 'view'),
  ('accounting_manager', 'payment_batch', 'create'),
  ('accounting_manager', 'payment_batch', 'approve'),
  ('accounting_manager', 'payment_batch', 'execute'),
  ('accounting_manager', 'payment_batch', 'configure'),
  ('accounting_manager', 'payment_batch', 'reverse_cancel'),
  ('accounting_manager', 'payment_batch', 'print'),
  ('accounting_manager', 'payment_batch', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Section 17 never defines "high-risk", so the register carries it as D13 and
-- the default is the cautious one: a threshold of zero puts every payment above
-- the line. Finance raises it when they have decided what routine looks like.
INSERT INTO payment_risk_policy (branch_code, high_risk_threshold_iqd, note)
VALUES (NULL, 0,
  'Company-wide default. Zero means every payment is high-risk and needs a separate creator, approver and executor (blueprint 17). Awaiting the Business Process Owner - decision register D13.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist - grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON payment_proposal, payment_proposal_item, payment_batch,
                payment_batch_line, payment_risk_policy FROM erp_app;

  GRANT SELECT, INSERT, UPDATE ON payment_proposal      TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON payment_proposal_item TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON payment_batch         TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON payment_batch_line    TO erp_app;
  GRANT SELECT                  ON payment_risk_policy  TO erp_app;
END;
$$;--> statement-breakpoint

-- D10 - the branch boundary. The item and line tables reach through their
-- header, which is where the branch lives.
ALTER TABLE payment_proposal ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE payment_proposal FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY payment_proposal_branch_scope ON payment_proposal
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

ALTER TABLE payment_batch ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE payment_batch FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY payment_batch_branch_scope ON payment_batch
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

ALTER TABLE payment_proposal_item ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE payment_proposal_item FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY payment_proposal_item_branch_scope ON payment_proposal_item
  USING (EXISTS (SELECT 1 FROM payment_proposal h
                  WHERE h.id = payment_proposal_item.proposal_id
                    AND app_branch_allowed(h.branch_code)))
  WITH CHECK (EXISTS (SELECT 1 FROM payment_proposal h
                       WHERE h.id = payment_proposal_item.proposal_id
                         AND app_branch_allowed(h.branch_code)));--> statement-breakpoint

ALTER TABLE payment_batch_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE payment_batch_line FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY payment_batch_line_branch_scope ON payment_batch_line
  USING (EXISTS (SELECT 1 FROM payment_batch h
                  WHERE h.id = payment_batch_line.batch_id
                    AND app_branch_allowed(h.branch_code)))
  WITH CHECK (EXISTS (SELECT 1 FROM payment_batch h
                       WHERE h.id = payment_batch_line.batch_id
                         AND app_branch_allowed(h.branch_code)));
