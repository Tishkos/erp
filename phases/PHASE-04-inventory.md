# Phase 04 — Inventory & Warehouse

> **Blueprint:** §9, Appendix B, Appendix C
> **Release (§27):** 3 — Inventory
> **Acceptance dependency (§27):** *"Inventory subledger and G/L reconcile; negative stock tests pass."*
> **Depends on:** 03
> **Blocks:** 05, 06, 11

---

## Purpose

§9 requires control of quantity, availability, reservation, movement, serial/batch identity and FIFO cost across all branches and warehouses. This is the hardest module in the blueprint and the one most likely to be got wrong quietly — a FIFO error does not announce itself, it just makes the margin wrong.

## In scope

Inventory ledger, availability model, FIFO cost layers, serial/batch tracking, opening stock, transfers with in-transit, quarantine, stock counts, damaged goods and write-off.

## Out of scope

- Sales reservation trigger — Phase 06 (the reservation *mechanism* is built here)
- Goods Receipt and Goods Return documents — Phase 05
- Delivery Note — Phase 06

---

## Sub-phases

### 04.1 Inventory ledger and availability model

**Build**
- Quantity subledger by item, warehouse, branch
- The nine availability buckets from §9.5: On Hand, Available, Reserved, In Transit, In Quarantine, Damaged, Returns Stock, Ordered from Suppliers, Committed to Customers
- Views by item, warehouse, branch and consolidated company
- Reservation mechanism (consumed by Phase 06)

**Blueprint rules enforced**
- §9.5 — the full bucket list and the four aggregation levels
- Appendix B, Inventory Movement — *"Item, warehouse/bin from/to, quantity, cost layer, source line and posting journal"*

**Test gate**
- [x] Available = On Hand − Reserved − Quarantine − Damaged, verified against a hand-computed dataset
- [x] Quarantine stock is excluded from Available (§8.4: *"Quarantine stock is unavailable for sale"*)
- [x] Damaged stock is excluded from Available and cannot be reserved (§9.8)
- [x] In-Transit is visible at neither source nor destination as Available
- [x] Consolidated company figures equal the sum of branch figures for every item

---

### 04.2 FIFO cost layer engine

**Build**
- Cost layers created on every inbound movement with date, quantity, unit cost
- Every issue consumes the oldest available layers
- Reversal restores the original quantity **and** cost relationship
- Layer-level traceability from any issue back to the receipt that created the layer

**Blueprint rules enforced**
- §9.2 — *"FIFO is the single valuation method for every item and warehouse"*
- §9.2 — *"Every inventory issue consumes the oldest available FIFO cost layers"*
- §9.2 — *"A reversal restores the original quantity and cost relationship"*
- Appendix C — Purchase Goods Receipt: *"FIFO layer created"*

**Test gate**
- [x] Receive 100 @ 10, then 100 @ 12; issue 150 → COGS is exactly 1,000 + 600 = 1,600, not an average
- [x] Reversing that issue restores both layers to their original quantities and unit costs
- [x] Concurrent issues against the same item consume layers without double-consuming — verified under parallel load
- [x] Inventory valuation from layers equals the inventory G/L control account balance
- [x] Every issue line names the specific layers it consumed and the quantity from each
- [x] Layer consumption is deterministic — the same sequence of movements always yields the same cost result

---

### 04.3 Serial and batch tracking

**Build**
- Serial, batch, or both, per the item's tracking flag
- Manufacturing Date and Expiry Date captured where the approved process requires it
- Traceability from receipt through transfer, delivery, return and write-off

**Blueprint rules enforced**
- §9.3 — tracking is mandatory; no-tracking is not allowed
- §9.3 — *"Manufacturing Date and Expiry Date shall be captured where the approved process requires it to the item"*
- §9.9 — *"Serial/batch traceability works from receipt to transfer, delivery, return and write-off"*

**Test gate**
- [x] A movement of a tracked item without serial/batch identification is rejected
- [x] A serial number cannot be received twice while still on hand
- [x] A serial number can be traced end to end: receipt → transfer → delivery → return → write-off
- [x] Batch quantities reconcile to the item's total on-hand quantity
- [x] Expiry dates are captured and reportable where configured

---

### 04.4 No negative inventory

**Build**
- Enforcement at the inventory service level, applying to every write path

**Blueprint rules enforced**
- §9.2 — *"Negative inventory is prohibited without exception"*
- §3.4 — *"No negative inventory"*
- §9.9 — *"No UI, import or API transaction can create negative stock"*

**Test gate**
- [x] An issue exceeding available stock is rejected via the **UI**
- [x] The same issue is rejected via the **API**
- [x] The same issue is rejected via **import**
- [x] Two concurrent issues that individually fit but jointly exceed available stock cannot both succeed
- [x] No configuration flag anywhere permits negative stock

*These four paths are separately testable and separately required by §9.9. Test all four.*

---

### 04.5 Opening stock

**Build**
- Dedicated controlled document per §9.7 containing: item, branch, warehouse, quantity, UOM, FIFO unit cost, cost-layer date, serial/batch information, manufacture, expiry and warranty data
- Approval creates the inventory ledger entries **and** the opening accounting entry

**Blueprint rules enforced**
- §9.7 — verbatim field list and the approval effect

**Test gate**
- [x] Opening stock approval creates cost layers dated to the cost-layer date, not the approval date
- [x] The opening accounting entry balances and posts through the Phase 02 engine
- [x] Serial/batch data from opening stock is traceable in the same way as received stock
- [x] Opening stock cannot be entered for an item without its required tracking data

---

### 04.6 Transfers and in-transit

**Build**
- Workflow per §9.4: Inventory Transfer Request → Goods Issue from Source → In Transit → Goods Receipt at Destination
- Destination confirms actual receipt before the transfer completes
- Differences remain in **Transit under Investigation**
- Found: destination receipt completed. Not found: Warehouse Manager approves Inventory Loss and the system posts the loss

**Blueprint rules enforced**
- §9.4 — all four bullets
- Appendix B, Warehouse Transfer statuses: Requested, Approved, Issued, In Transit, Partially Received, Received, Investigating, Closed
- Appendix C — transfer issue: Dr Inventory in Transit / Cr Source Warehouse Inventory; transfer receipt: Dr Destination Warehouse Inventory / Cr Inventory in Transit

**Test gate**
- [x] Stock leaves the source and is not available at the destination until receipt is confirmed
- [x] A short receipt moves the difference to Transit under Investigation, not to a silent loss
- [x] Resolving "found" completes the destination receipt with correct FIFO layers carried across
- [x] Resolving "not found" requires Warehouse Manager approval and posts Inventory Loss (Appendix C: Dr Inventory Loss Expense / Cr Inventory in Transit)
- [x] FIFO cost layers survive the transfer — the destination inherits the source's layer costs, not a recomputed value
- [x] Transfer variances remain visible until completed or written off (§9.9)

---

### 04.7 Quarantine

**Build**
- States per §8.4: Received in Quarantine, Inspected, Released to Warehouse, Rejected for Return
- Quarantine stock unavailable for sale

**Test gate**
- [x] Quarantine stock never appears in Available
- [x] Release moves stock to the target warehouse preserving its FIFO layer
- [x] Rejection routes to the Goods Return process (Phase 05) without a separate manual movement

---

### 04.8 Stock count and reconciliation

**Build**
- Workflow per §9.6: Stock Count Plan → Physical Count → Recount where required → Variance Approval → Inventory Adjustment
- Scope: full, by warehouse, item, category or filter
- System quantity remains visible during counting
- System calculates physical-to-book differences
- Inventory Loss requires Warehouse Manager approval

**Blueprint rules enforced**
- §9.6 — all four bullets, including *"The system quantity remains visible during counting"*
- Appendix B, Stock Reconciliation statuses: Planned, Counted, Recount, Pending Approval, Adjusted, Closed

**Test gate**
- [x] Count scope filters produce exactly the intended item/warehouse set
- [x] Variance is computed correctly for positive and negative differences
- [x] An adjustment cannot post without variance approval
- [x] A loss adjustment requires Warehouse Manager approval specifically
- [x] The adjustment posts through the Phase 02 engine and reconciles to the G/L
- [x] Count variances remain visible until completed or written off (§9.9)

---

### 04.9 Damaged goods and write-off

**Build**
- Workflow per §9.8: Damage Report → Warehouse Manager Approval → Transfer to Damaged Warehouse → Inventory Write-Off

**Blueprint rules enforced**
- §9.8 — *"Damaged goods cannot be reserved, sold or returned to saleable stock after final damage approval"*
- Appendix B, Damage Report / Write-Off statuses: Draft, Approved, Transferred to Damaged, Written Off, Reversed

**Test gate**
- [x] Damaged stock cannot be reserved
- [x] Damaged stock cannot be sold
- [x] Damaged stock cannot be moved back to saleable after final damage approval, by any path
- [x] Write-off posts through the Phase 02 engine at the correct FIFO cost

---

### 04.10 Inventory reports

**Build** — the Appendix D inventory set: On Hand and Availability; FIFO Valuation; Serial/Batch Trace; In Transit; Quarantine; Damaged; Reconciliation Variance; Inventory Loss. Filters: item, category, warehouse, branch, serial/batch.

**Test gate**
- [x] FIFO Valuation total equals the inventory G/L control account balance
- [x] Serial/Batch Trace returns the complete movement history for a given identifier
- [x] Every report respects branch and department data scope
- [x] Reports distinguish posted from provisional data (§22)

---

## Phase exit gate

§27 Release 3 acceptance: *"Inventory subledger and G/L reconcile; negative stock tests pass."*

§9.9 minimum acceptance criteria, verbatim:

| # | Criterion | Evidence |
|---|---|---|
| 1 | Quantity subledger, FIFO valuation ledger and General Ledger reconcile | 04.2, 04.10 gates |
| 2 | No UI, import or API transaction can create negative stock | 04.4 gate — all four paths |
| 3 | Serial/batch traceability works from receipt to transfer, delivery, return and write-off | 04.3 gate |
| 4 | Transfer and count variances remain visible until completed or written off | 04.6, 04.8 gates |

Plus: all inventory postings flow through the Phase 02 engine and match Appendix C.

**Sign-off:** Warehouse (data owner per §4.3) and Finance (G/L reconciliation).

---

## Notes for the team

**FIFO under concurrency is the specific risk.** Two simultaneous issues against the same item must not both consume the same layer. This requires explicit locking on the costing path (`TECHSTACK.md` §A6), and it must be tested under genuine parallel load — a sequential test will pass while the production system silently corrupts cost.

**The reversal rule is stronger than it looks.** §9.2 says reversal restores *"the original quantity and cost relationship."* It is not enough to add the quantity back at the current cost; the specific layers consumed must be restored with their original unit costs. This means recording layer consumption at issue time, not recomputing it at reversal time.

**Open gap, found while building 05.2 — a movement's branch is not checked against its warehouse's.** `inventory_movement` carries both `branch_code` and `warehouse_code`, and nothing stops a movement claiming branch A while naming a warehouse in branch B. Nothing in Phase 04 does it, and the Goods Receipt refuses it at the service (§14.3), but the invariant belongs in the database: `stock_position` groups by branch, so a single wrong row makes one branch's inventory account disagree with the warehouse the stock is standing in, and the §9.9 reconciliation would fail without saying why. A trigger on `inventory_movement` asserting `branch_code = (select branch_code from warehouse where code = warehouse_code)` would close it. Transfers between branches still comply — each leg names its own end's branch.
