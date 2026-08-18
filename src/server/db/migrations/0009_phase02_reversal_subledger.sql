CREATE TABLE "subledger_entry" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "subledger_entry_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"subledger_type" "control_account_kind" NOT NULL,
	"party_code" text NOT NULL,
	"control_account_id" uuid NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"journal_line_id" uuid NOT NULL,
	"posting_date" date NOT NULL,
	"branch_code" text NOT NULL,
	"currency" char(3) NOT NULL,
	"debit_txn" numeric(19, 4) DEFAULT '0' NOT NULL,
	"credit_txn" numeric(19, 4) DEFAULT '0' NOT NULL,
	"debit_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"credit_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"debit_usd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"credit_usd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"source_module" text,
	"source_doc_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subledger_entry_one_side" CHECK (("subledger_entry"."debit_iqd" > 0 and "subledger_entry"."credit_iqd" = 0) or ("subledger_entry"."credit_iqd" > 0 and "subledger_entry"."debit_iqd" = 0)),
	CONSTRAINT "subledger_entry_party_present" CHECK (btrim("subledger_entry"."party_code") <> '')
);
--> statement-breakpoint
ALTER TABLE "subledger_entry" ADD CONSTRAINT "subledger_entry_control_account_id_chart_of_account_id_fk" FOREIGN KEY ("control_account_id") REFERENCES "public"."chart_of_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subledger_entry" ADD CONSTRAINT "subledger_entry_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subledger_entry" ADD CONSTRAINT "subledger_entry_journal_line_id_journal_line_id_fk" FOREIGN KEY ("journal_line_id") REFERENCES "public"."journal_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subledger_entry" ADD CONSTRAINT "subledger_entry_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subledger_entry_party_idx" ON "subledger_entry" USING btree ("subledger_type","party_code","posting_date");--> statement-breakpoint
CREATE INDEX "subledger_entry_control_idx" ON "subledger_entry" USING btree ("control_account_id","posting_date");--> statement-breakpoint
CREATE INDEX "subledger_entry_journal_idx" ON "subledger_entry" USING btree ("journal_entry_id");--> statement-breakpoint
CREATE INDEX "subledger_entry_line_idx" ON "subledger_entry" USING btree ("journal_line_id");--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE — Phase 02.8 and 02.9.
-- ===========================================================================

ALTER TABLE subledger_entry
  ALTER COLUMN debit_txn  TYPE money_amount,
  ALTER COLUMN credit_txn TYPE money_amount,
  ALTER COLUMN debit_iqd  TYPE money_amount,
  ALTER COLUMN credit_iqd TYPE money_amount,
  ALTER COLUMN debit_usd  TYPE money_amount,
  ALTER COLUMN credit_usd TYPE money_amount,
  ALTER COLUMN currency   TYPE currency_code;--> statement-breakpoint

-- §24 — "Posted journals and subledger entries are append-only."
CREATE TRIGGER subledger_entry_append_only
  BEFORE UPDATE OR DELETE ON subledger_entry
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

-- One journal line produces at most one subledger entry, so a reconciliation
-- can never double-count a movement.
CREATE UNIQUE INDEX subledger_entry_line_uniq ON subledger_entry (journal_line_id);--> statement-breakpoint

-- A subledger entry may only sit against an account that is actually a control
-- account. Otherwise a subledger would reconcile to nothing.
CREATE FUNCTION subledger_entry_control_account() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_account chart_of_account%ROWTYPE;
BEGIN
  SELECT * INTO v_account FROM chart_of_account WHERE id = NEW.control_account_id;

  IF v_account.control_account IS NULL THEN
    RAISE EXCEPTION
      'Account % is not a control account, so no subledger reconciles to it (§1.2).',
      v_account.code USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_account.control_account <> NEW.subledger_type THEN
    RAISE EXCEPTION
      'Account % controls the % subledger, not the % subledger.',
      v_account.code, v_account.control_account, NEW.subledger_type
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER subledger_entry_control_account
  BEFORE INSERT ON subledger_entry
  FOR EACH ROW EXECUTE FUNCTION subledger_entry_control_account();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §14.3 · reversal integrity, at the database.
--
-- The service checks all of this and produces readable messages. This is the
-- second layer: an import, a script or a future module cannot create a reversal
-- that breaks the rules just because it did not go through the service.
-- ---------------------------------------------------------------------------
CREATE FUNCTION journal_entry_reversal_integrity() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_original journal_entry%ROWTYPE;
BEGIN
  IF NEW.reverses_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_original FROM journal_entry WHERE id = NEW.reverses_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The journal being reversed does not exist.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW.id = NEW.reverses_id THEN
    RAISE EXCEPTION 'A journal cannot reverse itself.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- §14.3 — "Reversal Date must equal or be later than the original Posting Date."
  IF NEW.posting_date < v_original.posting_date THEN
    RAISE EXCEPTION
      'A reversal dated % is earlier than journal %, which posted on % (§14.3).',
      NEW.posting_date, v_original.entry_no, v_original.posting_date
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- A reversal cannot itself be reversed: that would recreate the original
  -- effect under a third number.
  IF v_original.reverses_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Journal % is itself a reversal and cannot be reversed (§14.3).',
      v_original.entry_no USING ERRCODE = 'restrict_violation';
  END IF;

  -- And a journal is reversed once.
  IF v_original.reversed_by_id IS NOT NULL AND v_original.reversed_by_id <> NEW.id THEN
    RAISE EXCEPTION
      'Journal % has already been reversed by another document.',
      v_original.entry_no USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER journal_entry_reversal_integrity
  BEFORE INSERT OR UPDATE ON journal_entry
  FOR EACH ROW EXECUTE FUNCTION journal_entry_reversal_integrity();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Integrity checks §24 expects to return zero.
--
--   "Unbalanced or orphan-entry integrity report, expected to be zero."
--
-- A view rather than a query in application code, so the same definition serves
-- the report, the tests and anyone asking the database directly.
-- ---------------------------------------------------------------------------
CREATE VIEW gl_integrity_issue AS
  -- A posted journal whose debits and credits disagree.
  SELECT 'unbalanced_journal' AS issue,
         e.id::text            AS object_id,
         e.entry_no            AS reference,
         format('debits %s, credits %s', e.total_debit_iqd, e.total_credit_iqd) AS detail
    FROM journal_entry e
   WHERE e.status IN ('posted', 'reversed')
     AND e.total_debit_iqd <> e.total_credit_iqd

  UNION ALL
  -- A posted journal with fewer than two lines.
  SELECT 'single_sided_journal',
         e.id::text,
         e.entry_no,
         format('%s line(s)', (SELECT count(*) FROM journal_line l WHERE l.journal_entry_id = e.id))
    FROM journal_entry e
   WHERE e.status IN ('posted', 'reversed')
     AND (SELECT count(*) FROM journal_line l WHERE l.journal_entry_id = e.id) < 2

  UNION ALL
  -- A subledger entry whose journal is not posted: the subledger would show a
  -- movement the G/L does not.
  SELECT 'orphan_subledger_entry',
         s.id::text,
         e.entry_no,
         format('%s subledger, party %s', s.subledger_type, s.party_code)
    FROM subledger_entry s
    JOIN journal_entry e ON e.id = s.journal_entry_id
   WHERE e.status NOT IN ('posted', 'reversed')

  UNION ALL
  -- A line on a posted journal whose account has since become a group.
  SELECT 'posted_to_group_account',
         l.id::text,
         e.entry_no,
         a.code
    FROM journal_line l
    JOIN journal_entry e ON e.id = l.journal_entry_id
    JOIN chart_of_account a ON a.id = l.account_id
   WHERE e.status IN ('posted', 'reversed')
     AND a.is_group;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON subledger_entry FROM erp_app;

  -- Append-only: written with its journal, never revised.
  GRANT SELECT, INSERT ON subledger_entry TO erp_app;
  GRANT SELECT ON gl_integrity_issue TO erp_app;
END;
$$;