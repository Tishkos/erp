# Exception Center — implementation record

Platform phase, Wave 3, Builder Agent 7. Branch `platform/exception-center`,
base `3403b6da`. Migrations `0380_exception_core`, `0381_exception_grants`
(journal idx 233 and 234). Controls C-78 to C-81.

The Exception Center is the one place that says what in the books and the work
needs a person, found by the system, kept until its cause is gone, and cleared
by itself when it is. It repairs, posts and edits nothing: every figure it
shows is read from a service that already knew the question.

## 1. Architecture

```
 crontab (*/30)            "Refresh now" (administer)
      │                          │
      ▼                          ▼
 scripts/ops/exception-sweep.ts ──► exceptions.sweep({ trigger })
                                        │
        ┌───────────────────────────────┴───────────────────────────────┐
        ▼ transaction 1 — DETECT                                        ▼ transaction 2 — PERSIST
  system scope (notification-runner.systemScope)                  applyScope + markSystemSweep
  set local transaction_read_only = on                            pg_advisory_xact_lock(hashtext('exception_sweep'))
  each detector in its own savepoint                              pure plan(found, stored, ranDetectors)
  RUNNERS[code](ctx) → Finding[]                                  create · update · touch · reopen · resolve
        │                                                         + history (AFTER trigger) + sweep run log
        └─ { findings, ranOk[], errors[] } ───────────────────────►        │
                                                                           ▼
                                              notifications (critical/high, new · reopened · raised)
```

* `domain/exceptions.ts` is pure: severities, domains, statuses, the road
  (`allowedPairs`), identity (`findingKey` = `detector|subject`), thresholds
  (`THRESHOLDS`), the detector catalogue (`DETECTORS`) and `plan()` — what the
  sweep does with what it found against what is stored. No database, no clock.
* `services/exception-detectors/*` hold one runner per catalogue entry
  (`RUNNERS`, held equal to `DETECTORS` by the unit test). A runner returns what
  is wrong now and writes nothing. Each is called inside a savepoint: one that
  throws costs its own findings nothing and the others nothing.
* `services/exceptions.ts` is the only writer of `exception`,
  `exception_history` and `exception_sweep_run`: `sweep`, `acknowledge`,
  `refreshNow`, and the reads `openFor`, `countsFor`, `byRecord`,
  `listForScreen`, `byNo`, `lastRun`, `recordVisible`.
* `services/exception-text.ts` renders a finding's words in the **viewer's**
  language from stored `facts` and the message catalogue.
* The database holds the road (`exception_lifecycle_guard`), the history
  (append-only AFTER trigger) and who may read (`exception_scope`, FORCE RLS).

The rule that makes the centre safe to leave running: **a finding that was not
found again is resolved only if its own detector ran without an error.** A
detector that failed, or was not asked (`only:`), leaves its findings exactly as
they were — a broken check never reads as a clean bill of health.

## 2. What was implemented

* 24 detectors in eight domains (catalogue below) plus the sweep's own
  `platform.sweep_truncated` notice.
* Persisted, de-duplicated findings: unique on `finding_key`; severity
  critical/high/medium/low; domain; explanation in words; affected record and
  its link; first detected, last seen, occurrence count; owner; the road to
  deal with it (`href`, action label); evidence rows (at most 25 per finding).
* Lifecycle open → acknowledged (a person, with a note, audited) → resolved
  (only by the sweep). A resolved finding found again is reopened with
  occurrence + 1; an acknowledged one reopens only if it got worse. Every move
  is a history row.
* The sweep: schedule `exception-sweep` every 30 minutes through `run-job.sh`;
  idempotent; concurrency-safe (advisory lock, unique key, `last_seen_at` never
  moves back); "Refresh now" runs the same sweep (30 s rate limit — it answers
  with the last run).
* Notifications for a NEW critical or high finding, a reopened one, and a
  severity raised to those grades: kinds `exception.<domain>`, window
  `occurrence`, dedupe `<occurrence>:<severity>`, `recordAccess`.
* Screens `/exceptions` and `/exceptions/[exceptionNo]`, copying the Tasks list
  and Task record; the four doors in the standing order.
* Menu entry (My Work section), Global Search entity, saved-view route
  `exceptions.list`, notification target, QS Cloud Files record kind, notes,
  attachments, print model `exception` (PDF/XLSX).
* English and Arabic (RTL, 390 px) — both message files, no raw keys.
* Exposed reads for the next agents: `openFor`, `countsFor`, `byRecord`.

### Detector catalogue

| Code | Domain | Object (grant) | Severity | Reads |
|---|---|---|---|---|
| `accounting.bank_reconciliation_difference` | accounting | bank_reconciliation | medium 7 d · high 30 d · critical 90 d after the statement | `bank-reconciliation.position` |
| `accounting.control_account_difference` | accounting | gl_inquiry | critical | `subledger.reconciliation` (close check `subledger_equals_gl`) |
| `accounting.gl_integrity` | accounting | journal_entry | critical | `gl_integrity_issue` view |
| `accounting.posting_role_unmapped` | accounting | posting_rule | high / medium | `POSTING_MAP` against `posting.rules` |
| `accounting.posting_failed` | accounting | posting_rule | high | `posting_failure` |
| `accounting.period_close_blocked` | accounting | fiscal_period | high / medium (5 days' grace) | `closing-checks.nextToClose` + `report` |
| `receivables.overdue_exposure` | receivables | ar_invoice | low 30 d · medium 60 · high 90 · critical 180 | `open-items.openItems` (customers) |
| `receivables.ledger_inconsistency` | receivables | ar_invoice | high | `customer-reconciliation.exceptions` |
| `payables.overdue_exposure` | payables | ap_invoice | low 14 d · medium 30 · high 60 · critical 90 | `open-items.openItems` (suppliers) |
| `payables.ledger_inconsistency` | payables | ap_invoice | high | `supplier-balances.exceptions` |
| `payables.supplier_credit_inconsistency` | payables | supplier_credit_memo | high | credit memo against its applications |
| `inventory.negative_stock` | inventory | inventory_movement | high | `inventory-integrity.adriftPositions` |
| `inventory.layer_mismatch` | inventory | inventory_movement | high | `inventory-integrity.adriftPositions` |
| `inventory.document_ledger_mismatch` | inventory | inventory_movement | critical | documents without ledger rows, rows without documents, unbalanced transfers |
| `inventory.gl_difference` | inventory | inventory_movement | high | `inventory-valuation.stockAgainstGl` |
| `inventory.transit_mismatch` | inventory | in_transit | medium | `logistics-views.inTransitReconciliation` |
| `logistics.container_delayed` | logistics | shipment_container | low 3 d · medium 7 · high 14 · critical 30 past ETA | `logistics-views.shipmentTracking` |
| `logistics.shipment_update_stale` | logistics | shipment_container | low 7 d · medium 14 · high 30 | `logistics-views.shipmentTracking` |
| `logistics.customs_issue` | logistics | customs_pd | high / medium (PD expiring within 14 d) | `customs_pd` with `pd_status` |
| `logistics.landed_cost_blocked` | logistics | landed_cost | medium 21 d · high 60 | `logistics-views.landedCostsRegister` |
| `tasks.overdue` | tasks | task | low 1 d · medium 3 · high 7 · critical 30 | `tasks.overdueTasks` |
| `tasks.blocked` | tasks | task | medium 3 d · high 7 · critical 21 | `tasks.blockedTasks` |
| `approvals.waiting_too_long` | approvals | workflow_instance | low 3 d · medium 7 · high 14 · critical 30 | the approvals inbox |
| `platform.system_health` | platform | system_health | critical / high / medium | `system-health.check` (host-dependent) |

One finding per subject: a customer or supplier is one finding with its oldest
overdue age as the severity and the invoices as evidence; a container, a task,
a PD, a period, a warehouse/item position is one each. All thresholds are
constants in `THRESHOLDS` (no settings screen — see §10).

### Detectors not built

Left out on purpose: each would need either a new reading of the books (this
centre only reuses services that already answer the question) or would repeat a
warning another module already raises. Candidates for a later wave:

* Unused supplier credit by age.
* Customs declaration rejected (as distinct from `logistics.customs_issue`,
  which covers the states a PD has today).
* Bank statement lines left unreconciled (as distinct from a reconciliation
  that closed with a difference).
* Project budget overrun — Project System raises `project.availability_warning`
  at the crossing; a finding would duplicate it.
* Payroll, leave and HR documents — HR has its own sweep and notification kinds.

## 3. Data source

Everything comes from services and views that already existed (column "Reads"
above); no detector repeats another service's arithmetic. Money is compared and
summed as scaled bigints. "Today" is `businessToday()`; dates are business dates.
Facts are stored as typed `jsonb` (`facts`) and `evidence` rows
`{ ref, href, date, amount, quantity, note }`; amounts are decimal strings.
Titles and explanations are *not* stored as the display text: `title` and
`explanation` hold an English snapshot (for search and exports) and every screen
re-renders from `facts` in the viewer's language
(`admin.exceptions.detector.<code with . → _>.{name,title,explanation,action}`,
`evidence_note.<code>`), so one finding reads correctly to an Arabic and an
English viewer at once.

No mocked data anywhere: the integration tests build a real world with the
logistics fixture and make each condition with the real services (or, for
negative stock, with the triggers off, as maintenance damage would).

## 4. Permissions

* Object `exception`. `view`, `execute`, `print`, `export`: every role.
  `administer`: CEO, accounting manager, system administrator ("Refresh now").
  Super user holds every verb.
* Row-level policy `exception_scope` (FORCE RLS): `view` on `exception` **and**
  `view` on the object the finding is about (`DETECTORS[].object`), within the
  user's branches (null branch = company-wide). So the accounting manager sees a
  bank reconciliation difference and a logistics officer does not; the officer
  with no `bank_reconciliation` grant never learns it exists.
* `exceptions.recordVisible` adds the one question SQL cannot answer — may this
  person open the affected record (`attachments.mayAccessParent`; a task is its
  parties' alone; an approval is its approver's and the workflow managers').
  Every read, the notes, files, print copy and Global Search go through it.
* Acknowledge = `execute` on `exception` plus visibility; the database lets a
  person move only open → acknowledged with a note and change nothing else.
* Notifications reach the holders of both grants in the branch, and the owner.

## 5. Database changes

`0380_exception_core.sql` (no enum is created or extended; severity, domain and
status are `text` with check constraints, mirrored by the domain constants)
* `exception` — id, `exception_no` (EXC-nnnn), `finding_key` (unique), detector,
  domain, severity, status, `facts`, `evidence` (a jsonb array, at most 50 rows by
  check; the sweep keeps 25), `title`, `explanation`, record type/id/label/href,
  action href/label, party, branch, owner, first/last seen, occurrence,
  acknowledgement (by, at, note), resolved_at.
* `exception_history` — append-only (`reject_mutation`), written by
  `exception_history_writer` (AFTER INSERT/UPDATE on `exception`), so no code
  path can move a finding without leaving a line.
* `exception_sweep_run` — append-only; one row per sweep: business date, trigger
  (`schedule`/`manual`), who, counts (found, created, updated, reopened,
  resolved, notified) and per-detector outcome and timing.
* Functions/triggers: `exception_lifecycle_guard` (the road and who walks it),
  `exception_no_delete`, `exception_is_sweep()` (reads `app.system_sweep`),
  `exception_severity_rank()`.
* RLS `exception_scope` on `exception`, `exception_history_scope` and
  `exception_sweep_run_scope` (history through the finding; the run log by
  `view` on `exception`).
* Series `EXCEPTION` (prefix EXC, `{PREFIX}-{SERIAL}`, 4 digits) inserted by the
  migration.

`0381_exception_grants.sql` — grants as in §4; moves every user's
`permissions_version`.

## 6. Routes

| Route | What |
|---|---|
| `/exceptions` | register (domain, severity, status, owner filters with counts, search, saved views, paging), last-check line, Refresh now |
| `/exceptions/[exceptionNo]` | record: header fields, evidence lines, acknowledge form (note required), action link, the road |
| `scripts/ops/exception-sweep.ts` | cron job `exception-sweep`, every 30 minutes, exit 2 if a detector could not run |
| export key `exception` | PDF/XLSX of the finding, its evidence and its road |

Server actions: `refreshExceptions`, `acknowledgeException`
(`src/app/(app)/exceptions/actions.ts`).

## 7. Shared files touched (all additive)

`messages/en.json`, `messages/ar.json` (block `admin.exceptions`, `page.exceptions`,
`savedViews.params.{domain,severity,owner}`) ·
`scripts/ops/crontab.erp` (one line) · `scripts/ops/format-live-database.sh`
(`exception` tables) · `src/server/attachments-runtime.ts`
(`exceptionParentAccess`) · `src/server/db/schema/index.ts` ·
`src/server/db/migrations/meta/_journal.json` ·
`src/server/domain/{menu,notification-center,profiles,saved-view-routes,screens,search}.ts` ·
`src/server/print/{access,registry}.ts` · `src/server/records/index.ts` ·
`src/server/search/entities/index.ts` · `src/server/services/record-notes.ts` ·
`tests/integration/setup.ts` (`resetTestData`: exception tables, series kept) ·
`tests/integration/sv01-saved-views.test.ts` (`exception` added to the buyer's
objects: the test opens every registered saved-view route) ·
`tests/unit/{im04-live-guard,im05-jobs-locked,screen-catalogue}.test.ts`
(counts: 250 → 251 screens, 365 → 367 in total; job list + `exception-sweep`) ·
`docs/CONTROLS.md` (C-78..C-81) · `docs/notes/doors-coverage.md` · `AGENTS.md`.

New files: schema `exceptions.ts`, `domain/exceptions.ts`,
`services/{exceptions,exception-text}.ts`, `services/exception-detectors/*`,
`print/exception-documents.ts`, `records/exceptions.ts`,
`search/entities/exceptions.ts`, the two pages and actions, the sweep script,
migrations 0380/0381 and the three test files.

Merge notes: `screen-catalogue`, `im04-live-guard`, `im05-jobs-locked` carry
counts that every new screen/job moves — expect a trivial conflict against any
other branch that adds a screen or job. Migration idx 233/234 and series `EXC`
are reserved to this branch.

## 8. Targeted checks run

Own databases only (`erp_exceptions`, `erp_test_exceptions`), every run through
`heavy`; no full suites.

* Typecheck: clean.
* Unit `tests/unit/ex01-exceptions.test.ts` — 49 passing: identity and keys,
  `plan()` for every transition (create/update/touch/reopen/resolve, failed
  detector leaves findings, `only:`), registry equals catalogue, migration's
  allowed pairs equal `allowedPairs`, every detector renders in both languages
  with no raw code or placeholder, registrations (menu, search, print,
  notification kinds, saved view).
* Unit batch of the files my registrations touch (attachments, menus, search,
  hd18/hd19, im04/im05, notification-center, screen-catalogue, sv01): 273 pass;
  the one failure is `im15-controls-register` › "numbered without gaps" —
  C-78..C-81 belong to the Dashboard agent and are absent on this branch (the
  rows C-78..C-81 are themselves valid: each names a real test file and a
  migration).
* Integration `tests/integration/ex01-exceptions.test.ts` — 48 passing on a real
  world: every detector with a real scenario and one finding per scenario;
  idempotence (second sweep: nothing new, `last_seen_at` moved); concurrent
  sweeps (two at once → one finding each); failed detector leaves its findings;
  resolve on cause gone; reopen with history; acknowledge (note required,
  audited, only open); acknowledged stays through sweeps and reopens only when
  worse; visibility matrix across roles/branches and `byRecord`; notifications
  once, only critical/high; guard (direct SQL cannot delete, skip the road, edit
  evidence, or write history); a snapshot digest of the business tables is
  identical before and after sweeps (no business data touched).
* Shared integration batch: `ops14-print-export`, `gs-global-search`,
  `notification-center`, `sv01-saved-views` (after the test-actor fix above),
  `document-center` — all pass (153 + 27 tests).
* Playwright `tests/e2e/exceptions.spec.ts` — 5 passing (manager register,
  filters, refresh, four doors, acknowledge with note, history dialog, sweep
  leaves acknowledgement, officer cannot refresh, outsider turned away, Arabic
  mobile no sideways scroll). `theme-readability.spec.ts` — 14 passing.
* Sweep timing on the dev database: 0.2–1.0 s; slowest detector
  `accounting.period_close_blocked` at 54 ms.

## 9. Commits

```
30c7668 migrations 0380 (exception, history, sweep run, lifecycle guard, RLS) and 0381 (grants)
baeab66 schema, domain rules (road, severities, thresholds, detector catalogue, sweep plan)
9c53f38 detectors, text renderer and service
281eb08 message catalogue (English and Arabic)
770ef05 registrations (notification kinds, record target, attachments access, notes, print, search, saved view, menu), sweep script and job
572eb0f the sweep loads the record registry before notifying
f516634 list and record pages with the four doors, actions
40146b0 unit tests
afb1bd6 integration tests against a real world; the sweep's principal follows its scope
473b427 notification kinds in the category the registry reserves; saved-view parameter labels
24e4a4d Playwright spec; the refresh flash says what it found; records named in words
```

and the closing commit with this record, the controls rows, the doors table, the
`AGENTS.md` section and the `sv01` test fix.

Screenshots (`/home/claude/shots/exceptions/`): `exceptions-list-desktop-en`,
`exception-record-open-desktop-en`, `exception-record-acknowledged-desktop-en`,
`exceptions-list-mobile-ar`, `exception-record-mobile-ar`, and the models they
copy, `model-invoices-desktop-en`, `model-invoices-mobile-ar`.

## 10. Remaining limitations

* **Thresholds are constants**, not a settings screen (a second place to be
  wrong); a deployment that wants other numbers edits `THRESHOLDS` in one line.
* **Negative stock** cannot arise through the application (a deferred trigger
  refuses it), so `inventory.negative_stock` is a net for maintenance damage; its
  test makes the damage with `session_replication_role = replica`.
* **A manual journal on a control account naming no party** keeps raising
  `payables.ledger_inconsistency` after a correcting journal (both lines still
  lack a sub-ledger entry). Acknowledge it with a note; it does not resolve.
* **`platform.system_health` is host-dependent** (files, disk, services of the
  machine). The integration tests leave it out; the Playwright run shows the dev
  host's real findings. Health messages themselves come from the health service
  and stay in English in Arabic (the finding's frame is translated).
* The first sweep on a live database notifies per finding for every critical/high
  already there — one burst, then only change. Run `exception-sweep.ts` once by
  hand before announcing the centre if that is unwanted.
* Acknowledged findings are excluded from `openFor`/`countsFor` by default
  (somebody is on it); pass `includeAcknowledged` to count them.
* The `href` carried by `openFor` rows is the exception's own page, not the
  affected record; the record's link is `recordType`/`recordId` and, on the
  detail, `recordHref`.
* Notification kinds sit in the Accounting category: the registry reserves the
  `exception.` prefix for it and one kind may not be claimed by two categories.
* `tests/unit/im15-controls-register.test.ts` "no gaps" fails on this branch alone
  until the Dashboard agent's C-78..C-81 merge.
* No bulk acknowledge, no assignment UI (owner is set by the detector from the
  record's own responsible person), no snooze: out of scope for this wave.

## 11. What next agents need

* **Dashboard / Control Center** — read, do not write:
  `exceptions.openFor(tx, principal, { limit?, domain?, minSeverity?, includeAcknowledged? })`
  → `{ id, no, severity, domain, title, explanation, recordType, recordId, href, createdAt, ownerName }`;
  `exceptions.countsFor(tx, principal)` → `{ total, bySeverity, byDomain }`;
  both apply the reader's grants, branches and `recordVisible`, so the Dashboard
  needs no filtering of its own. Titles are rendered in the locale passed in
  `{ locale }`. Link a tile to `/exceptions?severity=critical&status=open`
  (filters: `domain`, `severity`, `status` = live|open|acknowledged|resolved|all,
  `owner` = me|none, `q`).
* **A record page that wants "what is wrong here"** —
  `exceptions.byRecord(tx, principal, recordType, recordId)` (`recordType` as in
  the catalogue's "record" column: `business_partner`, `journal_entry`, `task`,
  `shipment_container`, …). Show it as the existing `s.sapNote` banner with a link
  to the finding; do not draw a new component.
* **A new detector** — an entry in `DETECTORS`, a runner in `RUNNERS`, catalogue
  keys in both locales under `admin.exceptions.detector.<code_with_underscore>`
  and `evidence_note.<code>`, an object whose grant the readers hold, a row in the
  catalogue above. The unit test renders every detector with sample facts in both
  locales and refuses a raw code, a placeholder or a missing key. A detector reads
  through an existing service, never repeats its arithmetic, never writes.
* **A new domain** widens the `exception_domain_known` check (a new migration, with a
  `when` after the journal's last entry), `DOMAINS`, the `domain_<x>` labels in both
  locales, the saved-view enum and the notification kind `exception.<domain>`.
* **Resetting data**: new exception tables are in `resetTestData` and
  `format-live-database.sh`; the series `EXCEPTION` is kept.
* **Live use**: `scripts/ops/exception-sweep.ts` is on the live-use list in
  `tests/unit/im04-live-guard.test.ts` (it writes only these tables and
  notifications). The Background Jobs screen shows it from `crontab.erp`.
* **Do not** edit a finding to "fix" it, and do not post a journal from the
  centre — the sweep refuses any row change a person did not make through
  `acknowledge`, by the trigger, not by convention.
