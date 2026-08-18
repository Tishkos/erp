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
- [ ] A project created from an opportunity retains the customer and source identifiers
- [ ] WBS supports hierarchy and rejects cycles
- [ ] Baseline dates and contract value are recorded and preserved against later change (see 11.9)
- [ ] The project dimension is available to every posting module

---

### 11.2 Project budget

**Build**
- Budget by cost category, item, labour, subcontract and overhead
- Budget distinguishes **budget, committed, actual, forecast and available**

**Blueprint rules enforced**
- §10 — *"Budget checks distinguish budget, committed, actual, forecast and available amounts"*
- §10 — *"No project spending without an active project and valid budget/cost code where required"*

**Test gate**
- [ ] Spending against an inactive project is rejected
- [ ] Spending without a valid budget/cost code is rejected where configured to require one
- [ ] The five amount types are separately visible and internally consistent
- [ ] Available = budget + approved revisions − commitments − actuals, per the configured logic (§19)

---

### 11.3 Material requests and project stock

**Build** — Material Request, project stock reservation, project issue and return

**Test gate**
- [ ] A project issue reduces warehouse stock and increases project actual cost in one transaction
- [ ] A project return reverses both, restoring the original FIFO cost relationship (§9.2)
- [ ] Material issued and returned, and stock at project site, are reported (§10 report list)
- [ ] The Project dimension is mandatory on project-specific inventory issues (§4.2)

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
- [ ] Approving a project PO immediately reduces available budget
- [ ] Cancelling or closing that PO immediately releases the commitment
- [ ] Receipt and invoicing convert commitment to actual without double-counting
- [ ] Budget availability updates immediately, not on a scheduled job

---

### 11.5 Timesheets, labour and equipment

**Build** — timesheets, employee cost, equipment usage feeding project actual cost

**Blueprint rules enforced**
- §10 — *"HR/timesheets and employee expenses add labour and travel costs"*
- §20 acceptance criterion 3 — *"Project timesheets/expenses update project actual cost"*

**Test gate**
- [ ] An approved timesheet line increases project actual cost at the configured rate
- [ ] Employee expenses tagged to a project appear in project cost
- [ ] Labour cost is attributable to WBS element, not only to the project

*Depends on Phase 15.2. If Phase 15 has not run, build the interface and stub the source.*

---

### 11.6 Subcontracts

**Build** — subcontract, service acceptance, subcontractor certificate, retention on subcontractor payments

**Blueprint rules enforced**
- §10 — *"A/P captures supplier/subcontractor costs and retention"*

**Test gate**
- [ ] Subcontractor certificates drive A/P invoice creation
- [ ] Subcontractor retention is held as a separate balance, not netted into A/P
- [ ] Service acceptance is required before subcontractor payment

---

### 11.7 Progress measurement and certificates

**Build** — progress measurement, client certificate, approval routing

**Test gate**
- [ ] Progress percentage is recorded per WBS element with an approver
- [ ] A client certificate cannot exceed approved measured progress
- [ ] Certificate history is preserved and auditable

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
- [ ] A progress invoice recovers the configured advance percentage and withholds the configured retention
- [ ] Retention sits in its own balance and is released only through the release process
- [ ] Customer advances sit in their own balance and reduce as recovered
- [ ] Neither balance appears as revenue or expense
- [ ] Unbilled revenue, WIP, customer advances, retention and claims are reported (§10 report list)

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
- [ ] After a variation, both the original baseline and the revised value are visible
- [ ] A variation requires both commercial and budget approval
- [ ] Variation versions are retained; superseded versions remain retrievable
- [ ] Budget availability reflects the revised figure while the baseline figure is unchanged

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
- [ ] Closure is blocked by each of the five conditions **individually**
- [ ] Closure is blocked when several conditions apply and reports all of them
- [ ] A closed project rejects new transactions
- [ ] Reopening a closed project requires controlled exception approval (§24 status model)

---

### 11.12 Project reports

**Build** — per §10 and Appendix D: Project P&L, contract value, billed, collected, cost, commitment, forecast, margin; budget vs committed vs actual vs forecast by WBS/cost code; project cash flow and working-capital exposure; unbilled revenue, WIP, customer advances, retention, claims; material issued/returned and stock at project site; milestone, variation, risk and issue status. Filters: project, WBS, customer, branch, cost centre.

**Test gate**
- [ ] Project P&L reconciles to the G/L for the project dimension
- [ ] Budget vs actual variance drills to source documents (§19 acceptance criterion 3)
- [ ] A project shows all related opportunities, contracts, budgets, purchases, stock issues, costs, invoices and receipts (§10 acceptance criterion 1)

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
