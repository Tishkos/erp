# REQ-PAY-001 — Purchasing & Payables, finalised

| | |
|---|---|
| **Requirement ID** | `REQ-PAY-001` |
| **Branch** | `feat/payables-module` — one of the parallel module branches (`feat/{module}-module`); see §6 before merging. |
| **Source** | The owner's specification of 2026-10-04 01:59 (Europe/Budapest), reproduced in full in Appendix A, and his addition in the same message: *"also add icon for notes in invoices also supplier clickable like we can from invoices we can goto their profile please like bank loans is very nice features print attachments audit notes icon for any invoice please starting from after draft created"*. Then, 02:04: other agents work on Receivables, Inventory and Accounting at the same time and he merges everything himself — stay inside Payables. |
| **Test case(s)** | PAY1–PAY14 in §3, from the specification's §26. |
| **Status** | **BUILT on this branch** (2026-10-04): PAY1–PAY6, PAY8–PAY12, PAY14. **PAY7** is built on `feat/inventory-module` (fdee68c, with the landed-cost engine it belongs to) and **PAY13** is verified there after that branch merges — neither is duplicated here. The owner's post-completion decisions (4.1–4.7) are all APPROVED and applied; see §5. |

**How to read this document.** §1 is what was asked, in short. §2 is what was
found when each item was inspected, classified KEEP / IMPROVE / ADD /
REMOVE-REDIRECT as the specification requires. §3 turns it into stages with
criteria. §4 is the decisions taken. §5 is what is done. §6 is what the person
merging the module branches must know. Appendix A is the specification
verbatim.

---

# §1 — What was asked

Make purchasing and payables complete and connected to Inventory, Logistics,
Projects, Treasury and the General Ledger **without a second engine of
anything**: reuse the purchasing engine, the supplier master, the posting
mappings, the inventory movement ledger, the landed-cost engine, the payment
engine, the currency/rate engine and the approval/audit infrastructure, and
keep the Qimah UI exactly as it is.

The module is three headings — **Purchasing & Invoices** (Import Applications,
Purchase Orders, Goods Receipts, Purchase Invoices, Expenses, Recurring
Contracts, Purchase Returns), **Supplier Payments & Credits** (Supplier
Payments, Payment Applications, Supplier Advances, Supplier Credits, Supplier
Credit / Debit Notes) and **Supplier Balances** (Supplier Statements, Payables
Ageing, Supplier Reconciliation). The supplier master is Master Data's;
Payables Settings and the Sheet Migration are Administration's.

The owner's addition: **every** purchase-side record, from the moment its draft
exists, wears the four doors — **print, attachments, notes, history** — and its
**supplier is a link to the supplier's profile**, the way the bank loan links
its account.

The accounting chain to hold: Purchase Order → Goods Receipt → Purchase
Invoice → Supplier Payable → Supplier Payment / Advance / Credit → Supplier
Statement → Payables Ageing → AP Reconciliation → General Ledger; and for
imports Import Application → Shipment → Customs → Landed Cost → Final Cost →
Goods Receipt → Inventory → Payables. One source of truth per transaction.

---

# §2 — What was found (KEEP / IMPROVE / ADD / REMOVE-REDIRECT)

The engines are almost all there. The work is screens, doors and wiring, plus
two real accounting gaps (the landed cost of returned goods, and notes that
are not tied to a return).

## Purchasing & Invoices

| # | Item | What exists | Verdict |
|---|---|---|---|
| 1 | Import Applications | `/payables` (menu key `payables_workbench`, labelled "Import Applications") and `/payables/[payableNo]`: supplier, agreed currency and rate, quantity position (`payables.quantityPosition`), B/Ls, containers, PDs, landed-cost charges, locks and **final cost** (`landed-cost.finalCost`), container receipts, invoices, notes, attachments, history, print (`import_application`). Project/WBS is an **optional** assignment ("the three together, or none") — not a dependency. | **KEEP.** IMPROVE: the supplier links to its profile. |
| 2 | Purchase Orders | `services/purchase-order.ts`: draft → submitted → approved (not by its raiser) → `partially_executed` → `executed` / `closed` / `cancelled`; approval writes **no journal** (commitment only, `project-execution.commitForOrder`); `cancel` closes only the open remainder. Record page `/payables/purchase-orders/[orderNo]` is an old `KeyValue` page with no doors, no supplier link and no *remaining* column. | **KEEP** engine. **IMPROVE** record: `DocumentWindow`, four doors, supplier link, Ordered / Received / **Remaining** / Invoiced / price. **ADD** print model `purchase_order`. |
| 3 | Goods Receipts | `services/goods-receipt.ts` posts `inventory_movement` kind `goods_receipt` (Dr Inventory / Cr GRNI, FIFO layer) and updates `purchase_order_line.received_quantity`; partial receipts work. Record page has no supplier, no ordered/remaining, no doors. Inventory's Stock Movement / Stock Ledger already read the movement ledger. | **KEEP** engine — no second receipt engine in Inventory. **IMPROVE** record: supplier link, ordered / received to date / remaining per line, doors. **ADD** print model `goods_receipt`. |
| 4 | Purchase Invoices | `/payables/invoices/[invoiceNo]` already wears print, attachments, notes (`ap_invoice_note`) and history. Supplier is plain text. | **IMPROVE**: supplier link; source PO / import links. |
| 5 | Matching | `domain/three-way-match.ts`, `ap_invoice.match_status`, `ap.exceptionQueue`. | **KEEP.** Shown through the PO record's Ordered / Received / Invoiced / Remaining and price — no new procurement workspace (`match_exceptions` stays unbuilt). |
| 6 | Expenses | `/payables/service-receipts` (labelled "Expenses") + *Add expense* = `expenses.addExpense` → `ap.create`, one non-stock line, expense category / account, cost centre, due date. | **KEEP.** |
| 7 | Recurring Contracts | `services/recurring-contracts.ts` generates invoices through the AP engine; a contract posts nothing itself. | **KEEP** engine. **IMPROVE** record: doors, supplier link. **ADD** print model. |
| 8 | Purchase Returns | `services/goods-return.ts`: against a receipt (Dr Return Clearing / Cr Inventory via `inventory.issueFromLayer`) or directly against an invoice (one journal, Dr Supplier A/P or Bank / Cr Inventory **at the layer's cost**). **Gap 1:** a layer restated by a landed-cost lock carries freight and duty; returning it debits the supplier for costs the supplier never invoiced. **Gap 2:** a landed-cost lock *after* a return sends the returned units' share to cost of sales (`landed-cost.distribute`: "what left any other way is cost of sales"). | **IMPROVE** record: doors, supplier link. **ADD** *Supplier reimburses the landed cost: Yes / No* (default **No**, frozen once posted): the landed part of the returned layers goes to `return_clearing` (Yes) or `purchase_variance` (No) — in the return's own journal and in any later lock's departures. |

## Supplier Payments & Credits

| # | Item | What exists | Verdict |
|---|---|---|---|
| 9 | Supplier Payments | `services/supplier-payment.ts`: explicit `allocate(payment, invoice, amount)` bounded both sides; the whole payment posts (Dr Supplier A/P / Cr Bank); an unallocated remainder stays visible. `allocateOldestFirst` exists but is never automatic. | **KEEP.** **IMPROVE** record: doors (print model exists), supplier link. |
| 10 | Payment Applications | In this system a *payment application* is the request to the bank (draft → approved → sent → confirmed → debited); `confirm` creates and posts the supplier payment allocated to the import's posted invoices, or an advance when none is posted. The per-invoice allocation is the payment's own table. | **KEEP.** **IMPROVE** record: doors, supplier link. **ADD** print model. |
| 11 | Supplier Advances | `services/supplier-advance.ts`, `/payables/advances`; applied when the invoice of its import posts (`applyToPostedInvoice`). No fake invoice. | **KEEP.** **IMPROVE** record: doors, supplier link. **ADD** print model. |
| 12 | Supplier Credits | The three balances are computed (`supplier-payment.supplierAccount`: unallocated payments, unapplied advances, unapplied credit memos) but no screen shows them. | **ADD** `/payables/supplier-credits`, read-only, from those documents — no balance table. |
| 13 | Supplier Credit / Debit Notes | `supplier_credit_memo` exists only behind a goods return (`goods-return.creditMemo`, Dr A/P / Cr Return Clearing); no screen (`/payables/credit-memos` was a menu promise). **Bug:** the memo adds its amount to the invoice's settled amount but leaves `allocated_amount_iqd` at 0, so `supplierAccount` counts it again as unapplied. No debit note anywhere. | **ADD** register + record at `/payables/credit-memos`; a **standalone credit note** against an invoice (Dr A/P / Cr purchase variance or a chosen account; applied up to what is owed, the rest an unapplied supplier credit, appliable later); a **debit note** raised through the AP invoice engine (one non-stock line, linked to the invoice it adjusts) so it is approved, posted, aged, stated and paid like any bill. **Fix** the memo's allocated amount. |

## Supplier Balances

| # | Item | What exists | Verdict |
|---|---|---|---|
| 14 | Supplier Statements | `/payables/supplier-statements`, from `subledger_entry` (posted journals only), credit-normal for a supplier. | **KEEP.** |
| 15 | Payables Ageing | `/payables/open-items` (labelled "Payables Ageing"): Not yet due / 1–30 / 31–60 / 61–90 / 90+ from the due date, partial payments, views open / overdue / unpaid / part paid / all, and already the band **Gross Payables / Unapplied Supplier Credits / Net Supplier Position** without negative invoices. | **KEEP.** The unbuilt duplicate `ap_ageing` leaves the tree. |
| 16 | Supplier Reconciliation | `subledger.reconciliation(tx, asOf)` compares every control account's subledger with the G/L; `closing-checks` blocks a close on a difference. No screen. | **ADD** `/payables/reconciliation`: supplier control accounts, subledger vs G/L vs difference, per supplier, and the investigation lines (journal lines on the control account without a subledger row and the reverse). Never repairs. |

## Navigation, settings, migration

| Item | Verdict |
|---|---|
| Three headings | **IMPROVE** — done (PAY1). |
| Suppliers | **REDIRECT** the menu item to Master Data; the route stays `/payables/suppliers` (D-FX-1). |
| Payables Settings (`/administration/payables-settings`) | Inspected: payable types, stages, time limits, hold reason codes, expense categories, event codes — genuinely payables configuration. **REDIRECT** to the Administration heading. |
| Sheet Migration (`/administration/payables-migration`) | One-time import (§24.3). **REDIRECT** to Administration beside Legacy Books Import, labelled "Payables Sheet Migration (data import)". |
| `ap_payments`, `ap_advances`, `ap_allocations`, `ap_ageing`, `supplier_ledger` | **REMOVE** — never built, and each was a built screen under a second name. |

---

# §3 — Stages

Each stage lands with its test. The criteria are the specification's §26.

| Stage | What | Criteria | State |
|---|---|---|---|
| PAY1 | Navigation (§21–23) | `fx1-menu`, `ap01-menu-redirects`, `screen-catalogue`, `i18n-catalogue`; e2e `fx1-navigation`, `tabs-navigate` updated. | **BUILT** |
| PAY2 | Record notes for every purchase document | A note is dated, signed, never edited, read back on the record; whoever may view the record may add one. | **BUILT** — the shared `record-notes` door (D-PAY-1, owner 4.1) |
| PAY3 | Four doors + supplier link on every purchase record (invoice, PO, GR, return, payment, payment application, advance, contract, credit/debit note) | Printer, paperclip, notes, clock in `DocumentWindow.titleActions`, in that order, from draft; supplier → `/payables/suppliers/<code>?role=supplier`. | **BUILT** — `payables/record-doors.tsx`, `attach-action.ts`, `ProfileLink`; e2e `pay-doors.spec.ts` |
| PAY4 | Print models: PO, GR, payment application, advance, contract, credit/debit note | `ops14-print-export` style: each builds under the reader's row security. | **BUILT** — `print/purchase-documents.ts`; `pay04-purchase-print` |
| PAY5 | PO record | PO 500 → approved → receipt 300 → Received 300 / Remaining 200 → receipt 200 → Received 500 / Remaining 0, status executed. | **BUILT** — `purchase-orders/[orderNo]` on `DocumentWindow`; the arithmetic held by `purchasing-goods-receipt`, `purchasing-order-cancellation` |
| PAY6 | GR record | 300 received → inventory +300 (movement ledger) → second 200 → 500; ordered / received / remaining per line. | **BUILT** — `goods-receipts/[receiptNo]` on `DocumentWindow` |
| PAY7 | Return landed-cost reimbursement | Flag default No; frozen once posted (trigger); landed part → `purchase_variance` (No) / `return_clearing` (Yes) in the return's journal and in a later lock; inventory and supplier balance stay consistent. | **BUILT on `feat/inventory-module`** (fdee68c) — verified after that branch merges; not duplicated here |
| PAY8 | Credit note | Invoice 100,000 → credit 10,000 → outstanding 90,000; on the statement and in the ageing; excess becomes an unapplied supplier credit. | **BUILT** — `services/supplier-notes.ts`, `/payables/credit-memos`, 0295; `pay08-supplier-credits` |
| PAY9 | Debit note | An AP invoice linked to the invoice it adjusts; ages, states and pays like a bill. | **BUILT** — `ap_invoice.adjusts_invoice_id`; `pay08-supplier-credits` |
| PAY10 | Supplier Credits screen | Overpayment 120,000 on 100,000 → invoice 0, supplier credit 20,000; advance 5,000,000 with no invoice → 5,000,000. | **BUILT** — `/payables/supplier-credits`; `pay08-supplier-credits` |
| PAY11 | Supplier Reconciliation screen | Subledger = AP control; a difference shows its source lines, nothing repaired. | **BUILT** — `/payables/reconciliation`; `pay08-supplier-credits` |
| PAY12 | Payments chain | Invoice 100,000 → pay 40,000 → AP 60,000 → pay 60,000 → AP 0, Paid; ageing buckets and partial balances. | **BUILT** — `pay08-supplier-credits` › PAY12 |
| PAY13 | Import chain | Import → B/L/container → PD → landed cost → receipt → inventory → AP; final cost equals the FIFO layers. | engines exist (`im2-01`, `ap07`); the end-to-end proof is Inventory's (final cost + FIFO) — verified after `feat/inventory-module` merges |
| PAY14 | Visual check | `theme-readability.spec.ts`; side-by-side screenshots against the model screens (AGENTS.md). | **DONE** — `/home/claude/shots/payables/` (desktop EN, phone AR, beside the register / record they copy) |

---

# §4 — Decisions

* **D-PAY-1 — Notes on the other purchase documents are read from the audit
  trail.** A note is an audit event `<object>.note_added` with the text in its
  after-image: dated, signed, immutable and branch-scoped by the audit trail's
  own policy. No new table, so no migration in the merge path. The purchase
  invoice keeps `ap_invoice_note` (its Overdue list reads the latest note).
* **D-PAY-2 — A debit note is a purchase invoice** raised with one non-stock
  line and a link to the invoice it adjusts, so the AP engine's approval,
  posting, ageing, statement and payment all apply unchanged. A credit note is
  a `supplier_credit_memo` with no goods return.
* **D-PAY-3 — New journal lines name their accounts from existing mappings**
  (`purchase_variance` from `purchasing.ap_invoice`, `return_clearing` from
  `purchasing.supplier_credit_memo`), the way the direct return already names
  `supplier_payable`. No new posting events, so no new posting rules to seed.
* **D-PAY-4 — The reimbursement flag is frozen by extending the existing
  `goods_return_posted_is_final` trigger**, not by a second trigger.
* **D-PAY-5 — Supplier Reconciliation and Payables Ageing authorise on
  `ap_invoice`** (as the ageing already does), not on the unbuilt
  `ap_reconciliation` object nobody holds.
* **D-PAY-6 — Supplier Credits authorises on `supplier_payment`.**

**Owner's decisions (2026-10-04, post-completion notes §4), all applied:**
4.1 D-PAY-1 approved (notes from the audit trail; no table). 4.2 D-PAY-2
approved (debit note = AP invoice). 4.3 a standalone credit note goes
Draft → Approve → Post; nothing posts on creation. 4.4 the five duplicate menu
items are removed, not hidden. 4.5 Suppliers stays under Master Data. 4.6
Payment Application = the request to the bank; allocation lives on the
supplier payment — said on the application's record and register. 4.7 four
doors and the supplier link on every purchase-side record from draft to
posted. 4.8 the memo double-count is fixed with a data correction (0295);
PAY7 is Inventory's branch. 4.9 the notes, credits and reconciliation read the
existing AP / open-item / subledger engines; the reconciliation never repairs.
4.10 `open-items.ts` is read, not edited.

---

# §5 — Done so far

* **PAY1 — navigation.** `domain/menu.ts`: `payables` (7 built items),
  `payables_payments` (new, ordinal 22 — the one the setup heading held),
  `payables_suppliers` (statements, ageing, reconciliation); `suppliers` →
  `master_data`; `payables_settings`, `payables_migration` → `administration`;
  the five duplicates removed; `supplier_credits` added. `domain/screens.ts`
  catalogue (238 items, 351 screens). `erp-shell.tsx` module headings. Labels
  in `messages/en.json` and `messages/ar.json` (six lines each). Tests updated:
  `tests/unit/fx1-menu.test.ts`, `tests/unit/screen-catalogue.test.ts`,
  `tests/integration/ap01-menu-redirects.test.ts`,
  `tests/e2e/fx1-navigation.spec.ts`, `tests/e2e/tabs-navigate.spec.ts`. Unit
  suite green (112 files, 1,731 tests); `ap01-menu-redirects` green.
* **PAY2–PAY6, PAY8–PAY12, PAY14** — see AGENTS.md › "Payables (REQ-PAY-001)"
  for where each lives. Commits on this branch: `0d8cdda` (attachment parent
  checks), `bb0592f` (credit/debit notes, the memo fix, 0295, PAY8–PAY12
  tests), `6699f6f` (the six print models, PAY4), the `feat/shared-module`
  merge (SHARED-READY), and the doors/links/screens commit that delivered
  `/payables/credit-memos`, `/payables/supplier-credits` and
  `/payables/reconciliation` (now in `DELIVERED`).
* **Not done here, by design:** PAY7 (on `feat/inventory-module`, fdee68c) and
  the PAY13 end-to-end final-cost proof (Inventory's engine) — both to be
  verified after that branch merges.

---

# §6 — Merging the module branches

Several agents run at once, each on `feat/{module}-module`. This branch
touches these shared files; expect conflicts there and nowhere else:

| File | This branch | Note |
|---|---|---|
| `src/server/domain/menu.ts` | the three Payables sections, `suppliers` in `master_data`, two items in `administration` | `feat/receivables-module` rewrites the Sales section and moves Customers to Master Data — both add to `master_data`'s list; keep both items. |
| `src/server/domain/screens.ts` | the `// 12 — Finance · Payables` block; `DELIVERED` additions to come | Item counts in `tests/unit/screen-catalogue.test.ts` must be re-added by hand after both merge (each branch states its delta in a comment). |
| `src/components/erp-shell.tsx` | the Payables line of `MODULE_DEFINITIONS` | one line |
| `messages/en.json`, `messages/ar.json` | `nav.payables_payments`, `nav.payables_suppliers`, five `page.*` labels; more under `admin.*` later | edited in place, never re-serialised, so the diff is line-for-line |
| `tests/unit/fx1-menu.test.ts` | the Payables tests | Receivables adds its own test to the same file |
| migrations (to come) | one file for PAY7–PAY9 | `feat/receivables-module` already uses **0280** (`0280_receivables_notes`). Payables will take the next free number; whichever merges second must re-time its `_journal.json` `when` after the last entry on `main` (AGENTS.md). |
| `src/server/attachments-runtime.ts`, `src/server/print/{access,registry}.ts` (to come) | parent-access checks and export keys for the purchase documents | Receivables adds its own lines in the same lists. |

Nothing in Receivables, Inventory or Accounting screens or services is changed
by this branch; `inventory.ts`, `open-items.ts` and `partner-statement.ts` are
read, not edited.

---

# Appendix A — The specification, verbatim (2026-10-04 01:59)

````markdown
We are now finalizing the **Purchasing & Payables** area of Qimah ERP.

The objective is to make the purchasing/AP workflow complete and properly connected to Inventory, Logistics, Projects, Treasury and the General Ledger.

## CORE RULE

First inspect the existing implementation.

Reuse:

* existing purchasing engine
* existing supplier model
* existing posting mappings
* existing inventory movement engine
* existing landed-cost engine
* existing payment engine
* existing currency/rate engine
* existing approval/audit infrastructure
* existing Qimah UI

Do not rebuild working engines.

For every requested item classify it as:

**KEEP / IMPROVE / ADD / REMOVE OR REDIRECT**

Do not create duplicate supplier, inventory, payment, FX, or accounting systems.

---

# FINAL PAYABLES STRUCTURE

## Purchasing & Invoices

* Import Applications
* Purchase Orders
* Goods Receipts
* Purchase Invoices
* Expenses
* Recurring Contracts
* Purchase Returns

## Supplier Payments & Credits

* Supplier Payments
* Payment Applications
* Supplier Advances
* Supplier Credits
* Supplier Credit / Debit Notes

## Suppliers & Balances

* Supplier Statements
* Payables Ageing
* Supplier Reconciliation

Supplier master itself belongs to:

**Master Data & Configuration → Suppliers**

Do not create another Supplier master inside Payables.

---

# 1. IMPORT APPLICATIONS

## Purpose

The Import Application is the company's process for bringing goods from foreign suppliers into Iraq.

Typical flow:

**Foreign Supplier**
→ Import Application
→ Shipment
→ Container
→ Customs
→ Landed Costs
→ Goods Receipt
→ Inventory
→ Supplier Payable

Important:

Import Application and Projects/WBS are separate concepts.

An Import Application determines the cost and logistics of importing goods.

A Project may later consume those goods.

The import process must not directly depend on Projects/WBS.

Reuse the existing Logistics / Landed Cost implementation.

The import application should be able to expose:

* Supplier
* Foreign currency
* Goods
* Quantities
* Purchase cost
* Shipment/container information
* Customs information
* Landed costs
* Final Cost
* Inventory receipt linkage
* Purchase invoice linkage
* Documents
* Audit history

Final Cost is determined by the existing landed-cost/FIFO architecture.

Do not create a second import costing engine.

---

# 2. PURCHASE ORDERS

## Purpose

A Purchase Order represents what the company intends to buy.

Lifecycle should be controlled by the existing approval architecture.

Typical flow:

**Draft**
→ **Submitted**
→ **Approved**
→ **Partially Received**
→ **Fully Received**
→ **Closed / Cancelled**

The PO should contain:

* Supplier
* Order date
* Expected delivery
* Currency
* Payment terms
* Items/services
* Quantity
* UOM
* Unit price
* Tax
* Warehouse where applicable
* Project/reference where applicable
* Notes
* Attachments
* Approval history

## Important accounting rule

A purchase order should NOT automatically become an AP liability merely because it exists.

The liability is created by the appropriate posted purchase invoice/accounting transaction according to the existing system design.

Do not create a duplicate liability.

---

# 3. GOODS RECEIPTS

## Purpose

Record that goods were physically received.

Typical flow:

**Purchase Order**
→ **Goods Receipt**
→ **Inventory increases**

Goods Receipt should support:

* PO reference
* Supplier
* Receipt date
* Warehouse
* Items
* Ordered quantity
* Received quantity
* Remaining quantity
* UOM
* Batch/serial information where supported
* Condition/status where supported
* Attachments
* Audit trail

## Partial receipts

Example:

PO:
500 units

First receipt:
300 units

System must show:

* Received = 300
* Remaining = 200

Second receipt:
200

Now:

* Received = 500
* Remaining = 0

## Critical architecture rule

If Goods Receipt already creates the actual inventory movement, keep that as the single source of stock.

Do NOT create a second inventory receipt engine inside Inventory.

Inventory's Stock Receipts page must read from the existing movement ledger/source transactions.

---

# 4. PURCHASE INVOICES

## Purpose

Create the supplier liability for goods/services purchased.

Example:

Purchase invoice:
1,000,000 IQD

After posting:

**Supplier payable = 1,000,000 IQD**

The invoice should support:

* Supplier
* Invoice number
* Supplier invoice date
* Posting date
* Due date
* Payment terms
* Currency
* Exchange rate using existing Currencies & Rates
* Lines
* Quantities where applicable
* UOM
* Unit cost
* Tax
* Freight/other charges where applicable
* Total
* Outstanding amount
* Paid amount
* Status
* Source PO/GR/import where applicable
* Attachments
* Audit history
* Print

## Important distinction

For inventory purchases:

**Purchase Order**
→ intention

**Goods Receipt**
→ physical receipt

**Purchase Invoice**
→ supplier liability/accounting

These must remain distinct.

Do not automatically make a receipt a payable.

Do not automatically assume an invoice means goods were received unless the existing business process explicitly allows that.

---

# 5. PURCHASE INVOICE MATCHING

Where the existing architecture supports it, provide controlled matching between:

**Purchase Order**
+
**Goods Receipt**
+
**Purchase Invoice**

This should help identify:

* Ordered quantity vs received quantity
* Received quantity vs invoiced quantity
* PO price vs invoice price
* Quantity mismatch
* Price mismatch

Do not add a heavy procurement system if the existing ERP already has a simpler implementation.

Use the existing document relationships.

---

# 6. EXPENSES

## Purpose

Record supplier/service expenses that are not inventory purchases.

Examples:

* Rent
* Utilities
* Consulting
* Maintenance
* Legal fees
* Other operational expenses

Expenses should post through the existing accounting engine.

They must be able to specify the appropriate:

* Expense account
* Tax
* Supplier where applicable
* Department
* Branch
* Cost Centre
* Project where appropriate
* Currency
* Due date
* Payment terms

Do not create a second expense accounting engine.

---

# 7. RECURRING CONTRACTS

## Purpose

Manage recurring supplier obligations.

Examples:

* Rent
* Electricity
* Water
* Internet
* Maintenance
* Service contracts

A recurring contract should define:

* Supplier
* Start/end dates
* Frequency
* Amount
* Currency
* Payment terms
* Expense/accounting treatment
* Department/branch/cost centre where applicable
* Renewal/cancellation information

The actual accounting transactions should still be generated through the normal Purchase/Expense/Payables posting architecture.

A recurring contract itself is not automatically a payable unless a payable transaction is generated/posted.

---

# 8. PURCHASE RETURNS

## Purpose

Return goods to the supplier.

Typical flow:

**Received goods**
→ **Purchase Return**
→ Inventory decreases
→ Supplier liability/credit changes appropriately

Support:

* Supplier
* Original Goods Receipt / Purchase Invoice where applicable
* Warehouse
* Item
* Quantity
* UOM
* Return date
* Reason
* Credit/adjustment reference
* Attachments
* Audit history

## Landed-cost integration

This is important.

If goods being returned already carry landed-cost adjustments, the existing landed-cost engine must use the approved routing:

**Supplier reimburses landed cost = Yes**
→ `return_clearing`

**No**
→ `purchase_variance`

The Goods Return must therefore have:

**Supplier reimburses the landed cost: Yes / No**

Default = **No**

Once the return is posted, freeze the value.

Do not guess whether the supplier reimburses freight/customs/etc.

Reuse the existing landed-cost engine.

---

# 9. SUPPLIER PAYMENTS

Supplier Payments belong to the **Payments** side of Payables, not Purchasing.

Purpose:

Record actual money paid to suppliers.

A supplier payment should support:

* Supplier
* Payment date
* Bank/Cash account
* Currency
* Amount
* Payment method
* Reference
* Allocation to invoices
* Unapplied amount
* Attachments
* Audit history

Example:

Supplier invoice:
100,000

Payment:
40,000

Result:

Outstanding:
60,000

Do not automatically mark the invoice paid just because a payment exists.

Use Payment Applications to allocate it.

---

# 10. PAYMENT APPLICATIONS

## Purpose

Show exactly which supplier invoices a supplier payment settles.

Example:

Payment:
1,000,000 IQD

Applied:

* Invoice A → 600,000
* Invoice B → 400,000

Unapplied:
0

Or:

Payment:
1,000,000

Applied:
800,000

Unapplied:
200,000

The 200,000 remains a supplier credit/advance.

Do not silently assign payments to invoices just because they are oldest unless that is explicitly the configured business rule.

---

# 11. SUPPLIER ADVANCES

## Purpose

Money paid to a supplier before a payable invoice exists.

Example:

Supplier advance:
5,000,000 IQD

No invoice exists yet.

Show:

**Supplier Advance = 5,000,000 IQD**

Do not create a fake purchase invoice.

Later, the advance can be applied to a supplier invoice.

---

# 12. SUPPLIER CREDITS

Add a dedicated concept for unapplied supplier credits.

Examples:

### Overpayment

Invoice:
100,000

Payment:
120,000

Result:

Invoice outstanding:
0

Supplier credit:
20,000

### Supplier credit without invoice

A supplier may owe the company a credit due to:

* Overpayment
* Credit note
* Return adjustment
* Other approved transaction

These credits should remain clearly separate from unpaid invoices.

Do not represent supplier credits as negative invoices.

---

# 13. SUPPLIER CREDIT / DEBIT NOTES

Add a dedicated workflow.

### Supplier Credit Note

Reduces what the company owes the supplier.

Example:

Payable:
100,000

Credit:
10,000

Outstanding:
90,000

### Supplier Debit Note

Increases what the company owes where appropriate.

Both must:

* Use the existing posting engine
* Appear in Supplier Statements
* Affect Payables Ageing correctly
* Maintain audit history
* Link to the underlying invoice/source where appropriate

---

# 14. SUPPLIER STATEMENTS

## Purpose

Show the complete supplier subledger.

Example:

| Date   | Reference   |  Debit |  Credit | Balance |
| ------ | ----------- | -----: | ------: | ------: |
| 01 Oct | Invoice     |      — | 100,000 | 100,000 |
| 05 Oct | Payment     | 40,000 |       — |  60,000 |
| 10 Oct | Credit Note | 10,000 |       — |  50,000 |

Use the correct debit/credit orientation according to the existing AP subledger convention.

The important requirement is consistency.

Statements must come from the underlying posted transactions.

Do not maintain an independent supplier balance table that can drift.

---

# 15. PAYABLES AGEING

## Purpose

Answer:

> Who do we owe, how much, and how overdue is it?

Show:

* Not Yet Due
* 1–30 days
* 31–60 days
* 61–90 days
* 90+ days

Support filters:

* Supplier
* Branch
* Date/as-of date
* Currency where applicable
* Open
* Partially Paid
* Paid
* All

## Partial payment

Invoice:
100,000

Payment:
40,000

Ageing:
60,000

## Fully paid

Invoice:
100,000

Payment:
100,000

Do not show as outstanding.

## Supplier advances/credits

Keep these separate from invoice ageing.

Example:

Invoice:
100,000

Supplier credit:
5,000,000

Show:

**Gross Payables = 100,000**

**Unapplied Supplier Credits = 5,000,000**

**Net Position = -4,900,000**

Do not turn the credit into a negative invoice.

---

# 16. SUPPLIER RECONCILIATION

## Purpose

Compare:

**Supplier subledger**

against:

**Accounts Payable control account in the GL**

Example:

Supplier subledger:
18,500,000 IQD

AP control account:
18,500,000 IQD

Difference:
0 IQD ✅

If different:

Difference:
250,000 IQD ⚠️

Show the investigation path/source transactions.

Do not automatically repair differences.

---

# 17. CROSS-MODULE ACCOUNTING FLOW

The architecture should remain:

### Purchase Order

→ procurement commitment / purchasing document

### Goods Receipt

→ physical inventory receipt

### Purchase Invoice

→ supplier liability

### Supplier Payment

→ cash/bank decreases

### Payment Application

→ payment allocated to invoice(s)

### Supplier Advance

→ money paid before invoice

### Supplier Credit Note

→ payable decreases

### Purchase Return

→ inventory decreases + supplier accounting adjustment

### Import Application

→ import/logistics process → eventual inventory/final cost

### Landed Cost

→ adjusts applicable inventory FIFO layers and correctly routes departed cost according to the source movement

Everything posts through the existing accounting architecture.

---

# 18. INVENTORY INTEGRATION

Purchasing must integrate with Inventory without creating duplicate inventory systems.

Example:

Purchase Order:
500 panels

Goods Receipt:
300 panels

Inventory:
+300

Purchase Invoice:
Financial payable created separately.

Second Goods Receipt:
200 panels

Inventory:
+200

Final quantity:
500

Purchase Return:
50

Inventory:
-50

Final quantity:
450

Inventory's movement ledger remains the single source of stock truth.

---

# 19. LOGISTICS INTEGRATION

Import Applications connect with:

* Shipments
* Containers
* Customs
* Landed Costs
* Goods Receipts

The import process must not become a second purchasing/inventory engine.

---

# 20. PROJECT INTEGRATION

Projects/WBS are separate from Import Applications.

A project may later consume purchased/imported stock through:

**Project Material Issue**

That is a downstream inventory consumption event.

The purchasing/import module does not directly own the project.

---

# 21. NAVIGATION / OWNERSHIP

The final Payables navbar should be:

## Procurement & Payables

### Purchasing & Invoices

* Import Applications
* Purchase Orders
* Goods Receipts
* Purchase Invoices
* Expenses
* Recurring Contracts
* Purchase Returns

### Supplier Payments & Credits

* Supplier Payments
* Payment Applications
* Supplier Advances
* Supplier Credits
* Supplier Credit / Debit Notes

### Supplier Balances

* Supplier Statements
* Payables Ageing
* Supplier Reconciliation

The Supplier master itself remains:

**Master Data & Configuration → Suppliers**

Do not duplicate Suppliers inside Payables.

---

# 22. PAYABLES SETTINGS

Current route:

`/administration/payables-settings`

Do NOT leave this as an unexplained standalone settings page.

Inspect what it contains.

If it is genuinely Payables-specific configuration, keep it under:

**Administration / Settings**

rather than the operational Payables navbar.

Examples of legitimate settings:

* Numbering
* Approval rules
* Default posting behavior
* Payment application rules
* Other Payables-specific configuration

Do not duplicate global ERP settings.

---

# 23. SHEET MIGRATION

Current route:

`/administration/payables-migration`

This is not a normal Payables business process.

Keep it under:

**Administration / Data Migration**

if it is still required.

Do not put Sheet Migration in the operational Purchasing & Payables navbar.

It should be clearly marked as an administrative/import utility.

---

# 24. UI REQUIREMENTS

Preserve the existing Qimah ERP UI.

Reuse:

* Existing forms
* Existing tables
* Existing filters
* Existing cards
* Existing modals/drawers
* Existing status chips
* Existing currency formatting
* Existing date formatting
* Existing loading states
* Existing empty/error states
* Attachment icon
* Audit/History icon
* Print icon

Do not redesign working screens.

Make new screens visually consistent with existing Qimah pages.

---

# 25. NO-DUPLICATION RULES

Do not create:

* Second Supplier master
* Second AP balance engine
* Second payment engine
* Second inventory engine
* Second FIFO engine
* Second landed-cost engine
* Second FX engine
* Second GL engine
* Second supplier statement engine
* Second ageing balance engine

Everything should read from the existing underlying transactions/subledgers.

---

# 26. TESTING

Before declaring Purchasing & Payables complete, verify:

### Purchase Order

PO 500 units → approved → partial receipt → remaining balance correct

### Goods Receipt

300 received → inventory +300

### Second Receipt

200 received → total 500

### Purchase Invoice

Invoice 100,000 → AP 100,000

### Partial Payment

Payment 40,000 → AP 60,000

### Full Payment

Payment 60,000 → AP 0 → Paid

### Supplier Advance

5,000,000 paid before invoice → supplier advance 5,000,000

### Overpayment

100,000 invoice → 120,000 payment → 20,000 supplier credit

### Purchase Return

Return inventory + supplier accounting remain consistent

### Supplier Credit Note

100,000 → 10,000 credit → 90,000 outstanding

### Ageing

Correct due-date buckets and partial-payment balances

### Import

Import Application → Shipment/Container → Customs → Landed Cost → Goods Receipt → Inventory → Supplier/AP linkage

### Landed Cost

Final Cost remains consistent with the existing FIFO and landed-cost engine.

### Reconciliation

Supplier subledger = AP control account

### Multi-currency

Reuse existing Currencies & Rates.

Do not build another FX system.

---

# FINAL REQUIREMENT

Before coding:

1. Inspect every existing Payables route.
2. Inspect existing supplier/payment/invoice models.
3. Inspect existing posting mappings.
4. Inspect existing Inventory integration.
5. Inspect existing Import/Landed Cost integration.
6. Inspect existing payment and supplier-credit logic.
7. Identify:

   * KEEP
   * IMPROVE
   * ADD
   * REMOVE / REDIRECT

Do not rebuild what already works.

The target accounting chain is:

**Purchase Order**
→ **Goods Receipt**
→ **Purchase Invoice**
→ **Supplier Payable**
→ **Supplier Payment / Advance / Credit**
→ **Supplier Statement**
→ **Payables Ageing**
→ **AP Reconciliation**
→ **General Ledger**

For imports:

**Import Application**
→ **Shipment**
→ **Customs**
→ **Landed Cost**
→ **Final Cost**
→ **Goods Receipt**
→ **Inventory**
→ **Payables**

The final system must have **one source of truth for each transaction and one consistent accounting result across Purchasing, Inventory, Logistics, Payables, Treasury and the General Ledger.**

````
