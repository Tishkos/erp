# Four doors and profile links — independent review (2026-10-04)

The owner's rule: *"For every invoice I want notes, attachments, audit, print —
after the draft is created. Like Bank Loans: we can directly click the bank or
the customer; the parts have profiles. Make sure most things have a profile if
needed. Correctly audit."* This page is what the code on `verify/review`
(= `feat/erp-integration`, the six modules merged) actually does, read page by
page by somebody who wrote none of it, and where it differs from what
`docs/notes/doors-coverage.md` claims. The small gaps were fixed on this
branch (commits listed at the end); the rest is reported to the owner module.

**Columns.** **P A N H**: printer (`ExportIcon` with a key in `print/registry.ts`
and `EXPORT_ACCESS`), paperclip (`AttachmentsButton` / `RecordAttachmentsDoor`
with a parent-access check in `attachments-runtime.ts`), notes
(`RecordNotesDoor` or the invoice's door, with a `TARGETS` row in
`record-notes.ts`), clock (`HistoryButton` + `RecordHistory`) — ✓ in
`titleActions` in the rule's order, ◐ elsewhere on the page, ✗ missing, — not
applicable. **Draft**: the doors are drawn with no status gate (the box to add
a file may still follow the record's own rule). **Links**: every party or
account the page names is a `ProfileLink` (or the loan's `sapLink` markup) to a
route in `BASES` that is delivered — ✓, or the parties still in plain text.
**Audit**: every transition in the record's service writes `audit.record` /
`recordChange`. **Verdict**: `compliant`, `fixed` (compliant after this
review's commits), `failing` (needs the owner module), `profile` (a master
record: notes and clock), `view` (a rendering of another record: printer only).

## Invoice-like and money documents

| Page | P | A | N | H | Draft | Links | Audit | Owner | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| `payables/invoices/[invoiceNo]` — purchase invoice | ✓ | ✓ | ✓ | ✓ | ✓ | supplier ✓; import ✓; adjusted invoice, notes ✓; **item, warehouse (lines) and the payable / expense G/L account were text → fixed** | ✓ | payables | fixed |
| `payables/[payableNo]` — import application | ✓ | ✓ | ✓ | ✓ | ✓ | supplier ✓; B/L, PD, invoice, loan, application ✓; **item (order lines, quantities) text → fixed** | ✓ | payables | fixed (**door order was paperclip, printer, notes, clock → fixed**; the second "Add a note" box under the status log came off) |
| `payables/supplier-payments/[paymentNo]` | ✓ | ✓ | ✓ | ✓ | ✓ | supplier, bank/cash account, application, invoices ✓ | ✓ | payables | compliant |
| `payables/goods-returns/[returnNo]` — purchase return | ✓ | ✓ | ✓ | ✓ | ✓ | supplier, invoice, receipt, credit note, item, warehouse ✓ | ✓ | payables | compliant |
| `payables/advances/[advanceNo]` — supplier advance | ✓ | ✓ | ✓ | ✓ | ✓ | supplier, order, invoices ✓ | ✓ | payables | compliant |
| `payables/payment-applications/[applicationNo]` | ✓ | ✓ | ✓ | ✓ | ✓ | supplier, bank/cash account, bank, import, PD, loan ✓ | ✓ | payables | compliant |
| `payables/purchase-orders/[orderNo]` | ✓ | ✓ | ✓ | ✓ | ✓ | supplier, items, receipts, invoices ✓ | ✓ | payables | compliant |
| `payables/goods-receipts/[receiptNo]` | ✓ | ✓ | ✓ | ✓ | ✓ | order, supplier, item, warehouse ✓ | ✓ | payables | compliant |
| `payables/contracts/[contractNo]` — recurring contract | ✓ | ✓ | ✓ | ✓ | ✓ | supplier, department, invoices ✓ | ✓ | payables | compliant |
| `payables/credit-memos/[memoNo]` — supplier credit / debit note (new, not in the coverage table) | ✓ | ✓ | ✓ | ✓ | ✓ | supplier, invoice, return, G/L account, journals ✓ | ✓ | payables | compliant |
| `treasury/loans/[loanNo]` — bank loan (the owner's reference) | ✓ | ✓ | ✓ | ✓ | ✓ | **bank was text → `ProfileLink` (fixed)**; account ✓ (kind now follows the account's type); applications, imports ✓ | ✓ (`setManualShares` wrote no loan event → `bank_loan.shares_set` added) | payables | **compliant** — notes door and bank link fixed here; print model `bank_loan` added on `verify/e2e` (2026-10-04, later the same day) |
| `treasury/deposits/[depositNo]` — manual deposit | ✓ | ✓ | ✓ | ✓ | ✓ | **account it lands in, cash account / G/L account it came from, journal were text → fixed** | ✓ (through `treasury` / `other-receipt`) | payables | **compliant** — notes door and links fixed here; print model `bank_deposit` added on `verify/e2e` (2026-10-04, later the same day; see also the defects below) |
| `finance/journals/[entryNo]` | ✓ | ✓ | ✓ | ✓ | ✓ | G/L accounts, reversal, template ✓; **department (lines) text → fixed** | ✓ | accounting | fixed |
| `treasury/transfers/[transferNo]` — internal transfer | ✓ | ✓ | ✓ | ✓ | ✓ | bank/cash accounts, G/L accounts, journals ✓ | ✓ | accounting | compliant |
| `treasury/bank-reconciliation/[statementNo]` | ✓ | ✓ | ✓ | ✓ | ✓ | account, G/L account, journals ✓ | ✓ | accounting | compliant |
| `finance/recurring-journals/[templateNo]` | ✓ | ✓ | ✓ | ✓ | ✓ | G/L accounts, journals ✓; **branch, department text → fixed** | ✓ | accounting | fixed |
| `master-data/tax-codes/[code]` | ✓ | ✓ | ✓ | ✓ | ✓ | G/L account ✓ | ✓ | accounting | compliant |
| `finance/closing` — the period | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ | accounting | compliant |
| `sales/ar-invoices/[invoiceNo]` — sales invoice | ✓ | ✓ | ✓ | ✓ | ✓ | customer ✓; **item, supplier, warehouse (lines) and receivable / revenue G/L account were text → fixed**; revenue-trace accounts, journals ✓ | ✓ | receivables | fixed |
| `sales/customer-receipts/[receiptNo]` | ✓ | ✓ | ✓ | ✓ | ✓ | customer, bank/cash account, invoices ✓ | ✓ | receivables | compliant |
| `sales/sales-returns/[returnNo]` | ✓ | ✓ | ✓ | ✓ | ✓ | customer, invoice ✓; **item, destination warehouse text → fixed** | ✓ | receivables | fixed |
| `sales/credit-notes/[noteNo]` — credit / debit note and the credit memo | ✓ | ✓ | ✓ | ✓ | ✓ | customer, invoice, return, journal ✓ | ✓ | receivables | compliant |
| `inventory/opening-stock/[documentNo]` | ✓ | ✓ | ✓ | ✓ | ✓ | warehouse, items ✓ | ✓ | inventory | compliant |
| `inventory/stock-count/[countNo]` | ✓ | ✓ | ✓ | ✓ | ✓ | warehouse, items ✓ | ✓ | inventory | compliant |
| `/inventory/transfers` — warehouse transfer | — | — | — | — | — | — | ✓ | inventory | **failing — no record page**: a transfer is a row of the register with a per-row `ExportMenu`; nothing to hang paperclip, notes or clock on (`warehouse_transfer` is already a note target and has a parent-access check) |
| `/inventory/stock-reconciliation` — stock reconciliation | — | — | — | — | — | — | ✓ | inventory | **failing — no record page** (same; `stock_reconciliation` is registered for notes and files) |

## Logistics documents

| Page | P | A | N | H | Draft | Links | Audit | Owner | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| `payables/shipments/[blNo]` — B/L | ✓ | ✓ | ✓ | ✓ | ✓ | import, supplier, port of discharge, containers, warehouses ✓; shipping line and port of loading are free text (no carrier record) | ✓ | logistics | compliant |
| `payables/containers/[containerNo]` | ✓ | ✓ | ✓ | ✓ | ✓ | import, supplier, B/L, warehouse, PD ✓; **item (lines) text → fixed** | ✓ | logistics | fixed |
| `payables/pd/[pdNo]` — PD | ✓ | ✓ | ✓ | ✓ | ✓ | import, supplier, bank, PDs, applications, B/Ls, containers ✓ | ✓ | logistics | compliant |
| `payables/pd/asycuda/[runNo]` — ASYCUDA reading | ✓ | ✓ | ✓ | ✓ | ✓ | PDs, imports ✓ | ✓ | logistics | compliant |
| `logistics/customs-declarations/[declarationNo]` | ✓ | ✓ | ✓ | ✓ | ✓ | import, supplier, PD ✓ | ✓ | logistics | compliant |
| `logistics/ports/[code]` — port (profile with four doors) | ✓ | ✓ | ✓ | ✓ | ✓ | B/Ls, imports, suppliers, containers ✓ | ✓ | logistics | compliant |

## Project System and HR (shared)

| Page | P | A | N | H | Draft | Links | Audit | Verdict |
|---|---|---|---|---|---|---|---|---|
| `projects/billing/[no]`, `projects/budgets/[no]`, `projects/change-orders/[no]`, `projects/material-issues/[no]` | ✓ | ✓ | ✓ | ✓ | ✓ | project, customer, journal, warehouse, items ✓ (WBS codes are text — an element has no page) | ✓ | compliant |
| `hr/advances`, `hr/leave`, `hr/documents`, `hr/requests`, `hr/performance`, `hr/recruitment` (+ applicants), `hr/payroll/[runNo]` | ✓ | ✓ | ✓ | ✓ | ✓ | employee, accounts, journals ✓; a leave's manager and a review's reviewer are text (as the coverage table says) | ✓ | compliant |
| `hr/payroll/payslips/[payslipNo]` | ✓ | — | — | — | — | employee, department, run ✓ | — | view |
| `projects/[code]`, `hr/employees/[employeeNo]` | — | — | ✓ | ✓ | — | customer, manager, branch, department, position ✓ | ✓ | profile |

## Profiles

| Page | Kind | Notes | Clock | Owner | Verdict |
|---|---|---|---|---|---|
| `master-data/business-partners/[code]` (`/sales/customers/…`, `/payables/suppliers/…`) | `customer`, `supplier` | ✗ | ◐ (`AuditLogButton` + log under the record) | receivables / payables | profile — exists; a notes door would be welcome (`business_partner` is a note target) |
| `master-data/banks/[code]` | `bank` | ✗ | ◐ | accounting | profile — exists |
| `master-data/bank-accounts/[code]`, `master-data/cash-accounts/[code]` | `bank_account`, `cash_account` | ✗ | ◐ (G/L account and bank link ✓) | accounting | profile — exists |
| `master-data/chart-of-accounts/[code]` | `gl_account` | ✗ | ◐ | accounting | profile — exists; its ledger one click on |
| `master-data/items/[code]`, `master-data/warehouses/[code]` | `item`, `warehouse` | ✓ | ✓ | inventory | profile |
| `logistics/ports/[code]` | `port` | ✓ | ✓ | logistics | profile with four doors |
| — | `carrier` | | | logistics | **missing** — a B/L's shipping line is text |
| — | `currency`, `fixed_asset`, `investment` | | | shared | missing — nothing links to them yet |

`tests/unit/profiles.test.ts` holds every filled-in `BASES` route to an existing,
delivered page; it passes on this branch.

## Score

* 64 dynamic pages under `src/app/(app)` plus `/finance/closing`; 42 of them
  are record or document screens the rule applies to (the rest are profiles,
  reports, settings, the payslip view and the journal's full audit page), and
  two more documents — the warehouse transfer and the stock reconciliation —
  have no page at all.
* Fully compliant before this review: 33. Brought to compliance here: 7
  (purchase invoice, import application, sales invoice, sales return, journal,
  recurring journal, container). Improved here, and brought to compliance later
  the same day on `verify/e2e`: 2 (the loan and the deposit — notes door and
  links added here, print models `bank_loan` / `bank_deposit` there). Failing with
  nothing to fix in place: 2 (the transfer and the reconciliation, no record
  page). Still failing in all: 4.

## Defects found on the way (fixed here)

* **Deposit slip filed under the wrong object.** `attachToDeposit` asked
  `source === 'cash'` for a `bank_transfer`; since dec7625 only `transfer` is
  one, so a cash deposit's slip went to `bank_transfer` with an
  `other_receipt` id and the parent-access check refused it.
* **Raw keys on every bank deposit.** dec7625 renamed the service's sources to
  `cash | bank | transfer` and left the messages at `cash | other`:
  `admin.bank_deposits.document_type_bank` and `source_bank` showed as keys.
  Both locales now carry the six.
* **Two dialogs, one field name.** The Bank deposit dialog shared
  `credit_account_id` / `payer` with the Cash deposit dialog (AGENTS.md ›
  FIX-1 forbids it); its labels did not reach its fields.
* `tests/e2e/fx1-navigation.spec.ts` still looked for "Bank Deposits" and
  "Other deposit"; the screen says Manual Deposits and Bank deposit.

## Claims vs reality (`doors-coverage.md`)

* The payables rows (`supplier-payments`, `goods-returns`, `advances`,
  `payment-applications`, `purchase-orders`, `goods-receipts`, `contracts`,
  the purchase invoice's supplier) read **owner module** with ◐/❌; on the
  merged branch they are all four doors through `PurchaseDoors`, supplier and
  accounts linked. The table is behind the branch, not ahead of it.
* The import application is claimed ✅✅✅✅ — the doors were there but in the
  wrong order (paperclip before printer).
* The bank loan and the deposit read as claimed (no printer, no notes door);
  the notes door was one line away on both.
* `payables/credit-memos/[memoNo]` is not in the table at all; it is compliant.
* The inventory section lists only opening stock and the stock count; the
  warehouse transfer and the stock reconciliation — both named in the owner's
  list of records — are absent because they have no page.
* "Parties → profile ✅" on the sales invoice, the sales return, the journal,
  the recurring journal and the container counted the header and missed the
  lines (item, warehouse, supplier, department) — fixed here.
* Project System, HR and logistics rows read as claimed.

## Audit

Every record service's transitions write an audit row (`audit.record` or the
`recordChange` helper); a note is itself an audit event. The one gap found:
`loans.setManualShares` restated commission shares with only import events
(`COMMISSION_RECORDED`) and no `bank_loan` row — it now writes
`bank_loan.shares_set` with each share's before and after. Posted documents
are guarded (`editableDraft` and the like) and corrected by reversal.

## Commits on `verify/review`

`98c6e45` doors and links on eight pages · `0414acf` G/L accounts, items, the
review spec · `6257283` the deposit's slip, labels and second dialog ·
`2f4453a` the import's second note box · and this note.
`tests/e2e/review-doors.spec.ts` raises one record per module in the browser
and reads it against the rule; screenshots in `/home/claude/shots/review/`.
