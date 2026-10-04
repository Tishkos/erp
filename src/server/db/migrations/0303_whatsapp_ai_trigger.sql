-- REQ-WA-001 — Noah speaks only when he is called.
--
-- By direction (2026-10-04): "the AI must ONLY respond when a WhatsApp message
-- explicitly starts with `!ai` … it must not send unsolicited reminders or
-- commentary into the group". The group is the company's own conversation; the
-- bot is not one of the people talking in it.
--
-- The trigger itself is code (`domain/whatsapp.ts` › `triggerOf`, held in the
-- bridge before anything is read). This is the other half: the two things the
-- bot said in the group without being asked — a copy of every notification,
-- and the morning digest — are switched off. They stay switches on the
-- WhatsApp screen, so an administrator who wants either back turns it on
-- there; in-app and e-mail notifications are untouched.

UPDATE whatsapp_setting
   SET value = 'off', updated_at = now()
 WHERE key IN ('group_notifications', 'group_digest')
   AND value <> 'off';
