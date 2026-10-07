-- ===========================================================================
-- Manual Stock Addition (2026-10-06, by direction: "manually adding items in
-- warehouse report sometimes it's needed … to which warehouse, quantity, stock
-- price and unit of it, and note for audit … needs approval too; if superadmin
-- no need — draft → approval"). HAND-AUTHORED. Everything additive.
--
-- A document that puts stock found or brought in without a purchase onto the
-- books: one warehouse, lines of item / unit / quantity / unit cost, and the
-- reason it is being added. Draft → Submitted → Approved by somebody other than
-- whoever raised or sent it (a super user alone excepted, as 0278 made every
-- four-eyes check); Rejected (with its reason) goes back to draft; a draft or a
-- rejected one is cancelled with its reason. Approval receives each line into
-- the warehouse at its cost per base unit (one FIFO layer each) and posts one
-- journal: Dr each item's inventory account / Cr the inventory adjustment role,
-- or the account the sheet named (`services/manual-stock-addition.ts`).
--
-- Never deleted; its lines are frozen once it leaves draft.
-- ===========================================================================

CREATE TABLE "manual_stock_addition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	-- MSA-{BRANCH}-{YYYY}-{SERIAL}.
	"addition_no" text NOT NULL,
	"status" "document_status" NOT NULL DEFAULT 'draft',
	"branch_code" text NOT NULL REFERENCES "branch"("code"),
	"warehouse_code" text NOT NULL REFERENCES "warehouse"("code"),
	"posting_date" date NOT NULL,
	-- Why the stock is being added — the note the audit keeps. Required.
	"reason" text NOT NULL,
	-- The account the value is credited to; null = the inventory adjustment mapping.
	"offset_account_id" uuid REFERENCES "chart_of_account"("id"),
	"created_by" uuid NOT NULL REFERENCES "app_user"("id"),
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"submitted_by" uuid REFERENCES "app_user"("id"),
	"submitted_at" timestamptz,
	"approved_by" uuid REFERENCES "app_user"("id"),
	"approved_at" timestamptz,
	"rejected_by" uuid REFERENCES "app_user"("id"),
	"rejected_at" timestamptz,
	"rejection_reason" text,
	"cancelled_by" uuid REFERENCES "app_user"("id"),
	"cancelled_at" timestamptz,
	"cancellation_reason" text,
	"journal_entry_id" uuid REFERENCES "journal_entry"("id"),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "manual_stock_addition_status_known" CHECK (
		"status" IN ('draft', 'submitted', 'approved', 'rejected', 'cancelled')
	),
	CONSTRAINT "manual_stock_addition_reason_given" CHECK (btrim("reason") <> ''),
	CONSTRAINT "manual_stock_addition_rejected_has_reason" CHECK (
		"status" <> 'rejected' OR coalesce(btrim("rejection_reason"), '') <> ''
	),
	CONSTRAINT "manual_stock_addition_cancelled_has_reason" CHECK (
		"status" <> 'cancelled' OR coalesce(btrim("cancellation_reason"), '') <> ''
	),
	-- Approval is the posting: an approved addition names its journal.
	CONSTRAINT "manual_stock_addition_approved_posted" CHECK (
		"status" <> 'approved' OR ("journal_entry_id" IS NOT NULL AND "approved_by" IS NOT NULL)
	),
	-- Four eyes: not whoever raised it, nor whoever sent it — a super user alone excepted (0278).
	CONSTRAINT "manual_stock_addition_four_eyes" CHECK (
		"approved_by" IS NULL
		OR app_user_is_super("approved_by")
		OR ("approved_by" <> "created_by" AND "approved_by" IS DISTINCT FROM "submitted_by")
	)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "manual_stock_addition_no_uniq" ON "manual_stock_addition" ("addition_no");
--> statement-breakpoint
CREATE INDEX "manual_stock_addition_status_idx" ON "manual_stock_addition" ("status", "branch_code");
--> statement-breakpoint
CREATE INDEX "manual_stock_addition_recent_idx" ON "manual_stock_addition" ("posting_date" DESC, "addition_no" DESC);
--> statement-breakpoint

CREATE TABLE "manual_stock_addition_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"addition_id" uuid NOT NULL REFERENCES "manual_stock_addition"("id"),
	"line_no" integer NOT NULL,
	"item_code" text NOT NULL REFERENCES "item"("code"),
	-- The unit the line was written in; stock is received in the item's base unit.
	"uom_code" text NOT NULL REFERENCES "unit_of_measure"("code"),
	"quantity" numeric(24, 6) NOT NULL,
	-- The stock price: IQD for one of the line's unit.
	"unit_cost_iqd" numeric(19, 4) NOT NULL,
	"line_value_iqd" numeric(19, 4) NOT NULL,
	-- Written by the approval: the quantity in the base unit, the cost of one base unit, the movement.
	"base_quantity" numeric(24, 6),
	"base_unit_cost_iqd" numeric(19, 4),
	"movement_id" uuid REFERENCES "inventory_movement"("id"),
	CONSTRAINT "manual_stock_addition_line_quantity_positive" CHECK ("quantity" > 0),
	CONSTRAINT "manual_stock_addition_line_cost_positive" CHECK ("unit_cost_iqd" > 0),
	CONSTRAINT "manual_stock_addition_line_value_is_product" CHECK ("line_value_iqd" = round("quantity" * "unit_cost_iqd", 4))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "manual_stock_addition_line_no_uniq" ON "manual_stock_addition_line" ("addition_id", "line_no");
--> statement-breakpoint
CREATE INDEX "manual_stock_addition_line_item_idx" ON "manual_stock_addition_line" ("item_code");
--> statement-breakpoint

-- The document's road, and what it says once it has left draft.
CREATE FUNCTION manual_stock_addition_guard() RETURNS trigger
	LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.status IN ('approved', 'cancelled') THEN
		RAISE EXCEPTION 'Manual stock addition % is %; it does not change again.', OLD.addition_no, OLD.status
			USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
		(OLD.status = 'draft' AND NEW.status IN ('submitted', 'cancelled'))
		OR (OLD.status = 'submitted' AND NEW.status IN ('approved', 'rejected'))
		OR (OLD.status = 'rejected' AND NEW.status IN ('draft', 'cancelled'))
	) THEN
		RAISE EXCEPTION 'Manual stock addition % cannot go from % to %.', OLD.addition_no, OLD.status, NEW.status
			USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.addition_no IS DISTINCT FROM OLD.addition_no
		OR NEW.branch_code IS DISTINCT FROM OLD.branch_code
		OR NEW.created_by IS DISTINCT FROM OLD.created_by
		OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'Manual stock addition %: its number, branch and author never change.', OLD.addition_no
			USING ERRCODE = 'check_violation';
	END IF;
	IF OLD.status <> 'draft' AND (
		NEW.warehouse_code IS DISTINCT FROM OLD.warehouse_code
		OR NEW.posting_date IS DISTINCT FROM OLD.posting_date
		OR NEW.reason IS DISTINCT FROM OLD.reason
		OR NEW.offset_account_id IS DISTINCT FROM OLD.offset_account_id
	) THEN
		RAISE EXCEPTION 'Manual stock addition % is %; what it says is changed only in draft.', OLD.addition_no, OLD.status
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "manual_stock_addition_guard"
	BEFORE UPDATE ON "manual_stock_addition"
	FOR EACH ROW EXECUTE FUNCTION manual_stock_addition_guard();
--> statement-breakpoint
-- Never deleted: a mistaken one is cancelled with its reason.
CREATE TRIGGER "manual_stock_addition_no_delete"
	BEFORE DELETE ON "manual_stock_addition"
	FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint

-- The lines are written, changed and removed in draft only. The approval writes
-- each line's movement and base-unit figures once, while it is still submitted.
CREATE FUNCTION manual_stock_addition_line_frozen() RETURNS trigger
	LANGUAGE plpgsql AS $$
DECLARE
	v_status document_status;
	v_no     text;
BEGIN
	SELECT status, addition_no INTO v_status, v_no
	  FROM manual_stock_addition
	 WHERE id = coalesce(NEW.addition_id, OLD.addition_id);

	IF TG_OP = 'UPDATE' AND NEW.addition_id IS DISTINCT FROM OLD.addition_id THEN
		RAISE EXCEPTION 'A line of manual stock addition % stays on its document.', v_no
			USING ERRCODE = 'check_violation';
	END IF;
	IF v_status = 'draft' THEN
		RETURN coalesce(NEW, OLD);
	END IF;
	IF TG_OP = 'UPDATE' AND v_status = 'submitted'
		AND OLD.movement_id IS NULL AND NEW.movement_id IS NOT NULL
		AND NEW.line_no = OLD.line_no AND NEW.item_code = OLD.item_code AND NEW.uom_code = OLD.uom_code
		AND NEW.quantity = OLD.quantity AND NEW.unit_cost_iqd = OLD.unit_cost_iqd
		AND NEW.line_value_iqd = OLD.line_value_iqd THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'Manual stock addition % is %; its lines are changed only in draft.', coalesce(v_no, '?'), coalesce(v_status::text, 'not visible')
		USING ERRCODE = 'check_violation';
END $$;
--> statement-breakpoint
CREATE TRIGGER "manual_stock_addition_line_frozen"
	BEFORE INSERT OR UPDATE OR DELETE ON "manual_stock_addition_line"
	FOR EACH ROW EXECUTE FUNCTION manual_stock_addition_line_frozen();
--> statement-breakpoint

INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year) VALUES
	('MANUAL_STOCK_ADDITION', 'MSA', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
	('manual_stock_addition', 'Manual Stock Addition', 'inventory',
	 'Stock put onto the books without a purchase: a warehouse, items, quantities, unit costs and the reason; approved by a second person.')
ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
	('manual_stock_addition', 'draft',     'submitted'),
	('manual_stock_addition', 'draft',     'cancelled'),
	('manual_stock_addition', 'submitted', 'approved'),
	('manual_stock_addition', 'submitted', 'rejected'),
	('manual_stock_addition', 'rejected',  'draft'),
	('manual_stock_addition', 'rejected',  'cancelled')
ON CONFLICT DO NOTHING;
--> statement-breakpoint

ALTER TABLE manual_stock_addition ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE manual_stock_addition FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY manual_stock_addition_branch_scope ON manual_stock_addition
	USING (app_branch_allowed(branch_code)) WITH CHECK (app_branch_allowed(branch_code));
--> statement-breakpoint
ALTER TABLE manual_stock_addition_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE manual_stock_addition_line FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY manual_stock_addition_line_branch_scope ON manual_stock_addition_line
	USING (
		app_is_super_user()
		OR EXISTS (SELECT 1 FROM manual_stock_addition d
		            WHERE d.id = manual_stock_addition_line.addition_id AND app_branch_allowed(d.branch_code))
	)
	WITH CHECK (
		app_is_super_user()
		OR EXISTS (SELECT 1 FROM manual_stock_addition d
		            WHERE d.id = manual_stock_addition_line.addition_id AND app_branch_allowed(d.branch_code))
	);
--> statement-breakpoint

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
		RAISE WARNING 'Role erp_app does not exist — grants skipped.';
		RETURN;
	END IF;
	-- No DELETE on the document: it is cancelled. A draft's lines are replaced (the trigger keeps that to drafts).
	GRANT SELECT, INSERT, UPDATE ON manual_stock_addition TO erp_app;
	GRANT SELECT, INSERT, UPDATE, DELETE ON manual_stock_addition_line TO erp_app;
END;
$$;
--> statement-breakpoint

-- Whoever keeps opening stock keeps manual additions: the officer raises and
-- sends them, the manager approves (and posts) them; both print, the manager exports.
INSERT INTO role_grant (role_code, object, verb)
SELECT DISTINCT g.role_code, 'manual_stock_addition', g.verb
  FROM role_grant g
 WHERE g.object = 'opening_stock'
   AND g.verb IN ('view', 'create', 'edit_draft', 'submit', 'approve', 'print', 'export')
ON CONFLICT DO NOTHING;
