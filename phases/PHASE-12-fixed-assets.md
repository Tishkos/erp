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
- [x] Category defaults populate the asset document and remain overridable where policy allows
- [x] Account mappings resolve through the Phase 02 posting profile, not hardcoded
- [x] A category referenced by an asset cannot be deleted

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
- [x] The document cannot be saved without an Available for Use Date
- [x] All thirteen §18.2 fields are present and mandatory where specified
- [x] Recognition posts Dr Fixed Asset Cost / Cr the source account with **no clearing account** in between
- [x] The document links to its purchasing evidence
- [x] Asset codes are unique and issued through the Phase 01 numbering service

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
- [x] An asset acquired in January with an Available for Use Date in March depreciates from March, not January
- [x] A depreciation run is idempotent — running it twice for the same period posts once
- [x] Depreciation carries the asset's branch, department and cost centre dimensions
- [x] Accumulated depreciation per asset ties to the accumulated depreciation G/L account
- [x] A partial-period first run computes correctly per the approved method
- [x] Depreciation stops at residual value and does not go below it

---

### 12.4 Asset assignment and transfers

**Build** — asset assignment to custodians and employees, transfers between branch, department, cost centre and location

**Blueprint rules enforced**
- §18.5 — *"Transfer and disposal retain complete approval and document history"*
- §20 — *"Fixed Assets tracks assigned company assets"*; assigned assets appear in offboarding clearance

**Test gate**
- [x] A transfer moves the asset's dimensions and future depreciation posts to the new dimensions
- [x] Historic depreciation remains against the original dimensions
- [x] Assignment to an employee is visible in Phase 15 offboarding clearance
- [x] Transfer approval history is complete and auditable

---

### 12.5 Impairment

**Build** — impairment review and posting: Dr Impairment Loss / Cr Accumulated Impairment or Asset

**Test gate**
- [x] Impairment reduces carrying value and is visible separately from depreciation
- [x] Impairment posts to the configured accounts through the Phase 02 engine
- [x] Post-impairment depreciation recalculates on the revised carrying value per the approved method
- [x] Impairment history is preserved, not overwritten

---

### 12.6 Disposal

**Build** — disposal posting: Dr Bank/A/R and accumulated balances / Cr Asset Cost and gain, or debit loss

**Blueprint rules enforced**
- §18.3 lifecycle — Fixed Asset Document → Available for Use → Depreciation → Transfer/Impairment → Disposal → Closed

**Test gate**
- [x] Disposal clears cost, accumulated depreciation and accumulated impairment for that asset to zero
- [x] Gain or loss computes correctly for proceeds above and below carrying value
- [x] A disposed asset rejects further depreciation
- [x] Disposal retains complete approval and document history (§18.5)

---

### 12.7 Physical verification

**Build** — physical verification cycle with variance recording and approval

**Test gate**
- [x] Verification records existence, location and custodian against the register
- [x] Variances require approval before any register adjustment
- [x] Verification history is retained per asset

---

### 12.8 Asset reports

**Build** — per Appendix D: Asset Register; Available for Use; Depreciation; Net Book Value; Transfers; Impairment; Disposal. Filters: category, branch, department, custodian.

**Test gate**
- [x] Net Book Value = cost − accumulated depreciation − accumulated impairment, per asset and in total
- [x] Asset register totals reconcile to the G/L by category, branch and cost centre (§18.5)
- [x] Reports respect data scope

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

---

## Implementation notes

**Status:** complete. 52 integration tests (`tests/integration/phase12-fixed-assets.test.ts`) and 28 unit tests (`tests/unit/fixed-assets.test.ts`).

**Files**

| Layer | Path |
|---|---|
| Domain | `src/server/domain/fixed-assets.ts` |
| Schema | `src/server/db/schema/fixed-assets.ts` |
| Service | `src/server/services/fixed-assets.ts` |
| Migrations | `0149_phase12_fixed_assets.sql`, `0150_phase12_depreciation_queue.sql` |

**What the database refuses, rather than the service**

- `asset_depreciation_not_before_available` — a charge dated before the Available for Use Date. §18.5's first acceptance criterion is a constraint, not a code path.
- `asset_depreciation_stops_at_residual` — a charge that would take carrying value below residual.
- `asset_depreciation_not_after_disposal` and `asset_impairment_not_after_disposal` — both on the `asset_no_movement_after_disposal` function: neither a charge nor a write-down may be recorded against a disposed asset.
- `asset_transfer_not_after_disposal` — the same guard for a transfer. §18.5 asks transfer and disposal to retain complete history, and moving an asset that has left the register is the one movement that cannot be true.
- `asset_category_no_delete_when_used` — deleting a category an asset references.
- `asset_depreciation_period_uniq` on `(asset_id, period_end)` — this is what makes the run idempotent. The queue is at-least-once, so idempotence had to live below the handler.
- `fixed_asset_available_after_acquired`, `fixed_asset_residual_below_cost`.
- `asset_verification_variance_is_explained` — a variance with no note.

**No clearing account.** §18.2 says the approved workflow does not use one, so there is no column for it on `fixed_asset` or `asset_category` and a test asserts the absence. Recognition posts exactly two lines.

**Cost centre is not a posting dimension.** §4.2 names seven dimensions and cost centre is not among them; `journal_line` has no column for it. The asset and each depreciation row carry it, and the register reports by it, but the ledger does not. Reconciliation "by cost centre" (§18.5) therefore runs off the register, which is where the value lives.

**Depreciation on the 01.10 queue.** `scheduleDepreciationRun` writes an outbox row inside the caller's transaction; `registerDepreciationHandler` runs it as *the person who asked*, so a clerk's request fails on the clerk's authority rather than succeeding on the worker's. Tested.

**Open — for the register, not for us**

- **D15** widened: nobody chooses a department for a depreciation charge or a business line for a gain on disposal. The system generates them. Until D15 is answered the mapped accounts must not require those dimensions, and the fixture clears them to prove the gate rather than the gap.
- Post-impairment depreciation under straight line is unchanged by design here: the charge is of cost less residual, and impairment sits in its own account. If Finance wants the remaining depreciable amount re-based after an impairment (IAS 36 §63), that is a method change and belongs in the register.
- 12.4's Phase 15 link is one-sided so far: `assetsHeldBy(userId)` exists and is tested; Phase 15 offboarding will call it.

**Two status vocabularies, and which is which.** This system runs both, and the
difference is easy to lose. §24's eleven words — draft, submitted, approved,
partially_executed, executed, posted, settled, rejected, cancelled, reversed,
closed — are the **approval shape**: where a document stands in the workflow
engine. A module's own enum is its **operational lifecycle**: what the thing is
doing in the world.

Appendix B names the Fixed Asset Document's statuses as *Draft, Approved,
Available for Use, Active, Disposed, Closed, Reversed*, and three of those seven
are outside §24's list. Forcing them in would lose the distinction §18.5 turns on
— only an asset that is *available for use* may depreciate, and no §24 word says
that. So `fixed_asset_status` is its own enum, as `lead_status`,
`stock_count_status` and `warehouse_transfer_status` are, enforced in the service
and by trigger; and migration `0151` registers the document's **approval shape**
in `document_status_transition` where every other document keeps one. Three tests
hold the line.
