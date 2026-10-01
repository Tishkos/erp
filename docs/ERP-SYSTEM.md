# The Qimah Al-Safinah ERP — what it is and what every screen does

A working guide to the system as it stands. Written for someone who needs to
know what the application can do today, screen by screen, and what is still
ahead of it.

**Status key used throughout:**

| | meaning |
|---|---|
| **Built** | The screen exists, reads and writes the real database, and is reachable from the menu. |
| **Engine only** | The accounting and the rules are built and tested; no screen is exposed yet. The work behind it is real. |
| **Planned** | Named in the approved navigation tree, scheduled for a later phase. Nothing behind it yet. |

---

## 1. What this system is

A double-entry ERP for a trading and services company operating in Iraq, in
Iraqi dinars with a US dollar reading alongside. It covers the money and the
goods: purchasing, sales, stock, the general ledger, receivables, payables,
treasury, and the controls that keep them agreeing with one another.

It is bilingual — English and Arabic, with the whole interface mirroring to
right-to-left — and every screen is permission-gated, branch-scoped and
audited.

### The five rules that explain every screen

Almost every design decision in the application follows from these. Knowing
them makes the rest of this document predictable.

**1. The ledger is the only truth about money.**
No screen keeps its own running total. The Account Statement, the ageing
reports, the dashboard and the trial balance all read the same posted journal
lines and the subledger written beside them. When two screens could disagree,
the system shows both figures and names the difference rather than letting one
quietly win.

**2. A document posts through the posting engine, never directly.**
No module writes a journal line itself. Each document says *what kind of line*
it needs — "the customer's receivable", "the revenue", "the bank" — and the
posting engine resolves that to an account through the Posting Mappings screen.
A line that names a subledger (a customer's or supplier's balance) is
constrained to that subledger's control account, so a receipt cannot post
somewhere that leaves the customer's statement untouched.

**3. A posted document is never edited.**
It is reversed, or returned against, and the correction is a new document. The
original stays in the books. Status moves through one common vocabulary —
draft, submitted, approved, posted, settled, reversed, cancelled — and the
transitions are enforced in one place for every document type.

**4. Stock has one ledger.**
`inventory_movement` is the only source of a quantity. Availability, the Stock
Ledger, the Warehouses Report and every document that moves goods all sum the
same rows, written in the same transaction as the document that caused them.

**5. Nothing is hidden by the menu alone.**
Hiding a menu item a user cannot use is a courtesy. The control is the
server-side permission check on every request, so typing the URL gets the same
refusal.

### How it is built

- **Next.js 16 (App Router), React 19** — server components and server actions;
  there is no separate API the browser calls.
- **PostgreSQL + Drizzle ORM**, with **row-level security** enforced per
  request. The application connects as a non-owner role, so a query that
  forgets its scope returns nothing rather than everything.
- **Branch and department scoping** on every transaction, set per request.
- **Append-only audit** of who did what, when, and whether it succeeded.
- Deployed as a standalone Node build behind nginx; a **Windows desktop build**
  (Tauri) wraps the same application.

---

## 2. Home

| Screen | Route | Status |
|---|---|---|
| **My Dashboard** | `/` | **Built** |
| **My Approvals** | `/approvals` | **Built** |
| My Tasks | `/tasks` | Planned |
| Notifications | `/notifications` | Engine only |
| Recent Records | `/recent` | Planned |
| Global Search | `/search` | Engine only |

### My Dashboard — `/`

What the person signing in needs to see first, assembled from the live ledger
and filtered to what their role may know. Every band is permission-gated, so a
warehouse clerk and a CEO open the same URL and see different pages.

- **Waiting on me** — documents queued for this person's approval, and unread
  notifications.
- **Result** — income, expenses and the result for the year to date, taken from
  the Income Statement's own figures so the two cannot disagree.
- **Cash and bank** — every account's balance.
- **Owed to us / Owed by us** — total outstanding and the ageing bands. These
  include debts raised by journal with no invoice behind them, so the band
  agrees with the Receivables and Payables Ageing screens it links to.
- **How the business is doing** — income and expenses month by month, ageing
  bars, cash and bank balances, biggest customers, stock held by warehouse.

### My Approvals — `/approvals`

Documents waiting for this person's decision, then a record of what they
submitted and what they decided. Approving and executing the same document is
refused — the segregation is enforced in the database, not only in the screen.

### Notifications — *engine only*

The rules, the raising and the delivery are built: notification rules are rows
naming an event, a recipient role and a channel; documents raise events; the
in-app inbox reads them, and there is a daily sweep for invoices falling due,
due today and overdue, on both the sales and purchasing sides. The dedicated
screen is not exposed yet; notifications surface in the header and on the
dashboard.

---

## 3. Sales

| Screen | Route | Status |
|---|---|---|
| **Customers** | `/master-data/customers` | **Built** |
| **Customer Statements** | `/sales/customer-statements` | **Built** |
| **Sales Invoices** | `/sales/ar-invoices` | **Built** |
| **Receivables Ageing** | `/sales/receivables` | **Built** |
| **Customer Receipts** | `/sales/customer-receipts` | **Built** |
| **Sales Returns** | `/sales/sales-returns` | **Built** |
| Sales Orders | — | Engine only |
| Reservations | — | Engine only |
| Pick Lists | — | Engine only |
| Delivery Notes | — | Engine only |
| Cash Sales | — | Engine only |
| Customer Credit Memos | — | Engine only |
| Warranty Inquiry | — | Engine only |
| Sales Dashboard, Price Lists, Credit Control, Reports, Settings | — | Planned |

### Customers — `/master-data/customers`

One record per company, whatever else they are to you — a company that both
buys and sells is a single partner holding both roles, not two records. Carries
the legal and trade name, contact details, the payment terms their invoices
inherit, and a credit limit. A partner is deactivated, never deleted.

### Customer Statements — `/sales/customer-statements`

What a customer owes, as a statement: sales are Debit, receipts and credits are
Credit, with a running balance that ends at what is still outstanding. Choose
the customer, the period and the currency (IQD or USD — the same posted lines,
read at the rate each carried when it posted).

Underneath the movements sits **What is still owed** — the open invoices with
their due dates, what has been paid against each, and how late the remainder
is, with the ageing bands in the footer. A balance raised by journal with no
invoice behind it appears as its own row, so this panel's total is the
statement's closing balance rather than a different number sitting under it.

With no customer chosen it lists every customer's position, so "who owes us
money" is answerable without picking a name first. A **Show** filter narrows to
all, falling due soon, overdue, not yet paid, or part paid. The printed copy
carries the same rows, the same ageing bands and the same total.

### Sales Invoices — `/sales/ar-invoices`

What the company has billed. An invoice is raised from a delivery note or
directly, approved, then posted — debiting the customer's receivable and
crediting revenue. The lines name items, quantities, prices, discounts and the
warehouse the goods leave.

The record shows the invoice, its lines, the **revenue accounts actually
recorded on the journal** (with whether each came from the item's own
configuration or the general mapping — later setup changes never rewrite posted
history), and a **Settlement** panel: payment terms, due date, paid, outstanding,
last payment, and status against terms.

A posted invoice is corrected by **reversal**, not editing: the journal is
mirrored, every stock movement is put back onto its own FIFO layers, and the
status becomes reversed with a stated reason. Refused while a payment, return,
credit memo or payment run rests on it.

### Receivables Ageing — `/sales/receivables`

Every customer invoice, with the terms that set its due date, what has been
paid, what is left, and how late that remainder is — bucketed into not yet due,
1–30, 31–60, 61–90 and over 90 days, counted from the **due date**, not the
invoice date.

Type a customer's name or code to narrow to one account; leave it empty for
everybody. A name that matches nobody narrows to nothing and says so rather
than quietly reporting the whole ledger.

The report reconciles to the ledger and shows its working: **what the ledger
says**, **what the invoices account for**, and **what no invoice accounts
for** — the last being an opening balance, a write-off or a correction posted
by journal, which appears as its own row with the same raised / paid / left
columns. The total is the customer statement's closing balance by construction.

Settled invoices stay on the list by default, because "how late was it when it
was finally paid" is a question about invoices that *have* been paid.

### Customer Receipts — `/sales/customer-receipts`

Money received from customers. A receipt names the payer, the bank or cash
account it landed in, the date, the amount and a bank reference. Posting debits
that account and credits the customer's receivable — or a clearing account when
the payer is not yet known, so unidentified money is fully recorded and visibly
unresolved.

Once posted, the receipt is **allocated** to invoices. **Apply oldest first**
settles them in order in one action: a customer with a 50,000 invoice from
Monday and a 100,000 from Tuesday who pays 50,000 has paid Monday's; pay
100,000 and Monday is settled and Tuesday is part paid. The per-invoice boxes
are pre-filled with each invoice's share under that rule, and a clerk can still
override them when the customer says which invoice they meant.

### Sales Returns — `/sales/sales-returns`

Goods a customer has sent back. The stock comes in, the credit goes to the
customer. Distinct from a reversal: a return is for goods that come back, a
reversal is for an invoice that should not have been posted.

### Engine only, on the sales side

Sales orders, stock reservations, pick lists, delivery notes, cash sales,
customer credit memos and warranty registration are built, posted and tested —
the order-to-delivery-to-invoice chain works end to end, including availability
checks, price-list enforcement and reservations. They have no screens yet.

---

## 4. Purchasing

| Screen | Route | Status |
|---|---|---|
| **Suppliers** | `/master-data/suppliers` | **Built** |
| **Supplier Statements** | `/purchasing/supplier-statements` | **Built** |
| **Purchase Invoices** | `/purchasing/ap-invoices` | **Built** |
| **Payables Ageing** | `/purchasing/payables` | **Built** |
| **Supplier Payments** | `/purchasing/supplier-payments` | **Built** |
| **Purchase Returns** | `/purchasing/goods-returns` | **Built** |
| Purchase Orders | — | Engine only |
| Goods Receipts | — | Engine only |
| Service Receipts | — | Engine only |
| Supplier Advances | — | Engine only |
| Supplier Credit Memos | — | Engine only |
| Match Exceptions | — | Engine only |
| Procurement Dashboard, Reports, Settings | — | Planned |

Purchasing mirrors Sales throughout — the same screens in a mirror, written
once and pointed at either side, so the two cannot drift into disagreeing about
what "overdue" means.

### Suppliers — `/master-data/suppliers`

Who the company buys from. Same record as a customer, holding the supplier
role: legal name, contacts, payment terms, bank details for payment, and a
blocked flag that stops payment runs from selecting them.

### Supplier Statements — `/purchasing/supplier-statements`

The mirror of the customer statement: purchases are Credit, payments and
credits are Debit, and the balance ends positive when the company owes money.
Carries the same **What is still owed** panel and the same reconciliation to
the ledger.

### Purchase Invoices — `/purchasing/ap-invoices`

What the company has been billed. Raised against a purchase order and its goods
receipt, or directly — in which case a stated justification and a separate
approval are required, enforced by the database. Posting credits the supplier's
payable and debits either goods-received-not-invoiced or the expense.

Carries a **match status** of its own, separate from the document status: three-way
matching of order, receipt and invoice, with tolerances, and exceptions that
must be resolved or accepted.

### Payables Ageing — `/purchasing/payables`

What the company owes, invoice by invoice, aged from the due date, with the
same supplier filter, the same ledger reconciliation and the same journal-raised
rows as the receivables side.

### Supplier Payments — `/purchasing/supplier-payments`

Money paid out. Names the supplier, the account it leaves, the date and the
amount. **Pay oldest first** applies the payment across the supplier's open
invoices in order, in one action; the per-invoice boxes carry each invoice's
share. A payment already allocated to an invoice will not be allocated to it
twice — the remainder moves to the next invoice down.

### Purchase Returns — `/purchasing/goods-returns`

Goods sent back to a supplier: the stock goes out, the debit goes to the
supplier.

---

## 5. Inventory and Warehouses

| Screen | Route | Status |
|---|---|---|
| **Availability** | `/inventory/availability` | **Built** |
| **Opening Stock** | `/inventory/opening-stock` | **Built** |
| **Stock Movement** | `/inventory/stock-movements` | **Built** |
| **Stock Ledger** | `/inventory/stock-ledger` | **Built** |
| **Transfer** | `/inventory/transfers` | **Built** |
| **Item Reconciliation** | `/inventory/stock-reconciliation` | **Built** |
| **Warehouses Report** | `/inventory/fifo-valuation` | **Built** |
| **Invoice Status Tracking** | `/inventory/in-transit` | **Built** |
| **Items** | `/master-data/items` | **Built** |
| **Units of Measure** | `/master-data/uom` | **Built** |
| Quarantine, Returns, Damaged Goods, Serial/Batch Tracking, Reports, Settings | — | Planned |

### Availability — `/inventory/availability`

What can actually be sold: stock on hand less what is reserved, by item and
warehouse.

### Stock Movement — `/inventory/stock-movements`

Every movement of stock, In or Out, with the document that caused it. The one
place to answer "where did this quantity come from".

### Stock Ledger — `/inventory/stock-ledger`

One item, warehouse by warehouse: opening balance, every movement in order, and
the closing balance, with a running total down the page. Printable.

### Transfer — `/inventory/transfers`

Items moved from one warehouse to another. Each form carries a one-time id, so
a resubmitted page answers with the document already created rather than moving
the stock twice.

### Item Reconciliation — `/inventory/stock-reconciliation`

Brings the system's quantity to what is actually on the shelf. In adds stock
that was found; Out removes stock that is missing. Posts the difference to the
inventory adjustment account.

### Opening Stock — `/inventory/opening-stock`

The stock the company starts with, and what it is opened against.

### Warehouses Report — `/inventory/fifo-valuation`

Every warehouse's holding by item, with quantity from the movement ledger and
**Total Price at FIFO cost** — a value in dinars, not a selling price. 507 units
bought as 10 at 50 and 500 at 500, less 3 sold, is 250,350 IQD.

### Invoice Status Tracking — `/inventory/in-transit`

Goods bought abroad, between the invoice and the shelf: which shipment stage
each consignment has reached, who moved it there and when.

### Items — `/master-data/items`

The one item record Purchasing, Inventory and Sales all use: code, name, stock
or service, base unit, tracking (none, batch or serial), and the revenue and
inventory accounts its postings use.

### Units of Measure — `/master-data/uom`

The units items state their quantities in, with conversions.

---

## 6. Finance — General Ledger

| Screen | Route | Status |
|---|---|---|
| **Journal Entry** | `/finance/journals` | **Built** |
| **Reversals** | `/finance/reversals` | **Built** |
| **G/L Inquiry** | `/finance/gl-inquiry` | **Built** |
| **Trial Balance** | `/finance/trial-balance` | **Built** |
| **Accounting Periods** | `/finance/periods` | **Built** |
| **Posting Mappings** | `/finance/posting-mappings` | **Built** |
| **Income Statement** | `/finance/income-statement` | **Built** |
| **Balance Sheet** | `/finance/balance-sheet` | **Built** |
| **Changes in Equity** | `/finance/changes-in-equity` | **Built** |
| **Cash Flow Statement** | `/finance/cash-flow` | **Built** |
| Recurring Journals, Year-End Close | — | Planned |

### Journal Entry — `/finance/journals`

Entries raised by hand, and where each one has got to. Journals belong to the
Finance department — the system reads who is in Finance from the department
assignments rather than from a role name. A journal is drafted, lines are added
with their accounts and dimensions, then submitted and approved; it must
balance, the period must be open, and dimensions required by an account must be
supplied.

Manual posting to a control account is restricted: the subledger is the
document modules' to write.

### Reversals — `/finance/reversals`

Every correction made to the books, and why. A reversal mirrors the original
journal and its subledger movements in the same transaction, so a reversed
invoice leaves both the document layer and the ledger at once.

### G/L Inquiry — `/finance/gl-inquiry`

Any account, any period: the opening balance, every line that hit it, and the
closing balance, drilling through to the document behind each line.

### Trial Balance — `/finance/trial-balance`

Every account's debit and credit for a period, proving the books balance, at any
level of the account hierarchy.

### Accounting Periods — `/finance/periods`

The months the books are open for. A posting into a closed period is refused —
which is why a reversal is dated the day it is made and needs the current period
open.

### Posting Mappings — `/finance/posting-mappings`

Which account each document posts to. The posting engine never chooses one on
its own: each document event and line role — "sales invoice / customer
receivable", "supplier payment / supplier payable" — is mapped here, optionally
narrowed by item group, partner group, warehouse, project or branch.

A line that names a subledger must be mapped to that subledger's control
account; the screen refuses anything else. Without that constraint a receipt
can post a balanced journal that never reaches the customer's statement.

### The four financial statements

Each is its own screen — one report to a window, so a reader is never shown two
answers to one question. All four read the same posted lines through the
**Statement Mapping** screen, which decides which accounts roll into which
printed line. Each can be read in IQD or USD, at any level of detail, and
exported.

---

## 7. Treasury and Banking

| Screen | Route | Status |
|---|---|---|
| **Bank Accounts** | `/master-data/bank-accounts` | **Built** |
| **Cash Accounts** | `/master-data/cash-accounts` | **Built** |
| **Bank and Cash Reporting** | `/treasury/reporting` | **Built** |
| Receipts, Payments, Bank Transfers, Bank Statements, Reconciliation, Daily Position, Cash Forecast | — | Engine only |

### Bank Accounts / Cash Accounts

The company's bank accounts and cash floats, each carried in a named G/L
account. A bank account has a bank, number, IBAN, SWIFT and statement format; a
cash account has a custodian answerable for it at a count, and a float ceiling.
Both carry an approval limit — the ceiling a payment from that account may
reach. Accounts are company-wide; the transactions carry the branch.

Each record shows **what the account holds**: the balance now, what it has
received and paid out this year, transfers in and out between the company's own
accounts, and when it last moved — read from the ledger, so it agrees with Bank
and Cash Reporting exactly.

### Bank and Cash Reporting — `/treasury/reporting`

Every bank and cash account over a period: opening balance, money in, money
out, transfers in and out (the company's own money moving between its own
accounts, kept separate from real receipts and payments), closing balance and
last movement. Pick one account — typed by name — and the transactions behind
its balance are listed with the document, the customer or supplier, who raised
it, who approved it, and a running balance. The closing balance *is* the G/L
balance; it is not computed a second way.

---

## 8. Master Data

| Screen | Route | Status |
|---|---|---|
| **Chart of Accounts** | `/master-data/chart-of-accounts` | **Built** |
| **Statement Mapping** | `/master-data/statement-mapping` | **Built** |
| **Currencies and Rates** | `/master-data/exchange-rates` | **Built** |
| **Branches** | `/master-data/branches` | **Built** |
| **Departments** | `/master-data/departments` | **Built** |
| **Cost Centres** | `/master-data/cost-centres` | **Built** |
| **Warehouses** | `/master-data/warehouses` | **Built** |
| **Payment Terms** | `/master-data/payment-terms` | **Built** |
| **Payment Methods** | `/master-data/payment-methods` | **Built** |
| Banks, Price Lists, Supplier Item Codes, Barcodes | — | Planned |

Master Data keeps the reference data no single module owns. Customers, suppliers,
items and units live under the module whose work they are.

### Chart of Accounts

The account tree: code, name, type, currency restriction, whether it is a group
or posts, and whether it is a **control account** for customers, suppliers,
bank or stock. Accounts are created, submitted and approved — the chart is
itself a controlled document. An account can require dimensions, and a posting
that omits one is refused.

### Statement Mapping

Which accounts roll into which line of each financial statement.

### Currencies and Rates

The rates every posting is measured at, effective from a date. The ledger is
kept in IQD; USD is a way of reading it at the historical rate each line
carried.

### Branches / Departments

Every user and every transaction belongs to a branch; a branch is deactivated,
never deleted. Departments route approvals — a document goes to the manager of
the department it was raised in.

### Cost Centres

Where cost is gathered, independently of who reports to whom.

### Warehouses

Where stock is held, each belonging to a branch. Stock movements must carry the
warehouse's own branch — enforced by database trigger as well as in code.

### Payment Terms

When an invoice falls due, and what an early settlement is worth. A sales
invoice records the terms it was raised on, so an old invoice keeps saying
"Net 7" after the customer moves to Net 30 — which is what makes its due date
defensible.

### Payment Methods

How money is received and paid — cash, transfer, cheque.

---

## 9. Administration

| Screen | Route | Status |
|---|---|---|
| **Company** | `/administration/company` | **Built** |
| **Users** | `/administration/users` | **Built** |
| **Department Managers** | `/administration/managers` | **Built** |
| **Roles** | `/administration/roles` | **Built** |
| **Permissions** | `/administration/permissions` | **Built** |
| **Numbering** | `/administration/numbering` | **Built** |
| **Audit Trail** | `/administration/audit` | **Built** |
| System Parameters, Background Jobs, Backup Health | — | Engine only |

### Company

The legal entity every module works for. One company; saved here, read
everywhere — including on every printed document.

### Users

Each employee has an individual account, scoped to the branches and departments
they work in, holding one or more roles. Password resets issue a temporary
password and sign the person out everywhere.

### Department Managers

Who finalises what. A manager approves documents raised in their own department
without needing a second approval.

### Roles and Permissions

A role is a named set of permissions; people hold roles, roles hold grants. The
Permissions screen is a grid: choose a role, then tick what it may see and do in
every section. What is not ticked is hidden from the navigation **and refused by
URL**.

### Numbering

Every document takes its number from a series — prefix, branch, year, width.
Numbers are never reused; gaps are kept, not filled.

### Audit Trail

Who did what, when, to which record, whether it succeeded, and what changed.
Append-only; nothing here can be edited, including by an administrator.

---

## 10. Documents

### Document Centre — `/documents` — **Built**

Every file attached to any record, in one place, with the document it belongs
to, who uploaded it and when. Attachments are stored outside the application
directory so a deployment never touches them.

---

## 11. Capabilities that run across every screen

### Print and export

Every document and report can be exported as **PDF, Excel or Word**, in English
or Arabic. The export is built from the same figures the screen shows, not a
second query — a printed statement and the screen it came from cannot state
different totals. Printed documents carry the company header, the document
number, its status and the filters it was run with.

### Approvals and segregation of duties

Documents move through configured workflows. The same person cannot approve and
execute, nor create and execute, a high-risk batch — enforced by database
constraint, not only by the screen.

### Notifications

Rules are rows naming an event, a recipient role and a channel. Documents raise
events as they post; a daily sweep raises what falls due within the week, what
falls due today and what is overdue, on both sides, and announces an invoice
settled after its due date — the record a credit controller cannot get from a
list of what is *currently* overdue.

### Appearance

Eighteen colour palettes, seven of them dark, with an accent colour — set
personally or company-wide. Every combination is checked for readable contrast,
including status chips, selection and focus.

### Search

A global search reaches records and screens from anywhere, with a keyboard
shortcut.

### Imports

Spreadsheet imports with per-row validation and a reviewable result, for
loading master data.

### Desktop application

A Tauri shell packages the same application as a Windows executable with an
installer. It is a thin client — the ERP itself does not move.

---

## 12. Where the system stands

**Live and in use:** the accounting core, master data, the purchase and sales
invoice cycles with their returns, payments and receipts, stock movement and
valuation, the four financial statements, treasury reporting, both account
statements, both ageing reports, and the whole administration and permission
layer.

**Built but not yet on screen:** the order-to-delivery chain on both sides
(purchase orders, goods receipts, service receipts, sales orders, reservations,
pick lists, delivery notes), cash sales, credit memos, advances, three-way match
exceptions, bank reconciliation, cash forecasting, payment runs, and the
notification inbox. These are posted and tested; they need screens.

**Planned by phase:** CRM, Projects and Contracting, Logistics, Money Transfer,
Investments, Fixed Assets, Budgeting, HR and Payroll, Reports and Analytics, and
the integration and support tooling.

### Known gaps worth naming

- **A purchase invoice does not store the payment terms it was raised on**, only
  its due date. Move a supplier to different terms and an old invoice describes
  itself with the new ones. The due date is stored and stays correct; only the
  label is wrong.
- **Four menu entries point at routes that have not moved yet.** The navigation
  tree now files Customers under Sales, Suppliers under Purchasing, and Items
  and Units of Measure under Inventory, but the pages still live under
  `/master-data/…`. This is work in progress; the routes in this document are
  the ones that currently answer.
- **The full integration suite cannot run on the current development machine**
  (7.3 GB RAM). It is run in chunks instead.

---

*This document describes the application as built. The navigation tree it
follows is the approved one; grouping has been refined for usability without
removing any required function, changing any permission, or altering posting
behaviour.*
