-- ===========================================================================
-- Platform phase, Agent 4 — who may use the Document Center.
-- HAND-AUTHORED. Everything additive.
--
-- Two objects:
--
--   cloud_files    the Document Center and the links on a record. `view` browses
--                  and opens (as the person's own cloud account — the cloud
--                  still decides what that account sees); `create` uploads,
--                  makes folders and links a file to a record.
--   cloud_setting  the integration's settings screen: the address, on/off, the
--                  role -> group mapping. `view` opens it, `configure` changes it.
--
-- The Document Center used to ask `attachment` (it was a front-end preview
-- over nothing). Whoever could use the paperclip keeps the Document Center:
-- the grants are COPIED from `attachment`, so the roles the live database was
-- given by hand are covered too, and nobody gains a power they did not have.
-- Settings go to the roles that could `configure` attachments, to the CEO
-- (who administers roles) and to the system administrator.
-- ===========================================================================

INSERT INTO role_grant (role_code, object, verb)
SELECT DISTINCT g.role_code, 'cloud_files', g.verb
  FROM role_grant g
 WHERE g.object = 'attachment' AND g.verb IN ('view', 'create')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb)
SELECT DISTINCT g.role_code, 'cloud_setting', v.verb
  FROM role_grant g
 CROSS JOIN (VALUES ('view'::permission_verb), ('configure'::permission_verb)) AS v(verb)
 WHERE g.object = 'attachment' AND g.verb = 'configure'
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb)
SELECT r.code, o.object, o.verb
  FROM role r
 CROSS JOIN (VALUES
	('cloud_files',   'view'::permission_verb),
	('cloud_files',   'create'::permission_verb),
	('cloud_setting', 'view'::permission_verb),
	('cloud_setting', 'configure'::permission_verb)
 ) AS o(object, verb)
 WHERE r.code IN ('system_administrator')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb)
SELECT r.code, o.object, o.verb
  FROM role r
 CROSS JOIN (VALUES
	('cloud_setting', 'view'::permission_verb),
	('cloud_setting', 'configure'::permission_verb)
 ) AS o(object, verb)
 WHERE r.code = 'ceo'
ON CONFLICT DO NOTHING;
