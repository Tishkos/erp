# Phase 05 — Procurement & Accounts Payable

> **Blueprint:** §8, §15, Appendix B, Appendix C
> **Release (§27):** 4 — Purchasing and A/P
> **Acceptance dependency (§27):** *"Source documents, supplier ledger and G/L reconcile."*
> **Depends on:** 04
> **Blocks:** 06, 07, 11, 12, 14

---

## Purpose

§8: purchasing begins directly with a Purchase Order. Quotation and price collection happen outside the ERP in Excel; the Purchasing employee copies approved item and price lines into the PO.

**Explicitly out of scope (§8.2):** Purchase Requisition, RFQ, Supplier Quotation, Quotation Comparison, and a separate foreign-purchasing workflow. These are not deferred — they are not part of the build. Do not implement them.

## In scope

Purchase Order, Goods Receipt, Service Receipt/Expense Confirmation, Three-Way Match, A/P Invoice, supplier advances, Goods Return, Supplier Credit Memo, A/P subledger and ageing, and basic supplier payment.

---

## Sub-phases

### 05.1 Purchase Order

**Build**
- One supplier per PO; supplier must be an active Business Partner with the Supplier role
- Line types: Inventory Item, Service, Fixed Asset, Expense
- Branch, destination warehouse and cost centre **at line level** — one PO can cover several branches and warehouses
- Grid accepts multi-line copy and paste from Excel with validation of item codes, UOMs, prices and required fields
- Item selection by internal item code; name, supplier item code and barcode pulled from Item Master

**Blueprint rules enforced**
- §8.3 — all six bullets
- Appendix B — statuses: Draft, Pending Approval, Approved, Partially Received, Received, Closed, Cancelled; effect: **Commitment only**

**Test gate** — `tests/integration/phase05-purchase-order.test.ts`, `tests/unit/purchase-order-paste.test.ts`
- [x] A PO with two suppliers is impossible to create — the supplier is a header column, so two is unrepresentable rather than rejected
- [x] An inactive supplier, or a partner without the Supplier role, is rejected — at the service, at the database, and again at approval
- [x] Line-level branch, warehouse and cost centre are independently settable — *carriage to receipt and invoice is proved in 05.2 and 05.4*
- [x] Pasting 200 rows from Excel validates every row and reports errors per row, committing nothing on failure
- [x] An invalid item code, UOM or price in a pasted block is caught before save
- [x] An approved PO creates a commitment but **no accounting entry** (Appendix B: commitment only) — there is no journal column on the table to link one

---

### 05.2 Goods Receipt

**Build**
- Receipt against PO with partial receipts, multiple receipts, over-receipt, under-receipt and configurable quantity tolerance
- Manager approval for tolerance override, with mandatory reason
- Receipt into a different warehouse allowed, remaining visible as a variance from the source line
- Quarantine receipt states (§8.4)
- Posts: Dr Inventory / Cr GRNI (Appendix C)

**Blueprint rules enforced**
- §8.4 — first three bullets
- §8.6 — Goods Receipt is owned by **Warehouse**
- Appendix C — *"PO and warehouse receipt required; FIFO layer created"*

**Test gate** — `tests/integration/phase05-goods-receipt.test.ts`, `tests/unit/receipt-tolerance.test.ts`
- [x] Partial and multiple receipts against one PO line accumulate correctly and close the line at full receipt
- [x] Over-receipt beyond tolerance requires manager approval with a stored reason — tolerance is configuration (`purchase_receipt_tolerance`), defaulting to zero so every over-receipt is a decision until Purchasing sets one
- [x] Receipt into a different warehouse succeeds and the variance from the source line is visible — `warehouseVariances()`; the PO line's warehouse is left as ordered
- [x] Goods Receipt creates a FIFO layer at the PO price (Phase 04.2) — the *ordered* price, so §8.5's three-way match has a fixed quantity leg
- [x] The posting is Dr Inventory / Cr GRNI and is atomic with the stock movement — proved by removing the GRNI mapping and asserting no movement survives
- [x] A receipt without a PO is impossible — `purchase_order_id` is NOT NULL, and a trigger refuses a receipt against an unapproved order

**Note on quarantine (§8.4).** "Received in Quarantine" is modelled as receiving
into a warehouse whose type is `quarantine`, reusing Phase 04's §9.5 buckets
(migration 0027) rather than adding a state flag beside them. Stock is on hand,
`in_quarantine`, and not available — with no second source of truth to disagree
with the warehouse type. Inspection, release and rejection are `stock-states.ts`,
already built in 04.7.

---

### 05.3 Service Receipt / Expense Confirmation

**Build**
- Confirmation document for service and expense lines, owned by the **benefiting department** (§8.6)
- Workflow per §8.2: PO → Service Receipt / Expense Confirmation → A/P Invoice → Supplier Payment

**Blueprint rules enforced**
- §8.6 — ownership by benefiting department
- Appendix B — statuses: Draft, Pending Approval, Approved, Reversed; effect: receipt evidence / accrual

**Test gate** — `tests/integration/phase05-service-receipt.test.ts`
- [x] Only the benefiting department can confirm the service — refused for a manager of another department at the service *and* at the database; a Super User is the deliberate exception (§5.1)
- [x] Confirmation is required before the A/P Invoice for a service line — proved in 05.4's gate: an invoice line whose order line is a service with no approved confirmation is refused, at the service and at the database
- [x] No inventory movement is created for a service line — there is no movement column to write, and an inventory PO line cannot be confirmed here at all

**Note on the accounting effect.** Appendix B calls this document's effect
*"receipt evidence / accrual"*; Appendix C — the posting matrix — has **no row
for it**, and puts the expense on the A/P Invoice (*"PO and Service Receipt
required"*). It is built to post nothing, expressed as a table property. Whether
a period-end accrual is also wanted for confirmed-but-uninvoiced services is
**D11**, raised with the Business Process Owner and not decided here.

---

### 05.4 Three-Way Match

**Build**
- Mandatory matching of PO, receipt and invoice
- Quantity, price and value variance detection
- Variances allowed only after manager approval
- Exception queue

**Blueprint rules enforced**
- §8.4 — *"Three-Way Matching is mandatory. Quantity, price and value variances are allowed only after manager approval"*
- §8.4 — *"Every A/P Invoice must be created from both a Purchase Order and Goods Receipt, or from a Purchase Order and Service Receipt / Expense Confirmation"*
- Appendix C — A/P Invoice inventory: *"Three-Way Match required"*

**Test gate** — `tests/integration/phase05-three-way-match.test.ts`, `tests/unit/three-way-match.test.ts`
- [x] An A/P Invoice cannot be created without both a PO and a receipt — held by a database trigger, so UI, API and import all end in the same place
- [x] A quantity variance blocks posting until manager approval — judged **cumulatively** across invoices
- [x] A price variance blocks posting until manager approval — in both directions; an under-charge usually means a correction is coming
- [x] An approved variance posts to the configured variance account, not silently into inventory
- [x] Match exceptions appear in the exception queue with the reason — one row per variance, because each is a separate conversation
- [x] Match status is visible on the invoice at all times — stored on the document and on every line, recomputed on each change

**A partial invoice is not a variance.** Invoicing 40 of a delivery of 100 is
ordinary, and raising an exception on it would put a manager in front of every
second invoice and teach them to approve without reading. The unbilled balance
stays visible in GRNI, which is what that account is for. What *is* caught is
the cumulative over-bill: three invoices of 40 against a delivery of 100 are
each innocent and together charge for 20 that never arrived.

---

### 05.5 A/P Invoice

**Build**
- Invoice from PO + Goods Receipt (inventory) or PO + Service Receipt (service/expense)
- Non-PO invoices possible only through the stronger approval route with expense evidence (§15)
- Supplier invoice number unique per supplier unless a controlled duplicate exception is approved
- Posts: inventory — Dr GRNI and approved variances / Cr Supplier A/P; service — Dr Expense or Service Cost / Cr Supplier A/P

**Blueprint rules enforced**
- §15 — *"Supplier invoice number is unique per supplier unless a controlled duplicate exception is approved"*
- §15 — *"Non-PO invoices require stronger approval and expense evidence"*
- §8.6 — A/P Invoice owned by **Finance**
- Appendix B — statuses: Draft, Matched, Exception, Pending Approval, Posted, Partially Paid, Paid, Reversed

**Test gate** — `tests/integration/phase05-three-way-match.test.ts`
- [x] A duplicate supplier invoice number is rejected unless an approved exception exists — a **partial** unique index, so the approval is a column rather than a promise
- [x] A non-PO invoice routes to the stronger approval path and requires evidence — justification plus a second approver, held by a CHECK constraint
- [x] The inventory invoice clears GRNI exactly — GRNI returns to zero for a fully received and invoiced PO, because receipt and invoice both use the *ordered* price
- [x] The A/P subledger entry and the G/L control account entry are written in one transaction
- [x] A posted invoice cannot be edited or deleted

**Still owed for 05.5:** payment status (Partially Paid, Paid) arrives with
supplier payments in 05.9; the statuses and transitions exist and nothing sets
them yet.

---

### 05.6 Supplier advances

**Build** — per §8.5:
- Supplier Advance Request and Supplier Advance Payment
- Advance linked to a Purchase Order
- Automatic or manual partial settlement against A/P Invoice
- Supplier refund and reversal controls
- Prevention of duplicate settlement

**Blueprint rules enforced**
- §8.5 — all five bullets
- Appendix C — Supplier advance payment: Dr Supplier Advance / Cr Bank or Cash; *"Linked to PO and settlement history"*

**Test gate** — `tests/integration/phase05-supplier-advance.test.ts`
- [x] An advance without a linked PO is rejected — `purchase_order_id` is NOT NULL, and a trigger refuses a draft or cancelled order; the supplier is taken *from* the order, never from the request
- [x] Partial settlement reduces the advance balance and the invoice balance by the same amount
- [x] The same advance cannot be settled twice against the same invoice — a **partial unique index**, so two clerks at the same moment cannot both pass a service check
- [x] Settlement cannot exceed the advance balance or the invoice balance — bounded per row by CHECK, and *as a pair* by a trigger that locks both sides
- [x] Unapplied advance balance is visible and reported (§15) — with the order each advance is waiting on, because the total alone is unactionable

**Note on the accounting.** Appendix C lists only the payment: *"Supplier advance
payment | Supplier Advance | Bank/Cash | Linked to PO and settlement history."*
Settlement (Dr Supplier A/P / Cr Supplier Advance) and refund (Dr Bank / Cr
Supplier Advance) are not the implementation team choosing a treatment — they
are the arithmetic that the first entry forces. An advance account that could
be debited and never credited would grow without limit and never reconcile, and
§8.5 asks in terms for both settlement and refund. Unlike D11, there is no
second treatment to choose between.

**Why the advance is an asset, not a reduction of payables.** Netting money the
company is *owed* against money it *owes* would leave the supplier statement and
the ledger permanently disagreeing, with neither party able to say by how much.
Keeping settlement and refund apart is also what lets "how much of what we
advanced was actually used?" be answered at all.

---

### 05.7 Goods Return and Supplier Credit Memo

**Build**
- Workflow per §8.2: A/P Invoice → Goods Return → Supplier Credit Memo
- Return quantity cannot exceed available return quantity
- **No replacement** — a replacement requires a new Purchase Order (§8.7)

**Blueprint rules enforced**
- §8.7 — *"Returned goods do not support replacement. A replacement requires a new Purchase Order"*
- Appendix C — Goods Return: Dr Return Clearing / Supplier position, Cr Inventory; *"Quantity cannot exceed available return quantity"*

**Test gate** — `tests/integration/phase05-goods-return.test.ts`, `tests/unit/fifo.test.ts`
- [x] A return exceeding the available return quantity is rejected — measured per *receipt line*, counting only returns that have shipped; a draft reserves nothing
- [x] The return relieves the layer the goods arrived in, at the cost the supplier charged (§9.2)
- [x] No replacement mechanism exists anywhere in the return flow — asserted three ways: no column, no enum value, no exported function
- [x] The Supplier Credit Memo links to both the Goods Return and the original A/P Invoice — both NOT NULL

**On FIFO and returns.** FIFO decides the order in which *unidentified* units are
consumed: when the warehouse ships a hundred cables nobody knows which physical
cables they were, so the oldest cost is relieved first. A return to a supplier is
the opposite case — the units are identified, they are the ones that supplier
delivered, and they are going back against that invoice. Relieving inventory at
the oldest layer's cost would credit a number the supplier never charged, and the
credit memo would then not clear the return: the quantity right, the money wrong.
So `issueFromLayer` targets the receipt's own layer, and the reasoning is written
where the code is.

**Return Clearing, not GRNI.** Appendix C says *Dr Return Clearing / Cr
Inventory*. §8.2 puts the return **after** the invoice, so the debt is already in
payables by then and crediting GRNI would clear a liability the receipt already
discharged. The clearing account holds the gap between the stock leaving and the
supplier agreeing to credit it — and an ageing of it answers *"what have we sent
back and not been credited for?"*, which is normally a spreadsheet. If the
supplier credits less than the return was worth (a restocking fee), the
difference stays there for somebody to chase rather than being absorbed.

---

### 05.8 Purchase Order cancellation

**Build** — per §8.7:
- An unexecuted PO may be cancelled (no accounting or inventory effect)
- After partial receipt, only the remaining open quantity is closed; previous receipts unchanged
- A prior receipt is reversed only through a separate Goods Return

**Test gate** — `tests/integration/phase05-purchase-order.test.ts`
- [x] Cancelling an unexecuted PO requires no journal reversal (§3.2)
- [x] Cancelling a partially received PO closes only the open balance and leaves receipts intact
- [x] There is no path that reverses a receipt through PO cancellation
- [x] Cancellation requires a reason and releases the commitment

---

### 05.9 A/P subledger, ageing and statements

**Build** — the §15 module set:
- Supplier Account and Balance View
- A/P Invoice, Credit Note, Debit Note
- Invoice Matching and Exception Queue
- Due Invoice and Payment Proposal
- Supplier Statement Reconciliation
- A/P Ageing and Cash Requirement Forecast

**Blueprint rules enforced**
- §15 — *"Payment amount cannot exceed approved available invoice/advance balance"*
- §15 — *"Blocked suppliers cannot be paid without an authorised override"*
- §15 — *"Credit notes and advances are allocated transparently; unapplied balances remain visible"*

**Test gate** — see the file list at the end of this section
- [x] A/P ageing by supplier, currency, branch and due bucket ties to the G/L control account
- [x] A payment exceeding the available balance is rejected — bounded per row by CHECK and as a pair by a trigger that locks both sides
- [x] A blocked supplier cannot be paid without an authorised, audited override
- [x] Unapplied credit and advance balances are visible, not netted away
- [x] Supplier statement reconciliation identifies unmatched items (§15 acceptance criterion 4)

---

### 05.10 Supplier payment (basic)

**Build**
- Payment against approved open items with allocation
- Posts: Dr Supplier A/P / Cr Bank or Cash

**Note:** payment *proposal*, payment *batch*, maker-checker and bank reconciliation are Phase 07. This sub-phase delivers the minimum needed to close the procure-to-pay loop and prove the ledger reconciles.

**Test gate** — see the file list at the end of this section
- [x] Payment allocates to specific invoices and updates ageing immediately (§15 acceptance criterion 3)
- [x] Allocation history is retained (Appendix C) — readable from both ends
- [x] A/P subledger reconciles to the G/L control account after payment (§15 acceptance criterion 5)

---

### Where Phase 05 is tested

| Sub-phase | Tests |
|---|---|
| 05.1 Purchase Order | `phase05-purchase-order.test.ts`, `unit/purchase-order-paste.test.ts` |
| 05.2 Goods Receipt | `phase05-goods-receipt.test.ts`, `unit/receipt-tolerance.test.ts` |
| 05.3 Service Receipt | `phase05-service-receipt.test.ts` |
| 05.4 / 05.5 Match and A/P Invoice | `phase05-three-way-match.test.ts`, `unit/three-way-match.test.ts` |
| 05.6 Supplier advances | `phase05-supplier-advance.test.ts` |
| 05.7 Returns and credit memos | `phase05-goods-return.test.ts`, `unit/fifo.test.ts` |
| 05.8 Order cancellation | `phase05-order-cancellation.test.ts`, `phase05-purchase-order.test.ts` |
| 05.9 / 05.10 Ageing and payment | `phase05-supplier-payment.test.ts`, `unit/ageing.test.ts` |

---

## Phase exit gate

§27 Release 4 acceptance: *"Source documents, supplier ledger and G/L reconcile."*

§15 minimum acceptance criteria, verbatim:

| # | Criterion | Evidence | State |
|---|---|---|---|
| 1 | A/P invoice posts to supplier subledger and G/L control account with matching evidence | 05.5 gate | ✅ |
| 2 | Payment proposal includes only eligible approved items | 05.9 gate — `paymentProposal()` | ✅ |
| 3 | Payments allocate correctly and update ageing immediately | 05.10 gate | ✅ |
| 4 | Supplier statement reconciliation identifies unmatched items | 05.9 gate | ✅ |
| 5 | A/P subledger reconciles to the G/L control account | 05.10 gate, and again end to end | ✅ |

Plus the §8 accounting events, all five rows of the §8.8 table, verified against Appendix C.

**End-to-end scenario (from §26 critical UAT list)** — ✅ `tests/integration/phase05-exit-gate.test.ts`

> External supplier Excel → Purchase Order → partial receipt → Three-Way Match → A/P Invoice → payment → bank reconciliation → G/L

Run as one test, because §27's acceptance is a claim about the **chain** and every
other gate proves a link. Two items are ordered from a tab-separated supplier
paste, one arrives in part, the invoice matches cleanly, it posts, it ages into
the right bucket, it appears in the payment proposal, it is paid, and the books
are checked at every step: GRNI returns to zero, inventory is never revalued by
the invoice, the supplier ledger tracks its control account, every journal
balances, the FIFO layers still tie to the inventory account, and the sixty
cables that never came are still shown as outstanding.

**The bank-reconciliation leg is not run** — it is Phase 07 (§17), as the phase
plan says. Everything up to and including the payment is.

**Sign-off:** Purchasing, Warehouse and Finance per the §8.6 department ownership table.

---

## Notes for the team

**GRNI is the control that proves this module works.** For a fully received and fully invoiced PO, the GRNI account must return to exactly zero. A non-zero residual means quantity, price or currency is being handled inconsistently between receipt and invoice. Make this a standing check, not a one-off test.

**Resist building the requisition/RFQ flow.** §8.2 excludes it explicitly. §28 says the team must not convert approved requirements into configurable alternatives. Adding it "because every ERP has one" is a change-control breach.
