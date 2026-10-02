# Controls register

REQ-IMPROVE-001 FC-9. One row per control the system *enforces* — in the
database where it can be, in a service where it must be — with the test
that proves it. `tests/unit/im15-controls-register.test.ts` reads this
file: every row names a test file that exists, and every control named
**database** cites a migration that exists. A control that is only a
convention is not listed; a control listed here without its test fails the
gate.

Started 2026-10-02 with the closing controls; grows one row per control as
the stages land. Rows are never removed — a control retired is marked so.

| # | Control | Where | Enforced by | Test |
|---|---|---|---|---|
| C-01 | A posted journal cannot enter, or be moved into, a closed period. | database | `0243_closed_period_lock.sql` · `journal_entry_closed_period_lock` | `tests/integration/im10-period-close.test.ts` |
| C-02 | A stock movement cannot be written with a date in a closed period. | database | `0243_closed_period_lock.sql` · `inventory_movement_closed_period_lock` | `tests/integration/im10-period-close.test.ts` |
| C-03 | Periods close in sequence: a period cannot close while an earlier one of its year is open or soft-closed. | database + service | `0243_closed_period_lock.sql` · `fiscal_period_close_in_sequence`; `services/closing-checks.ts` › `sequence` | `tests/integration/im10-period-close.test.ts` |
| C-04 | A hard close is refused while a blocking checklist item fails (G/L integrity, unposted journals, sub-ledger ≠ G/L, stock ledger integrity, stock documents waiting); the warnings it was taken over are recorded with its reason. | service | `services/periods.ts` › `setPeriodStatus` → `closing-checks.report` | `tests/integration/im10-period-close.test.ts` |
| C-05 | Every control account equals its sub-ledger as at a period's end before that period closes. | service | `services/subledger.ts` › `reconciliation`; `closing-checks.ts` › `subledger_equals_gl` | `tests/integration/im10-period-close.test.ts` |
| C-06 | A closed period cannot be reopened from the calendar screen. | service | `services/periods.ts` › `setPeriodStatus` | `tests/integration/accounting-periods-rates.test.ts` |
| C-07 | Posting into a soft-closed period requires the `execute` permission on `fiscal_period` and a stated reason, both recorded. | service | `services/periods.ts` › `authorisePosting` | `tests/integration/accounting-periods-rates.test.ts` |
| C-08 | A question from WhatsApp runs read-only at the database, as the asking user, with that user's grants; only a user holding the `ceo` role whose contact allows queries is answered. | database + service | `services/whatsapp.ts` › `withReadOnlyScope`, `mayAsk`, `answer` | `tests/integration/wa01-bridge.test.ts` |
| C-09 | A payment batch over the high-risk line cannot be approved by its maker. | database | `0053_phase07_payment_run.sql` · `payment_batch_maker_checker` | `tests/integration/treasury-payment-run.test.ts` |
| C-10 | A bank loan cannot be approved by the person who created it. | database | `0235_bank_loans.sql` · `bank_loan_maker_checker` | `tests/integration/ap06-loans.test.ts` |
| C-11 | Stock quantity has one source, `inventory_movement`; no configuration anywhere permits a negative position (`warehouse.allow_negative_stock` is pinned false). | database + gate | `tests/integration/inventory-negative-stock-paths.test.ts` | `tests/integration/inventory-negative-stock-paths.test.ts` |
| C-12 | Audit rows, journal entries once posted, notification deliveries, WhatsApp messages and contacts, employee history and compensation are append-only. | database | `reject_mutation`, `*_forward_only`, `*_append_only` triggers | `tests/integration/ap01-append-only.test.ts`, `tests/integration/wa01-bridge.test.ts`, `tests/unit/hr01-event-coverage.test.ts` |
| C-13 | A project certificate is approved by somebody other than its raiser, and a posted certificate carries its journal. | database + service | `0249_project_billing.sql` · `project_certificate_four_eyes`, `project_certificate_posted_has_journal`; `services/project-billing.ts` › `approveCertificate` | `tests/integration/pm05-billing.test.ts` |
| C-14 | Project revenue recognition posts nothing until Finance has ratified the method (D-PM-1), never into a closed period, once per project and period end, and its adjustment is recognised less billed. | database + service | `0249_project_billing.sql` · `project_recognition_period_uniq`, `project_recognition_arithmetic`; `services/project-billing.ts` › `runRecognition` | `tests/integration/pm05-billing.test.ts` |
| C-15 | The period-close checklist warns of every running customer project without recognition to the period's end. | service | `services/closing-checks.ts` › `project_recognition` | `tests/integration/pm05-billing.test.ts`, `tests/integration/im10-period-close.test.ts` |
| C-16 | A billing plan never bills more than the contract value as it stands, and the certificates never certify more than it. | service | `services/project-billing.ts` › `addPlanLine`, `raiseFromLine`, `certifyProgress` | `tests/integration/pm05-billing.test.ts`, `tests/unit/pm05-project-billing.test.ts` |
| C-17 | A project settlement is posted by somebody other than its drafter, one per project; once posted the project refuses every further cost, recognition run and reopen, and its close needs it. | database + service | `0250_project_close.sql` · `project_settlement_four_eyes`, `project_settlement_one_per_project`; `services/project-close.ts` › `postSettlement`, `closeChecks`; `services/projects.ts` › `assertSpendable` | `tests/integration/pm06-close.test.ts` |
| C-18 | Hours on a project are approved by somebody other than who booked them, an employee's day holds at most 24 hours across projects, and a month's hours post once at the rate in force, read only by somebody who may see compensation. | database + service | `0250_project_close.sql` · `project_timesheet_four_eyes`, `project_timesheet_day_within_24`; `services/project-close.ts` › `postLabour` | `tests/integration/pm06-close.test.ts` |
| C-19 | A Material Issue document posts its cost against the items' inventory accounts in the same transaction as the stock leaves. | service | `services/project-execution.ts` › `postIssue` | `tests/integration/pm03-execution.test.ts`, `tests/integration/pm06-close.test.ts` |
