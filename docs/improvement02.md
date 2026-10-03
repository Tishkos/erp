# IMPROVEMENT-002 — One ERP, not a set of pages

| | |
|---|---|
| **Status** | IN BUILD — written 2026-10-03 from the sponsor's direction (two messages, 02:57 and 03:09). The audit below was run on main at 37f21c7 plus HR-6. Each stage is its own branch and PR, merged into main once its tests pass. |
| **Sponsor's rules for this work** | Keep the current design. Screens copy their models, use only existing classes, and are verified by theme readability and side-by-side screenshots. The one exception is the spacing between stacked blocks, which the sponsor asked for (IM2-8). **Keep the Import Application and the navbar as the sponsor left them**: whatever was removed or simplified there stays removed; only verified bugs are fixed. Business data comes from the database, never from the code. Everything is tested before it is merged. |
| **Appendix A** | The sponsor's audit brief of 03:09, kept word for word. It is the acceptance standard for IM2-2 to IM2-4. |

---

## 1. What the sponsor asked

From the 02:57 message, in the sponsor's order:

1. Finish HR-6, test it, and merge everything into main.
2. Run the full suites (unit, integration, end-to-end) and keep them green.
3. Merge the work other cloud sessions push, and test it.
4. Test every screen and every calculation. Make everything dynamic and connected like a real ERP.
5. Connect the **Document Center** to Nextcloud at `files.qs-groups.com`.
6. Add a **Monitoring** module to the navbar. Pressing it shows a "coming soon" screen.
7. Review **roles, permissions and all settings**.
8. Improve **WhatsApp** so the CEO's assistant can do everything the CEO needs. Build the tools it is missing, and make it behave like a person who works in the company.
9. Test the **payables workflow** end to end, including the people who work in ASYCUDA/PD, payment applications and containers. A container sometimes does not hold the full quantity, and the system must calculate for that.
10. Make it secure, effective and easy for everyone to understand. Keep the original design, but add padding between blocks, done the way the other pages are.
11. Deploy.

From the 03:09 brief (Appendix A), these become stages IM2-2 to IM2-4:

- the system-wide audit of hardcoded, mock and duplicated business data;
- one Attachment / Audit Log / Print action group, used everywhere;
- invoices that all follow one pattern;
- banks, currencies and exchange rates that are always dynamic;
- existing master data that is selected, not retyped;
- real empty states;
- permissions respected by every selector;
- a final technical report.

## 2. What the audit found (2026-10-03)

### 2.1 Main's health

Five problems were found on main. All are fixed in IM2-0.

- **HR migrations in the wrong place.** PRs #27–#30 left the HR migrations dated before main's own, so a live database would have skipped payroll, advances and talent. Fixed in PR #32.
- **A fresh database could not migrate.** 0260 uses the enum value `whatsapp`, which 0242 adds in the same transaction.
- **42 integration tests failed under C-20.** Fixture banks paid out money they never held.
- **One real bug in payment applications.** Confirming an application counted its own reservation against it, so an account had to hold twice the amount.
- **One stale gate.** The sales-exchange test did not know FX-3's `payable_exchange_difference`.

### 2.2 Dynamic data

Classes: (a) hardcoded or free-typed, should be dynamic · (b) a legitimate enum or constant · (c) a document snapshot · (d) a fallback that hides missing data.

| Area | Finding | Class |
|---|---|---|
| Bank Loans | **Clean.** `bank_loan.bank_code` is a FK to `bank`. The picker is read from the register, and "another bank" creates a real `bank` row. | — |
| Banks screen | The subtitle text names the four banks. | (a) minor |
| Bank & cash accounts | `bank_cash_account.bank_name` is a free-text copy beside an optional bank select. Renaming a bank does not reach it. `swift` duplicates `bank.swift_bic`. | (a) |
| Supplier bank accounts | `partner_bank_account.bank_name` is free text with no FK to `bank`, and **no screen exists to enter a supplier's bank account** (`business-partner.addBankAccount` has no caller). | (a) |
| Currencies | `domain/currencies.ts` is a static IQD/USD/EUR/CNY list used by the Company screen. It offers currencies that are not in `currency`. | (a) |
| Exchange rates | **No hardcoded rate in `src/`.** Two scripts disagree on their defaults (1470, 1320). | (e) |
| AP invoice from a supplier document | A USD document's prices are booked as dinars (`invoices/actions.ts:394,403`). | (d) high |
| Customer receipts | A receipt to a USD account is recorded as IQD, with no check on the account's currency. | (d) |
| Supplier payments (new) | The form lists USD accounts that the service then refuses. | (d) UX |
| PI lines on the import | Item code and unit are free-typed text boxes. | (a) |
| Shipments (B/L) | `shipping_line` is free text although `logistics_carrier` exists. `port_of_loading` is free text although `port` exists, and `port` has no screen at all. | (a) |
| Payables settings | Sweep check, scope, escalation role, lane hint and owner role are free-typed codes. | (a) |
| Company name | Shown from the message files ("Qimah Al-Safinah") in the shell and on the letterhead, not from `company`. `company` has no Arabic name. | (a) |
| Equipment (HR-4) | An "item" kind of equipment is free text with no FK to `item`. | (a) low |
| Dashboard | `components/dashboard-workspace.tsx` is unused and full of fake figures. Its sample message keys go with it. | dead code |
| Fallbacks | `?? 'IQD'` in ten services, and `?? 'EA'` units in five places. | (d) to review |

### 2.3 Attachment, Audit Log and Print

The pattern the sponsor approved is the Import Application's: icon-only `AttachmentsButton` and `HistoryButton` (`components/admin/icon-dialog.tsx`) in the `DocumentWindow` title bar (`titleActions`). It is fully used on one page.

- **Purchase Invoice and Journal** use the paperclip icon, but their audit control is an icon-plus-text link.
- **About 40 other record pages** draw a full Attachments panel and a full history panel at the bottom, with an "Audit log" text link in the title.
- **Print/Export** is the amber `ExportMenu` in the page header on about 15 pages, and missing on the rest.
- **No page has Print beside the two icons yet.**

### 2.4 The Import Application and the payables lanes

The sponsor's recent changes are kept as they are:

- the instalment plan removed from the screen;
- the "Funded by" and "Instalment" selects removed from the payment-application form;
- the "Save terms" and "Link an existing invoice" forms removed;
- the "Payments" menu heading removed;
- the stage chips;
- the four lanes side by side;
- the papers list;
- starting an import from the factory's document.

Bugs found around that workflow, to fix without restoring anything:

1. **A loan-funded payment application always fails.** The form sends `loan_id`, but the funding source defaults to own funds.
2. **Stage 2 "Invoiced + funded" can never be reached.** Its rule still asks for an instalment plan, and the screens for that plan were removed.
3. **An import started from a supplier's document** books USD prices as IQD. Its lines name no warehouse, so nothing lands in transit and every container receipt fails.
4. **Container plans copy the PI unit** but receipts move base units. An import bought in BOX never clears.
5. **`refreshFromInvoices` updates the amount but not the quantity.**
6. **Missing row locks** before status checks:
   - payment-application `create`, against its cap;
   - ASYCUDA `applyRun`;
   - container `setContainerLines`, `changeStatus` and `changeEta`.
7. **A direct supplier payment is invisible to the import.** The import never reaches fully paid and can be paid twice.
8. **Short containers.** Received, damaged and short are typed by hand, and nothing adds them up or checks that they make the planned figure.
   - Short and damaged units stay valued in the In Process warehouse for ever.
   - Only one hold opens per import, however many containers are short.
   - The import can never clear, because received ≠ ordered.
   - Landed cost can lock before all containers arrive.
   - A PD that is part written-off blocks the import for ever.
   - There is no per-item board of ordered / in containers / received / short / damaged / still in transit / not yet shipped.

### 2.5 WhatsApp ("Noah")

**What it has today:**
- **12 catalogue intents.** These are the fallback when no model is available.
- **24 agent tools**, including free `query` SQL limited to one read-only SELECT. The agent runs as the CEO, in a transaction PostgreSQL holds read-only.
- **Write actions:**
  - WA-6: approve/reject with a one-time code;
  - WA-8: propose, then confirm with "yes".
  Both act through the CEO's own approval inbox.
- **Group mode.**
- **File reading** (xlsx, PDF, CSV).

**What is missing:**
- **Gaps:**
  - HR: leave, attendance, payroll, requests, advances.
  - Projects on the agent path.
  - Inventory availability and transit stock.
  - Real per-account bank balances and the cash forecast. `bank_and_cash` promises a balance and prints none.
  - The import pipeline by stage.
  - PDs, B/Ls and containers in transit.
  - Loans.
  - Sales registers.
- **Security:** files are sent after a `view` check only. The CEO deliberately holds no `export` grant (0221), yet the bot records the sends as exports.
- **Documentation:** REQ-WA-001 still says write actions, groups and SQL are out of scope.

### 2.6 Document Center, Monitoring, roles and settings

**Document Center.** `/documents` is a front-end preview with no query or upload. There is no Nextcloud or WebDAV code. The requirement is already written as REQ-FIX-001 FIX-6: a per-user app password through Login Flow v2, WebDAV as the user, sharing through ERP role → Nextcloud group, and a folder per record. Attachments are stored on local disk (`ATTACHMENT_DIR`) through the `registerStorage` seam.

**Monitoring.** No module, route or menu item exists. The nearest is the undelivered `interface_monitor` item under Integrations.

**Roles and permissions:**
1. Three menu objects differ from their page's object, and the menu object is granted to nobody:
   - Periods: `accounting_period` vs `fiscal_period`;
   - FIFO valuation: `fifo_valuation` vs `inventory_movement`;
   - In Transit: `in_transit` vs `supplier_shipment`.
2. Cost centres, payment methods, units of measure and the `dashboard` object are granted to no role.
3. Some objects are checked in code but cannot be granted on any screen, e.g. `employee_compensation` and `other_receipt`.
4. The CEO cannot manage roles without also holding `system_administrator`.
5. The CEO has no `attachment` view.

**Settings with no screen:**
- the approval chains (`workflow_step`);
- the notification rules (only the WhatsApp channel toggles);
- the system parameters.

## 3. The plan

Each stage below is one branch and one PR. Its tests are named before it is built, and it merges into main only when the full unit suite and its integration and e2e suites pass.

| Stage | Delivers | Tests |
|---|---|---|
| **IM2-0 — Main green** · *built* | **Migrations:** PR #32 (HR migration order, controls register); a fresh database migrates in steps at each enum value; `0261_hr_time` joins the rename repair. **Tests:** fixture banks funded (C-20) in every suite; the sales-exchange gate narrowed; WhatsApp W6 exports at its own instant. **Product bug:** confirming a payment application draws on its own reservation. **HR-6:** requests, documents, HR dashboard and reports. The dev seed holds opening cash, so the screens can pay. | Every suite: unit, integration, e2e |
| **IM2-1 — Import & payables correctness** · *built* | Bugs 1–7 of §2.4, with no screen the sponsor removed brought back. **Short and partial containers:** see §4.1. | `im2-01-import-flow` (integration), `im2-01-shortage` (integration and unit), `payables.spec` extended (e2e) |
| **IM2-2 — One document action group** | `DocumentActions`: Attachment, Audit Log and Print as one row of `sapIconButton`s in the DocumentWindow title bar. Print opens the existing Print / Export panel (PDF, Excel, Word × EN/AR). Every record page is migrated, invoices first. The full Attachments and history panels are replaced by the icons where the record has a DocumentWindow. No new classes. | `im2-02-document-actions` (unit: every record page uses it), e2e on the invoice pair, theme readability |
| **IM2-3 — Dynamic master data** | Everything in the §2.2 table, in this order: currencies from `currency`; bank accounts read the bank's name and SWIFT through the FK (the copy kept as a snapshot only where printed); supplier bank accounts with a bank FK and a screen on the supplier; shipping line from carriers; port of loading from `port`, with a Ports screen; PI item and unit pickers; payables-settings pickers; company name (EN/AR) from `company`; the receipt and payment currency checks; the AP invoice currency from a document converted at the day's rate; dead fake-data components removed; real empty states. | `im2-03-dynamic-data` (integration: create, select, save, reload, rename propagates); a static grep gate for bank, currency and rate literals in `src/app` |
| **IM2-4 — Roles, permissions, settings** | The three object mismatches fixed. Grants for cost centres, payment methods, units of measure and the dashboard. The CEO administers roles. The CEO reads attachments. **Approval chains** screen (`workflow_step`). **Notification rules** screen. **System parameters** screen. | `im2-04-grants` (integration: every delivered menu item has a role that opens it), e2e |
| **IM2-5 — Monitoring** | A **Monitoring** module in the navbar. Its screen says "Coming soon", in the existing planned-screen pattern, and is reachable by everyone who signs in. | `fx1-menu` updated, e2e |
| **IM2-6 — Document Center ↔ Nextcloud** | REQ-FIX-001 FIX-6 against `files.qs-groups.com`: connect a user (Login Flow v2; app password encrypted with `ERP_SECRET_KEY`); browse, upload, create folders, open, all as that user; the record's folder linked from its page; attachments optionally mirrored. Everything is configured on a screen (URL, on/off). | `im2-06-webdav` (integration against a local WebDAV server), e2e. The first run on the host is the live test, because this sandbox has no route to the server. |
| **IM2-7 — WhatsApp assistant** | Tools for HR, projects, inventory availability and transit stock, bank balances per account, the cash forecast, the import pipeline, PDs, B/Ls and containers, loans, and sales. Files checked against `export`, or the CEO's grant decided (§5). REQ-WA-001 and the runbook brought up to date. | `wa02-router` / `wa02-intents` extended; one case per tool |
| **IM2-8 — Spacing** | One rule: the space between stacked blocks on record and list screens, changed once in `admin.module.css` and applied everywhere. | Theme readability; screenshots before and after |
| **IM2-9 — Screen by screen** | Every delivered screen opened in both languages. Every figure that is a sum checked against its source. Every calculation listed (invoice totals, FIFO, landed cost, payroll, advances, project EV, recognition, ageing, trial balance) with the test that holds it. | `im2-09-screens` (e2e walk), `docs/CALCULATIONS.md` |
| **IM2-10 — Release** | Full unit, integration and e2e run. CHANGELOG, version and tag. Deploy with `deploy.sh` from main. | `deploy.sh` (it runs the integration suite) |

## 4. Design notes

### 4.1 Short and partial containers (IM2-1)

1. **Receipt arithmetic.** On each container line, received + damaged + short = planned. The form fills short = planned − received − damaged, and the service refuses anything else.
2. **Where short and damaged units go.** They leave the In Process transit warehouse for good.
   - **Short units** go to the import's *shortage* (a supplier claim). Their value moves from transit stock to `supplier_claim_receivable`.
   - **Damaged units** go to a damage write-off (`inventory_adjustment`), or to the same claim if the supplier is responsible. The receiver chooses which, with a reason.
   - Each line is recorded as its own movement and journal, in the same transaction.
3. **The quantity board.** Per item: ordered, in containers, received, short, damaged, still in transit, and not yet shipped (balance shipment). It is shown on the import's warehouse lane and computed in one service.
4. **Clearing and landed cost.**
   - An import clears when received + settled shortage = ordered.
   - Landed cost locks only when every container is received or written off. It then allocates over the received layers.
   - A PD that is part written-off counts as done when the shortage that explains it is settled.
5. **Holds.** One hold per short container, released when its shortage is settled. Settlement means a credit memo from the supplier, a re-shipment, or a write-off approved by the accounting manager.
6. **Units.** Container plans and receipts are in the base unit. The PI unit is converted with `item-units.toBaseQuantity`, so BOX imports clear.

### 4.2 Document actions (IM2-2)

- The approved look is `sapIconButton` (icon, count badge, label as a tooltip) in the title bar.
- **Print** is a third icon (lucide `Printer`). It opens the same panel the `ExportMenu` opens: PDF, Excel and Word in English and Arabic.
- Pages without an export key show no Print icon. The icon never appears just to be there.
- The history dialog shows the same `RecordHistory` the page drew below. Nothing is lost; it moves into the dialog.

## 5. Decisions taken for this work (the sponsor may reverse any)

| # | Decision |
|---|---|
| D-IM2-1 | The Import Application is kept exactly as the sponsor left it. Removed screens stay removed even where a bug fix would be easier with them (e.g. stage 2 is redefined, rather than bringing the instalment plan back). |
| D-IM2-2 | A supplier shortage is a **claim on the supplier**, valued at the units' landed FIFO cost in transit, and settled by credit memo, re-shipment or write-off. It is never left in transit stock. |
| D-IM2-3 | **Open — for the sponsor.** WhatsApp files are sent after a `view` check only, while 0221 deliberately gave the CEO no `export` grant. Proposed: the bot checks `export`, and the CEO's role gains `export` on the objects the bot sends. Until the sponsor answers, the bot keeps today's behaviour, so nothing the CEO uses stops working. |
| D-IM2-4 | Monitoring is a navbar module with one "coming soon" screen until its requirement is written. It reads nothing. |
| D-IM2-5 | Spacing: one value changed once in the shared stylesheet. No page gets its own spacing. |
| D-IM2-6 | Deploy: this cloud session has no route or credentials to the server (`~/.config/qs-erp/vps.md` is not here). Each stage is merged to main ready to deploy, and the deploy is run on the host with `deploy.sh`. |

## 6. Progress

| Date | Stage | Branch / PR | Result |
|---|---|---|---|
| 2026-10-03 | IM2-0 | #32 `fix/hr-migration-order` | merged |
| 2026-10-03 | IM2-0 | #33 `fix/c20-test-fixtures`, #34 HR-6, #35 `test/e2e-current-ui` | merged — integration 2,420/2,420, e2e 133/133 |
| 2026-10-03 | IM2-1 | #37 `improve2/stage-1-import` | merged — integration 2,427/2,427 (148 files); e2e `im2-import-shortage` 2/2 |
| 2026-10-03 | IM2-1b | `improve2/bl-rewrite` | the B/L rewrite (table, check digit, ETA, edit/cancel, print and doors) — integration ap0*, im2-*, hd09, hd14, wa02 green; e2e im2-bl 3/3, payables + theme 15/15 |

---

# Appendix A — The sponsor's audit brief (2026-10-03 03:09), word for word

You are working on a production ERP system. I need a **full system-wide audit and implementation pass**, not a small page-by-page cosmetic fix.

The main goal is:

> **The ERP must behave like a real dynamic ERP. Existing master data, relationships, configuration, currencies, exchange rates, users, banks, accounts, customers, suppliers, etc. must be reused throughout the system instead of being hardcoded, duplicated, mocked, or unnecessarily retyped.**

At the same time, I made some intentional workflow/customization changes myself, especially in the **Import Application** module. Do not blindly restore old behavior. Preserve my current business logic unless it is objectively broken.

---

# 1. FIRST: FULL CODEBASE AUDIT BEFORE CHANGING THINGS

Before modifying anything, inspect the entire application and identify:

* hardcoded/mock/demo data
* static bank names
* static currency names
* static exchange rates
* duplicated master-data fields
* values that should come from existing database records
* dropdowns/selectors that should use existing entities but instead use free text
* fields where the same data is entered repeatedly
* pages that use different UI patterns for the same action
* inconsistent attachment/audit-log/print controls
* fake/default records used only to make the UI look populated
* frontend constants that should come from APIs/database
* backend fallback values that hide missing data
* static lists that should be dynamic
* pages where existing records are available but users are forced to type them again
* invoice pages and other transactional pages that do not follow the same system-wide interaction pattern

Do not only search for obvious words like `mock` or `demo`.

Look for:

* hardcoded strings
* hardcoded IDs
* arrays declared directly inside components
* hardcoded bank/currency/account/customer/supplier names
* manually duplicated dropdown options
* default records
* placeholder values
* seeded UI-only data
* fallback records
* fake API responses
* static exchange-rate values
* duplicated labels/options across modules
* manually typed relationships that should reference database entities

Think like a senior ERP architect reviewing the entire product.

---

# 2. ATTACHMENT + AUDIT LOG ICONS MUST BE SYSTEM-WIDE CONSISTENT

I already have the correct design/pattern for the **Audit Log** and **Attachment** actions.

Use that exact visual language throughout the ERP.

The same functionality should use the same:

* icon style
* icon size
* placement
* spacing
* hover behavior
* tooltip
* button/container styling
* visual hierarchy

Do not create slightly different versions on different pages.

Apply this consistently across:

* invoices
* purchase documents
* sales documents
* import applications
* payments
* receipts
* projects
* HR records
* accounting records
* logistics records
* inventory records
* investments
* loans
* bank/cash transactions
* customer/supplier records
* any other entity where attachments or audit history are available

If a page supports attachments or audit history, it should use the standardized icon treatment.

If the functionality already exists but the UI is inconsistent, unify the UI rather than creating another implementation.

---

# 3. PRINT BUTTON MUST BE PLACED CONSISTENTLY

Wherever a document/page supports printing or PDF generation, the **Print** action should be positioned cleanly next to the Attachment and Audit Log actions.

The final action group should look intentional and consistent.

For example, conceptually:

`[ Attachment ] [ Audit Log ] [ Print ]`

or the equivalent design used by the existing system.

Do not randomly place Print in different locations on different pages.

Apply this consistently to:

* invoices
* purchase invoices
* sales invoices
* payment documents
* receipts
* import applications
* financial documents
* reports where printing is supported
* other transactional documents

Do not remove existing functionality just to change the layout.

---

# 4. INVOICES MUST FOLLOW THE SAME SYSTEM PATTERN

Every invoice page should follow the same design language.

Audit Log, Attachment, Print, and other document actions must be placed consistently across invoice types.

Check all invoice implementations, not just one.

For example:

* Sales Invoice
* Purchase Invoice
* any other invoice/document subtype
* invoice detail page
* invoice edit page
* invoice preview/print page where applicable

Do not allow each invoice type to evolve into its own UI pattern.

---

# 5. IMPORT APPLICATION: PRESERVE MY CURRENT CHANGES

I have personally modified/customized the **Import Application** workflow and removed some previous behavior.

That was intentional.

### Important:

**Do NOT restore old customized functionality simply because it existed before.**

Treat the current Import Application workflow as the intended business workflow unless:

* there is a real bug,
* data integrity is broken,
* a relationship is incorrect,
* a security problem exists,
* or the implementation violates the dynamic-data rules below.

Before changing Import Application behavior, inspect the current implementation and understand why the current version differs from older behavior.

Do not automatically revert my customizations.

Only improve the implementation around the current workflow.

---

# 6. BANK LOANS: REMOVE STATIC BANK NAMES

The Bank Loans area currently contains mocked/static bank names.

This is incorrect for a real ERP.

Bank names must NOT be hardcoded in the frontend or business logic.

They must come dynamically from the actual bank/master-data source.

For example, do not do this conceptually:

```text
Bank A
Bank B
Bank C
```

as permanent application data inside a component.

Instead:

* retrieve the available banks from the real source
* display current database records
* allow newly created banks to appear automatically
* allow renamed/updated banks to propagate
* use actual IDs/relationships instead of duplicated text
* ensure loan records reference the actual bank entity

If there is already a Bank/Financial Institution master, use that.

Do not create a second unnecessary bank list just for loans.

---

# 7. CURRENCIES MUST ALWAYS BE DYNAMIC

Audit the entire application for currencies.

Currency values must come from the ERP's actual currency/master-data system.

Exchange rates must come from the real exchange-rate mechanism.

Do NOT hardcode things such as:

```text
USD
IQD
EUR
GBP
```

inside page-specific dropdowns when the application already has a currency source.

Do not hardcode exchange rates.

The correct pattern is:

**Currency Master → Currency Selection → Transaction → Exchange Rate Source**

Existing currencies should automatically be available wherever applicable.

If the system already contains the currency but a page currently forces the user to type it manually, fix that.

---

# 8. EXISTING MASTER DATA MUST BE SELECTABLE

This is one of the most important requirements.

This is an ERP.

If a piece of information already exists in the system, users should generally **select/reference the existing record instead of manually typing duplicate text**.

Audit every module for this behavior.

Examples:

* customer
* supplier
* bank
* bank account
* cash account
* currency
* exchange rate
* employee
* warehouse
* project
* company
* branch
* account/GL account
* tax
* cost center
* product/item
* unit
* country
* payment method
* responsible employee
* salesperson
* department
* investor
* loan
* contract
* other entities already defined elsewhere in the ERP

If the record exists in the system, use:

* selector
* autocomplete
* searchable dropdown
* entity picker
* relational field

instead of forcing users to type the same information again.

---

# 9. DO NOT DUPLICATE DATA JUST TO MAKE A PAGE EASY TO BUILD

A common anti-pattern in the current system is:

1. Master data exists.
2. Another page creates its own copy of the same values.
3. User types the information again.
4. The two records eventually become inconsistent.

Do not do this.

For every field, ask:

> "Does this information already belong to another entity/master table?"

If yes, use a relationship/reference whenever appropriate.

Do not duplicate the source value unless there is a legitimate historical/snapshot reason.

For example, distinguish between:

* a foreign key/reference to a bank
* versus copying a bank name into a free-text field

The former is usually the correct ERP design.

---

# 10. DYNAMIC DATA MUST REMAIN DYNAMIC EVERYWHERE

Do a system-wide scan for hardcoded values such as:

* bank names
* currencies
* exchange rates
* account names
* account numbers
* customer names
* supplier names
* employee names
* warehouse names
* project names
* branch names
* statuses
* categories
* payment methods
* tax values
* units
* countries
* other master data

Not every string is wrong.

Do not remove legitimate constants such as:

* UI labels
* validation messages
* fixed system terminology
* technical configuration
* enum values that are genuinely application-level constants

Use judgment.

The goal is to eliminate **business data hardcoding**, not every string literal in the application.

---

# 11. FRONTEND + BACKEND + DATABASE

Do not solve this only at the frontend level.

For every important dynamic entity, verify the complete flow:

**Database → Backend/API → Frontend → Form → Save → Reload**

Test that:

1. A new master record is created.
2. It becomes available in the relevant selectors.
3. It can be selected.
4. The correct ID/reference is saved.
5. The correct related data appears after reload.
6. Updating the master record is reflected where appropriate.
7. Deleting/deactivating a record behaves correctly according to business rules.
8. No static fallback silently replaces missing real data.

---

# 12. CHECK FOR "MOCKED BUT LOOKS REAL" DATA

This is especially important.

Some systems are dangerous because mocked data looks like real production data.

Search for things like:

* sample bank names
* fake account numbers
* sample currencies
* fake exchange rates
* demo customer records
* fake balances
* placeholder invoices
* example loan values
* fake transaction rows
* static dashboard metrics
* hardcoded counts
* fake reports

If the page is supposed to represent real ERP data, it must use the real backend data.

Do not simply hide the mocked data.

Remove the mock dependency and connect the page to the correct source.

---

# 13. EMPTY STATES MUST BE REAL EMPTY STATES

Do not create fake records just so a page "looks complete."

If there is no real data:

Show a proper empty state such as:

* No banks found
* No loans found
* No currencies configured
* No transactions found

with appropriate actions such as:

* Add Bank
* Add Loan
* Configure Currency

Do not fabricate data.

---

# 14. CHECK ALL FORMS FOR DUPLICATE MANUAL ENTRY

Go through forms and ask:

> "Is this value already known by the ERP?"

Examples:

Bad:

```text
Customer Name: __________
Customer Address: __________
Customer Phone: __________
```

when the customer already exists.

Better:

```text
Customer: [Select Customer]
```

and automatically load the relevant customer information where appropriate.

The same principle applies to:

* suppliers
* banks
* employees
* projects
* warehouses
* accounts
* currencies
* companies
* branches
* etc.

Do not overdo this where historical snapshot data is intentionally required.

---

# 15. DATA RELATIONSHIP INTEGRITY

For every dynamic selector/reference, make sure the system stores the actual entity relationship.

Do not rely on display names as identifiers.

For example:

```text
bankId
currencyId
customerId
supplierId
employeeId
warehouseId
projectId
accountId
```

rather than using names as the primary relationship.

Display names can change.

IDs/relations should remain stable.

---

# 16. UI CONSISTENCY AUDIT

Do a system-wide consistency review for:

* action icons
* buttons
* toolbars
* page headers
* document actions
* spacing
* alignment
* icon sizes
* tooltips
* modal behavior
* dropdown behavior
* search fields
* date selectors
* currency selectors
* entity selectors
* pagination
* loading states
* empty states
* error states

Do not introduce another visual style if the system already has an established component/pattern.

Reuse shared components.

If a common component should exist but doesn't, create one and migrate the relevant pages to it.

---

# 17. DO NOT BREAK EXISTING BUSINESS LOGIC

This is not a request to redesign the ERP's business rules.

Before changing something:

* understand the existing workflow
* understand related modules
* inspect backend behavior
* inspect database relationships
* check whether other pages depend on it

Especially protect areas such as:

* Accounting
* Inventory
* Invoicing
* Receivables
* Payables
* Loans
* Banking
* Import Applications
* HR
* Projects
* Logistics

A UI improvement is not successful if it introduces accounting or data-integrity problems.

---

# 18. RUN A REAL AUDIT AFTER IMPLEMENTATION

After making changes, run comprehensive checks.

### Static/code audit

Search again for:

* hardcoded bank names
* hardcoded currency lists
* hardcoded exchange rates
* mock data
* demo data
* duplicated master-data lists
* unnecessary free-text versions of relational data
* static financial values
* fake dashboard/report values

### Functional audit

Test:

* creating a new bank
* creating a new currency where supported
* changing currency configuration
* adding/updating exchange rates
* creating a loan
* selecting a bank on a loan
* creating/selecting customers
* selecting suppliers
* selecting accounts
* selecting warehouses
* invoice creation
* invoice printing
* attachment
* audit log
* import application workflow
* page reloads
* data persistence

### Cross-page audit

Verify that the same data behaves consistently across all modules.

For example:

If Bank X exists in the master data, determine whether it correctly appears wherever a bank should be selectable.

Do not fix only the page where the problem was reported.

---

# 19. DATABASE/API ERROR HANDLING

Do not silently replace failed dynamic requests with fake values.

For example, if the currency API fails:

BAD:

```text
USD / EUR / IQD
```

appearing from a hardcoded fallback and making the user think the data is real.

Better:

* proper loading state
* proper empty state
* meaningful error state
* retry capability where appropriate

Do not hide backend failures behind demo data.

---

# 20. SECURITY / PERMISSIONS CHECK

Because this is an ERP, also verify that dynamic selectors respect user permissions.

A user should not automatically see or select data they are not authorized to access.

Check especially:

* companies
* branches
* banks
* accounts
* customers
* suppliers
* employees
* projects
* financial records

Do not weaken existing authorization just to make selectors work.

---

# 21. PERFORMANCE

Do not turn every selector into a huge database query.

For large datasets, use appropriate:

* search
* pagination
* autocomplete
* server-side filtering
* debounced queries
* caching where appropriate

The requirement is **dynamic**, not "load the entire database into every dropdown."

---

# 22. SHARED COMPONENTS

Where appropriate, create/reuse shared components for things such as:

* document action toolbar
* Attachment icon
* Audit Log icon
* Print action
* entity selector
* currency selector
* bank selector

The goal is to prevent the same inconsistency from coming back later.

---

# 23. IMPORTANT: DO NOT MAKE BLIND CHANGES

Do not assume every existing hardcoded value is wrong.

For each suspicious value determine:

1. Is it business/master data?
2. Is it configuration?
3. Is it a UI constant?
4. Is it an enum?
5. Is it test data?
6. Is it intentionally historical data?
7. Is it a legitimate document snapshot?
8. Is it a temporary fallback masking an error?

Only change what should actually be dynamic.

---

# 24. FINAL ACCEPTANCE CRITERIA

Do not consider this task complete merely because the pages compile.

The task is complete only when:

### UI

* Attachment uses the standardized icon everywhere applicable.
* Audit Log uses the standardized icon everywhere applicable.
* Print is positioned consistently next to them where printing exists.
* Invoice pages follow the same action design.
* Shared document actions look and behave consistently.

### Data

* Bank names are dynamic.
* Currencies are dynamic.
* Exchange rates are dynamic.
* Existing master data is reused.
* Users are not forced to retype information that already exists when a relationship should be used.
* No fake/demo data is being used as production business data.
* Dynamic selectors use real database relationships/IDs.

### Workflow

* My current Import Application customization is preserved.
* Do not revert my intentional changes.
* Existing business logic remains intact unless there is a verified bug.

### Quality

* Frontend and backend both use the real data sources.
* No static fallback is masking backend failures.
* Permissions are respected.
* Large lists are handled efficiently.
* Empty states are real.
* Data persists correctly after reload.

---

# 25. FINAL REPORT

After implementation, provide a concise but technical report containing:

### A. Problems Found

List the important hardcoded/mock/dynamic-data issues you discovered.

### B. Changes Made

List exactly what you changed.

### C. Import Application

Explicitly confirm which existing customizations were preserved and that no old workflow was unnecessarily restored.

### D. Dynamic Data

List which modules were converted from static/mock data to real database/API data.

### E. UI Consistency

List the pages/modules updated for:

* Attachment
* Audit Log
* Print
* invoice action consistency

### F. Verification

Report the tests/checks you actually ran.

Do not claim something was tested if you did not actually test it.

### G. Remaining Issues

Clearly list anything you could not safely change because it requires additional business decisions, missing backend support, or clarification.

---

## MOST IMPORTANT RULE

Do not treat this as:

> "Fix these three pages."

Treat it as:

> **"Audit the ERP architecture and make sure the system behaves as one coherent, dynamic ERP rather than a collection of independently built pages."**

I want the result to be **data-driven, relational, consistent, maintainable, and production-oriented**.

Do not just make the UI look better.

**Fix the underlying implementation wherever the UI reveals that the system is relying on hardcoded, duplicated, mocked, or manually re-entered business data.**
