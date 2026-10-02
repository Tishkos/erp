-- ===========================================================================
-- REQ-PM-001 Stage PM-4 — Project System: schedule, progress, earned value
-- (2026-10-02). Over Phase 11 (0148) and PM-1 to PM-3 (0245–0247).
--
--   project.calendar_code          the working calendar the schedule counts
--                                  in (HR-1's working_calendar); none is
--                                  Sunday–Thursday without holidays
--   project_activity               a dated piece of work under an element,
--                                  or a milestone (zero duration) with its
--                                  usage — billing, progress, date (§5);
--                                  the schedule's dates and float written
--                                  by the critical-path pass
--   project_activity_dependency    finish-to-start or start-to-start, with
--                                  a lag; deactivated, never deleted
--   project_milestone_history      each milestone's date as it stood at
--                                  every schedule run — the milestone
--                                  trend analysis (§5, §14)
--   project_progress.activity_id   the milestone whose approval set the
--                                  element's percent (§10)
--
-- Series PROJECT_ACTIVITY is not a document series: activity codes are the
-- project's own (A0010, A0020, …).
-- ===========================================================================

ALTER TABLE "project" ADD COLUMN "calendar_code" text;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_calendar_code_fk" FOREIGN KEY ("calendar_code") REFERENCES "public"."working_calendar"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "scheduled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "scheduled_finish_on" date;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "schedule_run" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

CREATE TABLE "project_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_code" text NOT NULL,
	"wbs_code" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'activity' NOT NULL,
	"milestone_usage" text,
	"progress_percent" numeric(9, 4),
	"duration_days" integer DEFAULT 1 NOT NULL,
	"not_before" date,
	"responsible_user_id" uuid,
	"earliest_start" date,
	"earliest_finish" date,
	"latest_start" date,
	"latest_finish" date,
	"total_float" integer,
	"free_float" integer,
	"is_critical" boolean DEFAULT false NOT NULL,
	"actual_start" date,
	"actual_finish" date,
	"percent_complete" numeric(9, 4) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"reached_on" date,
	"reached_by" uuid,
	"reached_approved_by" uuid,
	"reached_approved_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_activity_code_uniq" UNIQUE ("project_code", "code"),
	CONSTRAINT "project_activity_kind" CHECK ("kind" IN ('activity', 'milestone')),
	CONSTRAINT "project_activity_status" CHECK ("status" IN ('open', 'done', 'cancelled')),
	CONSTRAINT "project_activity_name_present" CHECK (btrim("name") <> ''),
	-- A milestone has no duration and a usage; an activity has a duration and none.
	CONSTRAINT "project_activity_milestone_shape" CHECK (("kind" = 'milestone') = ("duration_days" = 0) AND ("kind" = 'milestone') = ("milestone_usage" IS NOT NULL)),
	CONSTRAINT "project_activity_usage" CHECK ("milestone_usage" IS NULL OR "milestone_usage" IN ('billing', 'progress', 'date')),
	-- A progress milestone names the element's percent it stands for.
	CONSTRAINT "project_activity_progress_percent" CHECK (("milestone_usage" = 'progress') = ("progress_percent" IS NOT NULL) AND ("progress_percent" IS NULL OR "progress_percent" BETWEEN 0 AND 100)),
	CONSTRAINT "project_activity_duration" CHECK ("duration_days" >= 0 AND "duration_days" <= 3650),
	CONSTRAINT "project_activity_percent" CHECK ("percent_complete" BETWEEN 0 AND 100),
	CONSTRAINT "project_activity_actual_order" CHECK ("actual_start" IS NULL OR "actual_finish" IS NULL OR "actual_finish" >= "actual_start"),
	CONSTRAINT "project_activity_done_complete" CHECK ("status" <> 'done' OR ("kind" = 'milestone' AND "reached_approved_at" IS NOT NULL) OR ("kind" = 'activity' AND "actual_finish" IS NOT NULL AND "percent_complete" = 100)),
	CONSTRAINT "project_activity_reached_complete" CHECK (("reached_on" IS NULL) = ("reached_by" IS NULL) AND ("reached_approved_by" IS NULL) = ("reached_approved_at" IS NULL) AND ("reached_approved_at" IS NULL OR "reached_on" IS NOT NULL)),
	-- A milestone is not approved by the person who reported it reached.
	CONSTRAINT "project_activity_reached_four_eyes" CHECK ("reached_approved_by" IS NULL OR "reached_approved_by" <> "reached_by"),
	CONSTRAINT "project_activity_cancel_complete" CHECK (("cancelled_by" IS NULL) = ("cancelled_at" IS NULL) AND ("cancelled_at" IS NULL OR coalesce(btrim("cancel_reason"), '') <> '') AND (("status" = 'cancelled') = ("cancelled_at" IS NOT NULL)))
);--> statement-breakpoint
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_project_code_fk" FOREIGN KEY ("project_code") REFERENCES "public"."project"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_wbs_fk" FOREIGN KEY ("project_code", "wbs_code") REFERENCES "public"."project_wbs"("project_code", "code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_responsible_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_reached_by_fk" FOREIGN KEY ("reached_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_reached_approved_by_fk" FOREIGN KEY ("reached_approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_cancelled_by_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_activity" ADD CONSTRAINT "project_activity_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_activity_element_idx" ON "project_activity" USING btree ("project_code", "wbs_code", "status");--> statement-breakpoint

CREATE TABLE "project_activity_dependency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_code" text NOT NULL,
	"predecessor_id" uuid NOT NULL,
	"successor_id" uuid NOT NULL,
	"kind" text DEFAULT 'FS' NOT NULL,
	"lag_days" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deactivated_by" uuid,
	"deactivated_at" timestamp with time zone,
	CONSTRAINT "project_activity_dependency_kind" CHECK ("kind" IN ('FS', 'SS')),
	CONSTRAINT "project_activity_dependency_not_self" CHECK ("predecessor_id" <> "successor_id"),
	CONSTRAINT "project_activity_dependency_lag" CHECK ("lag_days" BETWEEN -365 AND 365),
	CONSTRAINT "project_activity_dependency_deactivated" CHECK ("active" = ("deactivated_at" IS NULL) AND ("deactivated_by" IS NULL) = ("deactivated_at" IS NULL))
);--> statement-breakpoint
ALTER TABLE "project_activity_dependency" ADD CONSTRAINT "project_activity_dependency_project_code_fk" FOREIGN KEY ("project_code") REFERENCES "public"."project"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_activity_dependency" ADD CONSTRAINT "project_activity_dependency_predecessor_fk" FOREIGN KEY ("predecessor_id") REFERENCES "public"."project_activity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_activity_dependency" ADD CONSTRAINT "project_activity_dependency_successor_fk" FOREIGN KEY ("successor_id") REFERENCES "public"."project_activity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_activity_dependency" ADD CONSTRAINT "project_activity_dependency_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_activity_dependency" ADD CONSTRAINT "project_activity_dependency_deactivated_by_fk" FOREIGN KEY ("deactivated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- One active link between two activities.
CREATE UNIQUE INDEX "project_activity_dependency_uniq" ON "project_activity_dependency" USING btree ("predecessor_id", "successor_id") WHERE "active";--> statement-breakpoint

CREATE TABLE "project_milestone_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_code" text NOT NULL,
	"activity_id" uuid NOT NULL,
	"schedule_run" integer NOT NULL,
	"scheduled_on" date NOT NULL,
	"reason" text,
	"recorded_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_milestone_history_uniq" UNIQUE ("activity_id", "schedule_run")
);--> statement-breakpoint
ALTER TABLE "project_milestone_history" ADD CONSTRAINT "project_milestone_history_project_code_fk" FOREIGN KEY ("project_code") REFERENCES "public"."project"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_milestone_history" ADD CONSTRAINT "project_milestone_history_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."project_activity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_milestone_history" ADD CONSTRAINT "project_milestone_history_recorded_by_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- A trend row is a fact: it is not rewritten. (TRUNCATE, which the test reset
-- and the master-data format use, does not fire row triggers.)
CREATE FUNCTION project_milestone_history_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'A milestone trend row is history; it is not changed or removed.' USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER project_milestone_history_append_only
	BEFORE UPDATE OR DELETE ON project_milestone_history
	FOR EACH ROW EXECUTE FUNCTION project_milestone_history_append_only();--> statement-breakpoint

ALTER TABLE "project_progress" ADD COLUMN "activity_id" uuid;--> statement-breakpoint
ALTER TABLE "project_progress" ADD CONSTRAINT "project_progress_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."project_activity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Row-level security through the project.
DO $$
DECLARE t text;
BEGIN
	FOREACH t IN ARRAY ARRAY['project_activity', 'project_activity_dependency', 'project_milestone_history'] LOOP
		EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
		EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
		EXECUTE format(
			'CREATE POLICY %I ON %I USING (EXISTS (SELECT 1 FROM project p WHERE p.code = project_code)) '
			'WITH CHECK (EXISTS (SELECT 1 FROM project p WHERE p.code = project_code))',
			t || '_scope', t);
	END LOOP;
END $$;--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	GRANT SELECT, INSERT, UPDATE ON "project_activity", "project_activity_dependency" TO erp_app;
	GRANT SELECT, INSERT ON "project_milestone_history" TO erp_app;
END $$;--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
	('project_activity', 'Activity / milestone', 'projects', 'A dated piece of work under a project element, or a milestone with its usage; scheduled by the critical-path pass over its dependencies (REQ-PM-001 §5).')
ON CONFLICT (code) DO NOTHING;
