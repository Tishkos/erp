#!/usr/bin/env bash
#
# Puts the Statement Mapping back to the layout an install starts from, and
# unmaps every account, so Finance can build the four reports again from a
# clean sheet.
#
# What it does NOT touch: the chart of accounts, and every posted journal.
# The accounts keep their codes, names, places in the chart and their history;
# they simply stop naming a line, which means they report where their type
# reports until Finance maps them again. The statements go on printing
# throughout — from the default layout rather than a half-built one.
#
# Run from the project root on your own machine:
#
#   ssh-add ~/.ssh/qs_vps && bash scripts/ops/reset-statement-mapping.sh
#
set -euo pipefail

ERP_SSH="${ERP_SSH:-root@31.97.123.206}"
STAMP=$(date -u +%Y%m%d-%H%M%S)

say() { printf '\n\033[1m== %s\033[0m\n' "$*" >&2; }

say "Resetting the statement mapping on $ERP_SSH"

ssh "$ERP_SSH" bash -euo pipefail -s <<REMOTE
APP=/opt/qs-erp-next
STAMP=$STAMP
set -a; . "\$APP/.env"; set +a

# The mapping is configuration, not a ledger — but it is still someone's work,
# so it is dumped before it is replaced.
mkdir -p /root/erp-backups
pg_dump "\$DATABASE_URL_OWNER" \
  --table=financial_statement_line --table=chart_of_account -Fc \
  -f "/root/erp-backups/mapping-before-\$STAMP.dump"
echo "backup: /root/erp-backups/mapping-before-\$STAMP.dump" >&2

psql "\$DATABASE_URL_OWNER" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;

-- 1 ---------------------------------------------------------------------
-- Every account forgets which line it reported on. Four columns, because a
-- mapping is per report; the accounts themselves are not touched.
UPDATE chart_of_account
   SET income_statement_line  = NULL,
       balance_sheet_line     = NULL,
       cash_flow_line         = NULL,
       changes_in_equity_line = NULL
 WHERE income_statement_line  IS NOT NULL
    OR balance_sheet_line     IS NOT NULL
    OR cash_flow_line         IS NOT NULL
    OR changes_in_equity_line IS NOT NULL;

-- 2 ---------------------------------------------------------------------
-- Nothing is left parented to a line that is about to go, so the delete
-- below is not refused by the tree's own foreign key.
UPDATE financial_statement_line SET parent_id = NULL;

-- 3 ---------------------------------------------------------------------
-- Finance's own lines go; the seeded ones are restored to the names, order
-- and vocabulary a fresh install has, however they were edited since.
DELETE FROM financial_statement_line WHERE NOT is_system;

INSERT INTO financial_statement_line
  (code, name, statement, ordinal, role, side, cash_flow_category, is_cash, is_system)
VALUES
  ('non_current_assets',      'Non-current assets',        'balance_sheet',    10, NULL, 'asset',     'investing', false, true),
  ('current_assets',          'Current assets',            'balance_sheet',    20, NULL, 'asset',     'operating', false, true),
  ('cash_and_equivalents',    'Cash and cash equivalents', 'balance_sheet',    30, NULL, 'asset',     NULL,        true,  true),
  ('equity',                  'Equity',                    'balance_sheet',    40, NULL, 'equity',    'financing', false, true),
  ('non_current_liabilities', 'Non-current liabilities',   'balance_sheet',    50, NULL, 'liability', 'financing', false, true),
  ('current_liabilities',     'Current liabilities',       'balance_sheet',    60, NULL, 'liability', 'operating', false, true),
  ('revenue',                 'Revenue',                   'income_statement', 10, 'revenue',            NULL, 'operating', false, true),
  ('cost_of_sales',           'Cost of sales',             'income_statement', 20, 'cost_of_sales',      NULL, 'operating', false, true),
  ('other_income',            'Other income',              'income_statement', 30, 'other_income',       NULL, 'operating', false, true),
  ('operating_expenses',      'Operating expenses',        'income_statement', 40, 'operating_expenses', NULL, 'operating', false, true),
  ('finance_costs',           'Finance costs',             'income_statement', 50, 'finance_costs',      NULL, 'operating', false, true),
  ('tax_expense',             'Tax',                       'income_statement', 60, 'tax_expense',        NULL, 'operating', false, true),
  ('cash_flow_cash',          'Cash and cash equivalents', 'cash_flow',         10, NULL, NULL, NULL,        true,  true),
  ('cash_flow_operating',     'Operating activities',      'cash_flow',         20, NULL, NULL, 'operating', false, true),
  ('cash_flow_investing',     'Investing activities',      'cash_flow',         30, NULL, NULL, 'investing', false, true),
  ('cash_flow_financing',     'Financing activities',      'cash_flow',         40, NULL, NULL, 'financing', false, true),
  ('equity_movements',        'Equity',                    'changes_in_equity', 10, NULL, NULL, NULL,        false, true)
ON CONFLICT (code) DO UPDATE SET
  name               = EXCLUDED.name,
  statement          = EXCLUDED.statement,
  ordinal            = EXCLUDED.ordinal,
  role               = EXCLUDED.role,
  side               = EXCLUDED.side,
  cash_flow_category = EXCLUDED.cash_flow_category,
  is_cash            = EXCLUDED.is_cash,
  is_header          = false,
  parent_id          = NULL;

COMMIT;
SQL

echo >&2
psql "\$DATABASE_URL_OWNER" -c \
  "select statement, count(*) as lines, count(*) filter (where not is_system) as custom
     from financial_statement_line group by 1 order by 1"
psql "\$DATABASE_URL_OWNER" -tAc \
  "select 'accounts still mapped: ' || count(*) from chart_of_account
    where income_statement_line is not null or balance_sheet_line is not null
       or cash_flow_line is not null or changes_in_equity_line is not null"
psql "\$DATABASE_URL_OWNER" -tAc \
  "select 'posted journal lines kept: ' || count(*) from journal_line l
     join journal_entry e on e.id = l.journal_entry_id
    where e.status in ('posted','reversed')"
REMOTE

say "Done. The mapping is back to the seventeen lines an install starts with."
echo "Restore: ssh $ERP_SSH 'pg_restore -d \"\$DATABASE_URL_OWNER\" -c /root/erp-backups/mapping-before-$STAMP.dump'" >&2
