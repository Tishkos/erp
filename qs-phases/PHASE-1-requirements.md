# ERP Implementation — Phase 1

> **Source:** the sponsor's Phase 1 definition, received 2026-08-25. Recorded
> here verbatim; the acceptance record for this phase will sit beside it as
> `PHASE-1-accounting-core.md` when the phase closes.

## Purpose

Phase 1 establishes the basic accounting structure of the ERP. The objective is
to create the Chart of Accounts, record and approve Journal Entries, and produce
the main accounting reports before adding the detailed accounting branches in
later phases.

## Phase 1 Requirements

| No. | Requirement | Expected Result |
|---|---|---|
| 1 | Chart of Accounts | Finance can create and maintain a hierarchical Chart of Accounts under Assets, Liabilities, Equity, Revenue and Expenses. Accounts can be created as header or posting accounts and can be activated or deactivated. |
| 2 | Journal Entries | Finance can create manual Journal Entries with an automatic entry number, document date, posting date, description, optional attachment, and debit and credit lines. Each entry follows the approval flow already established in Phase 0. |
| 3 | Journal Posting and Reversal | An approved Journal Entry becomes posted and updates the accounting records. A posted entry cannot be edited or deleted. If a correction is required, the original entry is reversed through a linked full reversal. |
| 4 | General Ledger and Trial Balance | Posted Journal Entries appear automatically in the General Ledger. Finance can review account activity and produce a Trial Balance for a selected date or period. Total debits and total credits must remain equal. |
| 5 | Financial Reports | The system can produce the main accounting reports from the posted accounting records: General Ledger Report, Trial Balance, Statement of Profit or Loss and Statement of Financial Position. Accounts can be assigned to the correct financial statement lines. |

## Expected Result of Phase 1

At the end of Phase 1, Finance can create the Chart of Accounts, enter and
approve a Journal Entry, post it to the General Ledger, review the Trial Balance
and produce the basic financial statements. This creates the accounting
foundation that the remaining accounting functions will use in the following
phases.

## Not Included in Phase 1

Accounts Payable, Accounts Receivable, Treasury and Banking, Fixed Assets,
Budgeting, customer and supplier subledgers, inventory accounting, purchasing,
sales, payroll and the detailed accounting Master Data are not included in this
phase.
