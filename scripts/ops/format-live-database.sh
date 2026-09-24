#!/usr/bin/env bash
#
# Format the books on erp.qs-groups.com — take every document and everything it
# left behind off the system, and leave the setup standing.
#
#   scripts/ops/format-live-database.sh            what would go, and what would stay
#   scripts/ops/format-live-database.sh --yes      back up, then do it
#
# Run from the project root on your own machine. It reaches the server over ssh
# the way deploy.sh does, so the preview can be read before anything is decided.
#
# ── Why this was rewritten (2026-09-24) ───────────────────────────────────
# The first version predated the Operations build. It deleted journal_entry and
# journal_line and stopped there — leaving ap_invoice, ar_invoice, the receipts,
# the payments, the returns, the credit memos, the subledger, the stock
# movements and the cost layers all in place, every one of them pointing at a
# journal that no longer existed. And because it lifts the foreign keys for the
# length of the transaction, the database would not have refused: it would have
# accepted every one of those orphans and gone on serving them to the reports.
#
# A format has to take the whole document with it or none of it. The order
# below is children before parents for the same reason: with the keys lifted,
# nothing warns you when it is wrong.
#
set -euo pipefail

ERP_SSH="${ERP_SSH:-root@31.97.123.206}"
APP="${APP:-/opt/qs-erp-next}"
PM2_NAME="${PM2_NAME:-qs-erp}"
MODE="${1:-}"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

if [[ "$MODE" != "--yes" && -n "$MODE" ]]; then
  echo "Usage: $0 [--yes]" >&2
  exit 2
fi

# ── What a document is, in the order it has to be taken apart ──────────────
# Every table a posted document touches, children first. Tables belonging to
# phases that are not built yet are here too: they are empty, deleting from
# them costs nothing, and the day one of them fills is not the day anybody
# wants to discover this list was written before it existed.
read -r -d '' DOCUMENT_TABLES <<'TABLES' || true
proof_of_delivery_photo
proof_of_delivery
delivery_note_line_unit
delivery_note_line
delivery_note
pick_list_line_unit
pick_list_line
pick_list
stock_reservation
warranty_registration
promise_to_pay
collection_activity
ar_write_off
customer_credit_memo_line
customer_credit_memo
customer_receipt_allocation
customer_receipt
sales_return_line
sales_return
ar_invoice_line
ar_invoice
sales_order_line
sales_order
other_receipt
ap_match_exception
supplier_credit_memo
goods_return_line
goods_return
supplier_payment_allocation
supplier_payment
supplier_advance_settlement
supplier_advance
ap_invoice_line
ap_invoice
service_receipt_line
service_receipt
goods_receipt_line
goods_receipt
purchase_order_line
purchase_order
supplier_shipment
cost_layer_consumption
cost_layer
inventory_movement
opening_stock_line
opening_stock
stock_count_line
stock_count
warehouse_transfer_line
warehouse_transfer
bank_statement_rejected_line
bank_statement_line
bank_statement
bank_reconciliation_match_line
bank_reconciliation_match
bank_reconciliation
bank_transfer
cash_count
cash_advance_settlement
cash_advance
payment_batch_line
payment_batch
payment_proposal_item
payment_proposal
bank_execution_batch_line
bank_execution_batch
invoice_line
invoice
subledger_entry
journal_line
journal_entry
posting_log
posting_failure
workflow_decision
workflow_instance
doc_number_allocation
attachment_access
attachment
notification_delivery
notification
job_outbox
job_run
job_queue
import_row
import_batch
audit_event
auth_session
TABLES

# ── The master data the test runs left behind ──────────────────────────────
# Only what a test run created, named the way the suites name it. Anything
# entered by hand stays, which is the whole point of formatting rather than
# rebuilding: the company keeps its own customers, suppliers, items and chart.
read -r -d '' TEST_DATA_SQL <<'SQL' || true
delete from item_supplier
 where supplier_id in (select id from business_partner where code like 'E2E-%')
    or item_id in (select id from item where code = 'ITM-SEED' or code like 'E2E%');
delete from partner_bank_account
 where business_partner_id in (select id from business_partner where code like 'E2E-%');
delete from item_uom
 where item_id in (select id from item where code = 'ITM-SEED' or code like 'E2E%');
delete from price_list_item
 where item_id in (select id from item where code = 'ITM-SEED' or code like 'E2E%');
delete from item where code = 'ITM-SEED' or code like 'E2E%';
delete from business_partner where code like 'E2E-%';

-- The accounts the suites raise, and the mappings that were pointed at them.
-- The mapping goes first: a rule left behind would name an account that is no
-- longer there, and the next document to post through it would fail with a
-- message about a missing account rather than a missing mapping.
delete from posting_rule
 where account_id in (select id from chart_of_account where name like 'E2E %');
delete from account_required_dimension
 where account_id in (select id from chart_of_account where name like 'E2E %');
delete from chart_of_account where name like 'E2E %' and not is_system;
SQL

# ── The report, which is also the preview ──────────────────────────────────
read -r -d '' REPORT_SQL <<'SQL' || true
select 'DOCUMENTS';
select rpad(t.table_name, 28) || lpad(t.n::text, 8)
  from (
    select 'journal_entry' as table_name, count(*) n from journal_entry
    union all select 'journal_line', count(*) from journal_line
    union all select 'subledger_entry', count(*) from subledger_entry
    union all select 'ap_invoice', count(*) from ap_invoice
    union all select 'ar_invoice', count(*) from ar_invoice
    union all select 'customer_receipt', count(*) from customer_receipt
    union all select 'supplier_payment', count(*) from supplier_payment
    union all select 'goods_return', count(*) from goods_return
    union all select 'sales_return', count(*) from sales_return
    union all select 'customer_credit_memo', count(*) from customer_credit_memo
    union all select 'supplier_credit_memo', count(*) from supplier_credit_memo
    union all select 'inventory_movement', count(*) from inventory_movement
    union all select 'cost_layer', count(*) from cost_layer
    union all select 'workflow_instance', count(*) from workflow_instance
    union all select 'attachment', count(*) from attachment
    union all select 'audit_event', count(*) from audit_event
  ) t
 where t.n > 0
 order by 1;

select '';
select 'MASTER DATA THE TESTS LEFT';
select rpad('partners  E2E-*', 28) || lpad(count(*)::text, 8) from business_partner where code like 'E2E-%';
select rpad('items     ITM-SEED/E2E*', 28) || lpad(count(*)::text, 8) from item where code = 'ITM-SEED' or code like 'E2E%';
select rpad('accounts  "E2E ..."', 28) || lpad(count(*)::text, 8) from chart_of_account where name like 'E2E %';
select rpad('mappings on those', 28) || lpad(count(*)::text, 8)
  from posting_rule where account_id in (select id from chart_of_account where name like 'E2E %');

select '';
select 'STAYS';
select rpad('company', 28) || lpad(count(*)::text, 8) from company;
select rpad('branches', 28) || lpad(count(*)::text, 8) from branch;
select rpad('users (active)', 28) || lpad(count(*)::text, 8) from app_user where is_active;
select rpad('accounts (kept)', 28) || lpad(count(*)::text, 8) from chart_of_account where name not like 'E2E %';
select rpad('partners (kept)', 28) || lpad(count(*)::text, 8) from business_partner where code not like 'E2E-%';
select rpad('items (kept)', 28) || lpad(count(*)::text, 8) from item where code <> 'ITM-SEED' and code not like 'E2E%';
select rpad('warehouses', 28) || lpad(count(*)::text, 8) from warehouse;
select rpad('bank/cash accounts', 28) || lpad(count(*)::text, 8) from bank_cash_account;
select rpad('payment terms', 28) || lpad(count(*)::text, 8) from payment_terms;
select rpad('fiscal years', 28) || lpad(count(*)::text, 8) from fiscal_year;
select rpad('exchange rates', 28) || lpad(count(*)::text, 8) from exchange_rate;
select rpad('mappings (kept)', 28) || lpad(count(*)::text, 8)
  from posting_rule where account_id not in (select id from chart_of_account where name like 'E2E %');
SQL

if [[ "$MODE" != "--yes" ]]; then
  say "What is there now — nothing is being changed"
  ssh "$ERP_SSH" bash -euo pipefail -s <<REMOTE
export PGPASSWORD=\$(grep -oP '^DATABASE_URL_OWNER=postgres://erp_owner:\K[^@]+' "$APP/.env")
psql -h 127.0.0.1 -p 5434 -U erp_owner -d erp -tA <<'SQL'
$REPORT_SQL
SQL
REMOTE
  echo
  echo "Nothing was changed. Run with --yes to back up and format."
  exit 0
fi

say "Backing up, then formatting"
ssh "$ERP_SSH" bash -euo pipefail -s <<REMOTE
STAMP=\$(date -u +%Y%m%d-%H%M%S)
export PGPASSWORD=\$(grep -oP '^DATABASE_URL_OWNER=postgres://erp_owner:\K[^@]+' "$APP/.env")
psql() { command psql -h 127.0.0.1 -p 5434 -U erp_owner -d erp "\$@"; }

# The only way back. Taken before anything moves, and kept until somebody has
# looked at the formatted system and said it is right.
mkdir -p /root/erp-backups
pg_dump -h 127.0.0.1 -p 5434 -U erp_owner -d erp -Fc \
  -f "/root/erp-backups/erp-before-format-\$STAMP.dump"
ls -la "/root/erp-backups/erp-before-format-\$STAMP.dump"

psql -v ON_ERROR_STOP=1 <<'SQL'
begin;
-- Lifted for this transaction only: the tables come apart children first, and
-- the keys would otherwise refuse an order that is correct overall. Lifting
-- them is also why the list above has to be complete — with the keys down,
-- nothing tells you what you forgot.
set local session_replication_role = replica;
SQL

for table in $DOCUMENT_TABLES; do
  psql -v ON_ERROR_STOP=1 -c "delete from \$table" >/dev/null
done

psql -v ON_ERROR_STOP=1 <<'SQL'
begin;
set local session_replication_role = replica;
$TEST_DATA_SQL

-- Numbering starts again: there is nothing left for a number to collide with.
do \$\$
declare r record;
begin
  for r in select c.relname from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
           where c.relkind = 'S' and n.nspname = 'public' and c.relname like 'docseq_%'
  loop
    execute format('select setval(%L, 1, false)', r.relname);
  end loop;
end \$\$;
commit;
SQL

pm2 restart "$PM2_NAME" --update-env >/dev/null
echo "restarted $PM2_NAME"
REMOTE

say "What is left"
ssh "$ERP_SSH" bash -euo pipefail -s <<REMOTE
export PGPASSWORD=\$(grep -oP '^DATABASE_URL_OWNER=postgres://erp_owner:\K[^@]+' "$APP/.env")
psql -h 127.0.0.1 -p 5434 -U erp_owner -d erp -tA <<'SQL'
$REPORT_SQL
SQL
REMOTE
