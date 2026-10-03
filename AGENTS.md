<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Isolated database verification

`scripts/seed-dev.ts` uses `DATABASE_URL`, not `DATABASE_URL_OWNER`. Setting only the owner URL does not redirect the seed. For isolated verification, explicitly point `DATABASE_URL` and `DATABASE_URL_TEST` at the intended isolated database, and verify the running development server uses that same database before browser tests. Never rely on `.env` defaults for a seed or test run.

## Two migration lines at 0245 (2026-10-02)

The WhatsApp branch ran `0245_whatsapp_group_and_actions`, `0246_whatsapp_group_only` and `0247_whatsapp_noah_opus` at journal times …049–051; main ran PM-1 to PM-3 at the same times. In the merged journal the WhatsApp two sit at …061–062 (after `0255_hr_structure`), and `src/server/db/migrate.ts` (`LINEAGE_REPAIRS`) runs PM-1 to PM-3 on a database whose last recorded time had passed them and whose tables are missing — decided by the table, never the hash (files edited after they ran carry other hashes everywhere). A new migration takes a `when` after the journal's last entry, as always.

## Business dates and money (REQ-HARDEN-001 HARDEN-2)

* "Today" is `businessToday()` from `src/server/domain/business-date.ts` (Asia/Baghdad, `ERP_TIMEZONE`); a timestamp becomes a date with `businessDateOf(instant)`. Never `new Date().toISOString().slice(0, 10)` — it is UTC and reads yesterday for the first three hours of every Baghdad day. `tests/integration/hd07-business-today.test.ts` greps for it and fails the build. SQL that needs today binds `${businessToday()}::date`, never `current_date`.
* Money and quantities are compared and summed as scaled bigints (`parseDecimal` / `parseQuantity` / `divideHalfUp` / `toDecimalString`), never as `Number()`; in the browser the same through `src/lib/decimal.ts`. A `Number()` is only ever the last step before `Intl.NumberFormat`.
* A transition reads its row with `FOR UPDATE` (`lock(tx, id)` in payment-applications, loans, customs-pd, payables; `importOf(…, { lock: true })` in landed-cost) before it checks the status, so a double submit posts once. `tests/integration/hd09-double-submit.test.ts` holds it.

## Audit timestamp payloads

Pass timestamps to `audit.record` as ISO strings, not JavaScript `Date` objects: a Date in an audit before-value was serialized as `{}` by the current audit pipeline. Existing audit rows remain immutable; any correction must be an append-only supplement with verified source evidence.

## Release integration and migration ordering

Release `5f721629294249c8e9bd16b124f8b770253b50c3` on `fix/item-revenue-routing` — the supplier-statement fix, invoice dimensions, item-based revenue routing and account-profile corrections — is integrated here. The tree's pricing work predates it and was committed first, so the merge reads as "the release on top of the prices".

HR's migrations run after main's own 0256–0260: `0261_hr_time`, `0262_hr_payroll`, `0263_hr_advances`, `0264_hr_talent` at journal times …071–…074. HR-3 to HR-5 first reached main as `0257_hr_payroll`, `0258_hr_advances`, `0259_hr_talent` at …064–…066 — earlier than main's …066–…070, so a database past those would have skipped them. `migrate.ts` › `recordRenamed` records each under its new time where its tables already exist and runs one an earlier name had skipped; a new HR migration takes a `when` after the journal's last entry, as every migration does.

Production applied migrations `0197` and `0200` with journal timestamps `1795900000001` and `1795900000002`. Drizzle orders execution by `_journal.json` timestamps, not filename numbers, so the pending `0198`/`0199`/`0201` migrations are appended after the latest journal entry with strictly greater timestamps. Never rewrite an applied migration and never sort the journal by filename.

## Inventory: one ledger, and the scripts that must respect it

`inventory_movement` is the only source of stock quantity. `stock_position`, `positionOf`, the Stock Movement page and the Warehouses Report's Quantity column all sum it; `cost_layer` carries the value. Every document that moves stock writes its rows in the same transaction, so the two cannot drift through the application — only through maintenance.

When a new document table that moves stock is added (migration), add it to **both** `tests/integration/setup.ts` (`resetTestData`) **and** `scripts/ops/format-live-database.sh` (`DOCUMENT_TABLES`). The 2026-09-27 orphans (`TRF-HQ-2026-000001/2`, `ADJ-HQ-2026-000001`) were the format script wiping `inventory_movement` while `stock_transfer`/`stock_adjustment` were missing from its list.

To check a live database: `npx tsx scripts/ops/stock-movement-trace.ts [warehouse] [item]` prints every movement with a running balance and runs `services/inventory-integrity.ts` (documents without ledger rows, rows without documents, unbalanced transfers). To remove a verified orphan document: `scripts/ops/remove-orphan-stock-documents.sh [--yes] TRF-… ADJ-…` — it refuses anything that has movements and writes an `audit_event` per removal.

The Warehouses Report's *Total Price* is IQD at FIFO cost, not a quantity and not a selling price: 507 units bought as 10 @ 50 and 500 @ 500 less 3 sold is 250,350 IQD.

Integration suites: `npx vitest run --project integration tests/integration/ops15-inventory-ledger.test.ts` (≈3 min) covers the lifecycle, warehouse isolation, returns, transfers, shipment stages, concurrent double-posting, negative stock, the integrity checks, invoice reversal, the form-id idempotency key, the warehouse-branch rule, the Stock Ledger and paging. `ops16-document-table-lists.test.ts` derives the document tables from the schema and fails if `format-live-database.sh` or `resetTestData` omits one.

**Two test runs must not share a database.** Another worktree running `test:integration` against `erp_test` at the same time resets it under you — every test fails with "not found" and RLS 42501 errors that look like real bugs. Point `DATABASE_URL_TEST` at your own database (e.g. `erp_test_ledger`; create it as `erp_owner` with `template0`, `lc_collate 'C'`, and `grant connect … to erp_app`).

## Live server (2026-09-27 onward)

* `/opt/qs-erp-next/var/LIVE` marks the database as live; `format-live-database.sh` refuses while it exists. Do not remove it for a trial.
* Cron: nightly 02:15 `inventory-integrity-check.ts` (notifies accounting managers in-app; log `/var/log/qs-erp/inventory-integrity.log`); weekly Sunday 03:00 `restore-drill.sh --local` (log `/var/log/qs-erp/restore-drill.log`). A red drill is a defect in the live data, not in the backup — see `docs/RUNBOOK-database-recovery.md`.
* Known open item: `CASH-ACCOUNTANT_ERBIL` points at a deleted `chart_of_account`; until it is re-linked on the Bank/Cash Accounts screen the restore drill fails on that foreign key.
* `deploy.sh` runs the integration suite; `SKIP_INTEGRATION=<reason>` skips it and records the reason in `var/deploy-skips.log`.
* Server notes and credentials live in `~/.config/qs-erp/vps.md`, outside the tree.

## Correcting a posted invoice

A posted AP or AR invoice is **reversed** (`ap.reverse` / `ar.reverse`, the Reverse action on its page), never edited: the journal is mirrored through `journal.reverse`, every stock movement is put back through `inventory.reverseMovement` (onto its own FIFO layers), status → `reversed` with `reversal_reason`. Refused while a payment, return, credit memo or payment run rests on it, or while stock from a purchase has been sold or moved on. The reversal is dated the day it is made, so the current period must be open. A Sales/Goods Return is for goods that come back; a reversal is for an invoice that should not have been posted.

## Stock movements carry the warehouse's branch

`inventory.receive/issue/issueFromLayer` refuse a `branchCode` that is not the warehouse's, and migration 0215 holds the same rule by trigger on `inventory_movement` and `cost_layer`. Pass the warehouse's branch (the actor's, after `usableWarehouse`, is the same thing).

## Transfer and Reconciliation forms carry a one-time id

The page mints a UUID into `document_id`; `stock.transfer` / `stock.adjust` take it as the document's id and answer with the existing document on a repeat. New forms that create a stock-moving document on submit should do the same.

## Theme verification

The active appearance belongs to `.erp-root[data-palette][data-accent]`. Palette and accent previews also carry those data attributes, so root-level `:has()` selectors must target `.erp-root`, not arbitrary descendants. Window tokens (`--w-*`) and the generic UI tokens are connected in `src/components/admin/admin.module.css`; dark selection/focus colors must remain readable when an accent changes. Checkboxes use the yellow `--w-check` token and `--w-check-ink` for white marks on light palettes or dark marks on dark palettes. Forced-colors mode restores native checkbox rendering.

Run `npx playwright test tests/e2e/theme-readability.spec.ts --workers=1` against the seeded local development server. It checks all 90 palette/accent combinations without saving appearance settings, along with checkbox keyboard behavior, notifications, shared route-state styling, and the export menu at mobile LTR/RTL widths. Pearl (`pearl`) and Deep Ocean (`ocean`) require migration 0216. Migration 0217 adds Obsidian Plum, Evergreen, Espresso, Lunar Slate, Ivory Linen, Glacier, Sage White, Porcelain Rose, Dune Bronze, and Harbor Mist; `tests/integration/appearance-palettes.test.ts` checks personal and company persistence for every palette and rejection of unknown names.

## Screens copy existing models — the design must not change

Standing rule (by direction, 2026-10-01; see also docs/notes/newsettings.md: "DO NOT CHANGE THE CURRENT DESIGN"). A new or changed screen must be indistinguishable in style from the existing ones:

* A **list screen** copies `src/app/(app)/payables/invoices/page.tsx`: AdminPage → `tabs={<SectionTabs route=…/>}` → title/subtitle → ListToolbar (search; filters and saved views as filter controls — a `filterBar`/`FilterRow` form with `Select`/`Field`, never links in the header) → the standard register table (`s.sapRegisterTableWrap` / `s.sapRegisterTable`, `s.sapNum` for numbers) → paging. Nothing else.
* A **record/document screen** copies `src/app/(app)/payables/invoices/[invoiceNo]/page.tsx`: AdminPage → SectionTabs → DocumentWindow (standard header fields, status chip, actions row, lines) → further registers stacked underneath in the supplier-statement manner (own `s.sapDoc`/`s.sapWindow`/`s.sapTitle` sections, not tabs) → RecordHistory, Attachments.
* A **dialog** uses NewRecordDialog / Dialog from `@/components/admin/dialog` with Form, Field, Grid, Select, Submit, SubmitRow.
* A **settings screen** copies `src/app/(app)/administration/numbering/page.tsx`.
* Only classes that already exist in `src/components/admin/admin.module.css` and `src/components/ui/*.module.css`. No new CSS classes, modules, inline styles, colours, fonts, spacing values, icons or layout patterns. If something cannot be expressed with what exists, stop and ask.
* Never draw your own navigation, header rows, tab rows, chip rows or banners. Navigation is SectionTabs; status is the existing status chip (`status status--<x>` + `data-status`); a warning or stop is the existing Flash / `s.sapNote` banner in its existing colours.
* Before a screen is called done: `npx playwright test tests/e2e/theme-readability.spec.ts --workers=1` passes, and two side-by-side screenshots (the new screen beside the model it copies, desktop EN and mobile AR) are shown for approval. If a reviewer could tell which one is new from the layout alone, it is not done.

## Operations (REQ-IMPROVE-001 IMPROVE-1)

* `/healthz` answers 200 only when the database answers and the migrations are at head (`services/system-health.probe`); the footer light and `deploy.sh` read it. A migration that the application role must read (the `drizzle` schema) is granted in 0239 — keep it.
* Every script that writes fixtures refuses while `var/LIVE` exists (`scripts/lib/live-guard.ts` / `.sh`); a script whose purpose is the live database is listed with its reason in `tests/unit/im04-live-guard.test.ts`. Add a new writing script to one or the other.
* Scheduled jobs are lines in `scripts/ops/crontab.erp`, each through `run-job.sh` (flock, timeout, log, `var/jobs/<job>.last`); the Background Jobs screen parses that file. A new job is a line there, nothing else.
* Exports: read and audit inside the transaction (`prepareExport`), render after it (`renderExport`); `EXPORT_ROW_CAP` (20,000) over every table of the model. A new report that lists many rows reads `EXPORT_ROW_CAP + 1` rows so the cap trips rather than the list's page size.
* Request id: `currentRequestId()` (`src/server/request-id.ts`) — nginx's `X-Request-ID` or a minted UUID — goes on every audit row from `runAdmin`; errors are logged by `src/instrumentation.ts` with the digest the error page shows.
* The host, the environment keys, nginx, pm2, the crontab and the escrow are `docs/RUNBOOK-host-build.md`; backups, drill and recovery are `docs/RUNBOOK-database-recovery.md`. A release is `docs/RELEASE.md` (version, CHANGELOG, tag, deploy from `main`).
* `vitest` is pinned at 4.1.10 (B-IM-6): npm 10 cannot resolve 4.1.11's peer set, and the server's npm 10 rejects a lock from npm 11. Do not "fix" the audit by bumping it without checking `npm ci --dry-run`.

## Legacy books import (REQ-LEGACY-001)

* `src/server/domain/legacy-books.ts` reads the old system's export as data (header recognition, Arabic amounts/units/dates); `src/server/xls-read.ts` reads BIFF8 `.xls` with nothing but Node; `services/legacy-import.ts` dry-runs and applies. The partner code is the old account number; dollar balances post in dinars at the old books' implied rate (B-LG-3); opening stock is raised and submitted, never approved by the import (B-LG-2); the in-transit warehouse and negative quantities are never stock.
* The posting event `legacy.opening_balance` reuses the `customer_receivable`, `supplier_payable` and `opening_balance` roles; 0240 copies their rules.
* `legacy_document` and `legacy_import_run` are in `resetTestData`. Do not re-post the old registers as documents: the balances already carry the position.

## HR (REQ-HR-001 Stage HR-1)

* `services/employees.ts` is the only writer of `employee`, `employee_history` and `employee_compensation` (`tests/unit/hr01-event-coverage.test.ts` holds it): every move is a dated history row, identity is audited in place, compensation is a dated row under its own grant that the database policy checks itself (`app_has_grant`). `services/hr-settings.ts` holds positions, pay components, leave types and calendars — deactivated with a reason, never deleted.
* The HR screens live under `/hr/…` and `/administration/hr-settings`; the section's remaining items arrive with HR-2 to HR-4. The series `EMPLOYEE` is kept by `resetTestData`.


## WhatsApp bridge and the delivery runner (REQ-WA-001 WA-1/WA-2)

* A question from WhatsApp is answered by `services/whatsapp.answer` **as the asking user, in a transaction PostgreSQL holds read-only** (`withReadOnlyScope`: the asker's RLS scope plus `set local transaction_read_only = on`). Only a user holding the `ceo` role whose contact row allows queries is answered; everyone else gets silence and a `whatsapp.refused` audit row. Never widen this: a new intent is a read-only service call added to `domain/whatsapp.ts` (the phrase patterns) *and* `services/whatsapp-router.ts` (`INTENT_TOOLS`, the model's whitelist) *and* `services/whatsapp.ts` (`draft`), with a case in `tests/unit/wa02-router.test.ts` and `tests/integration/wa02-intents.test.ts`. The two lists are held equal by the unit test.
* Attachments are the ERP's own print models through the ERP's own renderers (`print/reports.ts` builders, `renderPdf`/`renderXlsx`): a PDF from WhatsApp is byte-identical to the export route's. The bridge writes the audit rows the screen would have (`auditAnswer`) after sending.
* `notifications.deliver` leaves a channel with no registered sender **pending** for the process that owns it; `DeliverySuppressed` marks a row `suppressed` (no address, notifications off, mail unconfigured); failed rows retry per `domain/notifications.isDeliveryDue` (1 / 10 / 60 min, three attempts). `scripts/ops/deliver-notifications.ts` (cron, every five minutes) owns e-mail; `scripts/ops/whatsapp-bridge.ts` (a service, `deploy/whatsapp-bridge.service`) owns WhatsApp. Both run `services/notification-runner.runOnce` as the system operator.
* `whatsapp_message` and `whatsapp_contact` are never deleted (triggers); retention blanks message bodies (`redactExpired`), rows stay. `resetTestData` truncates them and restores the seeded `whatsapp_setting` rows. The pairing could not be exercised in the build sandbox (no route to WhatsApp's servers): the first run on a host that has one is the test — `docs/RUNBOOK-whatsapp.md`.

## Closing controls (REQ-IMPROVE-001 IMPROVE-2a)

* A **closed** period is closed at the database (0243): a journal cannot enter `posted` with a posting date in it, a stock movement cannot be dated in it, and periods close in sequence. Soft close stays the application's override path (`periods.authorisePosting`). A fixture or test that needs a closed month closes every earlier month first (`accounting-periods-rates.test.ts` › `closeThrough`).
* `periods.setPeriodStatus(…, 'closed')` runs `services/closing-checks.report` and refuses on a blocking failure; the checklist is on `/finance/periods` and in the nightly `closing-checks` job. Add a check by adding it to `CHECK_CODES`, `report`, both locales (`admin.periods.check_<code>`), `docs/CONTROLS.md` and `im10-period-close.test.ts`.
* `docs/CONTROLS.md` is the register of enforced controls; `tests/unit/im15-controls-register.test.ts` holds every row to a test file and, for a database control, a migration. A new trigger or constraint that enforces a rule gets a row.

## Project System (REQ-PM-001 Stage PM-1)

* `services/project-system.ts` is the Project System's writer over Phase 11's `services/projects.ts` (which keeps creating customer projects, costs, certificates and variations): definition, status profile (`domain/project-system.ts` `TRANSITIONS` — draft → active by somebody other than the creator; on_hold; closing; closed; reopen once), the WBS elements under the coding mask `{PROJECT}-{N}` dotted to five levels (`nextWbsCode`), and the settings (types, tolerance profiles, cost codes — deactivated with a reason, never deleted).
* An element carries three operative indicators. `projects.assertAccountAssignmentElement` refuses a cost or a material issue naming an element without `is_account_assignment`; every service that posts to a `wbsCode` calls it. `rollUp` sums each element's budget, commitment, actual and available over its subtree; `availabilityState` reads the project's tolerance profile.
* The series `PROJECT` (PRJ) is kept by `resetTestData`; `project_type`, `project_tolerance_profile` and `project_cost_code` are restored to their seeds there. Migration 0245 adds the columns and tables; the `project_wbs_level_from_parent` trigger sets `level` from the parent.
* The screens: `/projects` (list and record copying the Purchase Invoices pair; the record's lines are the tree, read-only — elements are added from the actions row and changed on `/projects/wbs`), `/projects/contracts`, `/projects/wbs`, `/administration/project-settings`. Tests: `tests/integration/pm01-structure.test.ts`, `tests/unit/pm01-project-system.test.ts`, `tests/e2e/projects.spec.ts`.

## Project System — planning and budget (REQ-PM-001 Stage PM-2)

* `services/project-budget.ts` holds the budget documents (`project_budget_document` + lines; original / supplement / return / transfer, four eyes held by the table), the cost plan (`project_plan_version` / `project_plan_line`, month by month, one current version), availability control and the change orders' lines. `projects.ts` and `project-budget.ts` import each other by design (functions only): `PERMISSION_OBJECT` there is a literal, never `projects.PERMISSION_OBJECT`, because a binding read while the other module is loading is undefined.
* The budget by element has one source, `ownBudgetByElement`: the approved documents once the original is approved (its approval wrote Phase 11's `project_budget_line.baseline_iqd`, so the lines are not counted again); before that Phase 11's lines by element; before any, the definition's revised budget on the root. `projects.budgetFor` reads a cost code's revisions from the documents once they exist, else from the variation deltas.
* Every commitment, cost and issue that names a `wbsCode` goes through `projects.assertSpendable` → `budget.assertAvailable`: refused above the stop line (the profile's, or the element's raised `stop_percent_raised`), the responsible person and the project manager notified once as the warning line is crossed (`project.availability_warning`, deduped per element per day), the crossing audited. The cost code's own check is held to the same line, so a raised line is not undone by it. Percentages are compared exactly as scaled bigints — a dinar over the line is over it.
* A change order (`project_variation` + `project_variation_line`) is approved twice by people other than its raiser; the second approval raises and approves the supplement (or return) its lines describe and moves the forecast finish; the baseline never moves (R2). Series `PROJECT_BUDGET` (PBD) is kept by `resetTestData`; change orders keep Phase 11's `PROJECT_VARIATION` (PVR).
* Screens: `/projects/budgets` (+ `/new`, `/[no]`), `/projects/change-orders` (+ `/new`, `/[no]`), `/projects/plan`; the new-document pages copy the Sales Return's new page (the project named first, then one amount per element and cost code in `sapCellField` cells). Tests: `tests/integration/pm02-budget.test.ts`, `tests/unit/pm02-project-budget.test.ts`, `tests/e2e/projects-budget.spec.ts`.

## Project System — execution (REQ-PM-001 Stage PM-3)

* `services/project-execution.ts` is what purchasing calls at the moments §8 names: `checkAssignment` (project, element, cost code — together or none; the element an active account-assignment one) on `purchase-order.create`, `payables.create` and `ap-invoice.create` (an invoice inherits its order's assignment); `commitForOrder` on `purchase-order.approve`; `commitForPayable` for a payable without an order; `releaseFor` on cancellation; `recordInvoiceCost` / `reverseInvoiceCost` on `ap-invoice.post` / `reverse`. Like `project-budget.ts` it imports `projects.ts` and is imported by the purchasing services, so its `PERMISSION_OBJECT` is a literal.
* An assigned invoice's journal lines carry the `project` dimension. Services and their variance become a `project_cost` row (`source_type = 'ap_invoice'`, `consumed_commitment_id` the promise it consumed — only what exceeds the open promise is checked anew); goods only settle the promise, because they are stock until a Material Issue takes them to the element at FIFO. So Project Costs' line items equal the journal lines with the dimension on expense accounts plus the issues — the screen shows both figures and says why they differ when they do.
* A reversal is a negative `project_cost` row naming the row it undoes (`reverses_cost_id`, unique) and gives the consumed promise back; the journal's own reversal is the invoice's.
* `project_material_issue` (+ lines) is a stock-moving document: in `resetTestData` and `format-live-database.sh`, the series `PROJECT_ISSUE` (PMI) kept; the form mints `document_id`; posting locks the row `for update`, moves each line through `projects.issueToProject` / `returnFromProject` (a return names the unit cost it went out at) and records each line's movement and cost row.
* Screens: `/projects/material-issues` (+ `/[no]`), `/projects/costs`, `/projects/procurement`; the purchase invoice form offers the element and cost code. Tests: `tests/integration/pm03-execution.test.ts`, `tests/e2e/projects-execution.spec.ts`.

## Project System — schedule and earned value (REQ-PM-001 Stage PM-4)

* `domain/project-schedule.ts` is pure: the working calendar (HR-1's `working_calendar` + holidays; none is Sunday–Thursday), the critical-path pass on **time points** (point k is the start of working day k; an activity of d days runs s → s+d; a milestone is one point, shown as the day that ends at it), and the §10 arithmetic in scaled bigints (`earnedValue`, ratios ×10,000, `ratioText` to two decimals). `tests/unit/pm04-project-schedule.test.ts` holds a hand-worked network — change the pass and that test says whether the dates moved.
* `services/project-schedule.ts` writes activities (codes A0010, A0020, …), links (deactivated, never deleted; a loop refused), the schedule (`scheduleProject` locks the project row, writes every activity's dates and float, bumps `project.schedule_run` and appends a `project_milestone_history` row per milestone — append-only by trigger, cleared by `TRUNCATE` in `resetTestData` and the master-data format), actuals, and milestones reached by one person and approved by another. A `progress` milestone's approval is a `project_progress` row (`activity_id` set) measured by the reporter and approved by the approver.
* Earned value (`earnedValueTree`) sums each element's own budget, plan to the day (`plannedValueAt` prorates the day's month), earned (latest approved percent × own budget) and actual up the tree **before** taking ratios. `ps.technicalComplete` refuses while `openActivities` returns anything.
* Screens: the schedule and its links are stacked under the tree on `/projects/wbs`; `/projects/progress` is the Progress workspace. Tests: `tests/integration/pm04-schedule.test.ts`, `tests/unit/pm04-project-schedule.test.ts`, `tests/e2e/projects-schedule.spec.ts`.

## Project System — billing, recognition, forecast (REQ-PM-001 Stage PM-5)

* `services/project-billing.ts` (pure rules in `domain/project-billing.ts`) is the billing plan, the certificate's approval and posting, recognition and the forecast. `projects.certify` keeps Phase 11's arithmetic; a plan-line certificate passes `basis: 'billing_plan'`, which the service and the 0249 trigger exempt from the measured-progress cap.
* A certificate is not an AR invoice (D-PM-11): its approval posts `projects.certificate` — `customer_receivable` and `project_retention_receivable` (both constrained to the customer sub-ledger in `POSTING_MAP`), `project_revenue`. The roles `project_retention_receivable`, `project_wip` and `project_deferred_revenue` are Finance's to map; 0249 copied the receivable and revenue rules from `sales.ar_invoice`. A posting that needs an unmapped role refuses with the role's name.
* Recognition (`runRecognition`) refuses until `project_recognition_policy` 'DEFAULT' is ratified (`ratifyPolicy`, `configure` on `project_setting`); `resetTestData` puts it back to unratified. One row per project and period end; the earlier run is reversed by its own journal (source event `reversed`) dated the first day of the period being run. EAC is `forecast(...)`'s root — keep the Forecast report and recognition on that one function.
* A billing milestone's approval calls `billing.refreshDue`; a milestone with a live plan line cannot be cancelled. The close check `project_recognition` loads the billing service lazily (`await import`) so the catalogue unit test stays database-free.
* Screens: `/projects/billing` (workspace + `[no]` certificate page), `/projects/forecast` (report), the ratify section on `/administration/project-settings`. Tests: `tests/integration/pm05-billing.test.ts`, `tests/unit/pm05-project-billing.test.ts`, `tests/e2e/projects-billing.spec.ts`, and the `project` intent in `wa02-router` / `wa02-intents`.

## Project System — close, settlement, labour, reports (REQ-PM-001 Stage PM-6)

* `services/project-close.ts` (pure rules in `domain/project-close.ts`) holds the close checklist (`closeChecks`: Phase 11's five + open activities, billing lines, draft certificates, unposted hours, settlement), the settlement (`createSettlement` / `postSettlement` / `cancelSettlement`, one per project, four eyes held by the table) and timesheets (`bookHours`, `approveHours`, `cancelHours`, `postLabour`). `ps.close` goes through `closing.close`; Phase 11's `projects.close` stays the inner step.
* Settlement marks `project_cost.settlement_id`; `projects.closeoutState` counts a settled row as accounted for, and `assertSpendable` refuses any cost on a settled project. `recordCost` alone accepts a `closing` project (work already done); commitments and issues still need `active`.
* `postLabour` authorises `view` on `employee_compensation` (the rate is pay) and reads the compensation in force at the month's end; the absorption line carries no project dimension, on purpose. A Material Issue posts `projects.material_issue` in `postIssue` (D-PM-13).
* The four reports are `print/project-reports.ts` (`BUILD`, export keys `project_cost_report`, `project_line_items`, `project_milestone_trend`, `project_earned_value`); the Reports screen draws the builder's own model, so screen and copy are one set of figures. A new role in `POSTING_MAP` needs an account in the `ops13`/`ops14`/`ops15` fixtures, which map every role.
* Screens: `/projects/close`, `/projects/reports`, the Hours section on `/projects/progress`. Tests: `tests/integration/pm06-close.test.ts`, `tests/unit/pm06-project-close.test.ts`, `tests/e2e/projects-close.spec.ts`.

## Client messages and the load run (REQ-HARDEN-001 HARDEN-4)

* The root layout hands `NextIntlClientProvider` only `CLIENT_NAMESPACES` (`src/i18n/client-messages.ts`). A client component that needs another namespace adds it there; `tests/unit/hd19-client-messages.test.ts` fails on a `useTranslations` outside the list. Server components keep `getTranslations` and see everything.
* A code shown on a screen (status, kind, lane, outcome) goes through a translation with a `.has` fallback; `tests/unit/hd18-no-raw-enum.test.ts` greps for `{x.status}` and the like. A seeded code table read by a screen gets its keys in both locales (`hd18-seeded-labels`).
* The A21 load run is `scripts/load/seed-payables-volume.ts` (a database made for it, never `.env`'s) and `k6 run tests/load/payables.js`; `docs/RUNBOOK-host-build.md` › *Load run*. The figures live in REQ-HARDEN-001 §3.I.

## Menu headings and Bank Deposits (REQ-FIX-001 FIX-1)

* A module's dropdown is its sections in `MODULE_DEFINITIONS` (`erp-shell.tsx`), one heading each; a page's section tabs are the screens of its own section. Payables is `payables`, `payables_payments`, `payables_suppliers`, `payables_setup`; Logistics is `logistics_customs`, `logistics_shipping`, `logistics`; sections 21–25 are REQ-FIX-001's, after Appendix A's twenty. An item that leaves the section its route was derived from **names its route** (`href`) — routes never move with the menu (D-FX-1). `tests/unit/fx1-menu.test.ts` holds the layout.
* Bank Deposits (`/treasury/deposits`, `services/bank-deposits.ts`) is a register over `bank_transfer` (cash → bank) and `other_receipt` (any other source) into a *bank* account; it raises, approves (not by the raiser) and posts through those documents' own services. Bank and Cash Reporting tells a transfer by `bank_transfer.journal_entry_id`, never by `source_module`.
* Two forms in one page must not share field names (`f-<name>` ids); the dialog's title id is per dialog (`useId`).

## Availability and the password screen (REQ-FIX-001 FIX-2)

* `/inventory/availability` reads `services/availability.ts` (the `stock_position` view, which has no row-level security of its own, so the branch rule is applied in the query — keep it there). Issuing is `execute` on `inventory_movement`, from a dialog, with the warehouse's branch.
* `/password` is `src/app/password/` — outside `(app)`, drawn with `sign-in.module.css` like sign-in. `RESTRICTION_ROUTE.password` still names it; `PasswordField` takes `name`, `autoComplete` and `hint`.

## The import and its invoices (REQ-FIX-001 FIX-3)

* `ap-invoice.post` applies the deposits of the invoice's own import (`supplier-advance.applyToPostedInvoice`, authorised by the posting). An advance raised by hand against an order is the accountant's (D-FX-6).
* `payables.refreshFromInvoices` sets `amount_txn` from the posted invoices when the payable is in IQD; a foreign-currency import keeps its agreed amount and closes on `services/import-exchange.ts` (`payables.exchange_difference`: supplier payable, supplier advance, exchange gain/loss) when `payment-applications.confirm` makes it fully paid — in a savepoint, so an unmapped role leaves the payment confirmed and an `EXCHANGE_DIFFERENCE` "waits" event; `settleExchangeDifference` books it later. One `payable_exchange_difference` row per document closed.
* The supplier advance's three events are on `POSTING_MAP`; a new role there needs an account in the `ops13/14/15` fixtures.
* Invoice Status Tracking (`supplier-shipment`) excludes `is_import` invoices and refuses to advance one.


## Units of measure (REQ-FIX-001 FIX-4)

* `services/item-units.ts` is the only writer of `item_uom` (add, defaults, deactivate with a reason — never deleted). The base unit is kept active by the service and by the `item_uom_base_stays_active` trigger (0254); one active purchase default and one sales default per item (partial unique indexes); with none flagged, the base unit is the default.
* A purchase line carries the unit it was bought in; stock, cost layers and the payable's quantity are in the base unit — convert with `item-units.toBaseQuantity` / `domain/uom.toBaseExact` (refused when it does not divide), cost per base unit with `costPerBase`. A line from an order keeps the order's unit. Goods receipts and goods returns convert the same way.
* A sale is written in the base unit (D-FX-8); `ar.createDirect` refuses another. Selling in other units is a later stage across sales orders, delivery notes, pick lists and returns.
* Tests: `tests/integration/fx4-units.test.ts`, `tests/e2e/fx4-units.spec.ts` (adds BOX = 24 to ITM-SEED on the dev database).

## HR structure and the user link (REQ-FIX-001 FIX-5)

* A new user is also an employee unless the form's *Also an employee* is unticked: `users.create` → `employees.createForUser` in the same transaction (the user grant suffices — D-FX-9), the user's default branch, the chosen or first ticked department, hired today. `employees.ensureForUsers` / `scripts/ops/ensure-user-employees.ts [--apply]` backfills existing active users once; `deploy.sh` runs it after the migrations.
* HR menu order is the sponsor's (`tests/unit/fx5-hr-menu.test.ts`); unbuilt items keep derived routes until their stage (REQ-HR-001 §11a lists what is left — set aside by the sponsor for now). `/hr/departments` and `/hr/positions` read `services/hr-structure.ts`; positions are written by `hr-settings.ts`, code minted from `POSITION_CODE` (0255). `/hr/organisation` redirects to Departments.
* Tests: `tests/integration/fx5-hr-structure.test.ts`, `tests/e2e/fx5-hr.spec.ts`.

## HR time — leave and attendance (REQ-HR-001 Stage HR-2)

* `services/leave.ts` writes `leave_request` and `leave_balance_entry`; `services/attendance.ts` writes `attendance_day`; `domain/hr-time.ts` is the pure arithmetic (days in hundredths as bigints, the calendar, entitlement by months served, carry-over, the day's status). `tests/unit/hr02-time.test.ts` holds the arithmetic.
* A day reads approved leave over the sheet over the calendar (B-HR-9) — approval writes no attendance rows, so nothing is deleted on a cancellation. The year's calendar is the year's active `working_calendar` (first by code), else Sunday–Thursday.
* A leave is decided by the person's manager through `employee.manager_employee_id` → the manager's `app_user_id` (no grant needed), or by `approve` on `leave_request`; never by `requested_by` (also a check constraint) nor the person. `app_employee_reach(employee_id)` (definer) lets the person and their manager read the request under RLS.
* In a one-table Drizzle select a column inside a `sql` subquery prints bare (`"manager_employee_id"`), which the subquery then reads as its own alias's column: qualify it by hand (`"employee"."manager_employee_id"`).
* The sweep is `scripts/ops/hr-sweep.ts` (crontab 06:30); its limits are `hr_parameter` rows on HR Settings. `leave_request`, `leave_balance_entry`, `attendance_day` are in `resetTestData` and `format-live-database.sh`; the series `LEAVE_REQUEST` (LVE) is kept.
* Payroll (HR-3) reads `attendance.summary(employeeId, from, to)`.
* Tests: `tests/integration/hr02-time.test.ts`, `tests/unit/hr02-time.test.ts`, `tests/e2e/hr-time.spec.ts`.

## HR payroll (REQ-HR-001 Stage HR-3)

* `services/payroll.ts` writes `payroll_run`, `payroll_line`, `payroll_line_component`, `payroll_payment`; `domain/payroll.ts` is the pure arithmetic (`computeLine`, whole dinars half up) and the journal (`journalPlan`). `tests/unit/hr03-payroll.test.ts` holds the worked example (B-HR-15) — change the rules and that test says which payslip moved.
* A draft is recomputed whole from the facts (compensation in force at the month's end, `employee_pay_component`, the components' defaults, `attendance.summary`); only `manual` components are typed, with a note, and survive a recompute. Approval approves the stored figures; posting posts them. Posted lines are frozen by `payroll_line_frozen`.
* Who: the HR manager prepares and sends (the run is a sheet of salaries), the accounting manager or the CEO approves — never the preparer or sender (check constraint) — and Finance posts, pays and reverses (B-HR-13).
* Posting: `hr.payroll_run` (roles `salary_expense`, `payroll_employer_cost` by department; `payroll_withholding`; `net_pay`), or a component's own `expense_account_id` / `liability_account_id`. Paying: `hr.payroll_payment`, one payment per pay method from a bank or cash account (the line names its own account and `bankAccountCode`). There is no supplier payable behind payroll (B-HR-14). A role named `*payable*` must be a supplier control account — that is why the net is `net_pay`.
* RLS: runs and lines need `payroll_run` view by branch (`app_has_grant`); the person reads their own posted payslip (`app_own_payslip`) and of the run only `app_payslip_header`. The cash forecast (`app_payroll_outflows`) and the close check `payroll_posted` (`app_payroll_month_gaps`) read through definer functions, totals only. The `payslip` export is `selfService` in `print/access.ts`.
* `employee_pay_component` is written only by `services/employees.ts` (`setPayFigure`, held by `hr01-event-coverage`), append-only. `payroll_*` are in `resetTestData` and `format-live-database.sh`; the series `PAYROLL_RUN` (PAY) and `PAYSLIP` (PSL) are kept; `resetTestData` puts the seeded components back (no accounts, the D-HR-3 rates).
* Tests: `tests/integration/hr03-payroll.test.ts`, `tests/unit/hr03-payroll.test.ts`, `tests/e2e/hr-payroll.spec.ts`.

## HR advances, loans and equipment (REQ-HR-001 Stage HR-4)

* `services/employee-advances.ts` writes `employee_advance` and `employee_advance_recovery` (append-only); `domain/advances.ts` is the pure schedule (`instalmentPlan`, `dueBy`, `recoveryFor`, `allocateRecovery`, `behindSince`). It is **not** `cash_advance` (petty cash, B-HR-18). `services/payroll.ts` imports it; it never imports payroll.
* Endorse: the person's manager by the link or `approve`; approve: `post` (Finance); pay and cash repayment: `execute`. Check constraints keep the asker, the person and the endorser off the later steps.
* Payroll: the `advance_recovery` component (seeded ADVANCE) reads `dueForMonth`; `computeLine` takes it last and caps it at the net; `journalPlan` credits `employee_advance`. `payroll.post` calls `recordPayrollRecovery` (refuses if the advances moved since the run was computed); `payroll.reverse` calls `reversePayrollRecovery`.
* `services/employee-assets.ts` writes `employee_asset` (equipment; one holder per fixed asset) and reads the clearance. `employee` is in ops16's `NOT_DOCUMENTS`: `employee_advance` would otherwise make it a header.
* Events `hr.employee_advance`, `hr.employee_advance_repayment`; the role `employee_advance` is in the ops13–15 fixtures. Series `EMPLOYEE_ADVANCE` (EADV) kept by `resetTestData`. The sweep's `advancesBehind`.
* Tests: `tests/integration/hr04-advances.test.ts`, `tests/unit/hr04-advances.test.ts`, `tests/e2e/hr-advances.spec.ts`.

## HR recruitment and performance (REQ-HR-001 Stage HR-5)

* `services/recruitment.ts` writes `vacancy`, `applicant` and `applicant_stage` (append-only); `domain/talent.ts` holds the pipeline (`nextStages`, `assertStageMove` — forward only, a closing note), the transitions and the review arithmetic. Draft and move: `create` / `edit_draft` on `recruitment`; open, amend, close and hire: `approve`. A hire is `employees.create` (its new `reason` argument names the application on the first history row) in the vacancy's branch, department and position, refused when the national id is already somebody's (R1). The last hire fills the vacancy; a filled or closed vacancy rejects the rest of its pipeline, each with a stage row. The vacancy is locked before its applicant everywhere.
* `applicant` is read under `app_has_grant('recruitment','view')` in its row policy, not by the branch alone; its CV is an attachment (`applicant`), checked in `attachments-runtime.ts`, so the download route knows it without loading the service.
* `services/performance.ts` writes `review_cycle` (on HR Settings, `configure` on `hr_setting`), `performance_review` and `review_goal`. HR (`create`/`edit_draft`) starts reviews and sets goals; only the reviewer rates and finishes (`complete` → `overallRating`, Σ weight × rating ÷ 100, the weights making 100); `approve` signs off — never the reviewer (check) nor the person (`performance_review_guard`); the person comments once. `review_goal_frozen` keeps goals to a draft; a signed-off or cancelled review is frozen but for the person's word. A cycle closes only when `app_cycle_open_reviews` is 0. `app_review_reach` lets the person and the reviewer read a review without the grant.
* Sweep: `vacanciesOverdue` (`hr.vacancy_overdue`, rule `hr_vacancy_overdue`). Dashboard: `reviewsAwaiting`, `hiresAwaiting`. Employee page: *Hired from* and the Performance reviews section. Series `VACANCY` (VAC), `APPLICANT` (APL), `PERFORMANCE_REVIEW` (REV) kept by `resetTestData`; the five tables are in both reset lists (no journal, so ops16 does not ask).
* Screens: `/hr/recruitment` (+ `/[vacancyNo]`, `/applicants/[applicantNo]`), `/hr/performance` (+ `/[reviewNo]`), the Review cycles window on HR Settings. Tests: `tests/integration/hr05-talent.test.ts`, `tests/unit/hr05-talent.test.ts`, `tests/e2e/hr-talent.spec.ts`.
