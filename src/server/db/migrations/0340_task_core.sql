-- ===========================================================================
-- Platform phase · Agent 3 — the Task Center: the task itself (2026-10-04).
-- HAND-AUTHORED. Everything additive; no applied migration is touched.
--
--   task   TASK-{SERIAL}: a piece of work one person asks another to do, in a
--          section (a department) and a branch, with a priority, a due date,
--          the ERP record it concerns, tags and watchers.
--
--          draft → assigned → accepted → in_progress ⇄ blocked
--          in_progress → submitted → completed         (the assigner reviews)
--          submitted → in_progress                     (returned, with a reason)
--          assigned → rejected → assigned              (refused by the assignee, reassigned)
--          any live status → cancelled                 (with a reason)
--          completed and cancelled are final.
--
--   The road is held HERE, by `task_lifecycle_guard`, as well as by
--   `domain/tasks.ts` — `tests/unit/task-center.test.ts` reads the pair list
--   below and fails when the two disagree. The trigger also holds WHO takes
--   each step (the assignee accepts, rejects, starts, blocks, resumes and
--   submits; the assigner — or a holder of `administer` — completes, returns
--   and reassigns; the creator or assigner cancels), that a step which says
--   why carries its reason, that the moments are the database's own
--   (`assigned_at`, `accepted_at`, … are stamped here, never supplied), and
--   — in 0341 — that the assignee is somebody the assigner may assign to.
--
--   Tasks are documents: never deleted (`task_no_delete`).
-- ===========================================================================

CREATE TABLE "task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_no" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text NOT NULL DEFAULT 'draft',
	"priority" text NOT NULL DEFAULT 'normal',
	"department_code" text NOT NULL REFERENCES "department"("code"),
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"assigned_by" uuid REFERENCES "app_user"("id"),
	"assignee_id" uuid REFERENCES "app_user"("id"),
	"due_date" date,
	"related_type" text,
	"related_id" text,
	"related_label" text,
	"tags" text[] NOT NULL DEFAULT '{}',
	"watcher_ids" uuid[] NOT NULL DEFAULT '{}',
	"status_note" text,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	"assigned_at" timestamptz,
	"accepted_at" timestamptz,
	"started_at" timestamptz,
	"blocked_at" timestamptz,
	"submitted_at" timestamptz,
	"completed_at" timestamptz,
	"cancelled_at" timestamptz,
	CONSTRAINT "task_status_known" CHECK ("status" IN ('draft', 'assigned', 'accepted', 'in_progress', 'blocked', 'submitted', 'completed', 'rejected', 'cancelled')),
	CONSTRAINT "task_priority_known" CHECK ("priority" IN ('low', 'normal', 'high', 'urgent')),
	CONSTRAINT "task_title_length" CHECK (char_length(btrim("title")) BETWEEN 3 AND 200),
	CONSTRAINT "task_description_length" CHECK ("description" IS NULL OR char_length("description") <= 4000),
	CONSTRAINT "task_tags_bounded" CHECK (cardinality("tags") <= 8),
	CONSTRAINT "task_watchers_bounded" CHECK (cardinality("watcher_ids") <= 10),
	CONSTRAINT "task_related_together" CHECK (("related_type" IS NULL) = ("related_id" IS NULL) AND ("related_type" IS NULL) = ("related_label" IS NULL)),
	-- Once it has been given to somebody it names who gave it and who has it.
	CONSTRAINT "task_assigned_has_people" CHECK ("status" IN ('draft', 'cancelled') OR ("assignee_id" IS NOT NULL AND "assigned_by" IS NOT NULL AND "assigned_at" IS NOT NULL)),
	-- A block, a rejection and a cancellation each say why.
	CONSTRAINT "task_note_required" CHECK ("status" NOT IN ('blocked', 'rejected', 'cancelled') OR nullif(btrim("status_note"), '') IS NOT NULL),
	-- The timeline agrees with the status.
	CONSTRAINT "task_timeline_accepted" CHECK ("status" NOT IN ('accepted', 'in_progress', 'blocked', 'submitted', 'completed') OR "accepted_at" IS NOT NULL),
	CONSTRAINT "task_timeline_started" CHECK ("status" NOT IN ('in_progress', 'blocked', 'submitted', 'completed') OR "started_at" IS NOT NULL),
	CONSTRAINT "task_timeline_submitted" CHECK ("status" NOT IN ('submitted', 'completed') OR "submitted_at" IS NOT NULL),
	CONSTRAINT "task_timeline_completed" CHECK ("status" <> 'completed' OR "completed_at" IS NOT NULL),
	CONSTRAINT "task_timeline_cancelled" CHECK ("status" <> 'cancelled' OR "cancelled_at" IS NOT NULL),
	CONSTRAINT "task_timeline_blocked" CHECK (("status" = 'blocked') = ("blocked_at" IS NOT NULL)),
	CONSTRAINT "task_timeline_assigned" CHECK ("status" NOT IN ('assigned', 'rejected') OR ("accepted_at" IS NULL AND "started_at" IS NULL AND "submitted_at" IS NULL)),
	CONSTRAINT "task_timeline_working" CHECK ("status" NOT IN ('in_progress', 'blocked') OR "submitted_at" IS NULL)
);--> statement-breakpoint
CREATE UNIQUE INDEX "task_no_uniq" ON "task" ("task_no");--> statement-breakpoint
CREATE INDEX "task_assignee_idx" ON "task" ("assignee_id", "status") WHERE "assignee_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "task_creator_idx" ON "task" ("created_by", "status");--> statement-breakpoint
CREATE INDEX "task_assigner_idx" ON "task" ("assigned_by", "status") WHERE "assigned_by" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "task_department_idx" ON "task" ("department_code", "status");--> statement-breakpoint
CREATE INDEX "task_branch_idx" ON "task" ("branch_code", "status");--> statement-breakpoint
CREATE INDEX "task_due_idx" ON "task" ("due_date") WHERE "status" IN ('assigned', 'accepted', 'in_progress', 'blocked') AND "due_date" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "task_recent_idx" ON "task" ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "task_related_idx" ON "task" ("related_type", "related_id") WHERE "related_type" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "task_watchers_idx" ON "task" USING gin ("watcher_ids");--> statement-breakpoint

-- Never deleted.
CREATE FUNCTION task_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'A task is never deleted (%); cancel it with a reason.', OLD.task_no USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "task_no_delete"
	BEFORE DELETE ON "task"
	FOR EACH ROW EXECUTE FUNCTION task_no_delete();--> statement-breakpoint

-- The road, who walks it, what each step says, and the moments the database stamps.
-- The assignee's scope is checked by `task_assignment_guard` (0341), which needs the scope functions.
CREATE FUNCTION task_lifecycle_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	actor uuid := app_current_user();
	moved boolean;
	giving boolean;
	administers boolean;
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.status <> 'draft' THEN
			RAISE EXCEPTION 'A task starts as a draft (%).', NEW.task_no USING ERRCODE = 'check_violation';
		END IF;
		IF actor IS NOT NULL AND NEW.created_by <> actor THEN
			RAISE EXCEPTION 'A task is raised by the person raising it (%).', NEW.task_no USING ERRCODE = 'check_violation';
		END IF;
		NEW.assigned_by := NULL;
		NEW.assigned_at := NULL;
		NEW.accepted_at := NULL;
		NEW.started_at := NULL;
		NEW.blocked_at := NULL;
		NEW.submitted_at := NULL;
		NEW.completed_at := NULL;
		NEW.cancelled_at := NULL;
		NEW.created_at := now();
		NEW.updated_at := now();
		RETURN NEW;
	END IF;

	IF OLD.status IN ('completed', 'cancelled') THEN
		RAISE EXCEPTION '% is % and is final.', OLD.task_no, OLD.status USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.task_no <> OLD.task_no OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at OR NEW.branch_code <> OLD.branch_code THEN
		RAISE EXCEPTION '%: the number, the creator, the branch and the creation time never change.', OLD.task_no USING ERRCODE = 'check_violation';
	END IF;

	moved := NEW.status <> OLD.status;
	IF moved AND NOT EXISTS (
		SELECT 1
		  FROM (VALUES
			-- allowed pairs (from, to) — mirrored by domain/tasks.ts › allowedPairs()
			('accepted', 'assigned'),
			('accepted', 'cancelled'),
			('accepted', 'in_progress'),
			('assigned', 'accepted'),
			('assigned', 'assigned'),
			('assigned', 'cancelled'),
			('assigned', 'rejected'),
			('blocked', 'assigned'),
			('blocked', 'cancelled'),
			('blocked', 'in_progress'),
			('draft', 'assigned'),
			('draft', 'cancelled'),
			('in_progress', 'assigned'),
			('in_progress', 'blocked'),
			('in_progress', 'cancelled'),
			('in_progress', 'submitted'),
			('rejected', 'assigned'),
			('rejected', 'cancelled'),
			('submitted', 'cancelled'),
			('submitted', 'completed'),
			('submitted', 'in_progress')
		  ) AS p(from_status, to_status)
		 WHERE p.from_status = OLD.status AND p.to_status = NEW.status
	) THEN
		RAISE EXCEPTION '% is %; it cannot become %.', OLD.task_no, OLD.status, NEW.status USING ERRCODE = 'check_violation';
	END IF;

	-- Whom it is for changes only when it is given (assigned or reassigned) — or while still a draft.
	giving := NEW.status = 'assigned' AND (OLD.status <> 'assigned' OR NEW.assignee_id IS DISTINCT FROM OLD.assignee_id OR NEW.department_code <> OLD.department_code);
	IF (NEW.assignee_id IS DISTINCT FROM OLD.assignee_id OR NEW.department_code <> OLD.department_code OR NEW.assigned_by IS DISTINCT FROM OLD.assigned_by)
	   AND OLD.status <> 'draft' AND NOT giving THEN
		RAISE EXCEPTION '%: the assignee, the section and the assigner change only when the task is reassigned.', OLD.task_no USING ERRCODE = 'check_violation';
	END IF;
	IF giving AND OLD.status NOT IN ('draft', 'rejected') AND NEW.assignee_id IS NOT DISTINCT FROM OLD.assignee_id AND NEW.department_code = OLD.department_code THEN
		RAISE EXCEPTION '%: a reassignment names somebody else.', OLD.task_no USING ERRCODE = 'check_violation';
	END IF;

	-- Who takes the step. A session without a user (a migration, the owner's own repair) is not asked.
	IF actor IS NOT NULL AND (moved OR giving) THEN
		administers := app_task_holds(actor, 'administer');
		IF OLD.status = 'draft' AND NEW.status = 'assigned' THEN
			IF actor <> OLD.created_by THEN RAISE EXCEPTION '%: only the person who raised it assigns a draft.', OLD.task_no USING ERRCODE = 'check_violation'; END IF;
		ELSIF NEW.status = 'cancelled' THEN
			IF actor IS DISTINCT FROM OLD.created_by AND actor IS DISTINCT FROM OLD.assigned_by AND NOT administers THEN
				RAISE EXCEPTION '%: only the person who raised or assigned it cancels it.', OLD.task_no USING ERRCODE = 'check_violation';
			END IF;
		ELSIF NEW.status = 'assigned' THEN
			IF actor IS DISTINCT FROM OLD.assigned_by AND NOT administers THEN
				RAISE EXCEPTION '%: only the person who assigned it reassigns it.', OLD.task_no USING ERRCODE = 'check_violation';
			END IF;
		ELSIF OLD.status = 'submitted' THEN
			IF actor IS DISTINCT FROM OLD.assigned_by AND NOT administers THEN
				RAISE EXCEPTION '%: only the person who assigned it completes it or returns it.', OLD.task_no USING ERRCODE = 'check_violation';
			END IF;
		ELSE
			IF actor IS DISTINCT FROM OLD.assignee_id THEN
				RAISE EXCEPTION '%: only the person it is assigned to does that.', OLD.task_no USING ERRCODE = 'check_violation';
			END IF;
		END IF;
	END IF;

	-- What the task says is the raiser's, then the assigner's (or an administrator's) — not the assignee's.
	IF actor IS NOT NULL AND NOT giving AND (
		NEW.title IS DISTINCT FROM OLD.title OR NEW.description IS DISTINCT FROM OLD.description OR NEW.priority IS DISTINCT FROM OLD.priority
		OR NEW.due_date IS DISTINCT FROM OLD.due_date OR NEW.related_type IS DISTINCT FROM OLD.related_type OR NEW.related_id IS DISTINCT FROM OLD.related_id
		OR NEW.tags IS DISTINCT FROM OLD.tags
	) THEN
		IF OLD.status = 'draft' THEN
			IF actor <> OLD.created_by THEN RAISE EXCEPTION '%: only the person who raised it edits a draft.', OLD.task_no USING ERRCODE = 'check_violation'; END IF;
		ELSIF actor IS DISTINCT FROM OLD.assigned_by AND actor IS DISTINCT FROM OLD.created_by AND NOT app_task_holds(actor, 'administer') THEN
			RAISE EXCEPTION '%: only the person who raised or assigned it changes what it says.', OLD.task_no USING ERRCODE = 'check_violation';
		END IF;
	END IF;

	-- A reassignment, a return and a refusal say why (a block and a cancellation: task_note_required).
	IF (moved OR giving) AND ((NEW.status = 'assigned' AND OLD.status <> 'draft') OR (OLD.status = 'submitted' AND NEW.status = 'in_progress')) AND nullif(btrim(NEW.status_note), '') IS NULL THEN
		RAISE EXCEPTION '%: say why.', OLD.task_no USING ERRCODE = 'check_violation';
	END IF;

	-- The moments are the database's: whatever the statement supplied is put back, then the step stamps its own.
	NEW.assigned_at := OLD.assigned_at;
	NEW.accepted_at := OLD.accepted_at;
	NEW.started_at := OLD.started_at;
	NEW.blocked_at := OLD.blocked_at;
	NEW.submitted_at := OLD.submitted_at;
	NEW.completed_at := OLD.completed_at;
	NEW.cancelled_at := OLD.cancelled_at;
	IF giving THEN
		NEW.assigned_at := now();
		NEW.accepted_at := NULL;
		NEW.started_at := NULL;
		NEW.submitted_at := NULL;
		NEW.blocked_at := NULL;
	END IF;
	IF moved THEN
		IF NEW.status = 'accepted' THEN NEW.accepted_at := now(); END IF;
		IF NEW.status = 'in_progress' AND OLD.status = 'accepted' THEN NEW.started_at := now(); END IF;
		IF NEW.status = 'in_progress' AND OLD.status = 'submitted' THEN NEW.submitted_at := NULL; END IF;
		IF NEW.status = 'in_progress' AND OLD.status = 'blocked' THEN NEW.blocked_at := NULL; END IF;
		IF NEW.status = 'blocked' THEN NEW.blocked_at := now(); END IF;
		IF NEW.status = 'submitted' THEN NEW.submitted_at := now(); END IF;
		IF NEW.status = 'completed' THEN NEW.completed_at := now(); END IF;
		IF NEW.status = 'cancelled' THEN NEW.cancelled_at := now(); NEW.blocked_at := NULL; END IF;
	END IF;
	NEW.updated_at := now();
	RETURN NEW;
END;
$$;--> statement-breakpoint

-- Row security and the scope functions this trigger names arrive in 0341; the
-- trigger is created there too, once the functions exist.

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	-- Never deleted: no DELETE for the application.
	GRANT SELECT, INSERT, UPDATE ON "task" TO erp_app;
END $$;--> statement-breakpoint

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('TASK', 'TASK', '{PREFIX}-{SERIAL}', 3, false, false)
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
	('task', 'Task', 'home', 'A piece of work one person asks another to do — accepted, worked, handed in and reviewed (Task Center).')
ON CONFLICT (code) DO NOTHING;
