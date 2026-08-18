CREATE TYPE "public"."crm_activity_kind" AS ENUM('call', 'meeting', 'email', 'visit', 'note', 'task');--> statement-breakpoint
CREATE TYPE "public"."crm_case_status" AS ENUM('open', 'in_progress', 'resolved', 'closed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('new', 'working', 'qualified', 'converted', 'lost');--> statement-breakpoint
CREATE TYPE "public"."opportunity_stage" AS ENUM('open', 'qualified', 'won', 'lost', 'closed');--> statement-breakpoint
CREATE TABLE "crm_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "crm_activity_kind" NOT NULL,
	"lead_id" uuid,
	"opportunity_id" uuid,
	"partner_id" uuid,
	"case_id" uuid,
	"subject" text NOT NULL,
	"detail" text,
	"due_on" date,
	"completed_at" timestamp with time zone,
	"owner_user_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_activity_subject_present" CHECK (btrim("crm_activity"."subject") <> ''),
	CONSTRAINT "crm_activity_has_one_subject_record" CHECK ((case when "crm_activity"."lead_id" is not null then 1 else 0 end
           + case when "crm_activity"."opportunity_id" is not null then 1 else 0 end
           + case when "crm_activity"."partner_id" is not null then 1 else 0 end
           + case when "crm_activity"."case_id" is not null then 1 else 0 end) = 1)
);--> statement-breakpoint
CREATE TABLE "crm_campaign" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"starts_on" date,
	"ends_on" date,
	"budget_iqd" numeric(19, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_campaign_code_shape" CHECK ("crm_campaign"."code" ~ '^[A-Z0-9_-]+$'),
	CONSTRAINT "crm_campaign_dates_ordered" CHECK ("crm_campaign"."starts_on" is null or "crm_campaign"."ends_on" is null or "crm_campaign"."ends_on" >= "crm_campaign"."starts_on"),
	CONSTRAINT "crm_campaign_budget_not_negative" CHECK ("crm_campaign"."budget_iqd" is null or "crm_campaign"."budget_iqd" >= 0)
);--> statement-breakpoint
CREATE TABLE "crm_case" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_no" text NOT NULL,
	"status" "crm_case_status" DEFAULT 'open' NOT NULL,
	"partner_id" uuid NOT NULL,
	"warranty_registration_id" uuid,
	"ar_invoice_id" uuid,
	"serial_number" text,
	"branch_code" text NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"detail" text,
	"opened_on" date NOT NULL,
	"resolved_on" date,
	"resolution" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_case_subject_present" CHECK (btrim("crm_case"."subject") <> ''),
	CONSTRAINT "crm_case_resolved_is_explained" CHECK ("crm_case"."status" not in ('resolved', 'closed', 'rejected')
          or ("crm_case"."resolved_on" is not null and coalesce(btrim("crm_case"."resolution"), '') <> '')),
	CONSTRAINT "crm_case_resolved_not_before_opened" CHECK ("crm_case"."resolved_on" is null or "crm_case"."resolved_on" >= "crm_case"."opened_on")
);--> statement-breakpoint
CREATE TABLE "crm_contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"job_title" text,
	"phone" text,
	"email" text,
	"is_primary" text DEFAULT 'false' NOT NULL,
	"active" text DEFAULT 'true' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_contact_name_present" CHECK (btrim("crm_contact"."name") <> '')
);--> statement-breakpoint
CREATE TABLE "lead" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_no" text NOT NULL,
	"status" "lead_status" DEFAULT 'new' NOT NULL,
	"partner_id" uuid,
	"company_name" text NOT NULL,
	"contact_name" text,
	"phone" text,
	"email" text,
	"registration_no" text,
	"bank_account_number" text,
	"lead_source_code" text,
	"campaign_code" text,
	"business_line_code" text,
	"branch_code" text NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"note" text,
	"lost_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_company_name_present" CHECK (btrim("lead"."company_name") <> ''),
	CONSTRAINT "lead_lost_has_reason" CHECK ("lead"."status" <> 'lost' or coalesce(btrim("lead"."lost_reason"), '') <> ''),
	CONSTRAINT "lead_converted_has_partner" CHECK ("lead"."status" <> 'converted' or "lead"."partner_id" is not null)
);--> statement-breakpoint
CREATE TABLE "lead_source" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"active" text DEFAULT 'true' NOT NULL,
	CONSTRAINT "lead_source_code_shape" CHECK ("lead_source"."code" ~ '^[A-Z0-9_]+$')
);--> statement-breakpoint
CREATE TABLE "opportunity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_no" text NOT NULL,
	"stage" "opportunity_stage" DEFAULT 'open' NOT NULL,
	"lead_id" uuid,
	"partner_id" uuid NOT NULL,
	"business_line_code" text NOT NULL,
	"lead_source_code" text,
	"campaign_code" text,
	"branch_code" text NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"expected_value_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"probability_percent" smallint DEFAULT 0 NOT NULL,
	"expected_close_on" date,
	"next_action" text,
	"next_action_on" date,
	"lost_reason" text,
	"sales_order_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opportunity_title_present" CHECK (btrim("opportunity"."title") <> ''),
	CONSTRAINT "opportunity_value_not_negative" CHECK ("opportunity"."expected_value_iqd" >= 0),
	CONSTRAINT "opportunity_probability_range" CHECK ("opportunity"."probability_percent" between 0 and 100),
	CONSTRAINT "opportunity_lost_has_reason" CHECK ("opportunity"."stage" <> 'lost' or coalesce(btrim("opportunity"."lost_reason"), '') <> ''),
	CONSTRAINT "opportunity_converted_only_when_won" CHECK ("opportunity"."sales_order_id" is null or "opportunity"."stage" in ('won', 'closed'))
);--> statement-breakpoint
CREATE TABLE "opportunity_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"item_code" text,
	"description" text NOT NULL,
	"quantity" numeric(24, 6),
	"estimated_value_iqd" numeric(19, 4),
	CONSTRAINT "opportunity_item_description_present" CHECK (btrim("opportunity_item"."description") <> ''),
	CONSTRAINT "opportunity_item_quantity_positive" CHECK ("opportunity_item"."quantity" is null or "opportunity_item"."quantity" > 0)
);--> statement-breakpoint
ALTER TABLE "crm_activity" ADD CONSTRAINT "crm_activity_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_activity" ADD CONSTRAINT "crm_activity_opportunity_id_opportunity_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_activity" ADD CONSTRAINT "crm_activity_partner_id_business_partner_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_activity" ADD CONSTRAINT "crm_activity_owner_user_id_app_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_activity" ADD CONSTRAINT "crm_activity_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_activity" ADD CONSTRAINT "crm_activity_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_case" ADD CONSTRAINT "crm_case_partner_id_business_partner_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_case" ADD CONSTRAINT "crm_case_warranty_registration_id_warranty_registration_id_fk" FOREIGN KEY ("warranty_registration_id") REFERENCES "public"."warranty_registration"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_case" ADD CONSTRAINT "crm_case_ar_invoice_id_ar_invoice_id_fk" FOREIGN KEY ("ar_invoice_id") REFERENCES "public"."ar_invoice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_case" ADD CONSTRAINT "crm_case_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_case" ADD CONSTRAINT "crm_case_owner_user_id_app_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_case" ADD CONSTRAINT "crm_case_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contact" ADD CONSTRAINT "crm_contact_partner_id_business_partner_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."business_partner"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contact" ADD CONSTRAINT "crm_contact_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_partner_id_business_partner_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_lead_source_code_lead_source_code_fk" FOREIGN KEY ("lead_source_code") REFERENCES "public"."lead_source"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_campaign_code_crm_campaign_code_fk" FOREIGN KEY ("campaign_code") REFERENCES "public"."crm_campaign"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_business_line_code_business_line_code_fk" FOREIGN KEY ("business_line_code") REFERENCES "public"."business_line"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_owner_user_id_app_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_lead_id_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."lead"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_partner_id_business_partner_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_business_line_code_business_line_code_fk" FOREIGN KEY ("business_line_code") REFERENCES "public"."business_line"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_lead_source_code_lead_source_code_fk" FOREIGN KEY ("lead_source_code") REFERENCES "public"."lead_source"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_campaign_code_crm_campaign_code_fk" FOREIGN KEY ("campaign_code") REFERENCES "public"."crm_campaign"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_owner_user_id_app_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_sales_order_id_sales_order_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_item" ADD CONSTRAINT "opportunity_item_opportunity_id_opportunity_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crm_activity_lead_idx" ON "crm_activity" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "crm_activity_opportunity_idx" ON "crm_activity" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "crm_activity_partner_idx" ON "crm_activity" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "crm_activity_case_idx" ON "crm_activity" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "crm_activity_owner_idx" ON "crm_activity" USING btree ("owner_user_id","due_on");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_case_no_uniq" ON "crm_case" USING btree ("case_no");--> statement-breakpoint
CREATE INDEX "crm_case_partner_idx" ON "crm_case" USING btree ("partner_id","status");--> statement-breakpoint
CREATE INDEX "crm_case_warranty_idx" ON "crm_case" USING btree ("warranty_registration_id");--> statement-breakpoint
CREATE INDEX "crm_contact_partner_idx" ON "crm_contact" USING btree ("partner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_contact_primary_uniq" ON "crm_contact" USING btree ("partner_id") WHERE is_primary = 'true' and active = 'true';--> statement-breakpoint
CREATE UNIQUE INDEX "lead_no_uniq" ON "lead" USING btree ("lead_no");--> statement-breakpoint
CREATE INDEX "lead_owner_idx" ON "lead" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX "lead_partner_idx" ON "lead" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "lead_phone_idx" ON "lead" USING btree (regexp_replace("phone", '\D', '', 'g'));--> statement-breakpoint
CREATE INDEX "lead_email_idx" ON "lead" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "lead_registration_idx" ON "lead" USING btree ("registration_no");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_no_uniq" ON "opportunity" USING btree ("opportunity_no");--> statement-breakpoint
CREATE INDEX "opportunity_stage_idx" ON "opportunity" USING btree ("stage","owner_user_id");--> statement-breakpoint
CREATE INDEX "opportunity_partner_idx" ON "opportunity" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "opportunity_lead_idx" ON "opportunity" USING btree ("lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_sales_order_uniq" ON "opportunity" USING btree ("sales_order_id") WHERE sales_order_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_item_line_uniq" ON "opportunity_item" USING btree ("opportunity_id","line_no");
--> statement-breakpoint

-- ===========================================================================
-- Phase 08 — CRM and customer management (blueprint 6, Appendix B)
--
-- The module before the money. Appendix B says an opportunity has no accounting
-- effect, and the way to keep that true is that none of these tables has a
-- journal link to fill in.
--
-- There is no CRM-local customer either. Section 6 requires "the same Business
-- Partner record" as Sales, Finance, Projects, Logistics and Money Transfer, so
-- every table here points at business_partner. A CRM copy would be a second
-- version of a customer, and the first thing that would happen is that the two
-- addresses would differ.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Section 6 - an opportunity's customer is a customer.
--
-- A lead may name anybody, because a lead is an enquiry. An opportunity has a
-- value, a probability and a pipeline entry against it; if it could name a
-- supplier, the pipeline would forecast revenue from somebody the company buys
-- from.
-- ---------------------------------------------------------------------------
CREATE FUNCTION opportunity_partner_is_a_customer() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_is_customer boolean;
  v_code        text;
BEGIN
  SELECT is_customer, code INTO v_is_customer, v_code
    FROM business_partner WHERE id = NEW.partner_id;

  IF NOT coalesce(v_is_customer, false) THEN
    RAISE EXCEPTION
      '% is not a customer, so nothing can be sold to them (blueprint 6).', coalesce(v_code, 'That partner')
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER opportunity_partner_is_a_customer
  BEFORE INSERT OR UPDATE ON opportunity
  FOR EACH ROW EXECUTE FUNCTION opportunity_partner_is_a_customer();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 6, acceptance criterion 1 - "conversion retains the same customer and
-- source identifiers."
--
-- The service checks it on the way through; this is the half that a future code
-- path cannot forget. An opportunity that came from a lead carries that lead's
-- customer, source and campaign, and none of the three may drift afterwards.
-- Without this, no report can say which campaign produced which revenue.
-- ---------------------------------------------------------------------------
CREATE FUNCTION opportunity_identity_matches_its_lead() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_partner  uuid;
  v_source   text;
  v_campaign text;
  v_lead_no  text;
BEGIN
  IF NEW.lead_id IS NULL THEN RETURN NEW; END IF;

  SELECT partner_id, lead_source_code, campaign_code, lead_no
    INTO v_partner, v_source, v_campaign, v_lead_no
    FROM lead WHERE id = NEW.lead_id;

  IF v_partner IS NOT NULL AND NEW.partner_id IS DISTINCT FROM v_partner THEN
    RAISE EXCEPTION
      'Opportunity names a different customer from lead % (blueprint 6, criterion 1).', v_lead_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_source IS NOT NULL AND NEW.lead_source_code IS DISTINCT FROM v_source THEN
    RAISE EXCEPTION
      'Opportunity names a different lead source from lead % (blueprint 6, criterion 1).', v_lead_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_campaign IS NOT NULL AND NEW.campaign_code IS DISTINCT FROM v_campaign THEN
    RAISE EXCEPTION
      'Opportunity names a different campaign from lead % (blueprint 6, criterion 1).', v_lead_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER opportunity_identity_matches_its_lead
  BEFORE INSERT OR UPDATE ON opportunity
  FOR EACH ROW EXECUTE FUNCTION opportunity_identity_matches_its_lead();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 6, criterion 1 again, at the other end - the order an opportunity
-- became is an order for the same customer.
-- ---------------------------------------------------------------------------
CREATE FUNCTION opportunity_order_is_the_same_customer() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_customer uuid;
  v_order_no text;
BEGIN
  IF NEW.sales_order_id IS NULL THEN RETURN NEW; END IF;

  SELECT customer_id, order_no INTO v_customer, v_order_no
    FROM sales_order WHERE id = NEW.sales_order_id;

  IF NEW.partner_id IS DISTINCT FROM v_customer THEN
    RAISE EXCEPTION
      'Opportunity % was converted into order %, which is for a different customer (blueprint 6, criterion 1).',
      NEW.opportunity_no, v_order_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER opportunity_order_is_the_same_customer
  BEFORE INSERT OR UPDATE ON opportunity
  FOR EACH ROW EXECUTE FUNCTION opportunity_order_is_the_same_customer();--> statement-breakpoint

-- Numbering, document types, statuses and permissions.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('LEAD',        'LED', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true),
       ('OPPORTUNITY', 'OPP', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true),
       ('CRM_CASE',    'CAS', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('lead', 'Lead', 'crm',
   'An enquiry, before there is a customer. Blueprint 6 allows a lead to exist without an approved Business Partner - a Sales Order, Project, invoice or service transaction cannot.'),
  ('opportunity', 'Opportunity', 'crm',
   'A qualified enquiry with a customer, a value and a probability. Appendix B: no posting - and no journal column in which to record one.'),
  ('crm_case', 'After-Sales Case', 'crm',
   'A case against what was sold, linked to the invoice, the serial number and the warranty registration. Whether cover is still valid is 06.7''s calculation, never re-entered here.');--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('lead',        'draft',     'submitted'),
  ('lead',        'draft',     'cancelled'),
  ('lead',        'submitted', 'approved'),
  ('lead',        'submitted', 'rejected'),
  ('opportunity', 'draft',     'submitted'),
  ('opportunity', 'submitted', 'approved'),
  ('opportunity', 'submitted', 'rejected'),
  ('opportunity', 'approved',  'closed'),
  ('crm_case',    'draft',     'submitted'),
  ('crm_case',    'submitted', 'approved'),
  ('crm_case',    'submitted', 'rejected'),
  ('crm_case',    'approved',  'closed')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('opportunity', 'partner_id',
   'Which customer this is for. Blueprint 6''s first acceptance criterion is that it survives every conversion unchanged.'),
  ('opportunity', 'lead_source_code',
   'Where the enquiry came from. Changing it would move revenue to a campaign that did not earn it.'),
  ('opportunity', 'campaign_code',
   'The same, for the campaign.'),
  ('opportunity', 'expected_value_iqd',
   'What the pipeline is forecasting on.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Blueprint 6 is a sales module, and the roles that exist today are the
-- accounting ones. Both may work leads and opportunities; the financial half of
-- Customer 360 is governed separately, by the A/R permission, so a salesperson
-- sees the commercial history without the balances.
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'crm', 'view'),
  ('accounting_officer', 'crm', 'create'),
  ('accounting_officer', 'crm', 'edit_draft'),
  ('accounting_officer', 'crm', 'submit'),
  ('accounting_officer', 'crm', 'import'),
  ('accounting_officer', 'crm', 'print'),
  ('accounting_manager', 'crm', 'view'),
  ('accounting_manager', 'crm', 'create'),
  ('accounting_manager', 'crm', 'edit_draft'),
  ('accounting_manager', 'crm', 'submit'),
  ('accounting_manager', 'crm', 'approve'),
  ('accounting_manager', 'crm', 'import'),
  ('accounting_manager', 'crm', 'configure'),
  ('accounting_manager', 'crm', 'print'),
  ('accounting_manager', 'crm', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist - grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON lead, lead_source, crm_campaign, opportunity, opportunity_item,
                crm_activity, crm_contact, crm_case FROM erp_app;

  GRANT SELECT, INSERT, UPDATE ON lead             TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON opportunity      TO erp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON opportunity_item TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON crm_activity     TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON crm_contact      TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON crm_case         TO erp_app;
  GRANT SELECT                  ON lead_source     TO erp_app;
  GRANT SELECT                  ON crm_campaign    TO erp_app;
END;
$$;--> statement-breakpoint

-- D10 - the branch boundary. Contacts reach through their partner, which has no
-- branch of its own, so they are readable wherever the partner is.
ALTER TABLE lead ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE lead FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lead_branch_scope ON lead
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

ALTER TABLE opportunity ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE opportunity FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY opportunity_branch_scope ON opportunity
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

ALTER TABLE opportunity_item ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE opportunity_item FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY opportunity_item_branch_scope ON opportunity_item
  USING (EXISTS (SELECT 1 FROM opportunity h
                  WHERE h.id = opportunity_item.opportunity_id
                    AND app_branch_allowed(h.branch_code)))
  WITH CHECK (EXISTS (SELECT 1 FROM opportunity h
                       WHERE h.id = opportunity_item.opportunity_id
                         AND app_branch_allowed(h.branch_code)));--> statement-breakpoint

ALTER TABLE crm_activity ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE crm_activity FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY crm_activity_branch_scope ON crm_activity
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

ALTER TABLE crm_case ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE crm_case FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY crm_case_branch_scope ON crm_case
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));
