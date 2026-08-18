CREATE TYPE "public"."money_transfer_expense_type" AS ENUM('bank_charge', 'other');--> statement-breakpoint
CREATE TABLE "money_transfer_expense" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expense_no" text NOT NULL,
	"money_transfer_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"expense_date" date NOT NULL,
	"expense_type" "money_transfer_expense_type" NOT NULL,
	"description" text,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"charged_to_client" boolean NOT NULL,
	"company_bank_account_id" uuid NOT NULL,
	"journal_entry_id" uuid,
	"created_by" uuid NOT NULL,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"reversed_by" uuid,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "money_transfer_expense_amount_positive" CHECK ("money_transfer_expense"."amount_iqd" > 0),
	CONSTRAINT "money_transfer_expense_reversal_has_reason" CHECK (("money_transfer_expense"."reversed_by" is null and "money_transfer_expense"."reversed_at" is null)
          or ("money_transfer_expense"."reversed_by" is not null and "money_transfer_expense"."reversed_at" is not null
              and coalesce(btrim("money_transfer_expense"."reversal_reason"), '') <> ''))
);
--> statement-breakpoint

ALTER TABLE "money_transfer_expense" ADD CONSTRAINT "money_transfer_expense_money_transfer_id_money_transfer_id_fk" FOREIGN KEY ("money_transfer_id") REFERENCES "public"."money_transfer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer_expense" ADD CONSTRAINT "money_transfer_expense_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer_expense" ADD CONSTRAINT "money_transfer_expense_company_bank_account_id_bank_cash_account_id_fk" FOREIGN KEY ("company_bank_account_id") REFERENCES "public"."bank_cash_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer_expense" ADD CONSTRAINT "money_transfer_expense_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer_expense" ADD CONSTRAINT "money_transfer_expense_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer_expense" ADD CONSTRAINT "money_transfer_expense_posted_by_app_user_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer_expense" ADD CONSTRAINT "money_transfer_expense_reversed_by_app_user_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "money_transfer_expense_no_uniq" ON "money_transfer_expense" USING btree ("expense_no");--> statement-breakpoint
CREATE INDEX "money_transfer_expense_transfer_idx" ON "money_transfer_expense" USING btree ("money_transfer_id","status");--> statement-breakpoint
CREATE INDEX "money_transfer_expense_date_idx" ON "money_transfer_expense" USING btree ("expense_date","branch_code");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 09.7 gate — "An unlinked fee cannot be posted to the Money Transfer expense
-- account."
--
-- `money_transfer_id` is NOT NULL, so an unlinked fee has nowhere to exist:
-- Appendix C's "linked to transfer" is the column, not a rule anyone has to
-- remember. This trigger adds the part a NOT NULL cannot say — that the fee
-- belongs to the same branch as the transfer it is charged against, so a fee
-- cannot quietly land in another branch's profit and loss.
-- ---------------------------------------------------------------------------
CREATE FUNCTION money_transfer_expense_follows_transfer() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_branch text;
  v_no     text;
  v_status document_status;
BEGIN
  -- The NOT NULL on money_transfer_id is what refuses an unlinked fee, and it
  -- says so more clearly than this trigger could. Standing aside lets the
  -- constraint that owns the rule be the one that reports it.
  IF NEW.money_transfer_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT branch_code, transfer_no, status INTO v_branch, v_no, v_status
    FROM money_transfer WHERE id = NEW.money_transfer_id;

  IF NEW.branch_code IS DISTINCT FROM v_branch THEN
    RAISE EXCEPTION
      'Expense is on branch % but transfer % belongs to branch % (§14.3, §12.4). A direct expense is borne where the transfer is.',
      NEW.branch_code, v_no, v_branch USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_status = 'draft' THEN
    RAISE EXCEPTION
      'Transfer % is still a draft; there is no bank movement yet for a charge to attach to (§12.4).',
      v_no USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER money_transfer_expense_follows_transfer
  BEFORE INSERT ON money_transfer_expense
  FOR EACH ROW EXECUTE FUNCTION money_transfer_expense_follows_transfer();--> statement-breakpoint

-- A posted charge is what the bank took. Corrected by reversal (§3.2).
--
-- `charged_to_client` is frozen with the rest, and that matters more here than
-- it looks: it decides the client's Remaining Client Balance (09.8) and, on a
-- returned transfer, whether the refund is full (§12.6). Letting it be flipped
-- after posting would silently restate a client's balance.
CREATE FUNCTION money_transfer_expense_posted_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_allowed text[] := ARRAY['status', 'updated_at', 'reversed_by', 'reversed_at', 'reversal_reason'];
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - v_allowed) IS DISTINCT FROM (to_jsonb(OLD) - v_allowed) THEN
    RAISE EXCEPTION
      'Expense % has posted; the bank has taken it and the ledger records it (§3.2). Reverse it and record it again.',
      OLD.expense_no USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER money_transfer_expense_posted_is_final
  BEFORE UPDATE ON money_transfer_expense
  FOR EACH ROW EXECUTE FUNCTION money_transfer_expense_posted_is_final();--> statement-breakpoint

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('MT_EXPENSE', 'MTE', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('money_transfer_expense', 'Money Transfer Direct Expense', 'money_transfer',
   'A bank charge or other direct expense on a specific transfer (§12.4). Posts Dr Bank Fees / Money Transfer Direct Expense, Cr Company Bank Account. Every fee names its transfer (Appendix C).');--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('money_transfer_expense', 'draft',  'posted'),
  ('money_transfer_expense', 'draft',  'cancelled'),
  ('money_transfer_expense', 'posted', 'reversed');--> statement-breakpoint

INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('money_transfer_expense', 'money_transfer_id',
   'Which transfer bears the charge. An unlinked fee cannot exist (09.7).'),
  ('money_transfer_expense', 'amount_iqd',
   'What the bank took. Corrected by reversal (§3.2).'),
  ('money_transfer_expense', 'charged_to_client',
   'Decides the client''s Remaining Client Balance (§12.4) and, on a return, the size of the refund (§12.6).'),
  ('money_transfer_expense', 'expense_date',
   'Decides the accounting period the charge lands in.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'money_transfer_expense', 'view'),
  ('accounting_officer', 'money_transfer_expense', 'create'),
  ('accounting_officer', 'money_transfer_expense', 'edit_draft'),
  ('accounting_officer', 'money_transfer_expense', 'submit'),
  ('accounting_manager', 'money_transfer_expense', 'view'),
  ('accounting_manager', 'money_transfer_expense', 'create'),
  ('accounting_manager', 'money_transfer_expense', 'edit_draft'),
  ('accounting_manager', 'money_transfer_expense', 'submit'),
  ('accounting_manager', 'money_transfer_expense', 'approve'),
  ('accounting_manager', 'money_transfer_expense', 'post'),
  ('accounting_manager', 'money_transfer_expense', 'reverse_cancel'),
  ('accounting_manager', 'money_transfer_expense', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON money_transfer_expense FROM erp_app;
  -- No DELETE: §12.6 makes the company absorb these charges after a return, so
  -- a deletable fee would be a deletable loss.
  GRANT SELECT, INSERT, UPDATE ON money_transfer_expense TO erp_app;
END;
$$;--> statement-breakpoint

ALTER TABLE money_transfer_expense ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE money_transfer_expense FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY money_transfer_expense_branch_scope ON money_transfer_expense
  USING (app_is_super_user() OR branch_code = app_current_branch())
  WITH CHECK (app_is_super_user() OR branch_code = app_current_branch());
