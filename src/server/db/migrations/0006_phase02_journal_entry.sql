CREATE TYPE "public"."journal_source" AS ENUM('manual', 'system');--> statement-breakpoint
CREATE TYPE "public"."journal_type" AS ENUM('standard');--> statement-breakpoint
CREATE TABLE "journal_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_no" text NOT NULL,
	"document_date" date NOT NULL,
	"posting_date" date NOT NULL,
	"fiscal_period_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"description" text,
	"journal_type" "journal_type" DEFAULT 'standard' NOT NULL,
	"source" "journal_source" DEFAULT 'manual' NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"total_debit_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"total_credit_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"source_module" text,
	"source_doc_id" text,
	"source_event" text,
	"reverses_id" uuid,
	"reversed_by_id" uuid,
	"created_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "journal_entry_source_complete" CHECK (("journal_entry"."source_module" is null) = ("journal_entry"."source_doc_id" is null)
          and ("journal_entry"."source_module" is null) = ("journal_entry"."source_event" is null)),
	CONSTRAINT "journal_entry_source_matches_kind" CHECK (("journal_entry"."source" = 'manual') = ("journal_entry"."source_module" is null)),
	CONSTRAINT "journal_entry_dates_ordered" CHECK ("journal_entry"."posting_date" >= "journal_entry"."document_date"),
	CONSTRAINT "journal_entry_totals_non_negative" CHECK ("journal_entry"."total_debit_iqd" >= 0 and "journal_entry"."total_credit_iqd" >= 0),
	CONSTRAINT "journal_entry_posted_at_matches_status" CHECK (("journal_entry"."status" in ('posted','reversed')) = ("journal_entry"."posted_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "journal_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"account_id" uuid NOT NULL,
	"debit_txn" numeric(19, 4) DEFAULT '0' NOT NULL,
	"credit_txn" numeric(19, 4) DEFAULT '0' NOT NULL,
	"currency" char(3) NOT NULL,
	"debit_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"credit_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"debit_usd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"credit_usd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"txn_rate_id" uuid,
	"usd_rate_id" uuid,
	"branch_code" text,
	"department_code" text,
	"business_line_code" text,
	"project_code" text,
	"warehouse_code" text,
	"business_partner_code" text,
	"employee_code" text,
	"bank_account_code" text,
	"line_description" text,
	CONSTRAINT "journal_line_one_side_txn" CHECK (("journal_line"."debit_txn" > 0 and "journal_line"."credit_txn" = 0) or ("journal_line"."credit_txn" > 0 and "journal_line"."debit_txn" = 0)),
	CONSTRAINT "journal_line_one_side_iqd" CHECK (("journal_line"."debit_iqd" > 0 and "journal_line"."credit_iqd" = 0) or ("journal_line"."credit_iqd" > 0 and "journal_line"."debit_iqd" = 0)),
	CONSTRAINT "journal_line_sides_agree" CHECK (("journal_line"."debit_txn" > 0) = ("journal_line"."debit_iqd" > 0)),
	CONSTRAINT "journal_line_amounts_non_negative" CHECK ("journal_line"."debit_txn" >= 0 and "journal_line"."credit_txn" >= 0 and "journal_line"."debit_iqd" >= 0
          and "journal_line"."credit_iqd" >= 0 and "journal_line"."debit_usd" >= 0 and "journal_line"."credit_usd" >= 0),
	CONSTRAINT "journal_line_currency_shape" CHECK ("journal_line"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "journal_line_no_positive" CHECK ("journal_line"."line_no" >= 1)
);
--> statement-breakpoint
ALTER TABLE "department" ADD COLUMN "is_finance" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_fiscal_period_id_fiscal_period_id_fk" FOREIGN KEY ("fiscal_period_id") REFERENCES "public"."fiscal_period"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entry" ADD CONSTRAINT "journal_entry_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_account_id_chart_of_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."chart_of_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_txn_rate_id_exchange_rate_id_fk" FOREIGN KEY ("txn_rate_id") REFERENCES "public"."exchange_rate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_usd_rate_id_exchange_rate_id_fk" FOREIGN KEY ("usd_rate_id") REFERENCES "public"."exchange_rate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_line" ADD CONSTRAINT "journal_line_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entry_no_uniq" ON "journal_entry" USING btree ("entry_no");--> statement-breakpoint
CREATE INDEX "journal_entry_posting_date_idx" ON "journal_entry" USING btree ("posting_date","branch_code");--> statement-breakpoint
CREATE INDEX "journal_entry_status_idx" ON "journal_entry" USING btree ("status","posting_date");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entry_source_uniq" ON "journal_entry" USING btree ("source_module","source_doc_id","source_event") WHERE "journal_entry"."source_module" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "journal_line_no_uniq" ON "journal_line" USING btree ("journal_entry_id","line_no");--> statement-breakpoint
CREATE INDEX "journal_line_account_idx" ON "journal_line" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "journal_line_partner_idx" ON "journal_line" USING btree ("business_partner_code");--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE — Phase 02.5 and 02.6.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Money columns take the named domain rather than an inline numeric(19,4).
--
-- The domains were created in migration 0000 precisely so that no table could
-- quietly declare its own precision (A4). This is the first table that holds
-- real money, and it is the one that most needed them.
-- ---------------------------------------------------------------------------
ALTER TABLE journal_entry
  ALTER COLUMN total_debit_iqd  TYPE money_amount,
  ALTER COLUMN total_credit_iqd TYPE money_amount;--> statement-breakpoint

ALTER TABLE journal_line
  ALTER COLUMN debit_txn  TYPE money_amount,
  ALTER COLUMN credit_txn TYPE money_amount,
  ALTER COLUMN debit_iqd  TYPE money_amount,
  ALTER COLUMN credit_iqd TYPE money_amount,
  ALTER COLUMN debit_usd  TYPE money_amount,
  ALTER COLUMN credit_usd TYPE money_amount;--> statement-breakpoint

ALTER TABLE journal_line
  ALTER COLUMN currency TYPE currency_code;--> statement-breakpoint

-- The reversal links, added after the table exists because they point at it.
ALTER TABLE journal_entry
  ADD CONSTRAINT journal_entry_reverses_fk
  FOREIGN KEY (reverses_id) REFERENCES journal_entry(id);--> statement-breakpoint

ALTER TABLE journal_entry
  ADD CONSTRAINT journal_entry_reversed_by_fk
  FOREIGN KEY (reversed_by_id) REFERENCES journal_entry(id);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Running totals.
--
-- Maintained by trigger rather than by the application, so that a line inserted
-- by any path — service, import, a future posting engine — keeps the header
-- honest. The balance check below reads these.
-- ---------------------------------------------------------------------------
CREATE FUNCTION journal_entry_retotal() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_entry uuid := COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);
BEGIN
  UPDATE journal_entry e
     SET total_debit_iqd  = COALESCE(t.debit,  0),
         total_credit_iqd = COALESCE(t.credit, 0)
    FROM (SELECT SUM(debit_iqd) AS debit, SUM(credit_iqd) AS credit
            FROM journal_line WHERE journal_entry_id = v_entry) t
   WHERE e.id = v_entry;

  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER journal_line_retotal
  AFTER INSERT OR UPDATE OR DELETE ON journal_line
  FOR EACH ROW EXECUTE FUNCTION journal_entry_retotal();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §14.3 — a journal balances in IQD.
--
-- A DEFERRED constraint trigger, and it has to be. Lines arrive one at a time,
-- so after the first insert the entry is unbalanced by definition; only the
-- finished transaction can be judged. Deferring to COMMIT is what lets the rule
-- be a database guarantee rather than an application convention —
-- 02.5's gate says so explicitly: "enforced as a database constraint, not only
-- in application code."
--
-- A draft is exempt. An accountant part-way through typing a journal has an
-- unbalanced one on screen, and refusing to save it would be a worse system.
-- The rule bites at submission, which is when the entry claims to be finished.
-- ---------------------------------------------------------------------------
CREATE FUNCTION journal_entry_assert_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_entry   journal_entry%ROWTYPE;
  v_lines   int;
BEGIN
  SELECT * INTO v_entry FROM journal_entry WHERE id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL; -- deleted later in the same transaction
  END IF;

  IF v_entry.status = 'draft' THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO v_lines FROM journal_line WHERE journal_entry_id = v_entry.id;

  IF v_lines < 2 THEN
    RAISE EXCEPTION
      'Journal % has % line(s). A journal needs at least two: one debit and one credit.',
      v_entry.entry_no, v_lines
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_entry.total_debit_iqd <> v_entry.total_credit_iqd THEN
    RAISE EXCEPTION
      'Journal % does not balance in IQD: debits %, credits %, difference %. Every journal must balance in IQD (§14.3).',
      v_entry.entry_no, v_entry.total_debit_iqd, v_entry.total_credit_iqd,
      abs(v_entry.total_debit_iqd - v_entry.total_credit_iqd)
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_entry.total_debit_iqd = 0 THEN
    RAISE EXCEPTION
      'Journal % totals zero. An entry that moves nothing has no accounting effect.',
      v_entry.entry_no USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER journal_entry_balanced
  AFTER INSERT OR UPDATE ON journal_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_entry_assert_balanced();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §14.3 — "One Journal Entry can contain one branch only."
--
-- A line may leave its branch empty and inherit the header's; it may not
-- contradict it.
-- ---------------------------------------------------------------------------
CREATE FUNCTION journal_line_single_branch() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_header_branch text;
BEGIN
  SELECT branch_code INTO v_header_branch FROM journal_entry WHERE id = NEW.journal_entry_id;

  IF NEW.branch_code IS NULL THEN
    NEW.branch_code := v_header_branch;
  ELSIF NEW.branch_code <> v_header_branch THEN
    RAISE EXCEPTION
      'Line % is in branch % but the journal is in branch %. One Journal Entry can contain one branch only (§14.3).',
      NEW.line_no, NEW.branch_code, v_header_branch
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER journal_line_single_branch
  BEFORE INSERT OR UPDATE ON journal_line
  FOR EACH ROW EXECUTE FUNCTION journal_line_single_branch();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §14.4 — "A posted Journal Entry cannot be edited or deleted."
--
-- Everything about a posted entry is frozen except the reversal link, which is
-- how a posted entry is corrected (§14.3, 02.8) and which by definition is
-- written after posting.
-- ---------------------------------------------------------------------------
CREATE FUNCTION journal_entry_posted_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status NOT IN ('posted', 'reversed') THEN
    NEW.updated_at := now();
    NEW.version    := OLD.version + 1;
    RETURN NEW;
  END IF;

  IF NEW.status         IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'posted' AND NEW.status = 'reversed') THEN
    RAISE EXCEPTION
      'Journal % is posted and its status cannot be changed. A posted journal is corrected by full reversal (§14.3).',
      OLD.entry_no USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.entry_no      IS DISTINCT FROM OLD.entry_no
  OR NEW.posting_date  IS DISTINCT FROM OLD.posting_date
  OR NEW.document_date IS DISTINCT FROM OLD.document_date
  OR NEW.branch_code   IS DISTINCT FROM OLD.branch_code
  OR NEW.description   IS DISTINCT FROM OLD.description
  OR NEW.total_debit_iqd  IS DISTINCT FROM OLD.total_debit_iqd
  OR NEW.total_credit_iqd IS DISTINCT FROM OLD.total_credit_iqd THEN
    RAISE EXCEPTION
      'Journal % is posted and cannot be edited (§14.4). Correct it by full reversal.',
      OLD.entry_no USING ERRCODE = 'restrict_violation';
  END IF;

  NEW.updated_at := now();
  NEW.version    := OLD.version + 1;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER journal_entry_posted_immutable
  BEFORE UPDATE ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION journal_entry_posted_immutable();--> statement-breakpoint

CREATE FUNCTION journal_entry_reject_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('posted', 'reversed') THEN
    RAISE EXCEPTION
      'Journal % is posted and cannot be deleted (§14.4, §1.1). Correct it by full reversal.',
      OLD.entry_no USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint

CREATE TRIGGER journal_entry_reject_delete
  BEFORE DELETE ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION journal_entry_reject_delete();--> statement-breakpoint

-- A line of a posted journal is as frozen as its header. §4.2's derived
-- dimension rule lands here too: Customer/Supplier cannot be altered after
-- posting, and on a posted entry nothing can.
CREATE FUNCTION journal_line_posted_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status document_status;
  v_no     text;
BEGIN
  SELECT status, entry_no INTO v_status, v_no
    FROM journal_entry
   WHERE id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);

  IF v_status IN ('posted', 'reversed') THEN
    RAISE EXCEPTION
      'Journal % is posted; its lines cannot be % (§14.4). Correct it by full reversal.',
      v_no, lower(TG_OP) USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;--> statement-breakpoint

CREATE TRIGGER journal_line_posted_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON journal_line
  FOR EACH ROW EXECUTE FUNCTION journal_line_posted_immutable();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Appendix B — the Journal Entry document type and its states.
--
-- §14.4, all four bullets:
--   a Finance user creates and submits to the Finance Manager
--   a Finance Manager creates and posts directly
--   approval posts automatically and locks
--   a posted Journal Entry cannot be edited or deleted
-- ---------------------------------------------------------------------------
INSERT INTO document_type (code, name, module, description) VALUES
  ('journal_entry', 'Journal Entry', 'finance',
   'A manual Standard Journal. Belongs exclusively to the Finance Department (§14).');--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('journal_entry', 'draft',     'submitted'),
  ('journal_entry', 'draft',     'cancelled'),
  ('journal_entry', 'submitted', 'posted'),     -- approval posts in the same act
  ('journal_entry', 'submitted', 'rejected'),
  ('journal_entry', 'submitted', 'draft'),      -- recalled by the raiser
  ('journal_entry', 'rejected',  'draft'),
  ('journal_entry', 'posted',    'reversed');--> statement-breakpoint

-- One step: the Accounting Manager.
--
-- allow_self_approval is TRUE here, and FALSE on the Chart of Account route.
-- That is not an inconsistency — §14.4 says a Finance Manager "creates and
-- posts directly", so a manager's own journal needs no second signature. The
-- chart of accounts is configuration every posting maps against, and takes one.
INSERT INTO workflow_definition (id, document_type_code, version, is_active)
VALUES ('00000000-0000-4000-8000-000000000002', 'journal_entry', 1, true);--> statement-breakpoint

INSERT INTO workflow_step (definition_id, sequence, approver_role, allow_self_approval)
VALUES ('00000000-0000-4000-8000-000000000002', 1, 'accounting_manager', true);--> statement-breakpoint

-- §4.2 — "Branch: mandatory for all operational transactions."
INSERT INTO document_type_dimension (document_type_code, dimension, requirement) VALUES
  ('journal_entry', 'branch', 'mandatory');--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'journal_entry', 'view'),
  ('accounting_officer', 'journal_entry', 'create'),
  ('accounting_officer', 'journal_entry', 'edit_draft'),
  ('accounting_officer', 'journal_entry', 'submit'),
  ('accounting_officer', 'journal_entry', 'print'),
  ('accounting_manager', 'journal_entry', 'view'),
  ('accounting_manager', 'journal_entry', 'create'),
  ('accounting_manager', 'journal_entry', 'edit_draft'),
  ('accounting_manager', 'journal_entry', 'submit'),
  ('accounting_manager', 'journal_entry', 'approve'),
  ('accounting_manager', 'journal_entry', 'post'),
  ('accounting_manager', 'journal_entry', 'reverse_cancel'),
  ('accounting_manager', 'journal_entry', 'print'),
  ('accounting_manager', 'journal_entry', 'export');--> statement-breakpoint

-- The Journal Entry number sequence — one series, never reset, never reused.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year) VALUES
  ('JOURNAL_ENTRY', 'JE', '{PREFIX}-{YYYY}-{SERIAL}', 6, false, true);--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON journal_entry, journal_line FROM erp_app;

  -- No DELETE on a posted entry is enforced by trigger; the grant allows
  -- deleting a draft, which §3.2 permits only through cancellation — the
  -- service never deletes, and the trigger stops anything that tries on a
  -- posted one.
  GRANT SELECT, INSERT, UPDATE ON journal_entry TO erp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON journal_line TO erp_app;
END;
$$;