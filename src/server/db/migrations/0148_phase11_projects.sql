CREATE TYPE "public"."project_billing_method" AS ENUM('milestone', 'progress', 'time_and_material', 'lump_sum');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('draft', 'active', 'on_hold', 'closing', 'closed');--> statement-breakpoint
CREATE TYPE "public"."project_balance_kind" AS ENUM('retention', 'advance');--> statement-breakpoint
CREATE TABLE "project_balance_movement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_code" text NOT NULL,
	"kind" "project_balance_kind" NOT NULL,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"moved_on" date NOT NULL,
	"description" text NOT NULL,
	"certificate_id" uuid,
	"journal_entry_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_balance_movement_amount_not_zero" CHECK ("project_balance_movement"."amount_iqd" <> 0),
	CONSTRAINT "project_balance_movement_description_present" CHECK (btrim("project_balance_movement"."description") <> '')
);
--> statement-breakpoint
CREATE TABLE "project_budget_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_code" text NOT NULL,
	"cost_code" text NOT NULL,
	"description" text NOT NULL,
	"wbs_code" text,
	"account_id" uuid,
	"baseline_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"forecast_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_budget_line_description_present" CHECK (btrim("project_budget_line"."description") <> ''),
	CONSTRAINT "project_budget_line_amounts_not_negative" CHECK ("project_budget_line"."baseline_iqd" >= 0 and "project_budget_line"."forecast_iqd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "project_certificate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"certificate_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"project_code" text NOT NULL,
	"branch_code" text NOT NULL,
	"certified_on" date NOT NULL,
	"percent_complete" numeric(9, 4) NOT NULL,
	"gross_iqd" numeric(19, 4) NOT NULL,
	"retention_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"advance_recovered_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"net_iqd" numeric(19, 4) NOT NULL,
	"ar_invoice_id" uuid,
	"created_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_certificate_gross_positive" CHECK ("project_certificate"."gross_iqd" > 0),
	CONSTRAINT "project_certificate_percent_range" CHECK ("project_certificate"."percent_complete" between 0 and 100),
	CONSTRAINT "project_certificate_deductions_not_negative" CHECK ("project_certificate"."retention_iqd" >= 0 and "project_certificate"."advance_recovered_iqd" >= 0),
	CONSTRAINT "project_certificate_net_is_the_remainder" CHECK ("project_certificate"."net_iqd" = "project_certificate"."gross_iqd" - "project_certificate"."retention_iqd" - "project_certificate"."advance_recovered_iqd"),
	CONSTRAINT "project_certificate_deductions_within_gross" CHECK ("project_certificate"."retention_iqd" + "project_certificate"."advance_recovered_iqd" <= "project_certificate"."gross_iqd")
);
--> statement-breakpoint
CREATE TABLE "project_commitment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_code" text NOT NULL,
	"cost_code" text NOT NULL,
	"purchase_order_id" uuid,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"consumed_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"committed_on" date NOT NULL,
	"released_on" date,
	"release_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_commitment_amount_positive" CHECK ("project_commitment"."amount_iqd" > 0),
	CONSTRAINT "project_commitment_consumed_within" CHECK ("project_commitment"."consumed_iqd" >= 0 and "project_commitment"."consumed_iqd" <= "project_commitment"."amount_iqd"),
	CONSTRAINT "project_commitment_release_has_reason" CHECK ("project_commitment"."released_on" is null or coalesce(btrim("project_commitment"."release_reason"), '') <> '')
);
--> statement-breakpoint
CREATE TABLE "project_cost" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_code" text NOT NULL,
	"cost_code" text NOT NULL,
	"wbs_code" text,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"incurred_on" date NOT NULL,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"journal_entry_id" uuid,
	"billed" text DEFAULT 'false' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_cost_amount_not_zero" CHECK ("project_cost"."amount_iqd" <> 0),
	CONSTRAINT "project_cost_description_present" CHECK (btrim("project_cost"."description") <> '')
);
--> statement-breakpoint
CREATE TABLE "project_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_code" text NOT NULL,
	"wbs_code" text NOT NULL,
	"measured_on" date NOT NULL,
	"percent_complete" numeric(9, 4) NOT NULL,
	"measured_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_progress_percent_range" CHECK ("project_progress"."percent_complete" between 0 and 100),
	CONSTRAINT "project_progress_approval_complete" CHECK (("project_progress"."approved_by" is null) = ("project_progress"."approved_at" is null)),
	CONSTRAINT "project_progress_approver_is_another" CHECK ("project_progress"."approved_by" is null or "project_progress"."approved_by" <> "project_progress"."measured_by")
);
--> statement-breakpoint
CREATE TABLE "project_variation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"variation_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"project_code" text NOT NULL,
	"version" smallint DEFAULT 1 NOT NULL,
	"supersedes_id" uuid,
	"raised_on" date NOT NULL,
	"description" text NOT NULL,
	"contract_delta_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"budget_delta_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"revised_ends_on" date,
	"commercial_approved_by" uuid,
	"commercial_approved_at" timestamp with time zone,
	"budget_approved_by" uuid,
	"budget_approved_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_variation_description_present" CHECK (btrim("project_variation"."description") <> ''),
	CONSTRAINT "project_variation_version_positive" CHECK ("project_variation"."version" >= 1),
	CONSTRAINT "project_variation_commercial_complete" CHECK (("project_variation"."commercial_approved_by" is null) = ("project_variation"."commercial_approved_at" is null)),
	CONSTRAINT "project_variation_budget_complete" CHECK (("project_variation"."budget_approved_by" is null) = ("project_variation"."budget_approved_at" is null)),
	CONSTRAINT "project_variation_approved_needs_both" CHECK ("project_variation"."status" <> 'approved'
          or ("project_variation"."commercial_approved_by" is not null and "project_variation"."budget_approved_by" is not null))
);
--> statement-breakpoint
CREATE TABLE "project_wbs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_code" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"parent_code" text,
	"responsible_user_id" uuid,
	"planned_starts_on" date,
	"planned_ends_on" date,
	"is_milestone" text DEFAULT 'false' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_wbs_name_present" CHECK (btrim("project_wbs"."name") <> ''),
	CONSTRAINT "project_wbs_not_own_parent" CHECK ("project_wbs"."parent_code" is distinct from "project_wbs"."code"),
	CONSTRAINT "project_wbs_dates_ordered" CHECK ("project_wbs"."planned_starts_on" is null or "project_wbs"."planned_ends_on" is null
          or "project_wbs"."planned_ends_on" >= "project_wbs"."planned_starts_on")
);
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "status" "project_status" DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "department_code" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "cost_centre_code" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "manager_user_id" uuid;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "opportunity_id" uuid;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "contract_value_iqd" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "baseline_budget_iqd" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "baseline_starts_on" date;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "baseline_ends_on" date;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "billing_method" "project_billing_method" DEFAULT 'progress' NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "retention_percent" numeric(9, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "advance_recovery_percent" numeric(9, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "recognition_method" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "requires_cost_code" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "closed_by" uuid;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "close_note" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "project_balance_movement" ADD CONSTRAINT "project_balance_movement_project_code_project_code_fk" FOREIGN KEY ("project_code") REFERENCES "public"."project"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_balance_movement" ADD CONSTRAINT "project_balance_movement_certificate_id_project_certificate_id_fk" FOREIGN KEY ("certificate_id") REFERENCES "public"."project_certificate"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_balance_movement" ADD CONSTRAINT "project_balance_movement_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_balance_movement" ADD CONSTRAINT "project_balance_movement_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_budget_line" ADD CONSTRAINT "project_budget_line_project_code_project_code_fk" FOREIGN KEY ("project_code") REFERENCES "public"."project"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_budget_line" ADD CONSTRAINT "project_budget_line_account_id_chart_of_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."chart_of_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_certificate" ADD CONSTRAINT "project_certificate_project_code_project_code_fk" FOREIGN KEY ("project_code") REFERENCES "public"."project"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_certificate" ADD CONSTRAINT "project_certificate_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_certificate" ADD CONSTRAINT "project_certificate_ar_invoice_id_ar_invoice_id_fk" FOREIGN KEY ("ar_invoice_id") REFERENCES "public"."ar_invoice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_certificate" ADD CONSTRAINT "project_certificate_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_certificate" ADD CONSTRAINT "project_certificate_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_commitment" ADD CONSTRAINT "project_commitment_project_code_project_code_fk" FOREIGN KEY ("project_code") REFERENCES "public"."project"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_commitment" ADD CONSTRAINT "project_commitment_purchase_order_id_purchase_order_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_commitment" ADD CONSTRAINT "project_commitment_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_cost" ADD CONSTRAINT "project_cost_project_code_project_code_fk" FOREIGN KEY ("project_code") REFERENCES "public"."project"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_cost" ADD CONSTRAINT "project_cost_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_cost" ADD CONSTRAINT "project_cost_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_progress" ADD CONSTRAINT "project_progress_project_code_project_code_fk" FOREIGN KEY ("project_code") REFERENCES "public"."project"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_progress" ADD CONSTRAINT "project_progress_measured_by_app_user_id_fk" FOREIGN KEY ("measured_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_progress" ADD CONSTRAINT "project_progress_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_variation" ADD CONSTRAINT "project_variation_project_code_project_code_fk" FOREIGN KEY ("project_code") REFERENCES "public"."project"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_variation" ADD CONSTRAINT "project_variation_commercial_approved_by_app_user_id_fk" FOREIGN KEY ("commercial_approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_variation" ADD CONSTRAINT "project_variation_budget_approved_by_app_user_id_fk" FOREIGN KEY ("budget_approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_variation" ADD CONSTRAINT "project_variation_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_wbs" ADD CONSTRAINT "project_wbs_project_code_project_code_fk" FOREIGN KEY ("project_code") REFERENCES "public"."project"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_wbs" ADD CONSTRAINT "project_wbs_responsible_user_id_app_user_id_fk" FOREIGN KEY ("responsible_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_balance_movement_project_idx" ON "project_balance_movement" USING btree ("project_code","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "project_budget_line_code_uniq" ON "project_budget_line" USING btree ("project_code","cost_code");--> statement-breakpoint
CREATE UNIQUE INDEX "project_certificate_no_uniq" ON "project_certificate" USING btree ("certificate_no");--> statement-breakpoint
CREATE INDEX "project_certificate_project_idx" ON "project_certificate" USING btree ("project_code","certified_on");--> statement-breakpoint
CREATE INDEX "project_commitment_project_idx" ON "project_commitment" USING btree ("project_code","cost_code");--> statement-breakpoint
CREATE INDEX "project_commitment_order_idx" ON "project_commitment" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "project_cost_project_idx" ON "project_cost" USING btree ("project_code","cost_code");--> statement-breakpoint
CREATE INDEX "project_cost_wbs_idx" ON "project_cost" USING btree ("project_code","wbs_code");--> statement-breakpoint
CREATE INDEX "project_cost_date_idx" ON "project_cost" USING btree ("incurred_on");--> statement-breakpoint
CREATE UNIQUE INDEX "project_progress_period_uniq" ON "project_progress" USING btree ("project_code","wbs_code","measured_on");--> statement-breakpoint
CREATE INDEX "project_progress_project_idx" ON "project_progress" USING btree ("project_code");--> statement-breakpoint
CREATE UNIQUE INDEX "project_variation_no_uniq" ON "project_variation" USING btree ("variation_no");--> statement-breakpoint
CREATE INDEX "project_variation_project_idx" ON "project_variation" USING btree ("project_code","status");--> statement-breakpoint
CREATE UNIQUE INDEX "project_wbs_code_uniq" ON "project_wbs" USING btree ("project_code","code");--> statement-breakpoint
CREATE INDEX "project_wbs_parent_idx" ON "project_wbs" USING btree ("project_code","parent_code");--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_manager_user_id_app_user_id_fk" FOREIGN KEY ("manager_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_closed_by_app_user_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_customer_idx" ON "project" USING btree ("partner_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "project_opportunity_uniq" ON "project" USING btree ("opportunity_id") WHERE opportunity_id is not null;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_contract_value_not_negative" CHECK ("project"."contract_value_iqd" >= 0);--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_baseline_budget_not_negative" CHECK ("project"."baseline_budget_iqd" >= 0);--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_percentages_in_range" CHECK ("project"."retention_percent" between 0 and 100
          and "project"."advance_recovery_percent" between 0 and 100);--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_baseline_dates_ordered" CHECK ("project"."baseline_starts_on" is null or "project"."baseline_ends_on" is null
          or "project"."baseline_ends_on" >= "project"."baseline_starts_on");--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_approval_complete" CHECK (("project"."approved_by" is null) = ("project"."approved_at" is null));--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_closed_is_explained" CHECK ("project"."status" <> 'closed'
          or ("project"."closed_by" is not null and "project"."closed_at" is not null
              and coalesce(btrim("project"."close_note"), '') <> ''));
--> statement-breakpoint

-- ===========================================================================
-- Phase 11 — projects and contracting (blueprint 10, 19, Appendix B)
--
-- The project dimension and the project master are one row. Phase 02 created
-- `project` so that a posting could be tagged with one; this gives it the
-- contract that makes it a project. A second table would mean a posting's
-- project and a contract's project were two records to keep in step, and the
-- first rename would make the reports disagree.
--
-- What is deliberately absent: revenue recognition. Section 10 requires Finance
-- to approve the recognition policy before WIP and progress billing are
-- developed and forbids IT from inventing the treatment. D1 is open, so
-- `recognition_method` is a column nothing reads and no default is seeded - not
-- even a percentage-of-completion one "to be changed later", which is the exact
-- shape of the mistake section 28 exists to prevent.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Section 10 - the work breakdown structure is a tree.
--
-- A cycle would make every roll-up of cost or progress run forever. The service
-- checks it before writing; this is the half a future code path cannot forget.
-- ---------------------------------------------------------------------------
CREATE FUNCTION project_wbs_has_no_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_cursor text;
  v_steps  int := 0;
BEGIN
  IF NEW.parent_code IS NULL THEN RETURN NEW; END IF;

  v_cursor := NEW.parent_code;

  WHILE v_cursor IS NOT NULL LOOP
    IF v_cursor = NEW.code THEN
      RAISE EXCEPTION
        'That parent would make a cycle in the work breakdown structure of % (blueprint 10). An element cannot be part of its own work.',
        NEW.project_code
        USING ERRCODE = 'restrict_violation';
    END IF;

    v_steps := v_steps + 1;
    IF v_steps > 100 THEN EXIT; END IF;

    SELECT w.parent_code INTO v_cursor
      FROM project_wbs w
     WHERE w.project_code = NEW.project_code AND w.code = v_cursor;
  END LOOP;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER project_wbs_has_no_cycle
  BEFORE INSERT OR UPDATE ON project_wbs
  FOR EACH ROW EXECUTE FUNCTION project_wbs_has_no_cycle();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 10 - nothing is spent against a project that is not active.
--
-- Commitments and costs both go through this. A project that is draft has no
-- approved baseline to spend against; one that is closed has been filed as
-- finished, and money moving against it afterwards is exactly what the closeout
-- rules exist to prevent.
-- ---------------------------------------------------------------------------
CREATE FUNCTION project_spending_requires_an_active_project() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status::text INTO v_status FROM project WHERE code = NEW.project_code;

  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION
      'Project % is %; nothing can be spent against a project that is not active (blueprint 10).',
      NEW.project_code, coalesce(v_status, 'missing')
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER project_commitment_requires_active_project
  BEFORE INSERT ON project_commitment
  FOR EACH ROW EXECUTE FUNCTION project_spending_requires_an_active_project();--> statement-breakpoint

CREATE TRIGGER project_cost_requires_active_project
  BEFORE INSERT ON project_cost
  FOR EACH ROW EXECUTE FUNCTION project_spending_requires_an_active_project();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 10, acceptance criterion 3 - the baseline is written once.
--
-- Contract value, baseline budget and the baseline dates are set when the
-- contract is approved and never touched again; variations accumulate beside
-- them. A baseline that moved with each change order could not answer "how far
-- have we drifted?", which is the only question it exists to answer.
-- ---------------------------------------------------------------------------
CREATE FUNCTION project_baseline_is_written_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.approved_at IS NULL THEN RETURN NEW; END IF;

  IF NEW.contract_value_iqd   IS DISTINCT FROM OLD.contract_value_iqd
  OR NEW.baseline_budget_iqd  IS DISTINCT FROM OLD.baseline_budget_iqd
  OR NEW.baseline_starts_on   IS DISTINCT FROM OLD.baseline_starts_on
  OR NEW.baseline_ends_on     IS DISTINCT FROM OLD.baseline_ends_on THEN
    RAISE EXCEPTION
      'The baseline of % was approved and cannot be changed (blueprint 10, criterion 3). Raise a variation: the revised figures sit beside the baseline, and both stay visible.',
      OLD.code
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER project_baseline_is_written_once
  BEFORE UPDATE ON project
  FOR EACH ROW EXECUTE FUNCTION project_baseline_is_written_once();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 10 - a certificate cannot exceed approved measured progress.
--
-- A certificate is the customer being asked to pay for work somebody measured
-- and somebody else approved. Certifying beyond the measurement bills for work
-- nobody has said was done.
-- ---------------------------------------------------------------------------
CREATE FUNCTION project_certificate_within_measured_progress() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_measured numeric(9,4);
BEGIN
  SELECT coalesce(avg(latest.percent_complete), 0) INTO v_measured
    FROM (
      SELECT DISTINCT ON (p.wbs_code) p.percent_complete
        FROM project_progress p
       WHERE p.project_code = NEW.project_code
         AND p.approved_at IS NOT NULL
         AND p.measured_on <= NEW.certified_on
       ORDER BY p.wbs_code, p.measured_on DESC
    ) latest;

  IF NEW.percent_complete > v_measured THEN
    RAISE EXCEPTION
      'Certificate claims %%% against %%% of approved measured progress on % (blueprint 10).',
      NEW.percent_complete, v_measured, NEW.project_code
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER project_certificate_within_measured_progress
  BEFORE INSERT ON project_certificate
  FOR EACH ROW EXECUTE FUNCTION project_certificate_within_measured_progress();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 10 - retention released can never exceed retention held.
--
-- The balance is a sum of movements rather than a maintained figure, so this
-- checks the sum after the movement rather than a column somebody kept.
-- ---------------------------------------------------------------------------
CREATE FUNCTION project_balance_never_goes_negative() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_balance numeric(19,4);
BEGIN
  SELECT coalesce(sum(amount_iqd), 0) INTO v_balance
    FROM project_balance_movement
   WHERE project_code = NEW.project_code AND kind = NEW.kind;

  IF v_balance < 0 THEN
    RAISE EXCEPTION
      'That movement would leave % of % on project % (blueprint 10). Releasing more than was withheld pays the customer money the company never held back.',
      v_balance, NEW.kind, NEW.project_code
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER project_balance_never_goes_negative
  AFTER INSERT OR UPDATE OR DELETE ON project_balance_movement
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION project_balance_never_goes_negative();--> statement-breakpoint

-- Numbering, document types, statuses and permissions.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('PROJECT_CERTIFICATE', 'PCT', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true),
       ('PROJECT_VARIATION',   'PVR', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('project', 'Project / Contract', 'projects',
   'Customer work with a scope, a budget, a timeline and a baseline (blueprint 10). The same row is the project dimension every posting is tagged with, so the contract and the ledger cannot disagree about which project is which.'),
  ('project_certificate', 'Progress Certificate', 'projects',
   'What the customer is asked to pay for measured work. Retention is withheld and the advance recovered into their own balances - neither is revenue (blueprint 10).'),
  ('project_variation', 'Variation / Change Order', 'projects',
   'A versioned change to contract value, budget or dates, requiring commercial and budget approval. The baseline is preserved; the revised figures sit beside it (blueprint 10, criterion 3).')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('project_certificate', 'draft',     'approved'),
  ('project_certificate', 'draft',     'cancelled'),
  ('project_certificate', 'approved',  'posted'),
  ('project_variation',   'draft',     'submitted'),
  ('project_variation',   'submitted', 'approved'),
  ('project_variation',   'submitted', 'rejected'),
  ('project_variation',   'draft',     'approved'),
  ('project_variation',   'draft',     'cancelled')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('project', 'contract_value_iqd',
   'The baseline. Every variation is measured against it, so it is written once and never again.'),
  ('project', 'baseline_budget_iqd',
   'The same, for the budget.'),
  ('project', 'baseline_ends_on',
   'The baseline completion date. A variation may revise it; the original stays visible beside the revision.'),
  ('project_variation', 'contract_delta_iqd',
   'What the change order is worth. It is what both approvers signed.'),
  ('project_variation', 'budget_delta_iqd',
   'The budget half of the same change.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'project', 'view'),
  ('accounting_officer', 'project', 'create'),
  ('accounting_officer', 'project', 'edit_draft'),
  ('accounting_officer', 'project', 'submit'),
  ('accounting_officer', 'project', 'post'),
  ('accounting_officer', 'project', 'print'),
  ('accounting_manager', 'project', 'view'),
  ('accounting_manager', 'project', 'create'),
  ('accounting_manager', 'project', 'edit_draft'),
  ('accounting_manager', 'project', 'submit'),
  ('accounting_manager', 'project', 'approve'),
  ('accounting_manager', 'project', 'post'),
  ('accounting_manager', 'project', 'configure'),
  ('accounting_manager', 'project', 'reverse_cancel'),
  ('accounting_manager', 'project', 'print'),
  ('accounting_manager', 'project', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist - grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON project_wbs, project_budget_line, project_commitment, project_cost,
                project_progress, project_certificate, project_balance_movement,
                project_variation FROM erp_app;

  GRANT SELECT, INSERT, UPDATE, DELETE ON project_wbs             TO erp_app;
  GRANT SELECT, INSERT, UPDATE         ON project_budget_line     TO erp_app;
  GRANT SELECT, INSERT, UPDATE         ON project_commitment      TO erp_app;
  GRANT SELECT, INSERT, UPDATE         ON project_cost            TO erp_app;
  GRANT SELECT, INSERT, UPDATE         ON project_progress        TO erp_app;
  GRANT SELECT, INSERT, UPDATE         ON project_certificate     TO erp_app;
  GRANT SELECT, INSERT                 ON project_balance_movement TO erp_app;
  GRANT SELECT, INSERT, UPDATE         ON project_variation       TO erp_app;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 10 - stock issued to a project, and stock returned from one.
--
-- Their own movement kinds rather than reusing `delivery`: a delivery leaves the
-- company and a project issue does not, and section 10 asks for "material issued
-- and returned, and stock at project site" to be reported. Reusing the sales
-- kind would make that report impossible to write truthfully.
-- ---------------------------------------------------------------------------
ALTER TYPE "inventory_movement_kind" ADD VALUE IF NOT EXISTS 'project_issue';--> statement-breakpoint
ALTER TYPE "inventory_movement_kind" ADD VALUE IF NOT EXISTS 'project_return';
