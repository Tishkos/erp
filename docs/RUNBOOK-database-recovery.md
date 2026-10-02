# Runbook — the live database: backups, checks, recovery

The live books are the PostgreSQL database `erp` on the VPS (port 5434,
owner role `erp_owner`, application role `erp_app`). This is what protects
them, what watches them, and what to do when something is wrong. Written to be
followed at 2 a.m. by someone who did not write it. How the host itself is
built — nginx, pm2, the environment files, the crontab — is
`RUNBOOK-host-build.md`; this one is only about the data.

---

## What runs by itself

Every line is in `scripts/ops/crontab.erp`, installed by `install-cron.sh`
(which `deploy.sh` runs), and every job goes through `run-job.sh`: one run at
a time (`flock`), a timeout, its own log under `/var/log/qs-erp/`, and its
exit code in `/opt/qs-erp-next/var/jobs/<job>.last` for the health check and
the **Administration → Background Jobs** screen.

| When (server time, Asia/Baghdad) | Job | What it does | Log |
|---|---|---|---|
| 01:00 daily | `backup` — `scripts/ops/backup.sh` | Writes a **set** under `/root/erp-backups/nightly/<stamp>/`: `erp-<stamp>.dump` (`pg_dump -Fc`), `globals-<stamp>.sql` (`pg_dumpall --globals-only` — the roles), `attachments-<stamp>.tgz` (the attachment store), `manifest.txt` (sizes, sha256, the git revision that was running). With `AGE_RECIPIENT` set the three files are encrypted (`.age`) and the clear copies removed; with `RCLONE_REMOTE` set the set is copied off the server and `offsite.txt` written. Rotation: every set from the last 7 days, the first of each week for 4 weeks, the first of each month for 12, the first of each year for 7. | `backup.log` |
| 02:15 daily | `inventory-integrity` | Documents without ledger rows, rows without documents, transfers out of balance, layers adrift, warehouses below zero → in-app notice to every accounting manager and super user. | `inventory-integrity.log` |
| 06:10 daily | `payables-sweep` | Time limits, holds, escalation, next year's `payable_event` partition (REQ-AP-001 §19.3). | `payables-sweep.log` |
| 06:20 daily | `due-notices` | Receivables due notices. | `due-notices.log` |
| 06:40 daily | `health-check` — `scripts/ops/health-check.ts` | Newest backup ≤ 26 h old, complete, encrypted; `payable_event` partitions reach next year; a fiscal period covers today and next year is open by November; no scheduled job failed in the last 36 h; disk ≥ 10 % free; no delivery stuck a day. Findings → in-app notice; the same report is on **Administration → Backup and Health**. | `health-check.log` |
| 03:00 Sunday | `restore-drill` — `scripts/ops/restore-drill.sh --local` | Restores the **newest nightly set** (decrypting with `AGE_IDENTITY`) into a throwaway database, checks the table count, the ledger and how far behind live it is, runs `scripts/verify-recovery.ts` on it, drops it. **Fails when the newest set is older than 26 hours** — the drill proves tonight's backup, not last month's. | `restore-drill.log` |

Every deploy, format or repair also takes `pg_dump -Fc` of `erp` first, into
`/root/erp-backups/db-before-<stamp>.dump`.

`/healthz` (no sign-in) answers 200 only when the database answers *and* the
migrations are at head, with the build id and revision; `deploy.sh` waits for
it, an external monitor should poll it, and the footer's health light reads
the same probe.

The backup's own settings live in `/etc/qs-erp/backup.env` on the server
(not in git): `AGE_RECIPIENT` (the public key the sets are encrypted to),
`AGE_IDENTITY` (the private key file the drill decrypts with — a copy of
this key is held by the owner off the server; without it an encrypted set is
unreadable), `RCLONE_REMOTE` (the off-site bucket), `BACKUP_ROOT` if not
`/root/erp-backups`.

---

## Recovery point and recovery time

Measured, not promised. The figures to keep current:

| | Figure | How it was measured |
|---|---|---|
| Recovery point (RPO) | **≤ 24 hours** — the nightly set; plus the deploy dumps between | The 01:00 schedule. D-IM-1 asks for 15 minutes through WAL archiving; that is the next step on this runbook, not yet built. |
| Recovery time (RTO) | **minutes on the same host** — a restore of the live-sized dump into a fresh database and `verify-recovery` ran in under a minute in the drill; the swap is two `alter database` statements | `restore-drill.log` prints `PASSED in <n>s` for every drill; write the latest figure here when it changes materially. Locally (`tests/integration/im01-backup-restore.test.ts`): dump + restore + verify in ≈ 5 s on the test database. |
| On a clean host | **≈ 1 hour** after the host exists — `RUNBOOK-host-build.md` end to end, then "Recovering on a new host" below | Walk it once a year and record the time in `INCIDENTS.md`. |

---

## Reading the drill log

```
== Restore drill 20261004-030000 — /root/erp-backups/nightly/20261004-010000/erp-20261004-010000.dump.age (1.6M, ...)
== Tables: live 205, restored 205
== Ledger in the copy: 0 document(s) without rows, 0 position(s) adrift
== Restored copy holds journals 14, movements 18, invoices 9; newest posting 2026-10-03 17:12:42+00
Recovery verification — database 'erp_restore_drill_20261004-030000'
  ✓ schema is at head
  ✓ row-level security is enabled and forced
  ...
== Restore drill 20261004-030000 PASSED in 41s — ... restores cleanly and its ledger agrees with its documents.
```

`DRILL FAILED: pg_restore reported errors` means the dump cannot be restored
as it stands. The first drill (2026-09-27) failed this way: a `bank_cash_account`
row pointed at a `chart_of_account` row that no longer existed, and
`pg_restore` could not recreate the foreign key. **A failed drill is a defect
in the live database, not in the backup** — the dump is a faithful copy of a
database that has an inconsistency the constraints would never have allowed
the application to create. Find the dangling row (the error names the
constraint), correct it through the application where a screen exists, and
run the drill again by hand:

```
scripts/ops/restore-drill.sh          # from your machine
scripts/ops/restore-drill.sh --local --any   # on the server, accepting a set older than 26 h
```

`DRILL FAILED: the newest nightly set is N hours old` means the backup job
is not running: read `backup.log`, then `crontab -l`.

---

## Checking the ledger by hand

```
npx tsx scripts/ops/stock-movement-trace.ts [warehouse] [item]
```

Every movement of the item in the warehouse with a running balance, the
position the screen reports, and the integrity findings company-wide. Run it
with `DATABASE_URL_OWNER` pointing at the database in question. The same
questions are asked live by the banner on every stock screen and by the
Stock Ledger page (`/inventory/stock-ledger`).

---

## Recovering for real

Only after the reason for the loss is understood — restoring over a database
that is being corrupted by something still running loses the evidence and
the new data both.

1. **Stop the application** so nothing posts during the restore:
   `pm2 stop qs-erp`. nginx now serves the maintenance page.
2. **Take a dump of what is there now**, even if it is broken. It is the only
   record of anything posted since the backup you are about to restore:
   `pg_dump -h 127.0.0.1 -p 5434 -U erp_owner -d erp -Fc -f /root/erp-backups/erp-before-recovery-$(date -u +%Y%m%d-%H%M%S).dump`
3. **Choose the set to restore.** The newest the drill has passed, or the
   newest that predates the damage: `ls -lt /root/erp-backups/nightly/`.
   Decrypt it: `age -d -i $AGE_IDENTITY -o /tmp/erp.dump …/erp-<stamp>.dump.age`.
   The deploy dumps in `/root/erp-backups/db-before-*.dump` are the fallback.
4. **Restore into a fresh database first**, never over the live one:
   `createdb -h 127.0.0.1 -p 5434 -U erp_owner -T template0 -E UTF8 --lc-collate=C --lc-ctype=C erp_recovered`
   `pg_restore -h 127.0.0.1 -p 5434 -U erp_owner -d erp_recovered --exit-on-error /tmp/erp.dump`
   No `--no-owner`, no `--no-acl`: the grants and FORCE ROW LEVEL SECURITY
   are part of what is being recovered. If this fails, the dump is not
   restorable as-is; go back to step 3 with an older one, or fix the named
   constraint in the restored copy by hand and write down what you did.
5. **Verify the copy.**
   `DATABASE_URL_OWNER=postgres://erp_owner:<pw>@127.0.0.1:5434/erp_recovered npx tsx scripts/verify-recovery.ts erp_recovered`
   — schema at head, RLS forced, append-only triggers, the draft-only delete
   fence, posted journals balanced, the five account roots. Then row counts,
   the newest posting, the ledger check
   (`… npx tsx scripts/ops/stock-movement-trace.ts`). Decide, with the owner,
   whether what was posted after the dump is re-entered by hand or accepted
   as lost.
6. **Attachments.** `tar -xzf attachments-<stamp>.tgz -C $(dirname $ATTACHMENT_DIR)`
   after moving the current store aside; `attachment` rows and files must
   come from the same set or the screens show files that are not there.
7. **Swap.** Rename the databases so the live name points at the good copy:
   `psql -d postgres -c "alter database erp rename to erp_damaged_$(date -u +%Y%m%d)"`
   `psql -d postgres -c "alter database erp_recovered rename to erp"`
   The application's `.env` does not change.
8. **Start the application** (`pm2 start qs-erp`), check `/healthz` answers
   200, and run the nightly check by hand:
   `cd /opt/qs-erp-next && npx tsx scripts/ops/inventory-integrity-check.ts`.
9. **Write it up** in `docs/INCIDENTS.md`: what was lost, what was restored,
   what was re-entered, how long it took, and what is being changed so it
   does not happen again.

Keep `erp_damaged_*` until the owner has looked at the recovered system and
said it is right. Then drop it.

### Recovering on a new host

`pg_dump` does not carry roles. On a host where `erp_owner` and `erp_app`
do not exist yet, a restore fails on the first `GRANT` — so the roles come
first, from the set's `globals-<stamp>.sql`:

1. Build the host (`RUNBOOK-host-build.md`) up to and including PostgreSQL.
2. `psql -h 127.0.0.1 -p 5434 -U postgres -f globals-<stamp>.sql` — creates
   the two roles with their passwords as they were. (The repository's
   `scripts/sql/00-init-roles.sql` creates them with the *development*
   passwords; use it only for a fresh install, never for a recovery.)
3. Continue from step 4 above, then put the host's `.env`, `backup.env`,
   the nginx vhost, pm2 and the crontab in place as the host runbook says.
4. Set `/opt/qs-erp-next/var/LIVE` (`echo "live since <date>, recovered from <stamp>" > var/LIVE`)
   only once the owner has signed the recovered system off.

---

## Staging

A copy of the live database with every person removed from it, for trials
and for testing the next release against real figures (D-IM-2):

```
scripts/ops/make-staging-copy.sh        # on the server: erp → erp_staging, scrubbed
```

`scripts/sql/scrub-staging.sql` replaces user e-mails, drops password hashes,
tokens, MFA seeds, sessions, sign-in attempts, KYC records, CRM contacts,
partner bank accounts, partner contact details and attachment rows, and
suppresses every pending delivery. The script refuses to write to the live
database by name. Afterwards create a sign-in on the copy with
`DATABASE_URL_OWNER=…/erp_staging npx tsx scripts/ops/ensure-ceo-user.ts`;
no live password works on staging.

---

## Things that must not be done to the live database

* **Do not run `format-live-database.sh`, `db-reset.ts`, `seed-dev.ts`,
  `new-company-setup.sh` or `reset-statement-mapping.sh` against it.** Every
  one refuses while `/opt/qs-erp-next/var/LIVE` exists, and that file is
  there because the books are live. Trials and demos belong on staging.
* **Do not delete with triggers or foreign keys disabled** (`set
  session_replication_role = replica`) unless you have the complete list of
  dependent tables in front of you. Both incidents on 2026-09-27 came from
  exactly this: rows left pointing at rows that were gone.
* **Do not `pg_restore` over the live database** (`-c`, `--clean`). Restore
  beside it and swap, as above; the old database stays as evidence.
* **Do not point a test suite at it.** `DATABASE_URL_TEST` must name a database
  the suite may destroy.
* **Do not edit a posted document's rows.** A posted invoice is corrected by
  reversing it (the Reverse action on its page); stock is corrected by a
  return, a reconciliation or a reversal — every one of them a new row, never a
  changed one.
