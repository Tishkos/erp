# Phase 21 — Data Migration, Testing, Training & Go-Live

> **Blueprint:** §26, §27 Release 10
> **Release (§27):** 10 — Reporting and Go-Live
> **Acceptance dependency (§27):** *"Issa Mohammed signs business acceptance."*
> **Depends on:** all phases
> **Blocked by decisions:** **D8** (cut-over date, historical depth, archive approach), **D9** (Money Transfer legal/compliance approval)

---

## Purpose

§26: migration, testing, training and go-live are **controlled accounting and operational activities with reconciliation and acceptance evidence** — not a technical deployment.

---

## Sub-phases

### 21.1 Migration strategy — ⚠ BLOCKED on D8

**Build** — approve the migration strategy, data owners, cut-off date, historical depth and archive approach (§26 migration cycle step 1)

**Test gate**
- [ ] Strategy is approved in writing by the Business Process Owner
- [ ] A named data owner exists for every one of the seven §26 data classes
- [ ] Cut-off date, historical depth and archive approach are decided and recorded

---

### 21.2 Source data profiling

**Build** — data-quality report covering duplicates, missing keys, invalid dates/currencies, inactive masters and unreconciled balances (§26 step 2)

**Test gate**
- [ ] All five defect categories are quantified against real source data
- [ ] Unreconciled source balances are identified **before** migration, not discovered during it
- [ ] The report is issued to data owners with remediation ownership

---

### 21.3 Mapping and cleansing

**Build** — source-to-target mappings, transformations, default values and rejection rules (§26 step 3); clean and approve source data **outside production**, retaining original extracts unchanged (§26 step 4)

**Test gate**
- [ ] Every target field has a documented source or a documented default
- [ ] Rejection rules are explicit — nothing is silently dropped
- [ ] Original extracts are retained unchanged and are re-runnable
- [ ] Cleansing happens outside production

---

### 21.4 Configuration migration

**Build** — fiscal periods, currencies, exchange rates, sequences, workflows, posting profiles, report mappings; built and approved in test, promoted through controlled release (§26 data class table)

**Test gate**
- [ ] Configuration is promoted through the release process, not hand-entered in production
- [ ] Posting profiles and report mappings are complete — no unmapped account (Phase 16.6)
- [ ] Sequences are set to correct starting numbers for the cut-over

---

### 21.5 Master data migration

**Build** — accounts, partners, items, warehouses, banks, projects, employees, price lists, opening classifications; cleansed, deduplicated, mapped, approved, then imported **with source ID**

**Test gate**
- [ ] Every imported master carries its source ID
- [ ] Duplicate detection ran and its results were approved by the data owner
- [ ] Record counts reconcile to the approved source extract
- [ ] Every stock item has serial and/or batch tracking (Phase 03.3) — no exceptions imported
- [ ] Every partner has its required role-specific mandatory fields

---

### 21.6 Open operational documents

**Build** — open opportunities/orders, undelivered/received quantities, projects, logistics jobs and transfer cases; migrated only if required for continued processing, with status and remaining balances validated

**Test gate**
- [ ] Only documents required for continued processing are migrated
- [ ] Remaining balances and quantities validate against source
- [ ] Migrated documents enter at a valid status per the Phase 01.6 status machine
- [ ] A migrated open Sales Order reserves stock correctly (Phase 06.2)
- [ ] A migrated open Purchase Order creates the correct commitment (Phase 14.4)

---

### 21.7 Subledger openings

**Build** — customer/vendor open invoices, advances, credit notes, client funds, bank reconciling items, inventory by location/cost, fixed assets; **line-level** migration with control-account reconciliation

**Test gate**
- [ ] Migration is line-level, not summarised — ageing must be reproducible
- [ ] A/R subledger reconciles to its control account
- [ ] A/P subledger reconciles to its control account
- [ ] Inventory by location and cost reconciles, with FIFO layers dated correctly (Phase 04.5)
- [ ] Fixed assets carry cost, accumulated depreciation and Available for Use Date (Phase 12.2)
- [ ] Client funds reconcile to their control accounts (Phase 09.2)
- [ ] Bank reconciling items are present and the reconciliation opens correctly (Phase 07.7)
- [ ] A/R and A/P ageing reproduce the source ageing exactly

---

### 21.8 G/L opening balances

**Build** — account and dimension balances at cut-over date, as a balanced journal linked to the migration batch, with **no unexplained suspense**

**Test gate**
- [ ] The opening journal balances in IQD
- [ ] It carries dimension detail, not only account totals
- [ ] There is **no** unexplained suspense balance
- [ ] G/L opening balances equal the sum of the migrated subledgers for every control account
- [ ] The opening Statement of Financial Position is produced and reviewed (Phase 16.6)

---

### 21.9 Attachment migration

**Build** — contracts, invoices, receipts, KYC, customs and project evidence; migrated with metadata, classification, hash and parent linkage; sample-tested for accessibility

**Test gate**
- [ ] Every migrated attachment links to a parent record that exists
- [ ] Classification and retention metadata are set
- [ ] Content hashes verify — no corruption in transit
- [ ] A sample is opened successfully by an authorised user and refused to an unauthorised one

---

### 21.10 Rehearsal migrations

**Build** — at least **two** rehearsal migrations in a representative environment (§26 step 5), each followed by full reconciliation of record counts, quantities, values, control accounts, ageing and opening financial statements (step 6), with business-owner sign-off per data domain (step 7)

**Test gate**
- [ ] Two full rehearsals completed
- [ ] Each rehearsal reconciled on all six dimensions listed in step 6
- [ ] Each data domain signed off by its business owner
- [ ] Rehearsal elapsed time is measured and fits the cut-over window
- [ ] Defects from rehearsal 1 are fixed and verified in rehearsal 2
- [ ] Migration batch IDs, source IDs, import logs, rejected records and approvals are stored for audit (step 9)

**A rehearsal that is not reconciled is not a rehearsal.** The point is to find the reconciliation breaks while there is still time.

---

### 21.11 System and security testing

**Build** — the §26 testing layers not already covered:

| Layer | Minimum evidence |
|---|---|
| System testing | End-to-end scripts and defect log, in a production-like environment |
| Security testing | Access matrix tests, scan/penetration report and remediation (Phase 20.2) |
| Performance/recovery | Measured results against targets (Phase 20.3, 20.4) |

**Test gate**
- [ ] System testing runs in a production-like environment on migrated data
- [ ] The defect log is complete with severity and disposition
- [ ] No unresolved critical defect remains

---

### 21.12 User Acceptance Testing

**Build** — business users prove real processes and outputs meet approved requirements. Evidence required: signed scripts, screenshots/reports, defect disposition and approval.

**The eleven critical end-to-end scenarios (§26), all mandatory:**

1. Lead → opportunity → Sales Order → reservation → partial delivery → A/R Invoice on delivery date → receipt → allocation → customer statement → G/L and margin report
2. External supplier Excel → Purchase Order → partial receipt → Three-Way Match → A/P Invoice → payment → bank reconciliation → G/L
3. Warehouse transfer with shipment, in-transit stock, receipt, discrepancy and cost reconciliation
4. Inventory count with freeze/cut-off, variance approval and posting
5. Project contract → budget → procurement/timesheet/expense → milestone → invoice → revenue/cost/margin reporting
6. Logistics job → vendor costs → customer charge → proof of delivery → invoice and profitability
7. Money Transfer client onboarding → KYC approval → deposit → quoted rate → transfer execution → settlement → bank reconciliation → client balance and margin
8. Foreign-currency invoice/payment and period-end revaluation with reversal in the next period where policy requires
9. Journal creation → approval → posting → reversal and source/audit trace
10. Month-end close checklist → subledger reconciliations → lock → financial statements → controlled reopen
11. User role change, session revocation, forbidden direct URL/API attempt and audit evidence
12. Integration duplicate retry and failure recovery without duplicate posting

**Test gate**
- [ ] Every scenario executed by a business user, not by the implementation team
- [ ] Each scenario has a signed script with screenshots or report output
- [ ] Every defect has a disposition — fixed, deferred with approval, or accepted
- [ ] Scenario 7 additionally has legal/compliance sign-off (D9)

---

### 21.13 Parallel run

**Build** — compare selected live-cycle results with the existing process before full cut-over; produce a reconciliation pack and a management decision

**Test gate**
- [ ] A full cycle runs in parallel and results are compared line by line
- [ ] Every difference is explained
- [ ] The reconciliation pack is presented and a management decision recorded

---

### 21.14 Training and change management

**Build** — per §26:
- Role-based curricula: Super User, Finance, Sales, Procurement, Warehouse, Projects, Logistics, Treasury/Transfer, HR, Management
- Train-the-trainer sessions and named process champions per department
- Business process guides with screenshots, field definitions, decision rules and exception handling
- Practice environment with realistic data and no production consequences
- Competency checks for users who post, approve, reconcile or administer access
- Go-live communication, support channels, daily issue review, escalation matrix

**Test gate**
- [ ] All ten role curricula delivered
- [ ] Each department has a named process champion
- [ ] Process guides cover exception handling, not only the happy path
- [ ] The practice environment is genuinely isolated from production
- [ ] Every user who posts, approves, reconciles or administers access has passed a competency check
- [ ] Support channels and the escalation matrix are published before go-live

---

### 21.15 Cut-over

**Build** — per §26:
- Detailed hour-by-hour cut-over plan with owners, prerequisites, decision points and rollback criteria
- Final backup/export from legacy sources and documented transaction freeze
- Opening data import and **independent** reconciliation before users are released
- Controlled activation of interfaces, jobs, document numbering and user accounts

**Test gate**
- [ ] The hour-by-hour plan is rehearsed and its timings validated against 21.10
- [ ] Rollback criteria are explicit and the decision points have named owners
- [ ] Source freeze is documented and enforced
- [ ] Opening data reconciliation is performed **independently** of the team that ran the import
- [ ] Users are released only after reconciliation is signed
- [ ] Interfaces, jobs, numbering and accounts activate in the planned order

---

### 21.16 Hypercare

**Build** — per §26:
- Daily reconciliation of cash, banks, receivables, payables, inventory and key revenue streams
- Defects triaged by severity; financial integrity issues receive immediate containment
- Formal exit criteria from hypercare and transfer to normal support

**Test gate**
- [ ] Daily reconciliation runs across all six areas from day one
- [ ] A financial integrity issue is contained immediately, with a documented containment action
- [ ] Exit criteria are met and recorded before transfer to normal support

---

## Phase exit gate — the go-live acceptance gate

§26, verbatim, all six:

| # | Criterion | Evidence |
|---|---|---|
| 1 | No unresolved critical defect and no material unexplained reconciliation difference | 21.11, 21.12, 21.13 |
| 2 | Opening statement of financial position and subledger controls are signed by Finance | 21.7, 21.8 |
| 3 | Critical users completed training and access was approved by management | 21.14 |
| 4 | Backups, monitoring, support, incident response and rollback procedures were tested | Phase 20.3, 20.6, 20.7 |
| 5 | Legal/compliance approval exists for regulated service processes, especially Money Transfer | **D9** |
| 6 | Executive sponsor signs the production-readiness decision | Business Process Owner |

Plus §27 Release 10: *"Issa Mohammed signs business acceptance."*

---

## Notes for the team

**Reconciliation is the deliverable, not the data load.** §26 uses the word "reconcile" or "reconciliation" eleven times. A migration that loads every row and reconciles to nothing has failed. Budget more time for reconciliation than for the loading itself — in practice it takes two to three times as long.

**The independent reconciliation in 21.15 must genuinely be independent.** The person who wrote the import cannot be the person who confirms it is correct; they will reconcile against the same assumption that produced the error.

**Do not compress the two rehearsals into one.** §26 step 5 says "at least two". The first finds the mapping errors; the second proves they are fixed and measures the real elapsed time for the cut-over window. Skipping the second means discovering the timing problem during the actual cut-over, when there is no way back.
