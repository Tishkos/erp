-- ===========================================================================
-- Payables — Stage 3, payments & bank (REQ-AP-001 §15.1–§15.6, §21.7).
-- HAND-AUTHORED. Everything additive; nothing posted changes meaning.
--
--   bank                   the lenders and paying banks (Mansour, Arab, NBI,
--                          Rafidain …) — a master, not a fixed list (§15.1)
--   bank_cash_account      + bank_code, back-filled from the free text
--   payment_method         + confirmation_kind: what proves the money left
--                          (SWIFT copy, transfer reference, cash voucher,
--                          cheque number) — the methods themselves stay rows
--   instalment_trigger     on order, against B/L copy, 60 days after B/L …
--   payable_instalment     the structured terms of an import (§15.2)
--   funding_source         own funds · loan (loan opens with Stage 6)
--   payment_application    the company's request to its bank or cashier to
--                          pay the supplier (§15.3) — PAYAPP series
--   payment_application_transition   its status machine, seeded, editable
--   supplier_payment / supplier_advance  + amount_txn: the SWIFT amount in
--                          its own currency; the journal stays IQD (§15.4)
--
-- Nothing here deletes. A payment application is rejected or cancelled with a
-- reason, never removed; an instalment plan is superseded, never rewritten.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- §15.1 — the bank master. Codes are minted (Critical Rule 1, as 0208): the
-- seeds take the minted shape and the counter starts past them.
-- ---------------------------------------------------------------------------
CREATE TABLE "bank" (
	"code" text PRIMARY KEY,
	"name" text NOT NULL,
	"swift_bic" text,
	"country" char(2) NOT NULL DEFAULT 'IQ',
	"active" boolean NOT NULL DEFAULT true,
	"created_by" uuid REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "bank_name_not_blank" CHECK (btrim("name") <> ''),
	-- ISO 9362: four letters (bank), two (country), two (location), optional
	-- three (branch).
	CONSTRAINT "bank_swift_shape" CHECK (
		"swift_bic" IS NULL OR "swift_bic" ~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$'
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bank_swift_uniq" ON "bank" ("swift_bic") WHERE "swift_bic" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "bank_name_uniq" ON "bank" (lower(btrim("name")));
--> statement-breakpoint

-- The four the PD sheet names by SWIFT code, plus Rafidain (whose code the
-- treasury enters). Names are editable on the Banks screen.
INSERT INTO "bank" ("code", "name", "swift_bic") VALUES
	('BNK-0001', 'Mansour Bank',            'MBIVIQBAXXX'),
	('BNK-0002', 'Arab Bank',               'ARABIQBAXXX'),
	('BNK-0003', 'National Bank of Iraq',   'NBIQIQBAXXX'),
	('BNK-0004', 'BABIIQBA',                'BABIIQBAXXX'),
	('BNK-0005', 'Rafidain Bank',           NULL);
--> statement-breakpoint

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year) VALUES
	('BANK_CODE', 'BNK', '{PREFIX}-{SERIAL}', 4, false, false),
	('PAYMENT_APPLICATION', 'PAYAPP', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

DO $$
DECLARE
	seq text := doc_sequence_name('BANK_CODE', '');
BEGIN
	IF to_regclass(seq) IS NULL THEN
		EXECUTE format('CREATE SEQUENCE %I START 1', seq);
	END IF;
	PERFORM setval(seq, 5, true);
END $$;
--> statement-breakpoint

-- §15.1 — a bank account names its bank; the free text stays (nothing is
-- removed) and is back-filled where the SWIFT code or the name says which.
ALTER TABLE "bank_cash_account" ADD COLUMN "bank_code" text REFERENCES "bank"("code");
--> statement-breakpoint
UPDATE "bank_cash_account" a
   SET "bank_code" = b."code"
  FROM "bank" b
 WHERE a."account_type" = 'bank'
   AND a."bank_code" IS NULL
   AND (
		(a."swift" IS NOT NULL AND b."swift_bic" IS NOT NULL
		 AND upper(left(a."swift", 8)) = left(b."swift_bic", 8))
		OR (a."bank_name" IS NOT NULL
		 AND lower(a."bank_name") LIKE '%' || lower(split_part(b."name", ' ', 1)) || '%')
	);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §15.3 — the method decides what confirms the payment and which clock runs.
-- The method is still whatever the treasury names it; what it is *proved by*
-- is one of four things, and that is what the confirmation dialog branches on.
-- ---------------------------------------------------------------------------
ALTER TABLE "payment_method" ADD COLUMN "confirmation_kind" text NOT NULL DEFAULT 'transfer';
--> statement-breakpoint
ALTER TABLE "payment_method" ADD CONSTRAINT "payment_method_confirmation_kind" CHECK (
	"confirmation_kind" IN ('swift', 'transfer', 'cash', 'cheque')
);
--> statement-breakpoint
UPDATE "payment_method" SET "confirmation_kind" = 'cash' WHERE "kind" = 'cash';
--> statement-breakpoint
UPDATE "payment_method" SET "confirmation_kind" = 'swift'
 WHERE upper("name") LIKE '%SWIFT%' OR upper("name") LIKE '%TELEGRAPHIC%' OR upper("name") LIKE 'TT %';
--> statement-breakpoint
UPDATE "payment_method" SET "confirmation_kind" = 'cheque'
 WHERE lower("name") LIKE '%cheque%' OR lower("name") LIKE '%check%';
--> statement-breakpoint

-- The four §15.3 names, minted, unless a method of that name exists already.
DO $$
DECLARE
	seq text := doc_sequence_name('PAYMENT_METHOD_CODE', '');
	top bigint;
	spec record;
BEGIN
	SELECT coalesce(max(substring(code from '^PM-([0-9]+)$')::bigint), 0) INTO top FROM payment_method;
	FOR spec IN
		SELECT * FROM (VALUES
			('SWIFT transfer', 'bank'::payment_method_kind, 'swift', 1),
			('Local transfer', 'bank'::payment_method_kind, 'transfer', 2),
			('Cash', 'cash'::payment_method_kind, 'cash', 3),
			('Cheque', 'bank'::payment_method_kind, 'cheque', 4)
		) AS s(name, kind, confirmation_kind, ord)
		ORDER BY ord
	LOOP
		IF NOT EXISTS (SELECT 1 FROM payment_method WHERE lower(name) = lower(spec.name)) THEN
			top := top + 1;
			INSERT INTO payment_method (code, name, kind, confirmation_kind)
			VALUES ('PM-' || lpad(top::text, 4, '0'), spec.name, spec.kind, spec.confirmation_kind);
		END IF;
	END LOOP;
	IF to_regclass(seq) IS NULL THEN
		EXECUTE format('CREATE SEQUENCE %I START 1', seq);
	END IF;
	IF top > 0 THEN
		PERFORM setval(seq, greatest(top, (SELECT last_value FROM pg_sequences WHERE sequencename = seq)), true);
	END IF;
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §15.2 — instalment triggers (R4: configurable) and the instalment plan.
-- ---------------------------------------------------------------------------
CREATE TABLE "instalment_trigger" (
	"code" text PRIMARY KEY,
	"name" text NOT NULL,
	"needs_days" boolean NOT NULL DEFAULT false,
	"sort_order" smallint NOT NULL DEFAULT 0,
	"active" boolean NOT NULL DEFAULT true,
	"created_by" uuid REFERENCES "app_user"("id")
);
--> statement-breakpoint
INSERT INTO "instalment_trigger" ("code", "name", "needs_days", "sort_order") VALUES
	('on_order',             'On order (deposit)',              false, 1),
	('before_production',    'Before production',               false, 2),
	('before_shipment',      'Before shipment',                 false, 3),
	('against_bl_copy',      'Against B/L copy',                false, 4),
	('against_bl_original',  'Against original B/L',            false, 5),
	('days_after_bl',        'Days after B/L date',             true,  6),
	('days_after_invoice',   'Days after invoice date',         true,  7),
	('on_arrival_warehouse', 'On arrival at the warehouse',     false, 8),
	('after_delivery',       'After delivery',                  false, 9),
	('sinosure_credit',      'Sinosure credit',                 true,  10);
--> statement-breakpoint

CREATE TABLE "payable_instalment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"payable_id" uuid NOT NULL REFERENCES "payable"("id"),
	"sequence" smallint NOT NULL,
	"label" text NOT NULL,
	"basis" text NOT NULL,
	"percent" numeric(9,4),
	-- The instalment's amount in the payable's currency, fixed when planned
	-- (the last row absorbs the rounding, §15.2).
	"amount_txn" numeric(19,4) NOT NULL,
	"trigger_code" text NOT NULL REFERENCES "instalment_trigger"("code"),
	"trigger_days" integer,
	"expected_date" date,
	-- A re-planned instalment is superseded, never rewritten (R3).
	"superseded_at" timestamptz,
	"superseded_by" uuid REFERENCES "app_user"("id"),
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "payable_instalment_basis" CHECK ("basis" IN ('percent', 'amount')),
	CONSTRAINT "payable_instalment_percent_shape" CHECK (
		("basis" = 'percent' AND "percent" > 0 AND "percent" <= 100)
		OR ("basis" = 'amount' AND "percent" IS NULL)
	),
	CONSTRAINT "payable_instalment_amount_positive" CHECK ("amount_txn" > 0),
	CONSTRAINT "payable_instalment_sequence_positive" CHECK ("sequence" > 0),
	CONSTRAINT "payable_instalment_days_non_negative" CHECK ("trigger_days" IS NULL OR "trigger_days" >= 0),
	CONSTRAINT "payable_instalment_label_not_blank" CHECK (btrim("label") <> '')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payable_instalment_live_uniq" ON "payable_instalment" ("payable_id", "sequence")
	WHERE "superseded_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "payable_instalment_payable_idx" ON "payable_instalment" ("payable_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §15.3 — funding sources. `loan` waits for the loan register (Stage 6),
-- which activates it; until then nothing can name a loan that does not exist.
-- ---------------------------------------------------------------------------
CREATE TABLE "funding_source" (
	"code" text PRIMARY KEY,
	"name" text NOT NULL,
	"requires_loan" boolean NOT NULL DEFAULT false,
	"active" boolean NOT NULL DEFAULT true,
	"created_by" uuid REFERENCES "app_user"("id")
);
--> statement-breakpoint
INSERT INTO "funding_source" ("code", "name", "requires_loan", "active") VALUES
	('own_funds', 'Own funds', false, true),
	('loan',      'Bank loan', true,  false);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §15.3 — the payment application.
-- ---------------------------------------------------------------------------
CREATE TABLE "payment_application" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"application_no" text NOT NULL,
	"payable_id" uuid NOT NULL REFERENCES "payable"("id"),
	"instalment_id" uuid REFERENCES "payable_instalment"("id"),
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	"supplier_id" uuid NOT NULL REFERENCES "business_partner"("id"),

	"payment_method_code" text NOT NULL REFERENCES "payment_method"("code"),
	"bank_cash_account_id" uuid NOT NULL REFERENCES "bank_cash_account"("id"),
	"payee_bank_account_id" uuid REFERENCES "partner_bank_account"("id"),
	"funding_source_code" text NOT NULL DEFAULT 'own_funds' REFERENCES "funding_source"("code"),
	-- The loan register arrives with Stage 6, which adds the foreign key.
	"loan_id" uuid,

	"currency" char(3) NOT NULL,
	"amount_txn" numeric(19,4) NOT NULL,
	"amount_iqd" numeric(19,4) NOT NULL,
	"rate_id" uuid REFERENCES "exchange_rate"("id"),

	"status" text NOT NULL DEFAULT 'draft',
	"application_date" date,
	"bank_reference" text,
	"confirmed_on" date,
	"confirmation_reference" text,
	"debit_date" date,
	"statement_line_id" uuid REFERENCES "bank_statement_line"("id"),

	"supplier_payment_id" uuid REFERENCES "supplier_payment"("id"),
	"supplier_advance_id" uuid REFERENCES "supplier_advance"("id"),
	-- The PD the bank paid against (imports). Stage 4 adds the foreign key.
	"pd_id" uuid,

	-- §15.3 — the dashed-arrow checks a manager let through, and why.
	"overridden_checks" text[] NOT NULL DEFAULT '{}',
	"override_reason" text,
	"override_by" uuid REFERENCES "app_user"("id"),
	"override_at" timestamptz,

	"note" text,
	"closed_reason" text,

	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"approved_by" uuid REFERENCES "app_user"("id"),
	"approved_at" timestamptz,
	"sent_by" uuid REFERENCES "app_user"("id"),
	"sent_at" timestamptz,
	"confirmed_by" uuid REFERENCES "app_user"("id"),
	"confirmed_at" timestamptz,
	"closed_by" uuid REFERENCES "app_user"("id"),
	"closed_at" timestamptz,
	"updated_at" timestamptz NOT NULL DEFAULT now(),

	CONSTRAINT "payment_application_status" CHECK (
		"status" IN ('draft', 'approved', 'sent', 'confirmed', 'debited', 'rejected', 'cancelled')
	),
	CONSTRAINT "payment_application_amounts_positive" CHECK ("amount_txn" > 0 AND "amount_iqd" > 0),
	CONSTRAINT "payment_application_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$'),
	-- Sent means a date the file went to the bank.
	CONSTRAINT "payment_application_sent_has_date" CHECK (
		"status" NOT IN ('sent', 'confirmed', 'debited') OR "application_date" IS NOT NULL
	),
	-- Confirmed means the proof and the posted document that recorded it.
	CONSTRAINT "payment_application_confirmed_has_proof" CHECK (
		"status" NOT IN ('confirmed', 'debited')
		OR ("confirmed_on" IS NOT NULL
			AND coalesce(btrim("confirmation_reference"), '') <> ''
			AND ("supplier_payment_id" IS NOT NULL OR "supplier_advance_id" IS NOT NULL))
	),
	CONSTRAINT "payment_application_debited_has_date" CHECK (
		"status" <> 'debited' OR "debit_date" IS NOT NULL
	),
	CONSTRAINT "payment_application_closed_has_reason" CHECK (
		"status" NOT IN ('rejected', 'cancelled') OR coalesce(btrim("closed_reason"), '') <> ''
	),
	CONSTRAINT "payment_application_loan_named" CHECK (
		"funding_source_code" <> 'loan' OR "loan_id" IS NOT NULL
	),
	CONSTRAINT "payment_application_override_has_reason" CHECK (
		cardinality("overridden_checks") = 0
		OR (coalesce(btrim("override_reason"), '') <> '' AND "override_by" IS NOT NULL)
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_application_no_uniq" ON "payment_application" ("application_no");
--> statement-breakpoint
CREATE INDEX "payment_application_payable_idx" ON "payment_application" ("payable_id");
--> statement-breakpoint
CREATE INDEX "payment_application_status_idx" ON "payment_application" ("status", "application_date");
--> statement-breakpoint
CREATE INDEX "payment_application_account_idx" ON "payment_application" ("bank_cash_account_id")
	WHERE "status" IN ('approved', 'sent');
--> statement-breakpoint
-- §15.3 — one instalment may have several applications only if the earlier
-- ones were rejected or cancelled.
CREATE UNIQUE INDEX "payment_application_instalment_live_uniq" ON "payment_application" ("instalment_id")
	WHERE "instalment_id" IS NOT NULL AND "status" NOT IN ('rejected', 'cancelled');
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_application_payment_uniq" ON "payment_application" ("supplier_payment_id")
	WHERE "supplier_payment_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_application_advance_uniq" ON "payment_application" ("supplier_advance_id")
	WHERE "supplier_advance_id" IS NOT NULL;
--> statement-breakpoint

-- Seeded transitions, editable (§15.3). The service refuses any move not here.
CREATE TABLE "payment_application_transition" (
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"active" boolean NOT NULL DEFAULT true,
	PRIMARY KEY ("from_status", "to_status"),
	CONSTRAINT "payment_application_transition_not_self" CHECK ("from_status" <> "to_status")
);
--> statement-breakpoint
INSERT INTO "payment_application_transition" ("from_status", "to_status") VALUES
	('draft',     'approved'),
	('draft',     'cancelled'),
	('approved',  'sent'),
	('approved',  'rejected'),
	('approved',  'cancelled'),
	('sent',      'confirmed'),
	('sent',      'rejected'),
	('sent',      'cancelled'),
	('confirmed', 'debited');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §15.4 — the posted document shows the SWIFT amount in its own currency.
-- ---------------------------------------------------------------------------
ALTER TABLE "supplier_payment" ADD COLUMN "amount_txn" numeric(19,4);
--> statement-breakpoint
ALTER TABLE "supplier_advance" ADD COLUMN "amount_txn" numeric(19,4);
--> statement-breakpoint

-- Three events the payment lane needs that the Stage 1 catalogue lacked.
INSERT INTO payable_event_code (code, lane_code, name) VALUES
	('PAYMENT_DRAFTED',  'payment', 'Payment application drafted'),
	('CHEQUE_PAID',      'payment', 'Cheque paid'),
	('CHECK_OVERRIDDEN', 'payment', 'Payment check overridden')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Branch scope, as every payable table.
-- ---------------------------------------------------------------------------
ALTER TABLE payment_application ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE payment_application FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY payment_application_branch_scope ON payment_application
	USING (app_branch_allowed(branch_code))
	WITH CHECK (app_branch_allowed(branch_code));
--> statement-breakpoint

ALTER TABLE payable_instalment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE payable_instalment FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY payable_instalment_branch_scope ON payable_instalment
	USING (
		app_is_super_user()
		OR EXISTS (SELECT 1 FROM payable p
		            WHERE p.id = payable_instalment.payable_id
		              AND app_branch_allowed(p.branch_code))
	)
	WITH CHECK (
		app_is_super_user()
		OR EXISTS (SELECT 1 FROM payable p
		            WHERE p.id = payable_instalment.payable_id
		              AND app_branch_allowed(p.branch_code))
	);
--> statement-breakpoint

-- §15.1 — what is reserved on an account is company-wide: an account is a
-- company master, and a branch-scoped reader must not see more money than
-- there is because another branch's reservation is outside its scope. The sum
-- is all the function reveals.
CREATE FUNCTION payment_application_reserved_iqd(p_account_id uuid) RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
	SELECT coalesce(sum(amount_iqd), 0)::numeric(19,4)
	  FROM payment_application
	 WHERE bank_cash_account_id = p_account_id
	   AND status IN ('approved', 'sent');
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Permissions. Approving and confirming are the manager's; the officer
-- prepares and sends. The approver of an application is never its maker.
-- ---------------------------------------------------------------------------
INSERT INTO role_grant (role_code, object, verb) VALUES
	('accounting_officer', 'payment_application', 'view'),
	('accounting_officer', 'payment_application', 'create'),
	('accounting_officer', 'payment_application', 'edit_draft'),
	('accounting_officer', 'payment_application', 'execute'),
	('accounting_officer', 'payment_application', 'print'),
	('accounting_officer', 'payment_application', 'export'),
	('accounting_manager', 'payment_application', 'view'),
	('accounting_manager', 'payment_application', 'create'),
	('accounting_manager', 'payment_application', 'edit_draft'),
	('accounting_manager', 'payment_application', 'approve'),
	('accounting_manager', 'payment_application', 'execute'),
	('accounting_manager', 'payment_application', 'post'),
	('accounting_manager', 'payment_application', 'reverse_cancel'),
	('accounting_manager', 'payment_application', 'print'),
	('accounting_manager', 'payment_application', 'export'),
	('ceo',                'payment_application', 'view'),
	('ceo',                'payment_application', 'print'),
	('accounting_officer', 'bank', 'view'),
	('accounting_manager', 'bank', 'view'),
	('accounting_manager', 'bank', 'create'),
	('accounting_manager', 'bank', 'configure'),
	('ceo',                'bank', 'view'),
	('system_administrator', 'bank', 'view'),
	('system_administrator', 'bank', 'create'),
	('system_administrator', 'bank', 'configure')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	-- Masters: created and deactivated, never deleted (R4).
	GRANT SELECT, INSERT, UPDATE ON bank                           TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON instalment_trigger             TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON funding_source                 TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON payment_application_transition TO erp_app;
	-- Documents: no DELETE (R3, §22.1).
	GRANT SELECT, INSERT, UPDATE ON payable_instalment             TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON payment_application            TO erp_app;
	GRANT EXECUTE ON FUNCTION payment_application_reserved_iqd(uuid) TO erp_app;
END $$;
