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
#   * The build happens in a sibling copy (/opt/qs-erp-next-build) while the
#     old .next keeps serving; the finished .next is moved into place in the
#     migration window and the old one kept as .next-prev (REQ-IMPROVE-001
#     OP-2). Building in place took the site down for every build.
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
#   * An archive only *adds*. A file deleted or renamed since the last deploy
#     survives on the server, and under the App Router a leftover page.tsx is
#     a live route — one still naming message keys the rename took away, so it
#     fails at request time rather than at build time. The wholly-tracked
#     trees are cleared before the extract for that reason. Only those: .env,
#     ecosystem.config.cjs, node_modules, .next and var/ must outlive it.
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
BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "shipping $BRANCH @ $COMMIT"

# REQ-IMPROVE-001 OP-11 — what ships is on main and pushed, so the server
# never runs a commit nobody else can see. DEPLOY_ANY_BRANCH=<reason> is the
# recorded exception (a hotfix branch), like SKIP_INTEGRATION.
git fetch -q origin
if [[ -z "${DEPLOY_ANY_BRANCH:-}" ]]; then
  [[ "$BRANCH" == "main" ]] || { echo "Deploy from main, not $BRANCH (DEPLOY_ANY_BRANCH=<reason> overrides)." >&2; exit 1; }
  git merge-base --is-ancestor HEAD origin/main || { echo "HEAD is not on origin/main — push first." >&2; exit 1; }
else
  printf '%s  %s  deployed from %s: %s\n' "$STAMP" "$COMMIT" "$BRANCH" "$DEPLOY_ANY_BRANCH" >> var/deploy-skips.log
fi
REVISION="$(git rev-parse HEAD) $BRANCH $(git log -1 --format=%cI)"

say "Type check and unit tests"
npm run typecheck
npm run test:unit

# ── The ledger rules, proved before the code reaches the books ────────────
# The integration suite is what holds the stock ledger, the journals and the
# permissions to their rules against a real PostgreSQL. Until 2026-09-27 a
# deploy ran only the type check and the unit tests, and a stale test sat in
# the suite unnoticed while the code it described had changed. It runs here
# now, against the local database named in .env (DATABASE_URL_TEST), and a
# red suite stops the deploy. It takes a while; that is the price of knowing.
#
# SKIP_INTEGRATION=<reason> skips it — for a hotfix whose suite is already
# green in CI — and the reason is printed and recorded so the shortcut is a
# decision somebody made, not a habit nobody noticed.
if [[ -n "${SKIP_INTEGRATION:-}" ]]; then
  say "Integration tests SKIPPED: $SKIP_INTEGRATION"
  printf '%s  %s  skipped integration tests: %s\n' "$STAMP" "$COMMIT" "$SKIP_INTEGRATION" >> var/deploy-skips.log
else
  say "Integration tests"
  npm run test:integration
fi

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
REVISION="$REVISION"
DEPLOYER="$(git config user.email || echo "$USER")"

mkdir -p /root/erp-backups "\$APP/var"
PW=\$(grep -oP '^DATABASE_URL_OWNER=postgres://erp_owner:\K[^@]+' "\$APP/.env")

# Both backups before anything moves. The database one is the only way back
# from a bad migration; the app one is the only way back from a bad build.
# Delete them once the deploy is confirmed, not before.
PGPASSWORD="\$PW" pg_dump -h 127.0.0.1 -p 5434 -U erp_owner -d erp -Fc \
  -f "/root/erp-backups/db-before-\$STAMP.dump"
tar -czf "/root/erp-backups/app-before-\$STAMP.tgz" \
  -C /opt --exclude=qs-erp-next/node_modules --exclude=qs-erp-next/var/attachments --exclude='qs-erp-next/.next*' qs-erp-next
echo "backups in /root/erp-backups"

cd "\$APP"
# Every file in these comes from git, so anything the archive does not carry
# is a file this release deleted. Clearing them first is what makes the
# extract a replacement rather than a merge — see the note at the top.
rm -rf src messages tests scripts
tar -xzf "$TARBALL" -C "\$APP"
rm -f "$TARBALL"
echo "\$REVISION" > "\$APP/REVISION"

npm ci

set -a; . ./.env; set +a
export DEPLOYMENT_ID="\$STAMP"

# REQ-IMPROVE-001 OP-2 (IM2) — build *beside* the running application, not
# over it. next build empties its dist directory first, and the old
# .next/standalone is what pm2 is serving: building in place took the site
# down for the length of every build. The build runs in a sibling copy of the
# tree (node_modules shared), and its finished .next is moved into place in
# the short window the migration already needs.
BUILD_DIR="\$APP-build"
rm -rf "\$BUILD_DIR"
mkdir -p "\$BUILD_DIR"
tar -C "\$APP" --exclude=node_modules --exclude='.next*' --exclude=var -cf - . | tar -C "\$BUILD_DIR" -xf -
# node_modules is hardlinked in, not symlinked to.
#
# It was a symlink until 2026-10-02, when the first deploy on Next 16.3.8
# died with "Symlink [project]/node_modules is invalid, it points out of the
# filesystem root": Turbopack resolves the project root itself and refuses a
# node_modules that leaves it. `cp -al` gives it a real directory, and
# because the link targets are the same inodes on the same filesystem it
# costs neither a copy nor the disk for one.
cp -al "\$APP/node_modules" "\$BUILD_DIR/node_modules"
( cd "\$BUILD_DIR" && npm run build )
# The standalone bundle ships server.js and its node_modules, but not these.
rm -rf "\$BUILD_DIR/.next/standalone/.next/static"
cp -r "\$BUILD_DIR/.next/static" "\$BUILD_DIR/.next/standalone/.next/static"
[ -d "\$BUILD_DIR/public" ] && cp -r "\$BUILD_DIR/public" "\$BUILD_DIR/.next/standalone/public"
cp "\$APP/REVISION" "\$BUILD_DIR/.next/standalone/REVISION"

# Apply migrations with no application requests in flight. Migrations run in
# one transaction. If one fails, the old build is still in place: bring it
# back against the unchanged schema.
pm2 stop "\$PM2_NAME"
if ! npm run db:migrate; then
  echo "Migration failed; the previous build is untouched — restarting it." >&2
  pm2 restart "\$PM2_NAME" --update-env
  printf '%s  %s  %s  FAILED migration\n' "\$STAMP" "\$(cut -c1-12 REVISION)" "\$DEPLOYER" >> "\$APP/var/deploys.log"
  exit 1
fi

# The swap: the previous build is kept as .next-prev for a rollback by hand.
rm -rf "\$APP/.next-prev"
[ -d "\$APP/.next" ] && mv "\$APP/.next" "\$APP/.next-prev"
mv "\$BUILD_DIR/.next" "\$APP/.next"
rm -rf "\$BUILD_DIR"

pm2 restart "\$PM2_NAME" --update-env
pm2 save

# OP-7 — the crontab is the file in the repository.
APP="\$APP" bash "\$APP/scripts/ops/install-cron.sh"
printf '%s  %s  %s  deployed\n' "\$STAMP" "\$(cut -c1-12 REVISION)" "\$DEPLOYER" >> "\$APP/var/deploys.log"
REMOTE

# ── Did it come up? ───────────────────────────────────────────────────────
# OP-4 (IM3): /healthz answers 200 only when the database answers and the
# migrations are at head; a 200 from /sign-in proved neither.
say "Health check"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  code=$(ssh "$ERP_SSH" "curl -s -o /dev/null -w '%{http_code}' --max-time 15 http://127.0.0.1:$PORT/healthz" || true)
  if [[ "$code" == "200" ]]; then
    echo "app on :$PORT -> healthz 200"
    ssh "$ERP_SSH" "curl -s --max-time 15 http://127.0.0.1:$PORT/healthz"; echo
    public=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$PUBLIC_URL" || echo "?")
    echo "$PUBLIC_URL -> $public"
    say "Deployed $COMMIT"
    exit 0
  fi
  echo "attempt $attempt: $code"
  sleep 5
done

echo "The app did not answer healthz 200. It is running the new build; roll back if needed." >&2
echo "Logs:     ssh $ERP_SSH 'pm2 logs $PM2_NAME --lines 80'" >&2
echo "Rollback: ssh $ERP_SSH 'cd $APP && pm2 stop $PM2_NAME && rm -rf .next && mv .next-prev .next && pm2 restart $PM2_NAME'" >&2
echo "          — then, if the migration must be undone, follow docs/RUNBOOK-database-recovery.md (restore into a NEW database, never over the live one)." >&2
exit 1
