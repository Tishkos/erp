CREATE TYPE "public"."promise_status" AS ENUM('open', 'kept', 'broken', 'cancelled');--> statement-breakpoint
CREATE TABLE "promise_to_pay" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"ar_invoice_id" uuid,
	"branch_code" text NOT NULL,
	"promised_on" date NOT NULL,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"status" "promise_status" DEFAULT 'open' NOT NULL,
	"promised_by" text,
	"note" text,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	CONSTRAINT "promise_to_pay_amount_positive" CHECK ("promise_to_pay"."amount_iqd" > 0),
	CONSTRAINT "promise_to_pay_resolution_complete" CHECK (("promise_to_pay"."status" = 'open') = ("promise_to_pay"."resolved_at" is null))
);
--> statement-breakpoint
CREATE TABLE "collection_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"ar_invoice_id" uuid,
	"branch_code" text NOT NULL,
	"occurred_on" date NOT NULL,
	"activity_kind" text NOT NULL,
	"note" text NOT NULL,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_activity_note_present" CHECK (btrim("collection_activity"."note") <> ''),
	CONSTRAINT "collection_activity_kind_present" CHECK (btrim("collection_activity"."activity_kind") <> '')
);
--> statement-breakpoint
CREATE TABLE "ar_write_off_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_code" text,
	"threshold_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"note" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ar_write_off_policy_threshold_not_negative" CHECK ("ar_write_off_policy"."threshold_iqd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ar_write_off_reason" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "ar_write_off_reason_name_present" CHECK (btrim("ar_write_off_reason"."name") <> '')
);
--> statement-breakpoint
CREATE TABLE "ar_write_off" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"write_off_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"ar_invoice_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"write_off_date" date NOT NULL,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"reason_code" text NOT NULL,
	"note" text,
	"threshold_at_approval_iqd" numeric(19, 4),
	"above_threshold" boolean,
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
	CONSTRAINT "ar_write_off_amount_positive" CHECK ("ar_write_off"."amount_iqd" > 0),
	CONSTRAINT "ar_write_off_reversal_has_reason" CHECK (("ar_write_off"."reversed_by" is null and "ar_write_off"."reversed_at" is null)
          or ("ar_write_off"."reversed_by" is not null and "ar_write_off"."reversed_at" is not null
              and coalesce(btrim("ar_write_off"."reversal_reason"), '') <> '')),
	CONSTRAINT "ar_write_off_posting_matches_status" CHECK (("ar_write_off"."journal_entry_id" is null) = ("ar_write_off"."posted_at" is null)),
	CONSTRAINT "ar_write_off_stamps_in_order" CHECK (("ar_write_off"."posted_at" is null or "ar_write_off"."approved_at" is not null)
          and ("ar_write_off"."posted_at" is null or "ar_write_off"."approved_at" <= "ar_write_off"."posted_at"))
);
--> statement-breakpoint
ALTER TABLE "promise_to_pay" ADD CONSTRAINT "promise_to_pay_customer_id_business_partner_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promise_to_pay" ADD CONSTRAINT "promise_to_pay_ar_invoice_id_ar_invoice_id_fk" FOREIGN KEY ("ar_invoice_id") REFERENCES "public"."ar_invoice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promise_to_pay" ADD CONSTRAINT "promise_to_pay_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promise_to_pay" ADD CONSTRAINT "promise_to_pay_recorded_by_app_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_activity" ADD CONSTRAINT "collection_activity_customer_id_business_partner_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_activity" ADD CONSTRAINT "collection_activity_ar_invoice_id_ar_invoice_id_fk" FOREIGN KEY ("ar_invoice_id") REFERENCES "public"."ar_invoice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_activity" ADD CONSTRAINT "collection_activity_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_activity" ADD CONSTRAINT "collection_activity_recorded_by_app_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_write_off_policy" ADD CONSTRAINT "ar_write_off_policy_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_write_off_policy" ADD CONSTRAINT "ar_write_off_policy_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_write_off" ADD CONSTRAINT "ar_write_off_ar_invoice_id_ar_invoice_id_fk" FOREIGN KEY ("ar_invoice_id") REFERENCES "public"."ar_invoice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_write_off" ADD CONSTRAINT "ar_write_off_customer_id_business_partner_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_write_off" ADD CONSTRAINT "ar_write_off_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_write_off" ADD CONSTRAINT "ar_write_off_reason_code_ar_write_off_reason_code_fk" FOREIGN KEY ("reason_code") REFERENCES "public"."ar_write_off_reason"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_write_off" ADD CONSTRAINT "ar_write_off_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_write_off" ADD CONSTRAINT "ar_write_off_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_write_off" ADD CONSTRAINT "ar_write_off_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_write_off" ADD CONSTRAINT "ar_write_off_posted_by_app_user_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_write_off" ADD CONSTRAINT "ar_write_off_reversed_by_app_user_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "promise_to_pay_customer_idx" ON "promise_to_pay" USING btree ("customer_id","status");--> statement-breakpoint
CREATE INDEX "promise_to_pay_invoice_idx" ON "promise_to_pay" USING btree ("ar_invoice_id");--> statement-breakpoint
CREATE INDEX "promise_to_pay_due_idx" ON "promise_to_pay" USING btree ("promised_on","status");--> statement-breakpoint
CREATE INDEX "collection_activity_customer_idx" ON "collection_activity" USING btree ("customer_id","occurred_on");--> statement-breakpoint
CREATE INDEX "collection_activity_invoice_idx" ON "collection_activity" USING btree ("ar_invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ar_write_off_policy_branch_uniq" ON "ar_write_off_policy" USING btree ("branch_code") WHERE branch_code is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ar_write_off_policy_default_uniq" ON "ar_write_off_policy" USING btree ((true)) WHERE branch_code is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ar_write_off_no_uniq" ON "ar_write_off" USING btree ("write_off_no");--> statement-breakpoint
CREATE INDEX "ar_write_off_invoice_idx" ON "ar_write_off" USING btree ("ar_invoice_id");--> statement-breakpoint
CREATE INDEX "ar_write_off_customer_idx" ON "ar_write_off" USING btree ("customer_id","status");
-- ===========================================================================
-- Phase 06.11 — A/R collections and write-off (§16)
--
--   "Collections Worklist, Promise to Pay, Follow-up Notes."
--   "Write-off requires defined threshold, approval and reason code."
--   Acceptance 5: "Write-offs, refunds and credit notes require controlled
--   approval."
--
-- **The threshold decides who approves, not whether.** Every write-off is
-- approved by somebody; the threshold decides whether the ordinary approver is
-- enough or whether it needs the higher hand. The alternative reading - small
-- write-offs needing no approval - would let a debt be forgiven with no owner at
-- all, and acceptance 5 says "controlled approval" without qualification.
--
-- **It defaults to zero**, which puts everything above the line until Finance
-- sets a figure. The figure is the company's to choose and is raised as the tail
-- note of D12 in docs/DECISIONS.md; the same safe-by-default treatment section
-- 8.4's receipt tolerance got.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- A write-off forgives a debt; it cannot create a credit.
--
-- In the database as well as the service, because an import writing a row goes
-- through neither the service nor the UI (blueprint 7.7).
-- ---------------------------------------------------------------------------
CREATE FUNCTION ar_write_off_within_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_invoice_no text;
  v_open       numeric(19,4);
  v_other      numeric(19,4);
BEGIN
  SELECT invoice_no, (net_iqd - allocated_iqd)
    INTO v_invoice_no, v_open
    FROM ar_invoice WHERE id = NEW.ar_invoice_id;

  SELECT coalesce(sum(amount_iqd), 0) INTO v_other
    FROM ar_write_off
   WHERE ar_invoice_id = NEW.ar_invoice_id
     AND id <> NEW.id
     AND status IN ('draft', 'approved');

  IF v_other + NEW.amount_iqd > coalesce(v_open, 0) THEN
    RAISE EXCEPTION
      'Writing off % against invoice % is more than the % still owed. A write-off forgives a debt; it cannot create a credit (blueprint 16).',
      NEW.amount_iqd, v_invoice_no, coalesce(v_open, 0) - v_other
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER ar_write_off_within_balance
  BEFORE INSERT ON ar_write_off
  FOR EACH ROW EXECUTE FUNCTION ar_write_off_within_balance();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Blueprint 5.4 — the collections history is evidence.
--
-- "We called three times" is worth having only if somebody else can check it, so
-- an activity is added and never edited. A promise *is* updated, because closing
-- one as kept or broken is the point of recording it - but the row itself is
-- never removed, and the outcome is part of the record.
-- ---------------------------------------------------------------------------
CREATE TRIGGER collection_activity_append_only
  BEFORE UPDATE OR DELETE ON collection_activity
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

-- Numbering, document type, statuses and permissions.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('AR_WRITE_OFF', 'WOF', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('ar_write_off', 'A/R Write-Off', 'sales',
   'Forgives an uncollectable customer debt. Posts Dr Bad Debt Expense / Cr Customer A/R. Requires a reason code from the configured list and, above the configured threshold, a higher approval (blueprint 16).');--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('ar_write_off', 'draft',    'approved'),
  ('ar_write_off', 'draft',    'cancelled'),
  ('ar_write_off', 'approved', 'draft'),
  ('ar_write_off', 'approved', 'posted'),
  ('ar_write_off', 'posted',   'reversed');--> statement-breakpoint

INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('ar_write_off', 'amount_iqd',
   'Decides how much debt is forgiven, and whether the higher approval is needed.'),
  ('ar_write_off', 'reason_code',
   'Blueprint 16 requires a reason code. A list rather than free text is what makes "why do we write debts off?" a countable question.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Blueprint 16 - a starting set of reason codes. Configuration, so Finance may
-- add to it; seeded so that the control is usable from the first day rather than
-- blocked on a list nobody has written yet.
INSERT INTO ar_write_off_reason (code, name, description) VALUES
  ('UNCOLLECTABLE',   'Uncollectable',           'Customer cannot or will not pay and recovery is not economic.'),
  ('CUSTOMER_CLOSED', 'Customer ceased trading', 'The customer no longer exists as a trading entity.'),
  ('DISPUTE_SETTLED', 'Dispute settled',         'Written off as part of an agreed settlement of a dispute.'),
  ('SMALL_BALANCE',   'Small residual balance',  'An immaterial remainder left after allocation, typically rounding.'),
  ('GOODWILL',        'Goodwill',                'Forgiven as a commercial gesture, with approval.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- The company-wide default threshold: zero, so every write-off needs the higher
-- approval until Finance sets a figure.
INSERT INTO ar_write_off_policy (branch_code, threshold_iqd, note)
VALUES (NULL, 0,
        'Default until Finance sets a threshold (D12). Zero means every write-off needs the higher approval.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Collections work — recording a promise or a call — is an action on the
-- receivable rather than on a document of its own, so it is 'execute' on
-- ar_invoice. A separate permission object would be a second place to forget.
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'ar_invoice', 'execute'),
  ('accounting_manager', 'ar_invoice', 'execute'),
  ('accounting_officer', 'ar_write_off', 'view'),
  ('accounting_officer', 'ar_write_off', 'create'),
  ('accounting_officer', 'ar_write_off', 'edit_draft'),
  ('accounting_officer', 'ar_write_off', 'print'),
  ('accounting_manager', 'ar_write_off', 'view'),
  ('accounting_manager', 'ar_write_off', 'create'),
  ('accounting_manager', 'ar_write_off', 'edit_draft'),
  ('accounting_manager', 'ar_write_off', 'approve'),
  ('accounting_manager', 'ar_write_off', 'post'),
  ('accounting_manager', 'ar_write_off', 'configure'),
  ('accounting_manager', 'ar_write_off', 'reverse_cancel'),
  ('accounting_manager', 'ar_write_off', 'print'),
  ('accounting_manager', 'ar_write_off', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist - grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON promise_to_pay, collection_activity, ar_write_off,
                ar_write_off_policy, ar_write_off_reason FROM erp_app;

  GRANT SELECT, INSERT, UPDATE ON promise_to_pay TO erp_app;
  -- No UPDATE or DELETE: the trigger above refuses them to everyone.
  GRANT SELECT, INSERT ON collection_activity TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON ar_write_off TO erp_app;
  -- Configuration is read by the application and changed through administration.
  GRANT SELECT ON ar_write_off_policy TO erp_app;
  GRANT SELECT ON ar_write_off_reason TO erp_app;
END;
$$;--> statement-breakpoint

-- D10 — the branch boundary.
ALTER TABLE promise_to_pay ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE promise_to_pay FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY promise_to_pay_branch_scope ON promise_to_pay
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

ALTER TABLE collection_activity ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE collection_activity FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY collection_activity_branch_scope ON collection_activity
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

ALTER TABLE ar_write_off ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ar_write_off FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY ar_write_off_branch_scope ON ar_write_off
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));
