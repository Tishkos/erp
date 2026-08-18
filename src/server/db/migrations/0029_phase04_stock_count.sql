CREATE TYPE "public"."stock_count_scope" AS ENUM('full', 'warehouse', 'item', 'category');--> statement-breakpoint
CREATE TYPE "public"."stock_count_status" AS ENUM('planned', 'counted', 'recount', 'pending_approval', 'adjusted', 'closed', 'cancelled');--> statement-breakpoint
CREATE TABLE "stock_count" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"count_no" text NOT NULL,
	"status" "stock_count_status" DEFAULT 'planned' NOT NULL,
	"branch_code" text NOT NULL,
	"warehouse_code" text NOT NULL,
	"scope" "stock_count_scope" NOT NULL,
	"scope_filter" text,
	"planned_on" date NOT NULL,
	"counted_on" date,
	"adjusted_on" date,
	"planned_by" uuid NOT NULL,
	"counted_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"approval_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_count_approval_has_reason" CHECK (("stock_count"."approved_by" is null and "stock_count"."approved_at" is null)
          or ("stock_count"."approved_by" is not null and "stock_count"."approved_at" is not null
              and coalesce(btrim("stock_count"."approval_reason"), '') <> ''))
);
--> statement-breakpoint
CREATE TABLE "stock_count_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stock_count_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"item_code" text NOT NULL,
	"system_quantity" numeric(24, 6) NOT NULL,
	"counted_quantity" numeric(24, 6),
	"recount_quantity" numeric(24, 6),
	"serial_number" text,
	"batch_number" text,
	"note" text,
	"movement_id" uuid,
	CONSTRAINT "stock_count_line_counted_not_negative" CHECK ("stock_count_line"."counted_quantity" is null or "stock_count_line"."counted_quantity" >= 0),
	CONSTRAINT "stock_count_line_recount_not_negative" CHECK ("stock_count_line"."recount_quantity" is null or "stock_count_line"."recount_quantity" >= 0)
);
--> statement-breakpoint
ALTER TABLE "stock_count" ADD CONSTRAINT "stock_count_branch_code_branch_code_fk" FOREIGN KEY ("branch_code") REFERENCES "public"."branch"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count" ADD CONSTRAINT "stock_count_warehouse_code_warehouse_code_fk" FOREIGN KEY ("warehouse_code") REFERENCES "public"."warehouse"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count" ADD CONSTRAINT "stock_count_planned_by_app_user_id_fk" FOREIGN KEY ("planned_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count" ADD CONSTRAINT "stock_count_counted_by_app_user_id_fk" FOREIGN KEY ("counted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count" ADD CONSTRAINT "stock_count_approved_by_app_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_line" ADD CONSTRAINT "stock_count_line_stock_count_id_stock_count_id_fk" FOREIGN KEY ("stock_count_id") REFERENCES "public"."stock_count"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_line" ADD CONSTRAINT "stock_count_line_item_code_item_code_fk" FOREIGN KEY ("item_code") REFERENCES "public"."item"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_count_no_uniq" ON "stock_count" USING btree ("count_no");--> statement-breakpoint
CREATE INDEX "stock_count_status_idx" ON "stock_count" USING btree ("status","branch_code");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_count_line_no_uniq" ON "stock_count_line" USING btree ("stock_count_id","line_no");--> statement-breakpoint

-- ===========================================================================
-- HAND-AUTHORED FROM HERE — Phase 04.8, section 9.6.
-- ===========================================================================

ALTER TABLE stock_count_line
  ADD CONSTRAINT stock_count_line_movement_fk
  FOREIGN KEY (movement_id) REFERENCES inventory_movement(id);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- An adjustment cannot post without variance approval (section 9.6).
--
-- The service checks it and gives a readable message; this is the layer that
-- holds when the write comes from somewhere else. A count that adjusted stock
-- without an approver named against it would make "who decided this stock was
-- gone?" unanswerable, which is the question an auditor asks first.
-- ---------------------------------------------------------------------------
CREATE FUNCTION stock_count_line_adjustment_is_approved() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_count stock_count%ROWTYPE;
BEGIN
  IF NEW.movement_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_count FROM stock_count WHERE id = NEW.stock_count_id;

  IF v_count.approved_by IS NULL THEN
    RAISE EXCEPTION
      'Stock count % has no approved variance, so its lines cannot be adjusted (blueprint 9.6). A Warehouse Manager approves the variance before any stock moves.',
      v_count.count_no
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER stock_count_line_adjustment_is_approved
  BEFORE INSERT OR UPDATE ON stock_count_line
  FOR EACH ROW EXECUTE FUNCTION stock_count_line_adjustment_is_approved();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- An adjusted count is final (sections 1.1, 9.6).
--
-- Its lines produced inventory movements, and the ledger is append-only. Going
-- back and changing what was counted would leave the movements describing a
-- count that no longer says what they were made from.
-- ---------------------------------------------------------------------------
CREATE FUNCTION stock_count_adjusted_is_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'Stock count % cannot be deleted (blueprint 1.1). Cancel it while it is planned, or close it.',
      OLD.count_no USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status IN ('adjusted', 'closed') AND NEW.status NOT IN ('adjusted', 'closed') THEN
    RAISE EXCEPTION
      'Stock count % has been adjusted; its stock movements exist and cannot be unmade (blueprint 1.1). Correct it with a further count.',
      OLD.count_no USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER stock_count_adjusted_is_final
  BEFORE UPDATE OR DELETE ON stock_count
  FOR EACH ROW EXECUTE FUNCTION stock_count_adjusted_is_final();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Section 9.9 — count variances stay visible until completed or written off.
-- ---------------------------------------------------------------------------
CREATE VIEW stock_count_variance AS
SELECT c.count_no,
       c.status,
       c.branch_code,
       c.warehouse_code,
       l.line_no,
       l.item_code,
       l.system_quantity,
       coalesce(l.recount_quantity, l.counted_quantity) AS counted_quantity,
       coalesce(l.recount_quantity, l.counted_quantity) - l.system_quantity AS variance
  FROM stock_count c
  JOIN stock_count_line l ON l.stock_count_id = c.id
 WHERE c.status NOT IN ('adjusted', 'closed', 'cancelled')
   AND coalesce(l.recount_quantity, l.counted_quantity) IS NOT NULL
   AND coalesce(l.recount_quantity, l.counted_quantity) <> l.system_quantity;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Numbering, document type and permissions.
-- ---------------------------------------------------------------------------
INSERT INTO doc_sequence (key, prefix, pattern, padding, scope_branch, scope_year)
VALUES ('STOCK_COUNT', 'CNT', '{PREFIX}-{BRANCH}-{YYYY}-{SERIAL}', 6, true, true);--> statement-breakpoint

INSERT INTO document_type (code, name, module, description) VALUES
  ('stock_count', 'Stock Count', 'inventory',
   'Counts physical stock and adjusts the ledger to it, on approval (section 9.6).');--> statement-breakpoint

INSERT INTO document_status_transition (document_type_code, from_status, to_status) VALUES
  ('stock_count', 'draft',     'submitted'),
  ('stock_count', 'submitted', 'approved'),
  ('stock_count', 'submitted', 'rejected'),
  ('stock_count', 'submitted', 'draft'),
  ('stock_count', 'approved',  'executed'),
  ('stock_count', 'executed',  'closed'),
  ('stock_count', 'draft',     'cancelled');--> statement-breakpoint

-- Section 9.6 — a variance is approved by a Warehouse Manager, which is the
-- `approve` verb; counting is `execute`.
INSERT INTO role_grant (role_code, object, verb) VALUES
  ('accounting_officer', 'stock_count', 'view'),
  ('accounting_officer', 'stock_count', 'create'),
  ('accounting_officer', 'stock_count', 'execute'),
  ('accounting_manager', 'stock_count', 'view'),
  ('accounting_manager', 'stock_count', 'create'),
  ('accounting_manager', 'stock_count', 'execute'),
  ('accounting_manager', 'stock_count', 'approve');--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    RAISE WARNING 'Role erp_app does not exist — grants skipped.';
    RETURN;
  END IF;

  REVOKE ALL ON stock_count, stock_count_line, stock_count_variance FROM erp_app;

  GRANT SELECT, INSERT, UPDATE ON stock_count          TO erp_app;
  GRANT SELECT, INSERT, UPDATE ON stock_count_line     TO erp_app;
  GRANT SELECT                 ON stock_count_variance TO erp_app;
END;
$$;--> statement-breakpoint

ALTER TABLE stock_count ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE stock_count FORCE  ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY stock_count_branch_scope ON stock_count
  USING (app_is_super_user() OR branch_code = app_current_branch())
  WITH CHECK (app_is_super_user() OR branch_code = app_current_branch());
