# Phase 12 — Fixed Assets

> **Blueprint:** §18, Appendix B, Appendix C, Appendix D, Appendix E (IAS 16)
> **Release (§27):** 9 — Fixed Assets, Budgeting, HR and Payroll
> **Acceptance dependency (§27):** *"Registers, payroll control and G/L reconcile."*
> **Depends on:** 05
> **Blocks:** —

---

## Purpose

§18: maintain the complete asset register and reconcile acquisition cost, accumulated depreciation, impairment and disposal to the General Ledger.

**A company-specific rule to note:** §18.2 states *"No Asset Clearing Account is required by the approved company workflow."* Finance creates the Fixed Asset Document directly from approved purchasing evidence. Do not introduce a clearing account because other ERPs use one — that would be an unapproved change under §28.

---

## Sub-phases

### 12.1 Asset categories

**Build** — category master driving default useful life, residual value, depreciation method and account mappings

**Test gate**
- [ ] Category defaults populate the asset document and remain overridable where policy allows
- [ ] Account mappings resolve through the Phase 02 posting profile, not hardcoded
- [ ] A category referenced by an asset cannot be deleted

---

### 12.2 Fixed Asset Document and register

**Build**
- Finance creates the Fixed Asset Document directly from approved purchasing evidence
- Fields per §18.2: Asset Code, Description, Category, Branch, Department, Cost Centre, Location, Custodian, Acquisition Cost, Useful Life, Residual Value, Depreciation Method, and **mandatory Available for Use Date**
- Posts: Dr Fixed Asset Cost / Cr Supplier A/P, Bank or approved source account

**Blueprint rules enforced**
- §18.2 — *"Finance creates the Fixed Asset Document directly from the approved purchasing evidence"*
- §18.2 — *"No Asset Clearing Account is required by the approved company workflow"*
- Appendix C — Fixed asset recognition control rule: *"Fixed Asset Document"*
- Appendix B — statuses: Draft, Approved, Available for Use, Active, Disposed, Closed, Reversed

**Test gate**
- [ ] The document cannot be saved without an Available for Use Date
- [ ] All thirteen §18.2 fields are present and mandatory where specified
- [ ] Recognition posts Dr Fixed Asset Cost / Cr the source account with **no clearing account** in between
- [ ] The document links to its purchasing evidence
- [ ] Asset codes are unique and issued through the Phase 01 numbering service

---

### 12.3 Depreciation

**Build**
- Depreciation runs as a scheduled background job (Phase 01.10)
- Depreciation starts from the **Available for Use Date**
- Posts: Dr Depreciation Expense / Cr Accumulated Depreciation

**Blueprint rules enforced**
- §18.2 — *"Depreciation starts from Available for Use Date in accordance with the approved IFRS treatment"*
- §18.5 — *"Depreciation cannot begin before Available for Use Date"*
- Appendix C — *"Starts on Available for Use Date"*
- Appendix E — IAS 16 reference

**Test gate**
- [ ] An asset acquired in January with an Available for Use Date in March depreciates from March, not January
- [ ] A depreciation run is idempotent — running it twice for the same period posts once
- [ ] Depreciation carries the asset's branch, department and cost centre dimensions
- [ ] Accumulated depreciation per asset ties to the accumulated depreciation G/L account
- [ ] A partial-period first run computes correctly per the approved method
- [ ] Depreciation stops at residual value and does not go below it

---

### 12.4 Asset assignment and transfers

**Build** — asset assignment to custodians and employees, transfers between branch, department, cost centre and location

**Blueprint rules enforced**
- §18.5 — *"Transfer and disposal retain complete approval and document history"*
- §20 — *"Fixed Assets tracks assigned company assets"*; assigned assets appear in offboarding clearance

**Test gate**
- [ ] A transfer moves the asset's dimensions and future depreciation posts to the new dimensions
- [ ] Historic depreciation remains against the original dimensions
- [ ] Assignment to an employee is visible in Phase 15 offboarding clearance
- [ ] Transfer approval history is complete and auditable

---

### 12.5 Impairment

**Build** — impairment review and posting: Dr Impairment Loss / Cr Accumulated Impairment or Asset

**Test gate**
- [ ] Impairment reduces carrying value and is visible separately from depreciation
- [ ] Impairment posts to the configured accounts through the Phase 02 engine
- [ ] Post-impairment depreciation recalculates on the revised carrying value per the approved method
- [ ] Impairment history is preserved, not overwritten

---

### 12.6 Disposal

**Build** — disposal posting: Dr Bank/A/R and accumulated balances / Cr Asset Cost and gain, or debit loss

**Blueprint rules enforced**
- §18.3 lifecycle — Fixed Asset Document → Available for Use → Depreciation → Transfer/Impairment → Disposal → Closed

**Test gate**
- [ ] Disposal clears cost, accumulated depreciation and accumulated impairment for that asset to zero
- [ ] Gain or loss computes correctly for proceeds above and below carrying value
- [ ] A disposed asset rejects further depreciation
- [ ] Disposal retains complete approval and document history (§18.5)

---

### 12.7 Physical verification

**Build** — physical verification cycle with variance recording and approval

**Test gate**
- [ ] Verification records existence, location and custodian against the register
- [ ] Variances require approval before any register adjustment
- [ ] Verification history is retained per asset

---

### 12.8 Asset reports

**Build** — per Appendix D: Asset Register; Available for Use; Depreciation; Net Book Value; Transfers; Impairment; Disposal. Filters: category, branch, department, custodian.

**Test gate**
- [ ] Net Book Value = cost − accumulated depreciation − accumulated impairment, per asset and in total
- [ ] Asset register totals reconcile to the G/L by category, branch and cost centre (§18.5)
- [ ] Reports respect data scope

---

## Phase exit gate

§18.5 minimum acceptance criteria, verbatim:

| # | Criterion | Evidence |
|---|---|---|
| 1 | Depreciation cannot begin before Available for Use Date | 12.3 gate |
| 2 | Asset register and G/L balances reconcile by category, branch and cost centre | 12.8 gate |
| 3 | Transfer and disposal retain complete approval and document history | 12.4, 12.6 gates |

Plus the four §18.4 accounting event rows verified against Appendix C.

**Sign-off:** Finance.
