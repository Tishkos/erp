CREATE TYPE "public"."return_disposition" AS ENUM('saleable', 'quarantine', 'damaged');--> statement-breakpoint
CREATE TABLE "sales_return" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_no" text NOT NULL,
	"status" "document_status" DEFAULT 'submitted' NOT NULL,
	"ar_invoice_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"requested_on" date NOT NULL,
	"received_on" date,
	"reason" text NOT NULL,
	"receiving_warehouse_code" text,
	"note" text,
	"created_by" uuid NOT NULL,
	"received_by" uuid,
	"received_at" timestamp with time zone,
	"inspected_by" uuid,
	"inspected_at" timestamp with time zone,
	"accepted_by" uuid,
	"accepted_at" timestamp with time zone,
	"rejected_by" uuid,
	"rejected_at" timestamp with time zone,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_return_reason_present" CHECK (btrim("sales_return"."reason") <> ''),
	CONSTRAINT "sales_return_rejection_has_reason" CHECK (("sales_return"."rejected_by" is null and "sales_return"."rejected_at" is null)
          or ("sales_return"."rejected_by" is not null and "sales_return"."rejected_at" is not null
              and coalesce(btrim("sales_return"."rejection_reason"), '') <> '')),
	CONSTRAINT "sales_return_stamps_in_order" CHECK (("sales_return"."inspected_at" is null or "sales_return"."received_at" is not null)
          and ("sales_return"."inspected_at" is null or "sales_return"."received_at" <= "sales_return"."inspected_at")
          and ("sales_return"."accepted_at" is null or "sales_return"."inspected_at" is not null)
          and ("sales_return"."accepted_at" is null or "sales_return"."inspected_at" <= "sales_return"."accepted_at")),
	CONSTRAINT "sales_return_one_outcome" CHECK ("sales_return"."accepted_at" is null or "sales_return"."rejected_at" is null),
	CONSTRAINT "sales_return_received_date_with_stamp" CHECK (("sales_return"."received_on" is null) = ("sales_return"."received_at" is null))
);
--> statement-breakpoint
CREATE TABLE "sales_return_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sales_return_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"ar_invoice_line_id" uuid NOT NULL,
	"delivery_note_line_id" uuid NOT NULL,
	"item_code" text NOT NULL,
	"description" text NOT NULL,
	"uom_code" text NOT NULL,
	"requested_quantity" numeric(24, 6) NOT NULL,
	"received_quantity" numeric(24, 6),
	"accepted_quantity" numeric(24, 6),
	"serial_number" text,
	"batch_number" text,
	"disposition" "return_disposition",
	"destination_warehouse_code" text,
	"inspection_note" text,
	"original_unit_cost_iqd" numeric(19, 4),
	"inventory_movement_id" uuid,
	"credited_quantity" numeric(24, 6) DEFAULT '0' NOT NULL,
	CONSTRAINT "sales_return_line_requested_positive" CHECK ("sales_return_line"."requested_quantity" > 0),
	CONSTRAINT "sales_return_line_received_within_requested" CHECK ("sales_return_line"."received_quantity" is null
          or ("sales_return_line"."received_quantity" >= 0 and "sales_return_line"."received_quantity" <= "sales_return_line"."requested_quantity")),
	CONSTRAINT "sales_return_line_accepted_within_received" CHECK ("sales_return_line"."accepted_quantity" is null
          or ("sales_return_line"."accepted_quantity" >= 0
              and "sales_return_line"."received_quantity" is not null
              and "sales_return_line"."accepted_quantity" <= "sales_return_line"."received_quantity")),
	CONSTRAINT "sales_return_line_inspection_complete" CHECK (("sales_return_line"."disposition" is null) = ("sales_return_line"."destination_warehouse_code" is null)),
	CONSTRAINT "sales_return_line_credited_within_accepted" CHECK ("sales_return_line"."credited_quantity" >= 0
          and ("sales_return_line"."accepted_quantity" is null or "sales_return_line"."credited_quantity" <= "sales_return_line"."accepted_quantity")),
	CONSTRAINT "sales_return_line_cost_not_negative" CHECK ("sales_return_line"."original_unit_cost_iqd" is null or "sales_return_line"."original_unit_cost_iqd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "customer_credit_memo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memo_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"sales_return_id" uuid NOT NULL,
	"ar_invoice_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"branch_code" text NOT NULL,
	"memo_date" date NOT NULL,
	"amount_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"allocated_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"journal_entry_id" uuid,
	"note" text,
	"created_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"reversed_by" uuid,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_credit_memo_amount_not_negative" CHECK ("customer_credit_memo"."amount_iqd" >= 0),
	CONSTRAINT "customer_credit_memo_allocation_within_amount" CHECK ("customer_credit_memo"."allocated_iqd" >= 0 and "customer_credit_memo"."allocated_iqd" <= "customer_credit_memo"."amount_iqd"),
	CONSTRAINT "customer_credit_memo_reversal_has_reason" CHECK (("customer_credit_memo"."reversed_by" is null and "customer_credit_memo"."reversed_at" is null)
          or ("customer_credit_memo"."reversed_by" is not null and "customer_credit_memo"."reversed_at" is not null
              and coalesce(btrim("customer_credit_memo"."reversal_reason"), '') <> '')),
	CONSTRAINT "customer_credit_memo_posting_matches_status" CHECK (("customer_credit_memo"."journal_entry_id" is null) = ("customer_credit_memo"."posted_at" is null)),
	CONSTRAINT "customer_credit_memo_stamps_in_order" CHECK (("customer_credit_memo"."posted_at" is null or "customer_credit_memo"."approved_at" is not null)
          and ("customer_credit_memo"."posted_at" is null or "customer_credit_memo"."approved_at" <= "customer_credit_memo"."posted_at")
          and ("customer_credit_memo"."reversed_at" is null or "customer_credit_memo"."posted_at" is not null)
          and ("customer_credit_memo"."reversed_at" is null or "customer_credit_memo"."posted_at" <= "customer_credit_memo"."reversed_at"))
);
--> statement-breakpoint
CREATE TABLE "customer_credit_memo_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_credit_memo_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"sales_return_line_id" uuid NOT NULL,
	"ar_invoice_line_id" uuid NOT NULL,
	"item_code" text NOT NULL,
	"description" text NOT NULL,
	"uom_code" text NOT NULL,
	"quantity" numeric(24, 6) NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"amount_iqd" numeric(19, 4) NOT NULL,
	CONSTRAINT "customer_credit_memo_line_quantity_positive" CHECK ("customer_credit_memo_line"."quantity" > 0),
	CONSTRAINT "customer_credit_memo_line_price_not_negative" CHECK ("customer_credit_memo_line"."unit_price" >= 0),
	CONSTRAINT "customer_credit_memo_line_amount_not_negative" CHECK ("customer_credit_memo_line"."amount_iqd" >= 0)
);
--> statement-breakpoint
ALTER TABLE "sales_return" ADD CONSTRAINT "sales_return_ar_invoice_id_ar_invoice_id_fk" FOREIGN KEY ("ar_invoice_id") REFERENCES "public"."ar_invoice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return" ADD CONSTRAINT "sales_return_customer_id_business_partner_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return" ADD CONSTRAINT "sales_return_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return" ADD CONSTRAINT "sales_return_receiving_warehouse_code_warehouse_code_fk" FOREIGN KEY ("receiving_warehouse_code") REFERENCES "public"."warehouse"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return" ADD CONSTRAINT "sales_return_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return" ADD CONSTRAINT "sales_return_received_by_app_user_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return" ADD CONSTRAINT "sales_return_inspected_by_app_user_id_fk" FOREIGN KEY ("inspected_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return" ADD CONSTRAINT "sales_return_accepted_by_app_user_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return" ADD CONSTRAINT "sales_return_rejected_by_app_user_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return_line" ADD CONSTRAINT "sales_return_line_sales_return_id_sales_return_id_fk" FOREIGN KEY ("sales_return_id") REFERENCES "public"."sales_return"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return_line" ADD CONSTRAINT "sales_return_line_ar_invoice_line_id_ar_invoice_line_id_fk" FOREIGN KEY ("ar_invoice_line_id") REFERENCES "public"."ar_invoice_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return_line" ADD CONSTRAINT "sales_return_line_delivery_note_line_id_delivery_note_line_id_fk" FOREIGN KEY ("delivery_note_line_id") REFERENCES "public"."delivery_note_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return_line" ADD CONSTRAINT "sales_return_line_item_code_item_code_fk" FOREIGN KEY ("item_code") REFERENCES "public"."item"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return_line" ADD CONSTRAINT "sales_return_line_uom_code_unit_of_measure_code_fk" FOREIGN KEY ("uom_code") REFERENCES "public"."unit_of_measure"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return_line" ADD CONSTRAINT "sales_return_line_destination_warehouse_code_warehouse_code_fk" FOREIGN KEY ("destination_warehouse_code") REFERENCES "public"."warehouse"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_memo" ADD CONSTRAINT "customer_credit_memo_sales_return_id_sales_return_id_fk" FOREIGN KEY ("sales_return_id") REFERENCES "public"."sales_return"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_memo" ADD CONSTRAINT "customer_credit_memo_ar_invoice_id_ar_invoice_id_fk" FOREIGN KEY ("ar_invoice_id") REFERENCES "public"."ar_invoice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_memo" ADD CONSTRAINT "customer_credit_memo_customer_id_business_partner_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."business_partner"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_memo" ADD CONSTRAINT "customer_credit_memo_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_memo" ADD CONSTRAINT "customer_credit_memo_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_memo" ADD CONSTRAINT "customer_credit_memo_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_memo" ADD CONSTRAINT "customer_credit_memo_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_memo" ADD CONSTRAINT "customer_credit_memo_posted_by_app_user_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_memo" ADD CONSTRAINT "customer_credit_memo_reversed_by_app_user_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_memo_line" ADD CONSTRAINT "customer_credit_memo_line_customer_credit_memo_id_customer_credit_memo_id_fk" FOREIGN KEY ("customer_credit_memo_id") REFERENCES "public"."customer_credit_memo"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_memo_line" ADD CONSTRAINT "customer_credit_memo_line_sales_return_line_id_sales_return_line_id_fk" FOREIGN KEY ("sales_return_line_id") REFERENCES "public"."sales_return_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_memo_line" ADD CONSTRAINT "customer_credit_memo_line_ar_invoice_line_id_ar_invoice_line_id_fk" FOREIGN KEY ("ar_invoice_line_id") REFERENCES "public"."ar_invoice_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_memo_line" ADD CONSTRAINT "customer_credit_memo_line_item_code_item_code_fk" FOREIGN KEY ("item_code") REFERENCES "public"."item"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_memo_line" ADD CONSTRAINT "customer_credit_memo_line_uom_code_unit_of_measure_code_fk" FOREIGN KEY ("uom_code") REFERENCES "public"."unit_of_measure"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_return_no_uniq" ON "sales_return" USING btree ("return_no");--> statement-breakpoint
CREATE INDEX "sales_return_invoice_idx" ON "sales_return" USING btree ("ar_invoice_id");--> statement-breakpoint
CREATE INDEX "sales_return_customer_idx" ON "sales_return" USING btree ("customer_id","status");--> statement-breakpoint
CREATE INDEX "sales_return_status_idx" ON "sales_return" USING btree ("status","branch_code");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_return_line_no_uniq" ON "sales_return_line" USING btree ("sales_return_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_return_line_invoice_line_uniq" ON "sales_return_line" USING btree ("sales_return_id","ar_invoice_line_id");--> statement-breakpoint
CREATE INDEX "sales_return_line_item_idx" ON "sales_return_line" USING btree ("item_code");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_credit_memo_no_uniq" ON "customer_credit_memo" USING btree ("memo_no");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_credit_memo_return_uniq" ON "customer_credit_memo" USING btree ("sales_return_id") WHERE "customer_credit_memo"."status" <> 'reversed';--> statement-breakpoint
CREATE INDEX "customer_credit_memo_customer_idx" ON "customer_credit_memo" USING btree ("customer_id","status");--> statement-breakpoint
CREATE INDEX "customer_credit_memo_invoice_idx" ON "customer_credit_memo" USING btree ("ar_invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_credit_memo_line_no_uniq" ON "customer_credit_memo_line" USING btree ("customer_credit_memo_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_credit_memo_line_return_line_uniq" ON "customer_credit_memo_line" USING btree ("customer_credit_memo_id","sales_return_line_id");--> statement-breakpoint
CREATE INDEX "customer_credit_memo_line_item_idx" ON "customer_credit_memo_line" USING btree ("item_code");
-- ===========================================================================
-- Phase 06.9 — Sales Return and Customer Credit Memo (§7.5, Appendix B, C)
--
--   "A/R Invoice -> Sales Return / Goods Return from Customer -> Inspection ->
--    Saleable Warehouse, Quarantine Warehouse or Damaged Goods Warehouse ->
--    Customer Credit Memo."
--   "Product exchange is not supported. Replacement requires a new Sales Order."
--   "Damaged returned goods cannot be sold."
--
-- **The first thing to notice is what is missing.** There is no exchange table,
-- no replacement_item_code, no swap document and no line type that means
-- "exchange". The rule is enforced by absence: a validation refusing exchanges
-- could be routed around by whatever path the validation was not written for, and
-- a concept with no column cannot be reached by any route at all. The same
-- reasoning keeps a unit price off the Sales Order (blueprint 7.3).
--
-- **Where the stock movement is.** At acceptance, not at receipt. A customer's
-- carton at the gate is not company stock; it is goods on an inspection bench
-- that the company has not agreed to take back. A rejected return therefore never
-- touches the ledger, instead of needing a reversing movement to undo stock the
-- company never accepted.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- §7.5 — *"Return quantity cannot exceed invoiced quantity less previous
-- accepted returns."*
--
-- Cumulative, and counting only returns that were not rejected: a rejected
-- return went back to the customer, so those units are still theirs to return
-- again. Counting them would let one refused claim block a legitimate second
-- attempt at the same goods.
--
-- In the database as well as the service, because blueprint 7.7 requires the sales
-- controls to survive the UI and the API — and an import is neither.
-- ---------------------------------------------------------------------------
CREATE FUNCTION sales_return_line_within_invoiced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_invoiced  numeric(24,6);
  v_returned  numeric(24,6);
  v_item      text;
  v_line_inv  uuid;
  v_ret_inv   uuid;
  v_claiming  numeric(24,6);
BEGIN
  SELECT quantity, item_code, ar_invoice_id
    INTO v_invoiced, v_item, v_line_inv
    FROM ar_invoice_line WHERE id = NEW.ar_invoice_line_id;

  SELECT ar_invoice_id INTO v_ret_inv FROM sales_return WHERE id = NEW.sales_return_id;

  IF v_line_inv IS DISTINCT FROM v_ret_inv THEN
    RAISE EXCEPTION
      'A sales return line names an invoice line from a different invoice. A return reconciles to the invoice it names (blueprint 7.5).'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.item_code IS DISTINCT FROM v_item THEN
    RAISE EXCEPTION
      'Sales return line names % but the invoice line is for %. The item is carried down the chain, not chosen at return.',
      NEW.item_code, v_item
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT coalesce(sum(coalesce(rl.accepted_quantity, rl.requested_quantity)), 0)
    INTO v_returned
    FROM sales_return_line rl
    JOIN sales_return r ON r.id = rl.sales_return_id
   WHERE rl.ar_invoice_line_id = NEW.ar_invoice_line_id
     AND rl.id <> NEW.id
     AND r.status <> 'rejected';

  v_claiming := coalesce(NEW.accepted_quantity, NEW.requested_quantity);

  IF v_returned + v_claiming > coalesce(v_invoiced, 0) THEN
    RAISE EXCEPTION
      'Returning % of % is more than the customer bought. Invoiced: %; already returned: %. Goods the customer was never billed for are not a return (blueprint 7.5).',
      v_claiming, v_item, coalesce(v_invoiced, 0), v_returned
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER sales_return_line_within_invoiced
  AFTER INSERT OR UPDATE ON sales_return_line
  FOR EACH ROW EXECUTE FUNCTION sales_return_line_within_invoiced();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 06.9 gate — *"goods routed to damaged cannot subsequently be sold."*
--
-- Phase 04 enforces that by where the stock sits: damaged-goods stock is not
-- available stock (migration 0027 computes availability by warehouse type). That
-- control is worth exactly as much as the guarantee that damaged goods actually
-- land in a damaged-goods warehouse, which is this.
--
-- Saleable is deliberately permissive between 'main' and 'branch': a company may
-- return goods to either kind of selling location. Quarantine and damaged are
-- not - there is one right kind of warehouse for each, and a mistake there is
-- the mistake blueprint 7.5 exists to prevent.
-- ---------------------------------------------------------------------------
CREATE FUNCTION sales_return_line_destination_matches() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_type text;
BEGIN
  IF NEW.destination_warehouse_code IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT warehouse_type::text INTO v_type
    FROM warehouse WHERE code = NEW.destination_warehouse_code;

  IF NEW.disposition = 'damaged' AND v_type IS DISTINCT FROM 'damaged_goods' THEN
    RAISE EXCEPTION
      'A return inspected as damaged cannot be put into %, which is a % warehouse. Blueprint 7.5 keeps damaged goods out of the saleable pool by keeping them in a warehouse that is not one.',
      NEW.destination_warehouse_code, coalesce(v_type, 'missing')
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.disposition = 'quarantine' AND v_type IS DISTINCT FROM 'quarantine' THEN
    RAISE EXCEPTION
      'A return inspected as quarantine cannot be put into %, which is a % warehouse.',
      NEW.destination_warehouse_code, coalesce(v_type, 'missing')
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.disposition = 'saleable' AND v_type NOT IN ('main', 'branch') THEN
    RAISE EXCEPTION
      'A return inspected as saleable cannot be put into %, which is a % warehouse.',
      NEW.destination_warehouse_code, coalesce(v_type, 'missing')
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER sales_return_line_destination_matches
  BEFORE INSERT OR UPDATE ON sales_return_line
  FOR EACH ROW EXECUTE FUNCTION sales_return_line_destination_matches();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Appendix C — *"accepted return and source invoice required."*
--
-- Both are NOT NULL columns above, which closes "no link at all". This closes
-- the rest: the return must have been accepted, and the memo must credit the
-- same customer and the same invoice the return was raised against.
-- ---------------------------------------------------------------------------
CREATE FUNCTION customer_credit_memo_has_an_accepted_return() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status   text;
  v_return_no text;
  v_invoice  uuid;
  v_customer uuid;
  v_branch   text;
BEGIN
  SELECT status::text, return_no, ar_invoice_id, customer_id, branch_code
    INTO v_status, v_return_no, v_invoice, v_customer, v_branch
    FROM sales_return WHERE id = NEW.sales_return_id;

  IF v_status NOT IN ('approved', 'closed') THEN
    RAISE EXCEPTION
      'Sales Return % is %, and Appendix C requires an accepted return before a credit memo. Crediting a customer for goods nobody has inspected is agreeing to a claim sight unseen.',
      v_return_no, coalesce(v_status, 'missing')
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.ar_invoice_id IS DISTINCT FROM v_invoice THEN
    RAISE EXCEPTION
      'Credit memo names a different invoice from the one Sales Return % was raised against.',
      v_return_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.customer_id IS DISTINCT FROM v_customer THEN
    RAISE EXCEPTION
      'Credit memo credits a different customer from the one who returned the goods on %.',
      v_return_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.branch_code IS DISTINCT FROM v_branch THEN
    RAISE EXCEPTION
      'Credit memo is in branch % but Sales Return % belongs to %.',
      NEW.branch_code, v_return_no, v_branch
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER customer_credit_memo_has_an_accepted_return
  BEFORE INSERT OR UPDATE ON customer_credit_memo
  FOR EACH ROW EXECUTE FUNCTION customer_credit_memo_has_an_accepted_return();--> statement-breakpoint

-- Numbering, document types, statuses and permissions.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('SALES_RETURN', 'SRN', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true),
       ('CUSTOMER_CREDIT_MEMO', 'CCM', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('sales_return', 'Sales Return', 'sales',
   'Goods coming back from a customer against a posted A/R Invoice. Inspected to saleable, quarantine or damaged (blueprint 7.5); the stock movement happens at acceptance, valued at the original FIFO cost. Product exchange is not supported.'),
  ('customer_credit_memo', 'Customer Credit Memo', 'sales',
   'Credits a customer for an accepted Sales Return. Posts Dr Sales Returns / Cr Customer A/R; the inventory and COGS half belongs to the return''s movement (Appendix B).');--> statement-breakpoint

-- Appendix B: Requested, Received, Inspected, Accepted, Rejected, Closed - onto
-- section 3.2's vocabulary. Approval comes *after* execution here, which is right:
-- the warehouse receives and inspects before anyone can sensibly decide whether
-- the company accepts the return.
INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('sales_return', 'submitted',           'partially_executed'),
  ('sales_return', 'submitted',           'rejected'),
  ('sales_return', 'partially_executed',  'executed'),
  ('sales_return', 'partially_executed',  'rejected'),
  ('sales_return', 'executed',            'approved'),
  ('sales_return', 'executed',            'rejected'),
  ('sales_return', 'approved',            'closed'),
  ('sales_return', 'rejected',            'closed');--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('customer_credit_memo', 'draft',              'approved'),
  ('customer_credit_memo', 'draft',              'cancelled'),
  ('customer_credit_memo', 'approved',           'draft'),
  ('customer_credit_memo', 'approved',           'posted'),
  ('customer_credit_memo', 'posted',             'partially_executed'),
  ('customer_credit_memo', 'posted',             'settled'),
  ('customer_credit_memo', 'partially_executed', 'settled'),
  ('customer_credit_memo', 'posted',             'reversed');--> statement-breakpoint

INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('sales_return', 'ar_invoice_id',
   'Decides what the return reconciles to and what the customer may be credited. Appendix C requires the source invoice.'),
  ('sales_return', 'reason',
   'The only record of why the customer sent the goods back, and the basis for accepting or rejecting (blueprint 5.4).'),
  ('customer_credit_memo', 'sales_return_id',
   'Appendix C requires an accepted return; changing it would credit a customer for somebody else''s goods.'),
  ('customer_credit_memo', 'amount_iqd',
   'Decides what the customer is owed. Derived from the accepted quantities at the invoice price, never typed.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'sales_return', 'view'),
  ('accounting_officer', 'sales_return', 'create'),
  ('accounting_officer', 'sales_return', 'edit_draft'),
  ('accounting_officer', 'sales_return', 'execute'),
  ('accounting_officer', 'sales_return', 'print'),
  ('accounting_manager', 'sales_return', 'view'),
  ('accounting_manager', 'sales_return', 'create'),
  ('accounting_manager', 'sales_return', 'edit_draft'),
  ('accounting_manager', 'sales_return', 'execute'),
  ('accounting_manager', 'sales_return', 'approve'),
  ('accounting_manager', 'sales_return', 'reverse_cancel'),
  ('accounting_manager', 'sales_return', 'print'),
  ('accounting_manager', 'sales_return', 'export'),
  ('accounting_officer', 'customer_credit_memo', 'view'),
  ('accounting_officer', 'customer_credit_memo', 'create'),
  ('accounting_officer', 'customer_credit_memo', 'edit_draft'),
  ('accounting_officer', 'customer_credit_memo', 'print'),
  ('accounting_manager', 'customer_credit_memo', 'view'),
  ('accounting_manager', 'customer_credit_memo', 'create'),
  ('accounting_manager', 'customer_credit_memo', 'edit_draft'),
  ('accounting_manager', 'customer_credit_memo', 'approve'),
  ('accounting_manager', 'customer_credit_memo', 'post'),
  ('accounting_manager', 'customer_credit_memo', 'execute'),
  ('accounting_manager', 'customer_credit_memo', 'reverse_cancel'),
  ('accounting_manager', 'customer_credit_memo', 'print'),
  ('accounting_manager', 'customer_credit_memo', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist - grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON sales_return, sales_return_line,
                customer_credit_memo, customer_credit_memo_line FROM erp_app;

  GRANT SELECT, INSERT, UPDATE ON sales_return TO erp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON sales_return_line TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON customer_credit_memo TO erp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON customer_credit_memo_line TO erp_app;
END;
$$;--> statement-breakpoint

-- D10 — the branch boundary, on all four.
ALTER TABLE sales_return ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE sales_return FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY sales_return_branch_scope ON sales_return
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

ALTER TABLE sales_return_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE sales_return_line FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY sales_return_line_branch_scope ON sales_return_line
  USING (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM sales_return r
       WHERE r.id = sales_return_line.sales_return_id
         AND app_branch_allowed(r.branch_code)
    )
  )
  WITH CHECK (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM sales_return r
       WHERE r.id = sales_return_line.sales_return_id
         AND app_branch_allowed(r.branch_code)
    )
  );--> statement-breakpoint

ALTER TABLE customer_credit_memo ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE customer_credit_memo FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY customer_credit_memo_branch_scope ON customer_credit_memo
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

ALTER TABLE customer_credit_memo_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE customer_credit_memo_line FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY customer_credit_memo_line_branch_scope ON customer_credit_memo_line
  USING (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM customer_credit_memo m
       WHERE m.id = customer_credit_memo_line.customer_credit_memo_id
         AND app_branch_allowed(m.branch_code)
    )
  )
  WITH CHECK (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM customer_credit_memo m
       WHERE m.id = customer_credit_memo_line.customer_credit_memo_id
         AND app_branch_allowed(m.branch_code)
    )
  );
