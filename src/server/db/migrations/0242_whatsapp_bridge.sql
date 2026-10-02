-- ===========================================================================
-- REQ-WA-001 Stages WA-1 and WA-2 — the WhatsApp bridge and the query bot
-- (2026-10-02).
--
--   notification_channel     gains 'whatsapp' beside in_app and email (§1)
--   whatsapp_contact         the allow-list (W-R3): user ↔ number ↔ what is
--                            allowed; deactivated, never deleted
--   whatsapp_session         the Baileys pairing, so a restart keeps the QR
--   whatsapp_message         every message in and out and what was decided
--                            about it (W-R4 made readable; D-WA-8 retention
--                            blanks the body, the row stays)
--   whatsapp_setting         models, limits, throttle — key/value
--
-- Permission object `whatsapp`: the CEO and the system administrator
-- configure the allow-list and the settings and read the log; the CEO is the
-- only role that may ask (D-WA-3 as ratified by the sponsor on 2026-10-02:
-- "only ceo role"). Asking is not a grant: it is the `ceo` role plus a
-- contact row with allow_queries — both checked on every message.
--
-- The new enum value is added first and used by nothing else in this file:
-- PostgreSQL will not let a value added inside a transaction be used before
-- the transaction commits, and the migrator runs this file as one.
-- ===========================================================================

ALTER TYPE "public"."notification_channel" ADD VALUE IF NOT EXISTS 'whatsapp';--> statement-breakpoint

CREATE TABLE "whatsapp_contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"e164" text NOT NULL,
	"allow_notifications" boolean DEFAULT true NOT NULL,
	"allow_queries" boolean DEFAULT false NOT NULL,
	"allow_digest" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"deactivated_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_contact_e164_format" CHECK ("e164" ~ '^\+[1-9][0-9]{7,14}$')
);--> statement-breakpoint

CREATE TABLE "whatsapp_session" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "whatsapp_message" (
	"id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
	"direction" text NOT NULL,
	"e164" text NOT NULL,
	"contact_id" uuid,
	"user_id" uuid,
	"wa_message_id" text,
	"body" text,
	"attachment_name" text,
	"attachment_type" text,
	"attachment_bytes" integer,
	"intent" text,
	"detail" jsonb,
	"status" text NOT NULL,
	"error_message" text,
	"in_reply_to" bigint,
	"delivery_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"redacted_at" timestamp with time zone,
	CONSTRAINT "whatsapp_message_direction" CHECK ("direction" in ('in', 'out')),
	CONSTRAINT "whatsapp_message_status" CHECK ("status" in ('received', 'answered', 'refused', 'failed', 'pending', 'sent')),
	CONSTRAINT "whatsapp_message_error_matches" CHECK (("status" = 'failed') = ("error_message" is not null))
);--> statement-breakpoint

CREATE TABLE "whatsapp_setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);--> statement-breakpoint

ALTER TABLE "whatsapp_contact" ADD CONSTRAINT "whatsapp_contact_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_contact" ADD CONSTRAINT "whatsapp_contact_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_message" ADD CONSTRAINT "whatsapp_message_contact_id_whatsapp_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."whatsapp_contact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_message" ADD CONSTRAINT "whatsapp_message_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_message" ADD CONSTRAINT "whatsapp_message_delivery_id_notification_delivery_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."notification_delivery"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_setting" ADD CONSTRAINT "whatsapp_setting_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "whatsapp_contact_user_uniq" ON "whatsapp_contact" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_contact_e164_uniq" ON "whatsapp_contact" USING btree ("e164");--> statement-breakpoint
CREATE INDEX "whatsapp_message_status_idx" ON "whatsapp_message" USING btree ("direction", "status", "created_at");--> statement-breakpoint
CREATE INDEX "whatsapp_message_created_idx" ON "whatsapp_message" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "whatsapp_message_contact_idx" ON "whatsapp_message" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "whatsapp_message_delivery_idx" ON "whatsapp_message" USING btree ("delivery_id");--> statement-breakpoint

-- A message is a record of what was said: nothing deletes it, and nothing
-- rewrites what was received (the status, the decision and the retention
-- blanking are the only changes).
CREATE FUNCTION whatsapp_message_forward_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.direction IS DISTINCT FROM OLD.direction
	OR NEW.e164 IS DISTINCT FROM OLD.e164
	OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'A WhatsApp message record cannot be moved to another number or time (W-R4).'
			USING ERRCODE = 'restrict_violation';
	END IF;
	IF OLD.body IS DISTINCT FROM NEW.body AND NOT (NEW.body IS NULL AND NEW.redacted_at IS NOT NULL) THEN
		RAISE EXCEPTION 'A message body is blanked by retention, never rewritten (D-WA-8).'
			USING ERRCODE = 'restrict_violation';
	END IF;
	IF OLD.status = 'sent' AND NEW.status <> 'sent' THEN
		RAISE EXCEPTION 'A sent message cannot be marked unsent.'
			USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER whatsapp_message_forward_only
	BEFORE UPDATE ON whatsapp_message
	FOR EACH ROW EXECUTE FUNCTION whatsapp_message_forward_only();--> statement-breakpoint

CREATE TRIGGER whatsapp_message_no_delete
	BEFORE DELETE ON whatsapp_message
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

CREATE TRIGGER whatsapp_contact_no_delete
	BEFORE DELETE ON whatsapp_contact
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

-- Row-level security: a signed-in session (the bridge runs as the system
-- operator, the screen as its reader). The session store is the bridge's own.
ALTER TABLE "whatsapp_contact" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "whatsapp_contact" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY whatsapp_contact_scope ON "whatsapp_contact" USING (app_signed_in()) WITH CHECK (app_signed_in());--> statement-breakpoint
ALTER TABLE "whatsapp_session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "whatsapp_session" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY whatsapp_session_scope ON "whatsapp_session" USING (app_signed_in()) WITH CHECK (app_signed_in());--> statement-breakpoint
ALTER TABLE "whatsapp_message" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "whatsapp_message" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY whatsapp_message_scope ON "whatsapp_message" USING (app_signed_in()) WITH CHECK (app_signed_in());--> statement-breakpoint
ALTER TABLE "whatsapp_setting" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "whatsapp_setting" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY whatsapp_setting_scope ON "whatsapp_setting" USING (app_signed_in()) WITH CHECK (app_signed_in());--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	GRANT SELECT, INSERT, UPDATE ON "whatsapp_contact", "whatsapp_message", "whatsapp_setting" TO erp_app;
	-- Signal keys are rotated by the protocol: a key the phone retired is
	-- removed. They are cryptographic material, not a record of anything.
	GRANT SELECT, INSERT, UPDATE, DELETE ON "whatsapp_session" TO erp_app;
END $$;--> statement-breakpoint

-- Who configures the bridge and reads its log. Asking is the CEO role plus
-- allow_queries — never a grant on its own.
INSERT INTO role_grant (role_code, object, verb) VALUES
	('ceo',                  'whatsapp', 'view'),
	('ceo',                  'whatsapp', 'configure'),
	('system_administrator', 'whatsapp', 'view'),
	('system_administrator', 'whatsapp', 'configure'),
	('accounting_manager',   'whatsapp', 'view')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- The knobs, with their seeds (§3, D-WA-2, D-WA-4).
INSERT INTO whatsapp_setting (key, value) VALUES
	('router_model',    'claude-haiku-4-5-20251001'),
	('agent_model',     'claude-sonnet-5-5'),
	('inline_rows',     '15'),
	('export_rows_cap', '5000'),
	('throttle_per_minute', '60'),
	('retention_days',  '90'),
	('digest_hour',     '08'),
	('digest_locale',   'ar')
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint

-- What reaches the CEO's phone from the start: an escalated hold and a
-- payment made. Both are also in the inbox; the rules screen (here, on the
-- WhatsApp screen) turns the channel on or off per rule.
INSERT INTO notification_rule (code, description, event_type, recipient_role, channels, escalate_after_seconds, escalate_to_role, active) VALUES
	('ceo_payable_hold_escalated', 'An unowned or overdue stop was escalated — the CEO hears of it (REQ-WA-001 §1).', 'payable.hold.escalated', 'ceo', ARRAY['in_app', 'whatsapp'], NULL, NULL, true),
	('ceo_supplier_payment_made',  'A supplier payment was made — the CEO hears of it (REQ-WA-001 §1).',              'supplier_payment.made',  'ceo', ARRAY['in_app', 'whatsapp'], NULL, NULL, true)
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
	('whatsapp_contact', 'WhatsApp contact', 'administration', 'A user''s WhatsApp number and what it is allowed (REQ-WA-001 W-R3).'),
	('whatsapp_message', 'WhatsApp message', 'administration', 'A message received or sent by the bridge, with what was decided about it (REQ-WA-001 W-R4).')
ON CONFLICT (code) DO NOTHING;
