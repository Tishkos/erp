# Tech Stack

**Project:** Integrated ERP System
**Source of truth:** `ERP Build Map (2).pdf` — *Integrated ERP System Blueprint | Approved Business & Functional Requirements* (45 pages, 28 sections + Appendices A–E)
**Status:** Part A complete · Part B awaiting stack list

---

## How to read this document

**Part A** lists the technical constraints the blueprint imposes on *any* stack. These are not preferences — each one traces to an approved requirement, and a stack that cannot satisfy them cannot deliver the system.

**Part B** records the chosen technologies and checks each one against Part A.

---

# Part A — Mandatory technical constraints

These are derived from the blueprint. Section references are to the source document.

## A1. Atomic posting requires a real transactional database

> "Posting must be atomic: either all journal/subledger/inventory records commit, or none do." — §24
> "Forced technical failure during posting leaves no partial journal, subledger or stock movement." — §24 acceptance criteria

| Requirement | Implication |
|---|---|
| One posting event writes journal header, journal lines, subledger entries and inventory movements in a single commit | ACID relational database with multi-statement transactions |
| No partial financial state under failure | The posting path cannot cross a network boundary mid-transaction — no two-phase writes to separate stores |
| Concurrent postings must not corrupt FIFO layers or stock | Serialisable or explicitly-locked isolation on the inventory/costing path |

**Rules out for the posting path:** eventually-consistent stores, document databases without multi-document transactions, microservice splits that put journal and subledger in separate databases.

## A2. Append-only ledgers and audit

> "Posted journals and subledger entries are append-only; corrections create new linked entries." — §24
> "Audit entries cannot be edited or deleted by application users." — §5.4
> "No deletion of saved or posted records." — §1.1

| Requirement | Implication |
|---|---|
| Posted journals, subledger entries, inventory movements and audit events are immutable | Enforce at the **database** level, not only in application code — the application role must not hold `UPDATE`/`DELETE` on these tables |
| Corrections create new linked rows | Every reversible entity carries `reversed_by` / `reverses` links |
| Audit captures before/after values, actor, action, reason, session | Structured audit event table, append-only, written inside the same transaction as the change |

## A3. Authorisation is server-side and deny-by-default

> "Use deny-by-default, server-side authorisation for every page, API and record. Navigation hiding alone is not access control." — §25
> "Row-level security is enforced in the query layer, not only hidden in the screen." — §22
> "Every create/update API must enforce the same permissions and business validations as the user interface." — §23

| Requirement | Implication |
|---|---|
| Permission checks on every request **and every record** | Authorisation lives in the data-access layer, shared by UI and API — never duplicated per screen |
| Data scope by branch and department | Row-level filtering applied in the query itself |
| Permission verbs: View, Create, Edit Draft, Submit, Approve, Execute, Post, Reverse/Cancel, Print, Export, Import, Configure, Administer — §5.3 | A 13-verb permission model, separate from department access and approval authority |
| Security test must prove direct URL/API access is blocked — §25 acceptance criteria | Automated authorisation tests are a build requirement, not a QA afterthought |

## A4. Money and currency representation

> "All money fields store transaction currency amount, base currency amount, currency and rate/reference." — §24
> "IQD is the primary transaction and ledger currency; USD values are reporting equivalents calculated using approved historical exchange rates." — §1.1

Every monetary value is a **four-part tuple**, not a number:

```
amount_txn        exact decimal   amount in the transaction currency
currency_code     char(3)         ISO code of the transaction currency
amount_iqd        exact decimal   balancing amount in IQD (primary ledger currency)
amount_usd        exact decimal   reporting equivalent at the historical rate
rate_ref          fk              the rate record used, with effective date and source
```

| Requirement | Implication |
|---|---|
| Exact decimal arithmetic | `NUMERIC`/`DECIMAL` with fixed scale. **Binary floating point is prohibited anywhere in the money path** — including the API serialisation layer and the browser |
| Historical rates, never current rates, on reprint | Rate is captured at posting and stored on the row; reports never recompute from today's rate — §22, Appendix D |
| Balanced in IQD | `SUM(debit_iqd) = SUM(credit_iqd)` enforced as a database constraint per journal |

This is the single hardest thing to retrofit. It must be in the schema from the first migration.

## A5. Idempotency and duplicate prevention

> "The system shall prevent duplicate posting through transaction identifiers and idempotency controls." — §3.1
> "Each posting batch includes a deterministic source reference to prevent duplicate posting." — §24
> "Repeated delivery of the same idempotent request creates only one ERP transaction." — §23 acceptance criteria

| Requirement | Implication |
|---|---|
| Deterministic source reference per posting event | Unique index on `(source_module, source_doc_id, source_line_id, event_type)` |
| API idempotency keys on create/post/payment/settlement | Idempotency key store with the original response, returned on replay |
| Document numbers never reused | Transactional sequence allocation, auditable, with gap reporting — §24 |

## A6. Concurrency control

> "Optimistic version or equivalent conflict detection for updates; explicit locking for critical posting/settlement." — §23

Every updatable record carries a `version` column. Posting, settlement, stock reservation and FIFO consumption take explicit locks.

## A7. Attachments and object storage

> "The file is stored using an immutable object identifier and linked to the parent record; later versions do not overwrite prior versions." — §21
> "Financial evidence attached to a posted transaction is immutable." — §21

| Requirement | Implication |
|---|---|
| Immutable object IDs, versioned | Object storage with write-once semantics; database holds metadata + content hash |
| Malware scanning before acceptance | Scan step in the upload pipeline; quarantine on failure |
| Access inherits from parent record | Attachment authorisation resolves through the parent, never standalone |
| No executable file types unless explicitly authorised and isolated | Server-side content-type verification, not extension trust |
| Retention periods and legal hold are configurable | Retention metadata + hold flag; disposal is an audited administrative action |
| External sharing uses expiring links with named recipients; public anonymous links prohibited | Signed, time-limited, recipient-bound URLs with download logging |

## A8. Background processing

Required by: depreciation runs (§18), recurring journals (§14.5), notification delivery and escalation (§21), bulk import (§4.4), scheduled report distribution (§22), integration retry and dead-letter queues (§23), document expiry reminders (§21).

| Requirement | Implication |
|---|---|
| Durable scheduled and queued jobs | Job store survives restart; no in-memory-only timers |
| Retry with dead-letter | Failed jobs are visible, owned and replayable — §23 |
| Jobs are observable | "Documents stuck in a status beyond target time" is a required report — §24 |
| Posting events emit **after** commit | "The posting engine emits events after commit so downstream notifications cannot cause partial financial posting." — §24 |

## A9. Reporting must not run on the posting path

> "Dashboards use governed aggregates/read replicas where needed, not expensive uncontrolled queries on the posting path." — §25
> "A dashboard is a presentation layer, not an accounting ledger." — §22
> "External BI tools may connect only through read-only governed datasets or APIs." — §22

| Requirement | Implication |
|---|---|
| Read/write separation for reporting | Read replica or governed materialised views |
| Large exports and reports run asynchronously | Report jobs, not synchronous HTTP responses |
| A common semantic layer defines customer, supplier, item, project, department, warehouse, currency and period consistently | One shared definition layer — reports do not each re-implement joins |
| Row-level security applies to reports and exports identically | Security in the view/query layer, not the report definition |

## A10. Date and time model

> "All dates distinguish document date, posting date, due date, tax date if required, and system timestamps." — §24

Business dates (document, posting, due, value, available-for-use) are **calendar dates** without timezone. System timestamps (created, updated, audit) are timezone-aware instants. These are different types and must not be conflated.

## A11. Internationalisation architecture

> "English is the initial business language; localisation architecture shall allow Arabic labels and right-to-left layout later without redesign." — §25

| Requirement | Implication |
|---|---|
| No hardcoded user-facing strings | Message catalogue from the first screen |
| RTL-capable layout | Logical CSS properties (`inline-start`/`inline-end`), never `left`/`right` |
| Explicit number, date and currency formatting | "Dates, currencies, quantities and number formats are explicit and cannot be misread across locales." — §25 |

Retrofitting RTL is a redesign. This is a day-one constraint even though launch is English-only.

## A12. Environments, migrations and release control

> "Use separate development, test/UAT and production environments with controlled promotion; production changes are never made directly." — §25
> "Database schema changes use versioned migrations with rollback or recovery plan and tested backup." — §25
> "Every release has scope, migration notes, test evidence, approvals and rollback plan." — §25

Three environments minimum. Forward-only migrations with a documented recovery path. Configuration separated from code and audited.

## A13. Security baseline

From §25, aligned to OWASP ASVS and NIST CSF 2.0 (Appendix E reference basis):

- Strong password policy, temporary-password setup, **MFA for privileged and high-risk roles**, session expiry, immediate revocation
- Least privilege and segregation of duties; privileged access time-bound and periodically reviewed
- Encryption in transit; sensitive data encrypted at rest with **keys managed separately from application code**
- Field-level masking of bank details and identity documents by role and purpose
- Input validation, output encoding, CSRF controls, rate limiting, secure file handling, dependency management
- Security event logging: authentication, authorisation failures, privilege changes, exports, configuration changes, sensitive-data access
- **No passwords, tokens, private keys or sensitive document contents in logs**
- Independent penetration test with agreed findings remediated **before production launch**

## A14. API design conventions

From §23, "Minimum API design conventions":

| Area | Requirement |
|---|---|
| Authentication | Machine identities, least-privilege scopes, short-lived tokens or mutual TLS |
| Authorisation | Server-side permission and data-scope checks per request **and per record** |
| Identifiers | Stable internal UUID **plus** human-readable document number; external reference stored separately |
| Validation | Structured field-level errors; no stack traces or internals returned |
| Idempotency | Required on create/post/payment/settlement; duplicate keys return the original result |
| Concurrency | Optimistic versioning; explicit locking for posting/settlement |
| Pagination | Cursor or stable pagination with deterministic sorting |
| Auditability | Actor, client, source IP where lawful, request ID, event, target, outcome |
| Observability | Correlation ID, metrics, tracing, health endpoints — without exposing secrets |
| Compatibility | Published schema, semantic versioning, test environment, deprecation notice |

## A15. Availability and recovery — *targets not yet set*

§25 lists availability, RPO, RTO, backup retention, restore testing, HA and DR as "**minimum business requirement to be confirmed**". Infrastructure cannot be sized and Phase 20 cannot be completed until these numbers exist. Tracked in the decision register (`phases/PHASE-00-program-setup.md`).

---

## A16. Constraint-to-phase map

| Constraint | Built in | Verified in |
|---|---|---|
| A1 Atomic posting | Phase 2 | Phase 2, Phase 20 |
| A2 Append-only ledgers/audit | Phase 1, Phase 2 | Phase 1, Phase 21 |
| A3 Server-side authorisation | Phase 1 | Phase 1, Phase 20 |
| A4 Money and currency | Phase 2 | Phase 2, Phase 16, Phase 18 |
| A5 Idempotency | Phase 2, Phase 19 | Phase 2, Phase 19 |
| A6 Concurrency | Phase 1, Phase 4 | Phase 4, Phase 20 |
| A7 Attachments | Phase 1, Phase 17 | Phase 17 |
| A8 Background jobs | Phase 1 | Phase 1, Phase 20 |
| A9 Reporting separation | Phase 18 | Phase 18, Phase 20 |
| A10 Date/time model | Phase 2 | Phase 2 |
| A11 i18n / RTL-ready | Phase 1 | Phase 20 |
| A12 Environments/migrations | Phase 0 | Phase 20 |
| A13 Security baseline | Phase 1, Phase 20 | Phase 20 |
| A14 API conventions | Phase 19 | Phase 19 |
| A15 Availability/recovery | Phase 20 | Phase 20 |

---

# Part B — Chosen stack

**Decided:** 2026-08-16 · **Source:** `suggesttionTech.md`, reviewed against Part A
**Versions verified against the npm registry on the decision date.**

## B1. Stack register

| Layer | Technology | Version | Part A constraints |
|---|---|---|---|
| Runtime | Node.js | ≥ 22 (dev on 24.14.0) | A1, A8 |
| Language | TypeScript | 5.9.3 | all |
| Web framework | Next.js (App Router) | 16.3.1 | A3, A11, A14 |
| UI runtime | React | 19.2.8 | A11 |
| Database | **PostgreSQL** | 17 | **A1, A2, A4, A5, A6** |
| ORM / query layer | Drizzle ORM | 0.45.2 | A1, A4, A6 |
| Migrations | Drizzle Kit | 0.31.10 | A12 |
| Validation | Zod | 4.4.3 | A14 |
| UI components | shadcn/ui + Tailwind CSS | Tailwind 4.3.3 | A11 |
| Data grids (read) | TanStack Table | 9.1.2 | — |
| Data grids (Excel paste) | AG Grid Enterprise *or* Handsontable | — (commercial) | — |
| Authentication | better-auth | 1.6.29 | A3, A13 |
| Authorisation — verbs | CASL, in the service layer | 7.0.1 | **A3** |
| Authorisation — data scope | PostgreSQL RLS with `FORCE` | — | **A3** |
| Background jobs / queue | **pg-boss** | 12.27.0 | **A8** |
| Object storage | S3 / Cloudflare R2 + SHA-256 + versioning | — | A7 |
| Semantic layer | Cube | — | A9 |
| Dashboards / BI | Metabase | — | A9 |
| Statutory statements | **in-app** (Phase 16.6), not Metabase | — | A9 |
| Internationalisation | next-intl | 4.13.6 | **A11** |
| Testing — unit + integration | Vitest | 4.1.10 | all |
| Testing — end-to-end | Playwright | 1.62.1 | A3 |
| Testing — load | k6 | — | A15 |
| Observability | OpenTelemetry + Sentry | otel-api 1.9.1 | A8, A14 |
| CI/CD | GitHub Actions | — | A12 |
| Hosting | **long-running container**, not serverless | — | A1, A15 |

### Changes made to the original suggestion

| Original | Decision | Reason |
|---|---|---|
| Payload CMS for admin scaffolding | **Dropped** | Creates a third authorisation system alongside CASL and RLS, making §25 deny-by-default unprovable. Owns its own schema, conflicting with Drizzle migrations over a schema that *is* the product. Its generated CRUD admin can `UPDATE`/`DELETE` posted records, which §5.4 and §24 prohibit. Its document versioning is not §14.3 accounting reversal. |
| Inngest for jobs | **pg-boss** | pg-boss lives in the same Postgres, so a job can be enqueued **inside** the posting transaction — the transactional-outbox pattern §24 needs (*"emits events after commit"*) without losing events. With an external service an outbox table is required anyway. Also avoids sending money-transfer event payloads to a third party, which §25 data classification and the Appendix E FATF reference make a decision, not a default. Inngest remains the answer if multi-day orchestration is later needed. |
| WorkOS *or* better-auth | **better-auth** | Self-hosted keeps identity data in the company database — relevant for a regulated money-transfer service. Must be configured with **database-backed sessions, not stateless JWTs**: §25 requires *immediate* revocation, and Phase 01.1's gate is *"revoking a session terminates access on the next request, not at token expiry."* |
| Metabase for reporting | Metabase **for analytics only** | §22 requires statements from account-to-report-line mappings, drill to journal and source document, and frozen re-openable management packs. Metabase does none of these. §22: *"A dashboard is a presentation layer, not an accounting ledger."* Statements are built in Phase 16.6. |
| TypeScript 7.0.2 (latest) | **5.9.3** | TS 7 is the native compiler port. Drizzle Kit declares no TypeScript peer range, so it is untested against it. Upgrade path once the toolchain settles. |

## B2. Constraint verification

| # | Constraint | How this stack meets it | Verified in |
|---|---|---|---|
| A1 | Atomic posting | Postgres transactions; Drizzle `db.transaction()` gives a real transaction block; the whole posting path in one process, one connection | Phase 02.7 |
| A2 | Append-only ledgers/audit | `REVOKE UPDATE, DELETE` on ledger and audit tables from the app role, plus `BEFORE UPDATE OR DELETE` triggers raising an exception | Phase 01.4, 02.9 |
| A3 | Server-side deny-by-default | Two layers only: **CASL** for the 13 verbs in the service layer, **Postgres RLS** for branch/department rows. `FORCE ROW LEVEL SECURITY` and a non-owner app role so RLS cannot be bypassed | Phase 01.2, 20.1 |
| A4 | Money and currency | `numeric(19,4)` for money; **`numeric(18,8)` for rates**, stored as IQD-per-USD | Phase 02.3 |
| A5 | Idempotency | Unique partial index on the deterministic source reference; idempotency-key table returning the original response | Phase 02.7, 19.3 |
| A6 | Concurrency | `SELECT … FOR UPDATE` on FIFO layers; `pg_advisory_xact_lock` for gapless numbering; `version` column for optimistic updates | Phase 01.5, 04.2 |
| A7 | Attachments | S3/R2, SHA-256 content hash, object versioning; **authenticated redirect endpoint** issuing short-lived presigned URLs — never a raw presigned URL shared externally | Phase 01.8, 17.8 |
| A8 | Background jobs | pg-boss: durable, cron, retry, dead-letter, all in Postgres; enqueue inside the posting transaction | Phase 01.10 |
| A9 | Reporting separation | Read replica → Cube semantic layer → Metabase. Cube enforces branch/department scope before Metabase sees a row | Phase 18.1, 18.2 |
| A10 | Date/time model | `date` for business dates, `timestamptz` for system instants — distinct column types | Phase 02.5 |
| A11 | i18n / RTL-ready | next-intl message catalogue; Tailwind logical properties (`ps-`/`pe-`/`ms-`/`me-`); `dir` attribute switching | Phase 01.12, 20.5 |
| A12 | Environments/migrations | Drizzle Kit versioned SQL migrations, applied in CI; three environments; no direct production change | Phase 00.2, 00.3 |
| A13 | Security baseline | better-auth (MFA, DB sessions); TLS; pgcrypto or KMS for sensitive columns with keys outside code; OWASP ASVS review | Phase 20.1, 20.2 |
| A14 | API conventions | Next.js Route Handlers under `/api/v1`, sharing `src/server/domain` with the UI — **one code path**. Server Actions are a UI transport only, never a second implementation | Phase 19.1 |
| A15 | Availability/recovery | Container deployment, managed Postgres with PITR — **sizing blocked on D4/D5** | Phase 20.3, 20.4 |

### Open risks accepted with this stack

| Risk | Mitigation | Owner |
|---|---|---|
| Postgres RLS is bypassed by table owners and superusers | App connects as a **non-owner** role; every RLS table declares `FORCE ROW LEVEL SECURITY`; asserted by an automated test | Phase 01.2 |
| Metabase open source has no row-level sandboxing (paid tier only) | Scope enforced in **Cube** before Metabase; or budget Metabase Pro | Phase 18.2 — decide before Phase 18 |
| Next.js on serverless breaks long transactions and connection pooling | Deploy as a long-running container; posting path never runs on an edge or function runtime | Phase 00.2 |
| AG Grid Enterprise / Handsontable are commercially licensed | Budget line item; licence required before Phase 05.1 | Procurement — before Phase 05 |
| Two grid libraries (TanStack read, AG Grid entry) | Deliberate: TanStack for lists, AG Grid only for clipboard-paste entry grids (§7.2, §8.3) | Phase 01.12 |

## B3. Testing tooling per phase

Every sub-phase in `phases/` carries a **test gate** written as assertions to prove. This maps each class of assertion to the tool that runs it.

| Assertion class | Where it appears | Tool | Command |
|---|---|---|---|
| Calculation and business-rule units | every phase | Vitest | `npm run test:unit` |
| Domain purity (no framework imports in `src/server/domain`) | Phase 00.5 | Vitest | `npm run test:unit` |
| Posting atomicity, idempotency, FIFO under concurrency | Phases 02, 04–16 | Vitest against a real Postgres | `npm run test:integration` |
| Append-only enforcement | Phases 01, 02 | Vitest against a real Postgres | `npm run test:integration` |
| Authorisation, data scope, direct-URL/API denial | Phases 01, 20 | Vitest (API) + Playwright (UI) | `npm run test:integration`, `npm run test:e2e` |
| Subledger-to-G/L reconciliation | Phases 04–16 | Vitest against a real Postgres | `npm run test:integration` |
| End-to-end business scenarios (§26, twelve scenarios) | Phases 06, 09, 11, 21 | Playwright | `npm run test:e2e` |
| Load, endurance, peak month-end | Phase 20.4 | k6 | `npm run test:load` |
| Restore, failover, DR | Phase 20.3 | manual runbook with recorded evidence | `docs/runbooks/` |
| Penetration test | Phase 20.2 | independent third party | external |

**Rule:** anything asserting a database guarantee — atomicity, append-only, RLS, locking, constraints — runs as an **integration** test against a real PostgreSQL instance. Mocking the database in those tests proves nothing, because the guarantee being tested belongs to the database.

---

*Related: [`PHASES.md`](PHASES.md) — the 22-phase build plan.*
