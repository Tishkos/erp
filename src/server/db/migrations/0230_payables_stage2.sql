-- ===========================================================================
-- Payables Stage 2 — service & expense, recurring contracts, local goods,
-- advances, charged-to-import (REQ-AP-001 §9–§12, §20.2 capture, §21.2 seeds).
--
-- HAND-AUTHORED. Everything additive; no posted document changes meaning.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- §9.2 — the service receipt confirms a payable. It gains the payable, and
-- "a confirmation always answers to an order" widens by exactly one word:
-- an order OR the payable it confirms. Nothing that exists loses its anchor.
-- ---------------------------------------------------------------------------

ALTER TABLE "service_receipt" ADD COLUMN "payable_id" uuid REFERENCES "payable"("id");
--> statement-breakpoint
CREATE INDEX "service_receipt_payable_idx" ON "service_receipt" ("payable_id")
	WHERE "payable_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "service_receipt" ALTER COLUMN "purchase_order_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "service_receipt" ADD CONSTRAINT "service_receipt_answers_to_something" CHECK (
	"purchase_order_id" IS NOT NULL OR "payable_id" IS NOT NULL
);
--> statement-breakpoint
-- A payable-born confirmation has no ordered line; the service refuses a
-- missing line reference whenever the header names an order.
ALTER TABLE "service_receipt_line" ALTER COLUMN "purchase_order_line_id" DROP NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §12 — an advance payable and its accounting document hold hands.
-- ---------------------------------------------------------------------------

ALTER TABLE "supplier_advance" ADD COLUMN "payable_id" uuid REFERENCES "payable"("id");
--> statement-breakpoint
CREATE INDEX "supplier_advance_payable_idx" ON "supplier_advance" ("payable_id")
	WHERE "payable_id" IS NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §9.2, §20.2 — a forwarder's or broker's line that belongs to an import.
-- ---------------------------------------------------------------------------

ALTER TABLE "ap_invoice_line" ADD COLUMN "charged_to_payable_id" uuid REFERENCES "payable"("id");
--> statement-breakpoint
CREATE INDEX "ap_invoice_line_charged_to_idx" ON "ap_invoice_line" ("charged_to_payable_id")
	WHERE "charged_to_payable_id" IS NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §10 — recurring contracts. Amendments are rows, never edits.
-- ---------------------------------------------------------------------------

CREATE TABLE "recurring_contract" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_no" text NOT NULL,
	"supplier_id" uuid NOT NULL REFERENCES "business_partner"("id"),
	"department_code" text NOT NULL REFERENCES "department"("code"),
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	"expense_category_code" text NOT NULL REFERENCES "expense_category"("code"),
	"description" text NOT NULL,
	"currency" char(3) NOT NULL,
	"amount_per_period_txn" numeric(19,4) NOT NULL,
	"frequency" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"notice_days" integer,
	-- day_of_period:<n> · days_before_period_start:<n> · days_after_invoice:<n>
	"due_rule" text NOT NULL DEFAULT 'day_of_period:1',
	"generate_days_ahead" integer NOT NULL DEFAULT 30,
	-- D8 — a lease is its own receipt evidence; a metered bill is confirmed.
	"auto_confirm" boolean NOT NULL DEFAULT false,
	"invoice_expected" boolean NOT NULL DEFAULT true,
	"deposit_payable_id" uuid REFERENCES "payable"("id"),
	"status" text NOT NULL DEFAULT 'draft',
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"approved_by" uuid REFERENCES "app_user"("id"),
	"approved_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"ended_by" uuid REFERENCES "app_user"("id"),
	"end_reason" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_contract_status_known" CHECK ("status" IN ('draft','active','ended','cancelled')),
	CONSTRAINT "recurring_contract_frequency_known" CHECK ("frequency" IN ('monthly','quarterly','yearly')),
	CONSTRAINT "recurring_contract_amount_positive" CHECK ("amount_per_period_txn" > 0),
	CONSTRAINT "recurring_contract_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "recurring_contract_dates_ordered" CHECK ("end_date" IS NULL OR "end_date" >= "start_date")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_contract_no_uniq" ON "recurring_contract" ("contract_no");
--> statement-breakpoint
CREATE INDEX "recurring_contract_supplier_idx" ON "recurring_contract" ("supplier_id","status");
--> statement-breakpoint

-- An amendment names what changes and from when; the contract row keeps its
-- original words. The amount in force on a date is the newest amendment at or
-- before it, or the contract's own.
CREATE TABLE "recurring_contract_amendment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL REFERENCES "recurring_contract"("id"),
	"effective_from" date NOT NULL,
	"amount_per_period_txn" numeric(19,4),
	"note" text NOT NULL,
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_contract_amendment_amount_positive"
		CHECK ("amount_per_period_txn" IS NULL OR "amount_per_period_txn" > 0)
);
--> statement-breakpoint
CREATE INDEX "recurring_contract_amendment_idx" ON "recurring_contract_amendment" ("contract_id","effective_from");
--> statement-breakpoint
CREATE TRIGGER recurring_contract_amendment_append_only
	BEFORE UPDATE OR DELETE ON recurring_contract_amendment
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint

-- The payable's column from 0225 gains its table.
ALTER TABLE "payable" ADD CONSTRAINT "payable_recurring_contract_fk"
	FOREIGN KEY ("recurring_contract_id") REFERENCES "recurring_contract"("id");
--> statement-breakpoint
-- One payable per contract per period, ever (§10.2).
CREATE UNIQUE INDEX "payable_contract_period_uniq" ON "payable" ("recurring_contract_id","period_start")
	WHERE "recurring_contract_id" IS NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §20.2 — landed-cost charges are CAPTURED in Stage 2 (a forwarder's line
-- charged to an import); allocation and the lock are Stage 7.
-- ---------------------------------------------------------------------------

CREATE TABLE "landed_cost_type" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid REFERENCES "app_user"("id")
);
--> statement-breakpoint
INSERT INTO landed_cost_type (code, name) VALUES
	('purchase',        'Purchase (SWIFT paid)'),
	('bank_commission', 'Bank commission'),
	('loan_cost',       'Loan cost'),
	('freight',         'Freight'),
	('customs_asycuda', 'Customs / ASYCUDA'),
	('port_forwarding', 'Port & forwarding'),
	('other',           'Other');
--> statement-breakpoint

CREATE TABLE "landed_cost_charge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payable_id" uuid NOT NULL REFERENCES "payable"("id"),
	"charge_type_code" text NOT NULL REFERENCES "landed_cost_type"("code"),
	"amount_txn" numeric(19,4) NOT NULL,
	"currency" char(3) NOT NULL,
	"amount_iqd" numeric(19,4) NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"source_no" text,
	"note" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid REFERENCES "app_user"("id"),
	"cancel_reason" text,
	"created_by" uuid REFERENCES "app_user"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "landed_cost_charge_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "landed_cost_charge_cancel_has_reason" CHECK (
		("cancelled_at" IS NULL AND "cancelled_by" IS NULL)
		OR ("cancelled_at" IS NOT NULL AND "cancelled_by" IS NOT NULL
		    AND coalesce(btrim("cancel_reason"), '') <> '')
	)
);
--> statement-breakpoint
CREATE INDEX "landed_cost_charge_payable_idx" ON "landed_cost_charge" ("payable_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "landed_cost_charge_source_uniq" ON "landed_cost_charge" ("source_type","source_id")
	WHERE "cancelled_at" IS NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- RLS — through the parent, like every payable child (§23).
-- ---------------------------------------------------------------------------

ALTER TABLE recurring_contract ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE recurring_contract FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY recurring_contract_branch_scope ON recurring_contract
	USING (app_branch_allowed(branch_code))
	WITH CHECK (app_branch_allowed(branch_code));
--> statement-breakpoint
ALTER TABLE recurring_contract_amendment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE recurring_contract_amendment FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY recurring_contract_amendment_branch_scope ON recurring_contract_amendment
	USING (app_is_super_user() OR EXISTS (
		SELECT 1 FROM recurring_contract c
		 WHERE c.id = recurring_contract_amendment.contract_id
		   AND app_branch_allowed(c.branch_code)))
	WITH CHECK (app_is_super_user() OR EXISTS (
		SELECT 1 FROM recurring_contract c
		 WHERE c.id = recurring_contract_amendment.contract_id
		   AND app_branch_allowed(c.branch_code)));
--> statement-breakpoint
ALTER TABLE landed_cost_charge ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE landed_cost_charge FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY landed_cost_charge_branch_scope ON landed_cost_charge
	USING (app_is_super_user() OR EXISTS (
		SELECT 1 FROM payable p
		 WHERE p.id = landed_cost_charge.payable_id
		   AND app_branch_allowed(p.branch_code)))
	WITH CHECK (app_is_super_user() OR EXISTS (
		SELECT 1 FROM payable p
		 WHERE p.id = landed_cost_charge.payable_id
		   AND app_branch_allowed(p.branch_code)));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Numbering, events, grants
-- ---------------------------------------------------------------------------

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year) VALUES
	('RECURRING_CONTRACT', 'CTR', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);
--> statement-breakpoint

-- Local goods arriving is its own line in the story (§11).
INSERT INTO payable_event_code (code, lane_code, name) VALUES
	('GOODS_RECEIVED', 'warehouse', 'Goods received');
--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
	('accounting_officer', 'recurring_contract', 'view'),
	('accounting_officer', 'recurring_contract', 'create'),
	('accounting_officer', 'recurring_contract', 'edit_draft'),
	('accounting_manager', 'recurring_contract', 'view'),
	('accounting_manager', 'recurring_contract', 'create'),
	('accounting_manager', 'recurring_contract', 'edit_draft'),
	('accounting_manager', 'recurring_contract', 'approve'),
	('accounting_manager', 'recurring_contract', 'reverse_cancel'),
	('ceo',                'recurring_contract', 'view');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §21.2 — the workbench's seed views become shared saved-view rows, owned by
-- the first administrator so the column's NOT NULL holds. A database with no
-- user yet (CI mid-migration) skips them; the workbench's built-in presets
-- stand in until a person exists.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
	v_owner uuid;
BEGIN
	SELECT u.id INTO v_owner
	  FROM app_user u
	  LEFT JOIN user_role r ON r.user_id = u.id AND r.role_code = 'system_administrator'
	 WHERE u.is_active AND (u.is_super_user OR r.user_id IS NOT NULL)
	 ORDER BY u.created_at LIMIT 1;

	IF v_owner IS NULL THEN
		RAISE NOTICE 'No administrator yet — the workbench seeds its views from code until one exists.';
		RETURN;
	END IF;

	INSERT INTO saved_view (list_key, name, owner_user_id, is_shared, query) VALUES
		('payables', '1 · All open',                 v_owner, true, '{}'::jsonb),
		('payables', '2 · Stopped — reason required', v_owner, true, '{"stopped":"needs_reason"}'::jsonb),
		('payables', '3 · Stopped',                  v_owner, true, '{"stopped":"yes"}'::jsonb),
		('payables', '4 · Imports',                  v_owner, true, '{"type":"import"}'::jsonb),
		('payables', '5 · Rent & contracts',         v_owner, true, '{"type":"recurring"}'::jsonb);
END;
$$;
--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;

	REVOKE ALL ON recurring_contract, recurring_contract_amendment,
	              landed_cost_type, landed_cost_charge FROM erp_app;

	GRANT SELECT, INSERT, UPDATE ON recurring_contract TO erp_app;
	-- Amendments and charges gain rows and lose none (R3); a wrong charge is
	-- cancelled with a reason, which is an UPDATE of its own columns.
	GRANT SELECT, INSERT ON recurring_contract_amendment TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON landed_cost_type   TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON landed_cost_charge TO erp_app;
END;
$$;
