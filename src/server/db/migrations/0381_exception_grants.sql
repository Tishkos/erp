-- ===========================================================================
-- Platform phase · Agent 7 — the Exception Center: who holds which verb on
-- `exception` (2026-10-04). HAND-AUTHORED. Everything additive.
--
--   view, print, export   every role — a colleague can open the Exception Center. What a
--          person sees inside it is held twice more: by the grant on the object the finding
--          is about (the accounting manager sees a bank reconciliation difference; the
--          customs officer does not) and by the branch, both in the row-level policy (0380).
--   execute               every role — acknowledge a finding they can see, with a note.
--   administer            the CEO, the accounting manager and the system administrator —
--          "Refresh now": run the detectors outside the schedule. A Super User holds every
--          verb already.
--
-- Copied from the roles that exist, as 0342 did for tasks; a role created later is given
-- its verbs on the roles screen. Each user's permissions version moves so a session in
-- progress picks the new grants up.
-- ===========================================================================

INSERT INTO role_grant (role_code, object, verb)
SELECT r.code, 'exception', v.verb
  FROM role r
 CROSS JOIN unnest(ARRAY['view', 'execute', 'print', 'export']::permission_verb[]) AS v(verb)
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb)
SELECT r.code, 'exception', 'administer'::permission_verb
  FROM role r
 WHERE r.code IN ('ceo', 'accounting_manager', 'system_administrator')
ON CONFLICT DO NOTHING;--> statement-breakpoint

UPDATE app_user SET permissions_version = permissions_version + 1;
