-- ===========================================================================
-- Payables — Stage 6, loans (REQ-AP-001 §15.6–§15.7, §21.10).
-- HAND-AUTHORED. Everything additive; nothing posted changes meaning.
--
--   control_account_kind   + loan: the liability's subledger reconciles to its
--                          control account per loan, as AP does per supplier
--   journal_line.loan_no   the loan subledger's party (as bank_account_code is
--                          the bank subledger's)
--   loan_commission_treatment  deducted at disbursement · paid separately ·
--                          spread over the instalments — a master whose flags
--                          say what each treatment does (R4)
--   bank_loan              one register for every lender (§15.7) — LOAN series
--   bank_loan_instalment   the generated schedule; superseded, never rewritten
--   bank_loan_allocation   which payment applications the loan funded, and
--                          the commission share each carries to its import
--   funding_source 'loan'  opens; payment_application.loan_id gets its key
--
-- Nothing here deletes. A loan is cancelled with a reason before it is
-- disbursed; once disbursed it is repaid, never removed. An allocation is
-- released with a reason when its application is rejected or cancelled.
-- ===========================================================================

-- PG ≥ 12 accepts this inside the migration's transaction; the value is not
-- used before the transaction commits.
ALTER TYPE "control_account_kind" ADD VALUE IF NOT EXISTS 'loan';
--> statement-breakpoint
ALTER TABLE "journal_line" ADD COLUMN "loan_no" text;
--> statement-breakpoint

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year) VALUES
	('LOAN', 'LOAN', '{PREFIX}-{YYYY}-{SERIAL}', 6, false, true)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

-- The loan's journals name it as their document type (§4.2's first layer of
-- dimension rules keys on a real document type).
INSERT INTO document_type (code, name, module, description) VALUES
	('bank_loan', 'Bank Loan', 'treasury', 'REQ-AP-001 §15.7 — a bank loan: its disbursement, commission and repayments.')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §15.7 — how the bank takes its commission. The flags are the behaviour; the
-- names are the treasury's to word.
-- ---------------------------------------------------------------------------
CREATE TABLE "loan_commission_treatment" (
	"code" text PRIMARY KEY,
	"name" text NOT NULL,
	-- Taken out of the proceeds: the account receives principal − commission.
	"deducted" boolean NOT NULL DEFAULT false,
	-- Paid with each instalment, in equal shares.
	"spread" boolean NOT NULL DEFAULT false,
	"sort_order" smallint NOT NULL DEFAULT 0,
	"active" boolean NOT NULL DEFAULT true,
	"created_by" uuid REFERENCES "app_user"("id"),
	CONSTRAINT "loan_commission_treatment_one_way" CHECK (NOT ("deducted" AND "spread"))
);
--> statement-breakpoint
INSERT INTO "loan_commission_treatment" ("code", "name", "deducted", "spread", "sort_order") VALUES
	('deducted_at_disbursement', 'Deducted at disbursement', true,  false, 1),
	('paid_separately',          'Paid separately',          false, false, 2),
	('spread_over_instalments',  'Spread over instalments',  false, true,  3);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §15.7 — the loan.
-- ---------------------------------------------------------------------------
CREATE TABLE "bank_loan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"loan_no" text NOT NULL,
	"bank_code" text NOT NULL REFERENCES "bank"("code"),
	-- The account the proceeds land in, and every repayment leaves from.
	"bank_cash_account_id" uuid NOT NULL REFERENCES "bank_cash_account"("id"),
	-- Where the loan is booked: the journals' branch.
	"branch_code" text NOT NULL REFERENCES "branch"("code"),

	"currency" char(3) NOT NULL,
	"principal_txn" numeric(19,4) NOT NULL,
	"principal_iqd" numeric(19,4) NOT NULL,
	"rate_id" uuid REFERENCES "exchange_rate"("id"),

	"commission_pct" numeric(9,4) NOT NULL DEFAULT 0,
	-- Defaults to principal × pct; the bank's own figure when it rounds.
	"commission_txn" numeric(19,4) NOT NULL DEFAULT 0,
	"commission_treatment_code" text NOT NULL REFERENCES "loan_commission_treatment"("code"),
	-- D5 — capitalised into the landed cost of the imports the loan funded;
	-- "expense when paid" stays available.
	"commission_capitalised" boolean NOT NULL DEFAULT true,
	"interest_pct_pa" numeric(9,4),
	-- principal − the commission deducted at disbursement.
	"net_proceeds_txn" numeric(19,4) NOT NULL,
	"allocation_method" text NOT NULL DEFAULT 'by_amount_used',

	"instalment_count" smallint NOT NULL,
	"frequency" text NOT NULL,
	"first_due_date" date NOT NULL,
	"maturity_date" date,
	"disbursement_date" date,
	"disbursement_reference" text,
	"disbursement_journal_entry_id" uuid REFERENCES "journal_entry"("id"),
	"commission_paid_on" date,
	"commission_reference" text,
	"commission_journal_entry_id" uuid REFERENCES "journal_entry"("id"),

	"status" text NOT NULL DEFAULT 'draft',
	"purpose" text,
	"closed_reason" text,

	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"approved_by" uuid REFERENCES "app_user"("id"),
	"approved_at" timestamptz,
	"activated_by" uuid REFERENCES "app_user"("id"),
	"activated_at" timestamptz,
	"closed_by" uuid REFERENCES "app_user"("id"),
	"closed_at" timestamptz,
	"updated_at" timestamptz NOT NULL DEFAULT now(),

	CONSTRAINT "bank_loan_status" CHECK (
		"status" IN ('draft', 'approved', 'active', 'fully_repaid', 'cancelled')
	),
	CONSTRAINT "bank_loan_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "bank_loan_principal_positive" CHECK ("principal_txn" > 0 AND "principal_iqd" > 0),
	CONSTRAINT "bank_loan_commission_range" CHECK (
		"commission_pct" >= 0 AND "commission_pct" < 100
		AND "commission_txn" >= 0 AND "commission_txn" < "principal_txn"
	),
	CONSTRAINT "bank_loan_interest_range" CHECK ("interest_pct_pa" IS NULL OR ("interest_pct_pa" >= 0 AND "interest_pct_pa" < 100)),
	CONSTRAINT "bank_loan_net_proceeds" CHECK ("net_proceeds_txn" > 0 AND "net_proceeds_txn" <= "principal_txn"),
	CONSTRAINT "bank_loan_allocation_method" CHECK ("allocation_method" IN ('by_amount_used', 'equal', 'manual')),
	CONSTRAINT "bank_loan_frequency" CHECK ("frequency" IN ('monthly', 'quarterly', 'custom')),
	CONSTRAINT "bank_loan_instalment_count_positive" CHECK ("instalment_count" > 0 AND "instalment_count" <= 360),
	-- The approver is never the person who entered the loan (§5.2).
	CONSTRAINT "bank_loan_maker_checker" CHECK ("approved_by" IS NULL OR "approved_by" <> "created_by"),
	-- Active means the money arrived and the disbursement posted.
	CONSTRAINT "bank_loan_active_disbursed" CHECK (
		"status" NOT IN ('active', 'fully_repaid')
		OR ("disbursement_date" IS NOT NULL AND "disbursement_journal_entry_id" IS NOT NULL)
	),
	CONSTRAINT "bank_loan_cancel_has_reason" CHECK (
		"status" <> 'cancelled' OR coalesce(btrim("closed_reason"), '') <> ''
	),
	CONSTRAINT "bank_loan_commission_paid_posted" CHECK (
		"commission_paid_on" IS NULL OR "commission_journal_entry_id" IS NOT NULL
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bank_loan_no_uniq" ON "bank_loan" ("loan_no");
--> statement-breakpoint
CREATE INDEX "bank_loan_account_idx" ON "bank_loan" ("bank_cash_account_id");
--> statement-breakpoint
CREATE INDEX "bank_loan_status_idx" ON "bank_loan" ("status");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §15.7 — the schedule. Editable before approval by superseding the rows;
-- dated rows after. The last instalment absorbs the rounding.
-- ---------------------------------------------------------------------------
CREATE TABLE "bank_loan_instalment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"loan_id" uuid NOT NULL REFERENCES "bank_loan"("id"),
	"sequence" smallint NOT NULL,
	"due_date" date NOT NULL,
	"principal_txn" numeric(19,4) NOT NULL DEFAULT 0,
	"commission_txn" numeric(19,4) NOT NULL DEFAULT 0,
	"interest_txn" numeric(19,4) NOT NULL DEFAULT 0,
	"total_txn" numeric(19,4) NOT NULL,
	"status" text NOT NULL DEFAULT 'upcoming',
	"paid_date" date,
	"paid_reference" text,
	"journal_entry_id" uuid REFERENCES "journal_entry"("id"),
	"paid_by" uuid REFERENCES "app_user"("id"),
	"paid_at" timestamptz,
	-- The sweep tells the funded imports once (LOAN_INSTALMENT_OVERDUE).
	"overdue_notified_at" timestamptz,
	"superseded_at" timestamptz,
	"superseded_by" uuid REFERENCES "app_user"("id"),
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "bank_loan_instalment_status" CHECK ("status" IN ('upcoming', 'due', 'paid', 'overdue')),
	CONSTRAINT "bank_loan_instalment_sequence_positive" CHECK ("sequence" > 0),
	CONSTRAINT "bank_loan_instalment_parts_non_negative" CHECK (
		"principal_txn" >= 0 AND "commission_txn" >= 0 AND "interest_txn" >= 0
	),
	CONSTRAINT "bank_loan_instalment_total" CHECK (
		"total_txn" > 0 AND "total_txn" = "principal_txn" + "commission_txn" + "interest_txn"
	),
	CONSTRAINT "bank_loan_instalment_paid_posted" CHECK (
		"status" <> 'paid'
		OR ("paid_date" IS NOT NULL AND "journal_entry_id" IS NOT NULL
			AND coalesce(btrim("paid_reference"), '') <> '')
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bank_loan_instalment_live_uniq" ON "bank_loan_instalment" ("loan_id", "sequence")
	WHERE "superseded_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "bank_loan_instalment_due_idx" ON "bank_loan_instalment" ("due_date")
	WHERE "superseded_at" IS NULL AND "status" <> 'paid';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §15.7 — what the loan funded. Written by the payment application's
-- approval, released by its rejection or cancellation; the commission share
-- becomes a bank_commission landed-cost charge of the import (D5).
-- ---------------------------------------------------------------------------
CREATE TABLE "bank_loan_allocation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"loan_id" uuid NOT NULL REFERENCES "bank_loan"("id"),
	"payment_application_id" uuid NOT NULL REFERENCES "payment_application"("id"),
	"payable_id" uuid NOT NULL REFERENCES "payable"("id"),
	"amount_txn" numeric(19,4) NOT NULL,
	"commission_share_txn" numeric(19,4) NOT NULL DEFAULT 0,
	"landed_cost_charge_id" uuid REFERENCES "landed_cost_charge"("id"),
	"released_at" timestamptz,
	"released_by" uuid REFERENCES "app_user"("id"),
	"release_reason" text,
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "bank_loan_allocation_amount_positive" CHECK ("amount_txn" > 0 AND "commission_share_txn" >= 0),
	CONSTRAINT "bank_loan_allocation_release_has_reason" CHECK (
		("released_at" IS NULL AND "released_by" IS NULL)
		OR ("released_at" IS NOT NULL AND "released_by" IS NOT NULL
			AND coalesce(btrim("release_reason"), '') <> '')
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bank_loan_allocation_live_uniq" ON "bank_loan_allocation" ("payment_application_id")
	WHERE "released_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "bank_loan_allocation_loan_idx" ON "bank_loan_allocation" ("loan_id");
--> statement-breakpoint
CREATE INDEX "bank_loan_allocation_payable_idx" ON "bank_loan_allocation" ("payable_id");
--> statement-breakpoint

-- §15.3 — an application funded by a loan names a loan that exists.
ALTER TABLE "payment_application"
	ADD CONSTRAINT "payment_application_loan_id_fk" FOREIGN KEY ("loan_id") REFERENCES "bank_loan"("id");
--> statement-breakpoint
UPDATE "funding_source" SET "active" = true WHERE "code" = 'loan';
--> statement-breakpoint

-- The bank lane's catalogue had the link; it lacked its undoing.
INSERT INTO payable_event_code (code, lane_code, name) VALUES
	('LOAN_UNLINKED', 'bank', 'Loan allocation released')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

-- §15.7 — the instalment warning window (seed 7 days), kept where every other
-- clock's limit is kept. Read by the loan sweep, not run as a hold check.
INSERT INTO sweep_check (code, name, lane_code, active) VALUES
	('loan_instalment_due', 'Loan instalment due soon', 'bank', false)
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint
INSERT INTO stage_time_limit (check_code, scope, limit_days, valid_from)
	SELECT 'loan_instalment_due', 'all', 7, DATE '2026-01-01'
	 WHERE NOT EXISTS (SELECT 1 FROM stage_time_limit WHERE check_code = 'loan_instalment_due');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The loan is a company register (as the bank accounts are): what a loan has
-- allocated is counted across every branch, whatever the reader may see.
-- ---------------------------------------------------------------------------
CREATE FUNCTION bank_loan_allocated_txn(p_loan_id uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT coalesce(sum(amount_txn), 0)::numeric(19,4)
	  FROM bank_loan_allocation
	 WHERE loan_id = p_loan_id
	   AND released_at IS NULL;
$$;
--> statement-breakpoint

-- The allocations are children of the import they fund, scoped like it.
ALTER TABLE bank_loan_allocation ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE bank_loan_allocation FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY bank_loan_allocation_branch_scope ON bank_loan_allocation
	USING (
		app_is_super_user()
		OR EXISTS (SELECT 1 FROM payable p
		            WHERE p.id = bank_loan_allocation.payable_id
		              AND app_branch_allowed(p.branch_code))
	)
	WITH CHECK (
		app_is_super_user()
		OR EXISTS (SELECT 1 FROM payable p
		            WHERE p.id = bank_loan_allocation.payable_id
		              AND app_branch_allowed(p.branch_code))
	);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Permissions. The officer enters a loan; a manager approves it (the CEO
-- above the account's approval limit), records the disbursement and the
-- repayments. Nobody deletes one.
-- ---------------------------------------------------------------------------
INSERT INTO role_grant (role_code, object, verb) VALUES
	('accounting_officer', 'bank_loan', 'view'),
	('accounting_officer', 'bank_loan', 'create'),
	('accounting_officer', 'bank_loan', 'edit_draft'),
	('accounting_officer', 'bank_loan', 'print'),
	('accounting_officer', 'bank_loan', 'export'),
	('accounting_manager', 'bank_loan', 'view'),
	('accounting_manager', 'bank_loan', 'create'),
	('accounting_manager', 'bank_loan', 'edit_draft'),
	('accounting_manager', 'bank_loan', 'approve'),
	('accounting_manager', 'bank_loan', 'post'),
	('accounting_manager', 'bank_loan', 'reverse_cancel'),
	('accounting_manager', 'bank_loan', 'print'),
	('accounting_manager', 'bank_loan', 'export'),
	('ceo',                'bank_loan', 'view'),
	('ceo',                'bank_loan', 'approve'),
	('ceo',                'bank_loan', 'print'),
	('system_administrator', 'bank_loan', 'view')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	GRANT SELECT, INSERT, UPDATE ON loan_commission_treatment TO erp_app;
	-- Documents: no DELETE (R3, §22.1).
	GRANT SELECT, INSERT, UPDATE ON bank_loan                 TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON bank_loan_instalment      TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON bank_loan_allocation      TO erp_app;
	GRANT EXECUTE ON FUNCTION bank_loan_allocated_txn(uuid) TO erp_app;
END $$;
