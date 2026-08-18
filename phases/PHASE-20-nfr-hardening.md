# Phase 20 — Non-Functional Hardening

> **Blueprint:** §25, Appendix E (NIST CSF 2.0, OWASP ASVS, OWASP Logging, OWASP Broken Access Control, COSO)
> **Release (§27):** 10 — Reporting and Go-Live
> **Depends on:** all phases
> **Blocks:** 21
> **Blocked by decisions:** **D4** (availability, RPO, RTO), **D5** (volumes and concurrency), **D6** (accessibility level)

---

## Purpose

§25 opens by stating that functional requirements *and* the security, continuity, performance, usability and support requirements are **mandatory implementation constraints**. This phase proves them.

Three of the sub-phases cannot complete until the Business Process Owner supplies numbers the blueprint marks "to be confirmed". Raise D4, D5 and D6 early — they are cheap to answer and expensive to wait for.

---

## Sub-phases

### 20.1 Security hardening

**Build and verify** — the §25 security and privacy list:
- Deny-by-default server-side authorisation on every page, API and record
- Password policy, temporary-password setup, MFA for privileged roles, session expiry, immediate revocation
- Least privilege, segregation of duties, time-bound privileged access, periodic review
- Encryption in transit; sensitive data encrypted at rest with keys managed separately from application code
- Field masking for bank details, identity documents and other sensitive fields
- Secure coding, dependency management, input validation, output encoding, CSRF controls, rate limiting, secure file handling
- Security event logging: authentication, authorisation failures, privilege changes, exports, configuration changes, sensitive-data access
- No passwords, tokens, private keys, sensitive document contents or unnecessary personal data in logs
- Data classification, retention, lawful access and incident response responsibilities defined **before go-live**

**Test gate**
- [ ] **§25 acceptance criterion 1:** security testing confirms inaccessible modules and records cannot be reached through direct URL or API — run against every module, not a sample
- [ ] A privileged action without MFA is refused
- [ ] Session revocation takes effect on the next request
- [ ] Dependency scan shows no unremediated high-severity finding
- [ ] Log inspection across all services finds zero secrets and zero unnecessary personal data
- [ ] Masking applies by role in screen, export and API
- [ ] All nine security event categories are logged
- [ ] Data classification, retention, lawful access and incident response are documented and approved

---

### 20.2 Independent penetration test

**Build** — engage an independent tester; remediate agreed severity findings

**Blueprint rules enforced**
- §25 — *"Perform independent penetration testing and remediate agreed severity findings before production launch"*
- §26 testing layers — Security testing evidence: *"Access matrix tests, scan/penetration report and remediation"*

**Test gate**
- [ ] An independent penetration test has been performed against a production-like environment
- [ ] Every agreed severity finding is remediated and retested
- [ ] The access matrix test covers every role × module combination
- [ ] Remediation evidence is recorded against each finding

**This is a hard gate on production launch, not a recommendation.**

---

### 20.3 Availability, continuity and recovery — ⚠ BLOCKED on D4

The §25 table lists eight requirement areas, every one marked *"minimum business requirement to be confirmed"*:

| Area | Needed from the Business Process Owner |
|---|---|
| Service availability | Target and authorised maintenance window |
| Recovery Point Objective | Maximum acceptable data loss, separately for database and attachments |
| Recovery Time Objective | Maximum acceptable restoration time |
| Backups | Retention schedule |
| Restore testing | Frequency |
| High availability | Design appropriate to the approved RTO |
| Disaster recovery | Invocation criteria, roles, contacts, alternate environment, return-to-primary |
| Business continuity | Manual contingency for critical receipts, deliveries, bank movements and approvals during outage |

**Build** — automated encrypted backups with off-system/off-site copy and monitored success/failure; scheduled full restore tests to an isolated environment; HA design; documented DR procedure; manual contingency procedures

**Test gate**
- [ ] **§25 acceptance criterion 2:** backup restoration succeeds in an isolated test and meets the approved recovery objectives
- [ ] Measured recovery time is recorded and compared against the approved RTO
- [ ] Measured data loss is recorded and compared against the approved RPO
- [ ] A backup failure raises an alert — verified by inducing one
- [ ] No single undocumented point of failure exists in the production design
- [ ] The DR procedure is executed once, including return-to-primary
- [ ] Manual contingency procedures exist for receipts, deliveries, bank movements and approvals, with controlled capture afterwards

---

### 20.4 Performance and scalability — ⚠ BLOCKED on D5

Sizing requires: target concurrent users, annual transaction volumes, attachment volume, integration throughput, data-retention horizon (§25).

**Build and verify**
- Pagination and indexed filters on all list and search screens
- Asynchronous large exports and reports
- Posting performance targets covering normal **and high-line-count** documents without sacrificing atomicity
- Governed aggregates or read replicas for dashboards
- Load and endurance tests including peak month-end activity, imports, background jobs and simultaneous reporting
- Performance monitoring: response time, database latency, queue depth, error rate, capacity trends

**Test gate**
- [ ] **§25 acceptance criterion 3:** peak-load tests meet approved response and posting targets without errors or data inconsistency
- [ ] A high-line-count document posts within target **and remains atomic**
- [ ] Endurance test over a sustained period shows no memory or connection leak
- [ ] The month-end scenario — close activity, imports, background jobs and reporting simultaneously — meets targets
- [ ] Dashboard load does not degrade posting throughput
- [ ] Every list and search screen uses pagination and indexed filters
- [ ] Performance monitoring records all five metric classes

---

### 20.5 Usability and accessibility — ⚠ BLOCKED on D6

**Build and verify** — the §25 usability list:
- Consistent navigation, terminology, status colours, action placement and keyboard behaviour across modules
- Responsive design for approved desktop/tablet/mobile scenarios; financial entry optimised for desktop
- English initial language with localisation architecture allowing Arabic labels and RTL later **without redesign**
- Explicit date, currency, quantity and number formats
- Validation messages identifying field, reason and corrective action
- Accessibility to the level selected by the company, including keyboard navigation and meaningful labels

**Test gate**
- [ ] A consistency audit across all 21 menu areas finds no divergence in navigation, terminology, status colours or action placement
- [ ] Every screen is fully operable by keyboard
- [ ] Switching to RTL produces a usable interface with **no code change**
- [ ] No user-facing string is hardcoded
- [ ] Number, date and currency formats are unambiguous across locales
- [ ] Zero generic "something went wrong" messages remain for business errors
- [ ] The accessibility level chosen in D6 is met and evidenced

---

### 20.6 Maintainability, support and operations

**Build and verify** — the §25 operations list:
- Three environments with controlled promotion; no direct production changes
- Versioned migrations with rollback or recovery plan and tested backup
- Configuration separated from code, changes audited
- Automated unit, integration and end-to-end tests covering critical posting and permission paths
- Application, database, job, integration and security monitoring feeding a support dashboard with alert ownership
- Support tools able to inspect status and retry safe jobs but **not** edit posted financial data
- Version-controlled technical and business documentation updated with each release
- Every release carrying scope, migration notes, test evidence, approvals and rollback plan

**Test gate**
- [ ] **§25 acceptance criterion 4:** a failed deployment can be rolled back or recovered according to the release plan
- [ ] **§25 acceptance criterion 5:** operational monitoring detects a simulated failed job, failed integration, authentication attack pattern **and** backup failure — all four, individually
- [ ] Automated tests cover every critical posting path and every critical permission path
- [ ] Support tooling cannot edit posted financial data — verified by attempting it
- [ ] Every alert has a named owner
- [ ] Documentation is current with the deployed release

---

### 20.7 Runbooks and support readiness

**Build** — runbooks, owners and support escalation contacts for all critical business processes

**Test gate**
- [ ] **§25 acceptance criterion 6:** all critical business processes have runbooks, owners and support escalation contacts
- [ ] A runbook is followed end to end by someone who did not write it, successfully
- [ ] The escalation path is tested out of hours

---

## Phase exit gate

§25 acceptance criteria, verbatim, all six:

| # | Criterion | Sub-phase |
|---|---|---|
| 1 | Security testing confirms inaccessible modules and records cannot be reached through direct URL or API | 20.1 |
| 2 | Backup restoration succeeds in an isolated test and meets the approved recovery objectives | 20.3 |
| 3 | Peak-load tests meet approved response and posting targets without errors or data inconsistency | 20.4 |
| 4 | A failed deployment can be rolled back or recovered according to the release plan | 20.6 |
| 5 | Operational monitoring detects a simulated failed job, failed integration, authentication attack pattern and backup failure | 20.6 |
| 6 | All critical business processes have runbooks, owners and support escalation contacts | 20.7 |

Plus: independent penetration test complete with agreed findings remediated (20.2).

**Sign-off:** Business Process Owner, having supplied D4, D5 and D6 and accepted the measured results against them.

---

## Notes for the team

**D4, D5 and D6 are not blockers you work around — they are inputs you request now.** Without an RTO you cannot choose a high-availability design; without volumes you cannot size infrastructure or set load-test targets; without an accessibility level you cannot say whether the interface passes. Each is a short conversation. Raise all three at the start of the programme, not at the start of this phase.

**Criterion 5 requires four separate simulations.** A single "monitoring works" demonstration does not satisfy it. Induce a failed job, a failed integration, an authentication attack pattern and a backup failure — separately — and show that each is detected and alerted to its owner.
