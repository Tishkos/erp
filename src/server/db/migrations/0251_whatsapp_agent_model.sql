-- REQ-WA-001 D-WA-2 — the agent model is Sonnet 5.5, by direction (2026-10-02).
--
-- 0242 seeded `claude-sonnet-5-5`; 0245 "corrected" it to `claude-sonnet-5`
-- on the belief that the first did not exist. It does: `claude-sonnet-5-5`
-- is the current Sonnet's API id. The row 0245 rewrote goes back; a value an
-- administrator has chosen since is left alone.
UPDATE whatsapp_setting SET value = 'claude-sonnet-5-5', updated_at = now()
 WHERE key = 'agent_model' AND value = 'claude-sonnet-5';
