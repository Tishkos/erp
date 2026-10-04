-- ===========================================================================
-- Platform phase · Agent 10 — Workflow automation: who holds which verb on
-- `automation`, and the approval route a purchase invoice is reviewed on
-- (2026-10-05). HAND-AUTHORED. Everything additive.
--
--   view         the CEO and the system administrator — the rules, their
--                versions, the events and the log of runs.
--   administer   the same two — create a rule from a template, turn it on or
--                off, change it (a new version), switch the whole of automation
--                off, and run the runner now. A Super User holds every verb
--                already; everybody else gets the standard Denied page and the
--                menu item stays hidden.
--
--   A rule runs with its owner's own permissions, not with these: `administer`
--   lets a person SET a rule up; what the rule may then DO is whatever its
--   owner could do by hand (the owning services' checks, again, at run time).
--
--   `ap_invoice` gets an approval route: the review a rule can ask for on a
--   large purchase invoice before it is posted. One step, the accounting
--   manager, never the person who asked (the rule's owner). It is the
--   workflow engine's own (services/workflow.ts); a rule only SUBMITS to it.
--
-- Copied from the roles that exist, as 0381 and 0390 did; a role created later
-- is given the verbs on the roles screen. Each user's permissions version moves
-- so a session in progress picks the grants up.
-- ===========================================================================

INSERT INTO role_grant (role_code, object, verb)
SELECT r.code, 'automation', v.verb
  FROM role r
 CROSS JOIN unnest(ARRAY['view', 'administer']::permission_verb[]) AS v(verb)
 WHERE r.code IN ('ceo', 'system_administrator')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
DECLARE
	definition uuid;
BEGIN
	IF NOT EXISTS (SELECT 1 FROM workflow_definition WHERE document_type_code = 'ap_invoice') THEN
		INSERT INTO workflow_definition (document_type_code, version, is_active)
		VALUES ('ap_invoice', 1, true)
		RETURNING id INTO definition;
		INSERT INTO workflow_step (definition_id, sequence, approver_kind, approver_role, allow_self_approval)
		VALUES (definition, 1, 'role', 'accounting_manager', false);
	END IF;
END $$;--> statement-breakpoint

UPDATE app_user SET permissions_version = permissions_version + 1;
