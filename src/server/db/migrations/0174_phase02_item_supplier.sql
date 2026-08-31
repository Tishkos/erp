-- ===========================================================================
-- Which suppliers an item can be bought from — Phase 2 requirement 4.
--
-- *"Each item can be linked to one or more suppliers, with one supplier
--   identified as the default supplier."*
--
-- HAND-AUTHORED, because two of the three rules here are not things Drizzle
-- models: a partial unique index and a trigger.
--
-- ── One default, enforced by the database ──────────────────────────────────
-- A partial unique index on (item_id) WHERE is_default. Two rows both claiming
-- to be the default is a state a purchase order cannot resolve — it would have
-- to pick one, and whichever it picked would be arbitrary. So it is a state
-- that cannot be written. Clearing the old default and setting the new one
-- happens in one statement in the service, inside one transaction, which is
-- why the index never sees the intermediate state.
--
-- ── Only a supplier can be a supplier ──────────────────────────────────────
-- The foreign key reaches business_partner, which holds customers too (§6 —
-- one record, two roles). A link to a customer who does not sell to us is
-- nonsense, and a foreign key cannot say so. The trigger can, and it also
-- catches the case the service cannot: a partner's supplier role being taken
-- away while links to it still exist.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS "item_supplier" (
  "item_id"            uuid NOT NULL,
  "supplier_id"        uuid NOT NULL,
  "supplier_item_code" text,
  "is_default"         boolean NOT NULL DEFAULT false,
  "active"             boolean NOT NULL DEFAULT true,
  "created_at"         timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "item_supplier_pk" PRIMARY KEY ("item_id", "supplier_id")
);--> statement-breakpoint

ALTER TABLE "item_supplier"
  ADD CONSTRAINT "item_supplier_item_id_item_id_fk"
  FOREIGN KEY ("item_id") REFERENCES "public"."item"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "item_supplier"
  ADD CONSTRAINT "item_supplier_supplier_id_business_partner_id_fk"
  FOREIGN KEY ("supplier_id") REFERENCES "public"."business_partner"("id")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- At most one default supplier per item.
CREATE UNIQUE INDEX IF NOT EXISTS "item_supplier_default_uniq"
  ON "item_supplier" USING btree ("item_id") WHERE "is_default";--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "item_supplier_supplier_idx"
  ON "item_supplier" USING btree ("supplier_id");--> statement-breakpoint

-- ── The partner on the other end must actually be a supplier ───────────────
CREATE OR REPLACE FUNCTION item_supplier_require_supplier_role() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_is_supplier boolean;
  v_name        text;
BEGIN
  SELECT is_supplier, legal_name INTO v_is_supplier, v_name
    FROM business_partner WHERE id = NEW.supplier_id;

  IF NOT COALESCE(v_is_supplier, false) THEN
    RAISE EXCEPTION
      '% is not a supplier. Give the partner the supplier role before linking an item to them (§6).',
      COALESCE(v_name, NEW.supplier_id::text)
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER item_supplier_require_supplier_role
  BEFORE INSERT OR UPDATE ON item_supplier
  FOR EACH ROW EXECUTE FUNCTION item_supplier_require_supplier_role();--> statement-breakpoint

-- ── And the role cannot be taken away while links depend on it ─────────────
CREATE OR REPLACE FUNCTION business_partner_supplier_role_in_use() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_items bigint;
BEGIN
  IF OLD.is_supplier AND NOT NEW.is_supplier THEN
    SELECT count(*) INTO v_items FROM item_supplier WHERE supplier_id = NEW.id;
    IF v_items > 0 THEN
      RAISE EXCEPTION
        '% is the named supplier for % item(s). Unlink them before removing the supplier role.',
        NEW.legal_name, v_items
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER business_partner_supplier_role_in_use
  BEFORE UPDATE ON business_partner
  FOR EACH ROW EXECUTE FUNCTION business_partner_supplier_role_in_use();--> statement-breakpoint

-- An item's suppliers are part of the item, and a link is removed rather than
-- deactivated when it was simply wrong — hence DELETE, which item_uom has too.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON item_supplier FROM erp_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON item_supplier TO erp_app;
END;
$$;
