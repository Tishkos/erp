# REQ-FIX-001 — The sponsor's fixes of 2 October 2026

| | |
|---|---|
| **Requirement ID** | `REQ-FIX-001` |
| **Release** | 1 (after REQ-PM-001 and REQ-HARDEN-001) |
| **Source** | The sponsor's messages of 2026-10-02, 18:06 and 18:14 (Europe/Budapest), and the three answers given the same evening: Nextcloud is reached **with each user's own account**; a new user **is also an employee unless the box is unticked**, existing users backfilled; **a Logistics module holds everything logistics in the whole system**. |
| **Test case(s)** | FX1–FX24, named per stage in §3; each lands with its test. |
| **Status** | Written 2026-10-02. FIX-1 BUILT (`fix/fx1-navigation`), FIX-2 BUILT (`fix/fx2-screens`), FIX-3 BUILT (`fix/fx3-import-invoice`), FIX-4 BUILT (`fix/fx4-uom`), 2026-10-02. The rest are built on their own branches, one by one, in the order of §3. |
| **Approved by** | *The sponsor's direction of 2026-10-02 (the messages above).* |

**How to read this document.** §1 is what the sponsor asked, in his words. §2
is what was found when each was looked at. §3 turns them into stages, each a
branch with numbered criteria. §4 is the decisions taken while writing it,
any of which the sponsor may reverse.

---

# §1 — What was asked

1. `/inventory/availability` — "design ui ux looks shit, doesn't look
   original, doesn't show the tabs".
2. "Invoice status tracking actually works with import allocation — tracks
   it as is it?"
3. "Make unit of measure work — buying a product, you cannot select the type
   of the unit."
4. "Document Center should be updated — we are using Nextcloud
   (files.qs-groups.com); they should be linked, with permission roles when
   creating a folder, and fetch — together nicely."
5. "HR is not yet advanced. When I create a user it should go to HR too, any
   employee there; we add more information in HR." The HR menu should be:
   Dashboard · Employees · Departments · Positions · Attendance · Leave
   Management · Payroll · Advances & Loans · Recruitment · Performance ·
   Employee Requests · Documents · Reports.
6. "Bank loans and the manual bank deposit belong in Accounting → Treasury &
   Banking (Bank Accounts, Cash Accounts, Bank and Cash Reporting); anything
   not related to payables shouldn't be in Payables. Make the dropdown like
   Accounting's General Ledger. ASYCUDA declarations in the navbar, not in
   Payables. Put the Payables order right." Answer to the follow-up: "make a
   Logistics navbar — anything related to logistics in the whole system
   should be there".
7. "The temporary password page is left-aligned; it should be a form in the
   centre."

# §2 — What was found

**1 · Availability.** The page predates the SAP screens: a bare `page__header`
and the generic `DataList`, an *Issue stock* panel with inline styles, no
`AdminPage`, no `SectionTabs`, no register table. Every other inventory
register copies the Purchase Invoices list.

**2 · Import ↔ invoice.** For an IQD import with one invoice posted before
any money is confirmed, the invoice moves posted → part-paid → settled in the
same transaction as the import's *Paid*, and every screen agrees. It stops
following the import in five cases:

* **A deposit is never applied to the invoice.** Confirming a payment before
  any invoice is posted creates a supplier advance (correct); posting the
  invoice afterwards does not settle it, because `supplier-advance.settle`
  is called by no service. The import reads *Fully paid* and can clear while
  its invoice is 30 % outstanding and shows *Unpaid / Overdue*; the
  supplier's account shows the 30 % owed **and** a 30 % unapplied advance.
* **The import's agreed amount is not refreshed from its invoices.**
  `refreshFromInvoices` updates `amount_iqd` only; *Paid*, *Remaining*,
  *Fully paid* and the cap on new applications use `amount_txn`, which is the
  first invoice's lines at creation — no discount, no later edit, no second
  invoice.
* **Foreign-currency imports leave an exchange residual.** The application's
  dinars are taken at the confirmation day's rate, the invoice is fixed in
  dinars, the allocation is capped at what it owes, and no exchange
  difference is booked: a residual stays on the invoice, or the excess sits
  as an unallocated payment.
* **Invoice Status Tracking (`/inventory/in-transit`) still shows migrated
  imports** at their old stage, and its *Advance* can move them apart from
  their containers (D38 says it keeps only non-import shipments).
* The register shows a part-paid invoice as *Unpaid*; there is no part-paid
  state on it.

**2a · The supplier advance could not be mapped (found while building
FIX-3).** The advance posts under `purchasing.supplier_advance_payment`,
`…_settlement` and `…_refund`, none of which the Posting Mappings screen
listed — so Finance could not map them and a deposit confirmed before the
invoice refused to post on any database the tests had not mapped by hand.
They are on the screen now; 0253 copies the supplier-payable line from the
purchase invoice's rule.

**3 · Units of measure.** The tables are right (`item_uom` with a
numerator/denominator fraction, purchase and sales defaults) and the
arithmetic exists (`domain/uom.ts`), but nothing uses either: an item has one
unit (the new-item dialog hard-codes `EA`), there is no screen for its other
units, the purchase lines carry the base unit in a hidden input, and stock is
received in whatever was typed — a carton of 24 received as 1.

**4 · Document Center.** `/documents` is a front-end preview ("these actions
demonstrate the interface and do not save or upload files"). There is no
Nextcloud or WebDAV code anywhere. The attachments subsystem (records' own
files) is real and stays as it is.

**5 · HR.** HR-1 is built (employees, organisation, user link, settings).
Users and employees are linked only by hand, afterwards. Attendance, leave,
payroll and advances are HR-2 to HR-4; recruitment, performance, requests
and documents were out of scope (REQ-HR-001 §13) and are now in by
direction.

**6 · Navigation.** The Payables section carries 29 items, among them the
customs declarations, bills of lading, containers and bank loans. The
Logistics module exists in the shell with twelve planned items and nothing
built. Treasury & Banking has the account masters and the reporting; bank
loans are in Payables and there is no deposit screen.

**6a · Bank and Cash Reporting miscounted (found while building FIX-1).**
It told a transfer between the company's own accounts by
`source_module = 'treasury'` — which every treasury document posts with. So
an other receipt, a loan drawn or repaid, its commission, a cash advance and
a reconciliation adjustment all read as *transfers*, and none of them as
money in or out. It now reads the journal a `bank_transfer` posted
(migration 0252 indexes the link); FX3 holds it.

**7 · Temporary password.** `/password` puts its one panel in the narrow
first column of `profileGrid`; the sign-in page centres its card.

# §3 — Stages

| Stage | Branch | Delivers | Criteria |
|---|---|---|---|
| **FIX-1 — Navigation** | `fix/fx1-navigation` | A **Logistics** module (`logistics` section, ordinal kept): Customs Declarations (PD / ASYCUDA), Bills of Lading, Containers, Invoice Status Tracking, and the Phase 10 logistics items (still planned). **Treasury & Banking** gains Bank Loans and **Bank Deposits** (a register and a new-deposit dialog over the existing treasury services: cash → bank through the bank transfer, any other source through the other receipt), beside Bank Accounts, Cash Accounts and Bank and Cash Reporting. **Payables** keeps payables work in the order a payable lives: Import Applications, Purchase Orders, Goods Receipts, Service Receipts, Recurring Contracts, Purchase Invoices, Payment Applications, Supplier Payments, Supplier Advances, Purchase Returns, Credit Memos, Suppliers, Supplier Statements, Payables Ageing, then the planned items. The routes do not move (bookmarks, links and tests keep working); only the menu, the dropdowns and the section tabs do. | FX1 `fx1-menu` (unit: the three sections hold exactly those items, in that order; no customs, shipment, container or loan item under Payables) · FX2 the dropdown shows Logistics and Treasury & Banking as groups (e2e) · FX3 a bank deposit from a cash account and from another source posts and shows on Bank and Cash Reporting (integration) |
| **FIX-2 — Screens** | `fix/fx2-screens` | Availability rebuilt on the list model (AdminPage → SectionTabs → ListToolbar → register table → paging; issuing stock moves to a dialog); the temporary password form centred like sign-in, with existing classes only — built by drawing `/password` as the sign-in page is (outside the shell: a restricted session has no menu), with sign-in's own classes and password field. | FX4 availability copies the Purchase Invoices list (screenshot pair, theme suite) · FX5 the password panel is centred at desktop and mobile (e2e measures it) |
| **FIX-3 — Import and invoice** | `fix/fx3-import-invoice` | Advances against the import's order applied to its invoice when it posts (Dr supplier payable, Cr supplier advance, in the posting transaction); the import's `amount_txn` refreshed from its posted invoices (discounts and every invoice counted); the exchange difference booked when an import is fully paid in its currency and its invoices still owe or are over-settled in dinars; Invoice Status Tracking without imports, and its Advance refused on one; the register shows *Part paid*. | FX6 deposit → invoice → balance: invoice settled, advance consumed, import cleared, open items and supplier account agree · FX7 two invoices on one import, one discounted: the cap and *Fully paid* follow both · FX8 a USD import paid at two rates: invoice settled, the difference on the exchange account · FX9 in-transit excludes imports and refuses to advance one |
| **FIX-4 — Units of measure** | `fix/fx4-uom` | The item record's Units section (add a unit with *1 X = n base*, purchase and sales defaults, deactivate); the new-item dialog chooses the base unit; every purchase line (purchase invoice, PI lines, goods receipt) offers the item's units, the purchase default first; stock is received in base units at the base unit's cost (`toBaseExact`, refused when it does not divide); a sale stays written in the base unit, and a sales line naming another unit is refused rather than issued as if it were the base (D-FX-8). | FX10 2 boxes of 24 at 24,000 a box: 48 pieces at 1,000 on the FIFO layer, the stock value and the journal; one box returned is 24 pieces out · FX11 a unit the item does not keep is refused with the way to add it; a quantity that does not divide is refused; the base unit stays active (service and trigger); one purchase default; a sale in another unit is refused · FX12 the unit chosen on a draft line is saved, read back and posted in it |
| **FIX-5 — HR structure and the user link** | `fix/fx5-hr-structure` | *Also an employee* on the new-user form, ticked by default: the user and the employee in one transaction, linked; existing active users without an employee backfilled by a migration-time script, dated and audited; the HR menu in the sponsor's order (Dashboard, Employees, Departments, Positions, Attendance, Leave Management, Payroll, Advances & Loans, Recruitment, Performance, Employee Requests, Documents, Reports) with Departments and Positions built as screens. The rest arrive with REQ-HR-001's stages, re-cut: HR-2 attendance and leave, HR-3 payroll, HR-4 advances and loans, HR-5 recruitment and performance, HR-6 requests, documents, dashboard and reports. | FX13 a new user is an employee unless unticked · FX14 the backfill makes one employee per active user and never two · FX15 the HR menu in that order |
| **FIX-6 — Document Center on Nextcloud** | `fix/fx6-nextcloud` | Each user links their own Nextcloud account by Nextcloud's Login Flow v2 (an app password, stored encrypted, revocable from the profile); the Document Center lists, opens, uploads and creates folders through WebDAV *as that user*; a folder created from the ERP is shared through the OCS Share API with the Nextcloud groups mapped to ERP roles (the mapping on a settings screen: role → group, with read / write / share), and a record's folder can be linked to the record. Nothing is copied: Nextcloud stays the store and its permissions stay the truth. | FX16 linking stores an app password and unlinking revokes it · FX17 a folder created from the ERP is shared with the mapped groups at the mapped permission · FX18 the listing is the user's own (a file they cannot see in Nextcloud they cannot see here) — all against a WebDAV/OCS stub in the tests, and on the live host once |
| **FIX-7 — The import's purchase invoice** | `fix/fx7-import-invoice-form` | On a new purchase invoice ticked *Import*, the lines carry no warehouse (the goods have not arrived; they are received container by container); documents attached to the import application are read (xlsx, pdf, docx) and fill a draft purchase invoice, which keeps the attachments (an attachment mark in its header, the attaching in its audit log) through to the CEO's approval, and the accountant is told the draft waits for correction. | FX25 an import invoice's lines refuse a warehouse; FX26 an xlsx/pdf/docx attached to an application becomes a draft invoice with its lines and keeps the files |
| **FIX-8 — Expenses** | `fix/fx8-expenses` | *Service Receipt / Expense Confirmation* becomes **Expenses**, its own tab for expenses and services; *Add expense* leaves Purchase Invoices for it; the Payables tabs are checked screen by screen. | FX27 the Expenses screen raises an expense and a service; Purchase Invoices has no expense button |
| **FIX-9 — The import's workflow** | `fix/fx9-import-workflow` | The import application drawn as its workflow (the stages of REQ-AP-001's workflow PDF as nodes and arrows); each stage assignable to a user, who is notified, accepts the task (*started*), and completes it; a node opened shows who, when, and what was done (the payment applications, the PD, the B/L, the attachments), every step recorded. | FX28 assign → accept → complete moves the node and writes the log; FX29 the node shows the documents of its stage |
| **FIX-10 — Final cost in inventory** | `fix/fx10-final-cost` | The import's final landed cost carried into inventory and shown there: the item's cost per unit after the lock, on the Warehouses Report and the item record, traced to the import. | FX30 after a lock, the inventory value and the unit cost on the screens are the landed cost |
| **HR-2 … HR-6** | one branch each | REQ-HR-001, re-cut as above. | REQ-HR-001's own criteria, plus FX19–FX24 for the new modules (recruitment, performance, requests, documents, dashboard, reports). |

# §4 — Decisions taken while writing this

| # | Decision | Why |
|---|---|---|
| D-FX-1 | The screens keep their routes when they change menu (`/payables/pd` stays `/payables/pd` under Logistics). | Bookmarks, the links between records, the e-mails and WhatsApp messages already sent, and the tests all name the routes; a menu is where a screen is found, not what it is called. The sponsor may ask for new routes; they would arrive with redirects. |
| D-FX-2 | *Bank Deposits* is a register over the existing bank transfer (from a cash account) and other receipt (from any other source), not a new document. | Both already post and reconcile; a third document would be a second way to say the same thing. |
| D-FX-3 | The Nextcloud app password is kept encrypted with the server's key (`ERP_SECRET_KEY`), never shown again, and deleted (and revoked at Nextcloud) on unlink or when the user is deactivated. | It is a credential to the person's files. |
| D-FX-4 | The exchange difference on an import goes to the posting map's realised exchange roles, which Finance maps; until they do, the posting refuses with the role's name. | The same rule as every other new role. |
| D-FX-5 | The confirmation that makes an import fully paid books the difference in a savepoint: unmapped, the payment still confirms, the import says the difference waits, and *Settle exchange difference* on its page books it once mapped. | Refusing a real payment because a gain account is not chosen yet would stop the bank work for a bookkeeping decision. |
| D-FX-6 | Only the deposits of the invoice's own import are applied when it posts. An advance raised by hand against a purchase order stays for the accountant (manual or automatic settlement on the advance, §8.5). | The sponsor's case is the import's deposit; an ordinary order's advance may be meant for a later invoice. |
| D-FX-7 | An import agreed in dinars takes its agreed amount from its posted invoices (FX7); one agreed in another currency keeps its agreed amount, and the dinar difference is the exchange difference (FX8). | The invoices are kept in dinars; only the dinar import can be agreed at them. |
| D-FX-8 | Units are bought in any unit the item keeps and stocked in its base unit; sales stay written in the base unit for now. | The sponsor's fault was in buying. Selling by the box runs through sales orders, delivery notes, pick lists and returns — a stage of its own, not a side effect of this one. |
