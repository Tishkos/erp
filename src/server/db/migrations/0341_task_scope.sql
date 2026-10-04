-- ===========================================================================
-- Platform phase · Agent 3 — the Task Center: who may assign to whom, who may
-- see what (2026-10-04). HAND-AUTHORED. Everything additive.
--
-- Assignment scope is the heart of the Task Center, and it is decided here,
-- once, in SQL, so that the three places that ask — the assignee dropdown
-- (`app_task_eligible`), the service before it writes, and the trigger below
-- when anything writes — cannot give three answers.
--
--   An assigner may give a task to P, in section S of branch B, when
--     * the assigner holds `submit` on task (the assign permission) and works in B;
--     * S is a section the assigner belongs to (or any section, for `administer`);
--     * P is an active user who holds `view` and `execute` on task and works in B
--       (otherwise the work would land where it cannot be seen or done); and
--     * one of these is true, in this order:
--         self          P is the assigner
--         organisation  the assigner holds `administer` on task
--         department    the assigner manages S (`user_department_scope.is_manager`)
--                       and P is a member of S
--         report        P reports to the assigner, directly or through others, by
--                       the employee record's manager link
--     Nothing else. A manager does not reach the whole company; a report does
--     not assign upward; a colleague in the same section does not assign sideways.
--
--   Verbs on the `task` object (the vocabulary is closed — there is no "assign"):
--     view        open the Task Center; see the tasks one is part of
--     create / edit_draft   raise and edit a draft
--     submit      ASSIGN, reassign, review (complete / return) and cancel what one assigned
--     execute     do the work assigned to one (accept, reject, start, block, resume, hand in)
--     administer  organisation-wide assignment; stands in for an assigner; sees every task of the branch
--
--   Who may SEE a task (the row-level policy): its creator, its assigner, its
--   assignee and its watchers wherever they work; and, in a branch they work
--   in and with `view`, a holder of `administer`, the manager of its section,
--   and whoever the assignee reports to. A draft is its creator's alone.
-- ===========================================================================

-- Does this user hold this verb on tasks? (A super user holds them all.)
CREATE FUNCTION app_task_holds(p_user uuid, p_verb text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT p_user IS NOT NULL AND EXISTS (
		SELECT 1
		  FROM app_user u
		 WHERE u.id = p_user AND u.is_active
		   AND (u.is_super_user OR EXISTS (
				SELECT 1
				  FROM user_role ur
				  JOIN role_grant g ON g.role_code = ur.role_code
				 WHERE ur.user_id = u.id AND g.object = 'task' AND g.verb::text = p_verb
		   ))
	);
$$;--> statement-breakpoint

-- Does this user work in this branch? (A super user works in all.)
CREATE FUNCTION app_task_in_branch(p_user uuid, p_branch text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT p_user IS NOT NULL AND p_branch IS NOT NULL AND EXISTS (
		SELECT 1
		  FROM app_user u
		 WHERE u.id = p_user
		   AND (u.is_super_user OR EXISTS (SELECT 1 FROM user_branch_scope s WHERE s.user_id = u.id AND s.branch_code = p_branch))
	);
$$;--> statement-breakpoint

-- Is this user a member of the section — by the user's department scope, or by the employee record?
CREATE FUNCTION app_task_member(p_user uuid, p_department text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT p_user IS NOT NULL AND p_department IS NOT NULL AND (
		EXISTS (SELECT 1 FROM user_department_scope s WHERE s.user_id = p_user AND s.department_code = p_department)
		OR EXISTS (SELECT 1 FROM employee e WHERE e.app_user_id = p_user AND e.status = 'active' AND e.department_code = p_department)
	);
$$;--> statement-breakpoint

-- Does this user manage the section?
CREATE FUNCTION app_task_manages(p_user uuid, p_department text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT p_user IS NOT NULL AND p_department IS NOT NULL
	   AND EXISTS (SELECT 1 FROM user_department_scope s WHERE s.user_id = p_user AND s.department_code = p_department AND s.is_manager);
$$;--> statement-breakpoint

-- Does the person report to the boss — directly or through others — by the employee records' manager links?
-- The walk is bounded (twelve levels) and a loop in the links ends it.
CREATE FUNCTION app_task_reports_to(p_boss uuid, p_person uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	WITH RECURSIVE chain(manager_id, depth) AS (
		SELECT e.manager_employee_id, 1
		  FROM employee e
		 WHERE e.app_user_id = p_person AND e.status = 'active' AND e.manager_employee_id IS NOT NULL
		UNION
		SELECT m.manager_employee_id, c.depth + 1
		  FROM chain c
		  JOIN employee m ON m.id = c.manager_id
		 WHERE m.manager_employee_id IS NOT NULL AND c.depth < 12
	)
	SELECT p_boss IS NOT NULL AND p_person IS NOT NULL AND p_boss <> p_person AND EXISTS (
		SELECT 1
		  FROM chain c
		  JOIN employee b ON b.id = c.manager_id
		 WHERE b.app_user_id = p_boss AND b.status = 'active'
	);
$$;--> statement-breakpoint

-- The answer: why the assigner may give this section's work to this person, or NULL when they may not.
CREATE FUNCTION app_task_scope(p_actor uuid, p_assignee uuid, p_department text, p_branch text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT CASE
		WHEN p_actor IS NULL OR p_assignee IS NULL OR p_department IS NULL OR p_branch IS NULL THEN NULL
		WHEN NOT app_task_holds(p_actor, 'submit') THEN NULL
		WHEN NOT app_task_in_branch(p_actor, p_branch) THEN NULL
		WHEN NOT EXISTS (SELECT 1 FROM department d WHERE d.code = p_department AND d.active) THEN NULL
		WHEN NOT (app_task_holds(p_actor, 'administer') OR app_task_member(p_actor, p_department)) THEN NULL
		WHEN NOT EXISTS (SELECT 1 FROM app_user u WHERE u.id = p_assignee AND u.is_active) THEN NULL
		WHEN NOT (app_task_holds(p_assignee, 'view') AND app_task_holds(p_assignee, 'execute') AND app_task_in_branch(p_assignee, p_branch)) THEN NULL
		WHEN p_actor = p_assignee THEN 'self'
		WHEN app_task_holds(p_actor, 'administer') THEN 'organisation'
		WHEN app_task_manages(p_actor, p_department) AND app_task_member(p_assignee, p_department) THEN 'department'
		WHEN app_task_reports_to(p_actor, p_assignee) THEN 'report'
		ELSE NULL
	END;
$$;--> statement-breakpoint

CREATE FUNCTION app_task_may_assign(p_actor uuid, p_assignee uuid, p_department text, p_branch text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT app_task_scope(p_actor, p_assignee, p_department, p_branch) IS NOT NULL;
$$;--> statement-breakpoint

-- The sections the assigner may raise a task in.
CREATE FUNCTION app_task_sections(p_actor uuid) RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT d.code
	  FROM department d
	 WHERE d.active AND p_actor IS NOT NULL AND app_task_holds(p_actor, 'submit')
	   AND (app_task_holds(p_actor, 'administer') OR app_task_member(p_actor, d.code))
	 ORDER BY d.code;
$$;--> statement-breakpoint

-- The people the assigner may assign to, with why: what the dropdown lists.
CREATE FUNCTION app_task_eligible(p_actor uuid, p_department text, p_branch text) RETURNS TABLE (user_id uuid, via text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT s.id, s.via
	  FROM (
		SELECT u.id, app_task_scope(p_actor, u.id, p_department, p_branch) AS via
		  FROM app_user u
		 WHERE u.is_active
	  ) s
	 WHERE s.via IS NOT NULL;
$$;--> statement-breakpoint

-- May this person be named a watcher (can they open the task)?
CREATE FUNCTION app_task_may_watch(p_user uuid, p_branch text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT p_user IS NOT NULL AND EXISTS (SELECT 1 FROM app_user u WHERE u.id = p_user AND u.is_active)
	   AND app_task_holds(p_user, 'view') AND app_task_in_branch(p_user, p_branch);
$$;--> statement-breakpoint

-- May this user open this task? The row-level policy asks it of the session's user; the
-- notification step asks it of each person it is about to tell (with the values it has just
-- written, so the answer does not depend on what is committed).
CREATE FUNCTION app_task_visible_to(
	p_user uuid, p_status text, p_created_by uuid, p_assigned_by uuid, p_assignee uuid,
	p_watchers uuid[], p_department text, p_branch text
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT CASE
		WHEN p_user IS NULL THEN false
		WHEN p_status = 'draft' THEN p_created_by = p_user
		WHEN p_user IN (p_created_by, p_assigned_by, p_assignee) THEN true
		WHEN p_user = ANY (coalesce(p_watchers, '{}'::uuid[])) THEN true
		WHEN NOT app_task_in_branch(p_user, p_branch) OR NOT app_task_holds(p_user, 'view') THEN false
		ELSE app_task_holds(p_user, 'administer')
		  OR app_task_manages(p_user, p_department)
		  OR app_task_reports_to(p_user, p_assignee)
	END;
$$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The trigger that holds the assignee's scope. It runs beside `task_lifecycle_guard`
-- (0340) on every insert and update: a statement that gives the task to somebody
-- outside the assigner's scope is refused here, whatever code wrote it.
-- ---------------------------------------------------------------------------
CREATE FUNCTION task_assignment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	actor uuid := app_current_user();
	stranger uuid;
BEGIN
	IF TG_OP = 'INSERT' OR NEW.watcher_ids IS DISTINCT FROM OLD.watcher_ids THEN
		SELECT w INTO stranger FROM unnest(NEW.watcher_ids) AS w WHERE NOT app_task_may_watch(w, NEW.branch_code) LIMIT 1;
		IF stranger IS NOT NULL THEN
			RAISE EXCEPTION '%: a watcher must be somebody who can open the task.', NEW.task_no USING ERRCODE = 'check_violation';
		END IF;
	END IF;

	IF NEW.status = 'assigned' AND actor IS NOT NULL AND (
		TG_OP = 'INSERT' OR OLD.status <> 'assigned'
		OR NEW.assignee_id IS DISTINCT FROM OLD.assignee_id OR NEW.department_code <> OLD.department_code
	) THEN
		IF NEW.assigned_by IS DISTINCT FROM actor THEN
			RAISE EXCEPTION '%: a task is assigned by the person assigning it.', NEW.task_no USING ERRCODE = 'check_violation';
		END IF;
		IF app_task_scope(actor, NEW.assignee_id, NEW.department_code, NEW.branch_code) IS NULL THEN
			RAISE EXCEPTION '%: that person is outside the scope you may assign to in this section.', NEW.task_no USING ERRCODE = 'check_violation';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "task_assignment_guard"
	BEFORE INSERT OR UPDATE ON "task"
	FOR EACH ROW EXECUTE FUNCTION task_assignment_guard();--> statement-breakpoint
CREATE TRIGGER "task_lifecycle_guard"
	BEFORE INSERT OR UPDATE ON "task"
	FOR EACH ROW EXECUTE FUNCTION task_lifecycle_guard();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Row-level security. FORCE, like the other documents.
-- ---------------------------------------------------------------------------
ALTER TABLE "task" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "task" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY task_scope ON "task"
	USING (app_task_visible_to(app_current_user(), "status", "created_by", "assigned_by", "assignee_id", "watcher_ids", "department_code", "branch_code"))
	WITH CHECK (
		app_current_user() IS NOT NULL AND (
			"created_by" = app_current_user() OR "assigned_by" = app_current_user() OR "assignee_id" = app_current_user()
			OR (app_task_holds(app_current_user(), 'administer') AND app_branch_allowed("branch_code"))
		)
	);--> statement-breakpoint

DO $$
DECLARE
	fn text;
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	FOREACH fn IN ARRAY ARRAY[
		'app_task_holds(uuid, text)',
		'app_task_in_branch(uuid, text)',
		'app_task_member(uuid, text)',
		'app_task_manages(uuid, text)',
		'app_task_reports_to(uuid, uuid)',
		'app_task_scope(uuid, uuid, text, text)',
		'app_task_may_assign(uuid, uuid, text, text)',
		'app_task_sections(uuid)',
		'app_task_eligible(uuid, text, text)',
		'app_task_may_watch(uuid, text)',
		'app_task_visible_to(uuid, text, uuid, uuid, uuid, uuid[], text, text)'
	] LOOP
		EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO erp_app', fn);
	END LOOP;
END $$;
