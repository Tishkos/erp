-- 0428 — Customer Payment, Expense Payment, and a customer's currency (2026-10-26).
--
-- By direction: "a customer account … the only transactions should be receipts
-- and payments … for payments I don't want to use bank transfers or material
-- returns … add a currency selection field when creating a customer … and
-- general expenses".
--
-- * business_partner.currency — the currency a partner deals in, chosen on the
--   New customer form; what the payment and receipt forms offer first.
-- * customer_payment (CPY-{BRANCH}-{YYYY}-{SERIAL}) — money paid OUT to a
--   customer from a bank or cash account: Dr the customer's receivable (naming
--   the customer) / Cr the account. The mirror of the Customer Receipt, so the
--   customer's statement holds receipts and payments and nothing else.
-- * expense_payment (EXV-{BRANCH}-{YYYY}-{SERIAL}) — a general expense paid
--   straight from a bank or cash account, with no supplier invoice: Dr the
--   expense account somebody names / Cr the account. The mirror of the Other
--   Receipt, and like it it can never touch a subledger control account.
--
-- Both: Draft → Approved (by somebody other than whoever wrote it; a super user
-- alone excepted, 0278) → Posted → Reversed (with a reason, through the journal's
-- own reversal); Draft or Approved → Cancelled with a reason. The amount is in
-- the account's own currency; the dinars are worked out at the payment date's
-- rate. Never deleted.

ALTER TABLE "business_partner" ADD COLUMN "currency" char(3) REFERENCES "currency"("code");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Customer Payment
-- ---------------------------------------------------------------------------
CREATE TABLE "customer_payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"customer_id" uuid NOT NULL REFERENCES "business_partner"("id"),
	"bank_cash_account_id" uuid NOT NULL REFERENCES "bank_cash_account"("id"),
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	"payment_date" date NOT NULL,
	"currency" text NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"payment_method_code" text REFERENCES "payment_method"("code"),
	"purpose" text NOT NULL,
	"reference" text,
	"note" text,
	"journal_entry_id" uuid REFERENCES "journal_entry"("id"),
	"reversal_journal_entry_id" uuid REFERENCES "journal_entry"("id"),
	"reversal_reason" text,
	"cancel_reason" text,
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"approved_by" uuid REFERENCES "app_user"("id"),
	"approved_at" timestamp with time zone,
	"posted_by" uuid REFERENCES "app_user"("id"),
	"posted_at" timestamp with time zone,
	"closed_by" uuid REFERENCES "app_user"("id"),
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_payment_amount_positive" CHECK ("amount" > 0 AND "amount_iqd" > 0),
	CONSTRAINT "customer_payment_purpose_present" CHECK (btrim("purpose") <> ''),
	CONSTRAINT "customer_payment_status_known" CHECK ("status" IN ('draft', 'approved', 'posted', 'reversed', 'cancelled')),
	CONSTRAINT "customer_payment_four_eyes" CHECK ("approved_by" IS NULL OR "approved_by" <> "created_by" OR app_user_is_super("approved_by")),
	CONSTRAINT "customer_payment_posting_matches_status" CHECK (("journal_entry_id" IS NULL) = ("status" IN ('draft', 'approved', 'cancelled'))),
	CONSTRAINT "customer_payment_reversal_has_reason" CHECK (("status" = 'reversed') = ("reversal_journal_entry_id" IS NOT NULL AND btrim(coalesce("reversal_reason", '')) <> '')),
	CONSTRAINT "customer_payment_cancel_has_reason" CHECK ("status" <> 'cancelled' OR btrim(coalesce("cancel_reason", '')) <> '')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "customer_payment_no_uniq" ON "customer_payment" ("payment_no");--> statement-breakpoint
CREATE INDEX "customer_payment_customer_idx" ON "customer_payment" ("customer_id", "payment_date");--> statement-breakpoint
CREATE INDEX "customer_payment_status_idx" ON "customer_payment" ("status", "branch_code");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Expense Payment
-- ---------------------------------------------------------------------------
CREATE TABLE "expense_payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"bank_cash_account_id" uuid NOT NULL REFERENCES "bank_cash_account"("id"),
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	"payment_date" date NOT NULL,
	"currency" text NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"expense_account_id" uuid NOT NULL REFERENCES "chart_of_account"("id"),
	"department_code" text REFERENCES "department"("code"),
	"business_line_code" text REFERENCES "business_line"("code"),
	"payment_method_code" text REFERENCES "payment_method"("code"),
	"payee" text NOT NULL,
	"purpose" text NOT NULL,
	"reference" text,
	"note" text,
	"journal_entry_id" uuid REFERENCES "journal_entry"("id"),
	"reversal_journal_entry_id" uuid REFERENCES "journal_entry"("id"),
	"reversal_reason" text,
	"cancel_reason" text,
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"approved_by" uuid REFERENCES "app_user"("id"),
	"approved_at" timestamp with time zone,
	"posted_by" uuid REFERENCES "app_user"("id"),
	"posted_at" timestamp with time zone,
	"closed_by" uuid REFERENCES "app_user"("id"),
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_payment_amount_positive" CHECK ("amount" > 0 AND "amount_iqd" > 0),
	CONSTRAINT "expense_payment_payee_present" CHECK (btrim("payee") <> ''),
	CONSTRAINT "expense_payment_purpose_present" CHECK (btrim("purpose") <> ''),
	CONSTRAINT "expense_payment_status_known" CHECK ("status" IN ('draft', 'approved', 'posted', 'reversed', 'cancelled')),
	CONSTRAINT "expense_payment_four_eyes" CHECK ("approved_by" IS NULL OR "approved_by" <> "created_by" OR app_user_is_super("approved_by")),
	CONSTRAINT "expense_payment_posting_matches_status" CHECK (("journal_entry_id" IS NULL) = ("status" IN ('draft', 'approved', 'cancelled'))),
	CONSTRAINT "expense_payment_reversal_has_reason" CHECK (("status" = 'reversed') = ("reversal_journal_entry_id" IS NOT NULL AND btrim(coalesce("reversal_reason", '')) <> '')),
	CONSTRAINT "expense_payment_cancel_has_reason" CHECK ("status" <> 'cancelled' OR btrim(coalesce("cancel_reason", '')) <> '')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "expense_payment_no_uniq" ON "expense_payment" ("payment_no");--> statement-breakpoint
CREATE INDEX "expense_payment_account_idx" ON "expense_payment" ("expense_account_id", "payment_date");--> statement-breakpoint
CREATE INDEX "expense_payment_status_idx" ON "expense_payment" ("status", "branch_code");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The road, and what a payment says once it has left draft. One function for
-- both tables: the columns they share are the ones it guards.
-- ---------------------------------------------------------------------------
CREATE FUNCTION money_out_document_guard() RETURNS trigger
	LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.status IN ('reversed', 'cancelled') THEN
		RAISE EXCEPTION '% is %; it does not change again.', OLD.payment_no, OLD.status
			USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
		(OLD.status = 'draft' AND NEW.status IN ('approved', 'cancelled'))
		OR (OLD.status = 'approved' AND NEW.status IN ('draft', 'posted', 'cancelled'))
		OR (OLD.status = 'posted' AND NEW.status = 'reversed')
	) THEN
		RAISE EXCEPTION '% cannot go from % to %.', OLD.payment_no, OLD.status, NEW.status
			USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.payment_no IS DISTINCT FROM OLD.payment_no
		OR NEW.branch_code IS DISTINCT FROM OLD.branch_code
		OR NEW.created_by IS DISTINCT FROM OLD.created_by
		OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION '%: its number, branch and author never change.', OLD.payment_no
			USING ERRCODE = 'check_violation';
	END IF;
	IF OLD.status <> 'draft' AND (
		NEW.bank_cash_account_id IS DISTINCT FROM OLD.bank_cash_account_id
		OR NEW.payment_date IS DISTINCT FROM OLD.payment_date
		OR NEW.currency IS DISTINCT FROM OLD.currency
		OR NEW.amount IS DISTINCT FROM OLD.amount
		OR NEW.purpose IS DISTINCT FROM OLD.purpose
	) THEN
		RAISE EXCEPTION '% is %; what it pays is changed only in draft.', OLD.payment_no, OLD.status
			USING ERRCODE = 'check_violation';
	END IF;
	-- The dinars are settled at posting, at the payment date's rate, and never after.
	IF OLD.status NOT IN ('draft', 'approved') AND NEW.amount_iqd IS DISTINCT FROM OLD.amount_iqd THEN
		RAISE EXCEPTION '% is %; its dinars were fixed when it posted.', OLD.payment_no, OLD.status
			USING ERRCODE = 'check_violation';
	END IF;
	IF OLD.journal_entry_id IS NOT NULL AND NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id THEN
		RAISE EXCEPTION '%: the journal it posted is its own for good.', OLD.payment_no
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END $$;
--> statement-breakpoint

CREATE FUNCTION customer_payment_guard() RETURNS trigger
	LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.status <> 'draft' AND NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
		RAISE EXCEPTION '% is %; whom it pays is changed only in draft.', OLD.payment_no, OLD.status
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END $$;
--> statement-breakpoint

CREATE FUNCTION expense_payment_guard() RETURNS trigger
	LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.status <> 'draft' AND (
		NEW.expense_account_id IS DISTINCT FROM OLD.expense_account_id
		OR NEW.payee IS DISTINCT FROM OLD.payee
		OR NEW.department_code IS DISTINCT FROM OLD.department_code
		OR NEW.business_line_code IS DISTINCT FROM OLD.business_line_code
	) THEN
		RAISE EXCEPTION '% is %; what it pays for is changed only in draft.', OLD.payment_no, OLD.status
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER "customer_payment_road" BEFORE UPDATE ON "customer_payment"
	FOR EACH ROW EXECUTE FUNCTION money_out_document_guard();--> statement-breakpoint
CREATE TRIGGER "customer_payment_guard" BEFORE UPDATE ON "customer_payment"
	FOR EACH ROW EXECUTE FUNCTION customer_payment_guard();--> statement-breakpoint
CREATE TRIGGER "customer_payment_no_delete" BEFORE DELETE ON "customer_payment"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint
CREATE TRIGGER "expense_payment_road" BEFORE UPDATE ON "expense_payment"
	FOR EACH ROW EXECUTE FUNCTION money_out_document_guard();--> statement-breakpoint
CREATE TRIGGER "expense_payment_guard" BEFORE UPDATE ON "expense_payment"
	FOR EACH ROW EXECUTE FUNCTION expense_payment_guard();--> statement-breakpoint
CREATE TRIGGER "expense_payment_no_delete" BEFORE DELETE ON "expense_payment"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

-- The currency recorded is the account's own (both tables).
CREATE FUNCTION money_out_matches_its_account() RETURNS trigger
	LANGUAGE plpgsql AS $$
DECLARE
	v_ccy  text;
	v_code text;
BEGIN
	SELECT currency, code INTO v_ccy, v_code FROM bank_cash_account WHERE id = NEW.bank_cash_account_id;
	IF btrim(NEW.currency) IS DISTINCT FROM btrim(v_ccy) THEN
		RAISE EXCEPTION '% says it is paid in % but % is held in %.', NEW.payment_no, NEW.currency, v_code, v_ccy
			USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "customer_payment_matches_its_account" BEFORE INSERT OR UPDATE ON "customer_payment"
	FOR EACH ROW EXECUTE FUNCTION money_out_matches_its_account();--> statement-breakpoint
CREATE TRIGGER "expense_payment_matches_its_account" BEFORE INSERT OR UPDATE ON "expense_payment"
	FOR EACH ROW EXECUTE FUNCTION money_out_matches_its_account();--> statement-breakpoint

-- The payee of a Customer Payment is a customer.
CREATE FUNCTION customer_payment_pays_a_customer() RETURNS trigger
	LANGUAGE plpgsql AS $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM business_partner WHERE id = NEW.customer_id AND is_customer) THEN
		RAISE EXCEPTION 'A Customer Payment pays a customer; % is not one.', NEW.customer_id
			USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "customer_payment_pays_a_customer" BEFORE INSERT OR UPDATE OF customer_id ON "customer_payment"
	FOR EACH ROW EXECUTE FUNCTION customer_payment_pays_a_customer();--> statement-breakpoint

-- An Expense Payment never debits a subledger control account (as an Other
-- Receipt never credits one, 0057): a customer is paid by a Customer Payment, a
-- supplier by a Supplier Payment, and the control accounts keep tying to their
-- subledgers.
CREATE FUNCTION expense_payment_not_to_a_control_account() RETURNS trigger
	LANGUAGE plpgsql AS $$
DECLARE
	v_control text;
	v_code    text;
BEGIN
	SELECT control_account::text, code INTO v_control, v_code FROM chart_of_account WHERE id = NEW.expense_account_id;
	IF v_control IS NOT NULL THEN
		RAISE EXCEPTION '% is the control account for the % subledger, and an Expense Payment cannot debit one. A customer is paid by a Customer Payment, a supplier by a Supplier Payment.', v_code, v_control
			USING ERRCODE = 'restrict_violation';
	END IF;
	RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "expense_payment_not_to_a_control_account" BEFORE INSERT OR UPDATE ON "expense_payment"
	FOR EACH ROW EXECUTE FUNCTION expense_payment_not_to_a_control_account();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Numbering, document types, statuses
-- ---------------------------------------------------------------------------
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year) VALUES
	('CUSTOMER_PAYMENT', 'CPY', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true),
	('EXPENSE_PAYMENT', 'EXV', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
	('customer_payment', 'Customer Payment', 'sales',
	 'Money paid out to a customer from a bank or cash account: Dr the customer''s receivable, Cr the account. The mirror of the Customer Receipt.'),
	('expense_payment', 'Expense Payment', 'treasury',
	 'A general expense paid straight from a bank or cash account, with no supplier invoice: Dr the expense account named, Cr the account. It cannot debit a control account.')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
	('customer_payment', 'draft',    'approved'),
	('customer_payment', 'draft',    'cancelled'),
	('customer_payment', 'approved', 'draft'),
	('customer_payment', 'approved', 'posted'),
	('customer_payment', 'approved', 'cancelled'),
	('customer_payment', 'posted',   'reversed'),
	('expense_payment',  'draft',    'approved'),
	('expense_payment',  'draft',    'cancelled'),
	('expense_payment',  'approved', 'draft'),
	('expense_payment',  'approved', 'posted'),
	('expense_payment',  'approved', 'cancelled'),
	('expense_payment',  'posted',   'reversed')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Row-level security: the branch boundary, as every branch document has it.
-- ---------------------------------------------------------------------------
ALTER TABLE customer_payment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE customer_payment FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY customer_payment_branch_scope ON customer_payment
	USING (app_branch_allowed(branch_code)) WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint
ALTER TABLE expense_payment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE expense_payment FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY expense_payment_branch_scope ON expense_payment
	USING (app_branch_allowed(branch_code)) WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	-- No DELETE: a mistaken payment is cancelled, a posted one reversed.
	GRANT SELECT, INSERT, UPDATE ON customer_payment TO erp_app;
	GRANT SELECT, INSERT, UPDATE ON expense_payment TO erp_app;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Who: whoever keeps Customer Receipts keeps Customer Payments; whoever keeps
-- Other Receipts keeps Expense Payments — and whoever pays suppliers pays
-- expenses too. Verbs as each source has them.
-- ---------------------------------------------------------------------------
INSERT INTO role_grant (role_code, object, verb)
SELECT DISTINCT g.role_code, 'customer_payment', g.verb
  FROM role_grant g
 WHERE g.object = 'customer_receipt'
   AND g.verb IN ('view', 'create', 'edit_draft', 'approve', 'post', 'reverse_cancel', 'print', 'export')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO role_grant (role_code, object, verb)
SELECT DISTINCT g.role_code, 'expense_payment', g.verb
  FROM role_grant g
 WHERE g.object IN ('other_receipt', 'supplier_payment')
   AND g.verb IN ('view', 'create', 'edit_draft', 'approve', 'post', 'reverse_cancel', 'print', 'export')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Those who may reverse a receipt or a supplier payment reverse these too.
INSERT INTO role_grant (role_code, object, verb)
SELECT DISTINCT g.role_code, o.object, 'reverse_cancel'::permission_verb
  FROM role_grant g
 CROSS JOIN (VALUES ('customer_payment'), ('expense_payment')) AS o(object)
 WHERE g.object IN ('customer_receipt', 'supplier_payment') AND g.verb = 'reverse_cancel'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The customer's side of a Customer Payment is the receivable a receipt
-- credits: its rule is copied from the receipt's, as 0240 copied the opening's.
-- The bank side is the account the money left (named on the payment).
-- ---------------------------------------------------------------------------
INSERT INTO posting_rule (event_type, line_role, account_id, is_active, created_by)
SELECT 'sales.customer_payment', r.line_role, r.account_id, true, r.created_by
  FROM posting_rule r
 WHERE r.event_type = 'sales.customer_receipt' AND r.line_role = 'customer_receivable'
   AND r.is_active
   AND r.item_group IS NULL AND r.partner_group IS NULL AND r.warehouse_code IS NULL
   AND r.project_code IS NULL AND r.branch_code IS NULL
ON CONFLICT DO NOTHING;
