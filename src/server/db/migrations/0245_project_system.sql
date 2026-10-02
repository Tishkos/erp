-- ===========================================================================
-- REQ-PM-001 Stage PM-1 — Project System: structure and the master screens
-- (2026-10-02). Built over Phase 11 (0148): nothing there is dropped or
-- rewritten; the project gains a type and a status profile, the WBS gains
-- its operative indicators and level, and the configuration becomes master
-- data (R4).
--
--   project_type               customer / internal / investment (§4)
--   project_tolerance_profile  availability control's warn and stop lines (§7)
--   project_cost_code          the cost codes a budget line may use (§7)
--   project (+columns)         type, tolerance profile, the status-profile
--                              dates (released, held, technically complete,
--                              reopened once), forecast dates, description
--   project_wbs (+columns)     level, planning / account-assignment / billing
--                              indicators, active, description
--
-- Role: project_manager (D-PM-6). Series PROJECT → PRJ-{BRANCH}-{YYYY}-{SERIAL}.
-- ===========================================================================

CREATE TABLE "project_type" (
	"code" text PRIMARY KEY NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text,
	"kind" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_type_kind" CHECK ("kind" in ('customer', 'internal', 'investment')),
	CONSTRAINT "project_type_name_present" CHECK (btrim("name_en") <> '')
);--> statement-breakpoint

CREATE TABLE "project_tolerance_profile" (
	"code" text PRIMARY KEY NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text,
	"warn_percent" numeric(9, 4) DEFAULT 90 NOT NULL,
	"stop_percent" numeric(9, 4) DEFAULT 100 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_tolerance_profile_lines" CHECK ("warn_percent" > 0 AND "warn_percent" <= "stop_percent" AND "stop_percent" <= 200)
);--> statement-breakpoint

CREATE TABLE "project_cost_code" (
	"code" text PRIMARY KEY NOT NULL,
	"name_en" text NOT NULL,
	"name_ar" text,
	"account_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_cost_code_name_present" CHECK (btrim("name_en") <> '')
);--> statement-breakpoint

ALTER TABLE "project_type" ADD CONSTRAINT "project_type_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tolerance_profile" ADD CONSTRAINT "project_tolerance_profile_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_cost_code" ADD CONSTRAINT "project_cost_code_account_id_chart_of_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."chart_of_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_cost_code" ADD CONSTRAINT "project_cost_code_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

INSERT INTO "project_type" (code, name_en, name_ar, kind) VALUES
	('CUSTOMER',   'Customer project',   'مشروع لعميل',   'customer'),
	('INTERNAL',   'Internal project',   'مشروع داخلي',   'internal'),
	('INVESTMENT', 'Investment project', 'مشروع استثماري', 'investment')
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

INSERT INTO "project_tolerance_profile" (code, name_en, name_ar, warn_percent, stop_percent) VALUES
	('STANDARD', 'Standard — warn at 90 %, stop at 100 %', 'قياسي — تحذير عند 90٪، إيقاف عند 100٪', 90, 100)
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

INSERT INTO "project_cost_code" (code, name_en, name_ar) VALUES
	('MAT', 'Materials',       'مواد'),
	('LAB', 'Labour',          'عمالة'),
	('SUB', 'Subcontract',     'مقاولة فرعية'),
	('EQP', 'Equipment',       'معدات'),
	('OVH', 'Overheads',       'مصاريف عامة'),
	('FEE', 'Fees and permits', 'رسوم وتراخيص')
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

-- The project definition (§4): type, profile, the status profile's dates.
ALTER TABLE "project" ADD COLUMN "type_code" text DEFAULT 'CUSTOMER' NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "tolerance_profile_code" text DEFAULT 'STANDARD' NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "forecast_starts_on" date;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "forecast_ends_on" date;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "held_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "held_by" uuid;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "held_reason" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "technically_complete_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "technically_complete_by" uuid;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "reopened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "reopened_by" uuid;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "reopened_reason" text;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_type_code_project_type_code_fk" FOREIGN KEY ("type_code") REFERENCES "public"."project_type"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_tolerance_profile_code_fk" FOREIGN KEY ("tolerance_profile_code") REFERENCES "public"."project_tolerance_profile"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_held_by_app_user_id_fk" FOREIGN KEY ("held_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_technically_complete_by_app_user_id_fk" FOREIGN KEY ("technically_complete_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_reopened_by_app_user_id_fk" FOREIGN KEY ("reopened_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_forecast_dates_ordered" CHECK ("forecast_starts_on" IS NULL OR "forecast_ends_on" IS NULL OR "forecast_ends_on" >= "forecast_starts_on");--> statement-breakpoint
-- A hold carries its reason; a reopen carries its reason — both or neither.
ALTER TABLE "project" ADD CONSTRAINT "project_hold_complete" CHECK (("held_at" IS NULL) = ("held_reason" IS NULL));--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_reopen_complete" CHECK (("reopened_at" IS NULL) = ("reopened_reason" IS NULL));--> statement-breakpoint
CREATE INDEX "project_type_idx" ON "project" USING btree ("type_code", "status");--> statement-breakpoint

-- The WBS element (§5): where it sits, and what it may receive.
ALTER TABLE "project_wbs" ADD COLUMN "level" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_wbs" ADD COLUMN "is_planning" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "project_wbs" ADD COLUMN "is_account_assignment" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "project_wbs" ADD COLUMN "is_billing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project_wbs" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "project_wbs" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "project_wbs" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "project_wbs" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "project_wbs" ADD CONSTRAINT "project_wbs_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_wbs" ADD CONSTRAINT "project_wbs_level_range" CHECK ("level" >= 1 AND "level" <= 5);--> statement-breakpoint
-- A level-1 element has no parent; a deeper one has one. The level is the
-- parent's plus one — held by trigger, since a check cannot read the parent.
ALTER TABLE "project_wbs" ADD CONSTRAINT "project_wbs_level_matches_parent" CHECK (("level" = 1) = ("parent_code" IS NULL));--> statement-breakpoint

CREATE FUNCTION project_wbs_level_from_parent() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	v_parent_level smallint;
BEGIN
	IF NEW.parent_code IS NULL THEN
		NEW.level := 1;
	ELSE
		SELECT level INTO v_parent_level FROM project_wbs
		 WHERE project_code = NEW.project_code AND code = NEW.parent_code;
		IF v_parent_level IS NULL THEN
			RAISE EXCEPTION 'WBS element % names a parent % that does not exist on %.', NEW.code, NEW.parent_code, NEW.project_code
				USING ERRCODE = 'foreign_key_violation';
		END IF;
		NEW.level := v_parent_level + 1;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER project_wbs_level_from_parent
	BEFORE INSERT OR UPDATE OF parent_code ON project_wbs
	FOR EACH ROW EXECUTE FUNCTION project_wbs_level_from_parent();--> statement-breakpoint

-- Row-level security on the new master tables, as on every other (0238).
ALTER TABLE "project_type" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_type" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY project_type_scope ON "project_type" USING (app_signed_in()) WITH CHECK (app_signed_in());--> statement-breakpoint
ALTER TABLE "project_tolerance_profile" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_tolerance_profile" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY project_tolerance_profile_scope ON "project_tolerance_profile" USING (app_signed_in()) WITH CHECK (app_signed_in());--> statement-breakpoint
ALTER TABLE "project_cost_code" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_cost_code" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY project_cost_code_scope ON "project_cost_code" USING (app_signed_in()) WITH CHECK (app_signed_in());--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	GRANT SELECT, INSERT, UPDATE ON "project_type", "project_tolerance_profile", "project_cost_code" TO erp_app;
END $$;--> statement-breakpoint

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('PROJECT', 'PRJ', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true)
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
	('project_wbs', 'WBS element', 'projects', 'One element of a project''s work breakdown structure: coded by the mask, saying whether it may be planned, posted to and billed (REQ-PM-001 §5).'),
	('project_setting', 'Project settings', 'projects', 'Project types, tolerance profiles and cost codes — configuration as master data (REQ-PM-001 R4).')
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

INSERT INTO role (code, name, description, is_system, requires_mfa) VALUES
	('project_manager', 'Project Manager', 'Structures, plans and runs projects; approves progress, never their own measurement (REQ-PM-001 D-PM-6).', true, false)
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb)
SELECT 'project_manager', 'project', v.verb
  FROM unnest(ARRAY['view', 'create', 'edit_draft', 'submit', 'post', 'print', 'export']::permission_verb[]) AS v(verb)
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
	('project_manager',      'project_setting', 'view'),
	('accounting_manager',   'project_setting', 'view'),
	('accounting_manager',   'project_setting', 'configure'),
	('system_administrator', 'project_setting', 'view'),
	('system_administrator', 'project_setting', 'configure'),
	('ceo',                  'project',         'view'),
	('ceo',                  'project',         'approve'),
	('ceo',                  'project_setting', 'view')
ON CONFLICT DO NOTHING;
