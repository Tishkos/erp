CREATE TABLE "logistics_client_charge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"charge_type" text NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"currency_code" text NOT NULL,
	"settlement_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "logistics_client_charge_amount_positive" CHECK ("logistics_client_charge"."amount" > 0),
	CONSTRAINT "logistics_client_charge_type" CHECK ("logistics_client_charge"."charge_type" in ('freight', 'customs', 'handling', 'documentation', 'storage', 'other'))
);
--> statement-breakpoint
CREATE TABLE "logistics_client_funding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"funding_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"job_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"funding_date" date NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"currency_code" text NOT NULL,
	"received_via" text NOT NULL,
	"bank_cash_account_id" uuid,
	"clearing_role" text,
	"journal_entry_id" uuid,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "logistics_client_funding_amount_positive" CHECK ("logistics_client_funding"."amount" > 0),
	CONSTRAINT "logistics_client_funding_received_via" CHECK ("logistics_client_funding"."received_via" in ('bank', 'cash', 'client_account')),
	CONSTRAINT "logistics_client_funding_account_matches_method" CHECK (("logistics_client_funding"."received_via" in ('bank', 'cash') and "logistics_client_funding"."bank_cash_account_id" is not null)
          or ("logistics_client_funding"."received_via" = 'client_account' and "logistics_client_funding"."bank_cash_account_id" is null)),
	CONSTRAINT "logistics_client_funding_posted_complete" CHECK (("logistics_client_funding"."posted_by" is null and "logistics_client_funding"."posted_at" is null and "logistics_client_funding"."journal_entry_id" is null
           and "logistics_client_funding"."clearing_role" is null)
          or ("logistics_client_funding"."posted_by" is not null and "logistics_client_funding"."posted_at" is not null
              and "logistics_client_funding"."journal_entry_id" is not null and "logistics_client_funding"."clearing_role" is not null))
);
--> statement-breakpoint
ALTER TABLE "logistics_client_charge" ADD CONSTRAINT "logistics_client_charge_job_id_logistics_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."logistics_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_client_charge" ADD CONSTRAINT "logistics_client_charge_currency_code_currency_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currency"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_client_charge" ADD CONSTRAINT "logistics_client_charge_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_client_funding" ADD CONSTRAINT "logistics_client_funding_job_id_logistics_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."logistics_job"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_client_funding" ADD CONSTRAINT "logistics_client_funding_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_client_funding" ADD CONSTRAINT "logistics_client_funding_currency_code_currency_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currency"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_client_funding" ADD CONSTRAINT "logistics_client_funding_bank_cash_account_id_bank_cash_account_id_fk" FOREIGN KEY ("bank_cash_account_id") REFERENCES "public"."bank_cash_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_client_funding" ADD CONSTRAINT "logistics_client_funding_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_client_funding" ADD CONSTRAINT "logistics_client_funding_posted_by_app_user_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logistics_client_funding" ADD CONSTRAINT "logistics_client_funding_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "logistics_client_charge_line_uniq" ON "logistics_client_charge" USING btree ("job_id","line_no");--> statement-breakpoint
CREATE INDEX "logistics_client_charge_settlement_idx" ON "logistics_client_charge" USING btree ("settlement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "logistics_client_funding_no_uniq" ON "logistics_client_funding" USING btree ("funding_no");--> statement-breakpoint
CREATE INDEX "logistics_client_funding_job_idx" ON "logistics_client_funding" USING btree ("job_id","status");--> statement-breakpoint
CREATE INDEX "logistics_client_funding_branch_idx" ON "logistics_client_funding" USING btree ("branch_code","funding_date");--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE. Everything above is generated.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Phase 10.4 — client charges and funding, §11.3 and §11.4.
--
-- §11.3: "Logistics charges paid by the client are added to the client account
-- from the Logistics module."
-- §11.4: Client logistics funding or charge | Bank, Cash or Client Account |
--        Client Logistics Clearing / Deferred Service Balance according to
--        document stage.
--
-- Two tables because they are two different facts. A *charge* is what the client
-- agreed to pay; a *funding* is money that actually arrived. Holding them in one
-- table would make "what does this client owe?" ambiguous the first time a job
-- was charged 100 and funded 60, and §11.5 asks for Job Revenue and Client
-- Balances as separate reports precisely because they are separate questions.
--
-- A charge posts nothing on its own. §11.4's third row recognises revenue on
-- *service completion*, so a charge agreed in week one is an agreement, not
-- revenue — it reaches the ledger at settlement (migration 0146) and nowhere
-- else.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Charges and funding are in the job's currency.
--
-- §14.5 allows multi-currency, but a job's margin is a subtraction: mixing
-- currencies inside one job would make "service charge minus direct cost" a sum
-- over incomparable numbers unless every report re-converted at some rate it
-- chose for itself. Costs may be incurred in any currency and are converted by
-- the posting engine; what the *client* is charged and pays is one currency,
-- fixed on the job when it leaves draft.
-- ---------------------------------------------------------------------------
CREATE FUNCTION logistics_client_amount_matches_job_currency() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_currency text;
  v_no       text;
  v_status   document_status;
BEGIN
  SELECT currency_code, job_no, status INTO v_currency, v_no, v_status
    FROM logistics_job WHERE id = NEW.job_id;

  IF NEW.currency_code IS DISTINCT FROM v_currency THEN
    RAISE EXCEPTION
      'Job % is charged in %, so this row cannot be in % (blueprint 11.3). Job margin is a subtraction; it needs one currency on the client side.',
      v_no, v_currency, NEW.currency_code
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_status IN ('settled', 'closed', 'cancelled') THEN
    RAISE EXCEPTION
      'Job % is %; nothing further can be charged to or funded by the client (blueprint 11.2). The settlement has already fixed what was billed.',
      v_no, v_status
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER logistics_client_charge_currency
  BEFORE INSERT ON logistics_client_charge
  FOR EACH ROW EXECUTE FUNCTION logistics_client_amount_matches_job_currency();--> statement-breakpoint

CREATE TRIGGER logistics_client_funding_currency
  BEFORE INSERT ON logistics_client_funding
  FOR EACH ROW EXECUTE FUNCTION logistics_client_amount_matches_job_currency();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A billed charge is history.
--
-- Once a settlement has carried a charge into revenue, the charge is what the
-- G/L was told. Editing the amount afterwards would move the job margin away
-- from the posted journal, and 10.8's gate — "job margin reconciles to the G/L" —
-- would be false with nothing to show for it.
--
-- The `settlement_id` column itself is the exception: it is written as the
-- settlement posts, which is the moment this rule starts to apply.
-- ---------------------------------------------------------------------------
CREATE FUNCTION logistics_client_charge_billed_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.settlement_id IS NOT NULL THEN
      RAISE EXCEPTION
        'Charge line % has been billed on a settlement; it is part of the revenue already posted (blueprint 11.4). Reverse the settlement instead.',
        OLD.line_no USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.settlement_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.amount        IS DISTINCT FROM OLD.amount
  OR NEW.charge_type   IS DISTINCT FROM OLD.charge_type
  OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
  OR NEW.job_id        IS DISTINCT FROM OLD.job_id THEN
    RAISE EXCEPTION
      'Charge line % has been billed; what the client was charged cannot be edited afterwards (blueprint 3.2). Reverse the settlement and re-bill.',
      OLD.line_no USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER logistics_client_charge_billed_is_final
  BEFORE UPDATE OR DELETE ON logistics_client_charge
  FOR EACH ROW EXECUTE FUNCTION logistics_client_charge_billed_is_final();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Posted funding is history.
--
-- §3.2: a document that has moved the bank and the ledger is corrected by
-- reversal, never by editing.
-- ---------------------------------------------------------------------------
CREATE FUNCTION logistics_client_funding_posted_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'posted' THEN
    RETURN NEW;
  END IF;

  IF NEW.amount             IS DISTINCT FROM OLD.amount
  OR NEW.currency_code      IS DISTINCT FROM OLD.currency_code
  OR NEW.job_id             IS DISTINCT FROM OLD.job_id
  OR NEW.funding_date       IS DISTINCT FROM OLD.funding_date
  OR NEW.received_via       IS DISTINCT FROM OLD.received_via
  OR NEW.bank_cash_account_id IS DISTINCT FROM OLD.bank_cash_account_id
  OR NEW.clearing_role      IS DISTINCT FROM OLD.clearing_role
  OR NEW.journal_entry_id   IS DISTINCT FROM OLD.journal_entry_id
  OR NEW.branch_code        IS DISTINCT FROM OLD.branch_code
  OR NEW.funding_no         IS DISTINCT FROM OLD.funding_no THEN
    RAISE EXCEPTION
      'Client funding % has posted; the bank moved and the ledger recorded it (blueprint 3.2). Reverse it and record the correction.',
      OLD.funding_no USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER logistics_client_funding_posted_is_final
  BEFORE UPDATE ON logistics_client_funding
  FOR EACH ROW EXECUTE FUNCTION logistics_client_funding_posted_is_final();--> statement-breakpoint

-- Numbering, document types, statuses and permissions.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('LOGISTICS_CLIENT_FUNDING', 'LCF', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('logistics_client_charge', 'Logistics Client Charge', 'logistics',
   'What the client agreed to pay for the service. Posts nothing on its own: section 11.4 recognises revenue on service completion, at the settlement.'),
  ('logistics_client_funding', 'Logistics Client Funding', 'logistics',
   'Money received from the client against a job. Dr Bank, Cash or Client Account / Cr the clearing role configured for the job''s stage (section 11.4).');--> statement-breakpoint

-- Appendix B has no row for this document — §11.1 lists "Client Deposits" under
-- Logistics but Appendix B's catalogue covers the Money Transfer deposit only.
-- So it gets the shortest lifecycle that §3.2 allows for something that posts:
-- drafted, posted, and reversed when wrong. Nothing is invented beyond that.
INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('logistics_client_funding', 'draft',  'posted'),
  ('logistics_client_funding', 'draft',  'cancelled'),
  ('logistics_client_funding', 'posted', 'reversed');--> statement-breakpoint

INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('logistics_client_funding', 'job_id',
   'Decides whose job the money funds, and therefore which client balance it clears.'),
  ('logistics_client_funding', 'amount',
   'The figure the settlement measures the funded balance against (section 11.4).'),
  ('logistics_client_funding', 'received_via',
   'Decides the debit side: Bank, Cash or the client''s own account.'),
  ('logistics_client_funding', 'funding_date',
   'Decides the accounting period the receipt lands in.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'logistics_client_charge', 'view'),
  ('accounting_officer', 'logistics_client_charge', 'create'),
  ('accounting_officer', 'logistics_client_charge', 'edit_draft'),
  ('accounting_officer', 'logistics_client_funding', 'view'),
  ('accounting_officer', 'logistics_client_funding', 'create'),
  ('accounting_officer', 'logistics_client_funding', 'edit_draft'),
  ('accounting_officer', 'logistics_client_funding', 'submit'),
  ('accounting_manager', 'logistics_client_charge', 'view'),
  ('accounting_manager', 'logistics_client_charge', 'create'),
  ('accounting_manager', 'logistics_client_charge', 'edit_draft'),
  ('accounting_manager', 'logistics_client_charge', 'export'),
  ('accounting_manager', 'logistics_client_funding', 'view'),
  ('accounting_manager', 'logistics_client_funding', 'create'),
  ('accounting_manager', 'logistics_client_funding', 'edit_draft'),
  ('accounting_manager', 'logistics_client_funding', 'submit'),
  ('accounting_manager', 'logistics_client_funding', 'approve'),
  ('accounting_manager', 'logistics_client_funding', 'post'),
  ('accounting_manager', 'logistics_client_funding', 'reverse_cancel'),
  -- §11.4's stage mapping is configuration under §5.5's review, so it is the
  -- `configure` verb rather than `edit_draft`: changing it changes the
  -- accounting of every funding posted afterwards.
  ('accounting_manager', 'logistics_client_funding', 'configure'),
  ('accounting_manager', 'logistics_client_funding', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON logistics_client_charge, logistics_client_funding FROM erp_app;

  -- Charge lines are removable while unbilled — the trigger above scopes it.
  GRANT SELECT, INSERT, UPDATE, DELETE ON logistics_client_charge TO erp_app;
  -- Funding is a document: §1.1 keeps it, so no DELETE.
  GRANT SELECT, INSERT, UPDATE ON logistics_client_funding TO erp_app;
END;
$$;--> statement-breakpoint

ALTER TABLE logistics_client_funding ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE logistics_client_funding FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY logistics_client_funding_branch_scope ON logistics_client_funding
  USING (app_is_super_user() OR branch_code = app_current_branch())
  WITH CHECK (app_is_super_user() OR branch_code = app_current_branch());--> statement-breakpoint

ALTER TABLE logistics_client_charge ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE logistics_client_charge FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY logistics_client_charge_branch_scope ON logistics_client_charge
  USING (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM logistics_job j
       WHERE j.id = logistics_client_charge.job_id AND j.branch_code = app_current_branch()
    )
  )
  WITH CHECK (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM logistics_job j
       WHERE j.id = logistics_client_charge.job_id AND j.branch_code = app_current_branch()
    )
  );
