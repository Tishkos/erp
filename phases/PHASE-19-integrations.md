# Phase 19 — Integrations, APIs & External Interfaces

> **Blueprint:** §23, Appendix E (OWASP ASVS)
> **Release (§27):** 10 — Reporting and Go-Live
> **Depends on:** 01, 02
> **Blocks:** 20

---

## Purpose

§23: expose controlled, versioned interfaces for approved external systems **without granting direct database access**.

> §23: "Direct writes to production ERP tables by external systems are prohibited."

---

## Sub-phases

### 19.1 API gateway, versioning and conventions

**Build** — the §23 "Minimum API design conventions" table in full:

| Area | Requirement |
|---|---|
| Authentication | Machine identities, least-privilege scopes, short-lived tokens or mutual TLS |
| Authorisation | Server-side permission and data-scope checks per request and per record |
| Identifiers | Stable UUID/internal ID plus human-readable document number; external reference stored separately |
| Validation | Structured field-level and business-rule errors; no stack traces or sensitive internals |
| Idempotency | Required on create/post/payment/settlement; duplicate keys return the original result |
| Concurrency | Optimistic version or equivalent; explicit locking for critical posting/settlement |
| Pagination | Cursor or stable page pagination; deterministic sorting |
| Auditability | Actor/client, source IP where lawful, request ID, event, target, outcome |
| Observability | Correlation ID, metrics, tracing, health endpoints without exposing secrets |
| Compatibility | Published schema, semantic versioning, test environment, deprecation notice |

**Blueprint rules enforced**
- §23 — *"APIs are versioned; breaking changes require a new version and deprecation period"*
- §23 — *"Every create/update API must enforce the same permissions and business validations as the user interface"*

**Test gate**
- [ ] Every one of the ten convention rows is verified by a test
- [ ] An API create enforces the identical permission and validation set as the UI — proven by running the same negative cases through both
- [ ] An error response contains structured field-level detail and **no** stack trace or internal path
- [ ] Pagination is stable under concurrent inserts — no row appears twice or is skipped
- [ ] A breaking change requires a new version; the prior version continues to work

---

### 19.2 Machine identity and scope management

**Build** — API client/application management with scopes, secrets/certificates and expiry

**Blueprint rules enforced**
- §23 — *"Secrets are stored outside source code, rotated and never included in logs"*
- §23 — *"Sensitive fields are encrypted in transit and masked in support logs"*

**Test gate**
- [ ] A client can only reach endpoints within its granted scopes
- [ ] An expired credential is rejected
- [ ] Rotating a secret does not require a code deployment
- [ ] No secret appears in any log, error message or trace
- [ ] Sensitive fields are masked in support logs

---

### 19.3 Idempotency and atomic processing

**Build**
- Idempotency key store returning the original result on replay
- Accepted messages receive a correlation ID and are processed atomically or queued
- Time-outs and partial failures must not leave half-created business documents

**Blueprint rules enforced**
- §23 — *"Idempotency keys prevent duplicate documents when a sender retries"*
- §23 — *"Time-outs and partial failures must not leave half-created business documents"*
- §23 acceptance criterion 1 — *"Repeated delivery of the same idempotent request creates only one ERP transaction"*
- §23 acceptance criterion 2 — *"Invalid or unauthorised requests are rejected without partial data changes"*

**Test gate**
- [ ] The same idempotent request delivered five times creates exactly one ERP transaction and returns the same response each time
- [ ] A request that fails validation leaves **no** partial data
- [ ] A client time-out mid-request leaves either a complete document or none — never a partial
- [ ] An unauthorised request changes nothing
- [ ] Concurrent delivery of the same idempotency key resolves to one transaction, not a race

---

### 19.4 Accounting interfaces

**Build** — controlled posting from external sources

**Blueprint rules enforced**
- §23 — *"An interface cannot post accounting entries without a defined source type, posting profile and reconciliation owner"*

**Test gate**
- [ ] An interface without a defined source type cannot post
- [ ] An interface without a posting profile cannot post
- [ ] An interface without a named reconciliation owner cannot post
- [ ] Interface postings go through the Phase 02.7 engine like any other, with the same atomicity and idempotency

---

### 19.5 Webhooks and event subscriptions

**Build** — subscription management for the §23 event examples: opportunity converted, purchase order approved, goods received, invoice posted, payment applied, stock below threshold, transfer settled, project milestone approved

**Blueprint rules enforced**
- §24 — events emit **after** commit

**Test gate**
- [ ] Events fire after commit — a subscriber failure does not roll back the business transaction
- [ ] Each of the eight example events fires correctly
- [ ] Event delivery retries and dead-letters per the Phase 01.10 job policy
- [ ] Event payloads respect data classification — no sensitive field leaks to an unscoped subscriber

---

### 19.6 File import centre

**Build** — bank statements, master data and migration files, over the Phase 01.11 import framework

**Test gate**
- [ ] File imports enforce the same permissions and validations as the API and UI
- [ ] Bank statement import feeds Phase 07.6 with duplicate prevention
- [ ] Import batches are traceable and reversible before final posting

---

### 19.7 Integration mappings

**Build** — external code to ERP master/document mapping; master-data ownership defined per interface

**Blueprint rules enforced**
- §23 — *"Master-data ownership is defined per interface to avoid conflicting updates"*

**Test gate**
- [ ] An unmapped external code is reported, not silently created as a new master
- [ ] Two interfaces cannot both own the same master field — ownership is declared and enforced
- [ ] Unmatched external codes appear in the required report

---

### 19.8 Monitor, retry and dead-letter queue

**Build** — inbound/outbound message monitor, retry queue, dead-letter queue, technical logs with correlation identifiers

**Blueprint rules enforced**
- §23 — *"Failed messages enter an exception queue with retry policy, ownership and alert"*
- §23 acceptance criterion 4 — *"Failed messages can be corrected and replayed without editing production tables"*

**Test gate**
- [ ] A failed message enters the exception queue with owner and alert
- [ ] A dead-lettered message can be corrected and replayed **without any direct table edit**
- [ ] Replay respects idempotency — a replayed message that already succeeded creates nothing new
- [ ] Correlation IDs trace a request from source through ERP record to audit log (§23 acceptance criterion 3)

---

### 19.9 Interface reconciliation

**Build** — interface totals and record counts reconciled to source and target; exception dashboard

**Blueprint rules enforced**
- §23 acceptance criterion 5 — *"Reconciliation reports prove completeness for an agreed interface test batch"*

**Test gate**
- [ ] Source-to-target control totals match for an agreed test batch
- [ ] Record counts match and any difference is itemised
- [ ] Unreconciled interface batches are reported and aged
- [ ] The reconciliation report is produced automatically, not assembled by hand

---

### 19.10 Integration reports

**Build** — per §23: interface volume, latency, success/failure and retry metrics; unmatched external codes and duplicate-message prevention events; source-to-target control totals and unreconciled batches; API usage by client, scope and endpoint; security events including invalid token, forbidden action, rate-limit breach and suspicious payload.

**Test gate**
- [ ] All five report groups exist and populate from real interface activity
- [ ] Security events surface in the Phase 20 monitoring
- [ ] Duplicate-message prevention events are counted and visible

---

## Phase exit gate

§23 minimum acceptance criteria, verbatim:

| # | Criterion | Evidence |
|---|---|---|
| 1 | Repeated delivery of the same idempotent request creates only one ERP transaction | 19.3 gate |
| 2 | Invalid or unauthorised requests are rejected without partial data changes | 19.3 gate |
| 3 | Every interface transaction can be traced using a correlation ID from source to ERP record and audit log | 19.8 gate |
| 4 | Failed messages can be corrected and replayed without editing production tables | 19.8 gate |
| 5 | Reconciliation reports prove completeness for an agreed interface test batch | 19.9 gate |

**End-to-end scenario (§26 critical UAT list):**
> Integration duplicate retry and failure recovery without duplicate posting

**Sign-off:** Business Process Owner approves the interface catalogue and, per 19.4, each interface's named reconciliation owner.

---

## Notes for the team

**The prohibition on direct database writes is absolute.** §23 states it plainly, and §23 acceptance criterion 4 reinforces it: failed messages are corrected and replayed *"without editing production tables."* The moment a support process involves an UPDATE against a production table, every control in Phases 01 and 02 — audit, status machine, posting atomicity — has been bypassed. Build the replay tooling well enough that no one is tempted.
