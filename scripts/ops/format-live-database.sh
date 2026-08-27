#!/bin/bash
set -euo pipefail
APP=/opt/qs-erp-next
STAMP=$(date +%Y%m%d-%H%M)
PW=$(grep -oP '^DATABASE_URL_OWNER=postgres://erp_owner:\K[^@]+' "$APP/.env")
export PGPASSWORD="$PW"
psql() { command psql -h 127.0.0.1 -p 5434 -U erp_owner -d erp "$@"; }

echo "=== 1. Back up first — this is not reversible without it"
mkdir -p /root/erp-backups
pg_dump -h 127.0.0.1 -p 5434 -U erp_owner -d erp -Fc \
  -f "/root/erp-backups/erp-before-format-$STAMP.dump"
ls -la "/root/erp-backups/erp-before-format-$STAMP.dump"

echo "=== 2. Clear every document and everything they left behind"
# The guards that refuse deletion in production are lifted for the length of
# this transaction only — that is what makes this a format rather than an
# ordinary day's work.
psql -v ON_ERROR_STOP=1 <<'SQL'
begin;
set local session_replication_role = replica;

-- Documents.
delete from invoice_line;
delete from invoice;
delete from journal_line;
delete from journal_entry;

-- What approval left behind.
delete from workflow_decision;
delete from workflow_instance;

-- Numbering: the counters go back to the beginning, because there is nothing
-- left for a number to collide with.
delete from doc_number_allocation;
do $$
declare r record;
begin
  for r in select c.relname from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
           where c.relkind = 'S' and n.nspname = 'public' and c.relname like 'docseq_%'
  loop
    execute format('select setval(%L, 1, false)', r.relname);
  end loop;
end $$;

-- The accounting calendar and the rates entered against it.
delete from fiscal_period;
delete from fiscal_year;
delete from exchange_rate;

-- The chart, less the five type roots and the cash account the branch needs.
delete from account_required_dimension
 where account_id in (select id from chart_of_account where not is_system and code <> 'A100001');
delete from chart_of_account where not is_system and code <> 'A100001';

-- Departments and who was in them.
delete from user_department_scope;
delete from department;

-- Attachments.
delete from attachment_access;
delete from attachment;

-- Sessions: everyone signs in again.
delete from auth_session;

-- And the trail of all of it. Last, so everything above is still guarded by it
-- until the moment it goes.
delete from audit_event;

commit;
SQL

echo "=== 3. What is left"
psql -tAc "select 'company:      ' || coalesce(string_agg(code || ' · ' || legal_name, ', '), '(none)') from company"
psql -tAc "select 'branches:     ' || coalesce(string_agg(code || ' · ' || name, ', '), '(none)') from branch"
psql -tAc "select 'users:        ' || coalesce(string_agg(email, ', '), '(none)') from app_user where is_active"
psql -tAc "select 'roles:        ' || coalesce(string_agg(code, ', '), '(none)') from role"
psql -tAc "select 'departments:  ' || coalesce(string_agg(code, ', '), '(none)') from department"
psql -tAc "select 'accounts:     ' || coalesce(string_agg(code, ', ' order by code), '(none)') from chart_of_account"
for t in invoice journal_entry fiscal_year exchange_rate audit_event workflow_instance doc_number_allocation attachment; do
  psql -tAc "select '$t: ' || count(*) from $t"
done
