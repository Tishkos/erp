-- ---------------------------------------------------------------------------
-- The last two cross-branch text stubs become links.
--
-- Phases 07, 09 and 10 were built in parallel. Three times, a module needed to
-- point at a table that did not exist on its branch yet, and three times it left
-- a text column and a note saying who should replace it. 0153 dealt with the
-- first. These are the other two, and both notes are quoted where they sit.
--
-- A text reference is not a weaker link. It is a link that can be wrong: nothing
-- stops it naming a job that was cancelled, a statement line on another account,
-- or a document that never existed. §12.5 and §12.7 both turn on the reference
-- being *right*, so the reference has to be a foreign key.
-- ---------------------------------------------------------------------------

-- 1 · A money transfer names its logistics job -------------------------------
--
--   money-transfer.ts: "The logistics job is text and not a foreign key: the
--   Logistics module is Phase 10 and its table does not exist yet. ... Phase 10
--   adds the constraint when there is something to point at."
--
-- There is now something to point at.
ALTER TABLE money_transfer
  ADD COLUMN logistics_job_id uuid REFERENCES logistics_job(id);--> statement-breakpoint

UPDATE money_transfer m
   SET logistics_job_id = j.id
  FROM logistics_job j
 WHERE j.job_no = m.logistics_job_ref
   AND m.logistics_job_id IS NULL;--> statement-breakpoint

DROP INDEX IF EXISTS money_transfer_logistics_idx;--> statement-breakpoint
ALTER TABLE money_transfer DROP COLUMN logistics_job_ref;--> statement-breakpoint
CREATE INDEX money_transfer_logistics_idx ON money_transfer (logistics_job_id);--> statement-breakpoint

-- §11.3 and §12.4 keep the two services' results apart, but they are apart on
-- the *same consignment* — so if a transfer names both an import file and a
-- logistics job, the job must be on that file. Otherwise the cross-reference
-- report (§11.5, §22) would put two unrelated cases side by side and call it a
-- reconciliation.
CREATE FUNCTION money_transfer_job_is_on_the_same_file() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_job_file uuid;
  v_job_no   text;
BEGIN
  IF NEW.logistics_job_id IS NULL OR NEW.client_import_file_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT import_file_id, job_no INTO v_job_file, v_job_no
    FROM logistics_job WHERE id = NEW.logistics_job_id;

  IF v_job_file IS DISTINCT FROM NEW.client_import_file_id THEN
    RAISE EXCEPTION
      'Logistics job % is on a different import file from transfer % (blueprint 11.3, 12.4). The two services keep separate results on the same consignment, not results on two consignments.',
      v_job_no, NEW.transfer_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER money_transfer_job_is_on_the_same_file
  BEFORE INSERT OR UPDATE OF logistics_job_id, client_import_file_id ON money_transfer
  FOR EACH ROW EXECUTE FUNCTION money_transfer_job_is_on_the_same_file();--> statement-breakpoint

-- 2 · A bank execution batch names its statement line ------------------------
--
--   bank-execution.ts: "The statement line is a reference rather than a link:
--   Phase 07.7 owns bank statements and does not exist yet. When it does, this
--   column becomes a foreign key and this function gains a lookup."
--
-- Phase 07.7 exists. §12.5 — *"The batch total shall reconcile to the single
-- bank-statement amount"* — and §12.7's Transfer-to-Bank Statement
-- Reconciliation are the acceptance criteria this closes.
ALTER TABLE bank_execution_batch
  ADD COLUMN statement_line_id uuid REFERENCES bank_statement_line(id);--> statement-breakpoint

UPDATE bank_execution_batch b
   SET statement_line_id = l.id
  FROM bank_statement_line l
  JOIN bank_statement s ON s.id = l.statement_id
 WHERE l.reference = b.statement_line_ref
   AND s.bank_cash_account_id = b.bank_cash_account_id
   AND b.statement_line_id IS NULL;--> statement-breakpoint

DROP INDEX IF EXISTS bank_execution_batch_statement_uniq;--> statement-breakpoint

ALTER TABLE bank_execution_batch
  DROP CONSTRAINT bank_execution_batch_reconciliation_complete;--> statement-breakpoint

ALTER TABLE bank_execution_batch DROP COLUMN statement_line_ref;--> statement-breakpoint

-- One statement line explains one batch. §12.5's whole purpose is that the
-- bank's single movement has a single explanation on this side, and a foreign
-- key makes "the same line twice" impossible rather than merely discouraged.
CREATE UNIQUE INDEX bank_execution_batch_statement_uniq
  ON bank_execution_batch (statement_line_id)
  WHERE statement_line_id IS NOT NULL AND reversed_at IS NULL;--> statement-breakpoint

ALTER TABLE bank_execution_batch
  ADD CONSTRAINT bank_execution_batch_reconciliation_complete
  CHECK ((reconciled_at IS NULL AND reconciled_by IS NULL)
      OR (reconciled_at IS NOT NULL AND reconciled_by IS NOT NULL
          AND statement_line_id IS NOT NULL));--> statement-breakpoint

-- The batch and the line must be the same account's. A reconciliation that
-- crosses accounts is not a reconciliation; it is two errors that cancel.
CREATE FUNCTION bank_execution_batch_line_is_same_account() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_account uuid;
  v_amount  numeric(19,4);
BEGIN
  IF NEW.statement_line_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT s.bank_cash_account_id, l.amount_iqd INTO v_account, v_amount
    FROM bank_statement_line l
    JOIN bank_statement s ON s.id = l.statement_id
   WHERE l.id = NEW.statement_line_id;

  IF v_account IS DISTINCT FROM NEW.bank_cash_account_id THEN
    RAISE EXCEPTION
      'Batch % is on one bank account and the statement line on another (blueprint 12.5).',
      NEW.batch_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- A batch pays out, so the line is a debit: negative, by the sign convention
  -- `directionOf` reads. §12.5 says the total *shall* reconcile, and 12.7's
  -- word is "exactly" - so this is equality, not a tolerance.
  IF abs(v_amount) <> NEW.total_iqd THEN
    RAISE EXCEPTION
      'Batch % totals % and the statement line is % (blueprint 12.5). The batch total shall reconcile to the single bank-statement amount.',
      NEW.batch_no, NEW.total_iqd, v_amount
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER bank_execution_batch_line_is_same_account
  BEFORE INSERT OR UPDATE OF statement_line_id, total_iqd ON bank_execution_batch
  FOR EACH ROW EXECUTE FUNCTION bank_execution_batch_line_is_same_account();
