#!/usr/bin/env bash
#
# Prove that the newest backup can be restored — on the server, into a
# throwaway database, every week.
#
#   scripts/ops/restore-drill.sh            from your machine, over ssh
#   /opt/qs-erp-next/scripts/ops/restore-drill.sh --local   on the server (cron)
#
# A backup nobody has restored is a hope, not a backup. This takes the most
# recent dump in /root/erp-backups, restores it into a database that exists
# only for the length of the drill, and asks the restored copy three things:
#
#   1. did every table come back (the count matches the live database)?
#   2. does the stock ledger in the copy agree with its documents?
#   3. how far behind live is it — the newest document in the copy?
#
# Then it drops the copy. Nothing about the live database is touched, and the
# drill runs as the owner role against a database name no application uses.
#
# Written to /var/log/qs-erp/restore-drill.log by cron; exit 1 on any failure
# so a monitor or a cron mail notices.
#
set -euo pipefail

ERP_SSH="${ERP_SSH:-root@31.97.123.206}"
APP="${APP:-/opt/qs-erp-next}"

if [[ "${1:-}" != "--local" ]]; then
  # Run this same file on the server.
  exec ssh "$ERP_SSH" bash -s -- --local < "$0"
fi

# ── On the server from here ────────────────────────────────────────────────
APP="${APP:-/opt/qs-erp-next}"
BACKUPS=/root/erp-backups
STAMP=$(date -u +%Y%m%d-%H%M%S)
DRILL_DB="erp_restore_drill_$STAMP"

export PGPASSWORD
PGPASSWORD=$(grep -oP '^DATABASE_URL_OWNER=postgres://erp_owner:\K[^@]+' "$APP/.env")
psql() { command psql -h 127.0.0.1 -p 5434 -U erp_owner "$@"; }

say() { printf '\n== %s\n' "$*"; }
fail() { echo "DRILL FAILED: $*" >&2; psql -d postgres -qc "drop database if exists \"$DRILL_DB\"" || true; rm -f "/tmp/restore-drill-$STAMP.dump"; exit 1; }

# The newest *nightly* set (backup.sh, REQ-IMPROVE-001 OP-1), decrypted when
# it was encrypted; a deploy's pre-migration dump in the root is only the
# fallback for a server the nightly job has never run on. A partial dump
# (reset-statement-mapping.sh writes a two-table one) is never picked, and a
# set older than 26 hours fails the drill: the drill proves the backup that
# would be restored tonight, not one from last month (IM1).
NIGHTLY_SET=$(ls -1d "$BACKUPS"/nightly/*/ 2>/dev/null | sort | tail -1)
DRILL_STARTED=$(date -u +%s)
if [[ -n "$NIGHTLY_SET" ]]; then
  DUMP=$(ls "$NIGHTLY_SET"erp-*.dump "$NIGHTLY_SET"erp-*.dump.age 2>/dev/null | head -1)
  [[ -n "$DUMP" ]] || fail "the newest nightly set $NIGHTLY_SET holds no erp-*.dump"
  if [[ "$DUMP" == *.age ]]; then
    [[ -f /etc/qs-erp/backup.env ]] && { set -a; . /etc/qs-erp/backup.env; set +a; }
    [[ -n "${AGE_IDENTITY:-}" ]] || fail "the set is encrypted and AGE_IDENTITY is not set in /etc/qs-erp/backup.env"
    CLEAR="/tmp/restore-drill-$STAMP.dump"
    age -d -i "$AGE_IDENTITY" -o "$CLEAR" "$DUMP" || fail "could not decrypt $DUMP"
    DUMP_SOURCE="$DUMP"; DUMP="$CLEAR"
  fi
  AGE_HOURS=$(( ( $(date -u +%s) - $(date -u -r "${DUMP_SOURCE:-$DUMP}" +%s) ) / 3600 ))
  [[ "${1:-}" == "--any" || "$AGE_HOURS" -le 26 ]] || fail "the newest nightly set is $AGE_HOURS hours old — the backup job is not running"
else
  DUMP=$(ls -t "$BACKUPS"/db-before-*.dump 2>/dev/null | head -1)
  [[ -n "$DUMP" ]] || fail "no nightly set under $BACKUPS/nightly and no deploy dump in $BACKUPS — run backup.sh"
  say "WARNING: no nightly set yet; drilling the newest deploy dump instead"
fi
say "Restore drill $STAMP — $DUMP ($(du -h "$DUMP" | cut -f1), $(date -u -r "$DUMP" +%Y-%m-%dT%H:%MZ))"

# A fresh database, owned by the owner role like the live one. The app role
# must exist for the dump's grants to apply, and it does on this server.
psql -d postgres -v ON_ERROR_STOP=1 -qc "create database \"$DRILL_DB\" owner erp_owner template template0 encoding 'UTF8' lc_collate 'C' lc_ctype 'C'" \
  || fail "could not create $DRILL_DB"

# --no-owner/--no-acl are deliberately NOT passed: the drill restores the
# dump exactly as a real recovery would, roles and grants included.
if ! pg_restore -h 127.0.0.1 -p 5434 -U erp_owner -d "$DRILL_DB" --exit-on-error "$DUMP" 2> "/tmp/restore-drill-$STAMP.err"; then
  cat "/tmp/restore-drill-$STAMP.err" >&2
  fail "pg_restore reported errors"
fi

# 1. Every table came back.
LIVE_TABLES=$(psql -d erp -tAc "select count(*) from pg_tables where schemaname='public'")
COPY_TABLES=$(psql -d "$DRILL_DB" -tAc "select count(*) from pg_tables where schemaname='public'")
say "Tables: live $LIVE_TABLES, restored $COPY_TABLES"
[[ "$LIVE_TABLES" == "$COPY_TABLES" ]] || fail "the restored copy has $COPY_TABLES tables, the live database $LIVE_TABLES"

# 2. The restored ledger agrees with its documents — the same questions the
#    nightly check asks, in SQL so the drill needs nothing but psql.
ORPHANS=$(psql -d "$DRILL_DB" -tAc "
  select set_config('app.is_super_user','true',false);
  select count(*) from (
    select 1 from stock_transfer t where not exists (select 1 from inventory_movement m where m.source_document_type='stock_transfer' and m.source_document_id=t.id::text)
    union all select 1 from stock_adjustment a where not exists (select 1 from inventory_movement m where m.source_document_type='stock_adjustment' and m.source_document_id=a.id::text)
    union all select 1 from ap_invoice i where i.posted_at is not null and exists (select 1 from ap_invoice_line l where l.ap_invoice_id=i.id and l.warehouse_code is not null) and not exists (select 1 from inventory_movement m where m.source_document_type='ap_invoice' and m.source_document_id=i.id::text)
    union all select 1 from ar_invoice i where i.posted_at is not null and exists (select 1 from ar_invoice_line l where l.ar_invoice_id=i.id and l.warehouse_code is not null) and not exists (select 1 from inventory_movement m where m.source_document_type='ar_invoice' and m.source_document_id=i.id::text)
  ) o" | tail -1)
ADRIFT=$(psql -d "$DRILL_DB" -tAc "
  select set_config('app.is_super_user','true',false);
  with p as (select item_code, warehouse_code, sum(quantity) q from inventory_movement group by 1,2),
       l as (select item_code, warehouse_code, sum(remaining_quantity) q from cost_layer group by 1,2)
  select count(*) from p left join l using (item_code, warehouse_code) where p.q < 0 or p.q <> coalesce(l.q, 0)" | tail -1)
say "Ledger in the copy: $ORPHANS document(s) without rows, $ADRIFT position(s) adrift"
[[ "$ORPHANS" == "0" && "$ADRIFT" == "0" ]] || fail "the restored ledger is not clean"

# 3. How far behind live the copy is.
NEWEST=$(psql -d "$DRILL_DB" -tAc "
  select set_config('app.is_super_user','true',false);
  select coalesce(max(t)::text, 'nothing posted') from (
    select max(posted_at) t from ap_invoice union all select max(posted_at) from ar_invoice
    union all select max(created_at) from inventory_movement union all select max(posted_at) from journal_entry) x" | tail -1)
COUNTS=$(psql -d "$DRILL_DB" -tAc "
  select set_config('app.is_super_user','true',false);
  select 'journals '||(select count(*) from journal_entry)||', movements '||(select count(*) from inventory_movement)||', invoices '||(select count(*) from ap_invoice)+(select count(*) from ar_invoice)" | tail -1)
say "Restored copy holds $COUNTS; newest posting $NEWEST"

# 4. What the recovery runbook's own verifier says — RLS forced, grants in
#    place, migrations at head, the ledger balanced (IM1).
if [[ -f "$APP/scripts/verify-recovery.ts" ]]; then
  (cd "$APP" && DATABASE_URL_OWNER="postgres://erp_owner:$PGPASSWORD@127.0.0.1:5434/$DRILL_DB" npx tsx scripts/verify-recovery.ts "$DRILL_DB") \
    || fail "verify-recovery.ts did not pass on the restored copy"
fi

psql -d postgres -qc "drop database \"$DRILL_DB\""
rm -f "/tmp/restore-drill-$STAMP.err" "/tmp/restore-drill-$STAMP.dump"
say "Restore drill $STAMP PASSED in $(( $(date -u +%s) - DRILL_STARTED ))s — $DUMP restores cleanly and its ledger agrees with its documents."
