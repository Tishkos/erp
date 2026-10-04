-- ===========================================================================
-- Platform phase · Agent 3 — the Task Center: the system operator's session (2026-10-04).
-- HAND-AUTHORED. Everything additive; 0341's policy is replaced in place by ALTER POLICY.
--
-- The morning sweep (`scripts/ops/task-sweep.ts`) runs as the system operator in a
-- session flagged super user (`app.is_super_user`), as every other nightly job does,
-- and reads every branch's tasks to decide who is to be told. 0341's policy asked
-- only the visibility function, which looks at the person's roles and scopes: an
-- operator who is a system administrator by role (not a flagged super user) would
-- have seen no task at all and the sweep would have raised nothing without saying so.
--
-- The session flag now opens every task that has left draft. A draft stays its
-- creator's alone: the people it has not been given to have no business in it, and
-- the sweep has none either (a draft is nobody's to chase by date).
-- ===========================================================================

ALTER POLICY task_scope ON "task"
	USING (
		app_task_visible_to(app_current_user(), "status", "created_by", "assigned_by", "assignee_id", "watcher_ids", "department_code", "branch_code")
		OR (app_is_super_user() AND "status" <> 'draft')
	);
