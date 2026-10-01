-- ===========================================================================
-- Payables core — REQ-AP-001 Stage 1 (§5–§7, §19).
--
-- HAND-AUTHORED, like every migration since the schema generator was retired.
-- One record per thing the company has to pay, of five seeded types; a stage
-- rail per type, derived never typed; holds that answer "where is it stopped
-- and why"; and every list a master table an accounting manager edits (R4).
--
-- The status log itself (payable_event) is NOT here — it is partitioned by
-- year, which needs its own hand-authored DDL: see 0226.
--
-- Seed rows carry created_by NULL; rows added later through the settings
-- screen record their author — which is also how the test reset tells seed
-- from fixture.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Masters (R4)
-- ---------------------------------------------------------------------------

CREATE TABLE "payable_lane" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sort_order" smallint NOT NULL
);
--> statement-breakpoint

CREATE TABLE "payable_type" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"requires_po" boolean DEFAULT false NOT NULL,
	"requires_department" boolean DEFAULT false NOT NULL,
	"requires_receipt" boolean DEFAULT false NOT NULL,
	"number_series_key" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_by" uuid REFERENCES "app_user"("id")
);
--> statement-breakpoint

CREATE TABLE "payable_type_lane" (
	"payable_type_code" text NOT NULL REFERENCES "payable_type"("code"),
	"lane_code" text NOT NULL REFERENCES "payable_lane"("code")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payable_type_lane_uniq" ON "payable_type_lane" ("payable_type_code","lane_code");
--> statement-breakpoint

CREATE TABLE "payable_stage" (
	"payable_type_code" text NOT NULL REFERENCES "payable_type"("code"),
	"code" text NOT NULL,
	"sequence" smallint NOT NULL,
	"name" text NOT NULL,
	"rule_name" text NOT NULL,
	"is_terminal_mark" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid REFERENCES "app_user"("id"),
	CONSTRAINT "payable_stage_sequence_positive" CHECK ("sequence" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payable_stage_code_uniq" ON "payable_stage" ("payable_type_code","code");
--> statement-breakpoint
CREATE INDEX "payable_stage_sequence_idx" ON "payable_stage" ("payable_type_code","sequence");
--> statement-breakpoint

CREATE TABLE "payable_event_code" (
	"code" text PRIMARY KEY NOT NULL,
	"lane_code" text NOT NULL REFERENCES "payable_lane"("code"),
	"name" text NOT NULL,
	"summary_template" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid REFERENCES "app_user"("id")
);
--> statement-breakpoint

CREATE TABLE "hold_reason_code" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"lane_hint" text REFERENCES "payable_lane"("code"),
	"default_owner_role" text,
	"requires_detail" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid REFERENCES "app_user"("id")
);
--> statement-breakpoint

CREATE TABLE "expense_category" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"default_expense_account_id" uuid REFERENCES "chart_of_account"("id"),
	"requires_po" boolean DEFAULT false NOT NULL,
	"requires_receipt" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid REFERENCES "app_user"("id")
);
--> statement-breakpoint

CREATE TABLE "sweep_check" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"lane_code" text NOT NULL REFERENCES "payable_lane"("code"),
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid REFERENCES "app_user"("id")
);
--> statement-breakpoint

CREATE TABLE "stage_time_limit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"check_code" text NOT NULL REFERENCES "sweep_check"("code"),
	"scope" text DEFAULT 'all' NOT NULL,
	"limit_days" integer NOT NULL,
	"escalate_after_days" integer,
	"escalate_to_role" text,
	"active" boolean DEFAULT true NOT NULL,
	"valid_from" date NOT NULL,
	"created_by" uuid REFERENCES "app_user"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stage_time_limit_days_not_negative" CHECK ("limit_days" >= 0)
);
--> statement-breakpoint
CREATE INDEX "stage_time_limit_check_idx" ON "stage_time_limit" ("check_code","active");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The payable (§5.1) and its order lines
-- ---------------------------------------------------------------------------

CREATE TABLE "payable" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payable_no" text NOT NULL,
	"payable_type_code" text NOT NULL REFERENCES "payable_type"("code"),
	"supplier_reference" text NOT NULL,
	"supplier_reference_key" text NOT NULL,
	"supplier_id" uuid NOT NULL REFERENCES "business_partner"("id"),
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	"department_code" text REFERENCES "department"("code"),
	"currency" char(3) NOT NULL,
	"amount_txn" numeric(19,4) DEFAULT '0' NOT NULL,
	"amount_iqd" numeric(19,4) DEFAULT '0' NOT NULL,
	"quantity" numeric(24,6),
	"document_date" date NOT NULL,
	"description" text NOT NULL,
	"payment_terms_text" text,
	"purchase_order_id" uuid REFERENCES "purchase_order"("id"),
	"recurring_contract_id" uuid,
	"expense_category_code" text REFERENCES "expense_category"("code"),
	"charged_to_payable_id" uuid,
	"due_date" date,
	"period_start" date,
	"period_end" date,
	"stage_code" text NOT NULL,
	"stage_since" timestamp with time zone DEFAULT now() NOT NULL,
	"on_hold" boolean DEFAULT false NOT NULL,
	"closed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by" uuid REFERENCES "app_user"("id"),
	"cancel_reason" text,
	"source" text DEFAULT 'erp' NOT NULL,
	"source_row" text,
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payable_stage_fk" FOREIGN KEY ("payable_type_code","stage_code")
		REFERENCES "payable_stage"("payable_type_code","code"),
	CONSTRAINT "payable_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "payable_reference_key_shape" CHECK ("supplier_reference_key" ~ '^[A-Z0-9]+$'),
	CONSTRAINT "payable_cancel_has_reason" CHECK (
		("cancelled_at" IS NULL AND "cancelled_by" IS NULL)
		OR ("cancelled_at" IS NOT NULL AND "cancelled_by" IS NOT NULL
		    AND coalesce(btrim("cancel_reason"), '') <> '')
	)
);
--> statement-breakpoint
ALTER TABLE "payable" ADD CONSTRAINT "payable_charged_to_fk"
	FOREIGN KEY ("charged_to_payable_id") REFERENCES "payable"("id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payable_no_uniq" ON "payable" ("payable_no");
--> statement-breakpoint
-- R1 — one payable per supplier reference, per supplier and type.
CREATE UNIQUE INDEX "payable_reference_uniq" ON "payable" ("supplier_id","payable_type_code","supplier_reference_key");
--> statement-breakpoint
CREATE INDEX "payable_type_stage_idx" ON "payable" ("payable_type_code","stage_code");
--> statement-breakpoint
CREATE INDEX "payable_supplier_idx" ON "payable" ("supplier_id");
--> statement-breakpoint
CREATE INDEX "payable_branch_idx" ON "payable" ("branch_code");
--> statement-breakpoint
CREATE INDEX "payable_hold_idx" ON "payable" ("on_hold");
--> statement-breakpoint

CREATE TABLE "payable_order_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payable_id" uuid NOT NULL REFERENCES "payable"("id") ON DELETE CASCADE,
	"line_no" integer NOT NULL,
	"item_code" text REFERENCES "item"("code"),
	"expense_category_code" text REFERENCES "expense_category"("code"),
	"description" text NOT NULL,
	"quantity" numeric(24,6),
	"uom_code" text REFERENCES "unit_of_measure"("code"),
	"unit_price" numeric(19,4),
	"amount_txn" numeric(19,4),
	CONSTRAINT "payable_order_line_quantity_positive" CHECK ("quantity" IS NULL OR "quantity" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payable_order_line_no_uniq" ON "payable_order_line" ("payable_id","line_no");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Holds (§19)
-- ---------------------------------------------------------------------------

CREATE TABLE "payable_hold" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payable_id" uuid NOT NULL REFERENCES "payable"("id"),
	"lane_code" text NOT NULL REFERENCES "payable_lane"("code"),
	"stage_code" text,
	"source_type" text,
	"source_id" text,
	"reason_code" text NOT NULL REFERENCES "hold_reason_code"("code"),
	"detail" text,
	"owner_user_id" uuid REFERENCES "app_user"("id"),
	"started_at" timestamp with time zone NOT NULL,
	"next_action" text,
	"next_action_due" date,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid REFERENCES "app_user"("id"),
	"resolution" text,
	"escalated_at" timestamp with time zone,
	"escalated_to_role" text,
	"check_code" text REFERENCES "sweep_check"("code"),
	"created_by" uuid REFERENCES "app_user"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payable_hold_status_known" CHECK ("status" IN ('open','resolved')),
	CONSTRAINT "payable_hold_resolved_complete" CHECK (
		("status" = 'open' AND "resolved_at" IS NULL)
		OR ("status" = 'resolved' AND "resolved_at" IS NOT NULL
		    AND coalesce(btrim("resolution"), '') <> '')
	)
);
--> statement-breakpoint
CREATE INDEX "payable_hold_payable_idx" ON "payable_hold" ("payable_id","status");
--> statement-breakpoint
-- §19.3 — the sweep never opens a second hold for the same condition.
CREATE UNIQUE INDEX "payable_hold_check_open_uniq" ON "payable_hold" ("payable_id","check_code")
	WHERE status = 'open' AND check_code IS NOT NULL;
--> statement-breakpoint

CREATE TABLE "payable_hold_update" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hold_id" uuid NOT NULL REFERENCES "payable_hold"("id"),
	"payable_id" uuid NOT NULL REFERENCES "payable"("id"),
	"kind" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"note" text,
	"changed_by" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payable_hold_update_kind_known" CHECK (
		"kind" IN ('opened','completed','updated','reassigned','resolved','escalated')
	)
);
--> statement-breakpoint
CREATE INDEX "payable_hold_update_hold_idx" ON "payable_hold_update" ("hold_id","changed_at");
--> statement-breakpoint

-- The thread is evidence: a hold's history can gain rows and lose none (R3).
CREATE TRIGGER payable_hold_update_append_only
	BEFORE UPDATE OR DELETE ON payable_hold_update
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The invoice joins its payable (§5.1)
-- ---------------------------------------------------------------------------

ALTER TABLE "ap_invoice" ADD COLUMN "payable_id" uuid REFERENCES "payable"("id");
--> statement-breakpoint
CREATE INDEX "ap_invoice_payable_idx" ON "ap_invoice" ("payable_id") WHERE "payable_id" IS NOT NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Row-level security (§2, §23) — the record of what happened is branch-scoped;
-- configuration is company-wide, like posting rules.
-- ---------------------------------------------------------------------------

ALTER TABLE payable ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE payable FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY payable_branch_scope ON payable
	USING (app_branch_allowed(branch_code))
	WITH CHECK (app_branch_allowed(branch_code));
--> statement-breakpoint

ALTER TABLE payable_order_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE payable_order_line FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY payable_order_line_branch_scope ON payable_order_line
	USING (
		app_is_super_user()
		OR EXISTS (SELECT 1 FROM payable p
		            WHERE p.id = payable_order_line.payable_id
		              AND app_branch_allowed(p.branch_code))
	)
	WITH CHECK (
		app_is_super_user()
		OR EXISTS (SELECT 1 FROM payable p
		            WHERE p.id = payable_order_line.payable_id
		              AND app_branch_allowed(p.branch_code))
	);
--> statement-breakpoint

ALTER TABLE payable_hold ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE payable_hold FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY payable_hold_branch_scope ON payable_hold
	USING (
		app_is_super_user()
		OR EXISTS (SELECT 1 FROM payable p
		            WHERE p.id = payable_hold.payable_id
		              AND app_branch_allowed(p.branch_code))
	)
	WITH CHECK (
		app_is_super_user()
		OR EXISTS (SELECT 1 FROM payable p
		            WHERE p.id = payable_hold.payable_id
		              AND app_branch_allowed(p.branch_code))
	);
--> statement-breakpoint

ALTER TABLE payable_hold_update ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE payable_hold_update FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY payable_hold_update_branch_scope ON payable_hold_update
	USING (
		app_is_super_user()
		OR EXISTS (SELECT 1 FROM payable p
		            WHERE p.id = payable_hold_update.payable_id
		              AND app_branch_allowed(p.branch_code))
	)
	WITH CHECK (
		app_is_super_user()
		OR EXISTS (SELECT 1 FROM payable p
		            WHERE p.id = payable_hold_update.payable_id
		              AND app_branch_allowed(p.branch_code))
	);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Number series (§5.1) — one per type, maintained on the Numbering screen.
-- ---------------------------------------------------------------------------

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year) VALUES
	('PAYABLE_IMPORT',      'IMP', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true),
	('PAYABLE_SERVICE',     'SVC', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true),
	('PAYABLE_RECURRING',   'RNT', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true),
	('PAYABLE_LOCAL_GOODS', 'PUR', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true),
	('PAYABLE_ADVANCE',     'ADV', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Seeds — every day number and list below is a starting point, not a rule (R4).
-- ---------------------------------------------------------------------------

INSERT INTO payable_lane (code, name, sort_order) VALUES
	('payable',   'Payable',            1),
	('order',     'Order & invoice',    2),
	('service',   'Service',            3),
	('contract',  'Contract',           4),
	('bank',      'Bank & finance',     5),
	('payment',   'Payment',            6),
	('pd',        'PD / ASYCUDA',       7),
	('shipment',  'Shipment',           8),
	('warehouse', 'Warehouse & stock',  9),
	('cost',      'Landed cost',       10),
	('hold',      'Holds',             11);
--> statement-breakpoint

INSERT INTO payable_type (code, name, requires_po, requires_department, requires_receipt, number_series_key, sort_order) VALUES
	('import',      'Import application',  true,  false, true,  'PAYABLE_IMPORT',      1),
	('service',     'Service & expense',   false, true,  true,  'PAYABLE_SERVICE',     2),
	('recurring',   'Recurring contract',  false, true,  false, 'PAYABLE_RECURRING',   3),
	('local_goods', 'Local goods',         true,  false, true,  'PAYABLE_LOCAL_GOODS', 4),
	('advance',     'Advance',             false, false, false, 'PAYABLE_ADVANCE',     5);
--> statement-breakpoint

INSERT INTO payable_type_lane (payable_type_code, lane_code) VALUES
	('import','order'), ('import','bank'), ('import','payment'), ('import','pd'),
	('import','shipment'), ('import','warehouse'), ('import','cost'),
	('service','order'), ('service','service'), ('service','bank'), ('service','payment'),
	('recurring','contract'), ('recurring','service'), ('recurring','bank'), ('recurring','payment'),
	('local_goods','order'), ('local_goods','warehouse'), ('local_goods','bank'), ('local_goods','payment'),
	('advance','bank'), ('advance','payment');
--> statement-breakpoint

-- §6 — the seed rails. The rule names are implemented in domain/payables.ts;
-- rules over lanes whose documents arrive in later stages evaluate false
-- until those documents exist, which is exactly R2.
INSERT INTO payable_stage (payable_type_code, code, sequence, name, rule_name, is_terminal_mark) VALUES
	('import', 'order_confirmed',     1, 'Order confirmed',     'opened',                 false),
	('import', 'invoiced_funded',     2, 'Invoiced + funded',   'import_invoiced_funded', false),
	('import', 'pd_registered',       3, 'PD registered',       'import_pd_registered',   false),
	('import', 'payment_in_progress', 4, 'Payment in progress', 'payment_sent',           false),
	('import', 'shipped',             5, 'Shipped',             'import_shipped',         false),
	('import', 'partly_received',     6, 'Partly received',     'import_partly_received', false),
	('import', 'all_received',        7, 'All received',        'import_all_received',    true),
	('import', 'cleared',             8, 'Cleared',             'import_cleared',         true),

	('service', 'requested',           1, 'Requested',            'opened',            false),
	('service', 'confirmed',           2, 'Received / confirmed', 'service_confirmed', false),
	('service', 'invoiced',            3, 'Invoiced',             'invoice_posted',    false),
	('service', 'approved',            4, 'Approved for payment', 'invoice_approved',  false),
	('service', 'payment_in_progress', 5, 'Payment in progress',  'payment_sent',      false),
	('service', 'paid',                6, 'Paid',                 'fully_paid',        false),
	('service', 'closed',              7, 'Closed',               'closed_matched',    true),

	('recurring', 'due',                 1, 'Due',                 'opened',              false),
	('recurring', 'confirmed',           2, 'Confirmed',           'recurring_confirmed', false),
	('recurring', 'invoiced',            3, 'Invoiced',            'invoice_posted',      false),
	('recurring', 'approved',            4, 'Approved',            'invoice_approved',    false),
	('recurring', 'payment_in_progress', 5, 'Payment in progress', 'payment_sent',        false),
	('recurring', 'paid',                6, 'Paid',                'fully_paid',          false),
	('recurring', 'closed',              7, 'Closed',              'closed_matched',      true),

	('local_goods', 'ordered',             1, 'Ordered',             'opened',           false),
	('local_goods', 'received',            2, 'Received',            'goods_received',   false),
	('local_goods', 'invoiced',            3, 'Invoiced',            'invoice_posted',   false),
	('local_goods', 'approved',            4, 'Approved',            'invoice_approved', false),
	('local_goods', 'payment_in_progress', 5, 'Payment in progress', 'payment_sent',     false),
	('local_goods', 'paid',                6, 'Paid',                'fully_paid',       false),
	('local_goods', 'closed',              7, 'Closed',              'closed_matched',   true),

	('advance', 'requested',           1, 'Requested',           'opened',           false),
	('advance', 'approved',            2, 'Approved',            'advance_approved', false),
	('advance', 'payment_in_progress', 3, 'Payment in progress', 'payment_sent',     false),
	('advance', 'paid',                4, 'Paid',                'advance_paid',     false),
	('advance', 'settled',             5, 'Settled',             'advance_settled',  true);
--> statement-breakpoint

-- §7.2 — the event catalogue. Codes are never deleted; new ones are rows.
INSERT INTO payable_event_code (code, lane_code, name) VALUES
	('PAYABLE_OPENED',    'payable', 'Payable opened'),
	('STAGE_CHANGED',     'payable', 'Stage changed'),
	('FIELD_CHANGED',     'payable', 'Field changed'),
	('ATTACHMENT_ADDED',  'payable', 'Attachment added'),
	('NOTE_ADDED',        'payable', 'Note added'),
	('CLEARED',           'payable', 'Cleared'),
	('CLOSED',            'payable', 'Closed'),
	('CANCELLED',         'payable', 'Cancelled'),
	('CORRECTION',        'payable', 'Correction'),

	('PO_LINKED',          'order', 'Purchase order linked'),
	('PI_RECORDED',        'order', 'Proforma recorded'),
	('INVOICE_POSTED',     'order', 'Purchase invoice posted'),
	('INVOICE_REVERSED',   'order', 'Purchase invoice reversed'),
	('INVOICE_APPROVED',   'order', 'Invoice approved'),
	('NON_PO_JUSTIFIED',   'order', 'Non-PO invoice justified'),
	('MATCH_EXCEPTION',    'order', 'Match exception'),
	('CREDIT_MEMO_APPLIED','order', 'Credit memo applied'),
	('TERMS_SET',          'order', 'Payment terms set'),
	('TERMS_CHANGED',      'order', 'Payment terms changed'),
	('MOVED_TO_BL',        'order', 'Moved to B/L'),

	('SERVICE_RECEIPT_CREATED',  'service', 'Service receipt created'),
	('SERVICE_CONFIRMED',        'service', 'Service confirmed'),
	('SERVICE_DISPUTED',         'service', 'Service disputed'),
	('SERVICE_RECEIPT_REVERSED', 'service', 'Service receipt reversed'),

	('CONTRACT_LINKED',       'contract', 'Contract linked'),
	('PERIOD_GENERATED',      'contract', 'Period generated'),
	('PERIOD_AUTO_CONFIRMED', 'contract', 'Period auto-confirmed'),
	('CONTRACT_AMENDED',      'contract', 'Contract amended'),
	('CONTRACT_ENDED',        'contract', 'Contract ended'),

	('BANK_ACCOUNT_ASSIGNED',   'bank', 'Bank account assigned'),
	('DEPOSIT_RECORDED',        'bank', 'Deposit recorded'),
	('LOAN_LINKED',             'bank', 'Loan linked'),
	('FUNDS_RESERVED',          'bank', 'Funds reserved'),
	('FUNDS_RELEASED',          'bank', 'Funds released'),
	('DEBIT_FINAL',             'bank', 'Debit final'),
	('LOAN_INSTALMENT_PAID',    'bank', 'Loan instalment paid'),
	('LOAN_INSTALMENT_OVERDUE', 'bank', 'Loan instalment overdue'),
	('COMMISSION_RECORDED',     'bank', 'Commission recorded'),

	('INSTALMENT_PLANNED',  'payment', 'Instalment planned'),
	('PAYMENT_APPLIED',     'payment', 'Payment applied to bank'),
	('PAYMENT_METHOD_SET',  'payment', 'Payment method set'),
	('SWIFT_PENDING',       'payment', 'SWIFT pending'),
	('SWIFT_CONFIRMED',     'payment', 'SWIFT confirmed'),
	('TRANSFER_CONFIRMED',  'payment', 'Transfer confirmed'),
	('CASH_PAID',           'payment', 'Cash paid'),
	('PAYMENT_REJECTED',    'payment', 'Payment rejected'),
	('PAYMENT_CANCELLED',   'payment', 'Payment cancelled'),
	('FULLY_PAID',          'payment', 'Fully paid'),
	('SWIFT_OVER_LIMIT',    'payment', 'SWIFT over limit'),

	('PD_SUBMITTED',           'pd', 'PD submitted'),
	('PD_STATUS_CHANGED',      'pd', 'PD status changed'),
	('PORT_FILE_SENT',         'pd', 'Port file sent'),
	('PD_EXPIRING',            'pd', 'PD expiring'),
	('PD_EXPIRED',             'pd', 'PD expired'),
	('PD_REJECTED',            'pd', 'PD rejected'),
	('PD_REREGISTERED',        'pd', 'PD re-registered'),
	('PD_TOTALLY_WRITTEN_OFF', 'pd', 'PD totally written off'),

	('BL_ISSUED',                'shipment', 'B/L issued'),
	('CONTAINER_ADDED',          'shipment', 'Container added'),
	('CONTAINER_STATUS_CHANGED', 'shipment', 'Container status changed'),
	('ETA_CHANGED',              'shipment', 'ETA changed'),
	('CONTAINER_LATE',           'shipment', 'Container late'),
	('ALL_CONTAINERS_RECEIVED',  'shipment', 'All containers received'),

	('CONTAINER_RECEIVED', 'warehouse', 'Container received'),
	('QUANTITY_VARIANCE',  'warehouse', 'Quantity variance'),
	('STOCK_AVAILABLE',    'warehouse', 'Stock available'),
	('OUTBOUND_RECORDED',  'warehouse', 'Outbound recorded'),

	('HOLD_OPENED',         'hold', 'Hold opened'),
	('HOLD_COMPLETED',      'hold', 'Hold completed'),
	('HOLD_UPDATED',        'hold', 'Hold updated'),
	('HOLD_REASSIGNED',     'hold', 'Hold reassigned'),
	('HOLD_RESOLVED',       'hold', 'Hold resolved'),
	('OVER_LIMIT_DETECTED', 'hold', 'Over time limit'),
	('ESCALATED',           'hold', 'Escalated'),

	('CHARGE_RECORDED',     'cost', 'Charge recorded'),
	('CHARGED_TO_IMPORT',   'cost', 'Charged to import'),
	('LANDED_COST_LOCKED',  'cost', 'Landed cost locked'),
	('ITEM_COST_ALLOCATED', 'cost', 'Item cost allocated');
--> statement-breakpoint

-- §19.2 — the diagram's twelve reason codes, plus the system's own.
-- Default owners per D2.
INSERT INTO hold_reason_code (code, name, lane_hint, default_owner_role, requires_detail) VALUES
	('PD',   'PD not validated / expired',       'pd',       'customs_officer',    false),
	('FUND', 'Waiting deposit or loan',          'bank',     'accounting_officer', false),
	('DOC',  'Documents missing at bank',        'payment',  'accounting_officer', false),
	('BANK', 'Bank internal approval',           'payment',  'accounting_officer', false),
	('CBI',  'Platform / K2 compliance review',  'payment',  'accounting_officer', false),
	('REJ',  'Rejected, resubmit',               'payment',  'accounting_officer', false),
	('SUP',  'Supplier bank details / query',    'payment',  'accounting_officer', false),
	('CORR', 'Correspondent bank hold',          'payment',  'accounting_officer', false),
	('AMT',  'Amount mismatch',                  'payment',  'accounting_officer', false),
	('SHIP', 'Container delayed at origin/port', 'shipment', 'logistics_officer',  false),
	('CUS',  'Customs / port file pending',      'pd',       'customs_officer',    false),
	('OTHER','Other',                            NULL,       NULL,                 true),
	('PENDING_REASON', 'Over time limit — reason required', NULL, NULL,            false);
--> statement-breakpoint

-- §9.1 — expense categories. Accounts are mapped on the settings screen once
-- the chart says which; a category with no account falls back to the
-- invoice's own line account, exactly as today.
INSERT INTO expense_category (code, name, requires_receipt) VALUES
	('rent',               'Office rent',             true),
	('utilities',          'Utilities',               true),
	('freight_forwarding', 'Freight & forwarding',    true),
	('customs_brokerage',  'Customs brokerage',       true),
	('professional_fees',  'Professional fees',       true),
	('bank_charges',       'Bank charges',            false),
	('government_fees',    'Government fees',         false),
	('repairs',            'Repairs & maintenance',   true),
	('subscriptions',      'Software subscriptions',  true),
	('other',              'Other',                   true);
--> statement-breakpoint

-- §19.3 — the check registry. A row whose named query ships in a later stage
-- sits here inert until that stage lands (the sweep skips names it cannot run).
INSERT INTO sweep_check (code, name, lane_code) VALUES
	('swift_pending',        'SWIFT pending too long',          'payment'),
	('transfer_pending',     'Transfer pending too long',       'payment'),
	('pd_not_validated',     'PD not validated',                'pd'),
	('pd_expiring',          'PD expiring',                     'pd'),
	('container_eta_passed', 'Container ETA passed',            'shipment'),
	('partly_received',      'Partly received too long',        'shipment'),
	('at_port',              'At port too long',                'shipment'),
	('invoice_unfunded',     'Invoice unfunded',                'bank'),
	('recurring_overdue',    'Recurring payable past due',      'payment'),
	('service_unconfirmed',  'Service unconfirmed too long',    'service');
--> statement-breakpoint

-- D4 — seed limits. Examples, editable from day one; a change is a new row.
INSERT INTO stage_time_limit (check_code, scope, limit_days, escalate_after_days, escalate_to_role, valid_from) VALUES
	('swift_pending',        'all', 14, 3, 'accounting_manager', '2026-01-01'),
	('transfer_pending',     'all',  3, 3, 'accounting_manager', '2026-01-01'),
	('pd_not_validated',     'all',  7, 3, 'accounting_manager', '2026-01-01'),
	('pd_expiring',          'all', 45, 3, 'accounting_manager', '2026-01-01'),
	('container_eta_passed', 'all',  0, 3, 'accounting_manager', '2026-01-01'),
	('partly_received',      'all', 30, 3, 'accounting_manager', '2026-01-01'),
	('at_port',              'all', 10, 3, 'accounting_manager', '2026-01-01'),
	('invoice_unfunded',     'all',  7, 3, 'accounting_manager', '2026-01-01'),
	('recurring_overdue',    'all',  0, 3, 'accounting_manager', '2026-01-01'),
	('service_unconfirmed',  'all', 10, 3, 'accounting_manager', '2026-01-01');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Roles (D1) and grants
-- ---------------------------------------------------------------------------

INSERT INTO role (code, name, description, is_system) VALUES
	('logistics_officer', 'Logistics Officer',
	 'Follows shipments container by container; completes shipment-lane holds.', true),
	('customs_officer', 'Customs Officer',
	 'Keeps the ASYCUDA pre-declarations current; completes PD-lane holds.', true);
--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
	('accounting_officer', 'payable', 'view'),
	('accounting_officer', 'payable', 'create'),
	('accounting_officer', 'payable', 'edit_draft'),
	('accounting_officer', 'payable', 'print'),
	('accounting_officer', 'payable', 'export'),
	('accounting_manager', 'payable', 'view'),
	('accounting_manager', 'payable', 'create'),
	('accounting_manager', 'payable', 'edit_draft'),
	('accounting_manager', 'payable', 'reverse_cancel'),
	('accounting_manager', 'payable', 'print'),
	('accounting_manager', 'payable', 'export'),
	('accounting_manager', 'payables_settings', 'view'),
	('accounting_manager', 'payables_settings', 'configure'),
	('ceo',                'payable', 'view'),
	('logistics_officer',  'payable', 'view'),
	('logistics_officer',  'payable', 'edit_draft'),
	('customs_officer',    'payable', 'view'),
	('customs_officer',    'payable', 'edit_draft');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Grants for the application role. The shape of this block IS the control:
-- nothing under a payable can be deleted by the application, and the hold
-- thread cannot even be updated (R3).
-- ---------------------------------------------------------------------------

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;

	REVOKE ALL ON payable_lane, payable_type, payable_type_lane, payable_stage,
	              payable_event_code, hold_reason_code, expense_category,
	              sweep_check, stage_time_limit,
	              payable, payable_order_line, payable_hold, payable_hold_update
	  FROM erp_app;

	-- Configuration: created and amended (deactivated), never deleted (R4).
	GRANT SELECT, INSERT, UPDATE ON payable_lane       TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON payable_type       TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON payable_type_lane  TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON payable_stage      TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON payable_event_code TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON hold_reason_code   TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON expense_category   TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON sweep_check        TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON stage_time_limit   TO erp_app;

	-- The record of what happened: no DELETE, ever (R3).
	GRANT SELECT, INSERT, UPDATE ON payable            TO erp_app;
	-- PI lines are editable until an invoice exists; removing one then is part
	-- of editing the PI, exactly as invoice lines work today.
	GRANT SELECT, INSERT, UPDATE, DELETE ON payable_order_line TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON payable_hold       TO erp_app;
	-- The thread only ever gains rows.
	GRANT SELECT, INSERT ON payable_hold_update        TO erp_app;
END;
$$;
