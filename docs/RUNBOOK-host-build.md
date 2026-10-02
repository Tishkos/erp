# Runbook — building the host: from a bare server to a running QS ERP

REQ-IMPROVE-001 OP-12. Everything that is on the VPS and not in git, written
down so a second host can be built from this page, and so the first can be
rebuilt. The data side — backups, drills, recovery — is
`RUNBOOK-database-recovery.md`. The credentials themselves are **not** here:
they are in the owner's escrow (§ Secrets escrow), and the server notes in
`~/.config/qs-erp/vps.md` on the deployer's machine.

Live today: `erp.qs-groups.com`, one Ubuntu VPS shared with other sites, the
app at `/opt/qs-erp-next` on port 3200 behind nginx, PostgreSQL on 5434, pm2
process `qs-erp`.

---

## 1. The host

| | |
|---|---|
| OS | Ubuntu LTS; unattended security upgrades on |
| Time zone | `timedatectl set-timezone Asia/Baghdad` — the crontab times and the business date (`ERP_TIMEZONE`) assume it |
| Users | the app runs as root under pm2 today (SG-4 moves it to its own user; until then nothing else should) |
| Firewall | `ufw`: allow 22 (from the office/VPN addresses only), 80, 443; deny everything else. PostgreSQL and the app port listen on 127.0.0.1 only |
| Packages | `nginx`, `certbot python3-certbot-nginx`, `postgresql-16` (client and server), `age`, `rclone`, `git`, `build-essential`, `logrotate` |
| Node | the version in `.nvmrc` (22), via nvm or NodeSource; `npm` 10 — **not 11**, which writes a lock file npm 10 rejects. `pm2` global (`npm i -g pm2`, `pm2 startup`) |

## 2. PostgreSQL

* Cluster on port **5434** (the box has another on 5432): in
  `postgresql.conf`, `port = 5434`, `listen_addresses = '127.0.0.1'`,
  `timezone = 'Asia/Baghdad'`, `log_min_duration_statement = 2000`.
* Roles and database, fresh install:
  `psql -p 5434 -U postgres -f scripts/sql/00-init-roles.sql` then change
  both passwords (`alter role erp_owner password '…'`, same for `erp_app`);
  `createdb -p 5434 -U postgres -O erp_owner -T template0 -E UTF8 --lc-collate=C --lc-ctype=C erp`;
  `grant connect on database erp to erp_app`.
* Roles and database, **recovery**: the set's `globals-<stamp>.sql` first,
  then the restore — `RUNBOOK-database-recovery.md`, "Recovering on a new host".
* `pg_hba.conf`: `scram-sha-256` for both roles on 127.0.0.1 only.

## 3. The application tree

```
/opt/qs-erp-next/              the tree deploy.sh extracts (tracked files only)
  .env                         the environment — not in git (§ 4)
  ecosystem.config.cjs         pm2 — copy of deploy/ecosystem.example.cjs
  .next/                       the build pm2 serves; .next-prev/ the one before
  var/LIVE                     the live marker: every fixture script refuses while it exists
  var/attachments/             only if ATTACHMENT_DIR is unset — set it (§ 4)
  var/jobs/<job>.last          run-job.sh's record of each job's last run
  var/deploys.log              one line per deploy; var/deploy-skips.log the recorded exceptions
  REVISION                     "<sha> <branch> <date>" of what is running
/opt/qs-erp-next-build/        exists only during a deploy
/var/lib/qs-erp/attachments/   the attachment store (ATTACHMENT_DIR)
/var/log/qs-erp/               one log per job, pm2-out.log, pm2-error.log; rotated weekly, 12 kept
/root/erp-backups/             nightly/<stamp>/ sets and db-before-<stamp>.dump deploy dumps
/etc/qs-erp/backup.env         AGE_RECIPIENT, AGE_IDENTITY, RCLONE_REMOTE (§ 4)
```

First deploy on a new host: `mkdir -p /opt/qs-erp-next/var /var/log/qs-erp /var/lib/qs-erp/attachments`,
write `.env` and `ecosystem.config.cjs`, then run `scripts/ops/deploy.sh`
from a machine with the repository and ssh access; it uploads, installs,
builds beside the running app, migrates, swaps, installs the crontab and
checks `/healthz`. Then `pm2 save`.

## 4. The environment files

`/opt/qs-erp-next/.env` (mode 600, root). What each key is for; the values are
in escrow:

| Key | Meaning |
|---|---|
| `DATABASE_URL` | `postgres://erp_app:…@127.0.0.1:5434/erp` — what the application connects as |
| `DATABASE_URL_OWNER` | `postgres://erp_owner:…@127.0.0.1:5434/erp` — migrations, backups and ops scripts (SG-4 moves it out of the app's file) |
| `BETTER_AUTH_SECRET` | 32 random bytes; rotating it signs everyone out |
| `BETTER_AUTH_URL` | `https://erp.qs-groups.com` |
| `NODE_ENV` | `production` |
| `APP_ENV` | `production` / `staging` |
| `ERP_TIMEZONE` | `Asia/Baghdad` — the business date |
| `ATTACHMENT_DIR` | `/var/lib/qs-erp/attachments` — **must be set**: unset, the store is `cwd/var/attachments`, and the standalone server's cwd is inside `.next`, which every deploy replaces (OP-3) |
| `LOG_LEVEL` | `info` |
| `EXPORT_ROW_CAP` | optional; 20000 unless set (OP-9) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | the e-mail channel (HARDEN-3) |
| `LEDGER_CURRENCY`, `REPORTING_CURRENCY` | `IQD`, `USD` |
| `BACKUP_ROOT`, `JOB_STATE_DIR`, `JOB_LOG_DIR` | optional; the defaults are the paths in § 3 |

`/etc/qs-erp/backup.env` (mode 600, root):

| Key | Meaning |
|---|---|
| `AGE_RECIPIENT` | the `age1…` public key the sets are encrypted to. Generate once on the owner's machine: `age-keygen -o qs-erp-backup.key`; the public key goes here, the file into escrow |
| `AGE_IDENTITY` | `/etc/qs-erp/backup.key` — the private key, for the weekly drill to decrypt with (mode 600). Yes, it is on the server: the drill cannot run without it; the off-site copies are what the key protects |
| `RCLONE_REMOTE` | `<remote>:<bucket>/qs-erp` — an rclone remote configured in `/root/.config/rclone/rclone.conf` on a **different provider** from the VPS (D-IM-1) |

## 5. nginx

The vhost is `deploy/nginx.example.conf`, copied to
`/etc/nginx/sites-available/erp.qs-groups.com` and linked into
`sites-enabled`. TLS by `certbot --nginx -d erp.qs-groups.com` (renewal is
certbot's own timer; check `certbot renew --dry-run` after building).

What the file does that must survive any edit: `X-Request-ID` and
`X-Real-IP` to the app (the audit trail and the sign-in lockout read them),
`client_max_body_size 26m` (the same as `next.config.ts`), and
`error_page 502 503 504 =503 /maintenance.html` from
`/opt/qs-erp-next/deploy/` — the page the public sees for the seconds a
deploy has the app stopped (IM2). Keep the live file and the example the
same; a change made on the server alone is lost with the host.

## 6. pm2

`deploy/ecosystem.example.cjs` → `/opt/qs-erp-next/ecosystem.config.cjs`.
It runs the absolute path of the standalone server with
`--max-old-space-size=1536` and `max_memory_restart: '1800M'` (OP-9), logs
to `/var/log/qs-erp/pm2-*.log`, and takes the environment from `.env`
(deploy.sh sources it before `pm2 restart --update-env`).

`pm2 startup && pm2 save` once, so the process returns after a reboot.

## 7. The crontab

`scripts/ops/install-cron.sh` writes `scripts/ops/crontab.erp` into root's
crontab between two markers (and the logrotate rule). It runs on every
deploy; run it by hand after editing the file. The jobs and their times are
in `RUNBOOK-database-recovery.md`.

## 8. Deploy and roll back

```
scripts/ops/deploy.sh                       # from main, pushed; refuses otherwise
DEPLOY_ANY_BRANCH="hotfix: …" scripts/ops/deploy.sh    # the recorded exception
SKIP_INTEGRATION="…" scripts/ops/deploy.sh  # skips the integration suite, recorded in var/deploy-skips.log
```

What a deploy does, in order: typecheck and unit tests here; the
integration suite here; archive of the tracked files uploaded; **on the
server** — database and app dumps, extract, `npm ci`, build in
`/opt/qs-erp-next-build` while the old build keeps serving, `pm2 stop`,
migrate (on failure: restart the old build and stop), move `.next` to
`.next-prev` and the new build into place, `pm2 restart`, install the
crontab, log the deploy; then `/healthz` is polled until it answers 200.

Every deploy's build carries `DEPLOYMENT_ID=<stamp>`, so a browser holding the
previous build's pages reloads instead of 404-ing on a chunk (`deploymentId`
in `next.config.ts`).

Roll back the application (the schema stays — migrations are additive;
expand/contract, never a destructive change in the same release as the code
that stops needing the column):

```
ssh root@… 'cd /opt/qs-erp-next && pm2 stop qs-erp && rm -rf .next && mv .next-prev .next && pm2 restart qs-erp'
```

Roll back the data: `RUNBOOK-database-recovery.md` — restore the
`db-before-<stamp>.dump` beside the live database and swap. Never
`pg_restore --clean` over `erp`.

Check after any deploy: `curl -s https://erp.qs-groups.com/healthz` says
`"ok":true` with the new `build`; the footer shows the new version; a
reload of a page that was open during the deploy shows the maintenance page
only while pm2 was stopped and the application afterwards — never a 404 or a
500 (IM2).

## 9. Staging

Same host, database `erp_staging`, a second tree `/opt/qs-erp-staging` on
port 3201 with its own `.env` (`APP_ENV=staging`, `DATABASE_URL`s pointing at
`erp_staging`), pm2 name `qs-erp-staging`, vhost `staging.erp.qs-groups.com`
behind HTTP basic auth, **no crontab** and no `var/LIVE`. Refresh its data
with `scripts/ops/make-staging-copy.sh` (D-IM-2).

## 10. Secrets escrow

Held by the owner, off the server and off the deployer's laptop (a password
manager's shared vault, or a printed envelope in the safe), so a lost laptop
or a lost host is an inconvenience, not an outage:

* `/opt/qs-erp-next/.env` and `/etc/qs-erp/backup.env` (current copies, dated);
* the age backup key file (`qs-erp-backup.key`) — without it no encrypted set
  can be read, anywhere;
* the rclone remote's credentials and the off-site bucket's location;
* the PostgreSQL `erp_owner` and `erp_app` passwords (also in `.env`);
* the VPS provider login, the ssh key used to deploy, and the DNS registrar login;
* the TLS account (certbot re-issues; nothing to escrow beyond the DNS).

Rotate on any departure of someone who held them (SG-8 has the procedure).

## 11. Contacts

| Role | Who | How |
|---|---|---|
| Owner / sponsor | Tishko | the number in `vps.md` |
| Accounting manager (first to notice a figure is wrong) | — | in-app notice recipients |
| Deployer | whoever last wrote `var/deploys.log` | — |
| VPS provider | the provider named in `vps.md` | the provider console |
| Off-site storage | per `RCLONE_REMOTE` | the provider console |

Fill the dashes in when the people are named; a runbook with a blank
contacts table is still better than one with a wrong number.
