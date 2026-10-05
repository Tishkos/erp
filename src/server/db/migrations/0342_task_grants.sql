-- ===========================================================================
-- Platform phase · Agent 3 — the Task Center: who holds which verb on `task`
-- (2026-10-04). HAND-AUTHORED. Everything additive.
--
--   view, execute, print, export   every role — a colleague can open the Task
--          Center, work what is assigned to them, and take a copy of a task they
--          can see. What a person sees inside it is held by row-level security
--          (0341), not by this grant.
--   create, edit_draft, submit     the roles that lead people — the CEO, the two
--          managers and the project manager. `submit` is the permission to ASSIGN
--          (the vocabulary is closed; it has no "assign"), and even then only to
--          the people their scope reaches (`app_task_scope`, 0341).
--   administer                     the CEO: organisation-wide assignment, and
--          standing in for an assigner. A Super User holds every verb already.
--
-- Copied from the roles that exist, as 0311 did for chat; a role created later
-- is given its verbs on the roles screen. Each user's permissions version moves
-- so a session in progress picks the new grants up.
-- ===========================================================================

INSERT INTO role_grant (role_code, object, verb)
SELECT r.code, 'task', v.verb
  FROM role r
 CROSS JOIN unnest(ARRAY['view', 'execute', 'print', 'export']::permission_verb[]) AS v(verb)
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb)
SELECT r.code, 'task', v.verb
  FROM role r
 CROSS JOIN unnest(ARRAY['create', 'edit_draft', 'submit']::permission_verb[]) AS v(verb)
 WHERE r.code IN ('ceo', 'accounting_manager', 'hr_manager', 'project_manager')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb)
SELECT r.code, 'task', 'administer'::permission_verb
  FROM role r
 WHERE r.code = 'ceo'
ON CONFLICT DO NOTHING;--> statement-breakpoint

UPDATE app_user SET permissions_version = permissions_version + 1;
