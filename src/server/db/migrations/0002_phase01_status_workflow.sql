CREATE TYPE "public"."document_status" AS ENUM('draft', 'submitted', 'approved', 'partially_executed', 'executed', 'posted', 'settled', 'rejected', 'cancelled', 'reversed', 'closed');--> statement-breakpoint
CREATE TYPE "public"."workflow_decision_kind" AS ENUM('approved', 'rejected', 'recalled', 'delegated');--> statement-breakpoint
CREATE TABLE "document_status_transition" (
	"document_type_code" text NOT NULL,
	"from_status" "document_status" NOT NULL,
	"to_status" "document_status" NOT NULL,
	CONSTRAINT "document_status_transition_document_type_code_from_status_to_status_pk" PRIMARY KEY("document_type_code","from_status","to_status"),
	CONSTRAINT "document_status_transition_not_self" CHECK ("document_status_transition"."from_status" <> "document_status_transition"."to_status")
);
--> statement-breakpoint
CREATE TABLE "document_type" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"module" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_decision" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "workflow_decision_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"instance_id" uuid NOT NULL,
	"step_sequence" smallint NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"decision" "workflow_decision_kind" NOT NULL,
	"reason" text,
	"on_behalf_of" uuid,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_decision_reason_present" CHECK ("workflow_decision"."decision" not in ('rejected','delegated') or coalesce(btrim("workflow_decision"."reason"), '') <> '')
);
--> statement-breakpoint
CREATE TABLE "workflow_definition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_type_code" text NOT NULL,
	"version" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "workflow_instance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_type_code" text NOT NULL,
	"document_id" text NOT NULL,
	"definition_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"current_step" smallint,
	"is_complete" boolean DEFAULT false NOT NULL,
	"submitted_by" uuid NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"branch_code" text
);
--> statement-breakpoint
CREATE TABLE "workflow_step" (
	"definition_id" uuid NOT NULL,
	"sequence" smallint NOT NULL,
	"approver_role" text NOT NULL,
	"allow_self_approval" boolean DEFAULT false NOT NULL,
	"escalate_after_hours" integer,
	CONSTRAINT "workflow_step_definition_id_sequence_pk" PRIMARY KEY("definition_id","sequence"),
	CONSTRAINT "workflow_step_sequence_positive" CHECK ("workflow_step"."sequence" >= 1)
);
--> statement-breakpoint
ALTER TABLE "document_status_transition" ADD CONSTRAINT "document_status_transition_document_type_code_document_type_code_fk" FOREIGN KEY ("document_type_code") REFERENCES "public"."document_type"("code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_decision" ADD CONSTRAINT "workflow_decision_instance_id_workflow_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."workflow_instance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_decision" ADD CONSTRAINT "workflow_decision_actor_user_id_app_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_decision" ADD CONSTRAINT "workflow_decision_on_behalf_of_app_user_id_fk" FOREIGN KEY ("on_behalf_of") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_definition" ADD CONSTRAINT "workflow_definition_document_type_code_document_type_code_fk" FOREIGN KEY ("document_type_code") REFERENCES "public"."document_type"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_definition" ADD CONSTRAINT "workflow_definition_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_instance" ADD CONSTRAINT "workflow_instance_document_type_code_document_type_code_fk" FOREIGN KEY ("document_type_code") REFERENCES "public"."document_type"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_instance" ADD CONSTRAINT "workflow_instance_definition_id_workflow_definition_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."workflow_definition"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_instance" ADD CONSTRAINT "workflow_instance_submitted_by_app_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_step" ADD CONSTRAINT "workflow_step_definition_id_workflow_definition_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."workflow_definition"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_decision_instance_idx" ON "workflow_decision" USING btree ("instance_id","decided_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_definition_version_uniq" ON "workflow_definition" USING btree ("document_type_code","version");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_definition_active_uniq" ON "workflow_definition" USING btree ("document_type_code") WHERE "workflow_definition"."is_active";--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_instance_revision_uniq" ON "workflow_instance" USING btree ("document_type_code","document_id","revision");--> statement-breakpoint
CREATE INDEX "workflow_instance_pending_idx" ON "workflow_instance" USING btree ("document_type_code","current_step");--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE — Phase 01.6 and 01.7.
-- ===========================================================================

-- The decision history is evidence, not working data. §5.4: audit entries and
-- approval decisions "cannot be edited or deleted by application users."
CREATE TRIGGER workflow_decision_append_only
  BEFORE UPDATE OR DELETE ON workflow_decision
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

-- Escalation must be a positive interval or absent; zero would fire forever.
ALTER TABLE workflow_step
  ADD CONSTRAINT workflow_step_escalation_positive
  CHECK (escalate_after_hours IS NULL OR escalate_after_hours > 0);--> statement-breakpoint

-- A completed instance has no current step, and an instance still in flight has
-- one. Without this both can drift apart and "what is waiting for me?" stops
-- having a reliable answer.
ALTER TABLE workflow_instance
  ADD CONSTRAINT workflow_instance_step_matches_state
  CHECK ((is_complete AND current_step IS NULL) OR (NOT is_complete));--> statement-breakpoint

ALTER TABLE workflow_instance
  ADD CONSTRAINT workflow_instance_completed_at_matches_state
  CHECK ((is_complete) = (completed_at IS NOT NULL));--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Appendix B — the document types this release knows about, with their
-- allow-listed transitions.
--
-- Chart of Account is a master record, not a transaction, so it uses the short
-- form of the model: raised as a draft, submitted for approval, approved or
-- rejected, and cancellable before approval. §3.2 — "Each document type shall
-- use only the states applicable to its operational and accounting effect."
-- ---------------------------------------------------------------------------
INSERT INTO document_type (code, name, module, description) VALUES
  ('chart_of_account', 'Chart of Account', 'finance',
   'A General Ledger account. Raised by an Accounting Officer, approved by the Accounting Manager (§5.2, §14.4).');--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('chart_of_account', 'draft',     'submitted'),
  ('chart_of_account', 'draft',     'cancelled'),
  ('chart_of_account', 'submitted', 'approved'),
  ('chart_of_account', 'submitted', 'rejected'),
  ('chart_of_account', 'submitted', 'draft'),      -- recalled by the raiser
  ('chart_of_account', 'rejected',  'draft');      -- corrected and resubmitted--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The approval route for a Chart of Account change.
--
-- One step: the Accounting Manager. Self-approval is refused — an Accounting
-- Manager raising an account still needs a second pair of eyes on the chart
-- every posting in the system will be mapped against. §5.2 lets a Department
-- Manager finalise their own operational document; the Chart of Accounts is
-- configuration, and §5.5 keeps configuration under review.
-- ---------------------------------------------------------------------------
INSERT INTO workflow_definition (id, document_type_code, version, is_active)
VALUES ('00000000-0000-4000-8000-000000000001', 'chart_of_account', 1, true);--> statement-breakpoint

INSERT INTO workflow_step (definition_id, sequence, approver_role, allow_self_approval)
VALUES ('00000000-0000-4000-8000-000000000001', 1, 'accounting_manager', false);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The two finance roles this release needs, with their §5.3 verb grants.
--
-- Officer raises and submits; Manager additionally approves and configures.
-- Neither may administer users — §5.5: "The IT specialist has no authority to
-- change business processes"; the mirror of that is that accounting staff do
-- not administer the platform.
-- ---------------------------------------------------------------------------
INSERT INTO role (code, name, description, is_system) VALUES
  ('accounting_officer', 'Accounting Officer',
   'Raises accounting master data and journals; submits them for approval.', true),
  ('accounting_manager', 'Accounting Manager',
   'Approves accounting master data and journals; may post directly (§14.4).', true);--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'chart_of_account', 'view'),
  ('accounting_officer', 'chart_of_account', 'create'),
  ('accounting_officer', 'chart_of_account', 'edit_draft'),
  ('accounting_officer', 'chart_of_account', 'submit'),
  ('accounting_officer', 'chart_of_account', 'print'),
  ('accounting_manager', 'chart_of_account', 'view'),
  ('accounting_manager', 'chart_of_account', 'create'),
  ('accounting_manager', 'chart_of_account', 'edit_draft'),
  ('accounting_manager', 'chart_of_account', 'submit'),
  ('accounting_manager', 'chart_of_account', 'approve'),
  ('accounting_manager', 'chart_of_account', 'configure'),
  ('accounting_manager', 'chart_of_account', 'print'),
  ('accounting_manager', 'chart_of_account', 'export');--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Grants. Definitions and transitions are configuration the application reads;
-- decisions are append-only evidence it may only add to.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON document_type, document_status_transition, workflow_definition,
                workflow_step, workflow_instance, workflow_decision
    FROM erp_app;

  GRANT SELECT, INSERT, UPDATE ON document_type              TO erp_app;
  GRANT SELECT, INSERT, DELETE ON document_status_transition TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON workflow_definition        TO erp_app;
  GRANT SELECT, INSERT, DELETE ON workflow_step              TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON workflow_instance          TO erp_app;

  -- Append-only: a decision is never revised. A change of mind is a new
  -- decision on a new revision, and both are visible.
  GRANT SELECT, INSERT ON workflow_decision TO erp_app;
END;
$$;