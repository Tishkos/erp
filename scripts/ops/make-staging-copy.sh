#!/usr/bin/env bash
#
# Make (or refresh) the staging database from the live one, scrubbed —
# REQ-IMPROVE-001 OP-10 (IM7), decision D-IM-2: same host, separate
# database `erp_staging`, refreshed from this copy, cron disabled.
#
#   scripts/ops/make-staging-copy.sh                 on the server, as root
#   LOCAL_RUN=1 scripts/ops/make-staging-copy.sh     against a local Postgres
#
# What it does, in order:
#   1. pg_dump the source database (default erp) to a temporary file;
#   2. drop and recreate the target (default erp_staging) — never the source:
#      a target named like the source, or named `erp`, is refused;
#   3. pg_restore into the target;
#   4. apply scripts/sql/scrub-staging.sql as the owner: e-mails replaced,
#      hashes and MFA seeds gone, KYC, contacts, partner bank accounts and
#      attachment rows deleted, deliveries suppressed;
#   5. print the counts that prove it (tests/integration/im07 checks the same
#      file against seeded rows).
#
# After it: point the staging app's .env at the target, and create a sign-in
# with `DATABASE_URL_OWNER=<target> npx tsx scripts/ops/ensure-ceo-user.ts`
# — every password hash was removed, so nobody signs in to staging with a
# live password.
#
set -euo pipefail

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { echo "make-staging-copy: $*" >&2; exit 1; }

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5434}"
PGUSER="${PGUSER:-erp_owner}"
SOURCE_DB="${SOURCE_DB:-erp}"
TARGET_DB="${TARGET_DB:-erp_staging}"
APP="${APP:-/opt/qs-erp-next}"
SCRUB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../sql" && pwd)/scrub-staging.sql"
export PGHOST PGPORT PGUSER

[[ "$TARGET_DB" != "$SOURCE_DB" ]] || fail "target and source are the same database ($TARGET_DB)"
[[ "$TARGET_DB" != "erp" ]] || fail "the target may not be the live database name"
[[ -f "$SCRUB" ]] || fail "scrub file missing: $SCRUB"
# REQ-IMPROVE-001 OP-6 (IM4) — the live marker names the live tree; the
# database its .env points at is never a target, whatever it is called.
if [[ -e "$APP/var/LIVE" && -f "$APP/.env" ]]; then
  LIVE_DB=$(grep -oP '^DATABASE_URL=postgres://[^/]+/\K[^?]+' "$APP/.env" || true)
  [[ -z "$LIVE_DB" || "$TARGET_DB" != "$LIVE_DB" ]] || fail "$TARGET_DB is the live database ($APP/var/LIVE); refusing to overwrite it"
fi

if [[ -z "${PGPASSWORD:-}" && -f "$APP/.env" ]]; then
  PGPASSWORD=$(grep -oP '^DATABASE_URL_OWNER=postgres://[^:]+:\K[^@]+' "$APP/.env" || true)
  export PGPASSWORD
fi

STAMP=$(date -u +%Y%m%d-%H%M%S)
DUMP="${TMPDIR:-/tmp}/staging-source-$STAMP.dump"
trap 'rm -f "$DUMP"' EXIT

say "Dumping $SOURCE_DB"
pg_dump -d "$SOURCE_DB" -Fc -f "$DUMP" || fail "pg_dump $SOURCE_DB"

say "Recreating $TARGET_DB"
psql -d postgres -v ON_ERROR_STOP=1 -qc "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$TARGET_DB' and pid <> pg_backend_pid();" >/dev/null
psql -d postgres -v ON_ERROR_STOP=1 -qc "drop database if exists \"$TARGET_DB\";"
psql -d postgres -v ON_ERROR_STOP=1 -qc "create database \"$TARGET_DB\" owner $PGUSER template template0 lc_collate 'C' lc_ctype 'C';"
psql -d postgres -v ON_ERROR_STOP=1 -qc "grant connect on database \"$TARGET_DB\" to erp_app;" || true

say "Restoring into $TARGET_DB"
pg_restore -d "$TARGET_DB" --no-owner --role="$PGUSER" --exit-on-error "$DUMP" || fail "pg_restore"

say "Scrubbing"
psql -d "$TARGET_DB" -v ON_ERROR_STOP=1 -q --single-transaction -f "$SCRUB" || fail "scrub"

say "What survived (every figure below the line must be 0)"
psql -d "$TARGET_DB" -At -v ON_ERROR_STOP=1 <<'SQL'
select 'users:                  ' || count(*) from app_user;
select 'documents (ap+ar):      ' || ((select count(*) from ap_invoice) + (select count(*) from ar_invoice));
select 'journals:               ' || count(*) from journal_entry;
select '---';
select 'users with a real e-mail: ' || count(*) from app_user where email not like '%@staging.invalid';
select 'password hashes:          ' || count(*) from auth_account where password is not null;
select 'mfa seeds:                ' || count(*) from user_mfa;
select 'sessions:                 ' || count(*) from auth_session;
select 'kyc records:              ' || count(*) from client_kyc_record;
select 'crm contacts:             ' || count(*) from crm_contact;
select 'partner bank accounts:    ' || count(*) from partner_bank_account;
select 'partner e-mails/phones:   ' || count(*) from business_partner where email is not null or phone is not null;
select 'attachments:              ' || count(*) from attachment;
select 'pending deliveries:       ' || count(*) from notification_delivery where status = 'pending';
SQL

say "Done: $TARGET_DB is a scrubbed copy of $SOURCE_DB as of $STAMP"
