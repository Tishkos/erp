-- ===========================================================================
-- Platform phase · Agent 10 — Workflow automation: the copy (2026-10-05).
-- HAND-AUTHORED. Additive.
--
--   print, export   the CEO and the system administrator — the two roles that
--                   hold `view` on `automation` (0401). A rule and a run have a
--                   print model like every other record (the printer in the
--                   title bar); the PDF asks `print`, the workbook and the Word
--                   file ask `export`, on the same object the screen reads.
--
-- A Super User holds every verb already. Each user's permissions version moves
-- so a session in progress picks the grants up.
-- ===========================================================================

INSERT INTO role_grant (role_code, object, verb)
SELECT r.code, 'automation', v.verb
  FROM role r
 CROSS JOIN unnest(ARRAY['print', 'export']::permission_verb[]) AS v(verb)
 WHERE r.code IN ('ceo', 'system_administrator')
ON CONFLICT DO NOTHING;--> statement-breakpoint

UPDATE app_user SET permissions_version = permissions_version + 1;
