CREATE TYPE "public"."reconciliation_match_state" AS ENUM('suggested', 'confirmed');--> statement-breakpoint
CREATE TABLE "bank_reconciliation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reconciliation_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"bank_cash_account_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"statement_id" uuid NOT NULL,
	"as_of_date" date NOT NULL,
	"statement_closing_iqd" numeric(19, 4) NOT NULL,
	"ledger_balance_iqd" numeric(19, 4) NOT NULL,
	"deposits_in_transit_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"unpresented_payments_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"difference_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"prepared_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"reopened_by" uuid,
	"reopened_at" timestamp with time zone,
	"reopen_reason" text,
	"reopen_count" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_reconciliation_approved_means_balanced" CHECK ("bank_reconciliation"."approved_at" is null or "bank_reconciliation"."difference_iqd" = 0),
	CONSTRAINT "bank_reconciliation_approval_complete" CHECK (("bank_reconciliation"."approved_by" is null) = ("bank_reconciliation"."approved_at" is null)),
	CONSTRAINT "bank_reconciliation_reopen_has_reason" CHECK (("bank_reconciliation"."reopened_by" is null and "bank_reconciliation"."reopened_at" is null)
          or ("bank_reconciliation"."reopened_by" is not null and "bank_reconciliation"."reopened_at" is not null
              and coalesce(btrim("bank_reconciliation"."reopen_reason"), '') <> '')),
	CONSTRAINT "bank_reconciliation_reopen_count_not_negative" CHECK ("bank_reconciliation"."reopen_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "bank_reconciliation_match" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reconciliation_id" uuid NOT NULL,
	"match_no" integer NOT NULL,
	"state" "reconciliation_match_state" DEFAULT 'suggested' NOT NULL,
	"confidence" smallint,
	"why" text,
	"from_adjustment" text,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_reconciliation_match_confidence_range" CHECK ("bank_reconciliation_match"."confidence" is null or ("bank_reconciliation_match"."confidence" between 0 and 100)),
	CONSTRAINT "bank_reconciliation_match_confirmation_complete" CHECK (("bank_reconciliation_match"."state" = 'confirmed') = ("bank_reconciliation_match"."confirmed_by" is not null and "bank_reconciliation_match"."confirmed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "bank_reconciliation_match_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"statement_line_id" uuid,
	"journal_line_id" uuid,
	"amount_iqd" numeric(19, 4) NOT NULL,
	CONSTRAINT "bank_reconciliation_match_line_one_side" CHECK (("bank_reconciliation_match_line"."statement_line_id" is not null and "bank_reconciliation_match_line"."journal_line_id" is null)
          or ("bank_reconciliation_match_line"."statement_line_id" is null and "bank_reconciliation_match_line"."journal_line_id" is not null)),
	CONSTRAINT "bank_reconciliation_match_line_amount_not_zero" CHECK ("bank_reconciliation_match_line"."amount_iqd" <> 0)
);
--> statement-breakpoint
ALTER TABLE "bank_reconciliation" ADD CONSTRAINT "bank_reconciliation_bank_cash_account_id_bank_cash_account_id_fk" FOREIGN KEY ("bank_cash_account_id") REFERENCES "public"."bank_cash_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliation" ADD CONSTRAINT "bank_reconciliation_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliation" ADD CONSTRAINT "bank_reconciliation_statement_id_bank_statement_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."bank_statement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliation" ADD CONSTRAINT "bank_reconciliation_prepared_by_app_user_id_fk" FOREIGN KEY ("prepared_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliation" ADD CONSTRAINT "bank_reconciliation_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliation" ADD CONSTRAINT "bank_reconciliation_reopened_by_app_user_id_fk" FOREIGN KEY ("reopened_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliation_match" ADD CONSTRAINT "bank_reconciliation_match_reconciliation_id_bank_reconciliation_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."bank_reconciliation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliation_match" ADD CONSTRAINT "bank_reconciliation_match_confirmed_by_app_user_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliation_match_line" ADD CONSTRAINT "bank_reconciliation_match_line_match_id_bank_reconciliation_match_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."bank_reconciliation_match"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliation_match_line" ADD CONSTRAINT "bank_reconciliation_match_line_statement_line_id_bank_statement_line_id_fk" FOREIGN KEY ("statement_line_id") REFERENCES "public"."bank_statement_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliation_match_line" ADD CONSTRAINT "bank_reconciliation_match_line_journal_line_id_journal_line_id_fk" FOREIGN KEY ("journal_line_id") REFERENCES "public"."journal_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_reconciliation_no_uniq" ON "bank_reconciliation" USING btree ("reconciliation_no");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_reconciliation_statement_uniq" ON "bank_reconciliation" USING btree ("statement_id");--> statement-breakpoint
CREATE INDEX "bank_reconciliation_account_idx" ON "bank_reconciliation" USING btree ("bank_cash_account_id","as_of_date");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_reconciliation_match_no_uniq" ON "bank_reconciliation_match" USING btree ("reconciliation_id","match_no");--> statement-breakpoint
CREATE INDEX "bank_reconciliation_match_state_idx" ON "bank_reconciliation_match" USING btree ("reconciliation_id","state");--> statement-breakpoint
CREATE INDEX "bank_reconciliation_match_line_match_idx" ON "bank_reconciliation_match_line" USING btree ("match_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_reconciliation_match_line_statement_uniq" ON "bank_reconciliation_match_line" USING btree ("statement_line_id") WHERE statement_line_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_reconciliation_match_line_journal_uniq" ON "bank_reconciliation_match_line" USING btree ("journal_line_id") WHERE journal_line_id is not null;
--> statement-breakpoint

-- ===========================================================================
-- Phase 07.7 — the bank reconciliation workspace (blueprint 17)
--
-- Two records of the same money, kept by two organisations, and the job is to
-- explain every difference between them - not to remove them. Timing
-- differences are real and correct, and a reconciliation that made them
-- disappear would be hiding the one thing it exists to show.
--
-- A match is a SET against a SET rather than a pair. Section 12.5's Bank
-- Execution Batch puts one bank debit against several internally separate
-- transfers, each keeping its own document, client, branch and margin, and
-- requires the batch total to reconcile to the single statement amount. A
-- one-to-one match cannot say that, and Phase 09 would have to rebuild this.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Section 17 - "statement lines are immutable after reconciliation."
--
-- Once a line is matched, what the bank said about it is settled. Changing the
-- date, the amount or the reference afterwards would change what somebody
-- agreed, silently, after they agreed it. The correction route is the reopen
-- workflow, which puts the line back to unmatched with a reason on the record.
--
-- The match status itself is exempt: that is how the reopen releases the line.
-- ---------------------------------------------------------------------------
CREATE FUNCTION bank_statement_line_immutable_when_matched() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.match_status <> 'matched' THEN
    RETURN NEW;
  END IF;

  IF NEW.booking_date  IS DISTINCT FROM OLD.booking_date
  OR NEW.value_date    IS DISTINCT FROM OLD.value_date
  OR NEW.amount_iqd    IS DISTINCT FROM OLD.amount_iqd
  OR NEW.reference     IS DISTINCT FROM OLD.reference
  OR NEW.counterparty  IS DISTINCT FROM OLD.counterparty
  OR NEW.import_key    IS DISTINCT FROM OLD.import_key
  OR NEW.statement_id  IS DISTINCT FROM OLD.statement_id THEN
    RAISE EXCEPTION
      'This statement line has been reconciled and cannot be changed (blueprint 17). Reopen the reconciliation with a reason, or post an adjustment - either way the correction is on the record.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER bank_statement_line_immutable_when_matched
  BEFORE UPDATE ON bank_statement_line
  FOR EACH ROW EXECUTE FUNCTION bank_statement_line_immutable_when_matched();--> statement-breakpoint

CREATE FUNCTION bank_statement_line_no_delete_when_matched() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.match_status = 'matched' THEN
    RAISE EXCEPTION
      'This statement line has been reconciled and cannot be deleted (blueprint 17).'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint

CREATE TRIGGER bank_statement_line_no_delete_when_matched
  BEFORE DELETE ON bank_statement_line
  FOR EACH ROW EXECUTE FUNCTION bank_statement_line_no_delete_when_matched();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 17 - a match says "these are the same money", so both sides total the
-- same.
--
-- Judged at COMMIT, because the lines arrive one at a time and only the
-- finished set can be judged. The service checks it too; this is the half that
-- a future code path cannot forget.
-- ---------------------------------------------------------------------------
CREATE FUNCTION bank_reconciliation_match_balances() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_statement numeric(19,4);
  v_ledger    numeric(19,4);
  v_match     uuid;
BEGIN
  v_match := COALESCE(NEW.match_id, OLD.match_id);

  SELECT coalesce(sum(amount_iqd) FILTER (WHERE statement_line_id IS NOT NULL), 0::numeric(19,4)),
         coalesce(sum(amount_iqd) FILTER (WHERE journal_line_id   IS NOT NULL), 0::numeric(19,4))
    INTO v_statement, v_ledger
    FROM bank_reconciliation_match_line WHERE match_id = v_match;

  -- A match with nothing left in it is being dismantled, not unbalanced.
  IF v_statement = 0 AND v_ledger = 0
     AND NOT EXISTS (SELECT 1 FROM bank_reconciliation_match_line WHERE match_id = v_match) THEN
    RETURN NULL;
  END IF;

  IF v_statement <> v_ledger THEN
    RAISE EXCEPTION
      'The statement side of this match totals % and the ledger side totals %. Money that is not equal is not the same money (blueprint 17); if the difference is a fee or a charge, post it as an adjustment and match that too.',
      v_statement, v_ledger
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER bank_reconciliation_match_balances
  AFTER INSERT OR UPDATE OR DELETE ON bank_reconciliation_match_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION bank_reconciliation_match_balances();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 17 - a reconciliation belongs to its own statement's account.
--
-- Reconciling one account's ledger against another's statement would agree two
-- balances that were never related, and produce a tick against nothing.
-- ---------------------------------------------------------------------------
CREATE FUNCTION bank_reconciliation_matches_its_statement() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_account uuid;
  v_branch  text;
  v_to      date;
  v_no      text;
BEGIN
  SELECT bank_cash_account_id, branch_code, period_to, statement_no
    INTO v_account, v_branch, v_to, v_no
    FROM bank_statement WHERE id = NEW.statement_id;

  IF NEW.bank_cash_account_id IS DISTINCT FROM v_account THEN
    RAISE EXCEPTION
      'Reconciliation is for a different account from statement %.', v_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.branch_code IS DISTINCT FROM v_branch THEN
    RAISE EXCEPTION
      'Reconciliation is in branch % but statement % belongs to %.',
      NEW.branch_code, v_no, v_branch
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.as_of_date IS DISTINCT FROM v_to THEN
    RAISE EXCEPTION
      'Reconciliation is as at % but statement % ends on %. The agreement is of a balance on a date (blueprint 17).',
      NEW.as_of_date, v_no, v_to
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER bank_reconciliation_matches_its_statement
  BEFORE INSERT OR UPDATE ON bank_reconciliation
  FOR EACH ROW EXECUTE FUNCTION bank_reconciliation_matches_its_statement();--> statement-breakpoint

-- Numbering, document type, statuses and permissions.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('BANK_RECONCILIATION', 'BRC', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('bank_reconciliation', 'Bank Reconciliation', 'treasury',
   'The agreement between a bank statement and the ledger for the same date (blueprint 17). Matching proposes; a person confirms. It cannot be finalised while a difference is unexplained - an adjustment removes the difference by recording what it was, and there is no override.');--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('bank_reconciliation', 'draft',    'approved'),
  ('bank_reconciliation', 'draft',    'cancelled'),
  ('bank_reconciliation', 'approved', 'draft');--> statement-breakpoint

INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('bank_reconciliation', 'statement_id',
   'Which statement is being agreed. Changing it would move the agreement to a different period.'),
  ('bank_reconciliation', 'as_of_date',
   'The date the two balances are agreed at. A reconciliation is of a balance on a date.'),
  ('bank_reconciliation', 'statement_closing_iqd',
   'The bank''s own figure, copied from the statement. It is the claim being agreed, so it cannot move to fit.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Preparing, matching and finalising are three different acts. The officer
-- prepares and matches; the manager posts adjustments and signs. Section 17
-- does not require three people here as it does for a payment - the control is
-- that the arithmetic must balance, which no signature can waive.
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'bank_reconciliation', 'view'),
  ('accounting_officer', 'bank_reconciliation', 'create'),
  ('accounting_officer', 'bank_reconciliation', 'edit_draft'),
  ('accounting_officer', 'bank_reconciliation', 'execute'),
  ('accounting_officer', 'bank_reconciliation', 'print'),
  ('accounting_manager', 'bank_reconciliation', 'view'),
  ('accounting_manager', 'bank_reconciliation', 'create'),
  ('accounting_manager', 'bank_reconciliation', 'edit_draft'),
  ('accounting_manager', 'bank_reconciliation', 'execute'),
  ('accounting_manager', 'bank_reconciliation', 'approve'),
  ('accounting_manager', 'bank_reconciliation', 'reverse_cancel'),
  ('accounting_manager', 'bank_reconciliation', 'print'),
  ('accounting_manager', 'bank_reconciliation', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist - grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON bank_reconciliation, bank_reconciliation_match,
                bank_reconciliation_match_line FROM erp_app;

  GRANT SELECT, INSERT, UPDATE         ON bank_reconciliation            TO erp_app;
  GRANT SELECT, INSERT, UPDATE         ON bank_reconciliation_match      TO erp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON bank_reconciliation_match_line TO erp_app;
END;
$$;--> statement-breakpoint

-- D10 - the branch boundary. Matches and their lines reach through the header.
ALTER TABLE bank_reconciliation ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE bank_reconciliation FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY bank_reconciliation_branch_scope ON bank_reconciliation
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

ALTER TABLE bank_reconciliation_match ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE bank_reconciliation_match FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY bank_reconciliation_match_branch_scope ON bank_reconciliation_match
  USING (EXISTS (SELECT 1 FROM bank_reconciliation h
                  WHERE h.id = bank_reconciliation_match.reconciliation_id
                    AND app_branch_allowed(h.branch_code)))
  WITH CHECK (EXISTS (SELECT 1 FROM bank_reconciliation h
                       WHERE h.id = bank_reconciliation_match.reconciliation_id
                         AND app_branch_allowed(h.branch_code)));--> statement-breakpoint

ALTER TABLE bank_reconciliation_match_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE bank_reconciliation_match_line FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY bank_reconciliation_match_line_branch_scope ON bank_reconciliation_match_line
  USING (EXISTS (SELECT 1 FROM bank_reconciliation_match m
                   JOIN bank_reconciliation h ON h.id = m.reconciliation_id
                  WHERE m.id = bank_reconciliation_match_line.match_id
                    AND app_branch_allowed(h.branch_code)))
  WITH CHECK (EXISTS (SELECT 1 FROM bank_reconciliation_match m
                        JOIN bank_reconciliation h ON h.id = m.reconciliation_id
                       WHERE m.id = bank_reconciliation_match_line.match_id
                         AND app_branch_allowed(h.branch_code)));
