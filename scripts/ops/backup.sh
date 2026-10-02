#!/usr/bin/env bash
#
# The nightly backup — REQ-IMPROVE-001 OP-1 (IM1).
#
#   /opt/qs-erp-next/scripts/ops/backup.sh            on the server (cron, 01:00)
#   scripts/ops/backup.sh                             from your machine, over ssh
#
# What one run writes to /root/erp-backups/nightly/<stamp>/:
#
#   erp-<stamp>.dump          pg_dump -Fc of the live database (custom format,
#                             what restore-drill.sh and the recovery runbook
#                             restore)
#   globals-<stamp>.sql       pg_dumpall --globals-only: the roles. A dump
#                             without them cannot be restored on a new host.
#   attachments-<stamp>.tgz   the attachment store — pg_dump does not carry
#                             files, and a book without its evidence is half
#                             a book
#   manifest.txt              sizes, sha256, the git revision that was running
#   offsite.txt               when and where rclone copied the set (absent = it did not)
#
# With AGE_RECIPIENT set, each file is encrypted with `age` and the clear copy
# removed: the backups hold password hashes, TOTP seeds and KYC identity
# documents and must not sit readable on the same disk as the database.
# With RCLONE_REMOTE set (e.g. "b2:qs-erp-backups"), the set is copied off the
# server; the recovery point then survives the server. Both are read from
# /etc/qs-erp/backup.env so no secret is in this file.
#
# Rotation (D-IM-4): 7 daily, then one per week for 4 weeks, one per month
# for 12 months, one per year for 7 years. Older sets are removed locally;
# the off-site copy keeps whatever its own lifecycle rule says.
#
# Exit 1 on any failure so cron mail or the health check notices; the health
# check also fails when the newest set is older than 26 hours (IM1).
set -euo pipefail

ERP_SSH="${ERP_SSH:-root@31.97.123.206}"
if [[ "${1:-}" != "--local" && -z "${LOCAL_RUN:-}" ]]; then
  exec ssh "$ERP_SSH" bash -s -- --local < "$0"
fi

APP="${APP:-/opt/qs-erp-next}"
ROOT="${BACKUP_ROOT:-/root/erp-backups}"
NIGHTLY="$ROOT/nightly"
STAMP=$(date -u +%Y%m%d-%H%M%S)
SET="$NIGHTLY/$STAMP"
[[ -f /etc/qs-erp/backup.env ]] && { set -a; . /etc/qs-erp/backup.env; set +a; }

export PGPASSWORD
PGPASSWORD="${PGPASSWORD:-$(grep -oP '^DATABASE_URL_OWNER=postgres://erp_owner:\K[^@]+' "$APP/.env" 2>/dev/null || true)}"
[[ -n "$PGPASSWORD" ]] || { echo "BACKUP FAILED: no PGPASSWORD and no DATABASE_URL_OWNER in $APP/.env" >&2; exit 1; }
PGHOST="${PGHOST:-127.0.0.1}"; PGPORT="${PGPORT:-5434}"; PGUSER="${PGUSER:-erp_owner}"; PGDATABASE="${PGDATABASE:-erp}"
ATTACHMENTS=$(grep -oP '^ATTACHMENT_DIR=\K.*' "$APP/.env" 2>/dev/null || true)
ATTACHMENTS="${ATTACHMENTS:-$APP/var/attachments}"

say() { printf '== %s %s\n' "$(date -u +%FT%TZ)" "$*"; }
fail() { say "BACKUP FAILED: $*" >&2; exit 1; }

mkdir -p "$SET"
say "Backup $STAMP → $SET"

pg_dump -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -Fc -f "$SET/erp-$STAMP.dump" || fail "pg_dump"
pg_dumpall -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --globals-only > "$SET/globals-$STAMP.sql" || fail "pg_dumpall --globals-only"
if [[ -d "$ATTACHMENTS" ]]; then
  tar -czf "$SET/attachments-$STAMP.tgz" -C "$(dirname "$ATTACHMENTS")" "$(basename "$ATTACHMENTS")" || fail "attachments"
else
  say "no attachment directory at $ATTACHMENTS — nothing to copy (check ATTACHMENT_DIR in $APP/.env)"
fi

{
  echo "stamp=$STAMP"
  echo "revision=$(cat "$APP/REVISION" 2>/dev/null || echo unknown)"
  echo "database=$PGDATABASE@$PGHOST:$PGPORT"
  echo "attachments=$ATTACHMENTS"
  (cd "$SET" && for f in ./*.dump ./*.sql ./*.tgz; do [[ -f "$f" ]] && sha256sum "$f"; done; true)
  du -sh "$SET"/* | sed 's/^/size /'
} > "$SET/manifest.txt"

if [[ -n "${AGE_RECIPIENT:-}" ]]; then
  command -v age >/dev/null || fail "AGE_RECIPIENT is set but age is not installed"
  for f in "$SET"/*.dump "$SET"/*.sql "$SET"/*.tgz; do
    [[ -f "$f" ]] || continue
    age -r "$AGE_RECIPIENT" -o "$f.age" "$f" && rm -f "$f" || fail "age $f"
  done
  say "encrypted for $AGE_RECIPIENT"
else
  say "WARNING: AGE_RECIPIENT not set — the set is not encrypted (OP-1). Set it in /etc/qs-erp/backup.env."
fi

if [[ -n "${RCLONE_REMOTE:-}" ]]; then
  command -v rclone >/dev/null || fail "RCLONE_REMOTE is set but rclone is not installed"
  rclone copy "$SET" "$RCLONE_REMOTE/nightly/$STAMP" --checksum || fail "rclone copy"
  # The marker the Backup and Health screen reads; written after the copy
  # succeeded, so a set without it is a set that never left the server.
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$RCLONE_REMOTE/nightly/$STAMP" > "$SET/offsite.txt"
  say "copied off the server to $RCLONE_REMOTE/nightly/$STAMP"
else
  say "WARNING: RCLONE_REMOTE not set — nothing left the server (OP-1). Set it in /etc/qs-erp/backup.env."
fi

# ── Rotation ───────────────────────────────────────────────────────────────
# Keep: every set from the last 7 days; the first set of each ISO week for 4
# weeks; the first set of each month for 12 months; the first of each year
# for 7 years. Everything else under nightly/ goes.
now=$(date -u +%s)
declare -A keep_week keep_month keep_year
for dir in $(ls -1 "$NIGHTLY" 2>/dev/null | sort); do
  [[ "$dir" =~ ^[0-9]{8}-[0-9]{6}$ ]] || continue
  day="${dir:0:8}"
  ts=$(date -u -d "${day:0:4}-${day:4:2}-${day:6:2}" +%s)
  age_days=$(( (now - ts) / 86400 ))
  week=$(date -u -d "${day:0:4}-${day:4:2}-${day:6:2}" +%G-%V)
  month="${day:0:6}"; year="${day:0:4}"
  keep=0
  (( age_days <= 7 )) && keep=1
  if (( age_days <= 28 )) && [[ -z "${keep_week[$week]:-}" ]]; then keep_week[$week]=1; keep=1; fi
  if (( age_days <= 366 )) && [[ -z "${keep_month[$month]:-}" ]]; then keep_month[$month]=1; keep=1; fi
  if (( age_days <= 7*366 )) && [[ -z "${keep_year[$year]:-}" ]]; then keep_year[$year]=1; keep=1; fi
  if (( keep == 0 )); then say "rotating out $dir"; rm -rf "${NIGHTLY:?}/$dir"; fi
done

say "Backup $STAMP done — $(du -sh "$SET" | cut -f1)"
