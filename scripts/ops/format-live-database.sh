#!/usr/bin/env bash
#
# Format the books on erp.qs-groups.com — take every document and everything it
# left behind off the system, and leave the setup standing.
#
#   scripts/ops/format-live-database.sh                       what would go, what would stay
#   scripts/ops/format-live-database.sh --yes                  back up, then do it
#   scripts/ops/format-live-database.sh --yes --master-data    ...and the master data with it
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
# ── And why it was amended (2026-09-27) ───────────────────────────────────
# Operations block 7 added stock_transfer and stock_adjustment (migration 0207)
# after this list was written, and the list was not updated. Five formats that
# morning deleted every inventory_movement, cost_layer and journal on the box
# and left TRF-HQ-2026-000001, TRF-HQ-2026-000002 and ADJ-HQ-2026-000001
# standing: documents on the Transfer page with no rows in the Stock Movement
# ledger, and a number sequence reset underneath them. tests/integration/
# setup.ts already deleted both tables; this script did not. The two tables are
# in the list now, and the report at the end names any document left without
# its ledger rows, so the next omission is seen the moment it happens rather
# than when somebody's arithmetic disagrees with a screen.
#
set -euo pipefail

ERP_SSH="${ERP_SSH:-root@31.97.123.206}"
APP="${APP:-/opt/qs-erp-next}"
PM2_NAME="${PM2_NAME:-qs-erp}"
MODE="${1:-}"
MASTER="${2:-}"

# The one warehouse --master-data leaves standing. One has to survive: a branch
# defaults to a warehouse, and a company with none can receive nothing.
KEEP_WAREHOUSE="${KEEP_WAREHOUSE:-WH-HQ}"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

if [[ "$MODE" != "--yes" && -n "$MODE" ]]; then
  echo "Usage: $0 [--yes [--master-data]]" >&2
  exit 2
fi
if [[ -n "$MASTER" && "$MASTER" != "--master-data" ]]; then
  echo "Usage: $0 [--yes [--master-data]]" >&2
  exit 2
fi

# ── The books are open: this script no longer applies ──────────────────────
# Once real trading has begun, a format destroys history that the audit trail,
# the document numbers and every backup assume is permanent. The marker file
# below is placed on the server the day the company starts trading for real
# (2026-09-27), and while it stands this script does nothing but say so.
# Lifting it is a deliberate act by a person, not a flag on the command line:
# there is no --force, because the one time somebody reaches for --force is
# the one time it must not exist.
LIVE_MARKER="$APP/var/LIVE"
if ssh "$ERP_SSH" test -e "$LIVE_MARKER"; then
  say "Refusing to format a live database"
  ssh "$ERP_SSH" cat "$LIVE_MARKER"
  echo
  echo "The books on this server are live. A format would erase real invoices, real" >&2
  echo "stock movements and the audit trail behind them, as it did on 2026-09-27." >&2
  echo "Trials and demos belong on a separate database. If this really is not a live" >&2
  echo "system any more, remove $LIVE_MARKER on the server by hand and run again." >&2
  exit 3
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
container_receipt_line
container_receipt
shipment_container_line
shipment_container_status_history
shipment_container
bill_of_lading
bank_loan_allocation
bank_loan_instalment
bank_loan
payment_application
payable_instalment
customs_pd_status_history
customs_pd
ap_invoice_note
landed_cost_layer_adjustment
landed_cost_charge
landed_cost_lock
payable_hold_update
payable_hold
payable_event
payable_order_line
payable
recurring_contract_amendment
recurring_contract
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
stock_transfer
stock_adjustment
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
money_transfer_expense
money_transfer_deposit_usage
money_transfer
logistics_delivery_evidence
logistics_claim
logistics_job_cost
logistics_client_charge
logistics_client_funding
logistics_job_settlement
logistics_job_leg
logistics_job
client_goods_delivery
client_import_payment
client_import_file_reference
client_import_file
money_transfer_deposit
project_balance_movement
project_certificate
project_progress
project_material_issue_line
project_material_issue
project_plan_line
project_plan_version
project_budget_document_line
project_budget_document
project_variation_line
project_variation
project_cost
project_commitment
asset_verification
asset_impairment
asset_transfer
asset_depreciation
fixed_asset
investment_capital_call
investment_disposal
investment_impairment
investment_valuation
investment_income
investment_funding
investment
investment_proposal
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
 where partner_id in (select id from business_partner where code like 'E2E-%');
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

-- A bank or cash account carries exactly one G/L account and the database has
-- the foreign key for it. This runs with the keys down, so deleting an account
-- something still points at does not fail — it leaves a bank account naming a
-- row that is not there.
--
-- That is what happened to CASH-ACCOUNTANT_ERBIL on 2026-09-27: its G/L
-- account was named "E2E ..." and went out with this statement. The account
-- then vanished from its own screen (the list inner-joined the chart until
-- bbe05f1), so the one place that could repair the link was the place the
-- break had hidden it from, and it was reported as "I can't link the cash
-- account to a G/L account".
--
-- Refused rather than cascaded. Deleting the bank account too would destroy
-- something nobody asked to lose, and re-pointing it is a choice about which
-- account the money sits in — the person running the format is the one to
-- make it. Named here, before anything is deleted, so the transaction rolls
-- back whole.
do $fmt$
declare
  v_names text;
begin
  select string_agg(b.code || ' -> ' || a.code || ' ' || a.name, ', ' order by b.code)
    into v_names
    from bank_cash_account b
    join chart_of_account a on a.id = b.gl_account_id
   where a.name like 'E2E %' and not a.is_system;

  if v_names is not null then
    raise exception
      'These bank/cash accounts still carry a G/L account this format would delete: %. '
      'Point them at another account first (Master data -> Bank/Cash accounts), '
      'or remove them. Nothing has been changed.', v_names;
  end if;
end
$fmt$;

delete from chart_of_account where name like 'E2E %' and not is_system;
SQL

# ── The master data itself, only under --master-data ───────────────────────
# Asked for on 2026-09-25: the customers, the suppliers, the items and every
# warehouse but one, so the lists open empty on a system nobody has used yet.
#
# This is a step beyond a format, which is why it is a flag rather than part of
# it. A format leaves a company that can trade tomorrow; this leaves one that
# has to be set up first. The chart of accounts, the branches, the users, the
# payment terms, the calendar, the rates and the posting mappings all stay —
# without them the first invoice has nowhere to post.
#
# The tables below are every one that keys on a partner, an item or a
# warehouse and is not already emptied with the documents. Most belong to
# phases that are not built and hold nothing; they are named anyway, because
# the keys are down while this runs and a table left out leaves rows pointing
# at a record that is gone.
read -r -d '' MASTER_DATA_SQL <<SQL || true
-- Items, and what hangs off one.
delete from item_uom;
delete from price_list_item;
delete from purchase_receipt_tolerance;
delete from item_supplier;
delete from item;

-- Partners, and what hangs off one. The unbuilt phases first.
delete from client_kyc_document;
delete from client_kyc_record;
delete from client_import_file_reference;
delete from client_import_payment;
delete from client_import_file;
delete from opportunity_item;
delete from opportunity;
delete from lead;
delete from crm_activity;
delete from crm_case;
delete from crm_contact;
delete from logistics_job_cost;
delete from logistics_job_leg;
delete from logistics_job_settlement;
delete from logistics_job;
delete from logistics_carrier;
delete from money_transfer_deposit_usage;
delete from money_transfer_deposit;
delete from money_transfer_expense;
delete from money_transfer;
delete from money_transfer_client_account;
delete from investment_proposal;
delete from investment;
delete from project_cost;
delete from project_budget_line;
delete from project;
delete from ap_match_tolerance;
delete from partner_bank_account;
delete from business_partner;

-- Warehouses, all but one. A branch may have no default warehouse; it may not
-- point at one that is gone. Nulled rather than quietly repointed at the one
-- that survives — which warehouse a branch works out of is the company's
-- decision, not this script's.
update branch set default_warehouse_code = null
 where default_warehouse_code is distinct from '${KEEP_WAREHOUSE}';
delete from bin where warehouse_code <> '${KEEP_WAREHOUSE}';
delete from warehouse where code <> '${KEEP_WAREHOUSE}';
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
    union all select 'stock_transfer', count(*) from stock_transfer
    union all select 'stock_adjustment', count(*) from stock_adjustment
    union all select 'supplier_shipment', count(*) from supplier_shipment
    union all select 'opening_stock', count(*) from opening_stock
    union all select 'workflow_instance', count(*) from workflow_instance
    union all select 'attachment', count(*) from attachment
    union all select 'audit_event', count(*) from audit_event
  ) t
 where t.n > 0
 order by 1;

select '';
select 'MASTER DATA POINTING AT SOMETHING GONE (must be empty)';
-- The keys are down while this script runs, so a delete can leave a master
-- record naming a row that no longer exists — and unlike a document, a master
-- record is not re-created by the next day's trading. Reported before and
-- after, because a break that arrives some other way (a restore of one table,
-- a hand-run delete) reads exactly the same from here.
select rpad('bank/cash -> G/L', 22) || b.code || ' names a chart_of_account that is not there'
  from bank_cash_account b
 where not exists (select 1 from chart_of_account a where a.id = b.gl_account_id)
 order by b.code;

select '';
select 'DOCUMENTS WITHOUT THEIR LEDGER ROWS (must be empty)';
-- A stock document whose movements are gone is exactly what an incomplete
-- table list leaves behind. Listed here, before and after, so it is seen.
select rpad(kind, 18) || rpad(document_no, 22) || ' movements: 0'
  from (
    select 'stock_transfer' as kind, t.transfer_no as document_no
      from stock_transfer t
     where not exists (select 1 from inventory_movement m
                        where m.source_document_type = 'stock_transfer'
                          and m.source_document_id = t.id::text)
    union all
    select 'stock_adjustment', a.adjustment_no
      from stock_adjustment a
     where not exists (select 1 from inventory_movement m
                        where m.source_document_type = 'stock_adjustment'
                          and m.source_document_id = a.id::text)
    union all
    select 'ap_invoice', i.invoice_no
      from ap_invoice i
     where i.posted_at is not null
       and exists (select 1 from ap_invoice_line l
                    where l.ap_invoice_id = i.id and l.warehouse_code is not null)
       and not exists (select 1 from inventory_movement m
                        where m.source_document_type = 'ap_invoice'
                          and m.source_document_id = i.id::text)
    union all
    select 'ar_invoice', i.invoice_no
      from ar_invoice i
     where i.posted_at is not null
       and exists (select 1 from ar_invoice_line l
                    where l.ar_invoice_id = i.id and l.warehouse_code is not null)
       and not exists (select 1 from inventory_movement m
                        where m.source_document_type = 'ar_invoice'
                          and m.source_document_id = i.id::text)
  ) o
 order by o.kind, o.document_no;

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

# ── The deletes, written here rather than looped over there ────────────────
# The table list is a variable on this machine. Dropped into a `for` loop
# inside the remote script it arrives as a column of words, and the remote
# shell reads the second line as a command of its own — which is exactly how
# the first attempt at this died, one line into the loop.
#
# So the statements are built here and travel as SQL. That also fixes the
# thing that would have gone wrong next: `set local` lives only as long as the
# transaction it is set in, and a loop calling psql once per table opened a new
# transaction — with the foreign keys back on — for every one of them.
DELETE_SQL=$(printf 'delete from %s;\n' $DOCUMENT_TABLES)

# Only when asked. Empty otherwise, so the transaction below is the same one
# either way and there is no second path to get wrong.
MASTER_SQL=""
if [[ "$MASTER" == "--master-data" ]]; then
  MASTER_SQL="$MASTER_DATA_SQL"
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

-- Triggers and foreign keys, off for this transaction and no longer. The
-- tables come apart children first, and the keys would still refuse an order
-- that is correct overall; the append-only trigger on the audit trail would
-- refuse outright. Lifting them is also why the list has to be complete —
-- with the keys down, nothing tells you what you forgot.
set local session_replication_role = replica;

-- Row-level security is not lifted by that, and a hundred and nine tables
-- force it. A policy that cannot see the reader deletes nothing and says so
-- with a row count of zero, which is the one failure a format can survive
-- while appearing to have worked. The policies all begin with
-- app_is_super_user(), so this is the system's own way past its own door.
select set_config('app.is_super_user', 'true', true);

$DELETE_SQL
$TEST_DATA_SQL
$MASTER_SQL

-- Numbering starts again: there is nothing left for a number to collide with.
-- doc_sequence itself stays — that is the pattern and the prefix, not a count.
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
