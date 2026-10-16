#!/usr/bin/env bash
#
# The demo — https://accounting.qs-groups.com (2026-10-16, by direction: "replace
# accounting with a demo version of this … logins with admin and admin … one user,
# a different new database").
#
# Runs ON THE SERVER, as root, from the deployed tree:
#
#   ssh root@31.97.123.206 'bash /opt/qs-erp-next/scripts/ops/demo-instance.sh create'
#   ssh root@31.97.123.206 'bash /opt/qs-erp-next/scripts/ops/demo-instance.sh refresh'
#
# create   once: the database erp_demo built from nothing (migrations, the company's
#          setup, the chart, the stage warehouses), the one account admin / admin,
#          the tree /opt/qs-erp-demo with its own .env, the pm2 process qs-erp-demo
#          on 127.0.0.1:3300, and the vhost (the one it replaces is kept under
#          /root/nginx-backups/). The Odoo trial that answered at this name was
#          removed for good on 2026-10-16, by direction.
# refresh  the live tree's current build copied in, the demo database migrated, the
#          process restarted. deploy.sh runs it after every live deploy.
#
# What keeps it away from the live books:
#   * its own database, erp_demo, named in its own .env; every step that touches a
#     database runs with ONLY that .env (env -i, dotenv pointed at it) and the
#     database is asked its name before anything is written;
#   * the live build carries a copy of the live .env (next build copies it into
#     .next/standalone) — the demo's copy of the build has it removed, and the keys
#     that would reach the outside (mail, reCAPTCHA, the AI key) are set empty;
#   * ERP_DEMO=on, which the application ignores on a database named erp
#     (domain/demo.ts); no crontab, no WhatsApp bridge, no var/LIVE;
#   * its own attachment store, logs, secrets (BETTER_AUTH_SECRET, ERP_SECRET_KEY
#     generated here, never the live ones).
# It shares the database roles (the migrations grant to erp_app by name) and the
# host — the same box, so anyone who can read its .env could already read the
# live one.
set -euo pipefail

LIVE=/opt/qs-erp-next
DEMO=/opt/qs-erp-demo
DB=erp_demo
PORT=3300
PM2_NAME=qs-erp-demo
HOST=accounting.qs-groups.com
FILES=/var/lib/qs-erp-demo/attachments
LOGS=/var/log/qs-erp-demo

[[ "$DB" != "erp" ]] || { echo "Refusing: the demo database cannot be the live one." >&2; exit 1; }

say() { printf '\n== %s\n' "$*"; }

# A connection string of the live .env with its database swapped for $2.
url_for() {
  local value
  value=$(sed -n "s/^$1=//p" "$LIVE/.env" | head -n 1)
  if [[ ! "$value" =~ ^(postgres(ql)?://.+)/erp(\?[^/]*)?$ ]]; then
    echo "$1 in $LIVE/.env does not end in /erp; refusing to guess the demo's." >&2
    exit 1
  fi
  printf '%s/%s%s' "${BASH_REMATCH[1]}" "$2" "${BASH_REMATCH[3]}"
}

# Runs "$@" in the live tree (its node_modules, src and scripts) with nothing but
# the demo's environment: env -i, the demo .env exported, and dotenv/config told
# to read that file — so the live .env is never read by anything run here.
in_demo() {
  (
    cd "$LIVE"
    env -i PATH="$PATH" HOME="$HOME" LC_ALL=C.UTF-8 DEMO_ENV="$DEMO/.env" \
      bash -c 'set -a; . "$DEMO_ENV"; set +a; export DOTENV_CONFIG_PATH="$DEMO_ENV"; exec "$@"' bash "$@"
  )
}

# The database the demo's .env names, asked of PostgreSQL — both connection strings.
assert_demo_db() {
  local key name
  for key in DATABASE_URL_OWNER DATABASE_URL; do
    name=$(in_demo bash -c "psql \"\$$key\" -Atc 'select current_database()'")
    if [[ "$name" != "$DB" ]]; then
      echo "Refusing: $key in $DEMO/.env reaches '$name', not $DB." >&2
      exit 1
    fi
  done
  echo "the demo's .env reaches $DB, both as the owner and as the application"
}

copy_build() {
  local from="$LIVE/.next/standalone"
  [[ -f "$from/server.js" ]] || { echo "No build at $from." >&2; exit 1; }
  rm -rf "$DEMO/standalone.next"
  cp -a "$from" "$DEMO/standalone.next"
  # next build copies the tree's .env into the standalone bundle: never the demo's.
  find "$DEMO/standalone.next" -maxdepth 1 -name '.env*' -delete
  if [[ -n "$(find "$DEMO/standalone.next" -maxdepth 1 -name '.env*')" ]]; then
    echo "Refusing: the copied build still carries an .env." >&2
    exit 1
  fi
  cp "$LIVE/REVISION" "$DEMO/REVISION"
  cp "$LIVE/REVISION" "$DEMO/standalone.next/REVISION"
  rm -rf "$DEMO/standalone.prev"
  if [[ -d "$DEMO/standalone" ]]; then mv "$DEMO/standalone" "$DEMO/standalone.prev"; fi
  mv "$DEMO/standalone.next" "$DEMO/standalone"
  rm -rf "$DEMO/standalone.prev"
  echo "build $(cut -c1-12 "$DEMO/REVISION") copied"
}

write_env() {
  local owner app
  owner=$(url_for DATABASE_URL_OWNER "$DB")
  app=$(url_for DATABASE_URL "$DB")
  (
    umask 077
    cat > "$DEMO/.env" <<EOF
# The demo — https://$HOST (scripts/ops/demo-instance.sh). NOT the live books.
NODE_ENV=production
APP_ENV=demo
ERP_DEMO=on
DATABASE_URL=$app
DATABASE_URL_OWNER=$owner
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
BETTER_AUTH_URL=https://$HOST
ERP_SECRET_KEY=$(openssl rand -base64 48)
ATTACHMENT_DIR=$FILES
ERP_TIMEZONE=Asia/Baghdad
LEDGER_CURRENCY=IQD
REPORTING_CURRENCY=USD
LOG_LEVEL=info
ERP_ERROR_LOG=$LOGS/pm2-error.log
JOB_STATE_DIR=$DEMO/var/jobs
JOB_LOG_DIR=$LOGS
BACKUP_ROOT=$DEMO/var/backups
ERP_ISSUES_FILE=$DEMO/var/issues/reported-issues.md
NOAH_NOTES_DIR=$DEMO/var/noah
NOAH_ALERTS_FILE=$DEMO/var/noah/alerts.json
NOAH_APP_URL=http://127.0.0.1:$PORT
NOAH_LIVE_SHOTS=off
# Nothing that reaches the outside: no mail, no captcha, no AI key.
SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASS=
MAIL_FROM=
RECAPTCHA_SITE_KEY=
RECAPTCHA_SECRET_KEY=
ANTHROPIC_API_KEY=
EOF
  )
  echo "$DEMO/.env written (mode 600, its own secrets)"
}

write_ecosystem() {
  cat > "$DEMO/ecosystem.config.cjs" <<EOF
// pm2 process file for the demo — written by scripts/ops/demo-instance.sh.
// It reads $DEMO/.env itself, so a restart or a reboot keeps the demo's
// environment; it never sees the live one.
const fs = require('fs');
const env = {};
for (const line of fs.readFileSync('$DEMO/.env', 'utf8').split('\n')) {
  const found = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (found) env[found[1]] = found[2];
}
module.exports = {
  apps: [
    {
      name: '$PM2_NAME',
      cwd: '$DEMO',
      script: '$DEMO/standalone/server.js',
      node_args: '--max-old-space-size=768',
      max_memory_restart: '900M',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      kill_timeout: 15000,
      env: { ...env, NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: $PORT },
      error_file: '$LOGS/pm2-error.log',
      out_file: '$LOGS/pm2-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
EOF
}

migrate() {
  in_demo npx tsx src/server/db/migrate.ts
}

start_process() {
  pm2 startOrRestart "$DEMO/ecosystem.config.cjs" --update-env
  pm2 save >/dev/null
  local attempt code
  for attempt in $(seq 1 30); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT/healthz" || true)
    if [[ "$code" == "200" ]]; then
      echo "demo on :$PORT -> healthz 200"
      return 0
    fi
    sleep 2
  done
  echo "The demo did not answer /healthz (last: $code). Logs: $LOGS/pm2-error.log" >&2
  exit 1
}

create() {
  [[ ! -e "$DEMO" ]] || { echo "$DEMO exists already: use refresh." >&2; exit 1; }

  say "Database $DB"
  local admin_url
  admin_url=$(url_for DATABASE_URL_OWNER postgres)
  if [[ -n "$(psql "$admin_url" -Atc "select 1 from pg_database where datname = '$DB'")" ]]; then
    echo "Database $DB exists already; refusing to build over it." >&2
    exit 1
  fi
  psql "$admin_url" -v ON_ERROR_STOP=1 -qc "create database $DB owner erp_owner template template0 encoding 'UTF8' lc_collate 'C' lc_ctype 'C'"
  psql "$(url_for DATABASE_URL_OWNER "$DB")" -v ON_ERROR_STOP=1 -qc "grant connect on database $DB to erp_app"
  echo "created $DB"

  say "Tree $DEMO"
  mkdir -p "$DEMO"/var/{jobs,noah,issues,backups} "$FILES" "$LOGS"
  chmod 700 "$DEMO"
  write_env
  write_ecosystem
  assert_demo_db
  copy_build

  say "Migrations"
  migrate

  say "The company"
  # The marker new-company-setup.sh sees is the live tree's (/opt/qs-erp-next/var/LIVE);
  # what it writes is the database "$APP/.env" names — erp_demo, asked above.
  in_demo env APP="$DEMO" bash scripts/ops/new-company-setup.sh --i-know-this-is-live
  # The way in, then the demo's own password (demo-admin.ts refuses anything but the demo).
  local out
  if ! out=$(in_demo npx tsx scripts/ops/create-first-user.ts admin@demo.qs-groups.com "Demo Admin" HQ "Head Office" 2>&1); then
    printf '%s\n' "$out" | grep -viE 'password' >&2
    exit 1
  fi
  printf '%s\n' "$out" | grep -viE 'password' || true
  in_demo npx tsx scripts/ops/demo-admin.ts
  in_demo npx tsx scripts/ops/ensure-chart-of-accounts.ts --branch HQ
  in_demo npx tsx scripts/ops/ensure-stage-warehouses.ts --branch HQ
  in_demo npx tsx scripts/ops/ensure-user-employees.ts --apply

  say "Process $PM2_NAME"
  start_process

  say "https://$HOST"
  local vhost="/etc/nginx/sites-available/$HOST" kept
  mkdir -p /root/nginx-backups
  if [[ -f "$vhost" ]]; then
    kept="/root/nginx-backups/$HOST.$(date +%Y%m%d-%H%M%S)"
    cp -a "$vhost" "$kept"
    echo "the vhost it replaces is kept as $kept"
  fi
  cp "$LIVE/deploy/nginx.demo.conf" "$vhost"
  ln -sfn "$vhost" "/etc/nginx/sites-enabled/$HOST"
  if ! nginx -t; then
    echo "nginx refused the demo's vhost; putting the old one back." >&2
    if [[ -n "${kept:-}" ]]; then cp -a "$kept" "$vhost"; fi
    nginx -t && systemctl reload nginx
    exit 1
  fi
  systemctl reload nginx

  say "Done"
  printf 'https://%s/sign-in -> %s\n' "$HOST" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$HOST/sign-in" || echo '?')"
  echo "Sign in with the user name admin and the password admin."
}

refresh() {
  [[ -d "$DEMO" ]] || { echo "No demo at $DEMO: run create first." >&2; exit 1; }
  say "Demo refresh"
  assert_demo_db
  copy_build
  migrate
  start_process
}

case "${1:-}" in
  create) create ;;
  refresh) refresh ;;
  *)
    echo "usage: bash $0 create | refresh" >&2
    exit 2
    ;;
esac
