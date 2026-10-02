-- ===========================================================================
-- REQ-PM-001 Stage PM-2 — Project System: planning, budget documents and
-- availability control (2026-10-02). Over Phase 11 (0148) and PM-1 (0245).
--
--   project_plan_version        the cost plan's versions: 0 the original,
--                               1…n the re-plans; one is current (§7)
--   project_plan_line           element × cost code × month — the spread
--                               BCWS reads (§7, §10)
--   project_budget_document     original / supplement / return / transfer,
--                               raised by one person and approved by
--                               another; the budget by element is the sum
--                               of the approved ones (§7, PM4)
--   project_budget_document_line  one element and cost code per line, a
--                               signed amount; a transfer's lines sum to 0
--   project_variation_line      what a change order moves, element by
--                               element — the supplement it raises (§7)
--   project_commitment.wbs_code the element a commitment stands on, so
--                               availability is read per element (§8)
--   project_wbs.stop_percent_raised  the stop line raised for one element
--                               with a reason, by whom and when (§7, D-PM-5)
--   project_variation (+columns) scope and schedule effect, a rejection
--
-- Series PROJECT_BUDGET → PBD-{BRANCH}-{YYYY}-{SERIAL}; change orders keep
-- Phase 11's PROJECT_VARIATION (PVR-…), now allocated by the service.
-- ===========================================================================

CREATE TABLE "project_plan_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_code" text NOT NULL,
	"version" smallint NOT NULL,
	"name" text NOT NULL,
	"note" text,
	"is_current" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_plan_version_uniq" UNIQUE ("project_code", "version"),
	CONSTRAINT "project_plan_version_number" CHECK ("version" >= 0),
	CONSTRAINT "project_plan_version_name_present" CHECK (btrim("name") <> '')
);--> statement-breakpoint
ALTER TABLE "project_plan_version" ADD CONSTRAINT "project_plan_version_project_code_fk" FOREIGN KEY ("project_code") REFERENCES "public"."project"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_plan_version" ADD CONSTRAINT "project_plan_version_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- One current version per project.
CREATE UNIQUE INDEX "project_plan_version_current_uniq" ON "project_plan_version" USING btree ("project_code") WHERE "is_current";--> statement-breakpoint

CREATE TABLE "project_plan_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_code" text NOT NULL,
	"version_id" uuid NOT NULL,
	"wbs_code" text NOT NULL,
	"cost_code" text NOT NULL,
	"period" date NOT NULL,
	"amount_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_plan_line_uniq" UNIQUE ("version_id", "wbs_code", "cost_code", "period"),
	CONSTRAINT "project_plan_line_amount_not_negative" CHECK ("amount_iqd" >= 0),
	CONSTRAINT "project_plan_line_period_is_month" CHECK ("period" = date_trunc('month', "period")::date)
);--> statement-breakpoint
ALTER TABLE "project_plan_line" ADD CONSTRAINT "project_plan_line_project_code_fk" FOREIGN KEY ("project_code") REFERENCES "public"."project"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_plan_line" ADD CONSTRAINT "project_plan_line_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."project_plan_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_plan_line" ADD CONSTRAINT "project_plan_line_wbs_fk" FOREIGN KEY ("project_code", "wbs_code") REFERENCES "public"."project_wbs"("project_code", "code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_plan_line" ADD CONSTRAINT "project_plan_line_cost_code_fk" FOREIGN KEY ("cost_code") REFERENCES "public"."project_cost_code"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_plan_line" ADD CONSTRAINT "project_plan_line_updated_by_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_plan_line_project_idx" ON "project_plan_line" USING btree ("project_code", "wbs_code", "period");--> statement-breakpoint

CREATE TABLE "project_budget_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_no" text NOT NULL,
	"project_code" text NOT NULL,
	"kind" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"raised_on" date NOT NULL,
	"description" text NOT NULL,
	"variation_id" uuid,
	"total_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"created_by" uuid NOT NULL,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"rejected_by" uuid,
	"rejected_at" timestamp with time zone,
	"rejected_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_budget_document_no_uniq" UNIQUE ("document_no"),
	CONSTRAINT "project_budget_document_kind" CHECK ("kind" IN ('original', 'supplement', 'return', 'transfer')),
	CONSTRAINT "project_budget_document_status" CHECK ("status" IN ('draft', 'submitted', 'approved', 'rejected')),
	CONSTRAINT "project_budget_document_description_present" CHECK (btrim("description") <> ''),
	CONSTRAINT "project_budget_document_submitted_complete" CHECK (("submitted_by" IS NULL) = ("submitted_at" IS NULL)),
	CONSTRAINT "project_budget_document_approved_complete" CHECK (("approved_by" IS NULL) = ("approved_at" IS NULL)),
	CONSTRAINT "project_budget_document_rejected_complete" CHECK (("rejected_by" IS NULL) = ("rejected_at" IS NULL) AND ("rejected_at" IS NULL OR coalesce(btrim("rejected_reason"), '') <> '')),
	-- PM4 — a document is not approved by its raiser.
	CONSTRAINT "project_budget_document_four_eyes" CHECK ("approved_by" IS NULL OR "approved_by" <> "created_by"),
	CONSTRAINT "project_budget_document_approved_has_approver" CHECK ("status" <> 'approved' OR "approved_by" IS NOT NULL),
	-- A transfer moves money between elements; it adds none.
	CONSTRAINT "project_budget_document_transfer_nets_zero" CHECK ("kind" <> 'transfer' OR "total_iqd" = 0),
	CONSTRAINT "project_budget_document_original_positive" CHECK ("kind" NOT IN ('original', 'supplement') OR "total_iqd" >= 0),
	CONSTRAINT "project_budget_document_return_negative" CHECK ("kind" <> 'return' OR "total_iqd" <= 0)
);--> statement-breakpoint
ALTER TABLE "project_budget_document" ADD CONSTRAINT "project_budget_document_project_code_fk" FOREIGN KEY ("project_code") REFERENCES "public"."project"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_budget_document" ADD CONSTRAINT "project_budget_document_variation_id_fk" FOREIGN KEY ("variation_id") REFERENCES "public"."project_variation"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_budget_document" ADD CONSTRAINT "project_budget_document_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_budget_document" ADD CONSTRAINT "project_budget_document_submitted_by_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_budget_document" ADD CONSTRAINT "project_budget_document_approved_by_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_budget_document" ADD CONSTRAINT "project_budget_document_rejected_by_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_budget_document_project_idx" ON "project_budget_document" USING btree ("project_code", "status", "kind");--> statement-breakpoint
-- One original budget per project (PM4 — the baseline is written once).
CREATE UNIQUE INDEX "project_budget_document_one_original" ON "project_budget_document" USING btree ("project_code") WHERE "kind" = 'original' AND "status" IN ('submitted', 'approved');--> statement-breakpoint

CREATE TABLE "project_budget_document_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"project_code" text NOT NULL,
	"line_no" smallint NOT NULL,
	"wbs_code" text NOT NULL,
	"cost_code" text NOT NULL,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"description" text,
	CONSTRAINT "project_budget_document_line_uniq" UNIQUE ("document_id", "line_no"),
	CONSTRAINT "project_budget_document_line_amount_nonzero" CHECK ("amount_iqd" <> 0),
	CONSTRAINT "project_budget_document_line_no_positive" CHECK ("line_no" >= 1)
);--> statement-breakpoint
ALTER TABLE "project_budget_document_line" ADD CONSTRAINT "project_budget_document_line_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."project_budget_document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_budget_document_line" ADD CONSTRAINT "project_budget_document_line_project_code_fk" FOREIGN KEY ("project_code") REFERENCES "public"."project"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_budget_document_line" ADD CONSTRAINT "project_budget_document_line_wbs_fk" FOREIGN KEY ("project_code", "wbs_code") REFERENCES "public"."project_wbs"("project_code", "code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_budget_document_line" ADD CONSTRAINT "project_budget_document_line_cost_code_fk" FOREIGN KEY ("cost_code") REFERENCES "public"."project_cost_code"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_budget_document_line_element_idx" ON "project_budget_document_line" USING btree ("project_code", "wbs_code", "cost_code");--> statement-breakpoint

-- A change order's lines: the budget it moves, element by element (§7).
CREATE TABLE "project_variation_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"variation_id" uuid NOT NULL,
	"project_code" text NOT NULL,
	"line_no" smallint NOT NULL,
	"wbs_code" text NOT NULL,
	"cost_code" text NOT NULL,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"description" text,
	CONSTRAINT "project_variation_line_uniq" UNIQUE ("variation_id", "line_no"),
	CONSTRAINT "project_variation_line_amount_nonzero" CHECK ("amount_iqd" <> 0),
	CONSTRAINT "project_variation_line_no_positive" CHECK ("line_no" >= 1)
);--> statement-breakpoint
ALTER TABLE "project_variation_line" ADD CONSTRAINT "project_variation_line_variation_id_fk" FOREIGN KEY ("variation_id") REFERENCES "public"."project_variation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_variation_line" ADD CONSTRAINT "project_variation_line_project_code_fk" FOREIGN KEY ("project_code") REFERENCES "public"."project"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_variation_line" ADD CONSTRAINT "project_variation_line_wbs_fk" FOREIGN KEY ("project_code", "wbs_code") REFERENCES "public"."project_wbs"("project_code", "code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_variation_line" ADD CONSTRAINT "project_variation_line_cost_code_fk" FOREIGN KEY ("cost_code") REFERENCES "public"."project_cost_code"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- The change order's scope and schedule effect, and its rejection (§7).
ALTER TABLE "project_variation" ADD COLUMN "scope_note" text;--> statement-breakpoint
ALTER TABLE "project_variation" ADD COLUMN "schedule_delta_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_variation" ADD COLUMN "rejected_by" uuid;--> statement-breakpoint
ALTER TABLE "project_variation" ADD COLUMN "rejected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_variation" ADD COLUMN "rejected_reason" text;--> statement-breakpoint
ALTER TABLE "project_variation" ADD CONSTRAINT "project_variation_rejected_by_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_variation" ADD CONSTRAINT "project_variation_rejected_complete" CHECK (("rejected_by" IS NULL) = ("rejected_at" IS NULL) AND ("rejected_at" IS NULL OR coalesce(btrim("rejected_reason"), '') <> ''));--> statement-breakpoint
-- Four eyes on both approvals: neither is the raiser's.
ALTER TABLE "project_variation" ADD CONSTRAINT "project_variation_four_eyes" CHECK (("commercial_approved_by" IS NULL OR "commercial_approved_by" <> "created_by") AND ("budget_approved_by" IS NULL OR "budget_approved_by" <> "created_by"));--> statement-breakpoint

-- A commitment stands on an element (§8); availability is read there.
ALTER TABLE "project_commitment" ADD COLUMN "wbs_code" text;--> statement-breakpoint
ALTER TABLE "project_commitment" ADD CONSTRAINT "project_commitment_wbs_fk" FOREIGN KEY ("project_code", "wbs_code") REFERENCES "public"."project_wbs"("project_code", "code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_commitment_element_idx" ON "project_commitment" USING btree ("project_code", "wbs_code");--> statement-breakpoint

-- The stop line raised for one element, with its reason (§7, D-PM-5).
ALTER TABLE "project_wbs" ADD COLUMN "stop_percent_raised" numeric(9, 4);--> statement-breakpoint
ALTER TABLE "project_wbs" ADD COLUMN "stop_raised_reason" text;--> statement-breakpoint
ALTER TABLE "project_wbs" ADD COLUMN "stop_raised_by" uuid;--> statement-breakpoint
ALTER TABLE "project_wbs" ADD COLUMN "stop_raised_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_wbs" ADD CONSTRAINT "project_wbs_stop_raised_by_fk" FOREIGN KEY ("stop_raised_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_wbs" ADD CONSTRAINT "project_wbs_stop_raised_complete" CHECK (("stop_percent_raised" IS NULL) = ("stop_raised_reason" IS NULL) AND ("stop_percent_raised" IS NULL) = ("stop_raised_by" IS NULL) AND ("stop_percent_raised" IS NULL) = ("stop_raised_at" IS NULL));--> statement-breakpoint
ALTER TABLE "project_wbs" ADD CONSTRAINT "project_wbs_stop_raised_range" CHECK ("stop_percent_raised" IS NULL OR ("stop_percent_raised" > 0 AND "stop_percent_raised" <= 200));--> statement-breakpoint

-- Row-level security through the project, as 0238 does for Phase 11's children.
DO $$
DECLARE t text;
BEGIN
	FOREACH t IN ARRAY ARRAY['project_plan_version', 'project_plan_line', 'project_budget_document',
	                         'project_budget_document_line', 'project_variation_line'] LOOP
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
	GRANT SELECT, INSERT, UPDATE ON "project_plan_version", "project_plan_line", "project_budget_document" TO erp_app;
	-- A draft's lines are replaced when it is edited, as a draft invoice's are.
	GRANT SELECT, INSERT, UPDATE, DELETE ON "project_budget_document_line", "project_variation_line" TO erp_app;
END $$;--> statement-breakpoint

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year) VALUES
	('PROJECT_BUDGET', 'PBD', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true)
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
	('project_budget', 'Budget document', 'projects', 'An original budget, a supplement, a return or a transfer between elements — raised by one person, approved by another; the budget by element is the sum of the approved ones (REQ-PM-001 §7).'),
	('project_plan', 'Cost plan', 'projects', 'The cost plan by element, cost code and month, in versions: the original and the re-plans; the current one is what availability and earned value read (REQ-PM-001 §7).')
ON CONFLICT (code) DO NOTHING;
