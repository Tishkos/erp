CREATE TABLE "delivery_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_note_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"sales_order_id" uuid NOT NULL,
	"pick_list_id" uuid NOT NULL,
	"warehouse_code" text NOT NULL,
	"branch_code" text NOT NULL,
	"delivery_date" date NOT NULL,
	"delivery_location" text,
	"journal_entry_id" uuid,
	"cogs_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"note" text,
	"created_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"delivered_by" uuid,
	"delivered_at" timestamp with time zone,
	"reversed_by" uuid,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_note_reversal_has_reason" CHECK (("delivery_note"."reversed_by" is null and "delivery_note"."reversed_at" is null)
          or ("delivery_note"."reversed_by" is not null and "delivery_note"."reversed_at" is not null
              and coalesce(btrim("delivery_note"."reversal_reason"), '') <> '')),
	CONSTRAINT "delivery_note_stamps_in_order" CHECK (("delivery_note"."delivered_at" is null or "delivery_note"."approved_at" is not null)
          and ("delivery_note"."delivered_at" is null or "delivery_note"."approved_at" <= "delivery_note"."delivered_at")
          and ("delivery_note"."reversed_at" is null or "delivery_note"."delivered_at" is not null)
          and ("delivery_note"."reversed_at" is null or "delivery_note"."delivered_at" <= "delivery_note"."reversed_at")),
	CONSTRAINT "delivery_note_posting_matches_status" CHECK (("delivery_note"."journal_entry_id" is null) = ("delivery_note"."delivered_at" is null)),
	CONSTRAINT "delivery_note_cogs_not_negative" CHECK ("delivery_note"."cogs_iqd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "delivery_note_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_note_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"sales_order_line_id" uuid NOT NULL,
	"pick_list_line_id" uuid NOT NULL,
	"item_code" text NOT NULL,
	"description" text NOT NULL,
	"uom_code" text NOT NULL,
	"quantity" numeric(24, 6) NOT NULL,
	"cogs_iqd" numeric(19, 4) DEFAULT '0' NOT NULL,
	"inventory_movement_id" uuid,
	"invoiced_quantity" numeric(24, 6) DEFAULT '0' NOT NULL,
	CONSTRAINT "delivery_note_line_quantity_positive" CHECK ("delivery_note_line"."quantity" > 0),
	CONSTRAINT "delivery_note_line_cogs_not_negative" CHECK ("delivery_note_line"."cogs_iqd" >= 0),
	CONSTRAINT "delivery_note_line_invoiced_within_delivered" CHECK ("delivery_note_line"."invoiced_quantity" >= 0 and "delivery_note_line"."invoiced_quantity" <= "delivery_note_line"."quantity")
);
--> statement-breakpoint
CREATE TABLE "delivery_note_line_unit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_note_line_id" uuid NOT NULL,
	"serial_number" text,
	"batch_number" text,
	"quantity" numeric(24, 6) NOT NULL,
	CONSTRAINT "delivery_note_line_unit_quantity_positive" CHECK ("delivery_note_line_unit"."quantity" > 0),
	CONSTRAINT "delivery_note_line_unit_identifies_something" CHECK (coalesce(btrim("delivery_note_line_unit"."serial_number"), '') <> '' or coalesce(btrim("delivery_note_line_unit"."batch_number"), '') <> ''),
	CONSTRAINT "delivery_note_line_unit_serial_is_one" CHECK ("delivery_note_line_unit"."serial_number" is null or "delivery_note_line_unit"."quantity" = 1)
);
--> statement-breakpoint
CREATE TABLE "proof_of_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_note_id" uuid NOT NULL,
	"recipient_name" text NOT NULL,
	"recipient_role" text,
	"signature_attachment_id" uuid NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"captured_by" uuid NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	CONSTRAINT "proof_of_delivery_recipient_named" CHECK (btrim("proof_of_delivery"."recipient_name") <> '')
);
--> statement-breakpoint
CREATE TABLE "proof_of_delivery_photo" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proof_of_delivery_id" uuid NOT NULL,
	"attachment_id" uuid NOT NULL,
	"caption" text,
	"sequence" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_note" ADD CONSTRAINT "delivery_note_sales_order_id_sales_order_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_note" ADD CONSTRAINT "delivery_note_pick_list_id_pick_list_id_fk" FOREIGN KEY ("pick_list_id") REFERENCES "public"."pick_list"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_note" ADD CONSTRAINT "delivery_note_warehouse_code_warehouse_code_fk" FOREIGN KEY ("warehouse_code") REFERENCES "public"."warehouse"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_note" ADD CONSTRAINT "delivery_note_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_note" ADD CONSTRAINT "delivery_note_journal_entry_id_journal_entry_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_note" ADD CONSTRAINT "delivery_note_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_note" ADD CONSTRAINT "delivery_note_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_note" ADD CONSTRAINT "delivery_note_delivered_by_app_user_id_fk" FOREIGN KEY ("delivered_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_note" ADD CONSTRAINT "delivery_note_reversed_by_app_user_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_note_line" ADD CONSTRAINT "delivery_note_line_delivery_note_id_delivery_note_id_fk" FOREIGN KEY ("delivery_note_id") REFERENCES "public"."delivery_note"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_note_line" ADD CONSTRAINT "delivery_note_line_sales_order_line_id_sales_order_line_id_fk" FOREIGN KEY ("sales_order_line_id") REFERENCES "public"."sales_order_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_note_line" ADD CONSTRAINT "delivery_note_line_pick_list_line_id_pick_list_line_id_fk" FOREIGN KEY ("pick_list_line_id") REFERENCES "public"."pick_list_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_note_line" ADD CONSTRAINT "delivery_note_line_item_code_item_code_fk" FOREIGN KEY ("item_code") REFERENCES "public"."item"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_note_line" ADD CONSTRAINT "delivery_note_line_uom_code_unit_of_measure_code_fk" FOREIGN KEY ("uom_code") REFERENCES "public"."unit_of_measure"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_note_line_unit" ADD CONSTRAINT "delivery_note_line_unit_delivery_note_line_id_delivery_note_line_id_fk" FOREIGN KEY ("delivery_note_line_id") REFERENCES "public"."delivery_note_line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_of_delivery" ADD CONSTRAINT "proof_of_delivery_delivery_note_id_delivery_note_id_fk" FOREIGN KEY ("delivery_note_id") REFERENCES "public"."delivery_note"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_of_delivery" ADD CONSTRAINT "proof_of_delivery_signature_attachment_id_attachment_id_fk" FOREIGN KEY ("signature_attachment_id") REFERENCES "public"."attachment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_of_delivery" ADD CONSTRAINT "proof_of_delivery_captured_by_app_user_id_fk" FOREIGN KEY ("captured_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_of_delivery_photo" ADD CONSTRAINT "proof_of_delivery_photo_proof_of_delivery_id_proof_of_delivery_id_fk" FOREIGN KEY ("proof_of_delivery_id") REFERENCES "public"."proof_of_delivery"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_of_delivery_photo" ADD CONSTRAINT "proof_of_delivery_photo_attachment_id_attachment_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_note_no_uniq" ON "delivery_note" USING btree ("delivery_note_no");--> statement-breakpoint
CREATE INDEX "delivery_note_order_idx" ON "delivery_note" USING btree ("sales_order_id","status");--> statement-breakpoint
CREATE INDEX "delivery_note_pick_idx" ON "delivery_note" USING btree ("pick_list_id");--> statement-breakpoint
CREATE INDEX "delivery_note_date_idx" ON "delivery_note" USING btree ("delivery_date","branch_code");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_note_line_no_uniq" ON "delivery_note_line" USING btree ("delivery_note_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_note_line_pick_line_uniq" ON "delivery_note_line" USING btree ("delivery_note_id","pick_list_line_id");--> statement-breakpoint
CREATE INDEX "delivery_note_line_order_line_idx" ON "delivery_note_line" USING btree ("sales_order_line_id");--> statement-breakpoint
CREATE INDEX "delivery_note_line_item_idx" ON "delivery_note_line" USING btree ("item_code");--> statement-breakpoint
CREATE INDEX "delivery_note_line_unit_line_idx" ON "delivery_note_line_unit" USING btree ("delivery_note_line_id");--> statement-breakpoint
CREATE INDEX "delivery_note_line_unit_serial_idx" ON "delivery_note_line_unit" USING btree ("serial_number") WHERE "delivery_note_line_unit"."serial_number" is not null;--> statement-breakpoint
CREATE INDEX "delivery_note_line_unit_batch_idx" ON "delivery_note_line_unit" USING btree ("batch_number") WHERE "delivery_note_line_unit"."batch_number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "proof_of_delivery_note_uniq" ON "proof_of_delivery" USING btree ("delivery_note_id");--> statement-breakpoint
CREATE UNIQUE INDEX "proof_of_delivery_photo_uniq" ON "proof_of_delivery_photo" USING btree ("proof_of_delivery_id","attachment_id");--> statement-breakpoint
CREATE INDEX "proof_of_delivery_photo_pod_idx" ON "proof_of_delivery_photo" USING btree ("proof_of_delivery_id","sequence");
-- ===========================================================================
-- Phase 06.5 — Delivery Note and Proof of Delivery (§7.2, §7.4, Appendix B, C)
--
-- Appendix B: Draft, Approved, Delivered, Reversed. Effect: Inventory and COGS.
-- Appendix C: "Sales delivery and invoice | Customer A/R; COGS | Sales Revenue;
-- Inventory | Same delivery and invoice date; Price List locked."
--
-- No Cancelled state, because Appendix B gives it none: a delivery is undone by
-- reversing it, since by then stock has moved and COGS has posted.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- §7.2 — the chain. A note carries the units one picker took off one shelf,
-- against one order.
--
-- The foreign keys say the pick line and the order line exist; they do not say
-- the two belong together, or that either belongs to this note's documents. A
-- note that mixed two orders would deliver against a reservation nobody made.
-- ---------------------------------------------------------------------------
CREATE FUNCTION delivery_note_line_belongs_to_the_note() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_note_order  uuid;
  v_note_pick   uuid;
  v_note_no     text;
  v_pick_sheet  uuid;
  v_pick_order  uuid;
  v_pick_item   text;
  v_picked      numeric(24,6);
BEGIN
  SELECT sales_order_id, pick_list_id, delivery_note_no
    INTO v_note_order, v_note_pick, v_note_no
    FROM delivery_note WHERE id = NEW.delivery_note_id;

  SELECT pick_list_id, sales_order_line_id, item_code, picked_quantity
    INTO v_pick_sheet, v_pick_order, v_pick_item, v_picked
    FROM pick_list_line WHERE id = NEW.pick_list_line_id;

  IF v_pick_sheet IS DISTINCT FROM v_note_pick THEN
    RAISE EXCEPTION
      'Delivery Note % carries one pick list, and this line was picked on another. The note is the units that sheet took off the shelf (blueprint 7.2).',
      v_note_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_pick_order IS DISTINCT FROM NEW.sales_order_line_id THEN
    RAISE EXCEPTION
      'Delivery Note % line names an order line the pick did not pick against. Delivery, pick and order reconcile to each other (blueprint 7.7).',
      v_note_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.item_code IS DISTINCT FROM v_pick_item THEN
    RAISE EXCEPTION
      'Delivery Note line names % but the pick took %. The item is carried down, not chosen at delivery.',
      NEW.item_code, v_pick_item
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The van holds what the picker put in it, and no more (blueprint 9.9: the
  -- serials on the note have to be the ones that were scanned).
  IF NEW.quantity > coalesce(v_picked, 0) THEN
    RAISE EXCEPTION
      'Delivering % of % when % was picked. To send more, pick more first (blueprint 7.2).',
      NEW.quantity, NEW.item_code, coalesce(v_picked, 0)
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER delivery_note_line_belongs_to_the_note
  BEFORE INSERT OR UPDATE ON delivery_note_line
  FOR EACH ROW EXECUTE FUNCTION delivery_note_line_belongs_to_the_note();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 06.5 gate — *"Delivery quantities reconcile to the source Sales Order"*
-- (§7.7), cumulatively across notes.
--
-- §7.2 supports several deliveries from one order, so no single note is the
-- one that is too large: the third one is. A reversed note does not count, its
-- goods came back.
-- ---------------------------------------------------------------------------
CREATE FUNCTION delivery_note_line_within_ordered() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_ordered   numeric(24,6);
  v_delivered numeric(24,6);
  v_item      text;
BEGIN
  SELECT quantity, item_code INTO v_ordered, v_item
    FROM sales_order_line WHERE id = NEW.sales_order_line_id;

  SELECT coalesce(sum(l.quantity), 0) INTO v_delivered
    FROM delivery_note_line l
    JOIN delivery_note n ON n.id = l.delivery_note_id
   WHERE l.sales_order_line_id = NEW.sales_order_line_id
     AND l.id <> NEW.id
     AND n.status <> 'reversed';

  IF v_delivered + NEW.quantity > coalesce(v_ordered, 0) THEN
    RAISE EXCEPTION
      'Delivering % of % would exceed the Sales Order. Ordered: %; already delivered: %. A customer receives what they ordered; more is a new order, not a larger delivery (blueprint 7.7).',
      NEW.quantity, v_item, coalesce(v_ordered, 0), v_delivered
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER delivery_note_line_within_ordered
  AFTER INSERT OR UPDATE ON delivery_note_line
  FOR EACH ROW EXECUTE FUNCTION delivery_note_line_within_ordered();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §21 — an attachment is not linked to a record until the malware scan says
-- `clean`.
--
-- The Proof of Delivery is where that matters most in this module: a signature
-- and a set of photos are files a driver uploaded from a phone, and they become
-- evidence in a dispute. Quarantined bytes are not evidence.
-- ---------------------------------------------------------------------------
-- The rule itself, as a function any module can call. Every table that links an
-- attachment asks the same question, and one that asked it slightly differently
-- would be the one that let the quarantined file through.
CREATE FUNCTION assert_attachment_clean(p_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
BEGIN
  SELECT scan_status::text INTO v_status FROM attachment WHERE id = p_id;

  IF v_status IS DISTINCT FROM 'clean' THEN
    RAISE EXCEPTION
      'Attachment % is %, and only a clean attachment may be linked to a record (blueprint 21).',
      p_id, coalesce(v_status, 'missing')
      USING ERRCODE = 'restrict_violation';
  END IF;
END;
$$;--> statement-breakpoint

COMMENT ON FUNCTION assert_attachment_clean(uuid) IS
  'Blueprint 21: an attachment is not linked to a record until the malware scan says clean.';--> statement-breakpoint

-- Two thin triggers rather than one clever one: PL/pgSQL resolves every field
-- reference in a function body when it compiles, so a single function that
-- switched on TG_TABLE_NAME would fail on whichever column the *other* table
-- lacks — regardless of which branch runs.
CREATE FUNCTION proof_of_delivery_signature_is_clean() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_attachment_clean(NEW.signature_attachment_id);
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE FUNCTION proof_of_delivery_photo_is_clean() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_attachment_clean(NEW.attachment_id);
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER proof_of_delivery_signature_is_clean
  BEFORE INSERT OR UPDATE ON proof_of_delivery
  FOR EACH ROW EXECUTE FUNCTION proof_of_delivery_signature_is_clean();--> statement-breakpoint

CREATE TRIGGER proof_of_delivery_photo_is_clean
  BEFORE INSERT OR UPDATE ON proof_of_delivery_photo
  FOR EACH ROW EXECUTE FUNCTION proof_of_delivery_photo_is_clean();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 06.5 gate — *"Proof of Delivery captures all four elements."*
--
-- §7.2: "Proof of Delivery shall capture recipient name, signature, attachments
-- and delivery photos." The name and the signature are NOT NULL columns above;
-- this is the third, which a column cannot express because a photo is a row.
--
-- On the Delivered transition rather than on the POD row, because the photos are
-- inserted after the row they hang off. Read literally, as the clause is written:
-- if the company needs to accept a delivery with no photograph, that is a change
-- request under 28.1 rather than a check quietly left out here.
-- ---------------------------------------------------------------------------
CREATE FUNCTION delivery_note_proved_before_delivered() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_pod    uuid;
  v_photos integer;
BEGIN
  IF NEW.status <> 'executed' OR OLD.status = 'executed' THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_pod FROM proof_of_delivery WHERE delivery_note_id = NEW.id;

  IF v_pod IS NULL THEN
    RAISE EXCEPTION
      'Delivery Note % has no Proof of Delivery. Blueprint 7.2 requires the recipient name, their signature and delivery photos to be captured; a delivery that cannot be proved is one the customer can deny receiving.',
      NEW.delivery_note_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT count(*) INTO v_photos FROM proof_of_delivery_photo WHERE proof_of_delivery_id = v_pod;

  IF v_photos < 1 THEN
    RAISE EXCEPTION
      'Delivery Note % has no delivery photo. Blueprint 7.2 requires delivery photos as part of the Proof of Delivery.',
      NEW.delivery_note_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER delivery_note_proved_before_delivered
  BEFORE UPDATE ON delivery_note
  FOR EACH ROW EXECUTE FUNCTION delivery_note_proved_before_delivered();--> statement-breakpoint

-- Numbering, document type, statuses and permissions.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('DELIVERY_NOTE', 'DN', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('delivery_note', 'Delivery Note', 'sales',
   'Goods issue to a customer against a picked Sales Order. Posts Dr COGS / Cr Inventory at FIFO cost when delivered, and its date is the date the A/R Invoice must carry (blueprint 7.4).');--> statement-breakpoint

-- Appendix B gives four states and no Cancelled: once stock has moved, the
-- correction is a reversal.
INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('delivery_note', 'draft',    'approved'),
  ('delivery_note', 'approved', 'draft'),
  ('delivery_note', 'approved', 'executed'),
  ('delivery_note', 'executed', 'reversed');--> statement-breakpoint

INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('delivery_note', 'pick_list_id',
   'Decides which units are in the van. Changing it after approval would put a different sheet''s serials on the customer''s note.'),
  ('delivery_note', 'delivery_date',
   'Blueprint 7.4 forces the A/R Invoice onto this date, so it decides the accounting period of the sale.'),
  ('delivery_note', 'sales_order_id',
   'Decides whose reservation is drawn down and whose order the delivery reconciles to.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Appendix B gives the Delivery Note to Warehouse/Sales jointly. The verbs are
-- what matter: 'approve' releases it for dispatch, 'execute' marks it delivered
-- and posts. As elsewhere, the named business roles are an administrator's
-- configuration under blueprint 5.2, not something a migration decides.
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'delivery_note', 'view'),
  ('accounting_officer', 'delivery_note', 'create'),
  ('accounting_officer', 'delivery_note', 'edit_draft'),
  ('accounting_officer', 'delivery_note', 'print'),
  ('accounting_manager', 'delivery_note', 'view'),
  ('accounting_manager', 'delivery_note', 'create'),
  ('accounting_manager', 'delivery_note', 'edit_draft'),
  ('accounting_manager', 'delivery_note', 'approve'),
  ('accounting_manager', 'delivery_note', 'execute'),
  ('accounting_manager', 'delivery_note', 'reverse_cancel'),
  ('accounting_manager', 'delivery_note', 'configure'),
  ('accounting_manager', 'delivery_note', 'print'),
  ('accounting_manager', 'delivery_note', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist - grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON delivery_note, delivery_note_line, delivery_note_line_unit,
                proof_of_delivery, proof_of_delivery_photo FROM erp_app;

  -- No DELETE on the note or its proof: blueprint 1.1 keeps saved documents, and a
  -- Proof of Delivery that could be deleted is evidence that could be withdrawn.
  GRANT SELECT, INSERT, UPDATE ON delivery_note TO erp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON delivery_note_line TO erp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON delivery_note_line_unit TO erp_app;
  GRANT SELECT, INSERT ON proof_of_delivery TO erp_app;
  GRANT SELECT, INSERT ON proof_of_delivery_photo TO erp_app;
END;
$$;--> statement-breakpoint

-- D10 — the branch boundary. The note carries its own branch; everything under
-- it reads the note's, the way 0043 does elsewhere.
ALTER TABLE delivery_note ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE delivery_note FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY delivery_note_branch_scope ON delivery_note
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

ALTER TABLE delivery_note_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE delivery_note_line FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY delivery_note_line_branch_scope ON delivery_note_line
  USING (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM delivery_note d
       WHERE d.id = delivery_note_line.delivery_note_id
         AND app_branch_allowed(d.branch_code)
    )
  )
  WITH CHECK (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM delivery_note d
       WHERE d.id = delivery_note_line.delivery_note_id
         AND app_branch_allowed(d.branch_code)
    )
  );--> statement-breakpoint

ALTER TABLE delivery_note_line_unit ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE delivery_note_line_unit FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY delivery_note_line_unit_branch_scope ON delivery_note_line_unit
  USING (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM delivery_note_line l
        JOIN delivery_note d ON d.id = l.delivery_note_id
       WHERE l.id = delivery_note_line_unit.delivery_note_line_id
         AND app_branch_allowed(d.branch_code)
    )
  )
  WITH CHECK (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM delivery_note_line l
        JOIN delivery_note d ON d.id = l.delivery_note_id
       WHERE l.id = delivery_note_line_unit.delivery_note_line_id
         AND app_branch_allowed(d.branch_code)
    )
  );--> statement-breakpoint

ALTER TABLE proof_of_delivery ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE proof_of_delivery FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY proof_of_delivery_branch_scope ON proof_of_delivery
  USING (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM delivery_note d
       WHERE d.id = proof_of_delivery.delivery_note_id
         AND app_branch_allowed(d.branch_code)
    )
  )
  WITH CHECK (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM delivery_note d
       WHERE d.id = proof_of_delivery.delivery_note_id
         AND app_branch_allowed(d.branch_code)
    )
  );--> statement-breakpoint

ALTER TABLE proof_of_delivery_photo ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE proof_of_delivery_photo FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY proof_of_delivery_photo_branch_scope ON proof_of_delivery_photo
  USING (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM proof_of_delivery p
        JOIN delivery_note d ON d.id = p.delivery_note_id
       WHERE p.id = proof_of_delivery_photo.proof_of_delivery_id
         AND app_branch_allowed(d.branch_code)
    )
  )
  WITH CHECK (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM proof_of_delivery p
        JOIN delivery_note d ON d.id = p.delivery_note_id
       WHERE p.id = proof_of_delivery_photo.proof_of_delivery_id
         AND app_branch_allowed(d.branch_code)
    )
  );--> statement-breakpoint

-- Append-only evidence. Blueprint 5.4 and 24: a Proof of Delivery is what the
-- company shows when a customer says the goods never arrived, so it may be
-- added to and never edited or removed. The grants above already withhold
-- UPDATE and DELETE from the application role; this refuses them to everyone,
-- including a migration or a direct connection as the owner.
CREATE TRIGGER proof_of_delivery_append_only
  BEFORE UPDATE OR DELETE ON proof_of_delivery
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();--> statement-breakpoint

CREATE TRIGGER proof_of_delivery_photo_append_only
  BEFORE UPDATE OR DELETE ON proof_of_delivery_photo
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
