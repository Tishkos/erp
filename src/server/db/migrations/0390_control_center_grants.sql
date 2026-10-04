-- ===========================================================================
-- Platform phase · Agent 9 — the ERP Control Center: who may open it
-- (2026-10-04). HAND-AUTHORED. Everything additive; no table is created.
--
--   view   the CEO, the accounting manager and the system administrator — the
--          three roles that answer for "is the system healthy". A Super User
--          holds every verb already; everybody else gets the standard Denied
--          page and the menu item stays hidden.
--
-- The grant opens the SCREEN only. What a check may read is held again, per
-- check, by the grant on the screen it summarises (the trial balance check by
-- `trial_balance`, the payables checks by `ap_invoice`, …) and by the viewer's
-- branches in row-level security: a figure the viewer may not see is not shown,
-- and the check says it was not checked rather than printing a zero. The
-- Control Center writes nothing, so it needs no other verb.
--
-- Copied from the roles that exist, as 0381 did for the Exception Center; a
-- role created later is given the verb on the roles screen. Each user's
-- permissions version moves so a session in progress picks the grant up.
-- ===========================================================================

INSERT INTO role_grant (role_code, object, verb)
SELECT r.code, 'control_center', 'view'::permission_verb
  FROM role r
 WHERE r.code IN ('ceo', 'accounting_manager', 'system_administrator')
ON CONFLICT DO NOTHING;--> statement-breakpoint

UPDATE app_user SET permissions_version = permissions_version + 1;
