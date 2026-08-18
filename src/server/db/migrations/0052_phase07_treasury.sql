CREATE TABLE "cash_count" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"count_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"bank_cash_account_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"count_date" date NOT NULL,
	"counted_iqd" numeric(19, 4) NOT NULL,
	"book_iqd" numeric(19, 4) NOT NULL,
	"variance_iqd" numeric(19, 4) NOT NULL,
	"custodian_user_id" uuid,
	"variance_reason" text,
	"note" text,
	"journal_entry_id" uuid,
	"counted_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_count_amounts_not_negative" CHECK ("cash_count"."counted_iqd" >= 0 and "cash_count"."book_iqd" >= 0),
	CONSTRAINT "cash_count_variance_is_the_difference" CHECK ("cash_count"."variance_iqd" = "cash_count"."counted_iqd" - "cash_count"."book_iqd"),
	CONSTRAINT "cash_count_variance_has_a_reason" CHECK ("cash_count"."variance_iqd" = 0 or "cash_count"."approved_at" is null
          or coalesce(btrim("cash_count"."variance_reason"), '') <> ''),
	CONSTRAINT "cash_count_posting_matches_variance" CHECK ("cash_count"."journal_entry_id" is null or "cash_count"."variance_iqd" <> 0),
	CONSTRAINT "cash_count_posting_matches_status" CHECK (("cash_count"."journal_entry_id" is null) = ("cash_count"."posted_at" is null)),
	CONSTRAINT "cash_count_stamps_in_order" CHECK (("cash_count"."posted_at" is null or "cash_count"."approved_at" is not null)
          and ("cash_count"."posted_at" is null or "cash_count"."approved_at" <= "cash_count"."posted_at"))
);
--> statement-breakpoint
CREATE TABLE "bank_transfer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transfer_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"from_account_id" uuid NOT NULL,
	"to_account_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"transfer_date" date NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"from_currency" text NOT NULL,
	"received_amount" numeric(19, 4) NOT NULL,
	"to_currency" text NOT NULL,
	"fx_rate" numeric(18, 8),
	"bank_reference" text,
	"note" text,
	"journal_entry_id" uuid,
	"created_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"reversed_by" uuid,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_transfer_amounts_positive" CHECK ("bank_transfer"."amount" > 0 and "bank_transfer"."received_amount" > 0),
	CONSTRAINT "bank_transfer_accounts_differ" CHECK ("bank_transfer"."from_account_id" <> "bank_transfer"."to_account_id"),
	CONSTRAINT "bank_transfer_rate_matches_currencies" CHECK (("bank_transfer"."from_currency" = "bank_transfer"."to_currency" and "bank_transfer"."fx_rate" is null
           and "bank_transfer"."amount" = "bank_transfer"."received_amount")
          or ("bank_transfer"."from_currency" <> "bank_transfer"."to_currency" and "bank_transfer"."fx_rate" is not null and "bank_transfer"."fx_rate" > 0)),
	CONSTRAINT "bank_transfer_reversal_has_reason" CHECK (("bank_transfer"."reversed_by" is null and "bank_transfer"."reversed_at" is null)
          or ("bank_transfer"."reversed_by" is not null and "bank_transfer"."reversed_at" is not null
              and coalesce(btrim("bank_transfer"."reversal_reason"), '') <> '')),
	CONSTRAINT "bank_transfer_posting_matches_status" CHECK (("bank_transfer"."journal_entry_id" is null) = ("bank_transfer"."posted_at" is null)),
	CONSTRAINT "bank_transfer_stamps_in_order" CHECK (("bank_transfer"."posted_at" is null or "bank_transfer"."approved_at" is not null)
          and ("bank_transfer"."posted_at" is null or "bank_transfer"."approved_at" <= "bank_transfer"."posted_at")
          and ("bank_transfer"."reversed_at" is null or "bank_transfer"."posted_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "cash_count" ADD CONSTRAINT "cash_count_bank_cash_account_id_bank_cash_account_id_fk" FOREIGN KEY ("bank_cash_account_id") REFERENCES "public"."bank_cash_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_count" ADD CONSTRAINT "cash_count_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_count" ADD CONSTRAINT "cash_count_custodian_user_id_app_user_id_fk" FOREIGN KEY ("custodian_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_count" ADD CONSTRAINT "cash_count_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_count" ADD CONSTRAINT "cash_count_counted_by_app_user_id_fk" FOREIGN KEY ("counted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_count" ADD CONSTRAINT "cash_count_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_count" ADD CONSTRAINT "cash_count_posted_by_app_user_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfer" ADD CONSTRAINT "bank_transfer_from_account_id_bank_cash_account_id_fk" FOREIGN KEY ("from_account_id") REFERENCES "public"."bank_cash_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfer" ADD CONSTRAINT "bank_transfer_to_account_id_bank_cash_account_id_fk" FOREIGN KEY ("to_account_id") REFERENCES "public"."bank_cash_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfer" ADD CONSTRAINT "bank_transfer_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfer" ADD CONSTRAINT "bank_transfer_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfer" ADD CONSTRAINT "bank_transfer_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfer" ADD CONSTRAINT "bank_transfer_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfer" ADD CONSTRAINT "bank_transfer_posted_by_app_user_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfer" ADD CONSTRAINT "bank_transfer_reversed_by_app_user_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_count_no_uniq" ON "cash_count" USING btree ("count_no");--> statement-breakpoint
CREATE INDEX "cash_count_account_idx" ON "cash_count" USING btree ("bank_cash_account_id","count_date");--> statement-breakpoint
CREATE INDEX "cash_count_status_idx" ON "cash_count" USING btree ("status","branch_code");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_transfer_no_uniq" ON "bank_transfer" USING btree ("transfer_no");--> statement-breakpoint
CREATE INDEX "bank_transfer_from_idx" ON "bank_transfer" USING btree ("from_account_id","transfer_date");--> statement-breakpoint
CREATE INDEX "bank_transfer_to_idx" ON "bank_transfer" USING btree ("to_account_id","transfer_date");--> statement-breakpoint
CREATE INDEX "bank_transfer_status_idx" ON "bank_transfer" USING btree ("status","branch_code");
-- ===========================================================================
-- Phase 07.1 and 07.4 — treasury operations (§17)
--
-- The account master is Phase 03's `bank_cash_account`, which already carries
-- the currency, the custodian, the cash limit, the approval limit and the
-- statement format section 17 asks for. This adds what *happens* to those
-- accounts.
--
-- **A note on where balances come from.** Nowhere in this migration is there a
-- cached balance column, and that is deliberate: the 07.1 gate is *"each
-- bank/cash account's ledger balance equals its mapped G/L account balance"*, and
-- a cached figure turns that identity into a reconciliation that can fail. The
-- balance is read from the journal, and `bank_cash_account_gl_uniq` (Phase 03)
-- is what makes the mapping one-to-one.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Section 17 — a cash count belongs to a *cash* account.
--
-- Counting a bank account is not a count, it is a reconciliation, and it has its
-- own workspace in 07.7. Letting one document mean both would make the exception
-- report meaningless.
-- ---------------------------------------------------------------------------
CREATE FUNCTION cash_count_is_of_a_cash_account() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_type   text;
  v_code   text;
  v_branch text;
BEGIN
  SELECT account_type::text, code, branch_code
    INTO v_type, v_code, v_branch
    FROM bank_cash_account WHERE id = NEW.bank_cash_account_id;

  IF v_type IS DISTINCT FROM 'cash' THEN
    RAISE EXCEPTION
      '% is a % account. A physical count is of cash in a drawer; a bank account is agreed against a statement instead (blueprint 17).',
      v_code, coalesce(v_type, 'missing')
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.branch_code IS DISTINCT FROM v_branch THEN
    RAISE EXCEPTION
      'Cash count is in branch % but % belongs to %.',
      NEW.branch_code, v_code, v_branch
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER cash_count_is_of_a_cash_account
  BEFORE INSERT OR UPDATE ON cash_count
  FOR EACH ROW EXECUTE FUNCTION cash_count_is_of_a_cash_account();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 17 — a transfer's recorded currencies are the accounts' own.
--
-- The columns exist so that a transfer read years later shows what the accounts
-- were denominated in at the time; a currency typed independently of the account
-- would let the FX check above pass on a fiction.
-- ---------------------------------------------------------------------------
CREATE FUNCTION bank_transfer_currencies_are_the_accounts() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_from_ccy text;
  v_to_ccy   text;
  v_from     text;
  v_to       text;
BEGIN
  SELECT currency, code INTO v_from_ccy, v_from FROM bank_cash_account WHERE id = NEW.from_account_id;
  SELECT currency, code INTO v_to_ccy,   v_to   FROM bank_cash_account WHERE id = NEW.to_account_id;

  IF NEW.from_currency IS DISTINCT FROM v_from_ccy THEN
    RAISE EXCEPTION
      'Transfer says it leaves % in %, but that account is held in %.',
      v_from, NEW.from_currency, v_from_ccy
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.to_currency IS DISTINCT FROM v_to_ccy THEN
    RAISE EXCEPTION
      'Transfer says it arrives in % as %, but that account is held in %.',
      v_to, NEW.to_currency, v_to_ccy
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER bank_transfer_currencies_are_the_accounts
  BEFORE INSERT OR UPDATE ON bank_transfer
  FOR EACH ROW EXECUTE FUNCTION bank_transfer_currencies_are_the_accounts();--> statement-breakpoint

-- Numbering, document types, statuses and permissions.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('CASH_COUNT', 'CCT', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true),
       ('BANK_TRANSFER', 'BTR', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('cash_count', 'Cash Count', 'treasury',
   'A physical count of a cash float against the ledger (blueprint 17). A variance - over or short - is approved with a reason and posted; a count that agrees posts nothing.'),
  ('bank_transfer', 'Bank Transfer', 'treasury',
   'Money moved between the company''s own accounts. One document, two legs, one balanced journal. A cross-currency transfer records the approved rate on the document (blueprint 17, 14.3).');--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('cash_count', 'draft',    'approved'),
  ('cash_count', 'draft',    'cancelled'),
  ('cash_count', 'approved', 'posted'),
  ('cash_count', 'approved', 'draft'),
  ('bank_transfer', 'draft',    'approved'),
  ('bank_transfer', 'draft',    'cancelled'),
  ('bank_transfer', 'approved', 'draft'),
  ('bank_transfer', 'approved', 'posted'),
  ('bank_transfer', 'posted',   'reversed');--> statement-breakpoint

INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('cash_count', 'counted_iqd',
   'What was physically in the drawer. Changing it after approval would rewrite the count somebody signed.'),
  ('bank_transfer', 'amount',
   'How much leaves the source account.'),
  ('bank_transfer', 'fx_rate',
   'Blueprint 14.3 makes the rate a Finance decision; it is approved with the transfer and not looked up again at posting.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'bank_cash_account', 'view'),
  ('accounting_officer', 'bank_cash_account', 'create'),
  ('accounting_officer', 'bank_cash_account', 'execute'),
  ('accounting_officer', 'bank_cash_account', 'print'),
  ('accounting_manager', 'bank_cash_account', 'view'),
  ('accounting_manager', 'bank_cash_account', 'create'),
  ('accounting_manager', 'bank_cash_account', 'execute'),
  ('accounting_manager', 'bank_cash_account', 'approve'),
  ('accounting_manager', 'bank_cash_account', 'post'),
  ('accounting_manager', 'bank_cash_account', 'configure'),
  ('accounting_manager', 'bank_cash_account', 'reverse_cancel'),
  ('accounting_manager', 'bank_cash_account', 'print'),
  ('accounting_manager', 'bank_cash_account', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist - grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON cash_count, bank_transfer FROM erp_app;

  GRANT SELECT, INSERT, UPDATE ON cash_count TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON bank_transfer TO erp_app;
END;
$$;--> statement-breakpoint

-- D10 — the branch boundary.
ALTER TABLE cash_count ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE cash_count FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY cash_count_branch_scope ON cash_count
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

ALTER TABLE bank_transfer ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE bank_transfer FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY bank_transfer_branch_scope ON bank_transfer
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));
