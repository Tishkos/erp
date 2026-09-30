-- ---------------------------------------------------------------------------
-- A receipt must credit the account the invoice debited — §1.2, §3.3.
--
-- The posting map constrained the line that *raises* a debt to a control
-- account and left the lines that *clear* it unconstrained. Five mappings had
-- drifted through that gap:
--
--   sales.customer_receipt            / customer_receivable  → a cash account
--   sales.customer_receipt_identified / customer_receivable  → a cash account
--   sales.customer_credit_memo        / customer_receivable  → a cash account
--   purchasing.supplier_payment       / supplier_payable     → Salaries Payable
--   purchasing.supplier_credit_memo   / supplier_payable     → Salaries Payable
--
-- Each posts a balanced journal, so nothing complains. What does not happen is
-- the subledger entry: that is written only for a line hitting a control
-- account of the right kind. So a receipt debited the bank, credited a cash
-- account, marked the invoice Paid — and the customer's statement stayed
-- exactly where it was. The ageing read the invoice and said nothing was
-- owed; the statement read the ledger and said it was. Both were reporting
-- faithfully on different facts.
--
-- The repair is not a guess. A debt is cleared on the account it was raised
-- on, so each of these takes the account its own invoice event already uses.
-- Mappings that already name a control account of the right kind are left
-- alone, and a rule whose account cannot be determined is reported rather
-- than patched — see the check at the foot of this file.
-- ---------------------------------------------------------------------------

WITH raising AS (
  -- The general mapping for each side: the account an invoice posts to when no
  -- item group, partner group, warehouse, project or branch narrows it.
  SELECT
    'customer_receivable'::text AS line_role,
    'customer'::text            AS kind,
    (SELECT account_id
       FROM posting_rule
      WHERE event_type = 'sales.ar_invoice'
        AND line_role  = 'customer_receivable'
        AND item_group IS NULL AND partner_group IS NULL AND warehouse_code IS NULL
        AND project_code IS NULL AND branch_code IS NULL
      LIMIT 1)                  AS account_id
  UNION ALL
  SELECT
    'supplier_payable',
    'supplier',
    (SELECT account_id
       FROM posting_rule
      WHERE event_type = 'purchasing.ap_invoice'
        AND line_role  = 'supplier_payable'
        AND item_group IS NULL AND partner_group IS NULL AND warehouse_code IS NULL
        AND project_code IS NULL AND branch_code IS NULL
      LIMIT 1)
),
resolved AS (
  -- Where no invoice mapping exists to copy, fall back to the chart itself —
  -- but only when it leaves no choice to make. One control account of that
  -- kind is an answer; two is a decision for a person, not a migration.
  SELECT
    r.line_role,
    r.kind,
    COALESCE(
      r.account_id,
      (SELECT c.id
         FROM (
           SELECT a.id, count(*) OVER () AS candidates
             FROM chart_of_account a
            WHERE a.control_account::text = r.kind
              AND NOT a.is_group
         ) c
        WHERE c.candidates = 1)
    ) AS account_id
  FROM raising r
)
UPDATE posting_rule pr
   SET account_id = resolved.account_id
  FROM resolved
 WHERE pr.line_role = resolved.line_role
   AND resolved.account_id IS NOT NULL
   AND pr.account_id IS DISTINCT FROM resolved.account_id
   -- Only the broken ones. A mapping already naming the right kind of control
   -- account is somebody's deliberate choice — a second receivable account for
   -- a branch, say — and this has no business overruling it.
   AND NOT EXISTS (
     SELECT 1 FROM chart_of_account a
      WHERE a.id = pr.account_id
        AND a.control_account::text = resolved.kind
   );

-- ---------------------------------------------------------------------------
-- Fail loudly rather than deploy a system that refuses to post.
--
-- From this release the posting engine rejects a subledger line whose account
-- is not that subledger's control account, which is the point. But a rule left
-- unrepaired above would turn that into receipts failing at the counter, in
-- front of a customer, with no warning at deploy time. Better the deploy stops
-- here and somebody designates the account in Chart of Accounts first.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(format('%s / %s -> %s (%s)', r.event_type, r.line_role, a.code, a.name), E'\n  ')
    INTO offending
    FROM posting_rule r
    JOIN chart_of_account a ON a.id = r.account_id
   WHERE (r.line_role LIKE '%receivable%' AND a.control_account::text IS DISTINCT FROM 'customer')
      OR (r.line_role LIKE '%payable%'    AND a.control_account::text IS DISTINCT FROM 'supplier');

  IF offending IS NOT NULL THEN
    RAISE EXCEPTION E'Posting mappings still send a subledger line to an account that is not its control account:\n  %\n\nDesignate the account in Chart of Accounts (Control account = Customer or Supplier), or point the mapping at the one the invoice uses, then run the migration again. Left as it is, every receipt, payment and credit memo would post a balanced journal that never reaches the partner''s statement.', offending;
  END IF;
END $$;
