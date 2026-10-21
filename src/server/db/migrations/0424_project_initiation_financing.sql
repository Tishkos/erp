-- ===========================================================================
-- Project Initiation — the third road: the Renewable Energy Financing
-- Initiative (2026-10-21, by direction: "I need the ERP project section to be
-- structured around these stages … Leads → Opportunities → Projects", with the
-- initiative's own sheet). HAND-AUTHORED. Everything additive.
--
--   financing  fin_customer → fin_quotation → fin_bank_approval →
--              fin_loan_first → fin_installation → fin_contract → fin_loan_full
--
-- A customer whose system a bank loan pays for: name, city and phone; the
-- quotation agreed or refused (the proposal's columns); the bank's approval
-- and the loan it agreed; the first part of the loan paid; the installation;
-- the contract; the loan fully granted — and then, as on the other two roads,
-- the record is converted into an Active Project (type FINANCING).
--
-- The road's ordinal and the conversion's "last stage" are now read per road
-- (the financing road has seven stages, so "the sixth" no longer says "last").
-- ===========================================================================

CREATE OR REPLACE FUNCTION project_initiation_stage_ordinal(p_kind text, p_stage text) RETURNS integer
	LANGUAGE sql IMMUTABLE AS $$
	SELECT CASE
		WHEN p_kind = 'direct_sales' THEN array_position(
			ARRAY['lead', 'pre_sales', 'site_survey', 'boq_costing', 'proposal', 'contract'], p_stage)
		WHEN p_kind = 'tender' THEN array_position(
			ARRAY['tender_lead', 'go_no_go', 'pre_bid', 'tender_design', 'bidding', 'award'], p_stage)
		WHEN p_kind = 'financing' THEN array_position(
			ARRAY['fin_customer', 'fin_quotation', 'fin_bank_approval', 'fin_loan_first', 'fin_installation', 'fin_contract', 'fin_loan_full'], p_stage)
	END
$$;
--> statement-breakpoint
CREATE FUNCTION project_initiation_last_ordinal(p_kind text) RETURNS integer
	LANGUAGE sql IMMUTABLE AS $$
	SELECT CASE p_kind WHEN 'direct_sales' THEN 6 WHEN 'tender' THEN 6 WHEN 'financing' THEN 7 END
$$;
--> statement-breakpoint

ALTER TABLE "project_initiation" DROP CONSTRAINT "project_initiation_kind_known";
--> statement-breakpoint
ALTER TABLE "project_initiation" ADD CONSTRAINT "project_initiation_kind_known" CHECK ("kind" IN ('direct_sales', 'tender', 'financing'));
--> statement-breakpoint

ALTER TABLE "project_initiation"
	ADD COLUMN "customer_city" text,
	-- Stage 3: the bank that finances the system and what it said.
	ADD COLUMN "financing_bank" text,
	ADD COLUMN "financing_bank_ref" text,
	ADD COLUMN "bank_approval_status" text,
	ADD COLUMN "bank_decided_on" date,
	ADD COLUMN "loan_amount_iqd" numeric(19, 4),
	-- Stages 4 and 7: the loan paid out in part, then in full.
	ADD COLUMN "loan_status" text,
	ADD COLUMN "loan_received_iqd" numeric(19, 4),
	ADD COLUMN "loan_first_received_on" date,
	ADD COLUMN "loan_fully_granted_on" date,
	-- Stage 5: the installation.
	ADD COLUMN "installation_status" text,
	ADD COLUMN "installation_started_on" date,
	ADD COLUMN "installation_completed_on" date,
	ADD COLUMN "installation_note" text;
--> statement-breakpoint
ALTER TABLE "project_initiation" ADD CONSTRAINT "project_initiation_bank_approval_known" CHECK (
	"bank_approval_status" IS NULL OR "bank_approval_status" IN ('pending', 'approved', 'rejected')
);
--> statement-breakpoint
ALTER TABLE "project_initiation" ADD CONSTRAINT "project_initiation_loan_status_known" CHECK (
	"loan_status" IS NULL OR "loan_status" IN ('pending', 'partially_paid', 'fully_granted')
);
--> statement-breakpoint
ALTER TABLE "project_initiation" ADD CONSTRAINT "project_initiation_installation_status_known" CHECK (
	"installation_status" IS NULL OR "installation_status" IN ('not_started', 'in_progress', 'completed')
);
--> statement-breakpoint
ALTER TABLE "project_initiation" ADD CONSTRAINT "project_initiation_loan_amounts" CHECK (
	coalesce("loan_amount_iqd", 0) >= 0 AND coalesce("loan_received_iqd", 0) >= 0
	-- What the bank paid out never exceeds what it agreed to lend.
	AND ("loan_amount_iqd" IS NULL OR coalesce("loan_received_iqd", 0) <= "loan_amount_iqd")
);
--> statement-breakpoint
CREATE INDEX "project_initiation_updated_idx" ON "project_initiation" ("updated_at" DESC);
--> statement-breakpoint

-- The road, with the last stage read per road.
CREATE OR REPLACE FUNCTION project_initiation_guard() RETURNS trigger
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
	-- It becomes a project at the last stage of its workflow, and nowhere before it.
	IF NEW.status = 'converted'
		AND project_initiation_stage_ordinal(NEW.kind, NEW.stage) <> project_initiation_last_ordinal(NEW.kind) THEN
		RAISE EXCEPTION 'Project initiation % is at %; it is converted at the last stage of its workflow.', OLD.initiation_no, NEW.stage
			USING ERRCODE = 'check_violation';
	END IF;
	-- A tender goes on from Go / No-Go only with the decision to take part.
	IF NEW.stage IS DISTINCT FROM OLD.stage AND OLD.stage = 'go_no_go' AND NEW.go_decision IS DISTINCT FROM 'go' THEN
		RAISE EXCEPTION 'Project initiation % has no decision to participate; it stays at Go / No-Go.', OLD.initiation_no
			USING ERRCODE = 'check_violation';
	END IF;
	-- A financed customer goes on from the bank only with its approval.
	IF NEW.stage IS DISTINCT FROM OLD.stage AND OLD.stage = 'fin_bank_approval' AND NEW.bank_approval_status IS DISTINCT FROM 'approved' THEN
		RAISE EXCEPTION 'Project initiation % has no bank approval; it stays at Bank Approval.', OLD.initiation_no
			USING ERRCODE = 'check_violation';
	END IF;
	-- …and becomes a project only once the loan is fully granted.
	IF NEW.status = 'converted' AND NEW.kind = 'financing' AND NEW.loan_status IS DISTINCT FROM 'fully_granted' THEN
		RAISE EXCEPTION 'Project initiation %: the loan is not fully granted yet.', OLD.initiation_no
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END $$;
--> statement-breakpoint

-- The initiative's project type. Made by converting its initiation, never by hand.
INSERT INTO project_type (code, name_en, name_ar, kind) VALUES
	('FINANCING', 'Financed Customer Project', 'مشروع عميل ممول', 'customer')
ON CONFLICT (code) DO NOTHING;
