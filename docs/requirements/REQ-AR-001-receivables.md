# REQ-AR-001 — Receivables (agent: **receivables**, branch `feat/receivables-module`)

The receivables module, finalised: what customers owe, what they have paid,
what they hold as credit, and proof that all of it agrees with the general
ledger. One heading — **Sales & Receivables** — and one source of accounting
truth throughout:

**Sales Invoice → Receivable → Receipt / Credit → Statement / Ageing → Reconciliation → G/L**

| | |
|---|---|
| **Requirement ID** | `REQ-AR-001` |
| **Agent** | `receivables` — one of several module agents run in parallel, each on `feat/{module}-module` |
| **Branch** | `feat/receivables-module` (off `main` at `1e2ffd1`) — never `main` directly |
| **Source** | The sponsor's instruction of 2026-10-04, verbatim in Appendix A |
| **Approved by** | *The sponsor's instruction of 2026-10-04 (Appendix A); the defaults in §2 marked "owner to confirm" are not yet confirmed.* |
| **Test case(s)** | `tests/integration/rcv01-receivables.test.ts` (every §14 scenario), `tests/unit/fx1-menu.test.ts`, `tests/unit/screen-catalogue.test.ts` |
| **Status** | **Built, awaiting the owner** — services, migration, screens, doors, controls and tests built; owner to confirm the defaults in §2 |

---

## 0. Agent brief — read this first

You are the **receivables** agent. Other agents are working at the same time on
**inventory**, **accounting** and **payables**, each on its own
`feat/{module}-module` branch, and the owner merges them by hand. So:

1. **Work only on `feat/receivables-module`.** Commit there, push there. Never
   push to `main`, never merge another branch in, never rebase onto `main`
   without being asked.
2. **Stay in your lane.** Receivables files are `src/app/(app)/sales/**`,
   `src/server/services/{ar-invoice,customer-receipt,customer-credit-memo,customer-notes,customer-credits,customer-reconciliation,sales-return}.ts`,
   `src/components/admin/{receivables-ageing,receivable-invoice-activity}.tsx`,
   `src/server/domain/customer-credits.ts`, `src/server/db/schema/customer-note.ts`.
   Do **not** change inventory, payables or general-ledger code. Sales returns
   keep using the existing inventory / FIFO engine (`inventory.*`) untouched.
3. **Shared files get small, additive edits only**, each marked
   `Receivables (2026-10-04)` in a comment: the menu, the screen list, the
   posting map, the reset lists, the print registry, the message files. The
   shared Payables/Receivables ageing component (`open-items-report.tsx`) is
   **not** edited — Receivables has its own (`receivables-ageing.tsx`).
4. **Obey `CLAUDE.md` / `AGENTS.md`** — in particular: screens copy the
   existing models and add no CSS; record pages carry the four doors
   (printer, paperclip, notes where kept, clock) in `DocumentWindow.titleActions`;
   money as scaled bigints (`parseDecimal` / `toDecimalString`), never
   `Number()`; "today" is `businessToday()`; transitions lock their row
   `FOR UPDATE`; new document tables go in `resetTestData` **and**
   `format-live-database.sh`.
5. **Migrations:** this branch adds `0280_receivables_notes` at journal time
   `1795900000090`. If any other branch lands a migration on `main` first, this
   one's `when` must be re-timed **after the last entry on `main`** at merge
   (and its number moved if it collides). Never rewrite an applied migration.
6. **Do not reuse the dev `.env` database for tests.** See §7.

---

## 1. What the sponsor asked for (summary — full text in Appendix A)

* **Navbar** — Receivables › *Sales & Receivables*: Sales Invoices, Customer
  Receipts, Customer Credits & Advances, Customer Statements, Receivables
  Ageing, Credit Notes / Debit Notes, Sales Returns, Customer Reconciliation.
  **Customers belong only in Master Data**; Receivables references them.
* **Sales Invoice** creates the receivable; payment comes only through a
  receipt. Draft → Posted → Partially Paid → Paid, reversal per the existing
  architecture. Shows paid, outstanding, related returns/credit notes,
  attachments, audit history, print.
* **Customer Receipt** is independent of the invoice; allocates to one or many
  invoices; keeps any remainder as the customer's credit/advance. Customer,
  date, bank/cash account, currency, amount, reference, payment method,
  unapplied amount, attachments, audit trail.
* **Customer Credits & Advances** — money with no invoice is a credit, never a
  fake invoice; later applied to a real invoice; unapplied receipts and
  overpayments too. Distinguish outstanding invoices, applied receipts,
  unapplied credits.
* **Customer Statement** — the full subledger, debit/credit/running balance,
  generated from the subledger, never a balance table.
* **Receivables Ageing** — remaining outstanding by bucket (Not yet due, 1–30,
  31–60, 61–90, 90+); filters customer, branch, as-of, currency, status
  (paid / partially paid / open / all); credits kept separate; top metrics:
  Gross, Not yet due, Overdue, Unapplied credits, Net position.
* **Late payment** — "Paid 3 days late" from due date and receipt date; the
  due date is never rewritten.
* **Credit / Debit Notes** — a dedicated workflow; audit history, existing
  posting mappings, on the statement, in the ageing, traceable to the source
  invoice.
* **Sales Returns** — reduce A/R and reverse revenue/cost through the existing
  inventory/FIFO engine; no second inventory engine.
* **Customer Reconciliation** — subledger vs A/R control in the G/L, difference
  with ✅/⚠️, the investigation path; never auto-repair.
* **One source of truth**; **UI unchanged** in style; **drill-down** from
  ageing → customer → invoices → payments → credits → statement, from a
  statement row to its source document, and from an invoice to its receipts,
  credit notes, returns and remaining balance.
* **§14 validation list** — invoice, partial, full, advance, overpayment,
  ageing, late payment, credit note, sales return, reconciliation,
  multi-currency on the existing Currencies & Rates.

---

## 2. What I understood — decisions taken (D-AR-n)

Inspection first (§0 of the instruction). Most of the machinery already
existed and is **reused, not rebuilt**: `ar-invoice` (posting, reversal,
`applyAllocation`), `customer-receipt` (allocation, oldest-first plan),
`customer-credit-memo` (the money half of a return), `sales-return`
(`acceptAndSettle` with FIFO), `open-items` (ageing + tie to the ledger),
`partner-statement` (statement from `subledger_entry`),
`subledger.reconciliation` (subledger vs control, used by the closing check),
the posting engine and the exchange-rate service.

| # | Decision | Why |
|---|---|---|
| D-AR-1 | **Customers** move to the Master Data heading; the route stays `/sales/customers` (D-FX-1). | "Customers belong only in Master Data"; every existing link keeps working. |
| D-AR-2 | The eight items reuse Appendix A keys: `ar_allocations` → Credits & Advances (`/sales/customer-credits`), `customer_credit_memos` → Credit / Debit Notes (`/sales/credit-notes`), `ar_reconciliation` → Customer Reconciliation (`/sales/customer-reconciliation`). Unbuilt sales items stay in the tree, hidden. | The catalogue's 242 items / 357 screens stay intact; no Appendix A function dropped. |
| D-AR-3 | **A customer's credit is derived, never stored**: a posted receipt's unapplied remainder (advance if nothing applied, overpayment otherwise), a credit memo's remainder, a credit note's remainder. | §11 one source of truth. Receipts already post Dr Bank / Cr Customer A/R, so the subledger already holds the credit. |
| D-AR-4 | Receipts keep posting **Cr Customer A/R**; there is **no reclassification to a separate "customer advances" liability account**. | The existing architecture; the ageing shows the credit apart (gross vs unapplied vs net). A reclass to a liability account is a possible later stage, owner's call. |
| D-AR-5 | **Credit memo ≠ credit note.** The memo (0050) keeps its NOT NULL accepted-return rule. A **credit note** (allowance, no goods) and a **debit note** (extra charge) are a new document, `customer_note`. | Appendix C makes the return compulsory for a memo; weakening that control was not acceptable. |
| D-AR-6 | Posting: credit note **Dr Sales Returns & Allowances / Cr Customer A/R** (`sales.customer_credit_note`); debit note **Dr Customer A/R / Cr Revenue** (`sales.customer_debit_note`). Rules copied in 0280 from the memo's and the invoice's events; an optional account override like the invoice's. A note against an invoice uses that invoice's receivable account and dimensions. | "Post through the existing accounting mapping." |
| D-AR-7 | A **credit note against an invoice applies itself on posting** up to what the invoice still owes; the rest stays as the customer's credit. A **debit note is owed** from its due date (customer's payment terms by default) and ages like an invoice. | Spec example: 100,000 − 10,000 = 90,000 outstanding; "affect ageing appropriately". |
| D-AR-8 | **Every settlement is recorded in exactly one place**: receipt → invoice stays in `customer_receipt_allocation`; memo → its own invoice stays on the memo (`applyTo`); every other pairing (receipt → debit note, credit note → invoice/debit note, memo remainder → other debt) is one `customer_credit_application` row. A CHECK refuses receipt→invoice in the new table; triggers enforce customer, status and ceilings; the receipt-allocation trigger now counts both tables. | No duplicated settlement logic, no double counting. |
| D-AR-9 | Notes are governed by the **`customer_credit_memo` permission object** (same roles, MFA already applies). | No new grants, consistent with who may credit a customer today. |
| D-AR-10 | **Late payment** counts from the **receipt date** (money arrived), not the allocation timestamp. Due dates are never rewritten. | "Due 1 Oct, paid 4 Oct → paid 3 days late." Changed on the customer side of `open-items` only. |
| D-AR-11 | **Multi-currency**: a receipt's currency must equal its bank/cash account's currency (refused at entry with a clear message). The posting engine carries one currency per journal, so no new FX logic was built. | "Do NOT build another FX system"; closes IMPROVEMENT-002 §2.2 (d) for receipts. Foreign-currency receipts need per-line currency in the engine — a later, cross-module change. |
| D-AR-12 | **Tax**: the AR invoice has no tax lines today; none added. | Out of scope without a tax engine decision. |
| D-AR-13 | **Receivables Ageing** gets its own component (`receivables-ageing.tsx`); the shared `OpenItemsReport` (Payables) is untouched. Same service underneath. | Merge safety with the payables agent; same definitions of overdue. |
| D-AR-14 | **Customer Reconciliation is read-only**; it uses `subledger.reconciliation` (the closing check's query) and lists the exact lines behind any difference (no subledger entry, amount differs, other control account, unposted journal), each opening its journal. | "Do not automatically repair." |
| D-AR-15 | The invoice's status flow is the existing one: draft → approved → posted → partially_executed (Partially Paid) → settled (Paid); reversal only while nothing rests on it. | Existing architecture. |

**Decided by default, owner to confirm** (orchestrator, 2026-10-04 — taken as
recommended so the work does not block; each is reversible):

* Decided by default, owner to confirm: advances and unapplied receipts stay a
  credit on Customer A/R, shown apart in the ageing and on Credits & Advances —
  no reclassification to a separate customer-advances liability (D-AR-4).
* Decided by default, owner to confirm: credit and debit notes reuse the
  `customer_credit_memo` permission object; no separate `customer_note` grant
  (D-AR-9).
* Decided by default, owner to confirm: "days late" on the customer side counts
  from the receipt date, not the allocation timestamp (D-AR-10). Payables is
  unchanged.
* Decided by default, owner to confirm: a receipt into a bank or cash account of
  another currency is refused at entry rather than at posting (D-AR-11).
* Decided by default, owner to confirm: Customers sit under Master Data's first
  heading (`master_data`, beside the financial master records), not under
  Banking, Organization or Inventory Reference (PR #43's split).

**Out of scope** (reported, not built): multi-currency receipts — the posting
engine carries one currency per journal; sales tax — no tax engine.

---

## 3. Status by requirement

| § | Requirement | Status | Where |
|---|---|---|---|
| Nav | Sales & Receivables heading, 8 items, Customers in Master Data | **Done** | `domain/menu.ts`, `domain/screens.ts`, messages, `fx1-menu.test.ts` |
| 1 | Sales Invoice: four doors, paid/outstanding, receipts/credits/notes/returns/remaining | **Done** | `ar-invoices/[invoiceNo]/page.tsx`, `receivable-invoice-activity.tsx` |
| 2 | Receipt: payment method, currency, unapplied, attachments, audit, applied-elsewhere | **Done** | `customer-receipts/*`, `customer-receipt.ts`, migration 0280 |
| 3 | Customer Credits & Advances screen + apply to invoice/debit note | **Done** | `customer-credits/*`, `services/customer-credits.ts` |
| 4 | Statement from subledger; notes/memos named and linked | **Done** (existing + links) | `partner-statement.ts`, `account-statement.tsx` |
| 5 | Ageing: top metrics, filters (customer, branch, as-of, currency, status), debit notes, credits apart, drill-down | **Done** | `receivables-ageing.tsx`, `open-items.ts`, `print/reports.ts` |
| 6 | Paid N days late from the receipt date | **Done** | `open-items.ts` (customer query) |
| 7 | Credit / Debit Notes: list, new, record, approve, post, reverse, cancel, print, attach | **Done** | `credit-notes/*`, `services/customer-notes.ts`, `print/documents.ts` |
| 8 | Sales Returns connected to AR/inventory/GL | **Existing, verified by test** | `sales-return.acceptAndSettle` |
| 9 | Customer Reconciliation with investigation path | **Done** | `customer-reconciliation/page.tsx`, `services/customer-reconciliation.ts` |
| 13 | Drill-down ageing → customer/statement/credits; statement → source; invoice → everything | **Done** | as above |
| 14 | Validation scenarios | **Done — 20/20 passing** | `tests/integration/rcv01-receivables.test.ts` |
| 12 | UI unchanged; screenshots beside the models; theme readability | **Verified 2026-10-04** | `tests/e2e/receivables.spec.ts`, `theme-readability.spec.ts`, screenshots |
| R1 | Four doors from the draft on invoice, receipt, return, credit/debit note, credit memo | **Done** | record pages; `attachments-runtime.ts`; rcv01 › *the four doors* |
| R2 | Customer name links to the customer's profile on every receivables record and register | **Done** | shared `ProfileLink`; `/sales/customers/<code>?role=customer` |
| C | Controls register rows for 0280 | **Done** — C-41 to C-45 | `docs/CONTROLS.md`, rcv01 › *0280* |

---

## 4. What was built

**Migration `0280_receivables_notes`** — `customer_note` (kind credit/debit,
status machine, frozen after posting, same-customer trigger, RLS by branch),
`customer_credit_application` (one source, one target, append-only, ceilings
and customer checked by trigger, RLS), the receipt-allocation trigger now
counting both tables, `customer_receipt.payment_method_code`, number series
`CUSTOMER_CREDIT_NOTE` (CRN) and `CUSTOMER_DEBIT_NOTE` (DBN), document type
`customer_note`, posting rules for the two new events.

**Services** — `customer-notes.ts` (create, approve, cancel, post, reverse,
list with memos, view, invoices for the picker), `customer-credits.ts`
(apply, register, open debts, receipt totals, applications),
`customer-reconciliation.ts` (control accounts, exceptions), pure rules in
`domain/customer-credits.ts`. `open-items.ts`: customer side reads invoices
**and** debit notes with payments and credits; supplier query unchanged apart
from four returned columns. `customer-receipt.ts`: currency check, payment
method.

**Screens** — `/sales/customer-credits`, `/sales/credit-notes` (+ `/new`,
`/[noteNo]`, which also opens credit memos read-only),
`/sales/customer-reconciliation`, `/sales/receivables` (own component), the
invoice and receipt record pages (doors, registers), the receipt form.

**Shared, additive** — menu, screen catalogue, posting map (2 events), print
access/registry/documents (`customer_note` export key; receipt print shows
currency and method), `print/reports.ts` (receivables copy honours the new
filters), attachments runtime (parent checks for `ar_invoice`,
`customer_receipt`, `customer_note`, `customer_credit_memo`), due notices
(debit-note link), statement (note/memo links), reset lists, EN/AR messages.

---

## 5. Left to do (next run of this agent)

(2026-10-04, second run: the items below were taken up; see §3.)

- [x] Run the app against an isolated database, open every new and changed
      screen (desktop EN, mobile AR) and compare side by side with its model
      (Purchase Invoices list, Purchase Invoice record, Sales Return new page,
      the ageing). Fix anything a reviewer could tell apart.
- [x] `npx playwright test tests/e2e/theme-readability.spec.ts --workers=1`.
- [x] Add an e2e spec for the new screens (`tests/e2e/receivables.spec.ts`).
- [ ] Run the **full** integration suite on an isolated database — the
      orchestrator runs it at merge; the focused AR files run here.
- [x] Rows for the new triggers/constraints in `docs/CONTROLS.md` (C-41–C-45).
- [x] A Receivables section in `AGENTS.md` (CLAUDE.md only includes it).
- [ ] The PR into `main` — the orchestrator's.

Known, **not from this branch**: `ops16-document-table-lists` fails on `main`
— `bank_loan_repayment` and `bank_loan_revaluation` are missing from the reset
lists (the loans work).

---

## 6. Merge notes for the owner

* **Migration**: `0280_receivables_notes`, `when = 1795900000090`. Re-time
  after the last journal entry on `main` at merge if anything else landed.
* **Shared files touched** (small, additive, commented): `domain/menu.ts`,
  `domain/screens.ts`, `domain/posting-map.ts`, `services/open-items.ts`,
  `services/partner-statement.ts`, `services/due-notices.ts`,
  `attachments-runtime.ts`, `print/access.ts`, `print/registry.ts`,
  `print/documents.ts`, `print/reports.ts`,
  `components/admin/account-statement.tsx`, `db/schema/index.ts`,
  `db/schema/customer-receipt.ts`, `tests/integration/setup.ts`,
  `scripts/ops/format-live-database.sh`, `tests/unit/fx1-menu.test.ts`,
  `tests/unit/screen-catalogue.test.ts`, `messages/en.json`, `messages/ar.json`.
* **Not touched**: inventory services, payables services and screens,
  `open-items-report.tsx`, the posting engine, the journal service.

---

## 7. Verification commands

```bash
# Isolated databases (never the shared .env ones)
npm run db:migrate                                   # dev database
DATABASE_URL_OWNER=postgres://erp_owner:…@localhost:5432/erp_test npm run db:migrate
# (the test setup's own migrate cannot apply enum migrations to a fresh DB;
#  migrating erp_test first with migrate.ts avoids that)

npx tsc --noEmit
npx vitest run --project unit
npx vitest run --project integration tests/integration/rcv01-receivables.test.ts \
  tests/integration/open-items.test.ts tests/integration/ops17-ageing-ties-to-statement.test.ts \
  tests/integration/sales-ar-subledger.test.ts tests/integration/sales-receipts-cash-sales.test.ts \
  tests/integration/ops09-sales-returns.test.ts tests/integration/ops02-partner-statement.test.ts \
  tests/integration/ops05-sales-invoice.test.ts
```

Last verified on this branch: typecheck clean on the final code. Unit suite
1730/1731 before the last fix; the one failure (`hd18-no-raw-enum`) was fixed
and that file re-run green, but the full unit suite was not re-run after it.
Integration: `rcv01-receivables` 20/20 and the other seven files 144/144 were
run **before** the final round of changes (open-items minimal-diff refactor,
receipt currency check and payment method, statement links, receipt/invoice
page doors), so they must be re-run.

---

## Appendix A — the sponsor's instruction (2026-10-04, verbatim)

We are now adding/finalizing the **Receivables** module.

Please first inspect the existing Receivables/Sales implementation and reuse the current UI, components, accounting engine, customer master, posting mappings, and existing screens. Do not rebuild working functionality and do not create duplicate customer/accounting engines.

## Final Receivables navbar

### Receivables

#### Sales & Receivables

* Sales Invoices
* Customer Receipts
* Customer Credits & Advances
* Customer Statements
* Receivables Ageing
* Credit Notes / Debit Notes
* Sales Returns
* Customer Reconciliation

### Important Master Data rule

**Customers belong only in Master Data.**

Do not create a second Customer master inside Receivables.

The Receivables module references the existing Customer master.

---

# 1. Sales Invoices

This is the document that creates the customer receivable.

Example:

Invoice:
**100,000 IQD**

After posting:

**Customer receivable = 100,000 IQD**

Important:

A sales invoice does **not** mean the customer has paid.

Payment must come through a separate Customer Receipt.

The invoice should contain/reuse:

* Customer
* Invoice date
* Due date
* Payment terms
* Currency
* Lines/items
* Quantity
* Unit price
* Tax where applicable
* Total
* Outstanding amount
* Paid amount
* Status
* Related returns/credit notes
* Attachments
* Audit history
* Print

Expected status flow:

**Draft → Posted → Partially Paid → Paid**

with appropriate cancellation/reversal handling according to the existing accounting architecture.

---

# 2. Customer Receipts

This records actual money received from a customer.

A receipt must be independent from the invoice.

Example:

Invoice:
**100,000 IQD**

Customer pays:
**40,000 IQD**

Result:

* Invoice total = 100,000
* Paid = 40,000
* Outstanding = 60,000

Do not automatically mark the invoice paid just because a receipt exists.

The receipt must support:

* Customer
* Receipt date
* Bank/cash account
* Currency
* Amount
* Reference
* Payment method
* Allocation to one or more invoices
* Unapplied amount
* Attachments
* Audit trail

Example:

Receipt:
**1,000,000 IQD**

Applications:

* Invoice A → 600,000
* Invoice B → 300,000
* Unapplied customer credit → 100,000

The system must preserve the 100,000 as a customer credit/advance.

---

# 3. Customer Credits & Advances

This is separate from invoices.

Examples:

### Customer advance

Customer pays:

**5,000,000 IQD**

but there is no invoice yet.

The system should show:

**Customer Credit / Advance = 5,000,000 IQD**

Do NOT create a fake invoice.

Later, the credit can be allocated against a real invoice.

Also support unapplied receipt balances and overpayments.

The customer account should clearly distinguish:

* Outstanding invoices
* Applied receipts
* Unapplied credits/advances

---

# 4. Customer Statements

This should show the complete customer subledger.

Example:

| Date   | Reference          |   Debit | Credit | Balance |
| ------ | ------------------ | ------: | -----: | ------: |
| 01 Oct | Invoice INV-001    | 100,000 |      — | 100,000 |
| 05 Oct | Receipt RCPT-001   |       — | 40,000 |  60,000 |
| 10 Oct | Credit Note CN-001 |       — | 10,000 |  50,000 |

Core rule:

**Sales invoice = debit to customer receivable**

**Customer receipt = credit to customer receivable**

Credit notes / returns also reduce the receivable.

The statement must be generated from the underlying subledger/transactions, not a separate balance table that can drift.

---

# 5. Receivables Ageing

This is one of the most important Receivables screens.

It must answer:

> Who owes us money, how much, and how overdue is it?

Show buckets such as:

* Not Yet Due
* 1–30 days
* 31–60 days
* 61–90 days
* 90+ days

Support filters for:

* Customer
* Branch
* Date/as-of date
* Currency where applicable
* Status
* Paid
* Partially Paid
* Open
* All

## Important accounting behavior

Ageing should be based on the **remaining outstanding amount of invoices**, not simply the original invoice amount.

Example:

Invoice:
100,000

Receipt:
40,000

Ageing:
**60,000 outstanding**

A fully paid invoice must not appear in outstanding ageing.

## Credits and advances

Customer advances/unapplied credits must remain separate.

Example:

Invoice:
100,000

Customer advance:
5,000,000

Show:

**Gross Receivables = 100,000**

**Unapplied Customer Credits = 5,000,000**

**Net Position = -4,900,000**

Do NOT pretend the customer has a -4.9M invoice balance.

## Required summary metrics

At the top show:

* Gross Receivables
* Not Yet Due
* Overdue
* Unapplied Credits
* Net Position

---

# 6. Late payment handling

If an invoice was due on:

**01 Oct**

and the customer paid on:

**04 Oct**

the system should show:

**Paid 3 days late**

This should be derived from the due date and actual receipt/application date.

Do not rewrite the invoice due date.

---

# 7. Credit Notes / Debit Notes

Add a dedicated workflow for customer credits/debits.

### Credit Note

Reduces what the customer owes.

Example:

Invoice:
100,000

Credit Note:
10,000

Outstanding:
**90,000**

### Debit Note

Increases what the customer owes where appropriate.

Both must:

* preserve audit history
* post through the existing accounting mapping
* appear on the customer statement
* affect ageing appropriately
* remain traceable to the source invoice/document when applicable

---

# 8. Sales Returns

Sales Returns must connect correctly to:

* Inventory
* Sales
* Receivables
* GL

A sales return should reduce the customer's receivable as appropriate and reverse the corresponding inventory/revenue/cost effects according to the existing accounting architecture.

Do NOT create a second inventory engine.

Use the same inventory movement/FIFO logic already used elsewhere.

---

# 9. Customer Reconciliation

Add a control screen that compares:

**Customer subledger balance**

against:

**Accounts Receivable control account in the G/L**

Example:

Customer subledger:
**12,500,000 IQD**

AR control account:
**12,500,000 IQD**

Difference:
**0 IQD ✅**

If there is a difference:

**Difference: 250,000 IQD ⚠️**

Show the investigation path/source transactions.

Do not automatically repair reconciliation differences.

---

# 10. Cross-module accounting flow

The final architecture should be:

### Sales Invoice

Sales Invoice
→ Customer Receivable
→ AR Control Account
→ Revenue / Tax / other configured accounts

### Customer Receipt

Customer Receipt
→ Bank/Cash
→ Customer Receivable

### Customer Advance

Customer Receipt with no invoice allocation
→ Bank/Cash
→ Customer Credit / Advance

### Credit Note

Credit Note
→ Reduces Customer Receivable
→ Appropriate revenue/tax/accounting reversal

### Sales Return

Sales Return
→ Customer Receivable reduction
→ Inventory movement
→ Revenue/other accounting effects
→ COGS reversal according to existing architecture

### Statement

Reads the complete customer subledger.

### Ageing

Reads outstanding invoice balances and unapplied customer credits.

### Reconciliation

Customer subledger ↔ AR control GL.

---

# 11. One source of truth

Do not create competing balances.

The customer balance must be derived consistently from posted transactions/subledger entries.

Do not maintain:

* one balance in Customer master
* another in Receivables
* another in Ageing
* another in Statements

These screens should all read from the same underlying accounting/subledger data.

---

# 12. UI requirements

Keep the existing Qimah ERP UI exactly.

Do not redesign the existing visual language.

Reuse:

* current tables
* cards
* filters
* forms
* modals/drawers
* buttons
* date pickers
* currency formatting
* loading states
* empty states
* error states
* attachment icon
* audit/history icon
* print icon

Use the same action-icon placement already standardized elsewhere in the ERP.

Make all lists dynamic.

Do not leave mock/sample data.

---

# 13. Customer drill-down

From an Ageing row, the user should be able to open:

**Customer → invoices → payments → credits → statement**

From a Statement row, the user should be able to open the underlying source document.

From an Invoice, the user should be able to see:

* receipts applied
* credit notes
* sales returns
* remaining balance

This should make investigation fast for accountants.

---

# 14. Required validation/testing

Before considering Receivables complete, test:

### Invoice

100,000 invoice → 100,000 receivable

### Partial receipt

100,000 invoice → 40,000 receipt → 60,000 outstanding

### Full payment

100,000 invoice → 100,000 receipt → zero outstanding → invoice Paid

### Unapplied advance

5,000,000 receipt with no invoice → 5,000,000 customer credit

### Overpayment

100,000 invoice → 120,000 receipt → 20,000 unapplied credit

### Ageing

Invoice due 3 days ago and unpaid → 3 days overdue

### Late payment

Invoice due Oct 1 → paid Oct 4 → "Paid 3 days late"

### Credit note

100,000 invoice → 10,000 credit note → 90,000 outstanding

### Sales return

Verify AR, inventory, revenue and cost effects remain consistent

### Reconciliation

Customer subledger = AR control GL

### Multi-currency

Use the existing Currencies & Rates infrastructure.
Do NOT build another FX system.

---

# 15. Final navbar

The final Receivables tab should be:

## Receivables

### Sales & Receivables

* Sales Invoices
* Customer Receipts
* Customer Credits & Advances
* Customer Statements
* Receivables Ageing
* Credit Notes / Debit Notes
* Sales Returns
* Customer Reconciliation

Customers remain exclusively under:

**Master Data & Configuration → Customers**

Do not duplicate Customers inside Receivables.

### Final requirement

First inspect the existing implementation and tests.

Reuse what already works.

Do not rebuild the accounting engine.

Do not create duplicate customer balances.

The goal is:

**Sales Invoice → Receivable → Receipt/Credit → Statement/Ageing → Reconciliation → G/L**

with one consistent source of accounting truth throughout.
