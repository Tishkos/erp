-- ---------------------------------------------------------------------------
-- The CEO can see the company — Dashboard, REQ-DASH-001 §2.
--
-- The role was created by 0206 to approve the two invoices, and that is all it
-- was given: view/approve/post/print on ap_invoice and ar_invoice, and execute
-- on inventory_movement. So the CEO could approve a purchase invoice and could
-- not open the Trial Balance, the Income Statement, a bank balance, or the
-- audit trail — and, because `workflow_instance` was never granted, could not
-- even open the Approvals screen that exists to list what is waiting for them.
-- The invoices arrived; nothing said why.
--
-- This grants the read-only executive view a dashboard needs, and nothing
-- more:
--
--   * `view` and `print` on the statements, the ledger and the documents — the
--     CEO reads the company, and may take a paper copy of what they read.
--   * `view` on `audit_event`. This is the one object deliberately given to the
--     CEO and to nobody else below the system administrator: who did what, and
--     when, is an executive question, and an accounting manager who could read
--     the trail of their own approvals would be reading it for reassurance
--     rather than for control.
--   * `view` on `workflow_instance`, so the approvals waiting on the CEO appear
--     on the screen that exists to list them.
--
-- Not granted, deliberately:
--
--   * `export`. §5.3 keeps export narrower than view on purpose — a copy that
--     leaves the building is a different act from reading a figure, and the
--     Chart of Accounts requirement (REQ-MD-001 §6 rule 7) already holds that
--     line. The CEO prints; the Accounting Manager exports.
--   * `create`, `edit_draft`, `submit`, `configure`, `reverse_cancel`. The CEO
--     approves and reads. A CEO who could also raise the document they approve
--     is maker-checker (§14.4) with the checker removed.
-- ---------------------------------------------------------------------------
INSERT INTO role_grant (role_code, object, verb)
SELECT 'ceo', wanted.object, wanted.verb::permission_verb
  FROM (VALUES
    -- What is waiting on them.
    ('workflow_instance', 'view'),
    -- Where the money stands.
    ('financial_statement', 'view'), ('financial_statement', 'print'),
    ('trial_balance', 'view'), ('trial_balance', 'print'),
    ('gl_inquiry', 'view'), ('gl_inquiry', 'print'),
    ('journal_entry', 'view'), ('journal_entry', 'print'),
    ('bank_account', 'view'), ('bank_account', 'print'),
    ('bank_cash_account', 'view'), ('bank_cash_account', 'print'),
    ('fiscal_period', 'view'),
    -- The documents behind the figures.
    ('supplier_payment', 'view'), ('supplier_payment', 'print'),
    ('customer_receipt', 'view'), ('customer_receipt', 'print'),
    ('goods_return', 'view'), ('goods_return', 'print'),
    ('sales_return', 'view'), ('sales_return', 'print'),
    ('business_partner', 'view'), ('business_partner', 'print'),
    -- The stock.
    ('inventory_movement', 'view'), ('inventory_movement', 'print'),
    ('stock_movement', 'view'), ('stock_movement', 'print'),
    ('warehouse', 'view'),
    ('item', 'view'),
    ('chart_of_account', 'view'),
    -- Who did what. The CEO and the system administrator, nobody else.
    ('audit_event', 'view')
  ) AS wanted(object, verb)
ON CONFLICT DO NOTHING;
