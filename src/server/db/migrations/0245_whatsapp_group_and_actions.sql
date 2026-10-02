-- REQ-WA-001 WA-5 and WA-6 — the group the bot works in, and deciding a
-- document from it.
--
-- WA-5: one group, registered by its id. A message from any other group is
-- silence, exactly as an unlisted number is (W-R3). The message log gains the
-- group it happened in; the sender is still the person, by number, because
-- that is who the question runs as (W-R1).
--
-- WA-6: an approval asked for in chat. The audit's own rule — an inbound
-- message is untrusted text — is answered by four things together, not by
-- trusting the sentence:
--
--   1. `whatsapp_contact.allow_actions`, off until an administrator turns it
--      on for that one person (the sponsor's "it must not be available to
--      everyone");
--   2. an explicit command, never the agent's reading of a sentence;
--   3. a one-time code this table holds, which the asker must send back
--      before anything is decided — a forwarded or injected line cannot
--      complete that round trip;
--   4. the decision itself runs through `approvals.decide` as that person,
--      so their permissions, the maker-checker rule and the open period all
--      refuse exactly as they do on the screen.
--
-- Nothing here grants a permission. It is a doorway to the permissions that
-- already exist, with a lock on the door.

ALTER TABLE "whatsapp_message" ADD COLUMN IF NOT EXISTS "group_jid" text;--> statement-breakpoint
ALTER TABLE "whatsapp_contact" ADD COLUMN IF NOT EXISTS "allow_actions" boolean DEFAULT false NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "whatsapp_message_group_idx" ON "whatsapp_message" USING btree ("group_jid", "created_at");--> statement-breakpoint

-- The one-time code behind a decision asked for in chat (WA-6, step 3).
CREATE TABLE IF NOT EXISTS "whatsapp_action" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"group_jid" text,
	"document_type" text NOT NULL,
	"document_id" uuid NOT NULL,
	"document_no" text NOT NULL,
	"decision" text NOT NULL,
	"reason" text,
	"code" text NOT NULL,
	"status" text DEFAULT 'awaiting' NOT NULL,
	"refusal" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "whatsapp_action_decision" CHECK ("decision" in ('approve', 'reject')),
	CONSTRAINT "whatsapp_action_status" CHECK ("status" in ('awaiting', 'done', 'refused', 'expired', 'cancelled')),
	CONSTRAINT "whatsapp_action_code_shape" CHECK ("code" ~ '^[0-9]{6}$'),
	CONSTRAINT "whatsapp_action_reject_has_reason" CHECK ("decision" <> 'reject' OR coalesce(btrim("reason"), '') <> ''),
	CONSTRAINT "whatsapp_action_settled_has_status" CHECK (("status" = 'awaiting') = ("settled_at" is null))
);--> statement-breakpoint

-- Guarded (2026-10-02 merge repair): the merge of WA-5 left this file out of
-- the journal, so it runs after 0248 on every database — including one that
-- ran it from the WA-5 branch. Every statement is safe to meet twice.
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_action_contact_id_whatsapp_contact_id_fk') THEN
		ALTER TABLE "whatsapp_action" ADD CONSTRAINT "whatsapp_action_contact_id_whatsapp_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."whatsapp_contact"("id") ON DELETE no action ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_action_user_id_app_user_id_fk') THEN
		ALTER TABLE "whatsapp_action" ADD CONSTRAINT "whatsapp_action_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint

-- One code at a time per person: a second request replaces the first, so a
-- stale code can never be completed by accident.
CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_action_awaiting_uniq" ON "whatsapp_action" USING btree ("contact_id")
	WHERE "status" = 'awaiting';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "whatsapp_action_document_idx" ON "whatsapp_action" USING btree ("document_type", "document_id");--> statement-breakpoint

ALTER TABLE "whatsapp_action" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "whatsapp_action" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'whatsapp_action' AND policyname = 'whatsapp_action_scope') THEN
		CREATE POLICY whatsapp_action_scope ON "whatsapp_action" USING (app_signed_in()) WITH CHECK (app_signed_in());
	END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
	GRANT SELECT, INSERT, UPDATE ON "whatsapp_action" TO erp_app;
EXCEPTION WHEN undefined_object THEN NULL; END $$;--> statement-breakpoint

-- WA-5's settings. The group is empty until an administrator registers it:
-- the bot stays a direct-message bot until somebody names the group.
INSERT INTO whatsapp_setting (key, value) VALUES
	('group_jid',           ''),
	('group_subject',       ''),
	('group_queries',       'on'),
	('group_notifications', 'on'),
	('group_digest',        'on')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- 0242 seeded a model that does not exist (`claude-sonnet-5-5`), so the first
-- free-form question would have failed against the API. The seeded row is
-- corrected here; a value an administrator has since chosen is left alone.
UPDATE whatsapp_setting SET value = 'claude-sonnet-5', updated_at = now()
 WHERE key = 'agent_model' AND value = 'claude-sonnet-5-5';
