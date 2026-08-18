CREATE TABLE "cash_advance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"advance_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"bank_cash_account_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"holder_user_id" uuid NOT NULL,
	"issue_date" date NOT NULL,
	"due_date" date NOT NULL,
	"purpose" text NOT NULL,
	"currency" text DEFAULT 'IQD' NOT NULL,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"settled_amount_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"returned_amount_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"journal_entry_id" uuid,
	"created_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"issued_by" uuid,
	"issued_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_advance_amount_positive" CHECK ("cash_advance"."amount_iqd" > 0),
	CONSTRAINT "cash_advance_purpose_present" CHECK (btrim("cash_advance"."purpose") <> ''),
	CONSTRAINT "cash_advance_due_not_before_issue" CHECK ("cash_advance"."due_date" >= "cash_advance"."issue_date"),
	CONSTRAINT "cash_advance_amounts_not_negative" CHECK ("cash_advance"."settled_amount_iqd" >= 0 and "cash_advance"."returned_amount_iqd" >= 0),
	CONSTRAINT "cash_advance_not_over_accounted" CHECK ("cash_advance"."settled_amount_iqd" + "cash_advance"."returned_amount_iqd" <= "cash_advance"."amount_iqd"),
	CONSTRAINT "cash_advance_issue_matches_posting" CHECK (("cash_advance"."journal_entry_id" is null) = ("cash_advance"."issued_at" is null)),
	CONSTRAINT "cash_advance_accounted_after_issue" CHECK ("cash_advance"."issued_at" is not null
          or ("cash_advance"."settled_amount_iqd" = 0 and "cash_advance"."returned_amount_iqd" = 0)),
	CONSTRAINT "cash_advance_settled_means_settled" CHECK ("cash_advance"."status" <> 'settled'
          or "cash_advance"."settled_amount_iqd" + "cash_advance"."returned_amount_iqd" = "cash_advance"."amount_iqd"),
	CONSTRAINT "cash_advance_closed_when_settled" CHECK (("cash_advance"."closed_at" is null) = ("cash_advance"."status" <> 'settled'))
);
--> statement-breakpoint
CREATE TABLE "cash_advance_settlement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cash_advance_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"department_code" text,
	"business_line_code" text,
	"spent_on" date NOT NULL,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"description" text NOT NULL,
	"receipt_reference" text,
	"journal_entry_id" uuid,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_advance_settlement_amount_positive" CHECK ("cash_advance_settlement"."amount_iqd" > 0),
	CONSTRAINT "cash_advance_settlement_description_present" CHECK (btrim("cash_advance_settlement"."description") <> '')
);
--> statement-breakpoint
ALTER TABLE "cash_advance" ADD CONSTRAINT "cash_advance_bank_cash_account_id_bank_cash_account_id_fk" FOREIGN KEY ("bank_cash_account_id") REFERENCES "public"."bank_cash_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_advance" ADD CONSTRAINT "cash_advance_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_advance" ADD CONSTRAINT "cash_advance_holder_user_id_app_user_id_fk" FOREIGN KEY ("holder_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_advance" ADD CONSTRAINT "cash_advance_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_advance" ADD CONSTRAINT "cash_advance_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_advance" ADD CONSTRAINT "cash_advance_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_advance" ADD CONSTRAINT "cash_advance_issued_by_app_user_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_advance_settlement" ADD CONSTRAINT "cash_advance_settlement_cash_advance_id_cash_advance_id_fk" FOREIGN KEY ("cash_advance_id") REFERENCES "public"."cash_advance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_advance_settlement" ADD CONSTRAINT "cash_advance_settlement_account_id_chart_of_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."chart_of_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_advance_settlement" ADD CONSTRAINT "cash_advance_settlement_department_code_department_code_fk" FOREIGN KEY ("department_code") REFERENCES "public"."department"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_advance_settlement" ADD CONSTRAINT "cash_advance_settlement_business_line_code_business_line_code_fk" FOREIGN KEY ("business_line_code") REFERENCES "public"."business_line"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_advance_settlement" ADD CONSTRAINT "cash_advance_settlement_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_advance_settlement" ADD CONSTRAINT "cash_advance_settlement_recorded_by_app_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_advance_no_uniq" ON "cash_advance" USING btree ("advance_no");--> statement-breakpoint
CREATE INDEX "cash_advance_holder_idx" ON "cash_advance" USING btree ("holder_user_id","status");--> statement-breakpoint
CREATE INDEX "cash_advance_account_idx" ON "cash_advance" USING btree ("bank_cash_account_id","issue_date");--> statement-breakpoint
CREATE INDEX "cash_advance_due_idx" ON "cash_advance" USING btree ("due_date","status");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_advance_settlement_line_uniq" ON "cash_advance_settlement" USING btree ("cash_advance_id","line_no");--> statement-breakpoint
CREATE INDEX "cash_advance_settlement_account_idx" ON "cash_advance_settlement" USING btree ("account_id","spent_on");--> statement-breakpoint

-- ===========================================================================
-- Phase 07.5 — petty cash advances (blueprint 17, Appendix D)
--
-- An advance is a receivable, not an expense. Money handed to somebody who has
-- not yet said what it was for has not been spent - it has been lent, and until
-- the receipts arrive that is what the balance sheet should say.
--
-- Cash counts are 07.1's and are not repeated here: a float is counted the same
-- way whether or not somebody has an advance out of it, and two implementations
-- of "what is in the drawer" would eventually disagree.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Section 17 - an advance comes out of a *cash* float, in its own branch.
--
-- Money sent from a bank account is a payment, with its own approval and its own
-- beneficiary checks (07.2, 07.3). Letting an advance draw on a bank account
-- would be a way around both.
-- ---------------------------------------------------------------------------
CREATE FUNCTION cash_advance_is_from_a_float() RETURNS trigger
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
      '% is a % account. A petty cash advance comes out of a float; money sent from a bank account is a payment, with its own approval and beneficiary checks (blueprint 17).',
      v_code, coalesce(v_type, 'missing')
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.branch_code IS DISTINCT FROM v_branch THEN
    RAISE EXCEPTION
      'Advance is in branch % but % belongs to %.',
      NEW.branch_code, v_code, v_branch
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER cash_advance_is_from_a_float
  BEFORE INSERT OR UPDATE ON cash_advance
  FOR EACH ROW EXECUTE FUNCTION cash_advance_is_from_a_float();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 17 - the receipts cannot add up to more than was advanced.
--
-- The header already carries settled + returned <= amount. This is the other
-- half: the settlement *lines* must add up to the settled figure the header
-- reports. Judged at COMMIT, because the rows arrive one at a time and only the
-- finished set can be judged.
--
-- Without both, an advance could report that it had been accounted for while
-- its own receipts said something else.
-- ---------------------------------------------------------------------------
CREATE FUNCTION cash_advance_settlement_totals_match() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_lines numeric(19,4);
  v_head  record;
BEGIN
  SELECT * INTO v_head FROM cash_advance
   WHERE id = COALESCE(NEW.cash_advance_id, OLD.cash_advance_id);
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT coalesce(sum(amount_iqd), 0::numeric(19,4)) INTO v_lines
    FROM cash_advance_settlement WHERE cash_advance_id = v_head.id;

  IF v_head.settled_amount_iqd <> v_lines THEN
    RAISE EXCEPTION
      'Advance % says % has been accounted for but its receipts total % (blueprint 17).',
      v_head.advance_no, v_head.settled_amount_iqd, v_lines
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER cash_advance_settlement_totals_match
  AFTER INSERT OR UPDATE OR DELETE ON cash_advance_settlement
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION cash_advance_settlement_totals_match();--> statement-breakpoint

-- Numbering, document type, statuses and permissions.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('CASH_ADVANCE', 'CAD', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('cash_advance', 'Cash Advance', 'treasury',
   'Money handed out of a petty cash float against a stated purpose and a date by which it must be accounted for (blueprint 17). It posts a receivable, not an expense - the expense arrives with the receipts, on the accounts the receipts name.');--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('cash_advance', 'draft',              'approved'),
  ('cash_advance', 'draft',              'cancelled'),
  ('cash_advance', 'approved',           'draft'),
  ('cash_advance', 'approved',           'cancelled'),
  ('cash_advance', 'approved',           'posted'),
  ('cash_advance', 'posted',             'partially_executed'),
  ('cash_advance', 'posted',             'settled'),
  ('cash_advance', 'partially_executed', 'settled'),
  ('cash_advance', 'posted',             'reversed');--> statement-breakpoint

INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('cash_advance', 'amount_iqd',
   'How much leaves the float. It is what the approver agreed to.'),
  ('cash_advance', 'holder_user_id',
   'Who owes an account of it. Changing this after approval would move somebody else''s debt onto them.'),
  ('cash_advance', 'due_date',
   'When it must be accounted for. A deadline moved after approval is a deadline set by whoever is late.'),
  ('cash_advance', 'bank_cash_account_id',
   'Which float the money came out of.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'cash_advance', 'view'),
  ('accounting_officer', 'cash_advance', 'create'),
  ('accounting_officer', 'cash_advance', 'submit'),
  ('accounting_officer', 'cash_advance', 'print'),
  ('accounting_manager', 'cash_advance', 'view'),
  ('accounting_manager', 'cash_advance', 'create'),
  ('accounting_manager', 'cash_advance', 'approve'),
  ('accounting_manager', 'cash_advance', 'post'),
  ('accounting_manager', 'cash_advance', 'reverse_cancel'),
  ('accounting_manager', 'cash_advance', 'print'),
  ('accounting_manager', 'cash_advance', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist - grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON cash_advance, cash_advance_settlement FROM erp_app;

  GRANT SELECT, INSERT, UPDATE ON cash_advance            TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON cash_advance_settlement TO erp_app;
END;
$$;--> statement-breakpoint

-- D10 - the branch boundary. Settlement lines reach through the advance.
ALTER TABLE cash_advance ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE cash_advance FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY cash_advance_branch_scope ON cash_advance
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

ALTER TABLE cash_advance_settlement ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE cash_advance_settlement FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY cash_advance_settlement_branch_scope ON cash_advance_settlement
  USING (EXISTS (SELECT 1 FROM cash_advance h
                  WHERE h.id = cash_advance_settlement.cash_advance_id
                    AND app_branch_allowed(h.branch_code)))
  WITH CHECK (EXISTS (SELECT 1 FROM cash_advance h
                       WHERE h.id = cash_advance_settlement.cash_advance_id
                         AND app_branch_allowed(h.branch_code)));
