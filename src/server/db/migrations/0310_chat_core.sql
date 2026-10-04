-- ===========================================================================
-- Platform phase · Agent 1 — internal chat (2026-10-04).
-- HAND-AUTHORED. Everything additive; no applied migration is touched.
--
--   chat_conversation   a direct (two people) or group conversation, optionally
--                       tied to an ERP record by (record_type, record_id);
--                       last_seq / rev are kept by the database, not the app
--   chat_participant    who is in it, since which message they may read
--                       (first_seq), whether it is muted, typing_until; a
--                       person who leaves keeps their row (left_at), never
--                       deleted
--   chat_message        what was said. Append-only: never deleted, never
--                       edited; a message is withdrawn (soft-retracted) with a
--                       reason and the text is kept, but the service never
--                       hands it out again. seq is assigned by trigger.
--   chat_receipt        one row per message per recipient: delivered_at is
--                       written when that person's client acknowledged the
--                       message, seen_at when they read the conversation.
--                       Forward only, never faked: only the recipient writes
--                       them, and only the sender and the recipient read them.
--   chat_reaction       one reaction code per person per message (removable)
--   chat_presence       the heartbeat: last_seen_at / last_active_at / busy.
--                       Online / Away / Busy / Offline are derived from it
--                       (domain/chat.ts presenceOf), never stored.
--
-- Access is membership, enforced here (row-level security through definer
-- helpers) and again in the service. There is deliberately NO super-user
-- bypass: a private conversation is read by its members, and an
-- administrator who is not one sees nothing.
-- ===========================================================================

CREATE TABLE "chat_conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"kind" text NOT NULL,
	"title" text,
	-- The ERP record this is about, as the attachments and notes know records:
	-- the audit object type and the id the record's history is kept under.
	"record_type" text,
	"record_id" text,
	-- What the opener called it and where it opens; shown only to members who
	-- can still open the record themselves.
	"record_label" text,
	"record_href" text,
	-- The sorted member ids a direct or record conversation was opened for, so
	-- opening it again finds it instead of making another.
	"member_key" text,
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"last_seq" bigint NOT NULL DEFAULT 0,
	"last_message_at" timestamptz,
	-- Bumped by every change a member can see (message, receipt, reaction,
	-- retraction, membership), so a poll that already has this revision has
	-- everything.
	"rev" bigint NOT NULL DEFAULT 0,
	CONSTRAINT "chat_conversation_kind_known" CHECK ("kind" IN ('direct', 'group')),
	CONSTRAINT "chat_conversation_title_shape" CHECK (
		("kind" = 'direct' AND "title" IS NULL)
		OR ("kind" = 'group' AND char_length(btrim("title")) BETWEEN 1 AND 120)
	),
	CONSTRAINT "chat_conversation_record_complete" CHECK (("record_type" IS NULL) = ("record_id" IS NULL)),
	CONSTRAINT "chat_conversation_record_extras" CHECK (
		"record_type" IS NOT NULL OR ("record_label" IS NULL AND "record_href" IS NULL)
	),
	CONSTRAINT "chat_conversation_record_href_local" CHECK (
		"record_href" IS NULL OR "record_href" ~ '^/[^/\\ ]'
	),
	CONSTRAINT "chat_conversation_seq_not_negative" CHECK ("last_seq" >= 0 AND "rev" >= 0)
);
--> statement-breakpoint
-- One direct conversation per pair; one conversation per record and member set.
CREATE UNIQUE INDEX "chat_conversation_direct_uniq" ON "chat_conversation" ("member_key")
	WHERE "kind" = 'direct' AND "record_type" IS NULL AND "member_key" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_conversation_record_uniq" ON "chat_conversation" ("record_type", "record_id", "member_key")
	WHERE "record_type" IS NOT NULL AND "member_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "chat_conversation_record_idx" ON "chat_conversation" ("record_type", "record_id")
	WHERE "record_type" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE "chat_participant" (
	"conversation_id" uuid NOT NULL REFERENCES "chat_conversation"("id"),
	"user_id" uuid NOT NULL REFERENCES "app_user"("id"),
	"role" text NOT NULL DEFAULT 'member',
	"joined_at" timestamptz NOT NULL DEFAULT now(),
	-- The first message this person may read: 1 for the people a conversation
	-- began with, the next message for someone added later.
	"first_seq" bigint NOT NULL DEFAULT 1,
	"left_at" timestamptz,
	"muted" boolean NOT NULL DEFAULT false,
	"typing_until" timestamptz,
	PRIMARY KEY ("conversation_id", "user_id"),
	CONSTRAINT "chat_participant_role_known" CHECK ("role" IN ('owner', 'member')),
	CONSTRAINT "chat_participant_first_seq_positive" CHECK ("first_seq" >= 1)
);
--> statement-breakpoint
CREATE INDEX "chat_participant_user_idx" ON "chat_participant" ("user_id") WHERE "left_at" IS NULL;
--> statement-breakpoint

CREATE TABLE "chat_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"conversation_id" uuid NOT NULL REFERENCES "chat_conversation"("id"),
	-- Assigned by the before-insert trigger from the conversation's counter.
	"seq" bigint NOT NULL DEFAULT 0,
	"kind" text NOT NULL DEFAULT 'text',
	"sender_id" uuid NOT NULL REFERENCES "app_user"("id"),
	-- The text. For a system line (kind = 'system') the event code, with its
	-- particulars in meta; the screen words it in the reader's language.
	"body" text NOT NULL DEFAULT '',
	"meta" jsonb,
	"reply_to_id" uuid REFERENCES "chat_message"("id"),
	"mentions" uuid[] NOT NULL DEFAULT '{}',
	-- The browser mints it per send, so a retry after a dropped answer finds
	-- the message already there instead of sending it twice.
	"client_id" uuid,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"retracted_at" timestamptz,
	"retracted_by" uuid REFERENCES "app_user"("id"),
	"retract_reason" text,
	CONSTRAINT "chat_message_kind_known" CHECK ("kind" IN ('text', 'system')),
	CONSTRAINT "chat_message_body_length" CHECK (char_length("body") <= 4000),
	CONSTRAINT "chat_message_retraction_complete" CHECK (
		("retracted_at" IS NULL) = ("retracted_by" IS NULL)
		AND ("retracted_at" IS NULL) = ("retract_reason" IS NULL)
	),
	CONSTRAINT "chat_message_retraction_reason" CHECK (
		"retract_reason" IS NULL OR char_length(btrim("retract_reason")) >= 3
	),
	CONSTRAINT "chat_message_system_has_event" CHECK ("kind" <> 'system' OR ("body" <> '' AND "meta" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_message_seq_uniq" ON "chat_message" ("conversation_id", "seq");
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_message_client_uniq" ON "chat_message" ("conversation_id", "sender_id", "client_id")
	WHERE "client_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "chat_message_reply_idx" ON "chat_message" ("reply_to_id") WHERE "reply_to_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "chat_message_mentions_idx" ON "chat_message" USING gin ("mentions");
--> statement-breakpoint
CREATE INDEX "chat_message_body_trgm" ON "chat_message" USING gin (lower("body") gin_trgm_ops) WHERE "kind" = 'text';
--> statement-breakpoint

CREATE TABLE "chat_receipt" (
	"message_id" uuid NOT NULL REFERENCES "chat_message"("id"),
	"conversation_id" uuid NOT NULL REFERENCES "chat_conversation"("id"),
	"user_id" uuid NOT NULL REFERENCES "app_user"("id"),
	"delivered_at" timestamptz,
	"seen_at" timestamptz,
	PRIMARY KEY ("message_id", "user_id"),
	-- Seen is read after it arrived: never a seen without a delivery.
	CONSTRAINT "chat_receipt_seen_after_delivered" CHECK (
		"seen_at" IS NULL OR ("delivered_at" IS NOT NULL AND "seen_at" >= "delivered_at")
	)
);
--> statement-breakpoint
CREATE INDEX "chat_receipt_unread_idx" ON "chat_receipt" ("user_id", "conversation_id") WHERE "seen_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "chat_receipt_undelivered_idx" ON "chat_receipt" ("user_id", "conversation_id") WHERE "delivered_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "chat_receipt_conversation_idx" ON "chat_receipt" ("conversation_id");
--> statement-breakpoint

CREATE TABLE "chat_reaction" (
	"message_id" uuid NOT NULL REFERENCES "chat_message"("id"),
	"conversation_id" uuid NOT NULL REFERENCES "chat_conversation"("id"),
	"user_id" uuid NOT NULL REFERENCES "app_user"("id"),
	"reaction" text NOT NULL,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY ("message_id", "user_id", "reaction"),
	CONSTRAINT "chat_reaction_known" CHECK ("reaction" IN ('like', 'love', 'laugh', 'thanks', 'done', 'eyes'))
);
--> statement-breakpoint
CREATE INDEX "chat_reaction_conversation_idx" ON "chat_reaction" ("conversation_id");
--> statement-breakpoint

CREATE TABLE "chat_presence" (
	"user_id" uuid PRIMARY KEY REFERENCES "app_user"("id"),
	-- The last time any of this person's browsers asked.
	"last_seen_at" timestamptz NOT NULL DEFAULT now(),
	-- The last time one of them reported the person actually at the keyboard.
	"last_active_at" timestamptz,
	-- The person asked not to be disturbed.
	"busy" boolean NOT NULL DEFAULT false
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Helpers the policies stand on. SECURITY DEFINER, so they read the
-- participant table without asking its own policy (which would ask them).
-- ---------------------------------------------------------------------------

CREATE FUNCTION app_chat_member(p_conversation uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT EXISTS (
		SELECT 1 FROM chat_participant p
		 WHERE p.conversation_id = p_conversation
		   AND p.user_id = app_current_user()
		   AND p.left_at IS NULL
	);
$$;
--> statement-breakpoint

CREATE FUNCTION app_chat_is_owner(p_conversation uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT EXISTS (
		SELECT 1 FROM chat_participant p
		 WHERE p.conversation_id = p_conversation
		   AND p.user_id = app_current_user()
		   AND p.role = 'owner'
		   AND p.left_at IS NULL
	);
$$;
--> statement-breakpoint

-- A member may read message `p_seq` of the conversation: they are in it and
-- it is not older than their first.
CREATE FUNCTION app_chat_can_read(p_conversation uuid, p_seq bigint) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT EXISTS (
		SELECT 1 FROM chat_participant p
		 WHERE p.conversation_id = p_conversation
		   AND p.user_id = app_current_user()
		   AND p.left_at IS NULL
		   AND p_seq >= p.first_seq
	);
$$;
--> statement-breakpoint

CREATE FUNCTION app_chat_message_readable(p_message uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT EXISTS (
		SELECT 1 FROM chat_message m
		  JOIN chat_participant p ON p.conversation_id = m.conversation_id
		 WHERE m.id = p_message
		   AND p.user_id = app_current_user()
		   AND p.left_at IS NULL
		   AND m.seq >= p.first_seq
	);
$$;
--> statement-breakpoint

-- The same for an attachment, whose parent id is loose text.
CREATE FUNCTION app_chat_message_visible(p_object_id text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
	IF p_object_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
		RETURN false;
	END IF;
	RETURN app_chat_message_readable(p_object_id::uuid);
END;
$$;
--> statement-breakpoint

CREATE FUNCTION app_chat_is_sender(p_message uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT EXISTS (
		SELECT 1 FROM chat_message m
		 WHERE m.id = p_message
		   AND m.sender_id = app_current_user()
		   AND app_chat_member(m.conversation_id)
	);
$$;
--> statement-breakpoint

-- Two people are "around each other" when they share a conversation both are
-- still in: that is who may see each other's presence, nobody else.
CREATE FUNCTION app_chat_shares(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT EXISTS (
		SELECT 1
		  FROM chat_participant mine
		  JOIN chat_participant theirs ON theirs.conversation_id = mine.conversation_id
		 WHERE mine.user_id = app_current_user() AND mine.left_at IS NULL
		   AND theirs.user_id = p_user AND theirs.left_at IS NULL
	);
$$;
--> statement-breakpoint

-- Who may put people into a conversation: its creator while it has nobody in
-- it yet (one statement adds the first members), then only an owner of a group.
CREATE FUNCTION app_chat_may_add(p_conversation uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT (
		EXISTS (SELECT 1 FROM chat_conversation c WHERE c.id = p_conversation AND c.created_by = app_current_user())
		AND NOT EXISTS (SELECT 1 FROM chat_participant p WHERE p.conversation_id = p_conversation)
	) OR (
		EXISTS (
			SELECT 1 FROM chat_participant p
			  JOIN chat_conversation c ON c.id = p.conversation_id
			 WHERE p.conversation_id = p_conversation
			   AND p.user_id = app_current_user()
			   AND p.role = 'owner'
			   AND p.left_at IS NULL
			   AND c.kind = 'group'
		)
	);
$$;
--> statement-breakpoint

-- A change a member can see: the conversation's revision moves, so every
-- member's next poll fetches the new state. Only a member can ask for it.
CREATE FUNCTION app_chat_touch(p_conversation uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
	IF NOT app_chat_member(p_conversation) THEN
		RAISE EXCEPTION 'You are not in this conversation.' USING ERRCODE = 'insufficient_privilege';
	END IF;
	UPDATE chat_conversation SET rev = rev + 1 WHERE id = p_conversation;
END;
$$;
--> statement-breakpoint

-- The oldest message a person has not yet seen in a conversation: the notice
-- for a run of unread messages is raised once, keyed on this, however many
-- people wrote into it. Reads other people's messages' receipts, so definer.
CREATE FUNCTION app_chat_first_unseen(p_conversation uuid, p_user uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT min(m.seq)
	  FROM chat_receipt r
	  JOIN chat_message m ON m.id = r.message_id
	 WHERE r.conversation_id = p_conversation
	   AND r.user_id = p_user
	   AND r.seen_at IS NULL
	   AND m.retracted_at IS NULL;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Triggers: the invariants the application cannot forget.
-- ---------------------------------------------------------------------------

-- A message takes the conversation's next number (the counter's row lock
-- serialises senders), and may only answer a message of the same conversation.
CREATE FUNCTION chat_message_before_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
	v_seq bigint;
BEGIN
	UPDATE chat_conversation
	   SET last_seq = last_seq + 1, last_message_at = now(), rev = rev + 1
	 WHERE id = NEW.conversation_id
	RETURNING last_seq INTO v_seq;
	IF v_seq IS NULL THEN
		RAISE EXCEPTION 'There is no such conversation.' USING ERRCODE = 'foreign_key_violation';
	END IF;
	NEW.seq := v_seq;
	IF NEW.reply_to_id IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM chat_message q WHERE q.id = NEW.reply_to_id AND q.conversation_id = NEW.conversation_id
	) THEN
		RAISE EXCEPTION 'A reply answers a message of its own conversation.' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "chat_message_before_insert" BEFORE INSERT ON "chat_message"
	FOR EACH ROW EXECUTE FUNCTION chat_message_before_insert();
--> statement-breakpoint

-- Every other person in the conversation gets a receipt, undelivered and
-- unseen, from the moment the message exists. A system line has none: it is
-- not an unread message.
CREATE FUNCTION chat_message_after_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
	IF NEW.kind = 'text' THEN
		INSERT INTO chat_receipt (message_id, conversation_id, user_id)
		SELECT NEW.id, NEW.conversation_id, p.user_id
		  FROM chat_participant p
		 WHERE p.conversation_id = NEW.conversation_id
		   AND p.left_at IS NULL
		   AND p.user_id <> NEW.sender_id
		   AND p.first_seq <= NEW.seq;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "chat_message_after_insert" AFTER INSERT ON "chat_message"
	FOR EACH ROW EXECUTE FUNCTION chat_message_after_insert();
--> statement-breakpoint

-- What was said is the record: only a withdrawal may be written on a message,
-- once, and nothing deletes one.
CREATE FUNCTION chat_message_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.id IS DISTINCT FROM OLD.id
	OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
	OR NEW.seq IS DISTINCT FROM OLD.seq
	OR NEW.kind IS DISTINCT FROM OLD.kind
	OR NEW.sender_id IS DISTINCT FROM OLD.sender_id
	OR NEW.body IS DISTINCT FROM OLD.body
	OR NEW.meta IS DISTINCT FROM OLD.meta
	OR NEW.reply_to_id IS DISTINCT FROM OLD.reply_to_id
	OR NEW.mentions IS DISTINCT FROM OLD.mentions
	OR NEW.client_id IS DISTINCT FROM OLD.client_id
	OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'A chat message is not edited; withdraw it with a reason instead.'
			USING ERRCODE = 'restrict_violation';
	END IF;
	IF OLD.retracted_at IS NOT NULL AND (
		NEW.retracted_at IS DISTINCT FROM OLD.retracted_at
		OR NEW.retracted_by IS DISTINCT FROM OLD.retracted_by
		OR NEW.retract_reason IS DISTINCT FROM OLD.retract_reason
	) THEN
		RAISE EXCEPTION 'A withdrawn message stays withdrawn.' USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "chat_message_guard" BEFORE UPDATE ON "chat_message"
	FOR EACH ROW EXECUTE FUNCTION chat_message_guard();
--> statement-breakpoint
CREATE TRIGGER "chat_message_no_delete" BEFORE DELETE ON "chat_message"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint

-- Receipts move forward and nowhere else: delivered once, seen once.
CREATE FUNCTION chat_receipt_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.message_id IS DISTINCT FROM OLD.message_id
	OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
	OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
		RAISE EXCEPTION 'A receipt cannot be moved to another message or person.' USING ERRCODE = 'restrict_violation';
	END IF;
	IF OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at THEN
		RAISE EXCEPTION 'A delivery is recorded once.' USING ERRCODE = 'restrict_violation';
	END IF;
	IF OLD.seen_at IS NOT NULL AND NEW.seen_at IS DISTINCT FROM OLD.seen_at THEN
		RAISE EXCEPTION 'A message is seen once; it cannot be unseen.' USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "chat_receipt_guard" BEFORE UPDATE ON "chat_receipt"
	FOR EACH ROW EXECUTE FUNCTION chat_receipt_guard();
--> statement-breakpoint
CREATE TRIGGER "chat_receipt_no_delete" BEFORE DELETE ON "chat_receipt"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint

-- A reaction belongs to the conversation of its message.
CREATE FUNCTION chat_reaction_before_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
	SELECT m.conversation_id INTO NEW.conversation_id FROM chat_message m WHERE m.id = NEW.message_id;
	IF NEW.conversation_id IS NULL THEN
		RAISE EXCEPTION 'There is no such message.' USING ERRCODE = 'foreign_key_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "chat_reaction_before_insert" BEFORE INSERT ON "chat_reaction"
	FOR EACH ROW EXECUTE FUNCTION chat_reaction_before_insert();
--> statement-breakpoint

-- The conversation's shape is fixed when it is made; only a group's title
-- changes, and only an owner changes it. The counters move only forward.
CREATE FUNCTION chat_conversation_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.id IS DISTINCT FROM OLD.id
	OR NEW.kind IS DISTINCT FROM OLD.kind
	OR NEW.record_type IS DISTINCT FROM OLD.record_type
	OR NEW.record_id IS DISTINCT FROM OLD.record_id
	OR NEW.record_label IS DISTINCT FROM OLD.record_label
	OR NEW.record_href IS DISTINCT FROM OLD.record_href
	OR NEW.member_key IS DISTINCT FROM OLD.member_key
	OR NEW.created_by IS DISTINCT FROM OLD.created_by
	OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'A conversation keeps the shape it was opened with.' USING ERRCODE = 'restrict_violation';
	END IF;
	IF NEW.last_seq < OLD.last_seq OR NEW.rev < OLD.rev THEN
		RAISE EXCEPTION 'A conversation''s counters only move forward.' USING ERRCODE = 'restrict_violation';
	END IF;
	IF NEW.title IS DISTINCT FROM OLD.title AND NOT app_chat_is_owner(OLD.id) THEN
		RAISE EXCEPTION 'Only an owner of the conversation renames it.' USING ERRCODE = 'insufficient_privilege';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "chat_conversation_guard" BEFORE UPDATE ON "chat_conversation"
	FOR EACH ROW EXECUTE FUNCTION chat_conversation_guard();
--> statement-breakpoint
CREATE TRIGGER "chat_conversation_no_delete" BEFORE DELETE ON "chat_conversation"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint

-- Membership: nobody reads further back than they were let in, nobody lets
-- themselves back in, and a person's row is never deleted.
CREATE FUNCTION chat_participant_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
	OR NEW.user_id IS DISTINCT FROM OLD.user_id
	OR NEW.joined_at IS DISTINCT FROM OLD.joined_at THEN
		RAISE EXCEPTION 'A participant keeps the place they were given.' USING ERRCODE = 'restrict_violation';
	END IF;
	-- The one change of role there is: an owner makes a member an owner, so a
	-- group is never left without one when its last owner leaves.
	IF NEW.role IS DISTINCT FROM OLD.role
	AND NOT (OLD.role = 'member' AND NEW.role = 'owner' AND app_chat_is_owner(OLD.conversation_id)) THEN
		RAISE EXCEPTION 'Only an owner makes a member an owner; an owner stays one.' USING ERRCODE = 'restrict_violation';
	END IF;
	IF OLD.left_at IS NULL AND NEW.left_at IS NOT NULL THEN
		-- Leaving is one''s own; sending someone away is an owner''s.
		IF OLD.user_id <> app_current_user() AND NOT app_chat_is_owner(OLD.conversation_id) THEN
			RAISE EXCEPTION 'Only an owner removes someone from a conversation.' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF NEW.first_seq IS DISTINCT FROM OLD.first_seq THEN
			RAISE EXCEPTION 'A participant''s first message does not change when they leave.' USING ERRCODE = 'restrict_violation';
		END IF;
	ELSIF OLD.left_at IS NOT NULL AND NEW.left_at IS NULL THEN
		-- Coming back is the owner''s doing, from the next message on.
		IF NOT app_chat_is_owner(OLD.conversation_id) THEN
			RAISE EXCEPTION 'Only an owner adds someone back to a conversation.' USING ERRCODE = 'insufficient_privilege';
		END IF;
		IF NEW.first_seq <= OLD.first_seq THEN
			RAISE EXCEPTION 'Someone added back reads from the next message on.' USING ERRCODE = 'restrict_violation';
		END IF;
	ELSIF NEW.first_seq IS DISTINCT FROM OLD.first_seq OR NEW.left_at IS DISTINCT FROM OLD.left_at THEN
		RAISE EXCEPTION 'A participant''s first message and exit are not rewritten.' USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "chat_participant_guard" BEFORE UPDATE ON "chat_participant"
	FOR EACH ROW EXECUTE FUNCTION chat_participant_guard();
--> statement-breakpoint
CREATE TRIGGER "chat_participant_no_delete" BEFORE DELETE ON "chat_participant"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Row-level security: membership, and nothing else. FORCE, so the owner is
-- bound as well; no policy mentions app_is_super_user().
-- ---------------------------------------------------------------------------

ALTER TABLE chat_conversation ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE chat_conversation FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- The service mints the conversation's id and inserts it without RETURNING, so
-- no "creator" clause is needed here: nobody reads a conversation they are not
-- in, not even the person who opened it and has since left.
CREATE POLICY chat_conversation_select ON chat_conversation FOR SELECT
	USING (app_chat_member(id));--> statement-breakpoint
CREATE POLICY chat_conversation_insert ON chat_conversation FOR INSERT
	WITH CHECK (created_by = app_current_user());--> statement-breakpoint
CREATE POLICY chat_conversation_update ON chat_conversation FOR UPDATE
	USING (app_chat_is_owner(id)) WITH CHECK (app_chat_is_owner(id));--> statement-breakpoint

ALTER TABLE chat_participant ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE chat_participant FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY chat_participant_select ON chat_participant FOR SELECT
	USING (user_id = app_current_user() OR app_chat_member(conversation_id));--> statement-breakpoint
CREATE POLICY chat_participant_insert ON chat_participant FOR INSERT
	WITH CHECK (app_chat_may_add(conversation_id));--> statement-breakpoint
CREATE POLICY chat_participant_update ON chat_participant FOR UPDATE
	USING (user_id = app_current_user() OR app_chat_is_owner(conversation_id))
	WITH CHECK (user_id = app_current_user() OR app_chat_is_owner(conversation_id));--> statement-breakpoint

ALTER TABLE chat_message ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE chat_message FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY chat_message_select ON chat_message FOR SELECT
	USING (app_chat_can_read(conversation_id, seq));--> statement-breakpoint
CREATE POLICY chat_message_insert ON chat_message FOR INSERT
	WITH CHECK (sender_id = app_current_user() AND app_chat_member(conversation_id));--> statement-breakpoint
CREATE POLICY chat_message_update ON chat_message FOR UPDATE
	USING (sender_id = app_current_user() AND app_chat_member(conversation_id))
	WITH CHECK (sender_id = app_current_user() AND app_chat_member(conversation_id));--> statement-breakpoint

ALTER TABLE chat_receipt ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE chat_receipt FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Your own receipts (what reached you) and the receipts of messages you sent
-- (who got them): nobody else's.
CREATE POLICY chat_receipt_select ON chat_receipt FOR SELECT
	USING (user_id = app_current_user() OR app_chat_is_sender(message_id));--> statement-breakpoint
CREATE POLICY chat_receipt_update ON chat_receipt FOR UPDATE
	USING (user_id = app_current_user() AND app_chat_member(conversation_id))
	WITH CHECK (user_id = app_current_user() AND app_chat_member(conversation_id));--> statement-breakpoint

ALTER TABLE chat_reaction ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE chat_reaction FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY chat_reaction_select ON chat_reaction FOR SELECT
	USING (app_chat_message_readable(message_id));--> statement-breakpoint
CREATE POLICY chat_reaction_insert ON chat_reaction FOR INSERT
	WITH CHECK (user_id = app_current_user() AND app_chat_message_readable(message_id));--> statement-breakpoint
CREATE POLICY chat_reaction_delete ON chat_reaction FOR DELETE
	USING (user_id = app_current_user());--> statement-breakpoint

ALTER TABLE chat_presence ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE chat_presence FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- You read your own and that of the people you share a conversation with;
-- only you write your own.
CREATE POLICY chat_presence_select ON chat_presence FOR SELECT
	USING (user_id = app_current_user() OR app_chat_shares(user_id));--> statement-breakpoint
CREATE POLICY chat_presence_insert ON chat_presence FOR INSERT WITH CHECK (user_id = app_current_user());--> statement-breakpoint
CREATE POLICY chat_presence_update ON chat_presence FOR UPDATE
	USING (user_id = app_current_user()) WITH CHECK (user_id = app_current_user());--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	-- Columns the application may change; the counters move through the
	-- definer functions above, receipts are created by the insert trigger.
	GRANT SELECT, INSERT ON chat_conversation TO erp_app;
	GRANT UPDATE (title) ON chat_conversation TO erp_app;
	GRANT SELECT, INSERT ON chat_participant TO erp_app;
	GRANT UPDATE (role, muted, typing_until, left_at, first_seq) ON chat_participant TO erp_app;
	GRANT SELECT, INSERT ON chat_message TO erp_app;
	GRANT UPDATE (retracted_at, retracted_by, retract_reason) ON chat_message TO erp_app;
	GRANT SELECT ON chat_receipt TO erp_app;
	GRANT UPDATE (delivered_at, seen_at) ON chat_receipt TO erp_app;
	GRANT SELECT, INSERT, DELETE ON chat_reaction TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON chat_presence TO erp_app;
END $$;
