CREATE TABLE "pick_list" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pick_list_no" text NOT NULL,
	"status" "document_status" DEFAULT 'draft' NOT NULL,
	"sales_order_id" uuid NOT NULL,
	"warehouse_code" text NOT NULL,
	"branch_code" text NOT NULL,
	"pick_date" date NOT NULL,
	"assigned_to" uuid,
	"note" text,
	"created_by" uuid NOT NULL,
	"released_by" uuid,
	"released_at" timestamp with time zone,
	"picked_by" uuid,
	"picked_at" timestamp with time zone,
	"completed_by" uuid,
	"completed_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pick_list_cancellation_has_reason" CHECK (("pick_list"."cancelled_by" is null and "pick_list"."cancelled_at" is null)
          or ("pick_list"."cancelled_by" is not null and "pick_list"."cancelled_at" is not null
              and coalesce(btrim("pick_list"."cancellation_reason"), '') <> '')),
	CONSTRAINT "pick_list_stamps_in_order" CHECK (("pick_list"."picked_at" is null or "pick_list"."released_at" is not null)
          and ("pick_list"."picked_at" is null or "pick_list"."released_at" <= "pick_list"."picked_at")
          and ("pick_list"."completed_at" is null or "pick_list"."picked_at" is not null)
          and ("pick_list"."completed_at" is null or "pick_list"."picked_at" <= "pick_list"."completed_at"))
);
--> statement-breakpoint
CREATE TABLE "pick_list_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pick_list_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"sales_order_line_id" uuid NOT NULL,
	"item_code" text NOT NULL,
	"description" text NOT NULL,
	"uom_code" text NOT NULL,
	"requested_quantity" numeric(24, 6) NOT NULL,
	"picked_quantity" numeric(24, 6) DEFAULT '0' NOT NULL,
	"shortfall_reason" text,
	CONSTRAINT "pick_list_line_requested_positive" CHECK ("pick_list_line"."requested_quantity" > 0),
	CONSTRAINT "pick_list_line_picked_within_request" CHECK ("pick_list_line"."picked_quantity" >= 0 and "pick_list_line"."picked_quantity" <= "pick_list_line"."requested_quantity")
);
--> statement-breakpoint
CREATE TABLE "pick_list_line_unit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pick_list_line_id" uuid NOT NULL,
	"serial_number" text,
	"batch_number" text,
	"cost_layer_id" uuid,
	"quantity" numeric(24, 6) NOT NULL,
	CONSTRAINT "pick_list_line_unit_quantity_positive" CHECK ("pick_list_line_unit"."quantity" > 0),
	CONSTRAINT "pick_list_line_unit_identifies_something" CHECK (coalesce(btrim("pick_list_line_unit"."serial_number"), '') <> '' or coalesce(btrim("pick_list_line_unit"."batch_number"), '') <> ''),
	CONSTRAINT "pick_list_line_unit_serial_is_one" CHECK ("pick_list_line_unit"."serial_number" is null or "pick_list_line_unit"."quantity" = 1)
);
--> statement-breakpoint
ALTER TABLE "pick_list" ADD CONSTRAINT "pick_list_sales_order_id_sales_order_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_list" ADD CONSTRAINT "pick_list_warehouse_code_warehouse_code_fk" FOREIGN KEY ("warehouse_code") REFERENCES "public"."warehouse"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_list" ADD CONSTRAINT "pick_list_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_list" ADD CONSTRAINT "pick_list_assigned_to_app_user_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_list" ADD CONSTRAINT "pick_list_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_list" ADD CONSTRAINT "pick_list_released_by_app_user_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_list" ADD CONSTRAINT "pick_list_picked_by_app_user_id_fk" FOREIGN KEY ("picked_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_list" ADD CONSTRAINT "pick_list_completed_by_app_user_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_list" ADD CONSTRAINT "pick_list_cancelled_by_app_user_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_list_line" ADD CONSTRAINT "pick_list_line_pick_list_id_pick_list_id_fk" FOREIGN KEY ("pick_list_id") REFERENCES "public"."pick_list"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_list_line" ADD CONSTRAINT "pick_list_line_sales_order_line_id_sales_order_line_id_fk" FOREIGN KEY ("sales_order_line_id") REFERENCES "public"."sales_order_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_list_line" ADD CONSTRAINT "pick_list_line_item_code_item_code_fk" FOREIGN KEY ("item_code") REFERENCES "public"."item"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_list_line" ADD CONSTRAINT "pick_list_line_uom_code_unit_of_measure_code_fk" FOREIGN KEY ("uom_code") REFERENCES "public"."unit_of_measure"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pick_list_line_unit" ADD CONSTRAINT "pick_list_line_unit_pick_list_line_id_pick_list_line_id_fk" FOREIGN KEY ("pick_list_line_id") REFERENCES "public"."pick_list_line"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pick_list_no_uniq" ON "pick_list" USING btree ("pick_list_no");--> statement-breakpoint
CREATE INDEX "pick_list_order_idx" ON "pick_list" USING btree ("sales_order_id","status");--> statement-breakpoint
CREATE INDEX "pick_list_warehouse_idx" ON "pick_list" USING btree ("warehouse_code","status");--> statement-breakpoint
CREATE UNIQUE INDEX "pick_list_line_no_uniq" ON "pick_list_line" USING btree ("pick_list_id","line_no");--> statement-breakpoint
CREATE UNIQUE INDEX "pick_list_line_order_line_uniq" ON "pick_list_line" USING btree ("pick_list_id","sales_order_line_id");--> statement-breakpoint
CREATE INDEX "pick_list_line_item_idx" ON "pick_list_line" USING btree ("item_code");--> statement-breakpoint
CREATE INDEX "pick_list_line_unit_line_idx" ON "pick_list_line_unit" USING btree ("pick_list_line_id");--> statement-breakpoint
CREATE INDEX "pick_list_line_unit_serial_idx" ON "pick_list_line_unit" USING btree ("serial_number") WHERE "pick_list_line_unit"."serial_number" is not null;--> statement-breakpoint
CREATE INDEX "pick_list_line_unit_batch_idx" ON "pick_list_line_unit" USING btree ("batch_number") WHERE "pick_list_line_unit"."batch_number" is not null;
-- ===========================================================================
-- Phase 06.4 — Pick List (§7.2, Appendix B: effect **Operational**)
--
-- The step between a commitment and a movement. Nothing has moved: the stock is
-- on the shelf, owned by the company, reserved to the same order. What changed
-- is that somebody knows which units to take.
--
-- **The first gate is met by absence.** *"Pick List creates no accounting entry
-- and no stock movement"* — there is no journal_entry_id column and no
-- movement column on any of the three tables above, so a service that wanted to
-- post one would have nowhere to record it. The test that asserts no journal
-- and no movement row appears is checking the consequence; the tables are the
-- cause.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- §7.2 — a pick list serves one order, in one warehouse, and every line on it
-- belongs to that order and that warehouse.
--
-- Three facts that the foreign keys almost express and do not quite: the FK
-- says the order line exists, not that it is on *this* pick list's order. A
-- sheet that mixed two orders would draw down a reservation the picker was
-- never told about.
-- ---------------------------------------------------------------------------
CREATE FUNCTION pick_list_line_belongs_to_the_sheet() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_sheet_order    uuid;
  v_sheet_house    text;
  v_line_order     uuid;
  v_line_house     text;
  v_line_item      text;
  v_sheet_no       text;
BEGIN
  SELECT sales_order_id, warehouse_code, pick_list_no
    INTO v_sheet_order, v_sheet_house, v_sheet_no
    FROM pick_list WHERE id = NEW.pick_list_id;

  SELECT sales_order_id, warehouse_code, item_code
    INTO v_line_order, v_line_house, v_line_item
    FROM sales_order_line WHERE id = NEW.sales_order_line_id;

  IF v_line_order IS DISTINCT FROM v_sheet_order THEN
    RAISE EXCEPTION
      'Pick list % draws on one Sales Order, and this line belongs to another. A pick draws down the reservation of the order it names (blueprint 7.4).',
      v_sheet_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF v_line_house IS DISTINCT FROM v_sheet_house THEN
    RAISE EXCEPTION
      '% is delivered from %, but pick list % is for %. A picker walks one building, so an order spanning warehouses is picked on one sheet per warehouse (blueprint 7.2).',
      v_line_item, v_line_house, v_sheet_no, v_sheet_house
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- The item and unit are copied onto the sheet for the picker to read. Copied
  -- wrongly, the picker fetches the wrong thing and every downstream document
  -- inherits it, so the copy is checked rather than trusted.
  IF NEW.item_code IS DISTINCT FROM v_line_item THEN
    RAISE EXCEPTION
      'Pick list line names % but Sales Order line is for %. The item is copied from the order, not chosen at the pick.',
      NEW.item_code, v_line_item
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER pick_list_line_belongs_to_the_sheet
  BEFORE INSERT OR UPDATE ON pick_list_line
  FOR EACH ROW EXECUTE FUNCTION pick_list_line_belongs_to_the_sheet();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 06.4 gate — *"Picked quantity cannot exceed the reserved quantity."*
--
-- Judged cumulatively across every pick list raised against the same order
-- line, and in the database as well as in `domain/picking.ts`, because §7.7
-- says the sales controls "cannot be bypassed through the UI or API" and an
-- import writes rows by neither route.
--
-- A cancelled sheet does not count: those units went back on the shelf.
-- ---------------------------------------------------------------------------
CREATE FUNCTION pick_list_line_within_reservation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_reserved  numeric(24,6);
  v_claimed   numeric(24,6);
  v_item      text;
BEGIN
  SELECT reserved_quantity, item_code INTO v_reserved, v_item
    FROM sales_order_line WHERE id = NEW.sales_order_line_id;

  -- What every *other* live sheet has claimed, plus what this row claims.
  SELECT coalesce(sum(greatest(l.picked_quantity, l.requested_quantity)), 0)
    INTO v_claimed
    FROM pick_list_line l
    JOIN pick_list p ON p.id = l.pick_list_id
   WHERE l.sales_order_line_id = NEW.sales_order_line_id
     AND l.id <> NEW.id
     AND p.status <> 'cancelled';

  v_claimed := v_claimed + greatest(NEW.picked_quantity, NEW.requested_quantity);

  IF v_claimed > coalesce(v_reserved, 0) THEN
    RAISE EXCEPTION
      'Picking % of % would exceed the stock reserved for this order. Reserved: %; claimed by pick lists including this one: %. Reserve more stock on the Sales Order, or pick the quantity that is reserved (blueprint 7.4).',
      NEW.picked_quantity, v_item, coalesce(v_reserved, 0), v_claimed
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER pick_list_line_within_reservation
  AFTER INSERT OR UPDATE ON pick_list_line
  FOR EACH ROW EXECUTE FUNCTION pick_list_line_within_reservation();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 06.4 gate — *"Serial/batch selection at pick is carried through to the
-- Delivery Note."*
--
-- Carrying something through means it was complete when captured, so the
-- completeness is checked when the sheet becomes Picked rather than when the
-- Delivery Note reads it. A Delivery Note that discovered a missing serial
-- would be rejecting a document the warehouse has already acted on.
--
-- On the header rather than the line, because a line is written before its
-- units are: a per-row check would refuse the first insert of every tracked
-- pick.
-- ---------------------------------------------------------------------------
CREATE FUNCTION pick_list_identities_complete() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r record;
BEGIN
  IF NEW.status <> 'executed' OR OLD.status = 'executed' THEN
    RETURN NEW;
  END IF;

  FOR r IN
    SELECT l.item_code,
           l.picked_quantity,
           i.tracking::text                              AS tracking,
           coalesce(sum(u.quantity), 0)                  AS identified,
           count(u.id) FILTER (WHERE u.serial_number IS NULL) AS without_serial,
           count(u.id) FILTER (WHERE u.batch_number  IS NULL) AS without_batch
      FROM pick_list_line l
      JOIN item i ON i.code = l.item_code
      LEFT JOIN pick_list_line_unit u ON u.pick_list_line_id = l.id
     WHERE l.pick_list_id = NEW.id
     GROUP BY l.id, l.item_code, l.picked_quantity, i.tracking
  LOOP
    IF r.tracking IS NULL THEN
      IF r.identified > 0 THEN
        RAISE EXCEPTION
          '% is not tracked by serial or batch, so no units can be selected for it.',
          r.item_code
          USING ERRCODE = 'restrict_violation';
      END IF;
      CONTINUE;
    END IF;

    IF r.identified <> r.picked_quantity THEN
      RAISE EXCEPTION
        'The selections for % account for % but % was picked. Every unit of a tracked item is identified at the pick, because the Delivery Note carries the selection through and blueprint 9.9 traces it from receipt to delivery.',
        r.item_code, r.identified, r.picked_quantity
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- A serial_and_batch item needs both on every row, and the table check only
    -- insists on one of the two - it cannot see which item the row is for.
    IF r.tracking IN ('serial', 'serial_and_batch') AND r.without_serial > 0 THEN
      RAISE EXCEPTION
        '% is tracked by serial, and % picked row(s) name none.',
        r.item_code, r.without_serial
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF r.tracking IN ('batch', 'serial_and_batch') AND r.without_batch > 0 THEN
      RAISE EXCEPTION
        '% is tracked by batch, and % picked row(s) name none.',
        r.item_code, r.without_batch
        USING ERRCODE = 'restrict_violation';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER pick_list_identities_complete
  BEFORE UPDATE ON pick_list
  FOR EACH ROW EXECUTE FUNCTION pick_list_identities_complete();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §9.9 — one physical unit is picked once.
--
-- A serial on two live pick lists is two customers promised the same object.
-- Unique across sheets rather than within one, because within one the line
-- constraint would already have caught it and across sheets is where the
-- mistake actually happens.
-- ---------------------------------------------------------------------------
CREATE FUNCTION pick_list_serial_picked_once() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_other text;
BEGIN
  IF NEW.serial_number IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT p.pick_list_no INTO v_other
    FROM pick_list_line_unit u
    JOIN pick_list_line l ON l.id = u.pick_list_line_id
    JOIN pick_list p      ON p.id = l.pick_list_id
   WHERE u.serial_number = NEW.serial_number
     AND u.id <> NEW.id
     AND p.status NOT IN ('cancelled', 'closed')
   LIMIT 1;

  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION
      'Serial % is already picked on %. One physical unit cannot be promised to two customers (blueprint 9.9).',
      NEW.serial_number, v_other
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER pick_list_serial_picked_once
  BEFORE INSERT OR UPDATE ON pick_list_line_unit
  FOR EACH ROW EXECUTE FUNCTION pick_list_serial_picked_once();--> statement-breakpoint

-- Numbering, document type, statuses and permissions.
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('PICK_LIST', 'PICK', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('pick_list', 'Pick List', 'sales',
   'Tells the warehouse which units to take against a Sales Order, and records which ones were taken. Effect: operational only - no accounting entry and no stock movement (Appendix B).');--> statement-breakpoint

-- Appendix B: Draft, Released, Picked, Completed, Cancelled - onto section 3.2's
-- shared vocabulary. No partial state, because Appendix B gives it none: a short
-- pick is still Picked, and the shortfall is a quantity on the line.
INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('pick_list', 'draft',     'approved'),
  ('pick_list', 'draft',     'cancelled'),
  ('pick_list', 'approved',  'executed'),
  ('pick_list', 'approved',  'cancelled'),
  ('pick_list', 'executed',  'closed'),
  ('pick_list', 'executed',  'cancelled');--> statement-breakpoint

INSERT INTO document_type_controlled_field (document_type_code, field_name, note) VALUES
  ('pick_list', 'sales_order_id',
   'Decides whose reservation is drawn down. Changing it after release would send a picker for another customer''s stock.'),
  ('pick_list', 'warehouse_code',
   'Decides which building the job is in, and which branch owns the sheet.')
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Section 7.2 gives the Pick List to Warehouse, and section 5.2 makes who holds
-- which role a configuration question rather than a code one. The build has two
-- seeded roles - Accounting Officer and Accounting Manager - and every module so
-- far grants to those; a "Warehouse Manager" role is created by an administrator
-- through the role screen, and is handed exactly these verbs. Seeding one here
-- would be choosing the company's org chart in a migration.
--
-- The separation that matters is between the verbs, not the role names: whoever
-- releases a sheet holds 'approve', whoever picks it holds 'execute', and the
-- two need not be the same person.
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'pick_list', 'view'),
  ('accounting_officer', 'pick_list', 'create'),
  ('accounting_officer', 'pick_list', 'edit_draft'),
  ('accounting_officer', 'pick_list', 'execute'),
  ('accounting_officer', 'pick_list', 'print'),
  ('accounting_manager', 'pick_list', 'view'),
  ('accounting_manager', 'pick_list', 'create'),
  ('accounting_manager', 'pick_list', 'edit_draft'),
  ('accounting_manager', 'pick_list', 'approve'),
  ('accounting_manager', 'pick_list', 'execute'),
  ('accounting_manager', 'pick_list', 'reverse_cancel'),
  ('accounting_manager', 'pick_list', 'configure'),
  ('accounting_manager', 'pick_list', 'print'),
  ('accounting_manager', 'pick_list', 'export')
ON CONFLICT DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist - grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON pick_list, pick_list_line, pick_list_line_unit FROM erp_app;

  -- No DELETE on the sheet: section 1.1 keeps saved documents. Lines and unit
  -- selections are rewritten while the sheet is being filled in, which is why
  -- those two carry DELETE and the header does not.
  GRANT SELECT, INSERT, UPDATE ON pick_list TO erp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON pick_list_line TO erp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON pick_list_line_unit TO erp_app;
END;
$$;--> statement-breakpoint

-- D10 — the branch boundary, on all three tables. The lines and units have no
-- branch of their own, so they read the sheet's, the way 0043 does elsewhere.
ALTER TABLE pick_list ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE pick_list FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY pick_list_branch_scope ON pick_list
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

ALTER TABLE pick_list_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE pick_list_line FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY pick_list_line_branch_scope ON pick_list_line
  USING (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM pick_list p
       WHERE p.id = pick_list_line.pick_list_id
         AND app_branch_allowed(p.branch_code)
    )
  )
  WITH CHECK (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM pick_list p
       WHERE p.id = pick_list_line.pick_list_id
         AND app_branch_allowed(p.branch_code)
    )
  );--> statement-breakpoint

ALTER TABLE pick_list_line_unit ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE pick_list_line_unit FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY pick_list_line_unit_branch_scope ON pick_list_line_unit
  USING (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM pick_list_line l
        JOIN pick_list p ON p.id = l.pick_list_id
       WHERE l.id = pick_list_line_unit.pick_list_line_id
         AND app_branch_allowed(p.branch_code)
    )
  )
  WITH CHECK (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM pick_list_line l
        JOIN pick_list p ON p.id = l.pick_list_id
       WHERE l.id = pick_list_line_unit.pick_list_line_id
         AND app_branch_allowed(p.branch_code)
    )
  );
