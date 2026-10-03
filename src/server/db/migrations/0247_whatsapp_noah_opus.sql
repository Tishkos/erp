-- REQ-WA-001 — the bot is called Noah, and he thinks on Opus 5.5.
--
-- By direction (2026-10-02) the model is Opus 5.5, thinking at high effort:
-- the questions are the company's own books, and a wrong figure costs more
-- than a slow one. `claude-opus-5-5` is what the subscription resolves the
-- name `opus` to; the effort is a flag on the call, not a setting.
--
-- The model was chosen twice before this, both times for a brain that ran on
-- an API key and was being kept cheap. Only those three values are matched,
-- so a model an administrator has since chosen on the WhatsApp screen is left
-- exactly as they left it.

UPDATE whatsapp_setting
   SET value = 'claude-opus-5-5', updated_at = now()
 WHERE key = 'agent_model'
   AND value IN ('claude-sonnet-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001');
