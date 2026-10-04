# Four doors and profile links — coverage (2026-10-04)

The owner's rule: *"Every invoice — notes, attachments, audit, print — after the
draft is created. Like Bank Loans: we can click the bank or the customer; the
parts have profiles."* AGENTS.md › *Every record wears the same four doors* and
› *Shared doors and profiles* say how. This page is the one truth table of
where every record page stands. The rows marked **owner module** were surveyed
on `main` 81a5ede and are each module agent's to finish on its own branch; the
orchestrator re-checks them at merge. Every other row is `feat/shared-module`'s
and reads as it is on that branch. **The merged branch was reviewed page by
page on 2026-10-04: `docs/notes/doors-review-2026-10-04.md` is the table as the
code is, and says where this one was behind or wrong.**

Columns: **P** printer (`ExportIcon` in the title bar), **A** paperclip
(`AttachmentsButton` / `RecordAttachmentsDoor`), **N** notes (`RecordNotesDoor`),
**H** clock (`HistoryButton`). ✅ in the title bar · ◐ present on the page but
not as a door (an `ExportMenu` in the header, a `RecordHistory` or attachments
panel under the document) · ❌ missing · — not applicable. **Print model**: the
export key, or none. **Parties → profile**: what the record names and whether
each is a `ProfileLink` (or an existing `sapLink`). **Status**: `done` (four
doors from draft, print model, every party linked), `owner module` (that
module's agent wires it; the merge check reads this row against the branch),
`profile` (a master record: notes and clock, no printer or paperclip by the
rule), `view` (a read-only rendering of another record's data: printer only).

## Invoice-like and money documents

| Record page | P | A | N | H | Print model | Parties → profile | Owner | Status |
|---|---|---|---|---|---|---|---|---|
| `payables/invoices/[invoiceNo]` — purchase invoice (the model) | ✅ | ✅ | ✅ | ✅ | `purchase_invoice` | supplier: text ❌; import: link ✅ | payables | owner module |
| `sales/ar-invoices/[invoiceNo]` — sales invoice | ✅ | ✅ | ✅ | ✅ | `sales_invoice` | customer: `ProfileLink` ✅; journal, G/L accounts: links ✅ | receivables | done |
| `sales/customer-receipts/[receiptNo]` | ✅ | ✅ | ✅ | ✅ | `customer_receipt` | customer, bank/cash account: `ProfileLink` ✅; invoices, debit notes: links ✅ | receivables | done |
| `sales/sales-returns/[returnNo]` | ✅ | ✅ | ✅ | ✅ | `sales_return` | customer: `ProfileLink` ✅; invoice: link ✅ | receivables | done |
| `sales/credit-notes/[noteNo]` — customer credit / debit note, and the credit memo (REQ-AR-001) | ✅ | ✅ | ✅ | ✅ | `customer_note` | customer: `ProfileLink` ✅; invoice, return, journal: links ✅ | receivables | done |
| `payables/supplier-payments/[paymentNo]` | ◐ | ❌ | ❌ | ◐ | `supplier_payment` | supplier, bank/cash account: text ❌; application: link ✅ | payables | owner module |
| `payables/goods-returns/[returnNo]` — purchase return | ◐ | ❌ | ❌ | ◐ | `purchase_return` | supplier, invoice: text ❌ | payables | owner module |
| `payables/advances/[advanceNo]` — supplier advance | ❌ | ❌ | ❌ | ◐ | none | import, invoice: links ✅; supplier: text ❌ | payables | owner module |
| `payables/payment-applications/[applicationNo]` | ❌ | ◐ | ❌ | ◐ | none | import, PD, loan: links ✅; supplier, bank account: text ❌ | payables | owner module |
| `payables/purchase-orders/[orderNo]` | ❌ | ❌ | ❌ | ❌ | none | supplier: text ❌; import: link ✅ | payables | owner module |
| `payables/goods-receipts/[receiptNo]` | ❌ | ❌ | ❌ | ❌ | none | order: link ✅; supplier, warehouse: text ❌ | payables | owner module |
| `payables/contracts/[contractNo]` — recurring contract | ❌ | ❌ | ❌ | ❌ | none | supplier, department: text ❌ | payables | owner module |
| `payables/[payableNo]` — import application | ✅ | ✅ | ✅ | ✅ | `import_application` | supplier: text ❌; B/L, container, PD, invoice, loan: links ✅ | payables | owner module |
| `treasury/loans/[loanNo]` — bank loan (the party-link model) | ❌ | ✅ | ❌ | ✅ | **none** | bank account: link ✅; bank: text ❌ | payables | owner module |
| `treasury/deposits/[depositNo]` | ❌ | ✅ | ❌ | ✅ | none | journal: link ✅; bank/cash account: text ❌ | payables | owner module |
| `finance/journals/[entryNo]` | ✅ | ✅ | ✅ | ✅ | `journal_entry` | G/L accounts, reversal journal: `ProfileLink` ✅; recurring template: link ✅ | accounting | done |
| `treasury/transfers/[transferNo]` — internal transfer | ✅ | ✅ | ✅ | ✅ | `internal_transfer` | bank/cash accounts, G/L accounts, journals: `ProfileLink` ✅ | accounting | done |
| `treasury/bank-reconciliation/[statementNo]` — statement + reconciliation | ✅ | ✅ | ✅ | ✅ | `bank_reconciliation` | account, G/L account, every journal: `ProfileLink` ✅ | accounting | done |
| `finance/recurring-journals/[templateNo]` | ✅ | ✅ | ✅ | ✅ | `recurring_journal` | G/L accounts, journals raised: `ProfileLink` ✅ | accounting | done |
| `master-data/tax-codes/[code]` | ✅ | ✅ | ✅ | ✅ | `tax_code` | G/L account: `ProfileLink` ✅ | accounting | done |
| `finance/closing` — the period's close (the period is the record) | ✅ | ✅ | ✅ | ✅ | `period_close` | — (checks link their screens) | accounting | done |
| `inventory/opening-stock/[documentNo]` | ✅ | ✅ | ✅ | ✅ | `opening_stock` | warehouse, items: links ✅ | inventory | done (2026-10-04) |
| `inventory/stock-count/[countNo]` — stock count (new) | ✅ | ✅ | ✅ | ✅ | `stock_count` | warehouse, items: links ✅ | inventory | done (2026-10-04) |

## Logistics documents

| Record page | P | A | N | H | Print model | Parties → profile | Owner | Status |
|---|---|---|---|---|---|---|---|---|
| `payables/shipments/[blNo]` — B/L | ✅ | ✅ | ✅ | ✅ | `bill_of_lading` | import, supplier, port, containers, warehouse: `ProfileLink` ✅ | logistics | done (REQ-LOG-001) |
| `payables/containers/[containerNo]` | ✅ | ✅ | ✅ | ✅ | `shipment_container` **(new)**; the receipt prints as `container_receipt` from its field | import, supplier, B/L, warehouse, PD: `ProfileLink` ✅ | logistics | done |
| `payables/pd/[pdNo]` — PD | ✅ | ✅ | ✅ | ✅ | `customs_pd` **(new)** | import, supplier, bank, PDs, applications, B/Ls, containers: `ProfileLink` ✅ | logistics | done |
| `payables/pd/asycuda/[runNo]` — ASYCUDA reading | ✅ | ✅ | ✅ | ✅ | `asycuda_reading` | PDs, imports: `ProfileLink` ✅ | logistics | done |
| `logistics/customs-declarations/[declarationNo]` — customs declaration | ✅ | ✅ | ✅ | ✅ | `customs_declaration` **(new)** | import, supplier, PD: `ProfileLink` ✅ | logistics | done |
| `logistics/ports/[code]` — port (profile) | ✅ | ✅ | ✅ | ✅ | `port` **(new)** | B/Ls, imports, suppliers, containers: `ProfileLink` ✅ | logistics | done |

All six draw printer, paperclip, notes, clock in the rule's order (REQ-LOG-001, 2026-10-04).

## Project System (shared, Phase 2 — done on `feat/shared-module`)

| Record page | P | A | N | H | Print model | Parties → profile | Owner | Status |
|---|---|---|---|---|---|---|---|---|
| `projects/billing/[no]` — progress certificate (client invoice) | ✅ | ✅ | ✅ | ✅ | `project_certificate` | project, customer, journal ✅ | shared | done |
| `projects/budgets/[no]` — budget document | ✅ | ✅ | ✅ | ✅ | `project_budget` | project, change order ✅ | shared | done |
| `projects/change-orders/[no]` — change order | ✅ | ✅ | ✅ | ✅ | `project_change_order` | project, budget document, earlier versions ✅ | shared | done |
| `projects/material-issues/[no]` — material issue / return | ✅ | ✅ | ✅ | ✅ | `project_material_issue` | project, warehouse, items ✅ | shared | done |
| `projects/[code]` — project (profile) | — | — | ✅ | ✅ | — | customer, manager (employee), branch, department ✅; budget documents, change orders: links ✅ | shared | profile |

Attachments on the three documents hang by number, as the certificate's do
(`project_budget`, `project_variation`, `project_material_issue` in
`attachments-runtime.ts`); notes by number through `record-notes` `TARGETS`.

## HR (shared, Phase 2 — done on `feat/shared-module`)

| Record page | P | A | N | H | Print model | Parties → profile | Owner | Status |
|---|---|---|---|---|---|---|---|---|
| `hr/advances/[advanceNo]` — advance or loan | ✅ | ✅ | ✅ | ✅ | `employee_advance` | employee, paying account (bank/cash), journals ✅ | shared | done |
| `hr/leave/[requestNo]` — leave request | ✅ | ✅ | ✅ | ✅ | `leave_request` | employee ✅; manager: text (no employee no. on the row) | shared | done |
| `hr/documents/[documentNo]` — employee document | ✅ | ✅ | ✅ | ✅ | `employee_document` (self-service) | employee, the papers it renews / is renewed by ✅ | shared | done |
| `hr/requests/[requestNo]` — claim, trip, letter, other | ✅ | ✅ | ✅ | ✅ | `employee_request` (self-service; an issued letter prints as the letter, `hr_letter`) | employee, trip, advance, paying account, journal ✅ | shared | done |
| `hr/performance/[reviewNo]` — performance review | ✅ | ✅ | ✅ | ✅ | `performance_review` (self-service) | employee ✅; reviewer: text (a user) | shared | done |
| `hr/recruitment/[vacancyNo]` — vacancy | ✅ | ✅ | ✅ | ✅ | `vacancy` | branch, position, department, people hired ✅; applicants: links ✅ | shared | done |
| `hr/recruitment/applicants/[applicantNo]` — application | ✅ | ✅ | ✅ | ✅ | `applicant` | vacancy, position, employee hired ✅ | shared | done |
| `hr/payroll/[runNo]` — payroll run | ✅ | ✅ | ✅ | ✅ | `payroll_run` | branch, people, departments, paying accounts, journals ✅; payslips: links ✅ | shared | done |
| `hr/payroll/payslips/[payslipNo]` — payslip | ✅ | — | — | — | `payslip` (self-service) | employee, department, run ✅ | shared | view (a line of its run; papers, notes and history are the run's) |
| `hr/employees/[employeeNo]` — employee (profile) | — | — | ✅ | ✅ | — | branch, department, position, manager, user account ✅; hired from: link ✅ | shared | profile |

HR attachments hang by the row's uuid, as the HR pages always filed them
(`leave_request` in `services/leave.ts`; `employee_request`,
`employee_document`, `applicant`, `employee_advance`, `performance_review`,
`vacancy`, `payroll_run` in `attachments-runtime.ts`); notes by number.
The employee link on an HR record is shown only to readers who hold `view` on
`employee` — the person reading their own record has no page to land on.

## Platform and master records (profiles)

| Profile page | Kind (`profileHref`) | Notes | History | Owner | Status |
|---|---|---|---|---|---|
| `master-data/business-partners/[code]` (`/sales/customers/…`, `/payables/suppliers/…`) | `customer`, `supplier` | ❌ | ◐ | receivables / payables | owner module |
| `master-data/banks/[code]` | `bank` | ❌ | ◐ | accounting | owner module |
| `master-data/bank-accounts/[code]`, `master-data/cash-accounts/[code]` | `bank_account`, `cash_account` | ❌ | ◐ (G/L account and bank: `ProfileLink` ✅) | accounting | owner module |
| `master-data/chart-of-accounts/[code]` | `gl_account` | ❌ | ◐ (record framework) | accounting | owner module |
| `master-data/items/[code]` (`/inventory/items/…`) | `item` | ✅ | ✅ | inventory | done (2026-10-04) |
| `master-data/warehouses/[code]` | `warehouse` | ✅ | ✅ | inventory | done (2026-10-04) |
| `hr/employees/[employeeNo]` | `employee` | ✅ | ✅ | shared | profile |
| `projects/[code]` | `project` | ✅ | ✅ | shared | profile |
| `master-data/branches/[code]`, `master-data/departments/[code]`, `master-data/cost-centres/[code]` | `branch`, `department`, `cost_centre` | ❌ | ◐ (`AuditLogButton` + `RecordHistory`) | shared | profile (history only — no record links to a note on them yet) |
| `master-data/payment-terms/[code]`, `master-data/payment-methods/[code]` | `payment_term`, `payment_method` | ❌ | ◐ | shared | profile |
| `hr/positions/[code]`, `hr/departments/[code]` | `position` (`department` resolves to master-data) | ❌ | ◐ | shared | profile |
| `administration/users/[id]`, `administration/roles/[code]` | `user` | ❌ | ◐ | shared | profile (platform settings, not records) |
| `logistics/ports/[code]` | `port` | ✅ | ✅ | logistics | done (four doors) |
| — | `carrier` | | missing — no carrier record exists (a B/L's shipping line is text) | logistics | not delivered |
| — | `currency`, `fixed_asset`, `investment` | | missing — those modules have no delivered screens; nothing to link from yet | shared | not delivered |

## Export keys added on `feat/shared-module`

`project_certificate`, `project_budget`, `project_change_order`,
`project_material_issue` (object `project`); `employee_advance`,
`leave_request`, `employee_document`*, `performance_review`*, `vacancy`,
`applicant`, `employee_request`* (each under its own grant; * self-service, as
`payslip` and `hr_letter` are — the row policy returns the person their own
row and nobody else's). `tests/integration/ops14-print-export.test.ts` lists
`employee_advance` among the keys the accounting officer has no copy of and
`leave_request`, `vacancy`, `applicant` among those the accounting manager has
none of (HR's own).

## What a module agent checks against this table at merge

* Every row of its own in the first two tables reads ✅ ✅ ✅ ✅ with a print
  model and every party a `ProfileLink` — or says why not.
* Its profile pages (customer/supplier, bank, accounts, G/L account, item,
  warehouse) exist at the route `profileHref` answers; a notes door on a
  profile is welcome (`record-notes` already lists `business_partner`, `item`,
  `warehouse`, `bank`, `bank_account`, `chart_of_account`) but not required.
* Logistics fills `port` and `carrier` in `domain/profiles.ts` › `BASES` when
  their pages exist; `tests/unit/profiles.test.ts` then checks the page.
