CREATE TABLE "money_transfer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transfer_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"client_account_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"transfer_date" date NOT NULL,
	"requested_usd" numeric(19, 4) NOT NULL,
	"official_rate_id" uuid NOT NULL,
	"client_rate_id" uuid NOT NULL,
	"official_rate_iqd_per_usd" numeric(18, 8) DEFAULT '0' NOT NULL,
	"client_rate_iqd_per_usd" numeric(18, 8) DEFAULT '0' NOT NULL,
	"transfer_amount_iqd" numeric(19, 4) NOT NULL,
	"company_bank_account_id" uuid NOT NULL,
	"beneficiary_name" text NOT NULL,
	"beneficiary_bank" text,
	"beneficiary_account" text,
	"beneficiary_country" text,
	"bank_reference" text,
	"client_import_file_id" uuid,
	"logistics_job_ref" text,
	"journal_entry_id" uuid,
	"initiated_by" uuid,
	"initiated_at" timestamp with time zone,
	"sent_by" uuid,
	"sent_at" timestamp with time zone,
	"completed_by" uuid,
	"completed_at" timestamp with time zone,
	"returned_by" uuid,
	"returned_at" timestamp with time zone,
	"return_reason" text,
	"return_journal_entry_id" uuid,
	"refunded_by" uuid,
	"refunded_at" timestamp with time zone,
	"refund_amount_iqd" numeric(19, 4),
	"refund_journal_entry_id" uuid,
	"recognised_result_iqd" numeric(19, 4),
	"recognition_journal_entry_id" uuid,
	"recognised_by" uuid,
	"recognised_at" timestamp with time zone,
	"reversed_by" uuid,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	"replaced_by_transfer_id" uuid,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "money_transfer_requested_usd_positive" CHECK ("money_transfer"."requested_usd" > 0),
	CONSTRAINT "money_transfer_amount_positive" CHECK ("money_transfer"."transfer_amount_iqd" > 0),
	CONSTRAINT "money_transfer_beneficiary_present" CHECK (btrim("money_transfer"."beneficiary_name") <> ''),
	CONSTRAINT "money_transfer_rates_positive" CHECK ("money_transfer"."official_rate_iqd_per_usd" > 0 and "money_transfer"."client_rate_iqd_per_usd" > 0),
	CONSTRAINT "money_transfer_rates_distinct" CHECK ("money_transfer"."official_rate_id" <> "money_transfer"."client_rate_id"),
	CONSTRAINT "money_transfer_refund_positive" CHECK ("money_transfer"."refund_amount_iqd" is null or "money_transfer"."refund_amount_iqd" > 0),
	CONSTRAINT "money_transfer_return_has_reason" CHECK (("money_transfer"."returned_by" is null and "money_transfer"."returned_at" is null)
          or ("money_transfer"."returned_by" is not null and "money_transfer"."returned_at" is not null
              and coalesce(btrim("money_transfer"."return_reason"), '') <> '')),
	CONSTRAINT "money_transfer_reversal_has_reason" CHECK (("money_transfer"."reversed_by" is null and "money_transfer"."reversed_at" is null)
          or ("money_transfer"."reversed_by" is not null and "money_transfer"."reversed_at" is not null
              and coalesce(btrim("money_transfer"."reversal_reason"), '') <> '')),
	CONSTRAINT "money_transfer_recognition_complete" CHECK (("money_transfer"."recognised_result_iqd" is null and "money_transfer"."recognition_journal_entry_id" is null
           and "money_transfer"."recognised_by" is null and "money_transfer"."recognised_at" is null)
          or ("money_transfer"."recognised_result_iqd" is not null and "money_transfer"."recognised_by" is not null
              and "money_transfer"."recognised_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "money_transfer_deposit_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deposit_id" uuid NOT NULL,
	"money_transfer_id" uuid NOT NULL,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"applied_on" date NOT NULL,
	"reversed_by" uuid,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "money_transfer_deposit_usage_amount_positive" CHECK ("money_transfer_deposit_usage"."amount_iqd" > 0),
	CONSTRAINT "money_transfer_deposit_usage_reversal_has_reason" CHECK (("money_transfer_deposit_usage"."reversed_by" is null and "money_transfer_deposit_usage"."reversed_at" is null)
          or ("money_transfer_deposit_usage"."reversed_by" is not null and "money_transfer_deposit_usage"."reversed_at" is not null
              and coalesce(btrim("money_transfer_deposit_usage"."reversal_reason"), '') <> ''))
);
--> statement-breakpoint

ALTER TABLE "money_transfer" ADD CONSTRAINT "money_transfer_client_account_id_money_transfer_client_account_id_fk" FOREIGN KEY ("client_account_id") REFERENCES "public"."money_transfer_client_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer" ADD CONSTRAINT "money_transfer_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer" ADD CONSTRAINT "money_transfer_official_rate_id_exchange_rate_id_fk" FOREIGN KEY ("official_rate_id") REFERENCES "public"."exchange_rate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer" ADD CONSTRAINT "money_transfer_client_rate_id_exchange_rate_id_fk" FOREIGN KEY ("client_rate_id") REFERENCES "public"."exchange_rate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer" ADD CONSTRAINT "money_transfer_company_bank_account_id_bank_cash_account_id_fk" FOREIGN KEY ("company_bank_account_id") REFERENCES "public"."bank_cash_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer" ADD CONSTRAINT "money_transfer_client_import_file_id_client_import_file_id_fk" FOREIGN KEY ("client_import_file_id") REFERENCES "public"."client_import_file"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer" ADD CONSTRAINT "money_transfer_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer" ADD CONSTRAINT "money_transfer_initiated_by_app_user_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer" ADD CONSTRAINT "money_transfer_sent_by_app_user_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer" ADD CONSTRAINT "money_transfer_completed_by_app_user_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer" ADD CONSTRAINT "money_transfer_returned_by_app_user_id_fk" FOREIGN KEY ("returned_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer" ADD CONSTRAINT "money_transfer_return_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("return_journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer" ADD CONSTRAINT "money_transfer_refunded_by_app_user_id_fk" FOREIGN KEY ("refunded_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer" ADD CONSTRAINT "money_transfer_refund_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("refund_journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer" ADD CONSTRAINT "money_transfer_recognition_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("recognition_journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer" ADD CONSTRAINT "money_transfer_recognised_by_app_user_id_fk" FOREIGN KEY ("recognised_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer" ADD CONSTRAINT "money_transfer_reversed_by_app_user_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer" ADD CONSTRAINT "money_transfer_replaced_by_transfer_id_money_transfer_id_fk" FOREIGN KEY ("replaced_by_transfer_id") REFERENCES "public"."money_transfer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer" ADD CONSTRAINT "money_transfer_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer_deposit_usage" ADD CONSTRAINT "money_transfer_deposit_usage_deposit_id_money_transfer_deposit_id_fk" FOREIGN KEY ("deposit_id") REFERENCES "public"."money_transfer_deposit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer_deposit_usage" ADD CONSTRAINT "money_transfer_deposit_usage_money_transfer_id_money_transfer_id_fk" FOREIGN KEY ("money_transfer_id") REFERENCES "public"."money_transfer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer_deposit_usage" ADD CONSTRAINT "money_transfer_deposit_usage_reversed_by_app_user_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer_deposit_usage" ADD CONSTRAINT "money_transfer_deposit_usage_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "money_transfer_no_uniq" ON "money_transfer" USING btree ("transfer_no");--> statement-breakpoint
CREATE INDEX "money_transfer_account_idx" ON "money_transfer" USING btree ("client_account_id","status");--> statement-breakpoint
CREATE INDEX "money_transfer_date_idx" ON "money_transfer" USING btree ("transfer_date","branch_code");--> statement-breakpoint
CREATE INDEX "money_transfer_import_file_idx" ON "money_transfer" USING btree ("client_import_file_id");--> statement-breakpoint
CREATE INDEX "money_transfer_logistics_idx" ON "money_transfer" USING btree ("logistics_job_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "money_transfer_deposit_usage_pair_uniq" ON "money_transfer_deposit_usage" USING btree ("deposit_id","money_transfer_id") WHERE reversed_at is null;--> statement-breakpoint
CREATE INDEX "money_transfer_deposit_usage_transfer_idx" ON "money_transfer_deposit_usage" USING btree ("money_transfer_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 09.3 — the rates come from Finance, and the document copies them.
--
-- §14.3: "Rates are maintained only in the Finance Exchange Rate section."
-- 09.3 gate: "Rates cannot be edited on the transfer document itself."
--
-- The snapshot columns are overwritten from the two referenced `exchange_rate`
-- rows on every insert and every update, so whatever a caller supplies is
-- discarded. That is what makes the rule true rather than merely stated: there
-- is no value a user can put in those columns that survives the statement.
--
-- The types are checked too. §12.2 asks for "official exchange rate and client
-- exchange rate", and Phase 02 already publishes exactly those two kinds —
-- `accounting` ("the approved rate the ledger posts at") and `client` ("the rate
-- quoted to a customer (§12 money transfer pricing)"). Pointing the official
-- rate at a market quote would price the spread against a rate the ledger never
-- used.
-- ---------------------------------------------------------------------------
CREATE FUNCTION money_transfer_rate_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_official record;
  v_client   record;
BEGIN
  SELECT currency_code, rate_type, iqd_per_unit, effective_from, superseded_at
    INTO v_official FROM exchange_rate WHERE id = NEW.official_rate_id;
  SELECT currency_code, rate_type, iqd_per_unit, effective_from, superseded_at
    INTO v_client   FROM exchange_rate WHERE id = NEW.client_rate_id;

  IF v_official.rate_type <> 'accounting' THEN
    RAISE EXCEPTION
      'The official exchange rate must be an accounting rate, not ''%'' (§12.2, §4.3). The accounting rate is the approved rate the ledger posts at; pricing a spread against anything else measures it from a number the books never used.',
      v_official.rate_type USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_client.rate_type <> 'client' THEN
    RAISE EXCEPTION
      'The client exchange rate must be a client rate, not ''%'' (§12.2, §4.3). The client rate type exists for money transfer pricing.',
      v_client.rate_type USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_official.currency_code <> 'USD' OR v_client.currency_code <> 'USD' THEN
    RAISE EXCEPTION
      'Both rates must be IQD per USD (§12.2 — the transfer is priced from a requested USD equivalent). Received % and %.',
      v_official.currency_code, v_client.currency_code USING ERRCODE = 'restrict_violation';
  END IF;

  -- A superseded rate is a correction that has been replaced. Pricing a new
  -- transfer at one would quote a number Finance has already withdrawn.
  IF TG_OP = 'INSERT' AND (v_official.superseded_at IS NOT NULL OR v_client.superseded_at IS NOT NULL) THEN
    RAISE EXCEPTION
      'One of the rates has been superseded (§14.8). Quote the transfer at the rate now in force.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_official.effective_from > NEW.transfer_date OR v_client.effective_from > NEW.transfer_date THEN
    RAISE EXCEPTION
      'A rate effective after the transfer date of % cannot price it (§14.8). Rates apply from their effective date forward.',
      NEW.transfer_date USING ERRCODE = 'restrict_violation';
  END IF;

  -- Copied, never accepted. The document reproduces (§22) and cannot drift.
  NEW.official_rate_iqd_per_usd := v_official.iqd_per_unit;
  NEW.client_rate_iqd_per_usd   := v_client.iqd_per_unit;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER money_transfer_rate_snapshot
  BEFORE INSERT OR UPDATE ON money_transfer
  FOR EACH ROW EXECUTE FUNCTION money_transfer_rate_snapshot();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A transfer belongs to its client account's branch, and draws on that account.
-- ---------------------------------------------------------------------------
CREATE FUNCTION money_transfer_follows_client_account() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_branch text;
  v_no     text;
BEGIN
  SELECT branch_code, account_no INTO v_branch, v_no
    FROM money_transfer_client_account WHERE id = NEW.client_account_id;

  IF NEW.branch_code IS DISTINCT FROM v_branch THEN
    RAISE EXCEPTION
      'Transfer is on branch % but client account % belongs to branch % (§14.3). A transfer posts against the branch holding the client balance it consumes.',
      NEW.branch_code, v_no, v_branch USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER money_transfer_follows_client_account
  BEFORE INSERT ON money_transfer
  FOR EACH ROW EXECUTE FUNCTION money_transfer_follows_client_account();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 09.1 gate — "A transfer cannot be initiated for a client whose KYC is
-- incomplete."
--
-- §21 links KYC to the partner; Appendix E makes the controls risk-based; §26
-- gate 5 makes legal/compliance approval a go-live condition (D9, still open).
-- What "complete" *contains* is Compliance's to configure — the required
-- document catalogue is theirs and ships empty. What cannot wait for them is
-- that client money does not move without an approved, unexpired identification
-- on file, which is true of every reading of Appendix E.
--
-- Checked at the database, at the moment of initiation, because that is the
-- moment the money leaves — and because a service-only check would leave the
-- import and API paths open, which the 09.5 gate calls out by name.
-- ---------------------------------------------------------------------------
CREATE FUNCTION money_transfer_kyc_complete_to_initiate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_partner   uuid;
  v_code      text;
  v_kyc       uuid;
  v_expires   date;
  v_rating    text;
  v_missing   text;
BEGIN
  IF NEW.status <> 'posted' OR OLD.status = 'posted' THEN
    RETURN NEW;
  END IF;

  SELECT a.partner_id, p.code INTO v_partner, v_code
    FROM money_transfer_client_account a
    JOIN business_partner p ON p.id = a.partner_id
   WHERE a.id = NEW.client_account_id;

  SELECT id, expires_on, risk_rating_code INTO v_kyc, v_expires, v_rating
    FROM client_kyc_record
   WHERE partner_id = v_partner AND status = 'approved' AND superseded_at IS NULL
   LIMIT 1;

  IF v_kyc IS NULL THEN
    RAISE EXCEPTION
      'Client % has no approved KYC record, so transfer % cannot be initiated (§21, Appendix E). Money Transfer is a regulated service; identification is completed before client money moves.',
      v_code, NEW.transfer_no USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_expires IS NOT NULL AND v_expires < NEW.transfer_date THEN
    RAISE EXCEPTION
      'The KYC record for client % expired on % and the transfer is dated % (§21). Renew the identification before initiating.',
      v_code, v_expires, NEW.transfer_date USING ERRCODE = 'restrict_violation';
  END IF;

  -- The risk-based part: every active requirement that applies to this client's
  -- rating, plus every requirement that applies to all clients. A document
  -- present but expired counts as missing — expired evidence is not evidence.
  SELECT string_agg(d.code, ', ' ORDER BY d.code) INTO v_missing
    FROM kyc_required_document d
   WHERE d.active
     AND (d.risk_rating_code IS NULL OR d.risk_rating_code = v_rating)
     AND NOT EXISTS (
           SELECT 1 FROM client_kyc_document cd
            WHERE cd.kyc_record_id = v_kyc
              AND cd.required_document_code = d.code
              AND (cd.expires_on IS NULL OR cd.expires_on >= NEW.transfer_date));

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION
      'Client % is missing required KYC documents: % (§21, Appendix E). Transfer % cannot be initiated until they are on file.',
      v_code, v_missing, NEW.transfer_no USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER money_transfer_kyc_complete_to_initiate
  BEFORE UPDATE ON money_transfer
  FOR EACH ROW EXECUTE FUNCTION money_transfer_kyc_complete_to_initiate();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §12.3 and §12.7 acceptance 2 — the edit lock.
--
--   "After Initiate Transfer creates the transfer entry, the transaction is
--    locked. Correction requires full reversal and a new transaction."
--   "The system prevents editing after Initiate Transfer."
--
-- ── Why the whole row, and not a list of columns ────────────────────────────
-- A column list is a lock that has to be maintained: add a field in a later
-- phase, forget to add it to the list, and the lock silently develops a hole
-- that nobody will notice until an auditor does. Comparing `to_jsonb(NEW)` with
-- `to_jsonb(OLD)`, minus the lifecycle fields that must still move, inverts the
-- default — a new column is locked from the moment it exists, and the only way
-- to make one editable is to name it here deliberately.
--
-- `bank_reference` is on the lifecycle list because the bank supplies it after
-- execution, so freezing it would make §12.2's own required data unrecordable.
-- It is write-once, which is the narrowest form that stays workable.
-- ---------------------------------------------------------------------------
CREATE FUNCTION money_transfer_locked_after_initiation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_lifecycle text[] := ARRAY[
    'status', 'updated_at',
    'sent_by', 'sent_at', 'completed_by', 'completed_at',
    'returned_by', 'returned_at', 'return_reason', 'return_journal_entry_id',
    'refunded_by', 'refunded_at', 'refund_amount_iqd', 'refund_journal_entry_id',
    'recognised_result_iqd', 'recognition_journal_entry_id', 'recognised_by', 'recognised_at',
    'reversed_by', 'reversed_at', 'reversal_reason', 'replaced_by_transfer_id',
    'bank_reference'
  ];
BEGIN
  -- Editable while only deposit entries exist (§12.3): draft and Funded.
  IF OLD.status IN ('draft', 'approved') THEN
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - v_lifecycle) IS DISTINCT FROM (to_jsonb(OLD) - v_lifecycle) THEN
    RAISE EXCEPTION
      'Money transfer % is ''%''; Initiate Transfer has created the transfer entry, so the transaction is locked (§12.3, §12.7). Correction requires a full reversal and a new transaction — there is no partial edit path.',
      OLD.transfer_no, OLD.status USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.bank_reference IS NOT NULL AND NEW.bank_reference IS DISTINCT FROM OLD.bank_reference THEN
    RAISE EXCEPTION
      'Money transfer % already carries bank reference %; it is what the bank returned and it is not re-typed (§12.2, §12.3).',
      OLD.transfer_no, OLD.bank_reference USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER money_transfer_locked_after_initiation
  BEFORE UPDATE ON money_transfer
  FOR EACH ROW EXECUTE FUNCTION money_transfer_locked_after_initiation();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Funded means the client has confirmed; Sent means the bank has a reference;
-- Refunded means the client got everything back.
-- ---------------------------------------------------------------------------
CREATE FUNCTION money_transfer_stage_preconditions() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_account_status document_status;
  v_account_no     text;
  v_balance        numeric(19,4);
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  -- Funded (§12.3): the client has confirmed funding is complete and named the
  -- amount. Until they have, the instruction is a draft of an intention.
  IF NEW.status = 'approved' THEN
    SELECT status, account_no INTO v_account_status, v_account_no
      FROM money_transfer_client_account WHERE id = NEW.client_account_id;

    IF v_account_status <> 'approved' THEN
      RAISE EXCEPTION
        'Client account % has not confirmed that funding is complete, so transfer % cannot be funded (§12.3).',
        v_account_no, NEW.transfer_no USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  -- Sent: §12.2 requires the bank reference, and this is the moment it exists.
  IF NEW.status = 'executed' AND coalesce(btrim(NEW.bank_reference), '') = '' THEN
    RAISE EXCEPTION
      'Transfer % cannot be marked Sent without the bank reference (§12.2). It is the only evidence tying the instruction to the bank movement.',
      NEW.transfer_no USING ERRCODE = 'restrict_violation';
  END IF;

  -- Refunded (§12.6): "The client receives a full refund. The company absorbs
  -- all bank charges." The refund is therefore the client's whole remaining
  -- clearing balance — deducting charges from it would charge the client for a
  -- transfer that never arrived.
  IF NEW.status = 'closed' THEN
    IF NEW.refund_amount_iqd IS NULL THEN
      RAISE EXCEPTION
        'Transfer % cannot be marked Refunded without the refund amount (§12.6).',
        NEW.transfer_no USING ERRCODE = 'restrict_violation';
    END IF;

    SELECT coalesce(sum(d.amount_iqd - d.used_amount_iqd - d.refunded_amount_iqd), 0)
      INTO v_balance
      FROM money_transfer_deposit d
     WHERE d.client_account_id = NEW.client_account_id
       AND d.status IN ('posted', 'partially_executed', 'settled');

    IF NEW.refund_amount_iqd <> v_balance THEN
      RAISE EXCEPTION
        'Transfer % was returned, so the client receives a full refund of % — not % (§12.6). The company absorbs all bank charges; deducting them from the refund would charge the client for a transfer that never arrived.',
        NEW.transfer_no, v_balance, NEW.refund_amount_iqd USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER money_transfer_stage_preconditions
  BEFORE UPDATE ON money_transfer
  FOR EACH ROW EXECUTE FUNCTION money_transfer_stage_preconditions();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A transfer draws only on its own client's posted deposits.
--
-- This is the client-fund segregation Appendix E exists to protect: money in the
-- clearing account belongs to the client who deposited it, and one client's
-- transfer must not be funded out of another's balance. Checked here because a
-- foreign key can say the deposit exists but not that it is the right client's.
-- ---------------------------------------------------------------------------
CREATE FUNCTION money_transfer_deposit_usage_same_client() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_deposit_account uuid;
  v_deposit_status  document_status;
  v_deposit_no      text;
  v_transfer_account uuid;
  v_transfer_no     text;
BEGIN
  SELECT client_account_id, status, deposit_no
    INTO v_deposit_account, v_deposit_status, v_deposit_no
    FROM money_transfer_deposit WHERE id = NEW.deposit_id;

  SELECT client_account_id, transfer_no INTO v_transfer_account, v_transfer_no
    FROM money_transfer WHERE id = NEW.money_transfer_id;

  IF v_deposit_account IS DISTINCT FROM v_transfer_account THEN
    RAISE EXCEPTION
      'Deposit % belongs to a different client account from transfer % (§12.3, Appendix E). A transfer draws only on the deposits its own client made; funding it from another client''s balance is the failure client-fund segregation exists to prevent.',
      v_deposit_no, v_transfer_no USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_deposit_status NOT IN ('posted', 'partially_executed') THEN
    RAISE EXCEPTION
      'Deposit % is ''%''; only money that has actually reached the bank can fund a transfer (§12.4).',
      v_deposit_no, v_deposit_status USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER money_transfer_deposit_usage_same_client
  BEFORE INSERT ON money_transfer_deposit_usage
  FOR EACH ROW EXECUTE FUNCTION money_transfer_deposit_usage_same_client();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 09.2 gate — "the client clearing balance equals the sum of deposits less usage
-- at all times".
--
-- The deposit's used total is recomputed from its live usage rows rather than
-- incremented, so it cannot drift and a reversal restores it exactly. The
-- `money_transfer_deposit_not_over_used` CHECK then refuses any allocation that
-- would take a deposit past its own amount — the over-consumption guard is the
-- database's, not the service's.
-- ---------------------------------------------------------------------------
CREATE FUNCTION money_transfer_deposit_usage_retotal() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_deposit uuid := coalesce(NEW.deposit_id, OLD.deposit_id);
BEGIN
  UPDATE money_transfer_deposit d
     SET used_amount_iqd = (
           SELECT coalesce(sum(u.amount_iqd), 0)
             FROM money_transfer_deposit_usage u
            WHERE u.deposit_id = d.id AND u.reversed_at IS NULL),
         updated_at = now()
   WHERE d.id = v_deposit;

  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER money_transfer_deposit_usage_retotal
  AFTER INSERT OR UPDATE OR DELETE ON money_transfer_deposit_usage
  FOR EACH ROW EXECUTE FUNCTION money_transfer_deposit_usage_retotal();--> statement-breakpoint

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('MONEY_TRANSFER', 'MTR', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('money_transfer', 'Money Transfer', 'money_transfer',
   'The §12.2 transfer instruction. Posts Dr Client Clearing / Cr Company Bank Account at Initiate Transfer, after which the transaction is locked (§12.3).');--> statement-breakpoint

-- Appendix B: Draft, Funded, Initiated, Sent, Completed, Returned, Refunded,
-- Reversed. §12.6's lifecycle is Initiated -> Sent -> Returned -> Refunded,
-- which is why Returned is reachable only from Sent.
INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('money_transfer', 'draft',    'approved'),
  ('money_transfer', 'approved', 'draft'),
  ('money_transfer', 'approved', 'posted'),
  ('money_transfer', 'draft',    'cancelled'),
  ('money_transfer', 'approved', 'cancelled'),
  ('money_transfer', 'posted',   'executed'),
  ('money_transfer', 'executed', 'settled'),
  ('money_transfer', 'executed', 'rejected'),
  ('money_transfer', 'rejected', 'closed'),
  ('money_transfer', 'posted',   'reversed'),
  ('money_transfer', 'executed', 'reversed'),
  ('money_transfer', 'settled',  'reversed'),
  ('money_transfer', 'rejected', 'reversed'),
  ('money_transfer', 'closed',   'reversed');--> statement-breakpoint

-- §24 — the fields frozen once the instruction leaves draft. The trigger above
-- freezes everything from initiation; this is the earlier, narrower freeze the
-- controlled-field framework applies from submission.
INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('money_transfer', 'client_account_id',
   'Decides whose deposits fund the transfer.'),
  ('money_transfer', 'requested_usd',
   'The priced quantity (§12.2). Changing it changes the spread the client agreed.'),
  ('money_transfer', 'official_rate_id',
   'The approved rate the ledger posts at (§12.2).'),
  ('money_transfer', 'client_rate_id',
   'The rate quoted to the client (§12.2).'),
  ('money_transfer', 'transfer_amount_iqd',
   'The ledger amount (§1.1). Corrected by reversal and a new transaction (§12.3).'),
  ('money_transfer', 'company_bank_account_id',
   'Decides which company bank account is credited (§12.4).'),
  ('money_transfer', 'beneficiary_name',
   'Who the money goes to. The single most consequential field on the document.'),
  ('money_transfer', 'transfer_date',
   'Decides the accounting period and which rates are in force.'),
  ('money_transfer', 'branch_code',
   'A transfer posts to one branch (§14.3).')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'money_transfer', 'view'),
  ('accounting_officer', 'money_transfer', 'create'),
  ('accounting_officer', 'money_transfer', 'edit_draft'),
  ('accounting_officer', 'money_transfer', 'submit'),
  ('accounting_officer', 'money_transfer', 'print'),
  ('accounting_manager', 'money_transfer', 'view'),
  ('accounting_manager', 'money_transfer', 'create'),
  ('accounting_manager', 'money_transfer', 'edit_draft'),
  ('accounting_manager', 'money_transfer', 'submit'),
  ('accounting_manager', 'money_transfer', 'approve'),
  ('accounting_manager', 'money_transfer', 'post'),
  ('accounting_manager', 'money_transfer', 'execute'),
  ('accounting_manager', 'money_transfer', 'reverse_cancel'),
  ('accounting_manager', 'money_transfer', 'print'),
  ('accounting_manager', 'money_transfer', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON money_transfer, money_transfer_deposit_usage FROM erp_app;

  -- No DELETE on either. §12.3 corrects a transfer by reversal and a new
  -- transaction; a deletable transfer would make that sentence optional. The
  -- usage rows are the record of which client money went where — reversed, never
  -- removed.
  GRANT SELECT, INSERT, UPDATE ON money_transfer TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON money_transfer_deposit_usage TO erp_app;
END;
$$;--> statement-breakpoint

ALTER TABLE money_transfer ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE money_transfer FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY money_transfer_branch_scope ON money_transfer
  USING (app_is_super_user() OR branch_code = app_current_branch())
  WITH CHECK (app_is_super_user() OR branch_code = app_current_branch());--> statement-breakpoint

ALTER TABLE money_transfer_deposit_usage ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE money_transfer_deposit_usage FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

-- The usage row has no branch of its own — it is an allocation between two rows
-- that do, and both are always the same branch (the triggers above see to that).
-- Scoping it through the transfer keeps the §22 guarantee without denormalising
-- a branch code that could then disagree with the two it was copied from.
CREATE POLICY money_transfer_deposit_usage_branch_scope ON money_transfer_deposit_usage
  USING (app_is_super_user() OR EXISTS (
    SELECT 1 FROM money_transfer t
     WHERE t.id = money_transfer_deposit_usage.money_transfer_id
       AND t.branch_code = app_current_branch()))
  WITH CHECK (app_is_super_user() OR EXISTS (
    SELECT 1 FROM money_transfer t
     WHERE t.id = money_transfer_deposit_usage.money_transfer_id
       AND t.branch_code = app_current_branch()));
