<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Isolated database verification

`scripts/seed-dev.ts` uses `DATABASE_URL`, not `DATABASE_URL_OWNER`. Setting only the owner URL does not redirect the seed. For isolated verification, explicitly point `DATABASE_URL` and `DATABASE_URL_TEST` at the intended isolated database, and verify the running development server uses that same database before browser tests. Never rely on `.env` defaults for a seed or test run.

## Business dates and money (REQ-HARDEN-001 HARDEN-2)

* "Today" is `businessToday()` from `src/server/domain/business-date.ts` (Asia/Baghdad, `ERP_TIMEZONE`); a timestamp becomes a date with `businessDateOf(instant)`. Never `new Date().toISOString().slice(0, 10)` — it is UTC and reads yesterday for the first three hours of every Baghdad day. `tests/integration/hd07-business-today.test.ts` greps for it and fails the build. SQL that needs today binds `${businessToday()}::date`, never `current_date`.
* Money and quantities are compared and summed as scaled bigints (`parseDecimal` / `parseQuantity` / `divideHalfUp` / `toDecimalString`), never as `Number()`; in the browser the same through `src/lib/decimal.ts`. A `Number()` is only ever the last step before `Intl.NumberFormat`.
* A transition reads its row with `FOR UPDATE` (`lock(tx, id)` in payment-applications, loans, customs-pd, payables; `importOf(…, { lock: true })` in landed-cost) before it checks the status, so a double submit posts once. `tests/integration/hd09-double-submit.test.ts` holds it.

## Audit timestamp payloads

Pass timestamps to `audit.record` as ISO strings, not JavaScript `Date` objects: a Date in an audit before-value was serialized as `{}` by the current audit pipeline. Existing audit rows remain immutable; any correction must be an append-only supplement with verified source evidence.

## Release integration and migration ordering

Release `5f721629294249c8e9bd16b124f8b770253b50c3` on `fix/item-revenue-routing` — the supplier-statement fix, invoice dimensions, item-based revenue routing and account-profile corrections — is integrated here. The tree's pricing work predates it and was committed first, so the merge reads as "the release on top of the prices".

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
