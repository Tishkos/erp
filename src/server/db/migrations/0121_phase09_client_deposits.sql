CREATE TYPE "public"."client_deposit_method" AS ENUM('cash', 'bank_transfer');--> statement-breakpoint
CREATE TABLE "money_transfer_deposit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deposit_no" text NOT NULL,
	"client_account_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"deposit_date" date NOT NULL,
	"method" "client_deposit_method" NOT NULL,
	"company_bank_account_id" uuid NOT NULL,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"used_amount_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"refunded_amount_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"bank_reference" text,
	"note" text,
	"journal_entry_id" uuid,
	"created_by" uuid NOT NULL,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"reversed_by" uuid,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "money_transfer_deposit_amount_positive" CHECK ("money_transfer_deposit"."amount_iqd" > 0),
	CONSTRAINT "money_transfer_deposit_used_non_negative" CHECK ("money_transfer_deposit"."used_amount_iqd" >= 0),
	CONSTRAINT "money_transfer_deposit_refunded_non_negative" CHECK ("money_transfer_deposit"."refunded_amount_iqd" >= 0),
	CONSTRAINT "money_transfer_deposit_not_over_used" CHECK ("money_transfer_deposit"."used_amount_iqd" + "money_transfer_deposit"."refunded_amount_iqd" <= "money_transfer_deposit"."amount_iqd"),
	CONSTRAINT "money_transfer_deposit_reversal_has_reason" CHECK (("money_transfer_deposit"."reversed_by" is null and "money_transfer_deposit"."reversed_at" is null)
          or ("money_transfer_deposit"."reversed_by" is not null and "money_transfer_deposit"."reversed_at" is not null
              and coalesce(btrim("money_transfer_deposit"."reversal_reason"), '') <> ''))
);
--> statement-breakpoint

ALTER TABLE "money_transfer_deposit" ADD CONSTRAINT "money_transfer_deposit_client_account_id_money_transfer_client_account_id_fk" FOREIGN KEY ("client_account_id") REFERENCES "public"."money_transfer_client_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer_deposit" ADD CONSTRAINT "money_transfer_deposit_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer_deposit" ADD CONSTRAINT "money_transfer_deposit_company_bank_account_id_bank_cash_account_id_fk" FOREIGN KEY ("company_bank_account_id") REFERENCES "public"."bank_cash_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer_deposit" ADD CONSTRAINT "money_transfer_deposit_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer_deposit" ADD CONSTRAINT "money_transfer_deposit_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer_deposit" ADD CONSTRAINT "money_transfer_deposit_posted_by_app_user_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer_deposit" ADD CONSTRAINT "money_transfer_deposit_reversed_by_app_user_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "money_transfer_deposit_no_uniq" ON "money_transfer_deposit" USING btree ("deposit_no");--> statement-breakpoint
CREATE INDEX "money_transfer_deposit_account_idx" ON "money_transfer_deposit" USING btree ("client_account_id","status");--> statement-breakpoint
CREATE INDEX "money_transfer_deposit_date_idx" ON "money_transfer_deposit" USING btree ("deposit_date","branch_code");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Deposits arrive while the account is open, and only while it is open.
--
-- §12.3: "The client account remains open until the client confirms that funding
-- is complete and specifies the amount to transfer." Once they have confirmed,
-- funding is by definition complete — a later deposit would change the amount
-- the transfer was priced and agreed against, after the client agreed it.
--
-- Enforced on the deposit rather than on the account because the account cannot
-- see a row that does not exist yet.
-- ---------------------------------------------------------------------------
CREATE FUNCTION money_transfer_deposit_account_is_open() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status document_status;
  v_no     text;
  v_branch text;
BEGIN
  SELECT status, account_no, branch_code INTO v_status, v_no, v_branch
    FROM money_transfer_client_account WHERE id = NEW.client_account_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'No client account %.', NEW.client_account_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_status <> 'draft' THEN
    RAISE EXCEPTION
      'Client account % is ''%''; funding was confirmed complete, so no further deposit can be added (§12.3). Open a new account for a new funding cycle.',
      v_no, v_status USING ERRCODE = 'restrict_violation';
  END IF;

  -- A deposit belongs to the branch that holds the account. Without this the
  -- two branch codes are independent columns, and a deposit could post to one
  -- branch's books against another branch's client balance.
  IF NEW.branch_code IS DISTINCT FROM v_branch THEN
    RAISE EXCEPTION
      'Deposit is on branch % but client account % belongs to branch % (§14.3). A deposit posts to the branch that holds the account.',
      NEW.branch_code, v_no, v_branch USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER money_transfer_deposit_account_is_open
  BEFORE INSERT ON money_transfer_deposit
  FOR EACH ROW EXECUTE FUNCTION money_transfer_deposit_account_is_open();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A posted deposit is client money that has reached the bank.
--
-- §3.2 corrects a posted document by reversal, never by editing: the amount, the
-- date and the account it landed in are what the bank statement says. The usage
-- totals are the exception — they are maintained from the usage history as
-- transfers consume the deposit, which is the one thing about it that moves.
-- ---------------------------------------------------------------------------
CREATE FUNCTION money_transfer_deposit_posted_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_allowed text[] := ARRAY[
    'status', 'used_amount_iqd', 'refunded_amount_iqd', 'updated_at',
    'reversed_by', 'reversed_at', 'reversal_reason'
  ];
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - v_allowed) IS DISTINCT FROM (to_jsonb(OLD) - v_allowed) THEN
    RAISE EXCEPTION
      'Deposit % has posted; the money is in the bank and the ledger records it (§3.2). Reverse it and record the deposit again.',
      OLD.deposit_no USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER money_transfer_deposit_posted_is_final
  BEFORE UPDATE ON money_transfer_deposit
  FOR EACH ROW EXECUTE FUNCTION money_transfer_deposit_posted_is_final();--> statement-breakpoint

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('MT_CLIENT_DEPOSIT', 'MTD', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('money_transfer_deposit', 'Client Deposit', 'money_transfer',
   'Client money paid into a company bank account (§12.3). Posts Dr Company Bank Account / Cr Client Clearing (§12.4). One of several partial deposits against one client account.');--> statement-breakpoint

-- Appendix B: Draft, Posted, Available, Partially Used, Used, Refunded,
-- Reversed. Posted and Available are one state here — see the schema comment.
INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('money_transfer_deposit', 'draft',              'posted'),
  ('money_transfer_deposit', 'draft',              'cancelled'),
  ('money_transfer_deposit', 'posted',             'partially_executed'),
  ('money_transfer_deposit', 'posted',             'settled'),
  ('money_transfer_deposit', 'posted',             'closed'),
  ('money_transfer_deposit', 'partially_executed', 'settled'),
  ('money_transfer_deposit', 'partially_executed', 'closed'),
  -- The three usage states run in both directions. A returned transfer gives
  -- the client their deposits back (§12.6), so a Used deposit becomes Available
  -- again — the same journey backwards, and the machine has to allow it or the
  -- return would be a state nobody could reach.
  ('money_transfer_deposit', 'partially_executed', 'posted'),
  ('money_transfer_deposit', 'settled',            'partially_executed'),
  ('money_transfer_deposit', 'settled',            'posted'),
  ('money_transfer_deposit', 'closed',             'posted'),
  ('money_transfer_deposit', 'posted',             'reversed'),
  ('money_transfer_deposit', 'partially_executed', 'reversed'),
  ('money_transfer_deposit', 'settled',            'reversed');--> statement-breakpoint

INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('money_transfer_deposit', 'client_account_id',
   'Decides whose clearing balance the money joins.'),
  ('money_transfer_deposit', 'amount_iqd',
   'The amount the bank received. Corrected by reversal, never by edit (§3.2).'),
  ('money_transfer_deposit', 'deposit_date',
   'Decides the accounting period the bank and clearing movements land in.'),
  ('money_transfer_deposit', 'company_bank_account_id',
   'Decides which company bank account is debited (§12.4).'),
  ('money_transfer_deposit', 'branch_code',
   'A deposit posts to one branch (§14.3).')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'money_transfer_deposit', 'view'),
  ('accounting_officer', 'money_transfer_deposit', 'create'),
  ('accounting_officer', 'money_transfer_deposit', 'edit_draft'),
  ('accounting_officer', 'money_transfer_deposit', 'submit'),
  ('accounting_officer', 'money_transfer_deposit', 'print'),
  ('accounting_manager', 'money_transfer_deposit', 'view'),
  ('accounting_manager', 'money_transfer_deposit', 'create'),
  ('accounting_manager', 'money_transfer_deposit', 'edit_draft'),
  ('accounting_manager', 'money_transfer_deposit', 'submit'),
  ('accounting_manager', 'money_transfer_deposit', 'approve'),
  ('accounting_manager', 'money_transfer_deposit', 'post'),
  ('accounting_manager', 'money_transfer_deposit', 'reverse_cancel'),
  ('accounting_manager', 'money_transfer_deposit', 'print'),
  ('accounting_manager', 'money_transfer_deposit', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON money_transfer_deposit FROM erp_app;

  -- No DELETE: a deposit is a record of client money arriving. §1.1 keeps saved
  -- documents, and this is one whose absence a client would notice.
  GRANT SELECT, INSERT, UPDATE ON money_transfer_deposit TO erp_app;
END;
$$;--> statement-breakpoint

ALTER TABLE money_transfer_deposit ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE money_transfer_deposit FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY money_transfer_deposit_branch_scope ON money_transfer_deposit
  USING (app_is_super_user() OR branch_code = app_current_branch())
  WITH CHECK (app_is_super_user() OR branch_code = app_current_branch());
