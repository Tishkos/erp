-- ===========================================================================
-- REQ-PM-001 Stage PM-3 — Project System: execution (2026-10-02). Over
-- Phase 11 (0148), PM-1 (0245) and PM-2 (0246).
--
--   purchase_order / payable / ap_invoice (+columns)
--                               the project, the element and the cost code a
--                               purchase is assigned to (§8): the order's
--                               approval commits, the invoice's posting
--                               converts the commitment to an actual
--   project_commitment.payable_id  a service or recurring payable without an
--                               order is a commitment of its own
--   project_cost (+columns)     the source document behind the index row and
--                               the row a reversal undoes (§8)
--   project_material_issue      the Material Issues document (§9): one
--   project_material_issue_line element and cost code, a warehouse, lines of
--                               items issued (or returned) at layer cost,
--                               each line naming its stock movement; the
--                               one-time form id of the transfer forms
--
-- Series PROJECT_ISSUE → PMI-{BRANCH}-{YYYY}-{SERIAL}.
-- ===========================================================================

-- The assignment on the three purchasing documents.
ALTER TABLE "purchase_order" ADD COLUMN "project_code" text;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD COLUMN "wbs_code" text;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD COLUMN "cost_code" text;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_project_code_fk" FOREIGN KEY ("project_code") REFERENCES "public"."project"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_wbs_fk" FOREIGN KEY ("project_code", "wbs_code") REFERENCES "public"."project_wbs"("project_code", "code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_cost_code_fk" FOREIGN KEY ("cost_code") REFERENCES "public"."project_cost_code"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- An assignment is the three together, or nothing.
ALTER TABLE "purchase_order" ADD CONSTRAINT "purchase_order_assignment_complete" CHECK (("project_code" IS NULL) = ("wbs_code" IS NULL) AND ("project_code" IS NULL) = ("cost_code" IS NULL));--> statement-breakpoint
CREATE INDEX "purchase_order_project_idx" ON "purchase_order" USING btree ("project_code", "wbs_code");--> statement-breakpoint

ALTER TABLE "payable" ADD COLUMN "project_code" text;--> statement-breakpoint
ALTER TABLE "payable" ADD COLUMN "wbs_code" text;--> statement-breakpoint
ALTER TABLE "payable" ADD COLUMN "cost_code" text;--> statement-breakpoint
ALTER TABLE "payable" ADD CONSTRAINT "payable_project_code_fk" FOREIGN KEY ("project_code") REFERENCES "public"."project"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payable" ADD CONSTRAINT "payable_wbs_fk" FOREIGN KEY ("project_code", "wbs_code") REFERENCES "public"."project_wbs"("project_code", "code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payable" ADD CONSTRAINT "payable_cost_code_fk" FOREIGN KEY ("cost_code") REFERENCES "public"."project_cost_code"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payable" ADD CONSTRAINT "payable_assignment_complete" CHECK (("project_code" IS NULL) = ("wbs_code" IS NULL) AND ("project_code" IS NULL) = ("cost_code" IS NULL));--> statement-breakpoint
CREATE INDEX "payable_project_idx" ON "payable" USING btree ("project_code", "wbs_code");--> statement-breakpoint

ALTER TABLE "ap_invoice" ADD COLUMN "project_code" text;--> statement-breakpoint
ALTER TABLE "ap_invoice" ADD COLUMN "wbs_code" text;--> statement-breakpoint
ALTER TABLE "ap_invoice" ADD COLUMN "cost_code" text;--> statement-breakpoint
ALTER TABLE "ap_invoice" ADD CONSTRAINT "ap_invoice_project_code_fk" FOREIGN KEY ("project_code") REFERENCES "public"."project"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_invoice" ADD CONSTRAINT "ap_invoice_wbs_fk" FOREIGN KEY ("project_code", "wbs_code") REFERENCES "public"."project_wbs"("project_code", "code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_invoice" ADD CONSTRAINT "ap_invoice_cost_code_fk" FOREIGN KEY ("cost_code") REFERENCES "public"."project_cost_code"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_invoice" ADD CONSTRAINT "ap_invoice_assignment_complete" CHECK (("project_code" IS NULL) = ("wbs_code" IS NULL) AND ("project_code" IS NULL) = ("cost_code" IS NULL));--> statement-breakpoint
CREATE INDEX "ap_invoice_project_idx" ON "ap_invoice" USING btree ("project_code", "wbs_code");--> statement-breakpoint

-- A payable without an order is a commitment of its own (§8).
ALTER TABLE "project_commitment" ADD COLUMN "payable_id" uuid;--> statement-breakpoint
ALTER TABLE "project_commitment" ADD CONSTRAINT "project_commitment_payable_id_fk" FOREIGN KEY ("payable_id") REFERENCES "public"."payable"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_commitment_payable_idx" ON "project_commitment" USING btree ("payable_id");--> statement-breakpoint

-- The document behind an actual, and the row a reversal undoes (§8).
ALTER TABLE "project_cost" ADD COLUMN "source_type" text;--> statement-breakpoint
ALTER TABLE "project_cost" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "project_cost" ADD COLUMN "reverses_cost_id" uuid;--> statement-breakpoint
ALTER TABLE "project_cost" ADD COLUMN "consumed_commitment_id" uuid;--> statement-breakpoint
ALTER TABLE "project_cost" ADD CONSTRAINT "project_cost_consumed_commitment_id_fk" FOREIGN KEY ("consumed_commitment_id") REFERENCES "public"."project_commitment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_cost" ADD CONSTRAINT "project_cost_reverses_cost_id_fk" FOREIGN KEY ("reverses_cost_id") REFERENCES "public"."project_cost"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- A cost is reversed once.
CREATE UNIQUE INDEX "project_cost_reversal_uniq" ON "project_cost" USING btree ("reverses_cost_id") WHERE "reverses_cost_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "project_cost_source_idx" ON "project_cost" USING btree ("source_type", "source_id");--> statement-breakpoint

-- The Material Issues document (§9).
CREATE TABLE "project_material_issue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_no" text NOT NULL,
	"project_code" text NOT NULL,
	"wbs_code" text NOT NULL,
	"cost_code" text NOT NULL,
	"warehouse_code" text NOT NULL,
	"branch_code" text NOT NULL,
	"kind" text DEFAULT 'issue' NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"movement_date" date NOT NULL,
	"description" text,
	"total_cost_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"created_by" uuid NOT NULL,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_material_issue_no_uniq" UNIQUE ("document_no"),
	CONSTRAINT "project_material_issue_kind" CHECK ("kind" IN ('issue', 'return')),
	CONSTRAINT "project_material_issue_status" CHECK ("status" IN ('draft', 'posted', 'cancelled')),
	CONSTRAINT "project_material_issue_posted_complete" CHECK (("posted_by" IS NULL) = ("posted_at" IS NULL) AND ("status" <> 'posted' OR "posted_at" IS NOT NULL)),
	CONSTRAINT "project_material_issue_cancel_complete" CHECK (("cancelled_by" IS NULL) = ("cancelled_at" IS NULL) AND ("cancelled_at" IS NULL OR coalesce(btrim("cancel_reason"), '') <> ''))
);--> statement-breakpoint
ALTER TABLE "project_material_issue" ADD CONSTRAINT "project_material_issue_project_code_fk" FOREIGN KEY ("project_code") REFERENCES "public"."project"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_material_issue" ADD CONSTRAINT "project_material_issue_wbs_fk" FOREIGN KEY ("project_code", "wbs_code") REFERENCES "public"."project_wbs"("project_code", "code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_material_issue" ADD CONSTRAINT "project_material_issue_cost_code_fk" FOREIGN KEY ("cost_code") REFERENCES "public"."project_cost_code"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_material_issue" ADD CONSTRAINT "project_material_issue_warehouse_code_fk" FOREIGN KEY ("warehouse_code") REFERENCES "public"."warehouse"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_material_issue" ADD CONSTRAINT "project_material_issue_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_material_issue" ADD CONSTRAINT "project_material_issue_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_material_issue" ADD CONSTRAINT "project_material_issue_posted_by_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_material_issue" ADD CONSTRAINT "project_material_issue_cancelled_by_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_material_issue_project_idx" ON "project_material_issue" USING btree ("project_code", "status");--> statement-breakpoint

CREATE TABLE "project_material_issue_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"item_code" text NOT NULL,
	"quantity" numeric(24, 6) NOT NULL,
	"serial_number" text,
	"batch_number" text,
	"unit_cost_iqd" numeric(19, 4),
	"movement_id" uuid,
	"cost_id" uuid,
	"cost_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "project_material_issue_line_uniq" UNIQUE ("issue_id", "line_no"),
	CONSTRAINT "project_material_issue_line_quantity_positive" CHECK ("quantity" > 0),
	CONSTRAINT "project_material_issue_line_no_positive" CHECK ("line_no" >= 1)
);--> statement-breakpoint
ALTER TABLE "project_material_issue_line" ADD CONSTRAINT "project_material_issue_line_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."project_material_issue"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_material_issue_line" ADD CONSTRAINT "project_material_issue_line_item_code_fk" FOREIGN KEY ("item_code") REFERENCES "public"."item"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_material_issue_line" ADD CONSTRAINT "project_material_issue_line_movement_id_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."inventory_movement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_material_issue_line" ADD CONSTRAINT "project_material_issue_line_cost_id_fk" FOREIGN KEY ("cost_id") REFERENCES "public"."project_cost"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_material_issue_line_movement_idx" ON "project_material_issue_line" USING btree ("movement_id");--> statement-breakpoint

-- Row-level security: the document by its project's branch, the lines through it.
ALTER TABLE "project_material_issue" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_material_issue" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY project_material_issue_scope ON "project_material_issue" USING (app_branch_allowed(branch_code)) WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint
ALTER TABLE "project_material_issue_line" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_material_issue_line" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY project_material_issue_line_scope ON "project_material_issue_line"
  USING (EXISTS (SELECT 1 FROM project_material_issue d WHERE d.id = issue_id))
  WITH CHECK (EXISTS (SELECT 1 FROM project_material_issue d WHERE d.id = issue_id));--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	GRANT SELECT, INSERT, UPDATE ON "project_material_issue" TO erp_app;
	GRANT SELECT, INSERT, UPDATE, DELETE ON "project_material_issue_line" TO erp_app;
END $$;--> statement-breakpoint

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year) VALUES
	('PROJECT_ISSUE', 'PMI', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true)
ON CONFLICT (key) DO NOTHING;--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
	('project_material_issue', 'Material Issue', 'projects', 'Stock issued from a warehouse to a project element at layer cost, or returned at the cost it went out at (REQ-PM-001 §9).')
ON CONFLICT (code) DO NOTHING;
