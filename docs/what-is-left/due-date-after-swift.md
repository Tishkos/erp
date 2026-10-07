# The balance's due date after the SWIFT — what is left

By direction 2026-10-07: "don't show the due date until we get the SWIFT … once
the payment application is done, clicking the import application, a dialog
comes up: enter the due date, and it marks it."

## Done (compiles, narrow tsc clean, unit tests green, no migration)

* **The rule.** A purchase invoice has a due date only once `ap_invoice.due_date_set_at` is stamped. `ap-invoice.setDueDate` stamps it. Since this change `ap-invoice.create` also stamps it when the caller passes a `dueDate`: an expense's, a recurring contract period's, a debit note's, or one said in chat. A date the service fills in by itself is not stamped: the supplier's terms, or the entry day. The purchase invoice form sends none. The pure rules are in `src/server/domain/balance-due.ts`; the same rules for SQL are in `src/server/services/known-due-date.ts`. The import application's date is known once one of its live invoices was set; with no invoice, it is the date typed on the import.
* **Hidden: a dash with "Set once the SWIFT is received"** (`DueDateText`, `components/admin/due-date-text.tsx`). It shows on:
  * the Purchase Invoices register and the invoice record (the field now always shows, with "Set by … on …" once set);
  * the Import Applications register (`payables.workbench` now has `dueDate` known plus `dueDateWaiting`) and the import page;
  * the supplier statement (lines and the outstanding table);
  * Payables open items (screen and print);
  * the invoice's settlement panel;
  * the supplier payment record (open invoices and allocations), the credit-memo apply list and the purchase invoice print copy;
  * Noah's `invoice` read, `document_story`, the review check and `payable_status`.
* **Unset is not overdue.**
  * `open-items` gained `dueDateSet`. Unset means bucket `current` ("Not yet due"), 0 days overdue, never in the "due within" list. That covers the ageing, the supplier profile's chart, the overdue-exposure detector and Related records.
  * Elsewhere:
    * Home's payables ageing (`dashboard.payableAgeing`) and "Payables due this week" (`dashboard`, `home-loaders`) skip unset dates;
    * the register's payment state (`screen-registers`) and the record's never say Overdue on an unset date;
    * the due-soon/overdue notices (`due-notices.raiseDueNotices`) and the paid-late notice skip unset invoices;
    * the payment run (`domain/payment-run.classify`) puts an unset invoice in `excluded_not_due`, with a reason;
    * the A/P ageing in `supplier-payment` puts it in `current`.
  * There is no automation or exception sweep keyed on supplier due dates other than overdue exposure, which is covered.
* **The prompt.**
  * The service is `services/balance-due.ts`: `promptFor`, `setForImport`, `marksFor`, with `BalanceDueRefusal`.
  * The action is `app/(app)/payables/due-date-action.ts`: one action that answers, never redirects.
  * The dialog is `components/admin/balance-due-dialog.tsx`, the house native modal `<dialog>` with `IntentDateField`. It opens by itself once per tab, with `sessionStorage` wrapped in try/catch. "Later" closes it, and a refusal is shown inside the dialog in the reader's language.
  * The banner and the props are `app/(app)/payables/balance-due.tsx`. The banner says "Waiting for the due date" when the reader has no grant.
  * The invoice record's "Set due date" is un-hidden under the same condition and opens the same dialog.
  * The goods' journey shows "Due date …" on the In Process step.
* **Words.** `admin.balance_due.*` (22 keys) and `audit_action.ap_invoice.due_date_set` are in both catalogues. The guide blocks are updated (`docs/guide/payables.md`, Import Applications and Purchase Invoices).
* **Tests.**
  * New: `tests/unit/due01-balance-due.test.ts` and `tests/integration/due01-due-date-after-swift.test.ts` (3 tests).
  * Integration runs on `erp_test_due`, all passed: due01, all of ap01–ap08, pay08-supplier-credits, fx3-import-invoice. Unit: due01, hd18, hd19, i18n-catalogue, wa10, payment-run, domain-purity, ageing.
  * Fixtures stamped `due_date_set_at` because they stand for invoices with known due dates: `treasury-exit-gate` (raw invoices a payment run pays), `sv01-saved-views` and the `saved-views` e2e (an "overdue" view).

## Left

1. Run `adv01-advance-hold`, `pi01-purchase-invoice-fixes`, `due-notices`, `ex01-exceptions`, `dash-home`, `sv01-saved-views`, `treasury-exit-gate`, `treasury-payment-run`, `wa14-review`, `open-items`, `ops17`, `cc01-relationships` and `hd14-payable-record` on a database of their own. Use `C:/Users/tiish/.claude/jobs/619567b7/tmp/run-due.sh <log> <files…>`, which runs on `erp_test_due`, already migrated.
2. Run the e2e `tests/e2e/due-date-after-swift.spec.ts` against :3300 (`erp_ui`), started through `ui-env.sh` so that `DATABASE_URL_OWNER` is set, with `--config C:/Users/tiish/.claude/jobs/619567b7/tmp/pw-overlays.config.ts --workers=1`. It is written but has not run yet. It uses the dev database's own paid import (IMP-HQ-2026-000006 / PUR-HQ-2026-000011) and first clears that invoice's `due_date_set_at`.
3. Screens not looked at in the browser yet: the banner and dialog in light/dark, EN desktop and AR phone. The theme-readability spec has not been run.
4. AGENTS.md paragraph: in the report to main, to paste.

## Known issues and decisions to confirm

* **Live data.** Every existing purchase invoice on live has `due_date_set_at` null. After deploy, all of them show "—" and are not overdue until set, including expenses and recurring-contract periods raised before this change, whose dates were real. If the owner wants those back, a one-off backfill can stamp invoices with `expense_category_code` or `recurring_contract_id` set. It is not written, because the live database is three days old and holds few such invoices.
* **Terms-derived dates are not stamped.** A local invoice from a supplier with Net 30 terms is treated as unset too. That is what the record has done since 2026-10-03. The hint says "Set once the SWIFT is received" for it as well. Only an import's invoices can be set from the UI; a local invoice has no button yet.
* **Cash forecast and cash requirement are unchanged.** `cash-forecast.apDue` and `supplier-payment.cashRequirement` still place an unset invoice on its stored date, so treasury does not lose money it will owe. Decide whether that should change.
* **The paid notice.** An invoice paid in full before any due date was set never gets a "paid late" notice. That is intended.
