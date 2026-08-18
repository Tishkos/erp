# Phase 14 — Budgeting, Cost Control & Management Accounting

> **Blueprint:** §19, Appendix D
> **Release (§27):** 9 — Fixed Assets, Budgeting, HR and Payroll
> **Depends on:** 05, 11
> **Blocks:** —

---

## Purpose

§19: forward-looking control and profitability analysis, comparing approved budgets to commitments, actuals and forecasts **using the same dimensions as operational transactions**.

That last clause is the design constraint. Budgets are held against the Phase 02.4 dimension framework, not a parallel structure.

---

## Sub-phases

### 14.1 Budget versions and scenarios

**Build**
- Budget version and scenario setup with assumptions
- Versions **immutable after approval**; revisions create a new version

**Blueprint rules enforced**
- §19 — *"Budget versions are immutable after approval; revisions create a new version"*
- §19 acceptance criterion 4 — *"Budget revision history and approvals are preserved"*

**Test gate**
- [ ] An approved version rejects every edit
- [ ] A revision creates a new version and both remain retrievable
- [ ] Revision history shows what changed, who approved it and when
- [ ] Only one version is active for transaction control at any time

---

### 14.2 Budget entry and import

**Build**
- Annual and monthly budget entry and import
- By department, cost centre, project and business line
- Revenue, expense, capital and cash budgets

**Test gate**
- [ ] Budgets are held against the same dimensions as transactions (§4.2), not a separate hierarchy
- [ ] Monthly figures sum to the annual figure
- [ ] Import runs through the Phase 01 framework with preview, error file and rollback
- [ ] All four budget types are supported and reportable separately

---

### 14.3 Budget approval and revision

**Build** — submit, approve with comments, revise

**Test gate**
- [ ] Approval activates the version for transaction control (§19 acceptance criterion 1)
- [ ] Comments are retained with the approval
- [ ] A rejected budget returns for revision with the reason recorded

---

### 14.4 Commitment control and budget check

**Build**
- Budget check at transaction time: **warn, block or require override**, configurable by account/category and threshold
- Available budget = approved budget + approved revisions − commitments − actuals, per the defined logic
- Commitments created on approved purchase orders and contracts, released when closed or cancelled

**Blueprint rules enforced**
- §19 — *"Budget checks can warn, block or require override by account/category and threshold"*
- §19 — *"Available budget equals approved budget plus approved revisions less commitments and actuals according to defined logic"*
- §19 acceptance criterion 2 — *"Commitments update on approved purchase orders/contracts and release when closed/cancelled"*

**Test gate**
- [ ] All three modes — warn, block, override — work and are independently configurable per account/category
- [ ] An override requires a reason and an authorised approver, and is audited
- [ ] Approving a purchase order immediately creates the commitment
- [ ] Cancelling or closing that order immediately releases it
- [ ] Receipt and invoicing convert commitment to actual with no double count at any intermediate point
- [ ] Available budget recalculates immediately, not on a scheduled job

---

### 14.5 Forecast and estimate at completion

**Build** — forecast updated from actuals, commitments and revised estimates; estimate at completion for projects

**Test gate**
- [ ] Forecast draws from all three inputs; changing any one visibly changes the result
- [ ] Project EAC ties to the Phase 11.12 project forecast margin
- [ ] Forecast versions are retained alongside the budget version they relate to

---

### 14.6 Cost allocation

**Build** — allocation rules with documented drivers, producing auditable allocation journals

**Blueprint rules enforced**
- §19 — *"Allocations use documented drivers and create auditable journals"*
- §19 acceptance criterion 5 — *"Allocation journals reconcile and can be reversed"*

**Test gate**
- [ ] Each allocation rule names its driver and the driver value used for the period
- [ ] Allocation journals balance and post through the Phase 02 engine
- [ ] An allocation journal can be reversed and the reversal nets to zero
- [ ] Allocated and unallocated amounts are separately visible

---

### 14.7 Management reporting

**Build**
- Management P&L and contribution margin
- Budget vs actual vs commitment vs forecast by account and dimension
- Department and project budget availability
- Revenue and gross-margin forecast by business line
- Operating expense variance and top drivers
- Capital expenditure plan and asset acquisitions

**Blueprint rules enforced**
- §19 — *"Management reports distinguish statutory G/L presentation from internal management views"*
- §19 acceptance criterion 3 — *"Variance reports drill down to source transactions"*

**Test gate**
- [ ] Management views are visibly labelled as distinct from statutory G/L presentation
- [ ] Every variance drills through to the source transaction
- [ ] Capital expenditure plan ties to Phase 12 asset acquisitions
- [ ] Reports respect data scope and period filters

---

## Phase exit gate

§19 minimum acceptance criteria, verbatim:

| # | Criterion | Evidence |
|---|---|---|
| 1 | Approved budgets are available to transaction-level checks | 14.3, 14.4 gates |
| 2 | Commitments update on approved purchase orders/contracts and release when closed/cancelled | 14.4 gate |
| 3 | Variance reports drill down to source documents | 14.7 gate |
| 4 | Budget revision history and approvals are preserved | 14.1 gate |
| 5 | Allocation journals reconcile and can be reversed | 14.6 gate |

**Sign-off:** Finance and department managers holding budget responsibility.

---

## Notes for the team

The commitment lifecycle is where this module usually breaks. A purchase order approved, partially received, partially invoiced and then closed must at every intermediate step show the correct split between committed and actual, with no moment where both are counted. Test each transition individually and then test the full sequence — the bug is almost always in a transition, not in a state.
