-- REQ-WA-001 — questions are answered in the group and nowhere else.
--
-- The bot answered a private message on 2026-10-02 and the sponsor objected,
-- rightly: an answer in a private chat is an answer nobody else in the
-- company saw, and the group is the record of what was asked and what the
-- system said. On by default; a direct message is read, logged and left
-- unanswered, with the same silence an unlisted number gets.
--
-- A missing row already falls back to this in `settingsFrom`; the row exists
-- so the setting is visible and editable on the WhatsApp screen like the rest.

INSERT INTO whatsapp_setting (key, value) VALUES ('group_only', 'on')
ON CONFLICT DO NOTHING;
