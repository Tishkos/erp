#!/usr/bin/env bash
#
# Deploy to erp.qs-groups.com. Run from the project root on your own machine —
# not on the server. The repository only exists locally, and this copies from
# here to there.
#
# Written from a deploy that was actually performed, not from assumptions. The
# things that bit, so they do not bite again:
#
#   * The app is deployed in place at /opt/qs-erp-next. pm2 runs the absolute
#     path .next/standalone/server.js, so a releases/current symlink scheme
#     would leave pm2 running the old code. Do not "improve" this into
#     symlinked releases without also changing ecosystem.config.cjs.
#   * It listens on 3200, behind nginx. Not 3000.
#   * `next build` with output: 'standalone' does not put the static assets
#     inside the bundle. They are copied in below. Skip that and every page
#     renders with no CSS and no JS — which looks like a broken application
#     rather than a missing copy.
#   * The server runs npm 10. npm 11 writes a lock file it rejects, so the
#     lock must be generated with `npx npm@10 install --package-lock-only`.
#   * .env and ecosystem.config.cjs live on the server and are not in git, so
#     `git archive` cannot clobber them. That is why the upload is an archive
#     of tracked files and not an rsync of the working directory.
#
# The box hosts thirteen other sites. Everything here is scoped to qs-erp.
#
# Usage:  scripts/ops/deploy.sh
#
set -euo pipefail

ERP_SSH="${ERP_SSH:-root@31.97.123.206}"
APP=/opt/qs-erp-next
PM2_NAME="${PM2_NAME:-qs-erp}"
PORT="${PORT:-3200}"
PUBLIC_URL="${PUBLIC_URL:-https://erp.qs-groups.com/sign-in}"

STAMP=$(date -u +%Y%m%d-%H%M%S)
TARBALL="/tmp/qs-erp-$STAMP.tar.gz"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# ── Refuse to ship something nobody can point at ──────────────────────────
say "Checking the tree"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is dirty. Commit or stash first:" >&2
  git status --short >&2
  exit 1
fi
COMMIT=$(git rev-parse --short HEAD)
echo "shipping $(git rev-parse --abbrev-ref HEAD) @ $COMMIT"

say "Type check and unit tests"
npm run typecheck
npm run test:unit

# ── Upload tracked files only ─────────────────────────────────────────────
# This is what keeps vps.md, var/attachments and the reference images out of
# the upload without anyone having to remember they exist.
say "Uploading"
git archive --format=tar.gz -o "$TARBALL" HEAD
scp "$TARBALL" "$ERP_SSH:$TARBALL"
rm -f "$TARBALL"

# ── Back up, install, migrate, build, restart ─────────────────────────────
say "Deploying"
ssh "$ERP_SSH" bash -euo pipefail -s <<REMOTE
APP=$APP
STAMP=$STAMP
PM2_NAME=$PM2_NAME
PORT=$PORT

mkdir -p /root/erp-backups
PW=\$(grep -oP '^DATABASE_URL_OWNER=postgres://erp_owner:\K[^@]+' "\$APP/.env")

# Both backups before anything moves. The database one is the only way back
# from a bad migration; the app one is the only way back from a bad build.
# Delete them once the deploy is confirmed, not before.
PGPASSWORD="\$PW" pg_dump -h 127.0.0.1 -p 5434 -U erp_owner -d erp -Fc \
  -f "/root/erp-backups/db-before-\$STAMP.dump"
tar -czf "/root/erp-backups/app-before-\$STAMP.tgz" \
  -C /opt --exclude=qs-erp-next/node_modules qs-erp-next
echo "backups in /root/erp-backups"

cd "\$APP"
tar -xzf "$TARBALL" -C "\$APP"
rm -f "$TARBALL"

npm ci

# Migrations before the restart. Drizzle records what it has applied, so this
# is a no-op on a database already at head rather than an error.
set -a; . ./.env; set +a
npm run db:migrate

npm run build

# The standalone bundle ships server.js and its node_modules, but not these.
rm -rf .next/standalone/.next/static
cp -r .next/static .next/standalone/.next/static
[ -d public ] && cp -r public .next/standalone/public

pm2 restart "\$PM2_NAME" --update-env
pm2 save
REMOTE

# ── Did it come up? ───────────────────────────────────────────────────────
# pm2 reports the process started, which is not the same as the app answering.
say "Health check"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  code=$(ssh "$ERP_SSH" "curl -s -o /dev/null -w '%{http_code}' --max-time 15 http://127.0.0.1:$PORT/sign-in" || true)
  if [[ "$code" == "200" ]]; then
    echo "app on :$PORT -> 200"
    public=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$PUBLIC_URL" || echo "?")
    echo "$PUBLIC_URL -> $public"
    say "Deployed $COMMIT"
    exit 0
  fi
  echo "attempt $attempt: $code"
  sleep 5
done

echo "The app did not answer 200. It is running the new build; roll back if needed." >&2
echo "Logs:     ssh $ERP_SSH 'pm2 logs $PM2_NAME --lines 80'" >&2
echo "Rollback: ssh $ERP_SSH 'cd /opt && tar -xzf /root/erp-backups/app-before-$STAMP.tgz && pm2 restart $PM2_NAME'" >&2
echo "Database: ssh $ERP_SSH 'pg_restore -h 127.0.0.1 -p 5434 -U erp_owner -d erp -c /root/erp-backups/db-before-$STAMP.dump'" >&2
exit 1
