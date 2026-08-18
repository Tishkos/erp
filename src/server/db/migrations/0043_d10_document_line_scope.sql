-- ===========================================================================
-- D10, third part — the branch boundary reaches document *lines*.
--
-- Found while finishing the D10 rework, and it is a hole rather than a
-- refinement: nine document line tables had no row-level security at all, while
-- `erp_app` holds SELECT on every one of them.
--
--   ap_invoice_line · goods_receipt_line · goods_return_line ·
--   opening_stock_line · purchase_order_line · sales_order_line ·
--   service_receipt_line · stock_count_line · supplier_payment_allocation
--
-- The headers were protected from the beginning, so the 01.2 gate — *"a user
-- scoped to Branch A cannot read a Branch B record by ID"* — held for the
-- document and not for its contents. A user could not open another branch's
-- Sales Order, and could read every line of it: item, quantity, unit price,
-- discount, delivery location. For a purchase order, the supplier's prices.
--
-- D10 is explicit that this is not acceptable, and says where it must be fixed:
--
--   "A user must never be able to open a record belonging to a branch they are
--    not authorised for, including by entering its ID or URL directly. … The
--    Active Branch shall not replace branch-level security; access restrictions
--    must be enforced by the backend and database/query layer."
--
-- The services always joined through the header, so nothing was leaking through
-- the application. That is exactly the situation §22 is written against —
-- *"row-level security is enforced in the query layer, not only hidden in the
-- screen"* — because a control that lives only in the queries you happened to
-- write is a control the next query can forget.
--
-- **Two shapes, because the tables are two shapes.**
--
--   *Its own branch.* `purchase_order_line` and `sales_order_line` each carry
--   `branch_code`, because §8.3 and §7.2 let one order span branches. Their
--   policy reads the **line's** branch, not the header's — otherwise a user
--   permitted only Erbil could not see the Erbil line of a Baghdad-headed
--   order, which is the case those columns exist for.
--
--   *Through the parent.* The other seven have no branch of their own, so the
--   line's branch is the document's. The subquery is the same shape
--   `journal_line` has used since 0021.
--
-- **A consequence worth stating.** A user permitted one branch of a two-branch
-- order sees the header and the lines they are entitled to, and the header's
-- totals will exceed the lines they can see. That is the honest outcome: the
-- alternative is showing them another branch's prices so the arithmetic looks
-- tidy. A user who needs the whole order is permitted both branches.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Lines that carry their own branch (§7.2, §8.3).
-- ---------------------------------------------------------------------------

ALTER TABLE purchase_order_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE purchase_order_line FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY purchase_order_line_branch_scope ON purchase_order_line
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

ALTER TABLE sales_order_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE sales_order_line FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY sales_order_line_branch_scope ON sales_order_line
  USING (app_branch_allowed(branch_code))
  WITH CHECK (app_branch_allowed(branch_code));--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Lines whose branch is their document's.
-- ---------------------------------------------------------------------------

ALTER TABLE goods_return_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE goods_return_line FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY goods_return_line_branch_scope ON goods_return_line
  USING (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM goods_return d
       WHERE d.id = goods_return_line.goods_return_id
         AND app_branch_allowed(d.branch_code)
    )
  )
  WITH CHECK (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM goods_return d
       WHERE d.id = goods_return_line.goods_return_id
         AND app_branch_allowed(d.branch_code)
    )
  );--> statement-breakpoint

ALTER TABLE ap_invoice_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ap_invoice_line FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY ap_invoice_line_branch_scope ON ap_invoice_line
  USING (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM ap_invoice d
       WHERE d.id = ap_invoice_line.ap_invoice_id
         AND app_branch_allowed(d.branch_code)
    )
  )
  WITH CHECK (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM ap_invoice d
       WHERE d.id = ap_invoice_line.ap_invoice_id
         AND app_branch_allowed(d.branch_code)
    )
  );--> statement-breakpoint

ALTER TABLE goods_receipt_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE goods_receipt_line FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY goods_receipt_line_branch_scope ON goods_receipt_line
  USING (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM goods_receipt d
       WHERE d.id = goods_receipt_line.goods_receipt_id
         AND app_branch_allowed(d.branch_code)
    )
  )
  WITH CHECK (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM goods_receipt d
       WHERE d.id = goods_receipt_line.goods_receipt_id
         AND app_branch_allowed(d.branch_code)
    )
  );--> statement-breakpoint

ALTER TABLE opening_stock_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE opening_stock_line FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY opening_stock_line_branch_scope ON opening_stock_line
  USING (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM opening_stock d
       WHERE d.id = opening_stock_line.opening_stock_id
         AND app_branch_allowed(d.branch_code)
    )
  )
  WITH CHECK (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM opening_stock d
       WHERE d.id = opening_stock_line.opening_stock_id
         AND app_branch_allowed(d.branch_code)
    )
  );--> statement-breakpoint

ALTER TABLE service_receipt_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE service_receipt_line FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY service_receipt_line_branch_scope ON service_receipt_line
  USING (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM service_receipt d
       WHERE d.id = service_receipt_line.service_receipt_id
         AND app_branch_allowed(d.branch_code)
    )
  )
  WITH CHECK (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM service_receipt d
       WHERE d.id = service_receipt_line.service_receipt_id
         AND app_branch_allowed(d.branch_code)
    )
  );--> statement-breakpoint

ALTER TABLE stock_count_line ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE stock_count_line FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY stock_count_line_branch_scope ON stock_count_line
  USING (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM stock_count d
       WHERE d.id = stock_count_line.stock_count_id
         AND app_branch_allowed(d.branch_code)
    )
  )
  WITH CHECK (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM stock_count d
       WHERE d.id = stock_count_line.stock_count_id
         AND app_branch_allowed(d.branch_code)
    )
  );--> statement-breakpoint

-- An allocation says which invoice a payment settled. It is money, and it is
-- read straight off the payment's branch.
ALTER TABLE supplier_payment_allocation ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE supplier_payment_allocation FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY supplier_payment_allocation_branch_scope ON supplier_payment_allocation
  USING (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM supplier_payment d
       WHERE d.id = supplier_payment_allocation.supplier_payment_id
         AND app_branch_allowed(d.branch_code)
    )
  )
  WITH CHECK (
    app_is_super_user()
    OR EXISTS (
      SELECT 1 FROM supplier_payment d
       WHERE d.id = supplier_payment_allocation.supplier_payment_id
         AND app_branch_allowed(d.branch_code)
    )
  );--> statement-breakpoint

-- The indexes these policies read, where they do not already exist. A policy
-- evaluated per row on a sequential scan of the parent is a policy that turns a
-- list into a timeout.
CREATE INDEX IF NOT EXISTS ap_invoice_line_invoice_idx ON ap_invoice_line (ap_invoice_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS goods_receipt_line_receipt_idx ON goods_receipt_line (goods_receipt_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS opening_stock_line_document_idx ON opening_stock_line (opening_stock_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS service_receipt_line_receipt_idx ON service_receipt_line (service_receipt_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS stock_count_line_count_idx ON stock_count_line (stock_count_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS supplier_payment_allocation_payment_idx ON supplier_payment_allocation (supplier_payment_id);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS purchase_order_line_branch_idx ON purchase_order_line (branch_code);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sales_order_line_branch_idx ON sales_order_line (branch_code);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS goods_return_line_return_idx ON goods_return_line (goods_return_id);
