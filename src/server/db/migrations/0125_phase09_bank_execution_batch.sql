CREATE TABLE "bank_execution_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"branch_code" text NOT NULL,
	"bank_cash_account_id" uuid NOT NULL,
	"execution_date" date NOT NULL,
	"total_iqd" numeric(19, 4) NOT NULL,
	"bank_reference" text,
	"statement_line_ref" text,
	"reconciled_by" uuid,
	"reconciled_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"executed_by" uuid,
	"executed_at" timestamp with time zone,
	"reversed_by" uuid,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_execution_batch_total_positive" CHECK ("bank_execution_batch"."total_iqd" > 0),
	CONSTRAINT "bank_execution_batch_reconciliation_complete" CHECK (("bank_execution_batch"."reconciled_at" is null and "bank_execution_batch"."reconciled_by" is null)
          or ("bank_execution_batch"."reconciled_at" is not null and "bank_execution_batch"."reconciled_by" is not null
              and coalesce(btrim("bank_execution_batch"."statement_line_ref"), '') <> '')),
	CONSTRAINT "bank_execution_batch_reversal_has_reason" CHECK (("bank_execution_batch"."reversed_by" is null and "bank_execution_batch"."reversed_at" is null)
          or ("bank_execution_batch"."reversed_by" is not null and "bank_execution_batch"."reversed_at" is not null
              and coalesce(btrim("bank_execution_batch"."reversal_reason"), '') <> ''))
);
--> statement-breakpoint
CREATE TABLE "bank_execution_batch_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"source_document_type" text NOT NULL,
	"money_transfer_id" uuid,
	"client_import_payment_id" uuid,
	"counterparty_partner_id" uuid,
	"branch_code" text NOT NULL,
	"cost_centre_code" text,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"journal_entry_id" uuid,
	"margin_iqd" numeric(19, 4),
	"reversed_by" uuid,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	"reversal_journal_entry_id" uuid,
	"note" text,
	CONSTRAINT "bank_execution_batch_line_one_source" CHECK (num_nonnulls("bank_execution_batch_line"."money_transfer_id", "bank_execution_batch_line"."client_import_payment_id") = 1),
	CONSTRAINT "bank_execution_batch_line_amount_positive" CHECK ("bank_execution_batch_line"."amount_iqd" > 0),
	CONSTRAINT "bank_execution_batch_line_reversal_has_reason" CHECK (("bank_execution_batch_line"."reversed_by" is null and "bank_execution_batch_line"."reversed_at" is null)
          or ("bank_execution_batch_line"."reversed_by" is not null and "bank_execution_batch_line"."reversed_at" is not null
              and coalesce(btrim("bank_execution_batch_line"."reversal_reason"), '') <> ''))
);
--> statement-breakpoint

ALTER TABLE "bank_execution_batch" ADD CONSTRAINT "bank_execution_batch_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_execution_batch" ADD CONSTRAINT "bank_execution_batch_bank_cash_account_id_bank_cash_account_id_fk" FOREIGN KEY ("bank_cash_account_id") REFERENCES "public"."bank_cash_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_execution_batch" ADD CONSTRAINT "bank_execution_batch_reconciled_by_app_user_id_fk" FOREIGN KEY ("reconciled_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_execution_batch" ADD CONSTRAINT "bank_execution_batch_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_execution_batch" ADD CONSTRAINT "bank_execution_batch_executed_by_app_user_id_fk" FOREIGN KEY ("executed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_execution_batch" ADD CONSTRAINT "bank_execution_batch_reversed_by_app_user_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_execution_batch" ADD CONSTRAINT "bank_execution_batch_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_execution_batch_line" ADD CONSTRAINT "bank_execution_batch_line_batch_id_bank_execution_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."bank_execution_batch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_execution_batch_line" ADD CONSTRAINT "bank_execution_batch_line_money_transfer_id_money_transfer_id_fk" FOREIGN KEY ("money_transfer_id") REFERENCES "public"."money_transfer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_execution_batch_line" ADD CONSTRAINT "bank_execution_batch_line_client_import_payment_id_client_import_payment_id_fk" FOREIGN KEY ("client_import_payment_id") REFERENCES "public"."client_import_payment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_execution_batch_line" ADD CONSTRAINT "bank_execution_batch_line_counterparty_partner_id_business_partner_id_fk" FOREIGN KEY ("counterparty_partner_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_execution_batch_line" ADD CONSTRAINT "bank_execution_batch_line_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_execution_batch_line" ADD CONSTRAINT "bank_execution_batch_line_cost_centre_code_cost_centre_code_fk" FOREIGN KEY ("cost_centre_code") REFERENCES "public"."cost_centre"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_execution_batch_line" ADD CONSTRAINT "bank_execution_batch_line_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_execution_batch_line" ADD CONSTRAINT "bank_execution_batch_line_reversed_by_app_user_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_execution_batch_line" ADD CONSTRAINT "bank_execution_batch_line_reversal_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("reversal_journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "bank_execution_batch_no_uniq" ON "bank_execution_batch" USING btree ("batch_no");--> statement-breakpoint
CREATE INDEX "bank_execution_batch_account_idx" ON "bank_execution_batch" USING btree ("bank_cash_account_id","execution_date");--> statement-breakpoint
CREATE INDEX "bank_execution_batch_status_idx" ON "bank_execution_batch" USING btree ("status","execution_date");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_execution_batch_statement_uniq" ON "bank_execution_batch" USING btree ("bank_cash_account_id","statement_line_ref") WHERE statement_line_ref is not null and reversed_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_execution_batch_line_no_uniq" ON "bank_execution_batch_line" USING btree ("batch_id","line_no");--> statement-breakpoint
CREATE INDEX "bank_execution_batch_line_transfer_idx" ON "bank_execution_batch_line" USING btree ("money_transfer_id");--> statement-breakpoint
CREATE INDEX "bank_execution_batch_line_payment_idx" ON "bank_execution_batch_line" USING btree ("client_import_payment_id");--> statement-breakpoint
CREATE INDEX "bank_execution_batch_line_partner_idx" ON "bank_execution_batch_line" USING btree ("counterparty_partner_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The same document cannot be in two live batches.
--
-- §12.5 gives one bank debit several source lines; it does not give one source
-- line several bank debits. Paying a transfer twice through two batches is
-- exactly the kind of duplicate the single-debit model is meant to make
-- visible, so it is refused rather than reported.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX bank_execution_batch_line_transfer_once
  ON bank_execution_batch_line (money_transfer_id)
  WHERE money_transfer_id IS NOT NULL AND reversed_at IS NULL;--> statement-breakpoint

CREATE UNIQUE INDEX bank_execution_batch_line_payment_once
  ON bank_execution_batch_line (client_import_payment_id)
  WHERE client_import_payment_id IS NOT NULL AND reversed_at IS NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A line describes the document it points at, and says so consistently.
--
-- §12.5 requires each line to retain "their own document, client/vendor, branch,
-- cost centre, accounting and margin". The branch and the counterparty are
-- therefore taken from the source document rather than typed: a line whose
-- branch disagreed with its document would move one transaction's accounting
-- into another branch's books while claiming to have kept them separate.
-- ---------------------------------------------------------------------------
CREATE FUNCTION bank_execution_batch_line_matches_source() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_branch   text;
  v_partner  uuid;
  v_amount   numeric(19,4);
  v_doc      text;
  v_expected text;
BEGIN
  IF NEW.money_transfer_id IS NOT NULL THEN
    v_expected := 'money_transfer';
    SELECT t.branch_code, a.partner_id, t.transfer_amount_iqd, t.transfer_no
      INTO v_branch, v_partner, v_amount, v_doc
      FROM money_transfer t
      JOIN money_transfer_client_account a ON a.id = t.client_account_id
     WHERE t.id = NEW.money_transfer_id;
  ELSE
    v_expected := 'client_import_payment';
    SELECT p.branch_code, p.supplier_partner_id, p.amount_iqd, p.payment_no
      INTO v_branch, v_partner, v_amount, v_doc
      FROM client_import_payment p
     WHERE p.id = NEW.client_import_payment_id;
  END IF;

  IF NEW.source_document_type IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION
      'Batch line says it is a % but it points at a % (§12.5). The type and the reference describe one document.',
      NEW.source_document_type, v_expected USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.branch_code IS DISTINCT FROM v_branch THEN
    RAISE EXCEPTION
      'Batch line is on branch % but document % belongs to branch % (§12.5, §14.3). Each line keeps its own branch — its own, not one chosen for it.',
      NEW.branch_code, v_doc, v_branch USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_partner IS NOT NULL AND NEW.counterparty_partner_id IS DISTINCT FROM v_partner THEN
    RAISE EXCEPTION
      'Batch line names a different client/vendor from document % (§12.5). The counterparty comes from the document, not from the batch.',
      v_doc USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.amount_iqd <> v_amount THEN
    RAISE EXCEPTION
      'Batch line is for % but document % is for % (§12.5). A line is one document''s whole share of the bank debit; a different figure would make the batch total explain something other than what happened.',
      NEW.amount_iqd, v_doc, v_amount USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER bank_execution_batch_line_matches_source
  BEFORE INSERT OR UPDATE ON bank_execution_batch_line
  FOR EACH ROW EXECUTE FUNCTION bank_execution_batch_line_matches_source();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §12.7 acceptance 3 — "Bank Execution Batch lines sum exactly to the bank
-- execution total."
--
-- 09.6 gate: "A batch cannot be executed while its total does not equal the sum
-- of its lines."
--
-- The total is the bank's figure and the lines are the company's explanation of
-- it, so the two are independent and the check is a real one. Equality, with no
-- tolerance: §12.7's word is "exactly", and every part of this is scaled
-- integers in the database, so exactly is achievable.
-- ---------------------------------------------------------------------------
CREATE FUNCTION bank_execution_batch_lines_sum_to_total() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_sum   numeric(19,4);
  v_count integer;
BEGIN
  IF NEW.status <> 'executed' OR OLD.status = 'executed' THEN
    RETURN NEW;
  END IF;

  SELECT coalesce(sum(amount_iqd), 0), count(*) INTO v_sum, v_count
    FROM bank_execution_batch_line
   WHERE batch_id = NEW.id AND reversed_at IS NULL;

  IF v_count = 0 THEN
    RAISE EXCEPTION
      'Bank execution batch % has no lines; there is nothing for the bank debit of % to be for (§12.5).',
      NEW.batch_no, NEW.total_iqd USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_sum <> NEW.total_iqd THEN
    RAISE EXCEPTION
      'Bank execution batch % totals % but its lines sum to % (§12.5, §12.7). The total is the single amount the bank debited; until the lines account for all of it, % of company money is unexplained.',
      NEW.batch_no, NEW.total_iqd, v_sum, NEW.total_iqd - v_sum
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER bank_execution_batch_lines_sum_to_total
  BEFORE UPDATE ON bank_execution_batch
  FOR EACH ROW EXECUTE FUNCTION bank_execution_batch_lines_sum_to_total();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Once the bank has paid, the composition of the batch is history.
--
-- Adding, removing or re-pricing a line afterwards would restate what the single
-- bank debit was for, and the statement it reconciles to would stop agreeing
-- with it. Reversal is per line — 09.6's "reversing one line does not corrupt
-- the others" — so the reversal fields stay open.
-- ---------------------------------------------------------------------------
CREATE FUNCTION bank_execution_batch_line_executed_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status document_status;
  v_no     text;
  v_allowed text[] := ARRAY[
    'reversed_by', 'reversed_at', 'reversal_reason', 'reversal_journal_entry_id',
    'journal_entry_id', 'margin_iqd', 'note'
  ];
BEGIN
  SELECT status, batch_no INTO v_status, v_no
    FROM bank_execution_batch WHERE id = coalesce(NEW.batch_id, OLD.batch_id);

  IF v_status IN ('draft', 'approved') THEN
    RETURN coalesce(NEW, OLD);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Bank execution batch % has been executed; its lines are what the bank debit was for (§12.5). Reverse the line rather than removing it.',
      v_no USING ERRCODE = 'restrict_violation';
  END IF;

  -- journal_entry_id and margin_iqd are written as the batch executes, in the
  -- same statement pair that moves it to 'executed'. Everything else is fixed.
  IF (to_jsonb(NEW) - v_allowed) IS DISTINCT FROM (to_jsonb(OLD) - v_allowed) THEN
    RAISE EXCEPTION
      'Bank execution batch % has been executed; the composition of a single bank debit cannot be restated (§12.5, §12.7).',
      v_no USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER bank_execution_batch_line_executed_is_final
  BEFORE UPDATE OR DELETE ON bank_execution_batch_line
  FOR EACH ROW EXECUTE FUNCTION bank_execution_batch_line_executed_is_final();--> statement-breakpoint

-- A line cannot be added to a batch the bank has already paid.
CREATE FUNCTION bank_execution_batch_line_batch_is_open() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status document_status;
  v_no     text;
BEGIN
  SELECT status, batch_no INTO v_status, v_no
    FROM bank_execution_batch WHERE id = NEW.batch_id;

  IF v_status NOT IN ('draft', 'approved') THEN
    RAISE EXCEPTION
      'Bank execution batch % is ''%''; the bank has already debited it, so nothing more can be added to it (§12.5).',
      v_no, v_status USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER bank_execution_batch_line_batch_is_open
  BEFORE INSERT ON bank_execution_batch_line
  FOR EACH ROW EXECUTE FUNCTION bank_execution_batch_line_batch_is_open();--> statement-breakpoint

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('BANK_EXECUTION_BATCH', 'BEB', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('bank_execution_batch', 'Bank Execution Batch', 'money_transfer',
   'One bank debit combining several internally separate transactions (§12.5). Posts nothing itself: each line carries its own journal, counterparty, branch, cost centre and margin, which is what keeps them separate.');--> statement-breakpoint

-- Appendix B: Draft, Approved, Executed, Reconciled, Reversed.
INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('bank_execution_batch', 'draft',    'approved'),
  ('bank_execution_batch', 'approved', 'draft'),
  ('bank_execution_batch', 'approved', 'executed'),
  ('bank_execution_batch', 'executed', 'settled'),
  ('bank_execution_batch', 'draft',    'cancelled'),
  ('bank_execution_batch', 'approved', 'cancelled'),
  ('bank_execution_batch', 'executed', 'reversed'),
  ('bank_execution_batch', 'settled',  'reversed');--> statement-breakpoint

INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('bank_execution_batch', 'bank_cash_account_id',
   'One bank debit, one bank account (§12.5).'),
  ('bank_execution_batch', 'total_iqd',
   'The single amount the bank debited, from the bank advice. The lines are checked against it, not derived from it (§12.7).'),
  ('bank_execution_batch', 'execution_date',
   'Decides the period every line posts in.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'bank_execution_batch', 'view'),
  ('accounting_officer', 'bank_execution_batch', 'create'),
  ('accounting_officer', 'bank_execution_batch', 'edit_draft'),
  ('accounting_officer', 'bank_execution_batch', 'submit'),
  ('accounting_manager', 'bank_execution_batch', 'view'),
  ('accounting_manager', 'bank_execution_batch', 'create'),
  ('accounting_manager', 'bank_execution_batch', 'edit_draft'),
  ('accounting_manager', 'bank_execution_batch', 'submit'),
  ('accounting_manager', 'bank_execution_batch', 'approve'),
  ('accounting_manager', 'bank_execution_batch', 'execute'),
  ('accounting_manager', 'bank_execution_batch', 'post'),
  ('accounting_manager', 'bank_execution_batch', 'reverse_cancel'),
  ('accounting_manager', 'bank_execution_batch', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON bank_execution_batch, bank_execution_batch_line FROM erp_app;

  -- No DELETE on the batch. Draft lines are removable while the batch is a
  -- draft, which the trigger above allows and refuses once the bank has paid.
  GRANT SELECT, INSERT, UPDATE ON bank_execution_batch TO erp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON bank_execution_batch_line TO erp_app;
END;
$$;--> statement-breakpoint

ALTER TABLE bank_execution_batch      ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE bank_execution_batch      FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE bank_execution_batch_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE bank_execution_batch_line FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY bank_execution_batch_branch_scope ON bank_execution_batch
  USING (app_is_super_user() OR branch_code = app_current_branch())
  WITH CHECK (app_is_super_user() OR branch_code = app_current_branch());--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The line's own branch, not the batch's.
--
-- §12.5's own example combines a client transfer with a company import payment,
-- and there is no reason those share a branch. Scoping the line by the batch
-- would show a user rows belonging to a branch they cannot see; scoping it by
-- its own branch shows each user their own share of a shared bank debit, which
-- is what the separation in §12.5 means in practice.
-- ---------------------------------------------------------------------------
CREATE POLICY bank_execution_batch_line_branch_scope ON bank_execution_batch_line
  USING (app_is_super_user() OR branch_code = app_current_branch())
  WITH CHECK (app_is_super_user() OR branch_code = app_current_branch());
