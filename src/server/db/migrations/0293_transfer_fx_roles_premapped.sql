-- Internal Transfers — the exchange difference posts where every other one does
-- (REQ-ACC-001, owner's decision 2026-10-04).
--
-- A cross-currency transfer values each leg in dinars at the ledger rate of its
-- date and sends what the bank's rate gave beyond or short of that to
-- `exchange_gain` / `exchange_loss` under `treasury.bank_transfer`. Those two
-- roles were left for Finance to map, so the first transfer with a difference
-- refused to post and named the role. The owner's instruction: do not make
-- Finance discover that at runtime — map them by migration to the same accounts
-- the other exchange differences already use.
--
-- The rules are copied from the FX events already mapped, the loan repayment's
-- first (it is the same thing happening to a different kind of debt — see
-- `domain/posting-map.ts`), then the loan revaluation's, then the import's.
-- Idempotent: the unique index on (event, role, criteria) makes a second run a
-- no-op, and a rule Finance already defined for the transfer — active or not —
-- is left exactly as they decided it. On a database where no FX event is mapped
-- yet nothing is copied, and the transfer still refuses with the role's name
-- until Posting Mappings carries one (then this migration has nothing to add).

INSERT INTO posting_rule (event_type, line_role, account_id, is_active, created_by, description)
SELECT DISTINCT ON (r.line_role)
       'treasury.bank_transfer', r.line_role, r.account_id, true, r.created_by,
       'Copied from ' || r.event_type || ' — a transfer''s exchange difference posts where every other one does (REQ-ACC-001).'
  FROM posting_rule r
 WHERE r.line_role IN ('exchange_gain', 'exchange_loss')
   AND r.event_type IN ('treasury.loan_repayment', 'treasury.loan_revaluation', 'payables.exchange_difference')
   AND r.is_active
   AND r.item_group IS NULL AND r.partner_group IS NULL AND r.warehouse_code IS NULL
   AND r.project_code IS NULL AND r.branch_code IS NULL
 ORDER BY r.line_role,
          CASE r.event_type
            WHEN 'treasury.loan_repayment' THEN 1
            WHEN 'treasury.loan_revaluation' THEN 2
            ELSE 3
          END,
          r.created_at
ON CONFLICT DO NOTHING;
