CREATE TYPE "public"."notification_delivery_status" AS ENUM('pending', 'sent', 'failed', 'suppressed');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('in_app', 'email');--> statement-breakpoint
CREATE TABLE "notification" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notification_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"rule_code" text NOT NULL,
	"event_type" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"context" jsonb,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"acted_at" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"escalated_to_user_id" uuid,
	"branch_code" text
);
--> statement-breakpoint
CREATE TABLE "notification_delivery" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notification_delivery_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"notification_id" bigint NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"status" "notification_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"error_message" text,
	CONSTRAINT "notification_delivery_delivered_at_matches" CHECK (("notification_delivery"."status" = 'sent') = ("notification_delivery"."delivered_at" is not null)),
	CONSTRAINT "notification_delivery_error_matches" CHECK (("notification_delivery"."status" = 'failed') = ("notification_delivery"."error_message" is not null)),
	CONSTRAINT "notification_delivery_attempts_non_negative" CHECK ("notification_delivery"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "notification_rule" (
	"code" text PRIMARY KEY NOT NULL,
	"description" text,
	"event_type" text NOT NULL,
	"recipient_role" text NOT NULL,
	"channels" text[] NOT NULL,
	"escalate_after_seconds" integer,
	"escalate_to_role" text,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "notification_rule_has_channel" CHECK (array_length("notification_rule"."channels", 1) >= 1),
	CONSTRAINT "notification_rule_escalation_complete" CHECK (("notification_rule"."escalate_after_seconds" is null) = ("notification_rule"."escalate_to_role" is null)),
	CONSTRAINT "notification_rule_escalation_positive" CHECK ("notification_rule"."escalate_after_seconds" is null or "notification_rule"."escalate_after_seconds" > 0)
);
--> statement-breakpoint
ALTER TABLE "job_run" DROP CONSTRAINT "job_run_error_matches_status";--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_rule_code_notification_rule_code_fk" FOREIGN KEY ("rule_code") REFERENCES "public"."notification_rule"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_recipient_user_id_app_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_escalated_to_user_id_app_user_id_fk" FOREIGN KEY ("escalated_to_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_notification_id_notification_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notification"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_dedupe_uniq" ON "notification" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "notification_inbox_idx" ON "notification" USING btree ("recipient_user_id","created_at");--> statement-breakpoint
CREATE INDEX "notification_object_idx" ON "notification" USING btree ("object_type","object_id");--> statement-breakpoint
CREATE INDEX "notification_escalation_idx" ON "notification" USING btree ("created_at") WHERE "notification"."acted_at" is null and "notification"."escalated_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_delivery_channel_uniq" ON "notification_delivery" USING btree ("notification_id","channel");--> statement-breakpoint
CREATE INDEX "notification_delivery_status_idx" ON "notification_delivery" USING btree ("status","last_attempt_at");--> statement-breakpoint
CREATE INDEX "notification_rule_event_idx" ON "notification_rule" USING btree ("event_type") WHERE "notification_rule"."active";--> statement-breakpoint
ALTER TABLE "job_run" ADD CONSTRAINT "job_run_error_matches_status" CHECK (case
            when "job_run"."status" in ('failed','dead_letter') then "job_run"."error_message" is not null
            when "job_run"."status" = 'queued'                  then "job_run"."error_message" is null
            else true
          end);--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE — Phase 01.9.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- §21 — "record delivery status."
--
-- A delivery attempt is evidence: "we tried and it failed" is the thing worth
-- keeping, and a support engineer tidying it away is the thing that makes an
-- undelivered notification look delivered.
-- ---------------------------------------------------------------------------
CREATE FUNCTION notification_delivery_forward_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'sent' AND NEW.status <> 'sent' THEN
    RAISE EXCEPTION
      'A delivered notification cannot be marked undelivered. Raise a new one if it must be sent again (§21).'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'The attempt count cannot be reduced.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.notification_id IS DISTINCT FROM OLD.notification_id
  OR NEW.channel IS DISTINCT FROM OLD.channel THEN
    RAISE EXCEPTION 'A delivery record cannot be moved to another notification or channel.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER notification_delivery_forward_only
  BEFORE UPDATE ON notification_delivery
  FOR EACH ROW EXECUTE FUNCTION notification_delivery_forward_only();--> statement-breakpoint

CREATE TRIGGER notification_delivery_no_delete
  BEFORE DELETE ON notification_delivery
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

-- A notification is raised once and read once; neither is undone.
CREATE FUNCTION notification_forward_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.dedupe_key IS DISTINCT FROM NEW.dedupe_key THEN
    RAISE EXCEPTION 'The duplicate-suppression key cannot be changed — it is what makes "once" true (§21).'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.acted_at IS NOT NULL AND NEW.acted_at IS NULL THEN
    RAISE EXCEPTION 'A task that was acted upon cannot become outstanding again.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.escalated_at IS NOT NULL AND NEW.escalated_at IS NULL THEN
    RAISE EXCEPTION 'An escalation that happened cannot be un-happened (§5.4).'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER notification_forward_only
  BEFORE UPDATE ON notification
  FOR EACH ROW EXECUTE FUNCTION notification_forward_only();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The rules this release needs.
--
-- Every one is a *reminder*. §21: "System notifications are not a substitute
-- for workflow status" — the approval requirement lives on the document, and
-- none of these rows can reach it.
-- ---------------------------------------------------------------------------
INSERT INTO notification_rule
  (code, description, event_type, recipient_role, channels, escalate_after_seconds, escalate_to_role)
VALUES
  ('journal_awaiting_approval',
   'A Journal Entry is waiting for the Accounting Manager (§14.4).',
   'journal_entry.submitted', 'accounting_manager', ARRAY['in_app','email'], 86400, 'accounting_manager'),
  ('chart_account_awaiting_approval',
   'A new account is waiting for approval (§5.2).',
   'chart_of_account.submitted', 'accounting_manager', ARRAY['in_app'], 172800, 'accounting_manager'),
  ('bank_details_awaiting_approval',
   'A change of supplier bank details is waiting for independent verification (§15).',
   'partner_bank_account.submitted', 'accounting_manager', ARRAY['in_app','email'], 43200, 'accounting_manager'),
  ('journal_rejected',
   'A Journal Entry was returned to its author.',
   'journal_entry.rejected', 'accounting_officer', ARRAY['in_app'], NULL, NULL);--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'notification', 'view'),
  ('accounting_manager', 'notification', 'view'),
  ('accounting_manager', 'notification', 'configure');--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON notification_rule, notification, notification_delivery FROM erp_app;

  GRANT SELECT, INSERT, UPDATE ON notification_rule     TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON notification          TO erp_app;
  -- No DELETE: a delivery attempt is the record that it was tried.
  GRANT SELECT, INSERT, UPDATE ON notification_delivery TO erp_app;
END;
$$;
