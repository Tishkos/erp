-- ===========================================================================
-- REQ-HARDEN-001 Stage 1 — access and accounts (HD1–HD6).
-- HAND-AUTHORED. Everything additive; no applied migration is touched.
--
--   app_user.permissions_version   HD1 — bumped whenever a role, grant or
--                                  scope of the user changes; the shell asks
--                                  for it on every navigation and re-renders
--                                  the menu when it moved
--   app_user.mfa_required_since    HD4 — the first privileged sign-in starts
--                                  the enrolment grace (D-HD-5: 7 days)
--   sign_in_attempt                HD3 — every sign-in, succeeded or refused,
--                                  with the address it came from; the lockout
--                                  (D-HD-3: 5 failures → 15 minutes per
--                                  account + address) reads it
--   role.requires_mfa              HD4 — D-HD-5: CEO, accounting manager, the
--                                  system administrator and every role that
--                                  posts or approves a money document
--   row-level security             HD5 — the batch REQ-HARDEN-001 A5–A7 named
--                                  (attachments, loans, projects, KYC, notes,
--                                  consumptions, settlements, contacts,
--                                  notifications, imports, outbox); the
--                                  permission and authentication tables are
--                                  recorded exemptions (IMPROVE-3 SG-5)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- A session that has a user at all. The sign-in flow runs as the nil uuid.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_signed_in() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '') IS NOT NULL;
$$;
--> statement-breakpoint

ALTER TABLE "app_user" ADD COLUMN "permissions_version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "mfa_required_since" timestamptz;
--> statement-breakpoint

CREATE TABLE "sign_in_attempt" (
	"id" bigserial PRIMARY KEY,
	"email" text NOT NULL,
	"user_id" uuid REFERENCES "app_user"("id"),
	"ip_address" text,
	"user_agent" text,
	-- success · failed · locked · temporary_expired · second_factor_required ·
	-- second_factor_wrong · second_factor_not_enrolled · inactive
	"outcome" text NOT NULL,
	"occurred_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "sign_in_attempt_outcome" CHECK ("outcome" IN (
		'success', 'failed', 'locked', 'temporary_expired', 'second_factor_required',
		'second_factor_wrong', 'second_factor_not_enrolled', 'inactive'
	))
);
--> statement-breakpoint
CREATE INDEX "sign_in_attempt_email_idx" ON "sign_in_attempt" ("email", "occurred_at" DESC);
--> statement-breakpoint
CREATE INDEX "sign_in_attempt_ip_idx" ON "sign_in_attempt" ("ip_address", "occurred_at" DESC);
--> statement-breakpoint

-- D-HD-5 — who must present a second factor.
UPDATE "role" SET "requires_mfa" = true
 WHERE "code" IN ('ceo', 'accounting_manager', 'system_administrator')
    OR "code" IN (
      SELECT DISTINCT "role_code" FROM "role_grant"
       WHERE "verb" IN ('post', 'approve')
         AND "object" IN ('supplier_payment', 'customer_receipt', 'payment_application', 'bank_transfer',
                          'journal_entry', 'supplier_advance', 'cash_advance', 'bank_loan', 'payment_run',
                          'other_receipt', 'customer_credit_memo', 'supplier_credit_memo', 'ar_write_off')
    );
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- HD5 — row-level security. The predicate per table follows the rule the
-- rest of the schema uses: a branch-scoped record by its branch, a child
-- through its parent (whose own policy applies inside the subquery), a
-- person's own record by their user id, a company register by being signed
-- in at all. FORCE so the owner is bound as well.
-- ---------------------------------------------------------------------------

-- Attachments: the parent decides; a company master's attachment has no branch.
ALTER TABLE "attachment" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "attachment" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY attachment_scope ON "attachment"
  USING (app_is_super_user() OR branch_code IS NULL OR app_branch_allowed(branch_code))
  WITH CHECK (app_is_super_user() OR branch_code IS NULL OR app_branch_allowed(branch_code));
--> statement-breakpoint
ALTER TABLE "attachment_access" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "attachment_access" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY attachment_access_scope ON "attachment_access"
  USING (app_is_super_user() OR user_id = app_current_user()
         OR EXISTS (SELECT 1 FROM "attachment" a WHERE a.id = attachment_id))
  WITH CHECK (app_signed_in());
--> statement-breakpoint

-- Loans are a company register (REQ-AP-001 D31): every signed-in user reads them.
ALTER TABLE "bank_loan" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bank_loan" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY bank_loan_scope ON "bank_loan" USING (app_signed_in()) WITH CHECK (app_signed_in());
--> statement-breakpoint
ALTER TABLE "bank_loan_instalment" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bank_loan_instalment" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY bank_loan_instalment_scope ON "bank_loan_instalment" USING (app_signed_in()) WITH CHECK (app_signed_in());
--> statement-breakpoint

-- Projects by branch; their children through the project.
ALTER TABLE "project" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "project" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY project_scope ON "project"
  USING (app_branch_allowed(branch_code)) WITH CHECK (app_branch_allowed(branch_code));
--> statement-breakpoint
ALTER TABLE "project_certificate" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "project_certificate" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY project_certificate_scope ON "project_certificate"
  USING (app_branch_allowed(branch_code)) WITH CHECK (app_branch_allowed(branch_code));
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['project_balance_movement', 'project_budget_line', 'project_commitment',
                           'project_cost', 'project_progress', 'project_variation', 'project_wbs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (EXISTS (SELECT 1 FROM project p WHERE p.code = project_code)) '
      'WITH CHECK (EXISTS (SELECT 1 FROM project p WHERE p.code = project_code))',
      t || '_scope', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- KYC identity records: readable only by a signed-in session; the service
-- authorises the screen. Documents through their record.
ALTER TABLE "client_kyc_record" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "client_kyc_record" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY client_kyc_record_scope ON "client_kyc_record" USING (app_signed_in()) WITH CHECK (app_signed_in());
--> statement-breakpoint
ALTER TABLE "client_kyc_document" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "client_kyc_document" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY client_kyc_document_scope ON "client_kyc_document"
  USING (EXISTS (SELECT 1 FROM client_kyc_record r WHERE r.id = kyc_record_id))
  WITH CHECK (EXISTS (SELECT 1 FROM client_kyc_record r WHERE r.id = kyc_record_id));
--> statement-breakpoint

-- Children of branch-scoped documents.
ALTER TABLE "ap_invoice_note" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ap_invoice_note" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY ap_invoice_note_scope ON "ap_invoice_note"
  USING (EXISTS (SELECT 1 FROM ap_invoice i WHERE i.id = ap_invoice_id))
  WITH CHECK (EXISTS (SELECT 1 FROM ap_invoice i WHERE i.id = ap_invoice_id));
--> statement-breakpoint
ALTER TABLE "ap_match_exception" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "ap_match_exception" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY ap_match_exception_scope ON "ap_match_exception"
  USING (EXISTS (SELECT 1 FROM ap_invoice i WHERE i.id = ap_invoice_id))
  WITH CHECK (EXISTS (SELECT 1 FROM ap_invoice i WHERE i.id = ap_invoice_id));
--> statement-breakpoint
ALTER TABLE "supplier_advance_settlement" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "supplier_advance_settlement" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY supplier_advance_settlement_scope ON "supplier_advance_settlement"
  USING (EXISTS (SELECT 1 FROM supplier_advance s WHERE s.id = supplier_advance_id))
  WITH CHECK (EXISTS (SELECT 1 FROM supplier_advance s WHERE s.id = supplier_advance_id));
--> statement-breakpoint
ALTER TABLE "cost_layer_consumption" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "cost_layer_consumption" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY cost_layer_consumption_scope ON "cost_layer_consumption"
  USING (EXISTS (SELECT 1 FROM cost_layer l WHERE l.id = layer_id))
  WITH CHECK (EXISTS (SELECT 1 FROM cost_layer l WHERE l.id = layer_id));
--> statement-breakpoint

-- Partner contacts belong to the company-wide partner master.
ALTER TABLE "crm_contact" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "crm_contact" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY crm_contact_scope ON "crm_contact" USING (app_signed_in()) WITH CHECK (app_signed_in());
--> statement-breakpoint

-- A notification is read by its recipient; it is written by the module that
-- raises it for somebody else, and marked acted by the module that closed
-- the task, whoever that is.
ALTER TABLE "notification" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "notification" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- A sweep that escalates or re-delivers for everybody runs in a transaction
-- that marks itself as one (`markSystemSweep`); no web request does.
CREATE POLICY notification_read ON "notification" FOR SELECT
  USING (app_is_super_user() OR recipient_user_id = app_current_user()
         OR current_setting('app.system_sweep', true) = 'on');
--> statement-breakpoint
CREATE POLICY notification_write ON "notification" FOR INSERT WITH CHECK (app_signed_in());
--> statement-breakpoint
CREATE POLICY notification_update ON "notification" FOR UPDATE USING (app_signed_in()) WITH CHECK (app_signed_in());
--> statement-breakpoint
-- A module raises a notification for somebody else and needs its id back —
-- but RETURNING is subject to the SELECT policy, which rightly hides other
-- people's notifications. The insert therefore goes through a definer
-- function: one door, no policy widened.
CREATE FUNCTION app_notify(
  p_rule_code text, p_event_type text, p_object_type text, p_object_id text,
  p_recipient uuid, p_subject text, p_body text, p_context jsonb, p_dedupe_key text, p_branch_code text
) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO notification (rule_code, event_type, object_type, object_id, recipient_user_id, subject, body, context, dedupe_key, branch_code)
  VALUES (p_rule_code, p_event_type, p_object_type, p_object_id, p_recipient, p_subject, p_body, p_context, p_dedupe_key, p_branch_code)
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app_notify(text, text, text, text, uuid, text, text, jsonb, text, text) FROM PUBLIC;
--> statement-breakpoint
-- The module that closed a task marks every recipient's copy acted, whoever
-- they are: the one write across recipients, through the same kind of door.
CREATE FUNCTION app_notification_mark_acted(p_object_type text, p_object_id text) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH done AS (
    UPDATE notification SET acted_at = now()
     WHERE object_type = p_object_type AND object_id = p_object_id AND acted_at IS NULL
    RETURNING id
  ) SELECT count(*)::int FROM done;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app_notification_mark_acted(text, text) FROM PUBLIC;
--> statement-breakpoint
ALTER TABLE "notification_delivery" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "notification_delivery" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY notification_delivery_scope ON "notification_delivery" USING (app_signed_in()) WITH CHECK (app_signed_in());
--> statement-breakpoint

-- Imports by the branch they were uploaded in; rows through their batch.
ALTER TABLE "import_batch" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "import_batch" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY import_batch_scope ON "import_batch"
  USING (app_is_super_user() OR branch_code IS NULL OR app_branch_allowed(branch_code))
  WITH CHECK (app_is_super_user() OR branch_code IS NULL OR app_branch_allowed(branch_code));
--> statement-breakpoint
ALTER TABLE "import_row" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "import_row" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY import_row_scope ON "import_row"
  USING (EXISTS (SELECT 1 FROM import_batch b WHERE b.id = batch_id))
  WITH CHECK (EXISTS (SELECT 1 FROM import_batch b WHERE b.id = batch_id));
--> statement-breakpoint

-- The sheet-migration runs are a company-level administration record.
ALTER TABLE "payables_migration_run" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "payables_migration_run" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payables_migration_run_scope ON "payables_migration_run" USING (app_signed_in()) WITH CHECK (app_signed_in());
--> statement-breakpoint

-- Outbox, overrides, watchers, posting rules: by branch where they carry one.
ALTER TABLE "job_outbox" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "job_outbox" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY job_outbox_scope ON "job_outbox"
  USING (app_is_super_user() OR branch_code IS NULL OR app_branch_allowed(branch_code))
  WITH CHECK (app_is_super_user() OR branch_code IS NULL OR app_branch_allowed(branch_code));
--> statement-breakpoint
ALTER TABLE "period_override" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "period_override" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY period_override_scope ON "period_override"
  USING (app_is_super_user() OR branch_code IS NULL OR app_branch_allowed(branch_code))
  WITH CHECK (app_is_super_user() OR branch_code IS NULL OR app_branch_allowed(branch_code));
--> statement-breakpoint
ALTER TABLE "shipment_watcher" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "shipment_watcher" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY shipment_watcher_scope ON "shipment_watcher"
  USING (app_is_super_user() OR app_branch_allowed(branch_code))
  WITH CHECK (app_is_super_user() OR app_branch_allowed(branch_code));
--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	-- Attempts are a log: written, read, never changed.
	GRANT SELECT, INSERT ON sign_in_attempt TO erp_app;
	GRANT USAGE, SELECT ON SEQUENCE sign_in_attempt_id_seq TO erp_app;
	GRANT EXECUTE ON FUNCTION app_notify(text, text, text, text, uuid, text, text, jsonb, text, text) TO erp_app;
	GRANT EXECUTE ON FUNCTION app_notification_mark_acted(text, text) TO erp_app;
END $$;
