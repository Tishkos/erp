CREATE TABLE "kyc_risk_rating" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"severity" numeric(5, 0) DEFAULT '0' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "kyc_risk_rating_code_present" CHECK (btrim("kyc_risk_rating"."code") <> '')
);
--> statement-breakpoint
CREATE TABLE "kyc_required_document" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"risk_rating_code" text,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "kyc_required_document_code_present" CHECK (btrim("kyc_required_document"."code") <> '')
);
--> statement-breakpoint
CREATE TABLE "client_kyc_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"risk_rating_code" text,
	"expires_on" date,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"rejection_reason" text,
	"superseded_at" timestamp with time zone,
	"superseded_by" uuid,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_kyc_record_approval_complete" CHECK (("client_kyc_record"."approved_at" is null and "client_kyc_record"."approved_by" is null)
          or ("client_kyc_record"."approved_at" is not null and "client_kyc_record"."approved_by" is not null)),
	CONSTRAINT "client_kyc_record_rejection_has_reason" CHECK ("client_kyc_record"."status" <> 'rejected' or coalesce(btrim("client_kyc_record"."rejection_reason"), '') <> ''),
	CONSTRAINT "client_kyc_record_approved_not_rejected" CHECK ("client_kyc_record"."status" <> 'approved' or "client_kyc_record"."rejection_reason" is null)
);
--> statement-breakpoint
CREATE TABLE "client_kyc_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kyc_record_id" uuid NOT NULL,
	"required_document_code" text NOT NULL,
	"attachment_id" uuid NOT NULL,
	"provided_on" date NOT NULL,
	"expires_on" date,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_kyc_document_expiry_after_provision" CHECK ("client_kyc_document"."expires_on" is null or "client_kyc_document"."expires_on" >= "client_kyc_document"."provided_on")
);
--> statement-breakpoint
CREATE TABLE "money_transfer_client_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_no" text NOT NULL,
	"partner_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"opened_on" date NOT NULL,
	"funding_confirmed_at" timestamp with time zone,
	"funding_confirmed_by" uuid,
	"confirmed_transfer_amount_iqd" numeric(19, 4),
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "money_transfer_client_account_confirmation_complete" CHECK (("money_transfer_client_account"."funding_confirmed_at" is null and "money_transfer_client_account"."funding_confirmed_by" is null
           and "money_transfer_client_account"."confirmed_transfer_amount_iqd" is null)
          or ("money_transfer_client_account"."funding_confirmed_at" is not null and "money_transfer_client_account"."funding_confirmed_by" is not null
              and "money_transfer_client_account"."confirmed_transfer_amount_iqd" is not null
              and "money_transfer_client_account"."confirmed_transfer_amount_iqd" > 0)),
	CONSTRAINT "money_transfer_client_account_close_needs_confirmation" CHECK ("money_transfer_client_account"."status" <> 'closed' or "money_transfer_client_account"."funding_confirmed_at" is not null),
	CONSTRAINT "money_transfer_client_account_closed_complete" CHECK (("money_transfer_client_account"."closed_at" is null and "money_transfer_client_account"."closed_by" is null)
          or ("money_transfer_client_account"."closed_at" is not null and "money_transfer_client_account"."closed_by" is not null))
);
--> statement-breakpoint

ALTER TABLE "kyc_required_document" ADD CONSTRAINT "kyc_required_document_risk_rating_code_kyc_risk_rating_code_fk" FOREIGN KEY ("risk_rating_code") REFERENCES "public"."kyc_risk_rating"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_kyc_record" ADD CONSTRAINT "client_kyc_record_partner_id_business_partner_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_kyc_record" ADD CONSTRAINT "client_kyc_record_risk_rating_code_kyc_risk_rating_code_fk" FOREIGN KEY ("risk_rating_code") REFERENCES "public"."kyc_risk_rating"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_kyc_record" ADD CONSTRAINT "client_kyc_record_reviewed_by_app_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_kyc_record" ADD CONSTRAINT "client_kyc_record_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_kyc_record" ADD CONSTRAINT "client_kyc_record_superseded_by_client_kyc_record_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."client_kyc_record"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_kyc_record" ADD CONSTRAINT "client_kyc_record_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_kyc_document" ADD CONSTRAINT "client_kyc_document_kyc_record_id_client_kyc_record_id_fk" FOREIGN KEY ("kyc_record_id") REFERENCES "public"."client_kyc_record"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_kyc_document" ADD CONSTRAINT "client_kyc_document_required_document_code_kyc_required_document_code_fk" FOREIGN KEY ("required_document_code") REFERENCES "public"."kyc_required_document"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_kyc_document" ADD CONSTRAINT "client_kyc_document_attachment_id_attachment_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_kyc_document" ADD CONSTRAINT "client_kyc_document_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer_client_account" ADD CONSTRAINT "money_transfer_client_account_partner_id_business_partner_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer_client_account" ADD CONSTRAINT "money_transfer_client_account_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer_client_account" ADD CONSTRAINT "money_transfer_client_account_funding_confirmed_by_app_user_id_fk" FOREIGN KEY ("funding_confirmed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer_client_account" ADD CONSTRAINT "money_transfer_client_account_closed_by_app_user_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "money_transfer_client_account" ADD CONSTRAINT "money_transfer_client_account_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "kyc_required_document_rating_idx" ON "kyc_required_document" USING btree ("risk_rating_code");--> statement-breakpoint
CREATE UNIQUE INDEX "client_kyc_record_current_uniq" ON "client_kyc_record" USING btree ("partner_id") WHERE status = 'approved' and superseded_at is null;--> statement-breakpoint
CREATE INDEX "client_kyc_record_partner_idx" ON "client_kyc_record" USING btree ("partner_id","status");--> statement-breakpoint
CREATE INDEX "client_kyc_record_expiry_idx" ON "client_kyc_record" USING btree ("expires_on") WHERE status = 'approved';--> statement-breakpoint
CREATE UNIQUE INDEX "client_kyc_document_requirement_uniq" ON "client_kyc_document" USING btree ("kyc_record_id","required_document_code");--> statement-breakpoint
CREATE INDEX "client_kyc_document_attachment_idx" ON "client_kyc_document" USING btree ("attachment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "money_transfer_client_account_no_uniq" ON "money_transfer_client_account" USING btree ("account_no");--> statement-breakpoint
CREATE INDEX "money_transfer_client_account_partner_idx" ON "money_transfer_client_account" USING btree ("partner_id","status");--> statement-breakpoint
CREATE INDEX "money_transfer_client_account_branch_idx" ON "money_transfer_client_account" USING btree ("branch_code","opened_on");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The risk catalogue and the required-document catalogue are seeded EMPTY.
--
-- Appendix E cites the FATF MVTS guidance and §26 gate 5 makes legal/compliance
-- approval a go-live condition — the register carries it as D9, and it is still
-- open. Which documents a money transfer client must produce, and what a risk
-- band obliges, are compliance decisions (§28.1). Seeding a plausible-looking
-- set would put a control regime nobody approved into production, and it would
-- look approved because it was there.
--
-- The consequence is deliberate and visible: with no required documents
-- configured, KYC completeness reduces to "an approved, unexpired record".
-- Compliance tightens it by INSERTing rows, with no code change.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- A money transfer client is a Business Partner in the customer role.
--
-- §6: "one record serves CRM, Sales, Finance, Projects, Logistics and Money
-- Transfer." The client buys a service from the company, so the customer role is
-- the one they hold. Checked here rather than in the service because the whole
-- point of the 09.1 gate is that no module-local client record exists — and a
-- rule that only the service enforces is one an import path can walk around.
-- ---------------------------------------------------------------------------
CREATE FUNCTION money_transfer_client_is_partner_customer() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_is_customer boolean;
  v_code        text;
  v_active      boolean;
BEGIN
  SELECT is_customer, code, active INTO v_is_customer, v_code, v_active
    FROM business_partner WHERE id = NEW.partner_id;

  IF NOT v_is_customer THEN
    RAISE EXCEPTION
      'Business partner % does not hold the customer role, so no money transfer client account can be opened for them (§6, §12.2). One partner record serves every module; give them the role rather than making a second record.',
      v_code USING ERRCODE = 'restrict_violation';
  END IF;

  IF NOT v_active THEN
    RAISE EXCEPTION
      'Business partner % is inactive (§4.4). A client account cannot be opened against a partner the company has stopped dealing with.',
      v_code USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER money_transfer_client_is_partner_customer
  BEFORE INSERT OR UPDATE OF partner_id ON money_transfer_client_account
  FOR EACH ROW EXECUTE FUNCTION money_transfer_client_is_partner_customer();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A closed client account is history.
--
-- §1.1 keeps saved documents; §12.3 makes closing the end of the funding cycle.
-- Re-opening one would let deposits arrive against a cycle whose balance has
-- already been settled and reported.
-- ---------------------------------------------------------------------------
CREATE FUNCTION money_transfer_client_account_closed_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'closed' THEN
    RETURN NEW;
  END IF;

  IF to_jsonb(NEW) - ARRAY['updated_at', 'note'] IS DISTINCT FROM to_jsonb(OLD) - ARRAY['updated_at', 'note'] THEN
    RAISE EXCEPTION
      'Client account % is closed; its funding cycle is finished and reported (§12.3). Open a new account for a new transfer.',
      OLD.account_no USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER money_transfer_client_account_closed_is_final
  BEFORE UPDATE ON money_transfer_client_account
  FOR EACH ROW EXECUTE FUNCTION money_transfer_client_account_closed_is_final();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- An approved KYC record is the evidence a regulated transfer rested on.
--
-- Appendix E and §21: it is renewed by superseding, never by editing, because
-- "was this client identified when that transfer went out?" has to stay
-- answerable after the renewal. Superseding is the one field that may change.
-- ---------------------------------------------------------------------------
CREATE FUNCTION client_kyc_record_approved_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_allowed text[] := ARRAY['superseded_at', 'superseded_by', 'updated_at'];
BEGIN
  IF OLD.status <> 'approved' THEN
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - v_allowed) IS DISTINCT FROM (to_jsonb(OLD) - v_allowed) THEN
    RAISE EXCEPTION
      'KYC record % is approved; it is the identification a regulated transfer relied on (§21, Appendix E). Supersede it with a renewal rather than editing what was checked.',
      OLD.id USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER client_kyc_record_approved_is_final
  BEFORE UPDATE ON client_kyc_record
  FOR EACH ROW EXECUTE FUNCTION client_kyc_record_approved_is_final();--> statement-breakpoint

-- A document produced against an approved record is equally fixed: it is what
-- was inspected. A replacement is a new row on a new record.
CREATE FUNCTION client_kyc_document_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status document_status;
BEGIN
  SELECT status INTO v_status
    FROM client_kyc_record WHERE id = coalesce(NEW.kyc_record_id, OLD.kyc_record_id);

  IF v_status <> 'approved' THEN
    RETURN coalesce(NEW, OLD);
  END IF;

  RAISE EXCEPTION
    'KYC record % is approved; the documents attached to it are what was inspected (§21). Raise a renewal record to change them.',
    coalesce(NEW.kyc_record_id, OLD.kyc_record_id) USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint

CREATE TRIGGER client_kyc_document_is_append_only
  BEFORE UPDATE OR DELETE ON client_kyc_document
  FOR EACH ROW EXECUTE FUNCTION client_kyc_document_is_append_only();--> statement-breakpoint

-- Numbering, document types, statuses and permissions.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('MT_CLIENT_ACCOUNT', 'MTC', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('money_transfer_client_account', 'Money Transfer Client Account', 'money_transfer',
   'One client funding cycle (§12.3). Holds the deposits and the confirmed transfer amount; carries no client details of its own — those live on the Business Partner (§6).'),
  ('client_kyc_record', 'Client KYC Record', 'money_transfer',
   'Identification and compliance evidence for a Business Partner (§21, Appendix E). Renewed by superseding, never by editing.');--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('money_transfer_client_account', 'draft',    'approved'),
  ('money_transfer_client_account', 'approved', 'closed'),
  ('money_transfer_client_account', 'draft',    'cancelled'),
  ('client_kyc_record', 'draft',     'submitted'),
  ('client_kyc_record', 'submitted', 'approved'),
  ('client_kyc_record', 'submitted', 'rejected'),
  ('client_kyc_record', 'submitted', 'draft'),
  ('client_kyc_record', 'rejected',  'draft');--> statement-breakpoint

-- §24 — fields frozen once the document leaves draft.
INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('money_transfer_client_account', 'partner_id',
   'Decides whose money the account holds. Changing it would move one client''s deposits to another.'),
  ('money_transfer_client_account', 'branch_code',
   'A client account belongs to one branch (§14.3).'),
  ('client_kyc_record', 'partner_id',
   'Identification evidence belongs to the person it identifies.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- §5.1 — access by screen and action. The §5 role catalogue does not yet carry
-- Treasury or Compliance roles; until it does, the two accounting roles hold
-- these grants, and KYC approval sits with the manager because approving it is
-- what releases a client to transfer money.
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'money_transfer_client_account', 'view'),
  ('accounting_officer', 'money_transfer_client_account', 'create'),
  ('accounting_officer', 'money_transfer_client_account', 'edit_draft'),
  ('accounting_officer', 'money_transfer_client_account', 'submit'),
  ('accounting_officer', 'money_transfer_client_account', 'print'),
  ('accounting_manager', 'money_transfer_client_account', 'view'),
  ('accounting_manager', 'money_transfer_client_account', 'create'),
  ('accounting_manager', 'money_transfer_client_account', 'edit_draft'),
  ('accounting_manager', 'money_transfer_client_account', 'submit'),
  ('accounting_manager', 'money_transfer_client_account', 'approve'),
  ('accounting_manager', 'money_transfer_client_account', 'reverse_cancel'),
  ('accounting_manager', 'money_transfer_client_account', 'print'),
  ('accounting_manager', 'money_transfer_client_account', 'export'),
  ('accounting_officer', 'client_kyc_record', 'view'),
  ('accounting_officer', 'client_kyc_record', 'create'),
  ('accounting_officer', 'client_kyc_record', 'edit_draft'),
  ('accounting_officer', 'client_kyc_record', 'submit'),
  ('accounting_manager', 'client_kyc_record', 'view'),
  ('accounting_manager', 'client_kyc_record', 'create'),
  ('accounting_manager', 'client_kyc_record', 'edit_draft'),
  ('accounting_manager', 'client_kyc_record', 'submit'),
  ('accounting_manager', 'client_kyc_record', 'approve'),
  ('accounting_manager', 'client_kyc_record', 'configure'),
  ('accounting_manager', 'client_kyc_record', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON kyc_risk_rating, kyc_required_document, client_kyc_record,
                client_kyc_document, money_transfer_client_account FROM erp_app;

  -- The two catalogues are configuration Compliance maintains.
  GRANT SELECT, INSERT, UPDATE ON kyc_risk_rating TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON kyc_required_document TO erp_app;

  -- No DELETE on either the KYC record or the client account: §1.1 keeps saved
  -- documents, and a deleted KYC record would erase the evidence a completed
  -- transfer relied on. Draft KYC documents are removable while the record is a
  -- draft, which the trigger above allows and refuses afterwards.
  GRANT SELECT, INSERT, UPDATE ON client_kyc_record TO erp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON client_kyc_document TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON money_transfer_client_account TO erp_app;
END;
$$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Row-level security.
--
-- The client account carries a branch and is scoped like every other document.
--
-- The KYC tables deliberately are not, and the reason is §3.1: a partner is one
-- authoritative record with no branch, so its identification has no branch
-- either. Scoping KYC by branch would fragment one client's identity across
-- branches and let a client blocked in one branch transfer from another — the
-- exact failure Appendix E's guidance exists to prevent. Access to them is
-- controlled by the role grants above, which is where a company-wide record's
-- access belongs.
-- ---------------------------------------------------------------------------
ALTER TABLE money_transfer_client_account ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE money_transfer_client_account FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY money_transfer_client_account_branch_scope ON money_transfer_client_account
  USING (app_is_super_user() OR branch_code = app_current_branch())
  WITH CHECK (app_is_super_user() OR branch_code = app_current_branch());
