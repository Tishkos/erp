#!/usr/bin/env bash
#
# The configuration a fresh company needs before anything can be
# posted, applied in one transaction.
#
# Four things stop a brand-new install from recording a journal, and none of
# them announces itself until you have already filled a form in:
#
#   1. No finance department  — journal entries may only be raised from one.
#   2. Nobody holds a role    — approval waits for a role nobody has been given.
#   3. No fiscal year         — a journal posts into a period, and there are none.
#   4. No USD rate            — every posting is measured in IQD *and* USD, so a
#                               journal in IQD still needs a USD rate on its date.
#
# Every one of these is reachable from the UI (Departments, Users, Fiscal
# Periods, Currencies and Rates). This script is the same thing done in one go,
# for an install that has nobody set up yet.
#
# Safe to run twice: every statement is a no-op the second time.
#
set -euo pipefail

APP="${APP:-/opt/qs-erp-next}"

# REQ-IMPROVE-001 OP-6 (IM4) — a company that is already live has its finance
# department, its roles, its fiscal year and its rate; running this against it
# would only ever add a second of something. --i-know-this-is-live is the
# recorded exception for the day the marker is set before the setup is run.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)/live-guard.sh"
[[ "${1:-}" == "--i-know-this-is-live" ]] || refuse_on_live "set up a new company"
PW=$(grep -oP '^DATABASE_URL_OWNER=postgres://erp_owner:\K[^@]+' "$APP/.env")
export PGPASSWORD="$PW"
PSQL=(psql -h 127.0.0.1 -p 5434 -U erp_owner -d erp -v ON_ERROR_STOP=1)

# The rate to seed. The CBI official rate has been 1,320 IQD to the dollar
# since February 2023; change it here, or supersede it later on the Currencies
# and Rates screen, which is where rates are meant to be maintained.
USD_RATE=${USD_RATE:-1320}
FY=${FY:-$(date +%Y)}

"${PSQL[@]}" <<SQL
BEGIN;

-- 1 -------------------------------------------------------------------------
-- The finance department. The flag is what matters, not the code: "which
-- department is Finance?" is configuration, so more than one may carry it.
INSERT INTO department (code, name, is_finance, active)
VALUES ('FIN', 'Finance', true, true)
ON CONFLICT (code) DO UPDATE SET is_finance = true, active = true;

-- Its manager is the administrator, so department-routed documents have
-- somebody to go to. Approval of a journal is a *role*, not this.
UPDATE department
   SET manager_user_id = (SELECT id FROM app_user WHERE email = 'admin@qs-groups.com')
 WHERE code = 'FIN' AND manager_user_id IS NULL;

-- 2 -------------------------------------------------------------------------
-- Both people join it, so either can raise an entry. The administrator manages
-- it; the employee does not.
INSERT INTO user_department_scope (user_id, department_code, is_manager)
SELECT u.id, 'FIN', u.email = 'admin@qs-groups.com'
  FROM app_user u
 WHERE u.email IN ('admin@qs-groups.com', 'employee@qs-groups.com')
ON CONFLICT (user_id, department_code) DO NOTHING;

-- 3 -------------------------------------------------------------------------
-- Approval authority. Super User grants every *permission*, but an approval
-- step asks for a named role and stays silent about it — which is how an
-- administrator ends up unable to approve anything at all.
INSERT INTO user_role (user_id, role_code)
SELECT id, 'accounting_manager' FROM app_user WHERE email = 'admin@qs-groups.com'
ON CONFLICT (user_id, role_code) DO NOTHING;

-- The employee raises entries, so it holds the officer role. Already granted on
-- this install; here so a fresh one is not missing it.
INSERT INTO user_role (user_id, role_code)
SELECT id, 'accounting_officer' FROM app_user WHERE email = 'employee@qs-groups.com'
ON CONFLICT (user_id, role_code) DO NOTHING;

-- 4 -------------------------------------------------------------------------
-- The accounting calendar: one year, twelve open months, named the way the
-- application names them.
INSERT INTO fiscal_year (code, name, starts_on, ends_on, status)
VALUES ('FY${FY}', 'FY${FY}', '${FY}-01-01', '${FY}-12-31', 'open')
ON CONFLICT (code) DO NOTHING;

INSERT INTO fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on, status)
SELECT y.id,
       m::smallint,
       to_char(make_date(${FY}, m, 1), 'FMMonth YYYY'),
       make_date(${FY}, m, 1),
       (make_date(${FY}, m, 1) + interval '1 month - 1 day')::date,
       'open'
  FROM fiscal_year y, generate_series(1, 12) AS m
 WHERE y.code = 'FY${FY}'
   AND NOT EXISTS (SELECT 1 FROM fiscal_period p WHERE p.fiscal_year_id = y.id);

-- 5 -------------------------------------------------------------------------
-- The USD rate. This is the one nobody guesses: §1.1 makes IQD the ledger
-- currency and USD a reporting equivalent, so *every* line needs a USD rate on
-- its posting date, including a line denominated in IQD.
--
-- Dated 1900-01-01 to match the IQD rate, so a back-dated entry is valued too
-- rather than being refused for a reason that reads like a bug.
INSERT INTO exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, source, entered_by)
SELECT 'USD', 'accounting', ${USD_RATE}, '1900-01-01', 'Opening rate — set at system setup',
       (SELECT id FROM app_user WHERE email = 'admin@qs-groups.com')
 WHERE NOT EXISTS (
   SELECT 1 FROM exchange_rate
    WHERE currency_code = 'USD' AND rate_type = 'accounting' AND superseded_at IS NULL
 );

COMMIT;
SQL

echo
echo "--- what the company now has -------------------------------------------"
"${PSQL[@]}" -tAc "select 'finance departments: ' || coalesce(string_agg(code,', '),'(none)') from department where is_finance"
"${PSQL[@]}" -tAc "select 'in finance:          ' || coalesce(string_agg(u.email || case when s.is_manager then ' (manager)' else '' end, ', '),'(nobody)') from user_department_scope s join app_user u on u.id=s.user_id join department d on d.code=s.department_code where d.is_finance"
"${PSQL[@]}" -tAc "select 'roles:               ' || string_agg(u.email || '=' || r.role_code, ', ') from user_role r join app_user u on u.id=r.user_id"
"${PSQL[@]}" -tAc "select 'open periods:        ' || count(*) || ' in ' || string_agg(distinct y.code,', ') from fiscal_period p join fiscal_year y on y.id=p.fiscal_year_id where p.status='open'"
"${PSQL[@]}" -tAc "select 'live rates:          ' || string_agg(currency_code || ' ' || trim(trailing '0' from iqd_per_unit::text) || '0', ', ') from exchange_rate where superseded_at is null"
"${PSQL[@]}" -tAc "select 'accounts may self-approve: ' || s.allow_self_approval from workflow_step s join workflow_definition d on d.id=s.definition_id where d.document_type_code='chart_of_account'"
