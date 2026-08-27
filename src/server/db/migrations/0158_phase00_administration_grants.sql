-- ===========================================================================
-- Phase 0 — the administration screens read and write real data.
--
-- Until now only `is_super_user` opened Company, Users, Roles, Permissions,
-- Numbering and the Audit Trail: no role carried a grant on those objects.
-- This adds the System Administrator role the PDF's requirement 4 and 5 need
-- ("users can be created … access can be assigned by system section and
-- permitted action"), and gives the two finance roles a view on the approvals
-- inbox and the organisation structure they work inside.
--
-- Deny-by-default is unchanged: a grant is a row here, and nothing else.
-- ===========================================================================

INSERT INTO role (code, name, description, is_system) VALUES
  ('system_administrator', 'System Administrator',
   'Maintains the organisation structure, users, roles and numbering. Holds no business verbs (§5.5).', true)
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb)
SELECT 'system_administrator', o.object, v.verb
  FROM unnest(ARRAY[
         'company', 'branch', 'department', 'app_user', 'user_department_scope',
         'role', 'permission', 'data_scope', 'number_series', 'audit_event',
         'workflow_instance', 'warehouse', 'bank_cash_account', 'organisation'
       ]) AS o(object)
 CROSS JOIN unnest(ARRAY['view', 'create', 'configure', 'administer', 'export']::permission_verb[]) AS v(verb)
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- The finance roles see the organisation they work in, and their own inbox.
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'workflow_instance', 'view'),
  ('accounting_officer', 'branch',            'view'),
  ('accounting_officer', 'department',        'view'),
  ('accounting_manager', 'workflow_instance', 'view'),
  ('accounting_manager', 'workflow_instance', 'approve'),
  ('accounting_manager', 'department',        'view')
ON CONFLICT DO NOTHING;
