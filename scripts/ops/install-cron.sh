#!/usr/bin/env bash
#
# Installs scripts/ops/crontab.erp into root's crontab, between two markers,
# replacing whatever was there — so the crontab on the server is always the
# file in the repository (REQ-IMPROVE-001 OP-7, HARDEN F4). Run by deploy.sh.
set -euo pipefail
APP="${APP:-/opt/qs-erp-next}"
FILE="$APP/scripts/ops/crontab.erp"
BEGIN="# >>> qs-erp (managed by scripts/ops/install-cron.sh — do not edit) >>>"
END="# <<< qs-erp <<<"
current=$(crontab -l 2>/dev/null || true)
# Outside the markers only what is not ours: the lines the first installs
# wrote by hand before the markers existed (a second restore-drill at the same
# minute, a second integrity check) would otherwise run beside the managed
# ones for ever.
outside=$(printf '%s\n' "$current" | awk -v b="$BEGIN" -v e="$END" '$0==b{skip=1;next} $0==e{skip=0;next} !skip' | grep -v -e "$APP/scripts/ops/" -e '^# QS ERP:' || true)
{ printf '%s\n' "$outside"; echo "$BEGIN"; cat "$FILE"; echo "$END"; } | crontab -
mkdir -p /var/log/qs-erp "$APP/var/jobs"
cat > /etc/logrotate.d/qs-erp <<'ROTATE'
/var/log/qs-erp/*.log {
  weekly
  rotate 12
  compress
  missingok
  notifempty
  copytruncate
}
ROTATE
echo "crontab installed from $FILE; logs rotate weekly, 12 kept"
