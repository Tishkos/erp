# Phase 06 — Sales & Accounts Receivable

> **Blueprint:** §7, §16, Appendix B, Appendix C
> **Release (§27):** 5 — Sales and A/R
> **Acceptance dependency (§27):** *"Stock, customer ledger, revenue and COGS reconcile."*
> **Depends on:** 04, 05
> **Blocks:** 07, 08, 11

---

## Purpose

§7: sales begins directly with a Sales Order. Price negotiation and customer communication happen in Excel outside the ERP; the authorised user then creates or pastes item lines into the Sales Order.

The approved workflow (§7.2):
> External Excel → Sales Order → Automatic Stock Reservation → Pick List → Goods Issue / Delivery Note → A/R Invoice on the same delivery date → Customer Receipt

## In scope

Customer price lists, Sales Order with reservation, Pick List, Delivery Note with proof of delivery, A/R Invoice, Cash Sales, Customer Receipt with allocation, credit control, Sales Return, Customer Credit Memo, warranty, and the A/R subledger with ageing and collections.

---

## Sub-phases

### 06.1 Customer price lists and pricing control

**Build**
- Price retrieval from the customer's linked price list
- Price field **not editable** in the Sales Order
- Discounts allowed **only at line level**

**Blueprint rules enforced**
- §7.3 — *"Unit prices are retrieved from the customer's linked Price List and cannot be edited in the Sales Order"*
- §7.3 — *"Discounts are allowed only at line level"*
- §7.7 — *"Price List controls cannot be bypassed through the UI or API"*

**Test gate**
- [x] The unit price field is not editable in the Sales Order UI — there is no price field on `SalesLineInput` to submit, so the screen has nothing to render editable; the service resolves the price from the customer's list
- [x] A price override submitted via the **API** is rejected, not silently accepted — and again by a trigger, so a hand-written UPDATE meets the same refusal
- [x] A price override submitted via **import** is rejected — the same trigger, which is the point of putting it in the database
- [x] A header-level discount is impossible; only line-level discount exists — no header discount column, and a line takes a percentage or an amount, never both
- [x] Price resolves by the document date against the effective-dated price list — 10.0000 before 1 March, 12.0000 after, chosen by `order_date`

---

### 06.2 Sales Order and automatic reservation

**Build**
- One Sales Order may contain lines for multiple branches, warehouses and delivery locations
- Stock reserved automatically on approval
- Approval blocked when Available Stock is insufficient
- Approval routing: ordinary Sales users require Sales Manager approval; Sales Manager orders finalise directly
- Product items only — installation, transport and other services are **not** part of this workflow (§7.2)

**Blueprint rules enforced**
- §7.4 — *"Stock is reserved automatically when the Sales Order is approved"*
- §7.4 — *"The system shall not approve a Sales Order when Available Stock is insufficient"*
- §7.3 — approval routing
- §7.2 — *"The normal product-sale process contains product items only"*
- Appendix B — statuses: Draft, Pending Approval, Approved, Partially Delivered, Delivered, Closed, Cancelled; effect: **Stock reservation**

**Test gate**
- [x] Approval with insufficient Available Stock is rejected — no partial reservation is created; the whole approval is one transaction, so there is no half-reserved state to clean up
- [x] Approval reserves exactly the ordered quantity and Available drops by that amount
- [x] One Sales Order spanning three branches and three warehouses reserves correctly in each — this is what surfaced **D10**: under the superseded session-branch model the order could not be approved in one act at all
- [x] A Sales Manager's order finalises without a second approval; an ordinary user's order does not — read off the `approve` grant rather than a role name in code
- [x] A service line cannot be added to a product Sales Order — a trigger on `is_stock`, because §7.2 gives the type no line-type column to choose one in
- [x] Cancelling an order releases the reservation in full — and zeroes `reserved_quantity`, so a pick list raised afterwards has nothing to draw down

---

### 06.3 Credit control

**Build** — real-time calculation of: Customer Credit Limit, Payment Terms, Available Credit, Outstanding Balance, Overdue Balance, Open Order Exposure
- Approval blocked when the credit limit is exceeded
- Only the Sales Manager can override, with mandatory reason
- Exposure includes open invoices, open orders, delivered-not-invoiced amounts and guarantees/advances per policy (§16)

**Blueprint rules enforced**
- §7.3 — *"shall be calculated in real time"*; *"The system shall block approval when the Credit Limit is exceeded. Only the Sales Manager can override the block, and the reason is mandatory"*
- §16 — credit exposure composition
- §16 — *"Credit limit overrides require reason, amount, expiry and approver"*
- §7.7 — *"Customer exposure includes open orders, invoices, receipts, credit memos and approved overrides"*

**Test gate**
- [x] Exposure recomputes immediately after an order, delivery, invoice, receipt or credit memo — no batch lag, because there is no stored exposure figure to lag: `totalExposure` is derived on every read
- [x] Exceeding the credit limit blocks approval for a non-manager
- [x] The Sales Manager override requires reason, amount, expiry and approver, all stored — a CHECK constraint takes all five together or none, so a partial override is unrepresentable
- [x] An expired override no longer permits approval — the expiry is compared to the order date, not to the clock, so re-running an old approval gives the same answer
- [x] Delivered-not-invoiced amounts are included in exposure — one of the five components of `totalExposure`
- [x] A credit hold immediately affects order confirmation (§16 acceptance criterion 3)

---

### 06.4 Pick List

**Build** — Pick List from Sales Order, owned by Warehouse

**Blueprint rules enforced**
- Appendix B — statuses: Draft, Released, Picked, Completed, Cancelled; effect: **Operational** (no posting)

**Test gate**
- [x] Pick List creates no accounting entry and no stock movement — none of the three tables has a journal or movement column, so a service that wanted to post one could not record it; the cycle is run end to end and the journal, line, movement and layer counts are unchanged
- [x] Picked quantity cannot exceed the reserved quantity — cumulatively across sheets, in `domain/picking.ts` and again in a trigger, so an import cannot go round it; a *short* pick is ordinary and records its reason
- [x] Serial/batch selection at pick is carried through to the Delivery Note — captured complete at the pick (checked when the sheet becomes Picked, not when the delivery reads it) and returned by `pickedUnits()`, which is the function 06.5 will read. One serial cannot be live on two sheets (§9.9)

**Notes**
- Appendix B gives the Pick List five statuses and no partial one, so a short pick is still *Picked* and the shortfall is a quantity on the line rather than a state of the document. `shortPicks()` is how a supervisor finds them.
- One sheet, one warehouse: §7.2 lets an order span warehouses, and a picker walks one building, so an order spanning three warehouses produces three sheets.
- §7.2 gives the Pick List to Warehouse. The verbs are separated (`approve` releases, `execute` picks) but the *roles* are not seeded — §5.2 makes who holds which role an administrator's configuration, and only Accounting Officer and Accounting Manager are seeded anywhere in the build.

---

### 06.5 Delivery Note and proof of delivery

**Build**
- Goods Issue / Delivery Note from the Pick List
- Partial deliveries and multiple deliveries from one Sales Order
- Proof of Delivery capturing recipient name, signature, attachments and delivery photos
- Posts: Dr COGS / Cr Inventory at FIFO cost

**Blueprint rules enforced**
- §7.2 — *"Partial deliveries and multiple deliveries from one Sales Order are supported"*
- §7.2 — *"Proof of Delivery shall capture recipient name, signature, attachments and delivery photos"*
- Appendix B — Delivery Note effect: **Inventory and COGS**

**Test gate**
- [x] Multiple partial deliveries against one order accumulate and close the line at full delivery — 60 then 40 against 100; the order moves to Partially Delivered and then Delivered, derived from the lines rather than set by the note
- [x] Delivery consumes the reserved stock, not unreserved stock — 500 on hand with 100 reserved, delivering 100 leaves 400 on hand and the *same* 400 available; the reservation is released before the issue, because `inventory.issue` measures against Available and the units are promised to this very order
- [x] COGS is the FIFO cost of the specific layers consumed (Phase 04.2) — 100 at 6 then 100 at 10, delivering 150 costs 1,100; recorded on the line and not recomputed, since the layers it came out of may since be empty
- [x] Proof of Delivery captures all four elements and attaches through the Phase 01 attachment service — recipient, signature and photos are `attachment` rows, refused unless §21's scan says clean, and the whole record is append-only
- [x] Delivery quantities reconcile to the source Sales Order (§7.7) — `reconcileToOrder()` returns ordered, reserved, picked, delivered and invoiced on one row, and a delivery beyond the order is refused in the service *and* by a trigger

**Notes**
- **The posting is at *Delivered*, not at Approved.** Appendix C gives one row for the whole event — *"Sales delivery and invoice … Same delivery and invoice date"* — so there is one Dr COGS / Cr Inventory posting, made when the goods reach the customer, and `delivery_date` is the date §7.4 then forces onto the A/R Invoice.
- **A partial delivery releases the whole reservation and re-reserves the remainder** rather than decrementing it. §5.4's question afterwards is *"who let this stock go, when and why"*, and an edited quantity answers none of it.
- **Appendix B gives the Delivery Note no Cancelled state**, and that absence is honoured: once stock has moved the correction is a reversal. A draft that is never approved simply stays a draft. If the business wants a cancellable draft, that is a change to Appendix B and so a change request under §28.1.
- **§7.2's "shall capture … delivery photos" is read literally**: a delivery cannot be marked Delivered without a recipient name, a signature and at least one photo. If a delivery must be accepted without a photograph — a driver's phone that died, a dock with no camera — that is a change request rather than a check quietly left out.
- **The Sales Order gained `department_code` and `business_line_code`** (migration 0046). The COGS account is an expense account, and migration 0005 makes department and business line mandatory on every expense account by default (§4.2) — so a delivery could not post at all, and neither value is something a delivery could invent. Which line of business a sale belongs to is decided when the order is taken. The same values will serve the A/R Invoice's revenue posting in 06.6.

---

### 06.6 A/R Invoice

**Build**
- Every inventory A/R Invoice created **from an approved Delivery Note**
- Invoice issued on the **same date as delivery**
- Posts: Dr Customer A/R and COGS / Cr Sales Revenue and Inventory

**Blueprint rules enforced**
- §7.4 — *"Every inventory A/R Invoice shall be created from an approved Delivery Note"*
- §7.4 — *"The A/R Invoice shall be issued on the same date as delivery"*
- Appendix C — *"Same delivery and invoice date; Price List locked"*

**Test gate**
- [x] An A/R Invoice without a source Delivery Note is impossible via UI, API and import — `delivery_note_id` is NOT NULL, so "no delivery at all" is unrepresentable; a trigger closes the rest, refusing a note that has not actually delivered and reconciling the invoice's order, customer, branch and date against it
- [x] An invoice date differing from the delivery date is rejected — an equality, not a tolerance, in the service *and* in the database
- [x] Invoice quantities cannot exceed delivered quantities — cumulatively across invoices, and the unit price is checked against the one the Sales Order locked, so §7.3 survives the import route too
- [x] The revenue and COGS postings are in the same atomic transaction as the A/R subledger entry — the receivable is the customer control account, so the customer's balance and the control account move together; a refused posting leaves the invoice Approved with no journal
- [x] Every posted sales journal drills to Sales Order, Delivery Note and A/R Invoice (§7.7) — `drillBack()` answers from either journal, the revenue one or the delivery's COGS one

**Notes**
- **The cost is not posted here.** Appendix B splits the sale in two — the Delivery Note is *Inventory and COGS*, the A/R Invoice is *A/R and revenue*. Appendix C's single "Sales delivery and invoice" row describes the combined economic event across both documents; it is not an instruction to post the cost twice, and `ar_invoice` has no COGS column to record the double in.
- **Nothing on the invoice decides the money.** The price came from the price list and was locked on the order; the quantity came from the delivery. `CreateArInvoiceInput` has no price field and no free quantity — it names which delivery lines to bill and how much of each.
- **Payment terms come from the customer**, not from the invoice form: §4.3 makes the due date a consequence of who the customer is and when the invoice was issued.
- Appendix B's *Partially Paid* and *Paid* are derived from `allocated_iqd` against the total, so an invoice cannot be marked Paid with a balance on it. `applyAllocation()` is the one place that rule lives, for 06.9's credit memos and 06.10's receipts to share.

---

### 06.7 Warranty

**Build**
- Warranty starts on the A/R Invoice date
- Duration from Item Master; end date calculated automatically
- Warranty Inquiry screen

**Blueprint rules enforced**
- §7.4 — *"Warranty starts on the A/R Invoice date. Warranty duration is maintained in Item Master and the end date is calculated automatically"*
- §9.3 — *"Warranty fields are optional"* on the item

**Test gate**
- [x] Warranty end date = invoice date + item warranty duration, computed automatically — in `domain/warranty.ts` where the rule is readable, and again in a trigger so no route can type one; `addMonths` clamps into a shorter month, so 31 January + 1 month ends on 28 February
- [x] Warranty lookup by serial number returns the correct invoice and end date — one row per serial, which is what makes the lookup possible at all; the same item sold a week later is covered a week longer
- [x] Items without a warranty duration produce no warranty record rather than a zero-length one — `warrantyFor` returns `null` so a caller must branch, and a CHECK refuses a zero-month row outright

**Notes**
- **Registration happens when the A/R Invoice posts**, in the same transaction. §7.4 names that moment, and a warranty registered as a separate step is the one forgotten on a busy day and disputed two years later.
- **The duration is copied, not looked up.** The item's warranty is master data and may change; a customer who bought a year keeps it. Recomputing from today's `item.warranty_months` would rewrite history the first time Product Management edited a row — there is a test for exactly that.
- **The register is append-only** (§5.4). A warranty certificate the company can quietly shorten is not a certificate; a registration made in error is corrected by reversing the invoice that created it.
- The units come from the Delivery Note's identified units, which came from the pick — so §9.9's chain runs receipt → pick → delivery → invoice → warranty without a break.

---

### 06.8 Cash Sales

**Build** — same inventory and invoice controls as credit sales, with immediate cash or bank settlement
- Posts: Dr Cash or Bank / Cr Customer A/R

**Blueprint rules enforced**
- §7.4 — *"Cash Sales use the same inventory and invoice controls and record immediate cash or bank settlement"*

**Test gate**
- [x] Cash sales enforce the same reservation, availability and price list controls as credit sales — because a cash sale *is* the ordinary sale: the same order, reservation, pick, delivery and invoice, priced from the same list. There is no cash-sale pricing or cash-sale stock check to differ
- [x] Settlement posts in the same transaction as the invoice — `cashSale.postAndSettle` does both in the caller's transaction, so it is not a promise the caller has to keep; a test removes the bank mapping and asserts the *invoice* posting rolls back with it
- [x] A cash sale leaves no open A/R balance — the receipt allocates in full and the invoice closes to Appendix B's Paid, and the function refuses to return if a dinar is left behind

**Notes**
- **A cash sale is not a document type.** §7.4 says it uses "the same inventory and invoice controls", so the only thing it adds is the settlement — which is a Customer Receipt, and Appendix B gives one type for both: *"Customer Receipt / Cash Sale Receipt"*. `services/cash-sale.ts` is deliberately thin, and the thinness is the feature: any cash-specific pricing or stock check would be a second implementation of a control §7.7 requires to be unbypassable.
- **06.10 was built before 06.8**, out of numbered order and on purpose. "The same controls" is only true by construction if there is one set of controls to use; building the cash case first is how two sets come about.

---

### 06.9 Sales Return and Customer Credit Memo

**Build** — workflow per §7.5:
> A/R Invoice → Sales Return / Goods Return from Customer → Inspection → Saleable Warehouse, Quarantine Warehouse or Damaged Goods Warehouse → Customer Credit Memo

- **Product exchange is not supported.** Replacement requires a new Sales Order
- Return quantity cannot exceed invoiced quantity less previous accepted returns
- Damaged returned goods cannot be sold

**Blueprint rules enforced**
- §7.5 — all three bullets
- Appendix C — Sales return and Credit Memo: Dr Sales Returns and Inventory/Inspection, Cr Customer A/R and COGS; *"Accepted return and source invoice required"*

**Test gate**
- [x] No exchange mechanism exists anywhere in the return flow — enforced by **absence**: no replacement, exchange or swap column on any of the four tables, no exchange document type, and no status meaning "swapped". A validation could be routed around; a concept with no column cannot be reached at all
- [x] A return exceeding invoiced quantity less prior accepted returns is rejected — cumulatively, in the service and again in a trigger. A **rejected** return does not count: those goods went back to the customer, so one refused claim cannot block a legitimate second attempt at the same units
- [x] Inspection routing to saleable, quarantine or damaged works and each destination behaves per Phase 04 — quarantined stock lands in the quarantine bucket and is not available; saleable goes back into the selling pool
- [x] Goods routed to damaged cannot subsequently be sold — because of *where* they sit: Phase 04 counts a damaged-goods warehouse as damaged and damaged is not available, and a trigger guarantees damaged goods actually land there. An order that tries to sell from the damaged store is refused
- [x] The credit memo reverses revenue and COGS at the original FIFO cost, not current cost — the unit cost comes from what the Delivery Note recorded, so a return arriving after the market moved still goes back at 7.3333, not at 99
- [x] The credit memo links to the Sales Return and the source A/R Invoice — both NOT NULL, and a trigger checks the return was accepted and that the memo's invoice, customer and branch match it

**Notes**
- **The stock movement is at acceptance, not at receipt.** A customer's carton at the gate is not company stock; it is goods on an inspection bench the company has not agreed to take back. A rejected return therefore never touches the ledger, instead of needing a reversing movement to undo stock nobody accepted — and there is a test asserting the movement and journal counts are unchanged by a rejection.
- **Sales Returns, not a reversal of Revenue.** The memo debits a contra-revenue account so gross sales and returns stay separately visible. Netting them at source would hide the return rate, which is one of the few numbers that says something is wrong with a *product* rather than with a month.
- **The credit is at the price the customer paid**, not today's list — there is a test that doubles the price list after the sale and asserts the credit does not move.
- §9.9's identity is carried onto the return from the delivery's own units. Where a delivery carried more than one serial or batch, the inspection must say which came back rather than have the system guess — a wrong batch on a return is a wrong batch in a recall.

---

### 06.10 Customer Receipt and allocation

**Build**
- Receipt entry with customer, currency and bank reference identification
- Allocation to invoices, deposits or on-account balance
- One-to-many and many-to-one matching
- Unidentified receipts held in a clearing account until resolved

**Blueprint rules enforced**
- §16 — *"Receipt allocation cannot exceed invoice or available receipt balance"*
- §16 — *"Unidentified receipts remain in a clearing account until resolved"*
- §16 acceptance criterion 2 — *"Receipt allocation supports one-to-many and many-to-one matching"*

**Test gate**
- [x] One receipt allocates across several invoices — and `proposeFor` offers an oldest-first plan, which is a proposal rather than a rule: §16 also lets a customer say which invoice their payment is for
- [x] Several receipts allocate to one invoice — the invoice moves to Partially Paid and then Paid, derived from the money rather than declared
- [x] Allocation exceeding the invoice balance or the receipt balance is rejected — **both** ceilings on every line, in the service and again in a trigger; one without the other leaves either an over-paid invoice or a receipt that paid out money nobody sent
- [x] An unidentified receipt sits in the clearing account and is reported as unapplied — the debit is always the bank, and it is the *credit* that moves; identifying it posts a journal out of clearing rather than editing a column
- [x] Invoice and receipt update the customer subledger and G/L in the same posting (§16 acceptance criterion 1) — the receivable is the customer control account, so both move together or neither does

**Notes**
- **One-to-many and many-to-one need no code.** An allocation is one row joining one receipt to one invoice with an amount, so one receipt across five invoices is five rows and five receipts against one invoice is five rows. Modelling the two shapes separately would invent a distinction the accounting does not have.
- **The customer is nullable on a receipt**, and that is §16's rule rather than laziness: money in the bank is a fact whatever else is unknown. A receipt that forced a customer would be a receipt somebody guessed at, and the guess would be in the subledger.
- **Allocations are append-only** (§5.4). *"Why was this invoice marked paid in March?"* is exactly what an audit asks, and an allocation that could be deleted is a history that could be edited.
- The bank account is deliberately **not** a §4.2 dimension — the seven are branch, department, business line, project, warehouse, business partner and employee. Which account the money landed in lives on the receipt and in the bank subledger.

---

### 06.11 A/R subledger, ageing, statements and collections

**Build** — the §16 module set:
- Customer Account and Balance View
- Customer Deposit / Advance
- Collections Worklist, Promise to Pay, Follow-up Notes
- Customer Statement and Confirmation
- A/R Ageing and Expected Cash Collection
- Credit Limit, Credit Hold, Override
- Write-off with threshold, approval and reason code

**Blueprint rules enforced**
- §16 — *"Customer statements show transaction currency and base-currency equivalent"*
- §16 — *"Write-off requires defined threshold, approval and reason code"*

**Test gate**
- [x] A/R ageing ties to the G/L control account for every test period — tested across five period ends, and after a receipt has partly settled it. `reconcile()` returns the **differences** rather than a verdict, because a reconciliation that can only say "they agree" is one nobody can debug at 11pm on a closing day
- [x] Customer statements reconcile to A/R ageing and G/L control (§16 acceptance criterion 4) — the statement's closing balance, the ageing total and the control account are one number seen three ways, and the test asserts all three are equal
- [x] Statements show both transaction currency and base-currency equivalent — the USD figure is the historical-rate equivalent the journal recorded (§2.3), never a conversion done at report time, so a statement re-run next year reproduces this year's numbers
- [x] Write-offs, refunds and credit notes require controlled approval (§16 acceptance criterion 5) — above the threshold the approver must also hold `configure`; the threshold in force is copied onto the document, so *"what rule was this approved under?"* has an answer after the policy changes
- [x] Days sales outstanding computes per the documented formula (§22 KPI dictionary) — **and the formula is D12's to confirm**, not the build's: §22 says *"calculated from the approved management formula"*, so `domain/dso.ts` isolates it and offers the countback alternative alongside

**Notes**
- **D12 is raised and open.** §22 defers the DSO formula and period basis to management. The build computes the classic formula on credit sales over a caller-supplied range, and the register sets out all three readings plus the cash-sale question. Changing the answer touches one pure function and its test.
- **The write-off threshold defaults to zero**, which puts *every* write-off above the line until Finance sets a figure — the same safe-by-default treatment §8.4's receipt tolerance got. That figure is the tail note of D12.
- **The ageing buckets are Phase 05's**, reused unchanged from `domain/ageing.ts`. §24's "call shared services" applied to a *definition*: if A/R and A/P disagreed about what "1–30 days overdue" meant, one of the two reconciliations would be wrong and nobody would know which. The day an invoice falls due is `current`, not `1–30`.
- **A promise to pay is a row, not a note.** *"They said they would pay on the 15th"* is a fact somebody should be held to on the 16th, and the expected-cash report prefers a promised date over a due date because it is better information. The collections activity log is append-only — a call log that can be edited proves nothing.

**Still to build in this sub-phase** (no gate depends on them): Customer Deposit / Advance, and the Customer Account and Balance View screen. The ledger side of a customer advance is the mirror of Phase 05's Supplier Advance and would reuse it.

---

## Phase exit gate

§27 Release 5 acceptance: *"Stock, customer ledger, revenue and COGS reconcile."*

§7.7 minimum acceptance criteria, verbatim:

| # | Criterion | Evidence |
|---|---|---|
| 1 | Price List controls cannot be bypassed through the UI or API | 06.1 gate |
| 2 | Reservation, delivery, invoice and receipt quantities reconcile to the source Sales Order | 06.2, 06.5, 06.6, 06.10 gates |
| 3 | Customer exposure includes open orders, invoices, receipts, credit memos and approved overrides | 06.3 gate |
| 4 | Every posted sales journal drills to the Sales Order, Delivery Note and A/R Invoice | 06.6 gate |

Plus §16 acceptance criteria 1–5, and the three §7.6 accounting event rows verified against Appendix C.

**End-to-end scenario (§26 critical UAT list):**
> Lead → opportunity → Sales Order → reservation → partial delivery → A/R Invoice on delivery date → receipt → allocation → customer statement → G/L and margin report

Run the Sales Order onward now; the lead/opportunity leg completes in Phase 08.

- [x] **The scenario runs as one test** — `tests/integration/phase06-exit-gate.test.ts`. Each link is proved in its own sub-phase file; what this proves is that the links form a chain. A second test delivers the remaining 40 and closes the order.
- [x] **§27 Release 5: "stock, customer ledger, revenue and COGS reconcile"** — asserted against the state the scenario leaves, not a purpose-built fixture: Inventory 840 in the G/L equals the FIFO valuation of 840; Revenue 1,200 less COGS 360 is a gross margin of 840; Trade Receivables 500 equals the ageing total and the statement's closing balance; Bank 700 equals the receipt.
- [x] §7.7 criterion 2 — reservation, delivery, invoice and receipt reconcile to the order, on one row
- [x] §7.7 criterion 3 — exposure includes the open order and the open invoice
- [x] §7.7 criterion 4 — the posted sales journal drills to order, delivery and invoice

**One thing the scenario changed.** `reconcileToOrder` used to read `sales_order_line.reserved_quantity`, which the order sets at approval and nothing decrements. After a full delivery it still said 100 reserved while the stock position said none — two screens contradicting each other, which is exactly what §7.7 asks these figures not to do. It now reads the **live** `stock_reservation` rows.

**Sign-off:** Sales, Warehouse and Finance.

---

## Notes for the team

**"Cannot be edited" means cannot be edited anywhere.** §7.7 makes UI-and-API price bypass an explicit acceptance criterion. A read-only input on the form is not the control — server-side rejection is. Test the API path deliberately.

**Same-date invoicing is a hard rule.** §7.4 requires the A/R Invoice on the delivery date. This constrains how deliveries are batched at period end: a delivery on the last day of a soft-closed period cannot be invoiced into the next period. Confirm the operational consequence with Finance before go-live.
