# REQ-ACC-001 — Accounting module: navbar and finance architecture

| | |
|---|---|
| **Requirement ID** | `REQ-ACC-001` |
| **Branch** | `feat/accounting-module` (started 2026-10-04 from `main` @ `946633a`) |
| **Test case(s)** | `tests/integration/nav-internal-transfers.test.ts`; the menu layout in `tests/unit/ui-frameworks.test.ts`, `fx1-menu.test.ts`, `screen-catalogue.test.ts` |
| **Status** | IN BUILD — menu and the Internal Transfers engine done (Part C); screens in Part D to come |
| **Approved by** | *The sponsor's direction of 2026-10-04 (Part A); the reading in Part B not yet approved.* |

This file is the hand-off. Part A is the sponsor's requirement, verbatim.
Part B is how it was read against the code. Part C is what is done, Part D
what is left, Part E the defects found, Part F the rules for working beside
the other module agents.

---

## Part A — The requirement (sponsor, 2026-10-04, verbatim)

We are finalizing the **Accounting** navbar and finance architecture for Qimah ERP.

The objective is to organize the existing Accounting area correctly, reuse everything that already works, and only add genuinely missing functionality.

## CORE RULE

**Do not rebuild working accounting functionality.**

Before changing anything:

1. Inspect the existing routes and screens.
2. Inspect the existing database models and services.
3. Inspect the existing General Ledger/journal engine.
4. Inspect Posting Mappings.
5. Inspect Currencies & Rates.
6. Inspect Bank Accounts and Cash Accounts.
7. Inspect Treasury and reconciliation logic.
8. Inspect existing AR/AP integrations.
9. Inspect existing financial-statement/reporting logic.
10. Reuse the existing Qimah UI/components.

Classify each requested item as:

* **Existing and working → reuse / leave intact**
* **Existing with a genuine defect → smallest targeted correction**
* **Missing → implement**
* **Duplicate → consolidate / redirect rather than creating a second system**

Do not create parallel:

* GL engines
* Journal engines
* Posting engines
* FX engines
* Bank Account models
* Cash Account models
* Reconciliation engines
* Payment engines
* Financial statement engines

The General Ledger remains the accounting source of truth.

---

# 💰 ACCOUNTING

## 1. General Ledger

### Journal Entries

**Purpose:** Create, review, approve/post and investigate manual accounting journals.

Reuse the existing journal engine.

Journal lines should continue supporting the existing architecture for:

* G/L account
* Debit / Credit
* Currency
* Amount
* Branch
* Department
* Cost Centre
* Other configured dimensions
* Reference
* Description
* Source document

Posted journals must not be silently edited.

Use the existing reversal/correction architecture.

---

### Reversals

**Purpose:** Reverse posted accounting transactions through the controlled reversal process.

Rules:

* Never silently edit posted journals.
* Preserve the original.
* Create a separate reversal.
* Respect Accounting Period locks.
* Preserve audit history.
* Reuse the existing reversal engine.

Do not build another reversal mechanism.

---

### G/L Inquiry

**Purpose:** Investigate a specific G/L account.

Show, using the existing GL data:

* Opening balance
* Transactions
* Debit
* Credit
* Running balance
* Date/period
* Journal/reference
* Source document
* Existing accounting dimensions

Allow drill-down into the source transaction where supported.

---

### Trial Balance

**Purpose:** Show account balances and verify that total debits equal total credits.

Reuse the existing GL calculations.

Support the existing date/period and filtering behavior.

Do not create a second balance engine.

---

### Accounting Periods

**Purpose:** Control which accounting periods are open/closed.

Keep the existing implementation.

It must remain authoritative for:

* Opening periods
* Closing periods
* Controlled reopening
* Period locking
* Audit history

Inventory, AR, AP, Loans, Treasury and other accounting modules must continue respecting the same period locks.

---

### Period / Year-End Closing

**Add only if this is genuinely missing.**

Purpose:

* Run closing checks
* Confirm important reconciliations
* Review unresolved accounting issues
* Close the period/year
* Preserve close history
* Support controlled reopening

Reuse **Accounting Periods** for the actual lock.

Do not create a second period-lock system.

---

### Posting Mappings

**Keep and reuse the existing implementation.**

Purpose:

Define how business events post to the GL.

Examples:

* Sales invoice
* Customer receipt
* Purchase invoice
* Supplier payment
* Inventory receipt
* Inventory issue
* Bank loan
* Loan repayment
* Internal transfer
* Bank deposit
* Project material issue
* Landed cost
* FX gain/loss

Do not create separate posting logic inside each new screen.

The existing posting-mapping architecture remains authoritative.

---

### Recurring Journals

**Add only if genuinely missing.**

Purpose:

Create repeatable accounting entries such as:

* Rent
* Depreciation
* Subscriptions
* Accruals
* Other recurring accounting entries

Recurring journals must eventually create normal GL journal entries through the existing journal engine.

Do not create a second posting mechanism.

---

### Account Reconciliation

**Add only if genuinely missing.**

Purpose:

Compare subsidiary/control balances against the General Ledger.

Examples:

* AR subledger vs AR control account
* AP subledger vs AP control account
* Inventory valuation vs Inventory GL
* Loan subledger vs Loan liability GL
* Other relevant control accounts

Show:

* Subledger balance
* GL balance
* Difference
* Status
* Source/investigation path

Do not automatically "fix" accounting differences.

---

# 2. EXISTING FINANCIAL STATEMENTS — PROTECTED

The following four reports already exist and have required significant work:

* Income Statement
* Balance Sheet
* Changes in Equity
* Cash Flow Statement

## DO NOT REBUILD THESE

Treat them as **protected existing functionality**.

Do not:

* redesign them
* rewrite them
* replace their calculation engine
* replace their statement-mapping logic
* refactor them unnecessarily
* change working behavior merely for architectural cleanup

Keep their existing:

* UI
* layout
* calculations
* statement structure
* GL integration
* Statement Mapping integration
* date/period filters
* exports
* printing
* permissions
* tests

### Only fix genuine defects

If inspection finds an actual:

* bug
* incorrect calculation
* incorrect mapping
* broken filter
* inconsistency with the existing GL
* regression caused by another approved change

then:

1. Identify the exact problem.
2. Make the smallest targeted fix.
3. Reuse the existing reporting architecture.
4. Add/update a focused regression test.
5. Leave unrelated report logic untouched.

Do not rebuild these reports.

### Income Statement

Continue using the existing GL and Statement Mapping implementation to show revenue, costs, expenses and profit/loss.

### Balance Sheet

Continue using the existing GL and Statement Mapping implementation to show assets, liabilities and equity.

### Changes in Equity

Continue using the existing equity/reporting logic.

### Cash Flow Statement

Continue using the existing cash/bank and statement-mapping architecture.

Do not introduce a second cash ledger or a second financial-statement engine.

---

# 3. TREASURY & BANKING

Final Treasury & Banking menu:

* Bank Reconciliation
* Internal Transfers
* Bank Loans
* Manual Deposits
* Payments & Receipts
* Bank and Cash Reporting
* Cash Forecast

---

## Bank Reconciliation

**Keep existing if already implemented; otherwise add.**

Purpose:

Compare external bank activity with ERP bank transactions.

Support existing reconciliation capabilities such as:

* statement data
* matching
* unmatched items
* reconciliation status
* difference
* reconciliation history

Reuse the existing Bank Accounts and reconciliation infrastructure.

Do not create a second bank ledger.

---

## Internal Transfers

**Add.**

Purpose:

Move the company's own money between its own Bank Accounts and Cash Accounts.

Supported:

* Bank → Bank
* Bank → Cash
* Cash → Bank
* Cash → Cash

### Same currency

Example:

Rafidain Bank IQD
→ Head Office Cash IQD
→ 5,000,000 IQD

Accounting:

**Dr Destination**
**Cr Source**

No revenue or expense.

### Cross currency

Example:

Rafidain Bank USD
→ Rafidain Bank IQD

Use the existing **Currencies & Rates** infrastructure.

Do not create a transfer-specific FX engine.

### Required fields

Reuse existing Qimah form patterns:

* Transfer number
* Transfer date
* Source account
* Destination account
* Source currency
* Destination currency
* Source amount
* Destination amount
* Exchange rate where applicable
* Reference
* Description/purpose
* Attachments

Source and destination accounts must come from the existing:

**Master Data → Bank Accounts / Cash Accounts**

Do not permit arbitrary account creation inside the transfer screen.

### Validation

Reject:

* Source = destination
* Invalid accounts
* Invalid currency conversion
* Invalid amounts
* Posting into a closed period

Posted transfers cannot be silently edited.

Corrections use the existing reversal architecture.

### Treasury integration

A posted transfer must appear correctly in:

* Bank & Cash Reporting
* Source account history
* Destination account history
* Bank Reconciliation where applicable
* GL

For same-currency transfer:

> Destination increase = Source decrease

Company-wide cash/bank position must not falsely increase/decrease.

---

## Bank Loans

**Keep the existing implementation.**

Do not rebuild the loan system.

Existing functionality includes:

* Loan currency independent from receiving-account currency
* Repayment schedules
* Grace periods
* Repayment ledger
* Early settlement
* Fully Repaid derived from posted repayments
* FX revaluation
* Multi-currency disbursement
* Treasury forecast integration
* Audit history

Reuse the existing **Currencies & Rates** infrastructure.

---

## Manual Deposits

**Keep existing.**

Purpose:

Record treasury deposits that are not already represented by another dedicated business transaction.

Reuse:

* Bank Accounts
* Cash Accounts
* Currencies & Rates
* Existing posting engine
* Existing journal engine

Do not use Manual Deposits to duplicate:

* Customer Receipts
* Supplier Payments
* Loan Disbursements
* Internal Transfers

where those already have dedicated workflows.

---

## Payments & Receipts

**Add only if a central Treasury view is missing.**

This should provide a consolidated treasury-level view of actual money movement.

Important:

Do NOT create competing AR/AP payment engines.

Examples:

Customer Receipt:

* Created in Receivables
* Reflected here as Treasury movement

Supplier Payment:

* Created in Payables
* Reflected here as Treasury movement

Treasury may provide the consolidated view but the source business modules remain responsible for their own transactions.

---

## Bank & Cash Reporting

**Keep existing.**

Purpose:

Management-level bank/cash reporting.

Reuse the existing implementation for:

* Opening
* Money In
* Money Out
* Transfers
* Closing
* Running balance
* Account
* Currency
* Date
* Transaction details

Do not rebuild the reporting engine.

---

## Cash Forecast

**Add/keep if missing.**

Purpose:

Forecast future liquidity.

Possible inputs:

* Current bank/cash balances
* Customer receipts
* Supplier payments
* Loan drawdowns
* Loan instalments
* Other committed treasury flows

Rules:

* Paid transactions must not be counted again.
* Loan grace rows must not become fake outflows.
* Loan drawdowns use expected disbursement dates.
* Multi-currency forecasts reuse Currencies & Rates.
* Do not create another FX system.

---

# 4. MASTER DATA & CONFIGURATION

These are reusable records/configuration.

## Financial

### Chart of Accounts

**Keep existing.**

Authoritative account master.

---

### Statement Mapping

**Keep existing.**

Maps accounts to the existing:

* Income Statement
* Balance Sheet
* Cash Flow
* Other financial reporting structures

Do not duplicate statement mapping elsewhere.

---

### Currencies & Rates

**Keep existing.**

This is the authoritative FX infrastructure.

Reuse it everywhere.

It handles:

* Currency definitions
* Exchange rates
* Date-based rates
* Conversion

Do NOT create separate FX systems for:

* loans
* inventory
* internal transfers
* reports
* projects
* imports

---

### Tax Codes

**Add only if genuinely missing.**

Purpose:

Reusable tax configuration.

Should support, according to existing business requirements:

* Tax code
* Rate
* Input/output treatment
* Relevant accounts
* Active/inactive

Transactions reference tax codes.

Do not hard-code rates into individual invoices/journals.

---

### Payment Terms

**Keep existing.**

Reusable commercial payment conditions for:

* Sales
* Customers
* Purchases
* Suppliers
* Receivables
* Payables

Do not duplicate payment-term definitions in modules.

---

### Payment Methods

**Keep existing.**

Examples:

* Bank transfer
* Cash
* Cheque
* Other configured methods

Use one reusable definition.

---

## Banking

### Banks

**Keep existing.**

Master definition of financial institutions.

---

### Bank Accounts

**Keep existing, but navigation ownership belongs to Master Data.**

Bank Account is a master record.

Maintain/reuse:

* Bank
* Account number/reference
* Currency
* Branch
* Linked GL account
* Status
* Existing account attributes

Treasury transactions reference these accounts.

Do not create another bank-account model.

---

### Cash Accounts

**Keep existing, but navigation ownership belongs to Master Data.**

Cash Account is a master record.

Maintain/reuse:

* Account name
* Currency
* Branch
* Linked GL account
* Responsible information where already supported
* Status

Treasury transactions reference these accounts.

Do not create another cash-account model.

---

## Organization

### Branches

Keep existing.

### Departments

Keep existing.

### Cost Centres

Keep existing.

These must remain reusable accounting dimensions.

---

## Inventory Reference

### Warehouses

Keep existing.

Warehouse is Master Data.

Inventory transactions reference it.

Do not duplicate warehouse management under Accounting.

---

# FINAL ACCOUNTING NAVBAR

The final structure should be:

## 💰 Accounting

### General Ledger

* Journal Entries
* Reversals
* G/L Inquiry
* Trial Balance
* Accounting Periods
* Period / Year-End Closing
* Posting Mappings
* Recurring Journals
* Account Reconciliation
* Income Statement
* Balance Sheet
* Changes in Equity
* Cash Flow Statement

### Treasury & Banking

* Bank Reconciliation
* Internal Transfers
* Bank Loans
* Manual Deposits
* Payments & Receipts
* Bank and Cash Reporting
* Cash Forecast

### Master Data & Configuration

#### Financial

* Chart of Accounts
* Statement Mapping
* Currencies & Rates
* Tax Codes
* Payment Terms
* Payment Methods

#### Banking

* Banks
* Bank Accounts
* Cash Accounts

#### Organization

* Branches
* Departments
* Cost Centres

#### Inventory Reference

* Warehouses

---

# OWNERSHIP RULES

Use these rules throughout the ERP.

### Master Data

Defines:

> **What exists?**

Examples:

* Bank
* Bank Account
* Cash Account
* Currency
* Customer
* Supplier
* Item
* Warehouse

### General Ledger

Defines:

> **What was accounted for?**

### Treasury

Defines:

> **What money moved or is expected to move?**

### Receivables

Owns:

> **Customer receivables and customer receipts**

### Payables

Owns:

> **Supplier payables and supplier payments**

### Inventory

Owns:

> **Stock quantities, movements and valuation**

### Projects

Owns:

> **Project/WBS costs and project execution**

Accounting connects these systems through the existing posting architecture.

---

# CRITICAL NO-DUPLICATION RULES

Do not create:

* Second customer balance system
* Second supplier balance system
* Second bank-account model
* Second cash-account model
* Second FX system
* Second posting engine
* Second inventory ledger
* Second reconciliation engine
* Second payment engine
* Second financial-statement engine

Existing business modules remain the owners of their transactions.

Accounting and Treasury use those transactions through the existing architecture.

---

# UI REQUIREMENTS

Preserve the current Qimah ERP design.

Reuse:

* Existing navbar/sidebar
* Existing page headers
* Existing tables
* Existing cards
* Existing filters
* Existing forms
* Existing modal/drawer patterns
* Existing currency formatting
* Existing loading states
* Existing empty states
* Existing error states
* Existing attachment icon
* Existing audit/history icon
* Existing print icon

Do not redesign the finance UI just to reorganize navigation.

---

# IMPLEMENTATION PROCESS

Before coding:

1. Inspect all existing Accounting routes.
2. Inspect all existing Treasury routes.
3. Inspect existing Master Data routes.
4. Identify duplicate ownership.
5. Identify which requested screens already exist.
6. Identify genuinely missing screens.
7. Reuse existing services/models/components.
8. Do not rebuild working financial statements.

For every requested item, explicitly classify it as:

**KEEP**
**IMPROVE**
**ADD**
**REMOVE / REDIRECT**

where appropriate.

### Testing

Run focused tests for every changed area.

Do not use this navbar task as a reason to rewrite unrelated finance code.

### Most important requirement

The objective is:

**Existing engine + correct ownership + missing controls + consistent navigation + one source of truth.**

The four existing financial statements — **Income Statement, Balance Sheet, Changes in Equity, Cash Flow Statement** — are protected. Only make targeted corrections if a genuine defect is proven.

### Added by the sponsor during the work (2026-10-04)

* Every record screen (and every invoice) carries **notes, attachments,
  audit (history) and print** once it exists as a draft — the four doors
  (AGENTS.md, "Every record wears the same four doors").
* Parties and accounts on a record are links to their **profiles**: the bank
  account, the cash account, the bank, the customer, the supplier, the G/L
  account, the journal. Most things that have a profile should be clickable.
* Other agents work on Receivables, Inventory, Payables and Accounting at the
  same time; each works on `feat/{module}-module` and the sponsor merges.

---

## Part B — Reading the requirement against the code

| Item | What exists | Decision |
|---|---|---|
| Journal Entries | `/finance/journals`, `services/journal.ts` | KEEP |
| Reversals | `/finance/reversals`, `services/reversal.ts`, `journal.reverse` | KEEP |
| G/L Inquiry | `/finance/gl-inquiry` (+ `[code]`) | KEEP |
| Trial Balance | `/finance/trial-balance`, `services/trial-balance.ts` | KEEP |
| Accounting Periods | `/finance/periods`, `services/periods.ts` | KEEP (menu object fixed, E-1) |
| Period / Year-End Closing | checklist + close live on `/finance/periods` (`closing-checks.ts`) | ADD thin screen `/finance/closing` reusing `periods.closeReport` / `setPeriodStatus` + close history. **No** retained-earnings roll — it would change the protected statements |
| Posting Mappings | `/finance/posting-mappings`, `domain/posting-map.ts` | KEEP |
| Recurring Journals | nothing | ADD — templates that raise **draft** journals through `journal.ts`; one migration |
| Account Reconciliation | `subledger.reconciliation()`, inventory check in `closing-checks.ts` | ADD screen `/finance/account-reconciliation` (AR, AP, loan, bank control accounts; inventory layers vs G/L) |
| Income Statement, Balance Sheet, Changes in Equity, Cash Flow | built | KEEP — **protected, untouched** |
| Bank Reconciliation | full engine `bank-reconciliation.ts` + `bank-statement.ts`, no screen; close checklist already links `/treasury/bank-reconciliation` | ADD list + record screens over the engine |
| Internal Transfers | engine `treasury.createTransfer/approveTransfer/postTransfer` on `bank_transfer`, no screen | ADD list + record; IMPROVE engine (E-2) |
| Bank Loans | built | KEEP — **another agent is changing it; do not touch** |
| Manual Deposits | built | KEEP — **another agent is changing it; do not touch** |
| Payments & Receipts | none central | ADD read-only register over the G/L lines on bank/cash accounts (`treasury-reports.ts`), each row linking to its source document; no payment engine |
| Bank and Cash Reporting | `/treasury/reporting` | KEEP |
| Cash Forecast | engine `cash-forecast.ts` (paid excluded, grace rows excluded, drawdowns on expected date), no screen | ADD report screen |
| Chart of Accounts, Statement Mapping, Currencies & Rates, Payment Terms, Payment Methods, Banks, Branches, Departments, Cost Centres, Warehouses | built | KEEP |
| Bank Accounts, Cash Accounts | built, listed under Treasury | REDIRECT menu to Master Data › Banking (routes unchanged) |
| Tax Codes | `tax_code` / `tax_rate` tables and grants (0012), no service, no screen | ADD service + list + record (no migration) |
| Receivables section (`finance_ar`) | all unbuilt | left as is — Receivables belongs to Sales; the Receivables agent owns it |

---

## Part C — Done

1. **Menu** (`domain/menu.ts`, `erp-shell.tsx`, `domain/screens.ts`, labels in
   both locales, unit tests). General Ledger, Treasury & Banking and Master
   Data (Financial / Banking / Organization / Inventory Reference — sections
   `master_data`, `master_banking` 26, `master_organization` 27,
   `master_inventory` 28) in the order of Part A. Routes unchanged (D-FX-1).
   New items stay hidden until their route joins `DELIVERED`.
2. **Internal Transfers engine** (`services/treasury.ts`, transfer functions
   only): cross-currency posting through `exchange-rates.convertOn` with the
   difference to `exchange_gain` / `exchange_loss` (event
   `treasury.bank_transfer` added to `POSTING_MAP`); funds check in dinars;
   refused: same account, inactive account, closed period, rate and amount
   that disagree, zero; rate read off the two amounts when not typed;
   one-time `documentId`; `approveTransferAsChecker` (maker ≠ checker, Super
   User alone); `reverseTransfer` through `journal.reverse`; `listTransfers`,
   `transferByNo`, `valueTransfer`. Rows lock `FOR UPDATE` before a status
   change. Test: `tests/integration/nav-internal-transfers.test.ts`
   (10 pass, 1 skipped for E-3).

---

## Part D — Left to do, in this order

1. Generic **record notes** (one `record_note` table, append-only, RLS like
   `attachment`; access by the attachment service's parent checks) and a
   `RecordNotes` component, so every new record gets its Notes door.
2. **Internal Transfers screens** — `/treasury/transfers` (copies
   Purchase Invoices list) and `/treasury/transfers/[transferNo]` (copies the
   Purchase Invoice record): Printer (`internal_transfer` print model, object
   `bank_cash_account`), Paperclip, Notes, Clock; accounts link to
   `/master-data/bank-accounts/{code}` or `/master-data/cash-accounts/{code}`,
   the journal to `/finance/journals/{no}`; approve / post / reverse.
3. Bank Reconciliation screens (list, record with statement lines, matches,
   adjustment, finalise, reopen; four doors).
4. Payments & Receipts register; Cash Forecast; Account Reconciliation.
5. Tax Codes (service + screens, four doors on the record).
6. Period / Year-End Closing screen.
7. Recurring Journals (migration, service, screens, four doors).
8. Each route into `DELIVERED`, the catalogue test's list, `docs/CONTROLS.md`
   rows for new controls, AGENTS.md section, theme-readability run.

---

## Part E — Defects found

* **E-1 (fixed).** Accounting Periods named permission object
  `accounting_period`, which no role holds — hidden from everyone but the
  Super User. Now `fiscal_period`, what the page and service authorise on.
* **E-2 (fixed).** A cross-currency `bank_transfer` posted the source's and
  destination's own-currency figures into a dinar journal — it could not
  balance. The funds check compared a foreign amount with a dinar balance.
* **E-3 (open, needs a migration).** C-20 `assert_bank_not_negative`
  (0259) sums only `status = 'posted'` journals. Reversing a journal turns
  the original `reversed`, so the guard sees the reversal alone and refuses
  any reversal that empties an account. It should sum `('posted','reversed')`
  as `treasury.balances` does. Affects every reversal touching a bank or cash
  account (transfers, receipts, payments).
* **E-4 (open, noted).** `treasury.balances` counts an approved foreign-
  currency transfer's own-currency amount as dinars in "committed".
* **E-5 (noted).** The close checklist links `/inventory/fifo-valuation`
  correctly but `/treasury/bank-reconciliation` had no page (Part D-3).

---

## Part F — Working beside the other module agents

* One branch per module: `feat/{module}-module` — `feat/accounting-module`,
  `feat/receivables-module`, `feat/inventory-module`, `feat/payables-module`.
  Nobody pushes to `main`; the sponsor merges.
* **Accounting owns**: `src/app/(app)/finance/**`, `src/app/(app)/treasury/**`
  except `loans/` and `deposits/`, `src/app/(app)/master-data/{tax-codes,
  bank-accounts, cash-accounts, banks, chart-of-accounts, statement-mapping,
  exchange-rates, payment-terms, payment-methods}`, services `journal`,
  `reversal`, `periods`, `closing-checks`, `trial-balance`,
  `financial-statements` (protected), `treasury` (transfer functions),
  `bank-reconciliation`, `bank-statement`, `cash-forecast`,
  `treasury-reports`, `subledger`, new `record-notes`, `tax-codes`,
  `recurring-journals`.
* **Accounting does not touch**: loans, deposits, Receivables (sales/AR),
  Payables (AP), Inventory services or screens. It reads them read-only
  where Treasury shows their money.
* **Shared hotspots** — expect conflicts, resolve by keeping both sides:
  `src/server/domain/menu.ts` (each module edits only its own sections),
  `src/server/domain/screens.ts` (`SCREENS` and `DELIVERED`),
  `messages/en.json` / `ar.json` (add keys, never reorder), the counts in
  `tests/unit/screen-catalogue.test.ts` and `ui-frameworks.test.ts`
  (recount after merging), `src/components/erp-shell.tsx`
  (`MODULE_DEFINITIONS`, own module only), `domain/posting-map.ts`,
  `attachments-runtime.ts`, `tests/integration/setup.ts` (`resetTestData`),
  `scripts/ops/format-live-database.sh`, `docs/CONTROLS.md`, `AGENTS.md`.
* **Migrations**: the journal is ordered by `when`, not by file number. Two
  branches will both take the next number; at merge, the later branch renames
  its file and takes a `when` after the journal's last entry. Never edit a
  migration another branch has applied.
* Run tests against your **own** database (`DATABASE_URL_TEST`), never a
  shared `erp_test` — two suites resetting one database fail each other.
