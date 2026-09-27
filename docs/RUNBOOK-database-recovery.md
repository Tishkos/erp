# Runbook — the live database: backups, checks, recovery

The live books are the PostgreSQL database `erp` on the VPS (port 5434,
owner role `erp_owner`, application role `erp_app`). This is what protects
them, what watches them, and what to do when something is wrong. Written to be
followed at 2 a.m. by someone who did not write it.

---

## What runs by itself

| When | What | Where it writes |
|---|---|---|
| Every deploy, format or repair | `pg_dump -Fc` of `erp` before anything changes | `/root/erp-backups/*.dump` |
| Nightly, 02:15 server time | `scripts/ops/inventory-integrity-check.ts` — documents without ledger rows, rows without documents, transfers out of balance, layers adrift from the ledger, warehouses below zero. Findings go to every accounting manager and super user as an in-app notification. | `/var/log/qs-erp/inventory-integrity.log` |
| Weekly, Sunday 03:00 | `scripts/ops/restore-drill.sh --local` — restores the **newest** dump into a throwaway database, checks the table count, the ledger and how far behind live it is, drops it. | `/var/log/qs-erp/restore-drill.log` |

Both are in root's crontab (`crontab -l`). A non-zero exit is written to the
log; read the logs when you read the inbox.

**Gap, stated plainly:** there is no *scheduled* backup independent of a
deploy. The dumps exist because deploys and repairs make them. A nightly
`pg_dump` to the same folder, and a copy off the machine, are the next two
things to add; until then the recovery point is "the last time somebody
deployed".

---

## Reading the drill log

```
== Restore drill 20260927-030000 — /root/erp-backups/erp-before-...dump (1.6M, ...)
== Tables: live 205, restored 205
== Ledger in the copy: 0 document(s) without rows, 0 position(s) adrift
== Restored copy holds journals 14, movements 18, invoices 9; newest posting 2026-09-27 10:12:42+00
== Restore drill 20260927-030000 PASSED — ... restores cleanly and its ledger agrees with its documents.
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
```

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
   `pm2 stop qs-erp`.
2. **Take a dump of what is there now**, even if it is broken. It is the only
   record of anything posted since the backup you are about to restore:
   `pg_dump -h 127.0.0.1 -p 5434 -U erp_owner -d erp -Fc -f /root/erp-backups/erp-before-recovery-$(date -u +%Y%m%d-%H%M%S).dump`
3. **Choose the dump to restore.** The newest that the drill has passed, or
   the newest that predates the damage. `ls -lt /root/erp-backups/*.dump`.
4. **Restore into a fresh database first**, never over the live one:
   `createdb -h 127.0.0.1 -p 5434 -U erp_owner erp_recovered`
   `pg_restore -h 127.0.0.1 -p 5434 -U erp_owner -d erp_recovered --exit-on-error <dump>`
   If this fails, the dump is not restorable as-is; go back to step 3 with an
   older one, or fix the named constraint in the restored copy by hand and
   write down what you did.
5. **Look at the copy.** Row counts, the newest posting, the ledger check
   (`DATABASE_URL_OWNER=postgres://erp_owner:<pw>@127.0.0.1:5434/erp_recovered npx tsx scripts/ops/stock-movement-trace.ts`).
   Decide, with the owner, whether what was posted after the dump is re-entered
   by hand or accepted as lost.
6. **Swap.** Rename the databases so the live name points at the good copy:
   `psql -d postgres -c "alter database erp rename to erp_damaged_$(date -u +%Y%m%d)"`
   `psql -d postgres -c "alter database erp_recovered rename to erp"`
   The application's `.env` does not change.
7. **Start the application** (`pm2 start qs-erp`) and run the nightly check by
   hand: `cd /opt/qs-erp-next && node_modules/.bin/tsx scripts/ops/inventory-integrity-check.ts`.
8. **Write it up** in `docs/INCIDENTS.md`: what was lost, what was restored,
   what was re-entered, and what is being changed so it does not happen again.

Keep `erp_damaged_*` until the owner has looked at the recovered system and
said it is right. Then drop it.

---

## Things that must not be done to the live database

* **Do not run `format-live-database.sh`.** It refuses while
  `/opt/qs-erp-next/var/LIVE` exists, and that file is there because the books
  are live. Trials and demos belong on a database that is not this one.
* **Do not delete with triggers or foreign keys disabled** (`set
  session_replication_role = replica`) unless you have the complete list of
  dependent tables in front of you. Both incidents on 2026-09-27 came from
  exactly this: rows left pointing at rows that were gone.
* **Do not point a test suite at it.** `DATABASE_URL_TEST` must name a database
  the suite may destroy.
* **Do not edit a posted document's rows.** A posted invoice is corrected by
  reversing it (the Reverse action on its page); stock is corrected by a
  return, a reconciliation or a reversal — every one of them a new row, never a
  changed one.
