-- ===========================================================================
-- Platform phase · Agent 1 — internal chat: who may use it, and how a
-- conversation's files are read (2026-10-04).
-- HAND-AUTHORED. Everything additive; no applied migration is touched.
--
--   * `chat` is a new permission object. Talking to a colleague is not a
--     business document, so every role is given `view` (read the screen) and
--     `create` (start a conversation, write into one); what a person may read
--     inside it is membership, held by row-level security (0310), not by this
--     grant. A role created later is given it on the roles screen. Copied from
--     the roles that exist, so the roles `set-up-people.ts` made are covered.
--   * A file sent in a conversation is an ordinary attachment whose parent is
--     the message. The attachment table's own policy is the uploader's branch,
--     which would hide a colleague's file from a recipient in another branch;
--     one more SELECT policy lets a member of the conversation read the row.
--     It only widens reading to the people the message is for, and the
--     download still passes the parent check in attachments-runtime.
-- ===========================================================================

INSERT INTO role_grant (role_code, object, verb)
SELECT r.code, 'chat', v.verb
  FROM role r
 CROSS JOIN unnest(ARRAY['view', 'create']::permission_verb[]) AS v(verb)
ON CONFLICT DO NOTHING;--> statement-breakpoint

UPDATE app_user SET permissions_version = permissions_version + 1;--> statement-breakpoint

CREATE POLICY attachment_chat_member ON attachment FOR SELECT
	USING (object_type = 'chat_message' AND app_chat_message_visible(object_id));--> statement-breakpoint
