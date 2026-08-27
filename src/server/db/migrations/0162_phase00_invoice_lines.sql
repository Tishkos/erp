-- Phase 00 — an invoice is a list of things, not a number.
--
-- Migration 0160 gave the invoice a single amount, which was enough to
-- demonstrate numbering and approval and nothing else. A person raising a real
-- invoice enters what they are charging for, line by line, and the total is
-- something the system works out — never something anyone types, because a
-- typed total is a total that can disagree with its own lines.
--
-- So: the lines are the truth, `invoice.amount` is their sum, and it is kept
-- that way by a trigger rather than by whoever remembers to.

CREATE TABLE invoice_line (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id    uuid NOT NULL REFERENCES invoice(id),
  line_no       integer NOT NULL,
  description   text NOT NULL,
  quantity      numeric(19,6) NOT NULL,
  unit_price    numeric(19,4) NOT NULL,
  -- Stored, not computed on read: what was charged is a fact about the
  -- invoice at the time, and a rounding rule that changes later must not
  -- silently restate it.
  line_total    numeric(19,4) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_line_no_uniq UNIQUE (invoice_id, line_no),
  CONSTRAINT invoice_line_description_present CHECK (length(btrim(description)) > 0),
  CONSTRAINT invoice_line_quantity_positive CHECK (quantity > 0),
  CONSTRAINT invoice_line_price_not_negative CHECK (unit_price >= 0),
  CONSTRAINT invoice_line_total_agrees CHECK (line_total = round(quantity * unit_price, 4))
);--> statement-breakpoint

CREATE INDEX invoice_line_invoice_idx ON invoice_line (invoice_id, line_no);--> statement-breakpoint

-- An invoice with no lines yet has no total. §7 still refuses to submit it —
-- that rule belongs in the service, where it can say why.
ALTER TABLE invoice DROP CONSTRAINT invoice_amount_positive;--> statement-breakpoint
ALTER TABLE invoice ADD CONSTRAINT invoice_amount_not_negative CHECK (amount >= 0);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The total is the sum of the lines, always.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION invoice_retotal() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_invoice uuid := COALESCE(NEW.invoice_id, OLD.invoice_id);
BEGIN
  UPDATE invoice
     SET amount     = COALESCE((SELECT sum(line_total) FROM invoice_line WHERE invoice_id = v_invoice), 0),
         updated_at = now()
   WHERE id = v_invoice;
  RETURN NULL;
END $$;--> statement-breakpoint

CREATE TRIGGER invoice_line_retotal
AFTER INSERT OR UPDATE OR DELETE ON invoice_line
FOR EACH ROW EXECUTE FUNCTION invoice_retotal();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Lines move only while the invoice is a draft.
--
-- §1.1 forbids deleting a *record*; a line of an unsubmitted draft is not yet
-- a record of anything — nobody has approved it and nothing refers to it. Once
-- the invoice leaves draft its lines are what was approved, and they are as
-- fixed as the invoice itself.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION invoice_line_draft_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status document_status;
BEGIN
  SELECT status INTO v_status FROM invoice WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION
      'The lines of an invoice can only be changed while it is a draft; this one is %.', v_status
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;--> statement-breakpoint

CREATE TRIGGER invoice_line_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON invoice_line
FOR EACH ROW EXECUTE FUNCTION invoice_line_draft_only();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A line is visible exactly when its invoice is (§21's rule, applied to rows).
-- ---------------------------------------------------------------------------
ALTER TABLE invoice_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE invoice_line FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY invoice_line_parent_scope ON invoice_line
  USING (
    EXISTS (
      SELECT 1 FROM invoice i
       WHERE i.id = invoice_line.invoice_id
         AND (app_is_super_user() OR app_branch_allowed(i.branch_code))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM invoice i
       WHERE i.id = invoice_line.invoice_id
         AND (app_is_super_user() OR app_branch_allowed(i.branch_code))
    )
  );--> statement-breakpoint

COMMENT ON POLICY invoice_line_parent_scope ON invoice_line IS
  'A line inherits the visibility of the invoice it belongs to; there is no rule of its own to get around.';--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON invoice_line TO erp_app;--> statement-breakpoint
