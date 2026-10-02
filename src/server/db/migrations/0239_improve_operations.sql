-- ===========================================================================
-- REQ-IMPROVE-001 Stage 1 — Operations (OP-4).
--
-- The "Background Jobs" and "Backup and Health" screens the menu has
-- promised since Phase 0 are delivered. The System Administrator maintains
-- the system, so the role that holds every other administration object
-- holds these two; the accounting managers, who receive the daily health
-- notice, may read the same screen it summarises.
--
-- Deny-by-default is unchanged: a grant is a row here, and nothing else.
-- ===========================================================================

INSERT INTO role_grant (role_code, object, verb)
SELECT 'system_administrator', o.object, v.verb
  FROM unnest(ARRAY['job', 'system_health']) AS o(object)
 CROSS JOIN unnest(ARRAY['view', 'administer', 'execute', 'export']::permission_verb[]) AS v(verb)
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_manager', 'system_health', 'view')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- /healthz (OP-4, IM3) answers "the migrations are at head" by counting the
-- migrator's own table, as the application role. The schema was the owner's
-- alone, so the probe — and the footer badge that reads it — said "behind".
GRANT USAGE ON SCHEMA drizzle TO erp_app;--> statement-breakpoint
GRANT SELECT ON drizzle.__drizzle_migrations TO erp_app;
