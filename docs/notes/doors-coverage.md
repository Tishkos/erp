# Four doors and profile links — coverage (2026-10-04)

The owner's rule: *"Every invoice — notes, attachments, audit, print — after the
draft is created. Like Bank Loans: we can click the bank or the customer; the
parts have profiles."* AGENTS.md › *Every record wears the same four doors* and
› *Shared doors and profiles* say how. This page is where every record page
stands, surveyed on `feat/shared-module` from `main` 81a5ede plus the shared
work. Module branches change their own rows; re-survey after merging.

Columns: **P** printer (`ExportIcon` in the title bar), **A** paperclip
(`AttachmentsButton`), **N** notes (`RecordNotesDoor` / `NotesButton`), **H**
clock (`HistoryButton`). ✅ in the title bar · ◐ present on the page but not as
a door (an `ExportMenu` in the header, a `RecordHistory` or attachments panel
under the document) · ❌ missing. **Print model**: the export key, or none.
**Parties**: what the record names, and whether it links to the profile
(`ProfileLink` / an existing `sapLink`).

## Invoice-like and money documents

| Record page | P | A | N | H | Print model | Parties → profile | Owner |
|---|---|---|---|---|---|---|---|
| `payables/invoices/[invoiceNo]` — purchase invoice (the model) | ✅ | ✅ | ✅ | ✅ | `purchase_invoice` | supplier code/name: text ❌; import: link ✅ | payables |
| `sales/ar-invoices/[invoiceNo]` — sales invoice | ◐ | ❌ | ❌ | ◐ | `sales_invoice` | customer: text ❌; journal, G/L accounts: links ✅ | receivables |
| `sales/customer-receipts/[receiptNo]` | ◐ | ❌ | ❌ | ◐ | `customer_receipt` | customer, bank/cash account: text ❌ | receivables |
| `sales/sales-returns/[returnNo]` | ◐ | ❌ | ❌ | ◐ | `sales_return` | customer, invoice: text ❌ | receivables |
| `payables/supplier-payments/[paymentNo]` | ◐ | ❌ | ❌ | ◐ | `supplier_payment` | supplier, bank/cash account: text ❌; application: link ✅ | payables |
| `payables/goods-returns/[returnNo]` — purchase return | ◐ | ❌ | ❌ | ◐ | `purchase_return` | supplier, invoice: text ❌ | payables |
| `payables/advances/[advanceNo]` — supplier advance | ❌ | ❌ | ❌ | ◐ | none | import, invoice: links ✅; supplier: text ❌ | payables |
| `payables/payment-applications/[applicationNo]` | ❌ | ◐ | ❌ | ◐ | none | import, PD, loan: links ✅; supplier, bank account: text ❌ | payables |
| `payables/purchase-orders/[orderNo]` | ❌ | ❌ | ❌ | ❌ | none | supplier: text ❌; import: link ✅ | payables |
| `payables/goods-receipts/[receiptNo]` | ❌ | ❌ | ❌ | ❌ | none | order: link ✅; supplier, warehouse: text ❌ | payables |
| `payables/contracts/[contractNo]` — recurring contract | ❌ | ❌ | ❌ | ❌ | none | supplier, department: text ❌ | payables |
| `payables/[payableNo]` — import application | ✅ | ✅ | ✅ | ✅ | `import_application` | supplier: text ❌; B/L, container, PD, invoice, loan: links ✅ | payables |
| `treasury/loans/[loanNo]` — bank loan (the party-link model) | ❌ | ✅ | ❌ | ✅ | **none** | bank account: link ✅; bank: text ❌ | payables |
| `treasury/deposits/[depositNo]` | ❌ | ✅ | ❌ | ✅ | none | journal: link ✅; bank/cash account: text ❌ | payables |
| `finance/journals/[entryNo]` | ◐ | ✅ | ❌ | ◐ (own audit page) | `journal_entry` | G/L accounts: text ❌ | accounting |
| `inventory/opening-stock/[documentNo]` (record framework) | ◐ | ❌ | ❌ | ◐ | `opening_stock` | warehouse, items: text ❌ | inventory |
| `projects/billing/[no]` — **progress certificate (client invoice)** | ✅ | ✅ | ✅ | ✅ | `project_certificate` **(new)** | project, customer, journal: `ProfileLink` ✅ | **shared — done** |

## Logistics documents

| Record page | P | A | N | H | Print model | Parties → profile | Owner |
|---|---|---|---|---|---|---|---|
| `payables/shipments/[blNo]` — B/L | ✅ | ✅ | ❌ | ✅ | `bill_of_lading` | import, containers: links ✅; supplier, port: text ❌ | logistics |
| `payables/containers/[containerNo]` | ❌ | ✅ | ❌ | ✅ | none | import, B/L: links ✅; supplier, warehouse: text ❌ | logistics |
| `payables/pd/[pdNo]` — PD | ❌ | ✅ | ◐ (box + `last_note`) | ✅ | none | import, applications: links ✅; supplier, bank: text ❌ | logistics |
| `payables/pd/asycuda/[runNo]` — ASYCUDA reading | ✅ | ✅ | ❌ | ✅ | `asycuda_reading` | PDs: links ✅ | logistics |

The B/L, the PD, the container and the ASYCUDA reading draw the clock before
the printer; the rule's order is printer, paperclip, notes, clock.

## Project System (no module agent — shared, Phase 2)

| Record page | P | A | N | H | Print model | Parties → profile |
|---|---|---|---|---|---|---|
| `projects/billing/[no]` — progress certificate | ✅ | ✅ | ✅ | ✅ | `project_certificate` | project, customer, journal ✅ |
| `projects/material-issues/[no]` | ❌ | ❌ | ❌ | ◐ | none | project ✅; warehouse, items: text ❌ |
| `projects/budgets/[no]` | ❌ | ❌ | ❌ | ◐ | none | project ✅ |
| `projects/change-orders/[no]` | ❌ | ❌ | ❌ | ◐ | none | project, budget ✅ |
| `projects/[code]` — project (profile) | ❌ | ❌ | ❌ | ◐ | none | customer, manager, department: text ❌ |

## HR (no module agent — shared, Phase 2)

| Record page | P | A | N | H | Print model | Parties → profile |
|---|---|---|---|---|---|---|
| `hr/payroll/[runNo]` | ◐ | ❌ | ❌ | ◐ | `payroll_run` | journal, employees ✅ |
| `hr/payroll/payslips/[payslipNo]` | ◐ | ❌ | ❌ | ❌ | `payslip` | employee ✅; bank account: text |
| `hr/advances/[advanceNo]` | ❌ | ❌ | ❌ | ◐ | none | employee, journal ✅ |
| `hr/requests/[requestNo]` | ◐ | ◐ | ❌ | ◐ | `hr_letter` | employee ✅ |
| `hr/leave/[requestNo]` | ❌ | ◐ | ❌ | ◐ | none | employee ✅ |
| `hr/documents/[documentNo]` | ❌ | ◐ | ❌ | ◐ | none | employee ✅ |
| `hr/performance/[reviewNo]` | ❌ | ❌ | ❌ | ◐ | none | employee ✅ |
| `hr/recruitment/[vacancyNo]`, `…/applicants/[applicantNo]` | ❌ | ❌ / ◐ | ❌ | ◐ | none | department, position ✅ |
| `hr/employees/[employeeNo]` — employee (profile) | ❌ | ❌ | ❌ | ◐ | none | department, position, manager ✅ |

## Profiles (master records)

These are the pages `profileHref` sends a reader to. They are profiles, not
transactions: the rule's four doors are for records; a profile shows its own
history (◐) and, where it has one, its statement.

| Profile page | Kind (`profileHref`) | History | Owner |
|---|---|---|---|
| `master-data/business-partners/[code]` (`/sales/customers/…`, `/payables/suppliers/…`) | `customer`, `supplier` | ◐ | receivables / payables |
| `master-data/banks/[code]` | `bank` | ◐ | accounting |
| `master-data/bank-accounts/[code]`, `master-data/cash-accounts/[code]` | `bank_account`, `cash_account` | ◐ | accounting |
| `master-data/chart-of-accounts/[code]` | `gl_account` | ◐ (record framework) | accounting |
| `master-data/items/[code]` (`/inventory/items/…`) | `item` | ◐ | inventory |
| `master-data/warehouses/[code]` | `warehouse` | ◐ | inventory |
| `hr/employees/[employeeNo]` | `employee` | ◐ | shared |
| `projects/[code]` | `project` | ◐ | shared |
| — | `port`, `carrier` | missing — **logistics builds it** | logistics |
| — | `currency`, `fixed_asset`, `investment` | missing — those modules have no delivered screens; nothing to link from yet | shared |

## What changed on `feat/shared-module`

* The progress certificate — the Project System's client invoice (REQ-PM-001
  PM-5, D-PM-11) — wears all four doors from its draft, has a print model, and
  links its project, customer and journal.
* The other Project System and HR documents are listed above as they stand.
  They are not invoices; the four doors on them follow the certificate's
  wiring (see AGENTS.md) when their owners take them on.
* Rows owned by accounting, payables, receivables, logistics and inventory
  were not touched here; each module agent wires its own with
  `RecordNotesDoor` and `ProfileLink`.
