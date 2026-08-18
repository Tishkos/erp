-- ===========================================================================
-- D10 — branch security is the user's permitted branches, not the session's
-- active one. Decided 2026-08-17.
--
--   "A user may be assigned access to one or more branches. The branches
--    assigned to the user define their security boundary. … In addition to the
--    user's permitted branches, the ERP should have an Active Branch. The Active
--    Branch is for convenience and transaction creation. It is not the security
--    permission itself. … The Active Branch shall not replace branch-level
--    security; access restrictions must be enforced by the backend and
--    database/query layer."
--
-- Phase 01 built the other reading: one session branch, and everything else
-- invisible. The Business Process Owner has now chosen the three-part model:
--
--   Allowed Branches  =  security   (user_branch_scope)
--   Active Branch     =  default    (app.branch_code)
--   Role              =  what you may do  (role_grant)
--
-- So every branch policy changes from "is this row in my session's branch?" to
-- "is this row in a branch I am permitted?". `app_current_branch()` keeps its
-- name and loses its authority: it is now the Active Branch, used to default a
-- new document and to filter a list, and it decides nothing about access.
--
-- **What this does not relax.** A user still cannot reach a branch outside their
-- permitted list, by ID, by URL or by API — the decision says so in terms, and
-- the policies below are where that is true rather than promised. What it stops
-- doing is hiding a branch the user *is* authorised for merely because they have
-- a different one selected.
--
-- It also resolves a conflict found while building Phase 06: §7.2 allows one
-- Sales Order to carry lines for several branches, which a session-branch policy
-- made impossible to approve in one act.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The permitted set, read from the user's own scope rows.
--
-- SECURITY DEFINER with a fixed search_path: the policy must give the same answer
-- whatever the caller may read for themselves, and a policy that depended on the
-- caller's grants would be a policy that could be widened by changing a grant.
--
-- STABLE, so it is evaluated once per query rather than once per row.
--
-- Fails closed. With no `app.user_id` set the array is empty and nothing is
-- visible, which is the same behaviour a missing session branch had before.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_permitted_branches() RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(s.branch_code), '{}'::text[])
    FROM user_branch_scope s
   WHERE s.user_id = nullif(current_setting('app.user_id', true), '')::uuid;
$$;--> statement-breakpoint

COMMENT ON FUNCTION app_permitted_branches() IS
  'D10 (2026-08-17): the branches this user is authorised for. The security boundary. '
  'Not to be confused with app_current_branch(), which is the Active Branch and is only a default.';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The predicate the policies use.
--
-- Deliberately does **not** special-case a NULL branch. Some rows legitimately
-- have none — an unposted journal before its branch is set, a posting-log entry
-- for a company-level event — and whether that is visible is a per-table
-- question that the policies below answer for themselves. Baking it in here
-- would silently widen the tables that had chosen otherwise.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_branch_allowed(p_branch text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT app_is_super_user() OR p_branch = ANY (app_permitted_branches());
$$;--> statement-breakpoint

COMMENT ON FUNCTION app_current_branch() IS
  'D10 (2026-08-17): the **Active Branch** — the default for new documents and the '
  'initial filter on a list. It is not a permission: security is app_permitted_branches().';--> statement-breakpoint

-- An index on the lookup the predicate makes for every query.
CREATE INDEX IF NOT EXISTS user_branch_scope_user_idx ON user_branch_scope (user_id);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Every branch policy, restated.
--
-- Twenty-three of them, and each keeps the shape it had — the four that allow a
-- NULL branch still allow it, and the two that reach through to a parent still
-- reach through. Only the predicate changes.
-- ---------------------------------------------------------------------------

-- Plain branch_code, NULL not allowed.
DROP POLICY ap_invoice_branch_scope ON ap_invoice;--> statement-breakpoint
CREATE POLICY ap_invoice_branch_scope ON ap_invoice
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

DROP POLICY audit_event_branch_scope ON audit_event;--> statement-breakpoint
CREATE POLICY audit_event_branch_scope ON audit_event
  USING (app_is_super_user() OR branch_code IS NULL OR app_branch_allowed(branch_code))
  WITH CHECK (app_is_super_user() OR branch_code IS NULL OR app_branch_allowed(branch_code));--> statement-breakpoint

DROP POLICY cost_layer_branch_scope ON cost_layer;--> statement-breakpoint
CREATE POLICY cost_layer_branch_scope ON cost_layer
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

DROP POLICY goods_receipt_branch_scope ON goods_receipt;--> statement-breakpoint
CREATE POLICY goods_receipt_branch_scope ON goods_receipt
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

DROP POLICY goods_return_branch_scope ON goods_return;--> statement-breakpoint
CREATE POLICY goods_return_branch_scope ON goods_return
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

DROP POLICY inventory_movement_branch_scope ON inventory_movement;--> statement-breakpoint
CREATE POLICY inventory_movement_branch_scope ON inventory_movement
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

DROP POLICY opening_stock_branch_scope ON opening_stock;--> statement-breakpoint
CREATE POLICY opening_stock_branch_scope ON opening_stock
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

DROP POLICY purchase_order_branch_scope ON purchase_order;--> statement-breakpoint
CREATE POLICY purchase_order_branch_scope ON purchase_order
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

DROP POLICY sales_order_branch_scope ON sales_order;--> statement-breakpoint
CREATE POLICY sales_order_branch_scope ON sales_order
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

DROP POLICY service_receipt_branch_scope ON service_receipt;--> statement-breakpoint
CREATE POLICY service_receipt_branch_scope ON service_receipt
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

DROP POLICY stock_count_branch_scope ON stock_count;--> statement-breakpoint
CREATE POLICY stock_count_branch_scope ON stock_count
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

DROP POLICY stock_reservation_branch_scope ON stock_reservation;--> statement-breakpoint
CREATE POLICY stock_reservation_branch_scope ON stock_reservation
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

DROP POLICY supplier_advance_branch_scope ON supplier_advance;--> statement-breakpoint
CREATE POLICY supplier_advance_branch_scope ON supplier_advance
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

DROP POLICY supplier_credit_memo_branch_scope ON supplier_credit_memo;--> statement-breakpoint
CREATE POLICY supplier_credit_memo_branch_scope ON supplier_credit_memo
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

DROP POLICY supplier_payment_branch_scope ON supplier_payment;--> statement-breakpoint
CREATE POLICY supplier_payment_branch_scope ON supplier_payment
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

DROP POLICY warehouse_transfer_branch_scope ON warehouse_transfer;--> statement-breakpoint
CREATE POLICY warehouse_transfer_branch_scope ON warehouse_transfer
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

DROP POLICY workflow_instance_branch_scope ON workflow_instance;--> statement-breakpoint
CREATE POLICY workflow_instance_branch_scope ON workflow_instance
  USING (app_is_super_user() OR branch_code IS NULL OR app_branch_allowed(branch_code))
  WITH CHECK (app_is_super_user() OR branch_code IS NULL OR app_branch_allowed(branch_code));--> statement-breakpoint

-- NULL allowed: a company-level posting or an unbranched log line.
DROP POLICY posting_log_branch_scope ON posting_log;--> statement-breakpoint
CREATE POLICY posting_log_branch_scope ON posting_log
  USING (app_is_super_user() OR branch_code IS NULL OR app_branch_allowed(branch_code))
  WITH CHECK (app_is_super_user() OR branch_code IS NULL OR app_branch_allowed(branch_code));--> statement-breakpoint

DROP POLICY posting_failure_branch_scope ON posting_failure;--> statement-breakpoint
CREATE POLICY posting_failure_branch_scope ON posting_failure
  USING (app_is_super_user() OR branch_code IS NULL OR app_branch_allowed(branch_code))
  WITH CHECK (app_is_super_user() OR branch_code IS NULL OR app_branch_allowed(branch_code));--> statement-breakpoint

DROP POLICY subledger_entry_branch_scope ON subledger_entry;--> statement-breakpoint
CREATE POLICY subledger_entry_branch_scope ON subledger_entry
  USING (app_is_super_user() OR branch_code IS NULL OR app_branch_allowed(branch_code))
  WITH CHECK (app_is_super_user() OR branch_code IS NULL OR app_branch_allowed(branch_code));--> statement-breakpoint

DROP POLICY journal_entry_branch_scope ON journal_entry;--> statement-breakpoint
CREATE POLICY journal_entry_branch_scope ON journal_entry
  USING (app_is_super_user() OR branch_code IS NULL OR app_branch_allowed(branch_code))
  WITH CHECK (app_is_super_user() OR branch_code IS NULL OR app_branch_allowed(branch_code));--> statement-breakpoint

-- Reaches through to its parent, as before.
DROP POLICY journal_line_branch_scope ON journal_line;--> statement-breakpoint
CREATE POLICY journal_line_branch_scope ON journal_line
  USING (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM journal_entry e
       WHERE e.id = journal_line.journal_entry_id
         AND (e.branch_code IS NULL OR app_branch_allowed(e.branch_code))
    )
  )
  WITH CHECK (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM journal_entry e
       WHERE e.id = journal_line.journal_entry_id
         AND (e.branch_code IS NULL OR app_branch_allowed(e.branch_code))
    )
  );--> statement-breakpoint

DROP POLICY warehouse_transfer_line_branch_scope ON warehouse_transfer_line;--> statement-breakpoint
CREATE POLICY warehouse_transfer_line_branch_scope ON warehouse_transfer_line
  USING (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM warehouse_transfer t
       WHERE t.id = warehouse_transfer_line.transfer_id
         AND app_branch_allowed(t.branch_code)
    )
  )
  WITH CHECK (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM warehouse_transfer t
       WHERE t.id = warehouse_transfer_line.transfer_id
         AND app_branch_allowed(t.branch_code)
    )
  );
