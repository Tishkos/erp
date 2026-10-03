#!/usr/bin/env bash
#
# Runs one scheduled job the way every scheduled job should run
# (REQ-IMPROVE-001 OP-7): under a lock, under a timeout, into its own log,
# with its exit code written where the health check reads it.
#
#   run-job.sh <name> <timeout-seconds> <command…>
#
set -uo pipefail
NAME="$1"; TIMEOUT="$2"; shift 2
APP="${APP:-/opt/qs-erp-next}"
LOG="${LOG:-/var/log/qs-erp}"
STATE="$APP/var/jobs"
mkdir -p "$LOG" "$STATE"
LOCK="/run/lock/qs-erp-$NAME.lock"

{
  printf '== %s start %s\n' "$(date -u +%FT%TZ)" "$NAME"
  cd "$APP" || exit 2
  set -a; [[ -f .env ]] && . ./.env; set +a
  flock -n 9 || { echo "another run of $NAME is still going; this one exits"; exit 3; }
  started=$(date -u +%s)
  timeout --kill-after=60 "$TIMEOUT" "$@"
  code=$?
  seconds=$(( $(date -u +%s) - started ))
  printf '== %s end %s exit=%s after %ss\n' "$(date -u +%FT%TZ)" "$NAME" "$code" "$seconds"
  # "<when> <exit> <seconds>" — read by health-check.ts and the Background
  # Jobs screen (services/scheduled-jobs.ts parseLastRun).
  printf '%s %s %s\n' "$(date -u +%FT%TZ)" "$code" "$seconds" > "$STATE/$NAME.last"
  exit $code
} 9>"$LOCK" >> "$LOG/$NAME.log" 2>&1
