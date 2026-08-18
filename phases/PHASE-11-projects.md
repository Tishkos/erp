# Phase 11 — Projects & Contracting

> **Blueprint:** §10, Appendix D
> **Release (§27):** 7 — Projects, Contracting and Investments
> **Acceptance dependency (§27):** *"Module subledgers and G/L reconcile."*
> **Depends on:** 05, 06, 15 (timesheets)
> **Blocked by decision:** **D1** — project revenue-recognition and cost-recognition policy

---

## Purpose

§10: manage customer work with defined scope, budget, timeline and profitability, combining commercial, procurement, inventory, subcontractor, progress and billing data into one project view.

> **Accounting decision required (§10):** "Before development of progress billing and WIP, Finance must approve the project revenue-recognition and cost-recognition policy. The system shall support configuration, but IT must not invent the accounting treatment."

Sub-phases 11.1 through 11.9 can proceed now. **11.10 is blocked until D1 is decided.**

---

## Sub-phases

### 11.1 Project / Contract master and WBS

**Build**
- Project master per §4.3: customer, manager, WBS, budget, billing type, retention, status
- Work Breakdown Structure with tasks, milestones and responsibilities
- Contract terms: billing method, retention, advances, guarantees, key dates
- Creation from an approved CRM opportunity (Phase 08.5) or approved management instruction

**Blueprint rules enforced**
- §10 — *"Create a project from an approved CRM opportunity or an approved management instruction"*
- §10 — *"Approve contract, budget, WBS and baseline dates"*
- Appendix B, Project/Contract — *"Status, budget and change control; mandatory project dimension"*

**Test gate**
- [x] A project created from an opportunity retains the customer and source identifiers — the customer is taken *from* the opportunity, so the caller has no way to state a different one. A second project from the same opportunity is refused by a unique index: two would count one win twice
- [x] WBS supports hierarchy and rejects cycles — in the service and again by trigger, because a cycle makes every roll-up of cost or progress run forever
- [x] Baseline dates and contract value are recorded and preserved against later change — **written once.** Once the contract is approved a trigger refuses any change to the contract value, the baseline budget or the baseline dates; variations accumulate beside them
- [x] The project dimension is available to every posting module — because it *is* the project. Phase 02 created `project` as a dimension so postings could be tagged; Phase 11 gave that same row the contract. A second table would mean the posting's project and the contract's project were two records to keep in step

---

### 11.2 Project budget

**Build**
- Budget by cost category, item, labour, subcontract and overhead
- Budget distinguishes **budget, committed, actual, forecast and available**

**Blueprint rules enforced**
- §10 — *"Budget checks distinguish budget, committed, actual, forecast and available amounts"*
- §10 — *"No project spending without an active project and valid budget/cost code where required"*

**Test gate**
- [x] Spending against an inactive project is rejected — in the service and by trigger on both commitments and costs. A draft project has no approved baseline to spend against; a closed one has been filed as finished
- [x] Spending without a valid budget/cost code is rejected where configured to require one — an unknown cost code is refused outright, and `requires_cost_code` is per project because a small internal job may legitimately carry no budget
- [x] The five amount types are separately visible and internally consistent — budget, revisions, committed, actual and forecast, each its own figure
- [x] Available = budget + approved revisions − commitments − actuals — and **forecast is deliberately not in it.** A forecast is somebody's opinion about the end of the job; availability is a fact about what has been spent and promised. Netting the opinion into the fact would let an optimistic forecast create spending room that does not exist

---

### 11.3 Material requests and project stock

**Build** — Material Request, project stock reservation, project issue and return

**Test gate**
- [x] A project issue reduces warehouse stock and increases project actual cost in one transaction — at the **FIFO cost the issue actually consumed**, not a standard, an average, or a figure the caller supplies. §9.2 decides what the stock was worth; the project records that decision
- [x] A project return reverses both, restoring the original FIFO cost relationship — returned at the cost it went out at, because returning at today's cost would create a profit or a loss out of a movement that was neither
- [x] Material issued and returned, and stock at project site, are reported — a return is a **negative cost row, not a deleted issue**: §10 asks for material issued *and returned*, and a deleted issue reports neither
- [x] The Project dimension is mandatory on project-specific inventory issues — `project_issue` and `project_return` are their **own movement kinds**, carrying the project as their source document. Reusing `delivery` would say the stock left the company, which it did not, and would make the site-stock report impossible to write truthfully

---

### 11.4 Project procurement and commitments

**Build**
- Project Purchase Requests and supplier/subcontractor commitments
- Commitments created on approved purchase orders, released when closed or cancelled

**Blueprint rules enforced**
- §10 — *"Procurement and inventory automatically tag project commitments and actual costs"*
- §19 — *"Commitments update on approved purchase orders/contracts and release when closed/cancelled"*
- §10 acceptance criterion 2 — *"Budget availability updates immediately after commitments and actual postings"*

**Test gate**
- [x] Approving a project PO immediately reduces available budget — availability is **computed, never stored**, so "immediately" is not a promise about a job that runs: there is no job and no figure that could be stale
- [x] Cancelling or closing that PO immediately releases the commitment — with a reason, and the row stays: *"what did we commit and when was it released?"* is a question the budget history has to answer
- [x] Receipt and invoicing convert commitment to actual without double-counting — a cost that names the commitment it consumes is not checked against availability a second time, and the commitment is reduced by what it became
- [x] Budget availability updates immediately, not on a scheduled job — proved by reading the figure back in the same transaction as the commitment

---

### 11.5 Timesheets, labour and equipment

**Build** — timesheets, employee cost, equipment usage feeding project actual cost

**Blueprint rules enforced**
- §10 — *"HR/timesheets and employee expenses add labour and travel costs"*
- §20 acceptance criterion 3 — *"Project timesheets/expenses update project actual cost"*

**Test gate**
- [~] An approved timesheet line increases project actual cost at the configured rate — *awaits Phase 15.* `recordCost` takes labour exactly as it takes any other cost, with a WBS element; what is missing is the timesheet to read from
- [~] Employee expenses tagged to a project appear in project cost — *awaits Phase 15*, for the same reason
- [x] Labour cost is attributable to WBS element, not only to the project — every cost row carries an optional WBS code, which is why `project_cost` exists beside the journal at all: the ledger carries the project dimension but not the WBS

*Depends on Phase 15.2. If Phase 15 has not run, build the interface and stub the source.*

---

### 11.6 Subcontracts

**Build** — subcontract, service acceptance, subcontractor certificate, retention on subcontractor payments

**Blueprint rules enforced**
- §10 — *"A/P captures supplier/subcontractor costs and retention"*

**Test gate**
- [~] Subcontractor certificates drive A/P invoice creation — *not built.* Subcontracts need their own document set (subcontract, service acceptance, subcontractor certificate, subcontractor retention), which is a phase-sized addition rather than a wiring job
- [~] Subcontractor retention is held as a separate balance, not netted into A/P — *not built.* The customer side of exactly this rule is built and tested in 11.8, and the supplier side follows the same shape
- [~] Service acceptance is required before subcontractor payment — *not built.* §8.3's service receipt is the nearest existing control and would be the anchor for it

---

### 11.7 Progress measurement and certificates

**Build** — progress measurement, client certificate, approval routing

**Test gate**
- [x] Progress percentage is recorded per WBS element with an approver — and §5.2 applies: the person who measured cannot approve their own measurement, refused by the service and by a table check
- [x] A client certificate cannot exceed approved measured progress — counting **approved** measurements only, in the service and again by trigger. Certifying beyond the measurement bills for work nobody has said was done
- [x] Certificate history is preserved and auditable — each certificate stores the three figures it was issued with, because the terms can change between certificates and each was issued under the terms of its day

---

### 11.8 Progress billing, retention and advances

**Build**
- Milestone or progress invoices
- Retention and advances tracked as **separate balances**, not ordinary revenue or expense
- Advance recovery and retention release calculations

**Blueprint rules enforced**
- §10 — *"Retention and advances are separate balances, not ordinary revenue or expense"*
- §10 acceptance criterion 4 — *"Progress billing correctly calculates advance recovery and retention where configured"*

**Test gate**
- [x] A progress invoice recovers the configured advance percentage and withholds the configured retention — and never recovers more advance than remains, which would turn a liability into a receivable by arithmetic rather than by anybody's decision
- [x] Retention sits in its own balance and is released only through the release process — a sum of movements rather than a maintained figure, and a deferred trigger refuses any movement that would leave the balance negative
- [x] Customer advances sit in their own balance and reduce as recovered
- [x] Neither balance appears as revenue or expense — and the certificate has **no journal column at all**, because what a certificate recognises is D1's to decide
- [~] Unbilled revenue, WIP, customer advances, retention and claims are reported — advances, retention and unbilled cost are. **WIP and unbilled revenue await D1**: what is work in progress depends entirely on the recognition policy, and reporting a figure before the policy exists would be inventing it

---

### 11.9 Variations and change orders

**Build**
- Versioned change orders requiring commercial and budget approval
- Contract value, budget and forecast updated while the **baseline is preserved**

**Blueprint rules enforced**
- §10 — *"Change orders are versioned and require commercial and budget approval"*
- §10 — *"Approve variations and update contract value, budget and forecast while preserving baseline"*
- §10 acceptance criterion 3 — *"Variations preserve original baseline and show approved revised values"*

**Test gate**
- [x] After a variation, both the original baseline and the revised value are visible — side by side, and the baseline is never recomputed from the revised figure
- [x] A variation requires both commercial and budget approval — two separate columns, and a table check refuses an approved status with only one of them. One signature is not enough, and the database says so rather than trusting whoever writes the status
- [x] Variation versions are retained; superseded versions remain retrievable — a superseding variation records what it replaced and takes the next version number
- [x] Budget availability reflects the revised figure while the baseline figure is unchanged — and an **unapproved** variation moves nothing

---

### 11.10 WIP and revenue recognition — ⚠ BLOCKED

**Blocked by decision D1.**

> §10: "Before development of progress billing and WIP, Finance must approve the project revenue-recognition and cost-recognition policy. The system shall support configuration, but IT must not invent the accounting treatment."
> §10: "Project revenue recognition and WIP rules must be approved by Finance and aligned with applicable accounting policy."

**What can be built now:** the configuration structure — recognition method per project or contract type, the posting profile slots, the WIP account mapping, and the calculation hooks.

**What must not be built now:** any default recognition rule. Shipping a percentage-of-completion default "to be changed later" is exactly what §28 prohibits, and it will silently produce wrong financial statements if it is never revisited.

**Test gate (once D1 is decided)**
- [ ] The approved recognition method produces the results in Finance's worked examples
- [ ] Recognition is configuration-driven; changing the method changes the result with no code change
- [ ] WIP balances reconcile to their G/L accounts
- [ ] Recognition entries drill to the progress measurement that triggered them
- [ ] The applicable IFRS 15 treatment referenced in Appendix E is satisfied per Finance's written policy

---

### 11.11 Project closeout

**Build** — technical and financial closeout, final account, lessons learned

**Blueprint rules enforced**
- §10 — *"Project closure is blocked by open purchase orders, unreturned stock, unbilled costs, unapproved variations or unresolved advances/retention"*
- §10 acceptance criterion 5 — *"Project closeout blocks unresolved financial and operational items"*

**Test gate**
- [x] Closure is blocked by each of the five conditions **individually**
- [x] Closure is blocked when several conditions apply and reports all of them — every blocker at once, because closing a project is somebody working through a list and revealing it one item at a time turns an afternoon into a week
- [x] A closed project rejects new transactions — the same rule that blocks a draft project, from the same trigger
- [~] Reopening a closed project requires controlled exception approval — *not built.* The status machine allows it; the controlled-exception route is the piece left, and it belongs with the §24 reopen workflow 07.7 already models

---

### 11.12 Project reports

**Build** — per §10 and Appendix D: Project P&L, contract value, billed, collected, cost, commitment, forecast, margin; budget vs committed vs actual vs forecast by WBS/cost code; project cash flow and working-capital exposure; unbilled revenue, WIP, customer advances, retention, claims; material issued/returned and stock at project site; milestone, variation, risk and issue status. Filters: project, WBS, customer, branch, cost centre.

**Test gate**
- [~] Project P&L reconciles to the G/L for the project dimension — cost does, through the project dimension every posting carries. **Revenue awaits D1**, so there is no P&L to reconcile yet
- [x] Budget vs actual variance drills to source documents — every cost row carries the journal entry that posted it and the commitment it consumed
- [x] A project shows all related opportunities, contracts, budgets, purchases, stock issues, costs, invoices and receipts — one view over the contract, its origin, WBS, budget, commitments, costs, certificates and variations

---

## What is built, and what is not

| Sub-phase | State |
|---|---|
| 11.1 Project master and WBS | **Built.** The project dimension and the project master are one row |
| 11.2 Budget and the five amounts | **Built.** Availability is computed, never stored |
| 11.3 Material requests and project stock | **Built.** Issue and return at FIFO cost, with their own movement kinds |
| 11.4 Procurement and commitments | **Built.** Commitment reduces availability the moment it is approved |
| 11.5 Timesheets, labour and equipment | **Interface built, source awaits Phase 15** |
| 11.6 Subcontracts | **Not built.** Needs its own document set |
| 11.7 Progress and certificates | **Built.** Measured by one person, approved by another |
| 11.8 Progress billing, retention and advances | **Built.** Both balances separate; neither is revenue |
| 11.9 Variations and change orders | **Built.** Baseline written once; two approvals required |
| 11.10 WIP and revenue recognition | **⚠ Blocked by D1** — configuration slot only, no default |
| 11.11 Closeout | **Built.** All five blockers, reported together |
| 11.12 Reports | **Built**, except the parts that depend on recognition |

**Tests:** `tests/integration/phase11-projects.test.ts` — 49 integration tests;
`tests/unit/projects.test.ts` — 32 unit tests.

**The one thing this phase refuses to do.** §10 requires Finance to approve the
revenue-recognition and cost-recognition policy before progress billing and WIP
are developed, and says in terms that *"IT must not invent the accounting
treatment."* D1 is open. So `recognition_method` is a column nothing reads, there
is no WIP table to post into, and the progress certificate has **no journal link
at all**. Shipping a percentage-of-completion default "to be changed later" is
the exact shape of the mistake §28 exists to prevent: it would silently produce
wrong financial statements for as long as nobody revisited it.

---

## Phase exit gate

§10 minimum acceptance criteria, verbatim:

| # | Criterion | Evidence |
|---|---|---|
| 1 | A project shows all related opportunities, contracts, budgets, purchases, stock issues, costs, invoices and receipts | 11.12 gate |
| 2 | Budget availability updates immediately after commitments and actual postings | 11.4 gate |
| 3 | Variations preserve original baseline and show approved revised values | 11.9 gate |
| 4 | Progress billing correctly calculates advance recovery and retention where configured | 11.8 gate |
| 5 | Project closeout blocks unresolved financial and operational items | 11.11 gate |

Plus §27 Release 7: *"Module subledgers and G/L reconcile."*

**End-to-end scenario (§26 critical UAT list):**
> Project contract → budget → procurement/timesheet/expense → milestone → invoice → revenue/cost/margin reporting

**Sign-off:** Projects and Finance. Finance must have signed D1 before 11.10 is accepted.

---

## Notes for the team

This is the largest module in the blueprint after the platform, and the one with the most cross-module dependencies — it consumes procurement, inventory, A/P, A/R, HR and Treasury. Sequence 11.1 through 11.9 while D1 is pending, but do not let the schedule pressure produce a "temporary" recognition rule. §28.2 is explicit that the implementation team does not select accounting outcomes.

**Status vocabulary.** `project_status` (draft, active, on_hold, closing, closed)
is the project's operational lifecycle and is enforced in the service. Migration
`0151` separately registers the project's §24 **approval shape** — raised,
reviewed, approved by somebody other than its author (§5.2), closed — in
`document_status_transition`, which is where the workflow engine and an auditor
both look. The two vocabularies are deliberate; see the note at the foot of
[PHASE-12](PHASE-12-fixed-assets.md) for why they are not merged.
