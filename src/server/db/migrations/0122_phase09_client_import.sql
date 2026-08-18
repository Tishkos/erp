CREATE TABLE "client_import_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_no" text NOT NULL,
	"client_account_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"opened_on" date NOT NULL,
	"description" text,
	"logistics_job_ref" text,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_import_payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_no" text NOT NULL,
	"client_import_file_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"payment_date" date NOT NULL,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"supplier_partner_id" uuid,
	"supplier_reference" text,
	"company_bank_account_id" uuid NOT NULL,
	"journal_entry_id" uuid,
	"created_by" uuid NOT NULL,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"reversed_by" uuid,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_import_payment_amount_positive" CHECK ("client_import_payment"."amount_iqd" > 0),
	CONSTRAINT "client_import_payment_reversal_has_reason" CHECK (("client_import_payment"."reversed_by" is null and "client_import_payment"."reversed_at" is null)
          or ("client_import_payment"."reversed_by" is not null and "client_import_payment"."reversed_at" is not null
              and coalesce(btrim("client_import_payment"."reversal_reason"), '') <> ''))
);
--> statement-breakpoint
CREATE TABLE "client_goods_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_no" text NOT NULL,
	"client_import_file_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"delivery_date" date NOT NULL,
	"amount_iqd" numeric(19, 4) NOT NULL,
	"goods_description" text,
	"received_by" text,
	"journal_entry_id" uuid,
	"created_by" uuid NOT NULL,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"reversed_by" uuid,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "client_goods_delivery_amount_positive" CHECK ("client_goods_delivery"."amount_iqd" > 0),
	CONSTRAINT "client_goods_delivery_reversal_has_reason" CHECK (("client_goods_delivery"."reversed_by" is null and "client_goods_delivery"."reversed_at" is null)
          or ("client_goods_delivery"."reversed_by" is not null and "client_goods_delivery"."reversed_at" is not null
              and coalesce(btrim("client_goods_delivery"."reversal_reason"), '') <> ''))
);
--> statement-breakpoint

ALTER TABLE "client_import_file" ADD CONSTRAINT "client_import_file_client_account_id_money_transfer_client_account_id_fk" FOREIGN KEY ("client_account_id") REFERENCES "public"."money_transfer_client_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_import_file" ADD CONSTRAINT "client_import_file_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_import_file" ADD CONSTRAINT "client_import_file_closed_by_app_user_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_import_file" ADD CONSTRAINT "client_import_file_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_import_payment" ADD CONSTRAINT "client_import_payment_client_import_file_id_client_import_file_id_fk" FOREIGN KEY ("client_import_file_id") REFERENCES "public"."client_import_file"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_import_payment" ADD CONSTRAINT "client_import_payment_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_import_payment" ADD CONSTRAINT "client_import_payment_supplier_partner_id_business_partner_id_fk" FOREIGN KEY ("supplier_partner_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_import_payment" ADD CONSTRAINT "client_import_payment_company_bank_account_id_bank_cash_account_id_fk" FOREIGN KEY ("company_bank_account_id") REFERENCES "public"."bank_cash_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_import_payment" ADD CONSTRAINT "client_import_payment_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_import_payment" ADD CONSTRAINT "client_import_payment_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_import_payment" ADD CONSTRAINT "client_import_payment_posted_by_app_user_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_import_payment" ADD CONSTRAINT "client_import_payment_reversed_by_app_user_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_goods_delivery" ADD CONSTRAINT "client_goods_delivery_client_import_file_id_client_import_file_id_fk" FOREIGN KEY ("client_import_file_id") REFERENCES "public"."client_import_file"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_goods_delivery" ADD CONSTRAINT "client_goods_delivery_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_goods_delivery" ADD CONSTRAINT "client_goods_delivery_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_goods_delivery" ADD CONSTRAINT "client_goods_delivery_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_goods_delivery" ADD CONSTRAINT "client_goods_delivery_posted_by_app_user_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_goods_delivery" ADD CONSTRAINT "client_goods_delivery_reversed_by_app_user_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "client_import_file_no_uniq" ON "client_import_file" USING btree ("file_no");--> statement-breakpoint
CREATE INDEX "client_import_file_account_idx" ON "client_import_file" USING btree ("client_account_id","status");--> statement-breakpoint
CREATE INDEX "client_import_file_logistics_idx" ON "client_import_file" USING btree ("logistics_job_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "client_import_payment_no_uniq" ON "client_import_payment" USING btree ("payment_no");--> statement-breakpoint
CREATE INDEX "client_import_payment_file_idx" ON "client_import_payment" USING btree ("client_import_file_id","status");--> statement-breakpoint
CREATE INDEX "client_import_payment_date_idx" ON "client_import_payment" USING btree ("payment_date","branch_code");--> statement-breakpoint
CREATE UNIQUE INDEX "client_goods_delivery_no_uniq" ON "client_goods_delivery" USING btree ("delivery_no");--> statement-breakpoint
CREATE INDEX "client_goods_delivery_file_idx" ON "client_goods_delivery" USING btree ("client_import_file_id","status");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Client Inventory is a balance, not a warehouse — and it has to stay that way.
--
-- §11.3: "Goods imported for a client do not enter company warehouses"; "Goods
-- remain in a financial intermediary account, Client Inventory, until delivery
-- to the client". §12.4 and Appendix C repeat it: "No company warehouse
-- quantity".
--
-- The three tables above carry no item code, no warehouse code and no quantity,
-- so the prohibited state has no representation. This trigger guards the one
-- thing a column count cannot: that somebody later adds one. It is cheap,
-- it runs on DDL nobody expects to change, and the alternative is discovering
-- the breach when a client's goods appear in a company stock valuation.
-- ---------------------------------------------------------------------------
CREATE FUNCTION client_import_carries_no_quantity() RETURNS event_trigger
LANGUAGE plpgsql AS $$
DECLARE
  r record;
BEGIN
  -- Only when the statement actually touched one of the three tables. Event
  -- triggers are database-wide and every `ALTER TABLE ... DISABLE TRIGGER` in a
  -- test reset would otherwise pay for a catalogue scan that cannot find
  -- anything.
  IF NOT EXISTS (
    SELECT 1 FROM pg_event_trigger_ddl_commands() d
      JOIN pg_class c ON c.oid = d.objid
     WHERE c.relname IN ('client_import_file', 'client_import_payment', 'client_goods_delivery')
  ) THEN
    RETURN;
  END IF;

  FOR r IN
    SELECT c.table_name, c.column_name
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.table_name IN ('client_import_file', 'client_import_payment', 'client_goods_delivery')
       AND (c.column_name ~ '(^|_)(quantity|qty)($|_)'
         OR c.column_name IN ('item_code', 'item_id', 'warehouse_code', 'warehouse_id'))
  LOOP
    RAISE EXCEPTION
      'Column %.% would give client-funded goods a company inventory quantity, which §11.3 and §12.4 both prohibit. Client Inventory is a financial intermediary account; route the goods through it, not through the Phase 04 inventory ledger.',
      r.table_name, r.column_name USING ERRCODE = 'restrict_violation';
  END LOOP;
END;
$$;--> statement-breakpoint

CREATE EVENT TRIGGER client_import_carries_no_quantity
  ON ddl_command_end WHEN TAG IN ('ALTER TABLE')
  EXECUTE FUNCTION client_import_carries_no_quantity();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A payment or a delivery belongs to the branch of its file, and to an open one.
-- ---------------------------------------------------------------------------
CREATE FUNCTION client_import_document_follows_file() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status document_status;
  v_no     text;
  v_branch text;
BEGIN
  SELECT status, file_no, branch_code INTO v_status, v_no, v_branch
    FROM client_import_file WHERE id = NEW.client_import_file_id;

  IF v_status IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION
      'Client import file % is ''%''; nothing further can be recorded against it (§1.1).',
      v_no, v_status USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.branch_code IS DISTINCT FROM v_branch THEN
    RAISE EXCEPTION
      'Document is on branch % but client import file % belongs to branch % (§14.3).',
      NEW.branch_code, v_no, v_branch USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER client_import_payment_follows_file
  BEFORE INSERT ON client_import_payment
  FOR EACH ROW EXECUTE FUNCTION client_import_document_follows_file();--> statement-breakpoint

CREATE TRIGGER client_goods_delivery_follows_file
  BEFORE INSERT ON client_goods_delivery
  FOR EACH ROW EXECUTE FUNCTION client_import_document_follows_file();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 09.10 gate — "Client Inventory reconciles to its G/L account and clears to
-- zero on delivery settlement."
--
-- The file may not settle or close while payments made on the client's behalf
-- have not been handed over and charged to them. A residual Client Inventory
-- balance on a closed file is company money spent on goods that, as far as the
-- records go, nobody ever received.
-- ---------------------------------------------------------------------------
CREATE FUNCTION client_import_file_clears_to_zero() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_paid      numeric(19,4);
  v_delivered numeric(19,4);
BEGIN
  IF NEW.status NOT IN ('settled', 'closed') OR OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  SELECT coalesce(sum(amount_iqd), 0) INTO v_paid
    FROM client_import_payment
   WHERE client_import_file_id = NEW.id AND status = 'posted';

  SELECT coalesce(sum(amount_iqd), 0) INTO v_delivered
    FROM client_goods_delivery
   WHERE client_import_file_id = NEW.id AND status = 'posted';

  IF v_paid <> v_delivered THEN
    RAISE EXCEPTION
      'Client import file % still carries a Client Inventory balance of % (paid % less delivered %). It clears to zero on delivery settlement (§12.4, §11.3) — settle the delivery before closing the file.',
      NEW.file_no, v_paid - v_delivered, v_paid, v_delivered
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER client_import_file_clears_to_zero
  BEFORE UPDATE ON client_import_file
  FOR EACH ROW EXECUTE FUNCTION client_import_file_clears_to_zero();--> statement-breakpoint

-- Posted client-import documents are corrected by reversal (§3.2), like every
-- other document that has moved the ledger.
CREATE FUNCTION client_import_posted_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_allowed text[] := ARRAY['status', 'updated_at', 'reversed_by', 'reversed_at', 'reversal_reason'];
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - v_allowed) IS DISTINCT FROM (to_jsonb(OLD) - v_allowed) THEN
    RAISE EXCEPTION
      'This client-import document has posted; Client Inventory and the bank both moved (§3.2). Reverse it and record it again.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER client_import_payment_posted_is_final
  BEFORE UPDATE ON client_import_payment
  FOR EACH ROW EXECUTE FUNCTION client_import_posted_is_final();--> statement-breakpoint

CREATE TRIGGER client_goods_delivery_posted_is_final
  BEFORE UPDATE ON client_goods_delivery
  FOR EACH ROW EXECUTE FUNCTION client_import_posted_is_final();--> statement-breakpoint

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year) VALUES
  ('CLIENT_IMPORT_FILE',    'CIF', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true),
  ('CLIENT_IMPORT_PAYMENT', 'CIP', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true),
  ('CLIENT_GOODS_DELIVERY', 'CGD', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('client_import_file', 'Client Import File', 'money_transfer',
   'One client-funded consignment (§12.2). Links a transfer to a Logistics job without combining their results (§11.3).'),
  ('client_import_payment', 'Client Import Payment', 'money_transfer',
   'Payment for client goods. Posts Dr Client Inventory / Cr Company Bank Account (§12.4). Creates no company warehouse quantity (Appendix C).'),
  ('client_goods_delivery', 'Client Goods Delivery Settlement', 'money_transfer',
   'Delivery and financial settlement. Posts Dr Client Account / Cr Client Inventory (§12.4). No Sales Invoice is issued (§11.3).');--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('client_import_file', 'draft',   'posted'),
  ('client_import_file', 'posted',  'settled'),
  ('client_import_file', 'settled', 'closed'),
  ('client_import_file', 'draft',   'cancelled'),
  ('client_import_payment', 'draft',  'posted'),
  ('client_import_payment', 'draft',  'cancelled'),
  ('client_import_payment', 'posted', 'reversed'),
  ('client_goods_delivery', 'draft',  'posted'),
  ('client_goods_delivery', 'draft',  'cancelled'),
  ('client_goods_delivery', 'posted', 'reversed');--> statement-breakpoint

INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('client_import_payment', 'client_import_file_id',
   'Decides whose goods the company paid for.'),
  ('client_import_payment', 'amount_iqd',
   'The amount that left the bank. Corrected by reversal (§3.2).'),
  ('client_import_payment', 'payment_date',
   'Decides the period Client Inventory and the bank move in.'),
  ('client_goods_delivery', 'client_import_file_id',
   'Decides which Client Inventory balance the settlement clears.'),
  ('client_goods_delivery', 'amount_iqd',
   'The amount charged to the client account on delivery (§12.4).')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'client_import_file', 'view'),
  ('accounting_officer', 'client_import_file', 'create'),
  ('accounting_officer', 'client_import_file', 'edit_draft'),
  ('accounting_manager', 'client_import_file', 'view'),
  ('accounting_manager', 'client_import_file', 'create'),
  ('accounting_manager', 'client_import_file', 'edit_draft'),
  ('accounting_manager', 'client_import_file', 'approve'),
  ('accounting_manager', 'client_import_file', 'reverse_cancel'),
  ('accounting_manager', 'client_import_file', 'export'),
  ('accounting_officer', 'client_import_payment', 'view'),
  ('accounting_officer', 'client_import_payment', 'create'),
  ('accounting_officer', 'client_import_payment', 'edit_draft'),
  ('accounting_officer', 'client_import_payment', 'submit'),
  ('accounting_manager', 'client_import_payment', 'view'),
  ('accounting_manager', 'client_import_payment', 'create'),
  ('accounting_manager', 'client_import_payment', 'edit_draft'),
  ('accounting_manager', 'client_import_payment', 'submit'),
  ('accounting_manager', 'client_import_payment', 'approve'),
  ('accounting_manager', 'client_import_payment', 'post'),
  ('accounting_manager', 'client_import_payment', 'reverse_cancel'),
  ('accounting_manager', 'client_import_payment', 'export'),
  ('accounting_officer', 'client_goods_delivery', 'view'),
  ('accounting_officer', 'client_goods_delivery', 'create'),
  ('accounting_officer', 'client_goods_delivery', 'edit_draft'),
  ('accounting_officer', 'client_goods_delivery', 'submit'),
  ('accounting_manager', 'client_goods_delivery', 'view'),
  ('accounting_manager', 'client_goods_delivery', 'create'),
  ('accounting_manager', 'client_goods_delivery', 'edit_draft'),
  ('accounting_manager', 'client_goods_delivery', 'submit'),
  ('accounting_manager', 'client_goods_delivery', 'approve'),
  ('accounting_manager', 'client_goods_delivery', 'post'),
  ('accounting_manager', 'client_goods_delivery', 'reverse_cancel'),
  ('accounting_manager', 'client_goods_delivery', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON client_import_file, client_import_payment, client_goods_delivery FROM erp_app;

  -- No DELETE on any of the three: all are documents (§1.1), and two of them
  -- moved money on a client's behalf.
  GRANT SELECT, INSERT, UPDATE ON client_import_file TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON client_import_payment TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON client_goods_delivery TO erp_app;
END;
$$;--> statement-breakpoint

ALTER TABLE client_import_file    ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE client_import_file    FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE client_import_payment ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE client_import_payment FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE client_goods_delivery ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE client_goods_delivery FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY client_import_file_branch_scope ON client_import_file
  USING (app_is_super_user() OR branch_code = app_current_branch())
  WITH CHECK (app_is_super_user() OR branch_code = app_current_branch());--> statement-breakpoint

CREATE POLICY client_import_payment_branch_scope ON client_import_payment
  USING (app_is_super_user() OR branch_code = app_current_branch())
  WITH CHECK (app_is_super_user() OR branch_code = app_current_branch());--> statement-breakpoint

CREATE POLICY client_goods_delivery_branch_scope ON client_goods_delivery
  USING (app_is_super_user() OR branch_code = app_current_branch())
  WITH CHECK (app_is_super_user() OR branch_code = app_current_branch());
