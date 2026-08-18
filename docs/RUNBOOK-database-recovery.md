# Runbook — database backup and recovery

**Phase 00.3 gate:** *"The documented recovery procedure is executed once and
succeeds."*
**Blueprint §25:** backup and recovery are named non-functional requirements;
**§26** makes a proven restore a go-live gate.

A backup that has never been restored is not a backup. This procedure exists to
be rehearsed, and the rehearsal is scripted (`scripts/verify-recovery.ts`) so
that "we tested it once in 2026" does not become the answer.

---

## What is protected

| | |
|---|---|
| **Database** | PostgreSQL 17, database `erp` |
| **Contains** | every posted journal, subledger, document, attachment reference and audit event |
| **Does not contain** | attachment *content* — that lives in object storage and has its own lifecycle (§21, Phase 01.8) |
| **Recovery point objective (RPO)** | **15 minutes** for the database, **1 hour** for attachments — D4, decided 2026-08-17. |
| **Recovery time objective (RTO)** | **2 hours** for critical services — D4. |
| **Service availability** | 99.9% monthly, excluding authorised maintenance — D4. |

**The 15-minute RPO changes this procedure, and the change is not yet made.**

A nightly `pg_dump` — which is what the rest of this runbook describes — risks up
to 24 hours of posted transactions. Reaching 15 minutes needs continuous
archiving: WAL archiving to independent storage, or streaming replication to a
standby, so that recovery can roll forward to a point in time rather than back to
last night.

That is Phase 20.3 work. Until it is done, **this runbook's actual RPO is one
day, not fifteen minutes**, and anyone relying on it should know that. The dump
and restore below remain correct and remain the fallback; they are not yet
sufficient for the target the Business Process Owner has set.

Attachment content lives in object storage, not in the database (§21, Phase
01.8), so the 1-hour attachment RPO is a separate mechanism with its own
schedule — it cannot be met by backing up Postgres more often.

---

## Taking a backup

```bash
# Logical backup — portable across versions, and restorable table by table.
docker exec erp-postgres pg_dump -U erp_owner -Fc -d erp > erp-$(date +%Y%m%d-%H%M).dump
```

`-Fc` (custom format) rather than plain SQL: it compresses, it restores in
parallel, and `pg_restore --list` can show exactly what is in it before anything
is written.

**What the dump does not carry:** roles. `erp_owner` and `erp_app` are cluster
objects, created by `scripts/sql/00-init-roles.sql`. A restore into a fresh
cluster runs that first, or every `GRANT` in the dump fails and the application
connects to a database it has no rights on.

---

## Restoring

Into a **new** database, never over a live one. Restoring over the top leaves a
half-old, half-new schema if it fails midway, and the failure mode is a system
that starts and serves wrong figures.

```bash
# 1. Roles, if the cluster is new.
docker exec -i erp-postgres psql -U postgres -f - < scripts/sql/00-init-roles.sql

# 2. An empty target.
docker exec erp-postgres psql -U erp_owner -d postgres -c 'CREATE DATABASE erp_restored'

# 3. The data.
docker exec -i erp-postgres pg_restore -U erp_owner -d erp_restored --no-owner < erp-YYYYMMDD-HHMM.dump

# 4. Prove it before trusting it — see below.
npx tsx scripts/verify-recovery.ts erp_restored

# 5. Only then, swap.
```

---

## Proving a restore

A restore that completed without error is not yet a restore that worked.
`scripts/verify-recovery.ts` asserts the things that would be silently wrong:

1. **Schema is at head** — the `drizzle.__drizzle_migrations` journal matches the
   migration files, so the restored database is not a version behind the code
   that will connect to it.
2. **Row-level security is still enforced** — `relrowsecurity` **and**
   `relforcerowsecurity` on every table that had them. A dump/restore that lost
   `FORCE` would leave a database that looks right and leaks across branches.
3. **The append-only triggers exist** — audit events and posted journals are
   still immutable.
4. **The application role holds no `DELETE`** on the document tables. `--no-owner`
   changes ownership; if grants did not come through, the application would
   either fail to start or, worse, run with the owner's rights.
5. **The ledger balances** — total debits equal total credits in IQD across every
   posted journal. This is the one check that would catch a partial restore that
   passed every structural test.

Any failure exits non-zero and names what is wrong.

---

## Rehearsal record

| Date | Performed by | Dump taken | Restore target | Result |
|---|---|---|---|---|
| 2026-08-17 | Implementation team | development `erp` | `erp_restored` | **Pass** — all five checks; see below |

The 2026-08-17 rehearsal was run against the development database as the first
exercise of this procedure.

**D4 sets the schedule** — a backup job reporting success is not evidence of a
usable backup:

| Frequency | Test |
|---|---|
| Monthly | Automated or sample restoration |
| Quarterly | Full database restoration |
| Every 6 months | Disaster-recovery exercise |
| After a major infrastructure change | Additional recovery test |

Each test records the backup used, the start and completion time, **whether the
2-hour RTO was met**, whether the integrity checks passed, any problems found,
and the corrective actions taken.

It must also be repeated against a **production-sized** dataset before go-live
(§26 gate). A rehearsal against 5 seeded accounts proves the procedure is
correct; it proves nothing about the RTO, because nothing here takes long enough
to measure.

## Retention — D4

| Backup | Retention |
|---|---|
| Transaction logs / continuous recovery | 35 days |
| Daily | 30 days |
| Weekly | 12 weeks |
| Monthly | 12 months |
| Year-end | 7 years, subject to Finance and Legal |

All copies encrypted. At least one copy independent of the production
environment — a failure, deletion or destructive security incident affecting
production must not be able to destroy every recovery copy.

---

## If the restore fails

1. **Do not** delete the failed target — it is evidence.
2. `pg_restore --list` the dump to confirm the object is present at all.
3. Restore schema and data separately (`--schema-only`, then `--data-only`) to
   find which half fails.
4. If the dump itself is damaged, go to the previous one and accept the larger
   data loss — then record the incident, because two consecutive damaged dumps
   is a backup process that is not working rather than bad luck.

Escalation: Business Process Owner, per the §28.2 clarification route. A
recovery decision that trades data loss against downtime is a business decision,
not a technical one.
