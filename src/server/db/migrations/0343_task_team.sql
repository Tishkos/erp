-- ===========================================================================
-- Platform phase · Agent 3 — the Task Center: who has a team (2026-10-04).
-- HAND-AUTHORED. Everything additive.
--
-- The Team view of the Task Center is shown to a person who leads somebody:
-- a holder of `administer` on tasks, the manager of a section, or the manager
-- of at least one active employee (the employee record's manager link). The
-- screen asks this one function, so "only where permitted" has one meaning;
-- what the person then sees is still held by the row-level policy (0341).
-- ===========================================================================

CREATE FUNCTION app_task_leads(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT p_user IS NOT NULL AND app_task_holds(p_user, 'view') AND (
		app_task_holds(p_user, 'administer')
		OR EXISTS (SELECT 1 FROM user_department_scope s WHERE s.user_id = p_user AND s.is_manager)
		OR EXISTS (
			SELECT 1
			  FROM employee r
			  JOIN employee m ON m.id = r.manager_employee_id
			 WHERE m.app_user_id = p_user AND m.status = 'active' AND r.status = 'active'
		)
	);
$$;--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	GRANT EXECUTE ON FUNCTION app_task_leads(uuid) TO erp_app;
END $$;
