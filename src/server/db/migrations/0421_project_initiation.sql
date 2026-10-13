-- ===========================================================================
-- Project Initiation — the company's Project Guide (2026-10-12, by direction:
-- "we need our project follow the project guides"). HAND-AUTHORED. Everything
-- additive.
--
-- One record per prospective customer project, opened with the guide's Main
-- Project Initiation Selector (Direct Sales / Tender) and walked through its
-- workflow one stage at a time:
--
--   direct_sales  lead → pre_sales → site_survey → boq_costing → proposal → contract
--   tender        tender_lead → go_no_go → pre_bid → tender_design → bidding → award
--
-- At contract signing the record is converted into an Active Project
-- (`services/project-initiation.ts` › convert) and names it in `project_code`;
-- the Pre-Sales Form, the drawings and the approved BOQ are read from here by
-- the project's page, never copied. Lost with its reason otherwise. Nothing
-- here posts, moves stock or creates an obligation.
--
-- Never deleted. The road, the frozen identity and the decided record's
-- finality are held by the triggers below; the gates of each stage are the
-- service's (`domain/project-initiation.ts`).
-- ===========================================================================

CREATE FUNCTION project_initiation_stage_ordinal(p_kind text, p_stage text) RETURNS integer
	LANGUAGE sql IMMUTABLE AS $$
	SELECT CASE
		WHEN p_kind = 'direct_sales' THEN array_position(
			ARRAY['lead', 'pre_sales', 'site_survey', 'boq_costing', 'proposal', 'contract'], p_stage)
		WHEN p_kind = 'tender' THEN array_position(
			ARRAY['tender_lead', 'go_no_go', 'pre_bid', 'tender_design', 'bidding', 'award'], p_stage)
	END
$$;
--> statement-breakpoint

CREATE TABLE "project_initiation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	-- PIN-{BRANCH}-{YYYY}-{SERIAL}.
	"initiation_no" text NOT NULL,
	-- The Main Project Initiation Selector.
	"kind" text NOT NULL,
	"stage" text NOT NULL,
	"status" text NOT NULL DEFAULT 'open',
	"title" text NOT NULL,
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	"owner_user_id" uuid NOT NULL REFERENCES "app_user"("id"),

	-- The customer as first heard of (a tender's issuing entity), and the
	-- approved business partner once there is one: a lead may exist without a
	-- partner, a project may not.
	"customer_name" text NOT NULL,
	"customer_phone" text,
	"partner_id" uuid REFERENCES "business_partner"("id"),
	"lead_source_code" text REFERENCES "lead_source"("code"),
	"initial_contact_on" date,
	"lead_note" text,

	-- The Pre-Sales Form.
	"site_latitude" numeric(9, 6),
	"site_longitude" numeric(9, 6),
	"site_governorate" text,
	"site_area" text,
	"site_kind" text,
	"contact_name" text,
	"contact_job_title" text,
	"contact_phone" text,
	"contact_phone_alt" text,
	"contact_email" text,
	"system_type" text,

	-- Site survey and design.
	"survey_on" date,
	"site_verified" boolean NOT NULL DEFAULT false,
	"survey_note" text,

	-- The BOQ is approved by the step that leaves its stage.
	"boq_approved_by" uuid REFERENCES "app_user"("id"),
	"boq_approved_at" timestamptz,

	-- The proposal.
	"proposal_ref" text,
	"proposal_on" date,
	"proposal_value_iqd" numeric(19, 4),
	"proposal_status" text,

	-- The tender pipeline.
	"tender_ref" text,
	"tender_documents_url" text,
	"submission_deadline" date,
	"qualification_requirements" text,
	"bid_bond_iqd" numeric(19, 4),
	"go_decision" text,
	"go_decided_by" uuid REFERENCES "app_user"("id"),
	"go_decided_at" timestamptz,
	"go_note" text,
	"site_visit_on" date,
	"site_visit_minutes" text,
	"clarifications" text,
	"bid_price_iqd" numeric(19, 4),
	"guarantee_bank" text,
	"guarantee_no" text,
	"guarantee_iqd" numeric(19, 4),
	"guarantee_expires_on" date,
	"guarantee_status" text,
	"submitted_on" date,
	"submission_ref" text,
	"award_status" text,
	"awarded_on" date,

	-- Contract signing.
	"contract_ref" text,
	"contract_signed_on" date,
	"contract_value_iqd" numeric(19, 4),
	"payment_terms" text,

	-- The outcome: the project it became, or why it was lost.
	"project_code" text REFERENCES "project"("code"),
	"converted_by" uuid REFERENCES "app_user"("id"),
	"converted_at" timestamptz,
	"lost_reason" text,
	"lost_by" uuid REFERENCES "app_user"("id"),
	"lost_at" timestamptz,

	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),

	CONSTRAINT "project_initiation_kind_known" CHECK ("kind" IN ('direct_sales', 'tender')),
	CONSTRAINT "project_initiation_status_known" CHECK ("status" IN ('open', 'converted', 'lost')),
	-- A stage belongs to its workflow: a direct sale is never at the tender's Go / No-Go.
	CONSTRAINT "project_initiation_stage_of_kind" CHECK (project_initiation_stage_ordinal("kind", "stage") IS NOT NULL),
	CONSTRAINT "project_initiation_title_present" CHECK (btrim("title") <> ''),
	CONSTRAINT "project_initiation_customer_present" CHECK (btrim("customer_name") <> ''),
	CONSTRAINT "project_initiation_site_kind_known" CHECK ("site_kind" IS NULL OR "site_kind" IN ('land', 'rooftop')),
	CONSTRAINT "project_initiation_system_type_known" CHECK (
		"system_type" IS NULL OR "system_type" IN ('on_grid', 'off_grid', 'hybrid', 'bess', 'solar_pumping')
	),
	CONSTRAINT "project_initiation_latitude_range" CHECK ("site_latitude" IS NULL OR "site_latitude" BETWEEN -90 AND 90),
	CONSTRAINT "project_initiation_longitude_range" CHECK ("site_longitude" IS NULL OR "site_longitude" BETWEEN -180 AND 180),
	CONSTRAINT "project_initiation_proposal_status_known" CHECK (
		"proposal_status" IS NULL OR "proposal_status" IN ('draft', 'sent', 'negotiating', 'accepted', 'rejected')
	),
	CONSTRAINT "project_initiation_go_decision_known" CHECK ("go_decision" IS NULL OR "go_decision" IN ('go', 'no_go')),
	-- A decision to take part names who took it.
	CONSTRAINT "project_initiation_go_decided" CHECK (
		"go_decision" IS NULL OR ("go_decided_by" IS NOT NULL AND "go_decided_at" IS NOT NULL)
	),
	CONSTRAINT "project_initiation_guarantee_status_known" CHECK (
		"guarantee_status" IS NULL OR "guarantee_status" IN ('requested', 'issued', 'released', 'converted', 'forfeited')
	),
	CONSTRAINT "project_initiation_award_status_known" CHECK (
		"award_status" IS NULL OR "award_status" IN ('pending', 'awarded', 'not_awarded')
	),
	CONSTRAINT "project_initiation_amounts_not_negative" CHECK (
		coalesce("proposal_value_iqd", 0) >= 0 AND coalesce("bid_bond_iqd", 0) >= 0 AND coalesce("bid_price_iqd", 0) >= 0
		AND coalesce("guarantee_iqd", 0) >= 0 AND coalesce("contract_value_iqd", 0) >= 0
	),
	-- A converted record names its project and who confirmed the contract; nothing else does.
	CONSTRAINT "project_initiation_converted_has_project" CHECK (
		("status" = 'converted') = ("project_code" IS NOT NULL)
		AND ("status" <> 'converted' OR ("converted_by" IS NOT NULL AND "converted_at" IS NOT NULL AND "partner_id" IS NOT NULL))
	),
	CONSTRAINT "project_initiation_lost_has_reason" CHECK (
		"status" <> 'lost' OR (coalesce(btrim("lost_reason"), '') <> '' AND "lost_by" IS NOT NULL)
	),
	-- Four eyes at the contract: not whoever raised the record — a super user alone excepted (0278).
	CONSTRAINT "project_initiation_four_eyes" CHECK (
		"converted_by" IS NULL OR app_user_is_super("converted_by") OR "converted_by" <> "created_by"
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "project_initiation_no_uniq" ON "project_initiation" ("initiation_no");
--> statement-breakpoint
-- One initiation per project: two would count the same contract twice.
CREATE UNIQUE INDEX "project_initiation_project_uniq" ON "project_initiation" ("project_code") WHERE "project_code" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "project_initiation_status_idx" ON "project_initiation" ("status", "kind", "stage", "branch_code");
--> statement-breakpoint
CREATE INDEX "project_initiation_recent_idx" ON "project_initiation" ("created_at" DESC, "initiation_no" DESC);
--> statement-breakpoint
CREATE INDEX "project_initiation_partner_idx" ON "project_initiation" ("partner_id");
--> statement-breakpoint
CREATE INDEX "project_initiation_tender_ref_idx" ON "project_initiation" ("tender_ref");
--> statement-breakpoint

-- The bill of quantities: material, shipping and installation costs.
CREATE TABLE "project_initiation_boq_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"initiation_id" uuid NOT NULL REFERENCES "project_initiation"("id"),
	"line_no" integer NOT NULL,
	"category" text NOT NULL,
	-- An item of the catalogue where the line is one; free text otherwise.
	"item_code" text REFERENCES "item"("code"),
	"description" text NOT NULL,
	"quantity" numeric(24, 6) NOT NULL,
	"unit" text,
	"unit_cost_iqd" numeric(19, 4) NOT NULL,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "project_initiation_boq_category_known" CHECK ("category" IN ('material', 'shipping', 'installation')),
	CONSTRAINT "project_initiation_boq_description_present" CHECK (btrim("description") <> ''),
	CONSTRAINT "project_initiation_boq_quantity_positive" CHECK ("quantity" > 0),
	CONSTRAINT "project_initiation_boq_cost_not_negative" CHECK ("unit_cost_iqd" >= 0),
	CONSTRAINT "project_initiation_boq_amount_is_product" CHECK ("amount_iqd" = round("quantity" * "unit_cost_iqd", 4))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "project_initiation_boq_line_no_uniq" ON "project_initiation_boq_line" ("initiation_id", "line_no");
--> statement-breakpoint

-- The tender's technical Compliance Matrix.
CREATE TABLE "project_initiation_compliance_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"initiation_id" uuid NOT NULL REFERENCES "project_initiation"("id"),
	"line_no" integer NOT NULL,
	-- The clause of the tender documents the requirement comes from.
	"clause" text,
	"requirement" text NOT NULL,
	"response" text,
	"remark" text,
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "project_initiation_compliance_requirement_present" CHECK (btrim("requirement") <> ''),
	CONSTRAINT "project_initiation_compliance_response_known" CHECK (
		"response" IS NULL OR "response" IN ('compliant', 'partial', 'non_compliant', 'not_applicable')
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "project_initiation_compliance_line_no_uniq" ON "project_initiation_compliance_line" ("initiation_id", "line_no");
--> statement-breakpoint

-- Follow-up activities, site-visit notes, clarifications and addenda. Append-only.
CREATE TABLE "project_initiation_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"initiation_id" uuid NOT NULL REFERENCES "project_initiation"("id"),
	"kind" text NOT NULL,
	-- The stage the record stood at when this was written.
	"stage" text NOT NULL,
	"happened_on" date NOT NULL,
	"summary" text NOT NULL,
	"next_action" text,
	"next_action_on" date,
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "project_initiation_activity_kind_known" CHECK (
		"kind" IN ('follow_up', 'call', 'meeting', 'site_visit', 'clarification', 'addendum', 'note')
	),
	CONSTRAINT "project_initiation_activity_summary_present" CHECK (btrim("summary") <> '')
);
--> statement-breakpoint
CREATE INDEX "project_initiation_activity_idx" ON "project_initiation_activity" ("initiation_id", "happened_on" DESC, "created_at" DESC);
--> statement-breakpoint

-- The road: one stage forward at a time, a decided record never again, the
-- identity never.
CREATE FUNCTION project_initiation_guard() RETURNS trigger
	LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.status <> 'open' THEN
		RAISE EXCEPTION 'Project initiation % is %; a decided record does not change again.', OLD.initiation_no, OLD.status
			USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.initiation_no IS DISTINCT FROM OLD.initiation_no
		OR NEW.kind IS DISTINCT FROM OLD.kind
		OR NEW.branch_code IS DISTINCT FROM OLD.branch_code
		OR NEW.created_by IS DISTINCT FROM OLD.created_by
		OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'Project initiation %: its number, type, branch and author never change.', OLD.initiation_no
			USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.stage IS DISTINCT FROM OLD.stage
		AND project_initiation_stage_ordinal(NEW.kind, NEW.stage)
			IS DISTINCT FROM project_initiation_stage_ordinal(OLD.kind, OLD.stage) + 1 THEN
		RAISE EXCEPTION 'Project initiation % cannot go from % to %: one stage forward at a time.', OLD.initiation_no, OLD.stage, NEW.stage
			USING ERRCODE = 'check_violation';
	END IF;
	-- It becomes a project at contract signing — the last stage of its workflow, and nowhere before it.
	IF NEW.status = 'converted' AND project_initiation_stage_ordinal(NEW.kind, NEW.stage) <> 6 THEN
		RAISE EXCEPTION 'Project initiation % is at %; it is converted at contract signing, the last stage.', OLD.initiation_no, NEW.stage
			USING ERRCODE = 'check_violation';
	END IF;
	-- A tender goes on from Go / No-Go only with the decision to take part.
	IF NEW.stage IS DISTINCT FROM OLD.stage AND OLD.stage = 'go_no_go' AND NEW.go_decision IS DISTINCT FROM 'go' THEN
		RAISE EXCEPTION 'Project initiation % has no decision to participate; it stays at Go / No-Go.', OLD.initiation_no
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "project_initiation_guard"
	BEFORE UPDATE ON "project_initiation"
	FOR EACH ROW EXECUTE FUNCTION project_initiation_guard();
--> statement-breakpoint
CREATE TRIGGER "project_initiation_no_delete"
	BEFORE DELETE ON "project_initiation"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint

-- BOQ and compliance lines are written while the record is open; a converted
-- or lost record keeps what it said.
CREATE FUNCTION project_initiation_lines_frozen() RETURNS trigger
	LANGUAGE plpgsql AS $$
DECLARE
	v_status text;
	v_no     text;
BEGIN
	SELECT status, initiation_no INTO v_status, v_no
	  FROM project_initiation
	 WHERE id = coalesce(NEW.initiation_id, OLD.initiation_id);
	IF TG_OP = 'UPDATE' AND NEW.initiation_id IS DISTINCT FROM OLD.initiation_id THEN
		RAISE EXCEPTION 'A line of project initiation % stays on its record.', v_no
			USING ERRCODE = 'check_violation';
	END IF;
	IF v_status = 'open' THEN
		RETURN coalesce(NEW, OLD);
	END IF;
	RAISE EXCEPTION 'Project initiation % is %; its lines no longer change.', coalesce(v_no, '?'), coalesce(v_status, 'not visible')
		USING ERRCODE = 'check_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER "project_initiation_boq_line_frozen"
	BEFORE INSERT OR UPDATE OR DELETE ON "project_initiation_boq_line"
	FOR EACH ROW EXECUTE FUNCTION project_initiation_lines_frozen();
--> statement-breakpoint
CREATE TRIGGER "project_initiation_compliance_line_frozen"
	BEFORE INSERT OR UPDATE OR DELETE ON "project_initiation_compliance_line"
	FOR EACH ROW EXECUTE FUNCTION project_initiation_lines_frozen();
--> statement-breakpoint
-- What was done and said is never rewritten.
CREATE TRIGGER "project_initiation_activity_append_only"
	BEFORE UPDATE OR DELETE ON "project_initiation_activity"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year) VALUES
	('PROJECT_INITIATION', 'PIN', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
	('project_initiation', 'Project Initiation', 'projects',
	 'A prospective customer project from its first contact to its signed contract: a direct sale or a tender, converted into a project at signing.')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

-- The guide's two project types (its Main Project Initiation Selector). A
-- project of either type is made by converting its initiation, never by hand
-- (`project-system.createDefinition` refuses it).
INSERT INTO project_type (code, name_en, name_ar, kind) VALUES
	('DIRECT_SALES', 'Direct Sales Project', 'مشروع بيع مباشر', 'customer'),
	('TENDER',       'Tender Project',       'مشروع مناقصة',   'customer')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

-- The Sales Lead stage records a lead source; the catalogue had no rows.
INSERT INTO lead_source (code, name) VALUES
	('REFERRAL',          'Referral'),
	('EXISTING_CUSTOMER', 'Existing customer'),
	('WEBSITE',           'Website'),
	('SOCIAL_MEDIA',      'Social media'),
	('EXHIBITION',        'Exhibition or event'),
	('WALK_IN',           'Walk-in'),
	('COLD_CALL',         'Cold call'),
	('PARTNER',           'Partner or agent'),
	('OTHER',             'Other')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

ALTER TABLE project_initiation ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE project_initiation FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY project_initiation_branch_scope ON project_initiation
	USING (app_branch_allowed(branch_code)) WITH CHECK (app_branch_allowed(branch_code));
--> statement-breakpoint
ALTER TABLE project_initiation_boq_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE project_initiation_boq_line FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY project_initiation_boq_line_scope ON project_initiation_boq_line
	USING (
		app_is_super_user()
		OR EXISTS (SELECT 1 FROM project_initiation d
		            WHERE d.id = project_initiation_boq_line.initiation_id AND app_branch_allowed(d.branch_code))
	)
	WITH CHECK (
		app_is_super_user()
		OR EXISTS (SELECT 1 FROM project_initiation d
		            WHERE d.id = project_initiation_boq_line.initiation_id AND app_branch_allowed(d.branch_code))
	);
--> statement-breakpoint
ALTER TABLE project_initiation_compliance_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE project_initiation_compliance_line FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY project_initiation_compliance_line_scope ON project_initiation_compliance_line
	USING (
		app_is_super_user()
		OR EXISTS (SELECT 1 FROM project_initiation d
		            WHERE d.id = project_initiation_compliance_line.initiation_id AND app_branch_allowed(d.branch_code))
	)
	WITH CHECK (
		app_is_super_user()
		OR EXISTS (SELECT 1 FROM project_initiation d
		            WHERE d.id = project_initiation_compliance_line.initiation_id AND app_branch_allowed(d.branch_code))
	);
--> statement-breakpoint
ALTER TABLE project_initiation_activity ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE project_initiation_activity FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY project_initiation_activity_scope ON project_initiation_activity
	USING (
		app_is_super_user()
		OR EXISTS (SELECT 1 FROM project_initiation d
		            WHERE d.id = project_initiation_activity.initiation_id AND app_branch_allowed(d.branch_code))
	)
	WITH CHECK (
		app_is_super_user()
		OR EXISTS (SELECT 1 FROM project_initiation d
		            WHERE d.id = project_initiation_activity.initiation_id AND app_branch_allowed(d.branch_code))
	);
--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	-- No DELETE on the record or its activities: a record is lost with its reason, an activity is kept.
	GRANT SELECT, INSERT, UPDATE ON project_initiation TO erp_app;
	GRANT SELECT, INSERT, UPDATE, DELETE ON project_initiation_boq_line TO erp_app;
	GRANT SELECT, INSERT, UPDATE, DELETE ON project_initiation_compliance_line TO erp_app;
	GRANT SELECT, INSERT ON project_initiation_activity TO erp_app;
END;
$$;
