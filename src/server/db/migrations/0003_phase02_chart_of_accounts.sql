CREATE TYPE "public"."account_type" AS ENUM('asset', 'liability', 'equity', 'revenue', 'expense');--> statement-breakpoint
CREATE TYPE "public"."control_account_kind" AS ENUM('customer', 'supplier', 'inventory', 'bank', 'fixed_asset', 'project', 'service');--> statement-breakpoint
CREATE TYPE "public"."dimension_type" AS ENUM('branch', 'department', 'business_line', 'project', 'warehouse', 'business_partner', 'employee');--> statement-breakpoint
CREATE TABLE "account_required_dimension" (
	"account_id" uuid NOT NULL,
	"dimension" "dimension_type" NOT NULL,
	CONSTRAINT "account_required_dimension_account_id_dimension_pk" PRIMARY KEY("account_id","dimension")
);
--> statement-breakpoint
CREATE TABLE "chart_of_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"account_type" "account_type" NOT NULL,
	"parent_id" uuid,
	"is_group" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"approval_status" "document_status" DEFAULT 'draft' NOT NULL,
	"control_account" "control_account_kind",
	"currency_restriction" char(3),
	"is_system" boolean DEFAULT false NOT NULL,
	"level" integer DEFAULT 0 NOT NULL,
	"description" text,
	"created_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "chart_of_account_code_shape" CHECK ("chart_of_account"."code" ~ '^[A-Z0-9][A-Z0-9._-]*$'),
	CONSTRAINT "chart_of_account_currency_shape" CHECK ("chart_of_account"."currency_restriction" is null or "chart_of_account"."currency_restriction" ~ '^[A-Z]{3}$'),
	CONSTRAINT "chart_of_account_group_not_control" CHECK (not ("chart_of_account"."is_group" and "chart_of_account"."control_account" is not null)),
	CONSTRAINT "chart_of_account_active_requires_approval" CHECK (not ("chart_of_account"."is_active" and "chart_of_account"."approval_status" <> 'approved')),
	CONSTRAINT "chart_of_account_level_range" CHECK ("chart_of_account"."level" >= 0 and "chart_of_account"."level" < 12),
	CONSTRAINT "chart_of_account_root_is_system" CHECK (("chart_of_account"."parent_id" is null) = ("chart_of_account"."level" = 0))
);
--> statement-breakpoint
ALTER TABLE "account_required_dimension" ADD CONSTRAINT "account_required_dimension_account_id_chart_of_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."chart_of_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chart_of_account" ADD CONSTRAINT "chart_of_account_parent_id_chart_of_account_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."chart_of_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chart_of_account" ADD CONSTRAINT "chart_of_account_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chart_of_account" ADD CONSTRAINT "chart_of_account_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chart_of_account_code_uniq" ON "chart_of_account" USING btree ("code");--> statement-breakpoint
CREATE INDEX "chart_of_account_parent_idx" ON "chart_of_account" USING btree ("parent_id","code");--> statement-breakpoint
CREATE INDEX "chart_of_account_type_idx" ON "chart_of_account" USING btree ("account_type","code");--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE — Phase 02.1, Chart of Accounts.
--
-- No row-level security on this table, deliberately. The chart is shared
-- configuration: a Basra user posts to the same account code as a Baghdad user,
-- and that is what makes a consolidated Trial Balance possible (§14.8). Scope
-- belongs on the transactions, not on the chart they reference.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Tree integrity.
--
-- A chart of accounts is only summable if every rule below holds: a group's
-- balance is the sum of its descendants, and that means nothing if a child can
-- be a different type, if a leaf can hold children, or if a branch can loop.
-- ---------------------------------------------------------------------------
CREATE FUNCTION chart_of_account_validate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_parent   chart_of_account%ROWTYPE;
  v_ancestor uuid;
  v_walked   int := 0;
  v_children int;
  v_implied  account_type;
BEGIN
  -- Immutability first, so that an attempt to change a frozen field is told
  -- exactly that, rather than tripping over a downstream rule and reporting
  -- something true but unhelpful.
  IF TG_OP = 'UPDATE' THEN
    -- The code is what users cite in journals, reports and conversations. It
    -- may be corrected while the account is still a draft, and not afterwards.
    IF NEW.code <> OLD.code AND OLD.approval_status <> 'draft' THEN
      RAISE EXCEPTION
        'The code of account % cannot be changed once it has been submitted for approval.',
        OLD.code USING ERRCODE = 'restrict_violation';
    END IF;

    -- Likewise the type: it determines the normal balance and which statement
    -- the account appears on.
    IF NEW.account_type <> OLD.account_type AND OLD.approval_status <> 'draft' THEN
      RAISE EXCEPTION
        'The type of account % cannot be changed once it has been submitted for approval.',
        OLD.code USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  -- A code that follows the received A/L/E/R/X convention must mean what the
  -- convention says it means. Codes outside the convention pass without
  -- comment — §1.2 keeps the chart configurable, and a company that later
  -- adopts 4-digit or dotted codes must not need a code change to do it.
  IF NEW.code ~ '^[ALERX][0-9]{6}$' THEN
    v_implied := (CASE left(NEW.code, 1)
                    WHEN 'A' THEN 'asset'
                    WHEN 'L' THEN 'liability'
                    WHEN 'E' THEN 'equity'
                    WHEN 'R' THEN 'revenue'
                    WHEN 'X' THEN 'expense'
                  END)::account_type;

    IF v_implied <> NEW.account_type THEN
      RAISE EXCEPTION
        'Code % begins with ''%'', which means %, but the account is typed %.',
        NEW.code, left(NEW.code, 1), v_implied, NEW.account_type
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF NEW.parent_id IS NULL THEN
    NEW.level := 0;
  ELSE
    SELECT * INTO v_parent FROM chart_of_account WHERE id = NEW.parent_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Parent account % does not exist.', NEW.parent_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF NOT v_parent.is_group THEN
      RAISE EXCEPTION
        'Account % is a posting account and cannot hold children. Convert it to a group first, which is only possible while it carries no transactions.',
        v_parent.code USING ERRCODE = 'restrict_violation';
    END IF;

    IF v_parent.account_type <> NEW.account_type THEN
      RAISE EXCEPTION
        'Account % is %, so it cannot contain a % account. An account inherits its parent''s type.',
        v_parent.code, v_parent.account_type, NEW.account_type
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF NOT v_parent.is_active AND TG_OP = 'INSERT' THEN
      RAISE EXCEPTION
        'Account % is inactive. Reactivate it before adding accounts beneath it.',
        v_parent.code USING ERRCODE = 'restrict_violation';
    END IF;

    NEW.level := v_parent.level + 1;

    -- Walk up from the proposed parent. Meeting ourselves means the move would
    -- detach a subtree from the tree and hand it to itself.
    IF TG_OP = 'UPDATE' AND NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
      v_ancestor := NEW.parent_id;
      WHILE v_ancestor IS NOT NULL LOOP
        IF v_ancestor = NEW.id THEN
          RAISE EXCEPTION
            'Account % cannot be moved beneath itself or one of its own descendants.',
            NEW.code USING ERRCODE = 'restrict_violation';
        END IF;
        SELECT parent_id INTO v_ancestor FROM chart_of_account WHERE id = v_ancestor;
        v_walked := v_walked + 1;
        EXIT WHEN v_walked > 100;
      END LOOP;
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- A group with children cannot become a posting account: its children's
    -- balances would have nowhere to roll up to.
    IF OLD.is_group AND NOT NEW.is_group THEN
      SELECT count(*) INTO v_children FROM chart_of_account WHERE parent_id = NEW.id;
      IF v_children > 0 THEN
        RAISE EXCEPTION
          'Account % has % child account(s) and cannot become a posting account. Move them first.',
          NEW.code, v_children USING ERRCODE = 'restrict_violation';
      END IF;
    END IF;

    NEW.updated_at := now();
    NEW.version    := OLD.version + 1;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER chart_of_account_validate
  BEFORE INSERT OR UPDATE ON chart_of_account
  FOR EACH ROW EXECUTE FUNCTION chart_of_account_validate();--> statement-breakpoint

-- Moving a subtree changes the depth of everything under it. Repeated until
-- stable rather than recursively, so the order rows are visited cannot matter.
CREATE FUNCTION chart_of_account_restack_levels() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
    LOOP
      UPDATE chart_of_account c
         SET level = p.level + 1
        FROM chart_of_account p
       WHERE c.parent_id = p.id
         AND c.level <> p.level + 1;
      EXIT WHEN NOT FOUND;
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER chart_of_account_restack_levels
  AFTER UPDATE ON chart_of_account
  FOR EACH ROW EXECUTE FUNCTION chart_of_account_restack_levels();--> statement-breakpoint

-- §1.1: "No deletion of saved or posted records." An account that was ever
-- approved is deactivated, never removed — its code appears in journals,
-- reports and reconciliations that must stay readable.
CREATE FUNCTION chart_of_account_reject_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_system THEN
    RAISE EXCEPTION
      'Account % is one of the five type roots and cannot be deleted. It may be renamed.',
      OLD.code USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.approval_status = 'approved' THEN
    RAISE EXCEPTION
      'Account % has been approved and cannot be deleted. Deactivate it instead — its history stays readable (§1.1).',
      OLD.code USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN OLD;
END;
$$;--> statement-breakpoint

CREATE TRIGGER chart_of_account_reject_delete
  BEFORE DELETE ON chart_of_account
  FOR EACH ROW EXECUTE FUNCTION chart_of_account_reject_delete();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Automatic account codes.
--
-- One counter per account type, drawn through the Phase 01.5 numbering service
-- — not a private mechanism. §24: "Module developers shall call shared services
-- for numbering… Duplicating these mechanisms inside each module will create
-- inconsistent controls."
--
-- The format matches the chart received from the Business Process Owner: one
-- type letter and six digits. A000001, A000002, … The letter carries the type,
-- so an account's type is readable from its code; the tree carries its
-- position. That is why a new child of Assets is A000002 and not A000001001.
-- ---------------------------------------------------------------------------
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year) VALUES
  ('ACCOUNT_CODE_ASSET',     'A', '{PREFIX}{SERIAL}', 6, false, false),
  ('ACCOUNT_CODE_LIABILITY', 'L', '{PREFIX}{SERIAL}', 6, false, false),
  ('ACCOUNT_CODE_EQUITY',    'E', '{PREFIX}{SERIAL}', 6, false, false),
  ('ACCOUNT_CODE_REVENUE',   'R', '{PREFIX}{SERIAL}', 6, false, false),
  ('ACCOUNT_CODE_EXPENSE',   'X', '{PREFIX}{SERIAL}', 6, false, false);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The five groups received from the Business Process Owner on 2026-08-16
-- (phases/chartsofaccount.md, D7).
--
-- They are seeded through the numbering service so that each type's counter is
-- left at 1 and the next account of that type is A000002, L000002 and so on —
-- the same path an account added from the screen takes.
--
-- Note the Expense root: the extract showed it credit-normal. It is seeded as
-- an expense account, and `src/server/domain/accounts.ts` derives the debit
-- normal balance from the type. See D7 in docs/DECISIONS.md.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_seed record;
  v_serial bigint;
  v_code   text;
BEGIN
  FOR v_seed IN
    SELECT * FROM (VALUES
      ('ACCOUNT_CODE_ASSET',     'A', 'asset',     'Assets',
       'Everything the company owns or is owed. Debit-normal.'),
      ('ACCOUNT_CODE_LIABILITY', 'L', 'liability', 'Liabilities',
       'Everything the company owes. Credit-normal.'),
      ('ACCOUNT_CODE_EQUITY',    'E', 'equity',    'Equity',
       'The owners'' interest in the company. Credit-normal.'),
      ('ACCOUNT_CODE_REVENUE',   'R', 'revenue',   'Revenue',
       'Income earned. Credit-normal.'),
      ('ACCOUNT_CODE_EXPENSE',   'X', 'expense',   'Expense',
       'Costs incurred. Debit-normal.')
    ) AS t(seq_key, letter, acct_type, acct_name, acct_description)
  LOOP
    v_serial := next_document_serial(v_seed.seq_key, '');
    v_code   := v_seed.letter || lpad(v_serial::text, 6, '0');

    INSERT INTO doc_number_allocation (sequence_key, scope_key, serial, document_no)
    VALUES (v_seed.seq_key, '', v_serial, v_code);

    INSERT INTO chart_of_account
      (code, name, account_type, parent_id, is_group, is_active, approval_status,
       is_system, level, description)
    VALUES
      (v_code, v_seed.acct_name, v_seed.acct_type::account_type, NULL, true, true,
       'approved', true, 0, v_seed.acct_description);
  END LOOP;
END;
$$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Grants.
--
-- No DELETE on chart_of_account for the application, at all. An account raised
-- in error is cancelled; an account no longer used is deactivated. §1.1.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON chart_of_account, account_required_dimension FROM erp_app;

  GRANT SELECT, INSERT, UPDATE         ON chart_of_account            TO erp_app;
  GRANT SELECT, INSERT, DELETE         ON account_required_dimension  TO erp_app;
END;
$$;