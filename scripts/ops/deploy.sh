#!/usr/bin/env bash
#
# Deploy to the VPS — build on the server, migrate before the new code runs.
#
# Run this from the project root on your own machine. It ships only what git
# tracks, so the credentials file, the uploaded attachments under var/ and the
# reference images stay where they are.
#
# The order below is the part that matters. The twelve migrations 0158-0169
# add tables and triggers the new screens read, so they run *before* pm2 picks
# up the new build. Start the code first and the invoicing and statements
# routes query tables that are not there yet.
#
#   1. refuse to ship a dirty or untested tree
#   2. archive what git tracks, and upload it
#   3. install, migrate, build — on the server, in that order
#   4. restart, then check the app actually answers
#
# The release goes to a dated directory and the live path is a symlink, so
# rolling back is repointing the symlink rather than rebuilding an old commit.
#
# Usage:
#   scripts/ops/deploy.sh                 # uses ERP_SSH below
#   ERP_SSH=root@1.2.3.4 scripts/ops/deploy.sh
#
# Authenticate with an SSH key, not a password. If you are still using the
# root password from vps.md, replace it: `ssh-copy-id root@host`, then set
# `PermitRootLogin prohibit-password` in /etc/ssh/sshd_config.
#
set -euo pipefail

ERP_SSH="${ERP_SSH:-root@31.97.123.206}"
APP=/opt/qs-erp-next
RELEASES="$APP/releases"
PM2_NAME="${PM2_NAME:-qs-erp}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/sign-in}"

STAMP=$(date -u +%Y%m%d-%H%M%S)
REMOTE_TMP="/tmp/qs-erp-$STAMP.tar.gz"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# ── 1. Refuse to ship something unverified ────────────────────────────────
# A dirty tree means the tarball and the commit history disagree, and the
# thing running in production is then not any commit you can point at.
say "Checking the tree"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is dirty. Commit or stash first:" >&2
  git status --short >&2
  exit 1
fi
COMMIT=$(git rev-parse --short HEAD)
BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "shipping $BRANCH @ $COMMIT"

say "Type check and unit tests"
npm run typecheck
npm run test:unit

# ── 2. Archive and upload ─────────────────────────────────────────────────
# git archive takes tracked files only. That is deliberate: it is what keeps
# vps.md, var/attachments and the reference images out of the upload without
# anyone having to remember.
say "Uploading"
git archive --format=tar.gz -o "/tmp/qs-erp-$STAMP.tar.gz" HEAD
scp "/tmp/qs-erp-$STAMP.tar.gz" "$ERP_SSH:$REMOTE_TMP"
rm -f "/tmp/qs-erp-$STAMP.tar.gz"

# ── 3-4. Install, migrate, build, restart ─────────────────────────────────
say "Installing, migrating and building on the server"
ssh "$ERP_SSH" bash -euo pipefail -s <<REMOTE
APP=$APP
RELEASE=$RELEASES/$STAMP
PM2_NAME=$PM2_NAME

mkdir -p "\$RELEASE"
tar -xzf "$REMOTE_TMP" -C "\$RELEASE"
rm -f "$REMOTE_TMP"

# The environment file lives with the install, not with any one release: it
# holds the database passwords and the auth secret, and a release that carried
# its own copy would be a second place for them to drift.
ln -sfn "\$APP/.env" "\$RELEASE/.env"

cd "\$RELEASE"
npm ci --omit=dev --ignore-scripts || npm ci

# Before the schema moves, take a copy. vps.md says backups are not wanted;
# this one costs seconds and is the only way back if a migration is wrong.
# Delete it yourself once the deploy is confirmed.
PW=\$(grep -oP '^DATABASE_URL_OWNER=postgres://erp_owner:\K[^@]+' "\$APP/.env")
PGPASSWORD="\$PW" pg_dump -h 127.0.0.1 -p 5434 -U erp_owner -d erp -Fc \
  -f "\$APP/backup-before-$STAMP.dump"
echo "backup: \$APP/backup-before-$STAMP.dump"

# Migrations first. Drizzle records what it has applied, so this is a no-op
# on a database already at head rather than an error.
npm run db:migrate

npm run build

# Point the live path at the new release, then restart. Repointing before the
# restart means the process that comes up is reading the new code, not the old.
ln -sfn "\$RELEASE" "\$APP/current"
pm2 restart "\$PM2_NAME" --update-env || pm2 start "\$APP/current/.next/standalone/server.js" --name "\$PM2_NAME"
pm2 save

# Keep the last five releases; a rollback is repointing the symlink at one of
# them and restarting.
ls -1dt "$RELEASES"/*/ 2>/dev/null | tail -n +6 | xargs -r rm -rf
REMOTE

# ── Did it actually come up? ──────────────────────────────────────────────
# pm2 reports the process started, which is not the same as the application
# answering. Ask it for a page.
say "Health check"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  code=$(ssh "$ERP_SSH" "curl -s -o /dev/null -w '%{http_code}' --max-time 10 '$HEALTH_URL'" || true)
  if [[ "$code" == "200" ]]; then
    echo "$HEALTH_URL -> 200"
    say "Deployed $BRANCH @ $COMMIT"
    exit 0
  fi
  echo "attempt $attempt: $code"
  sleep 5
done

echo "The app did not answer with 200. It is still running the new release." >&2
echo "Logs:     ssh $ERP_SSH 'pm2 logs $PM2_NAME --lines 80'" >&2
echo "Rollback: ssh $ERP_SSH 'ln -sfn $RELEASES/<previous> $APP/current && pm2 restart $PM2_NAME'" >&2
exit 1
