# Changelog

Every release has a version, a tag, scope, migration notes, test evidence and
a rollback plan (blueprint §25; REQ-IMPROVE-001 OP-11). The version is
`package.json`'s and is what the footer shows; the tag is `v<version>`;
`docs/RELEASE.md` says how one is cut.

## Unreleased

### Added
- REQ-HR-001 HR-4 — **Advances & Loans**. A salary advance or a loan
  (EADV-…) asked for by HR or by the person, endorsed by their manager,
  approved by Finance (never by the asker, the person or the endorser), paid
  from a bank or cash account; recovered by payroll month by month from its
  first recovery month (a missed month caught up, never more than is owed,
  never below a net of nothing), given back when a run is reversed, settled
  in cash for what remains and never more. The morning sweep raises a loan
  behind its schedule; the dashboard shows advances waiting on me. The
  employee page shows the person's advances and the **equipment** they hold
  (a fixed asset or an item, handed out and returned with its condition) —
  a leaver's clearance. Migration 0258.
- REQ-HR-001 HR-3 — **Payroll**. One run per branch per month, computed from
  the facts: the salary in force, each person's own component figures
  (allowances, an exemption — dated rows on the employee page), the
  components' defaults, and the month as the day sheet and the leave read it
  (absences and unpaid leave at the day's rate, part months by working days
  employed); overtime and income tax typed on the draft with their notes.
  Prepared and sent by the HR manager, approved by the accounting manager or
  the CEO (never the preparer), posted by Finance as one journal by
  department through mapped roles or the components' own accounts, every line
  a payslip (PSL-…) the person can open and print. The net pay is paid by
  bank transfer and in cash from the treasury's accounts; a run nothing was
  paid from is reversed whole and run again. The dashboard shows runs waiting
  on me; the cash forecast's payroll source is live; the period-close
  checklist warns of a month without a posted payroll. Migration 0257.
- REQ-HR-001 HR-2 — time. **Leave Management**: requests counted on the
  year's working calendar (rest days and holidays not taken, half days at the
  ends), held to the balance of their type (entitlement by months served,
  carry-over capped, opening balances and corrections as dated rows), a sick
  note required where the type says so, decided by the person's manager or
  the HR manager — never by whoever asked, never by the person — with
  notices both ways and a band on the dashboard. **Attendance**: the day
  sheet per branch and department, present or absent with in and out times,
  never over an approved leave, every correction audited. The employee page
  shows the year's balances, the requests and the month day by day. A
  contract's end date; the morning `hr-sweep` warns of contracts ending,
  requests waiting and annual leave about to lapse (limits on HR Settings).
  Migration 0256.
- The sponsor's WhatsApp configuration (`whatsapp-configuration`) on top of
  main: Noah on Opus 5.5 working the question out (WA-3), answering in the
  group only, reading what is sent to him, the claude-CLI brain, the
  maker-checker wording. Its two migrations run after main's head
  (`0246_whatsapp_group_only`, `0247_whatsapp_noah_opus`, journal times
  …061–062), and the migration runner repairs a database from the WhatsApp
  line, which had passed over the Project System's first three stages
  (`LINEAGE_REPAIRS` in `src/server/db/migrate.ts`).
- REQ-FIX-001 FIX-5 — HR in the sponsor's order: Dashboard, Employees,
  Departments, Positions, Attendance, Leave Management, Payroll, Advances &
  Loans, Recruitment, Performance, Employee Requests, Documents, Reports.
  **Departments** (register and record: seats in reporting order, the
  people, headcount, vacancies) and **Positions** (register and record,
  code minted — 0255) are built; Organisation now opens Departments; the
  Positions window left HR Settings. A new user is also an employee unless
  *Also an employee* is unticked — the account and the employee made
  together and linked, the account page naming the employee;
  `scripts/ops/ensure-user-employees.ts` (run by the deploy) makes the
  employee behind each existing active user, once.
- REQ-FIX-001 FIX-4 — units of measure on purchase: an item keeps its units
  on its record (*1 BOX = 24 EA*, a purchase and a sales default, a unit
  deactivated with a reason, the base unit always kept — 0254 holds it); the
  new-item dialog chooses the base unit; every purchase invoice line has a
  Unit, starting in the purchase default, its price following the unit until
  typed over. Stock is received, returned and costed in the base unit,
  exactly or refused, so a box of 24 at 24,000 is 24 pieces at 1,000 on the
  FIFO layer and in the journal. Lines that named a unit their item does not
  keep were repaired to the item's base unit by the migration. A sale is
  written in the base unit and refuses another.
- REQ-FIX-001 FIX-3 — the import and its invoices agree: a deposit is applied
  to the import's invoice when it posts; an import agreed in dinars takes its
  amount from its invoices (discounts and a second invoice included); an
  import agreed in another currency closes on its exchange difference (gain
  or loss) once fully paid, or says it waits for the exchange accounts;
  *Part paid* on the invoice screens; Invoice Status Tracking keeps imports
  out. The supplier advance's events and the exchange difference are on
  Posting Mappings (0253).
- REQ-FIX-001 FIX-2 — Availability is a register like every other: the
  Inventory tabs, search, a warehouse filter and "only items with stock",
  item names, fifty rows a page with the true count; issuing stock is a
  dialog and its refusal comes back in the service's words. The temporary
  password screen is a centred card like sign-in, outside the shell, with
  sign out on it.
- REQ-FIX-001 FIX-1 — the menu the sponsor asked for: Payables in four
  headings (Purchasing & Invoices, Payments, Suppliers & Balances, Setup)
  with payables work only; a Logistics module holding the customs
  declarations, the ASYCUDA list, bills of lading, containers and Invoice
  Status Tracking; Bank Loans and a new **Bank Deposits** screen (cash taken
  to the bank, or money from another source — a register over the bank
  transfer and the other receipt, approved by somebody else and posted) under
  Treasury & Banking. Routes are unchanged.

### Fixed
- Stale e2e expectations in the Phase 0 foundation suite: roles are given
  and created by the CEO, and the audit trail names actions in words.
- Bank and Cash Reporting counted every treasury posting (other receipts,
  loans, commissions, cash advances, reconciliation adjustments) as a
  transfer between own accounts; only a bank transfer's journal is one now
  (migration 0252 indexes the link).
- A page with two dialogs labelled both after the first one's title.
- Stale e2e expectations: the shell's unbuilt-screen and theme tests, the
  section-tabs navigation test.
- REQ-HARDEN-001 HARDEN-4 completed: the payable record reads in one
  transaction under a measured budget (G1–G3, HD14); each page hands the
  browser the nine message namespaces its client components use, not the
  catalogue — a workbench page from 408 KB to 224 KB (G7, HD19); no raw
  status, kind, lane or outcome code reaches a screen, and one
  `status_order` namespace for the order documents (H2–H3, HD18); the A21
  load run with its figures (I3, HD17: `tests/load/payables.js`,
  `scripts/load/seed-payables-volume.ts`).
- REQ-PM-001 PM-6 — close, settlement, labour and the reports: hours booked
  on an element by one person, approved by another and posted by Finance
  once the month has ended at the base salary ÷ the calendar's working days
  ÷ 8 (D-PM-8); a Material Issue document now posts its cost against the
  items' inventory accounts (D-PM-13); the **Close** workspace — Phase 11's
  five blockers and five more, technical completion, the settlement (an
  investment project's cost to the asset under construction, the rest's
  WIP cleared; drafted by one, posted by another; one per project) and the
  close; the **Reports** screen — the hierarchy cost report, line items,
  milestone trend analysis and earned value, printed and exported through
  the ERP's renderers from the same models the screen draws. A settled
  project refuses any further cost, recognition or reopen. Migration 0250.
- REQ-PM-001 PM-5 — billing, revenue recognition and forecast: a customer
  project's **billing plan** (per billing element, due on a billing
  milestone reached and approved, or on a date; a share of the contract as
  it stands or an amount; never more than the contract); certificates
  raised from a due line or from measured progress, carrying Phase 11's
  retention and advance recovery, approved by somebody other than their
  raiser and **posted** (D-PM-11: Dr customer receivable and retention
  receivable on the customer's sub-ledger, Cr project revenue, the project
  on every line); a draft withdrawn with a reason gives its balances back.
  **Revenue recognition** by percentage of completion, cost to cost (D-PM-1):
  nothing posts until Finance ratifies the method on Project Settings; then
  per project and period end the difference between recognised and billed
  goes to WIP or deferred revenue, reversed on the first day of the next
  run; refused in a closed period; a loss contract is flagged. The
  **Forecast** report: plan, budget, committed, actual, ETC (typed, dated
  and reasoned, or the formula), EAC and VAC per element. The close
  checklist warns of customer projects without recognition to the
  period's end; the WhatsApp bot answers "project status P" (D-PM-10).
  Migration 0249 (the measured-progress trigger now exempts a certificate
  raised from a billing-plan line).
- REQ-PM-001 PM-4 — schedule, progress and earned value: activities and
  milestones (usage billing, progress or date) under the elements,
  finish-to-start and start-to-start links with lags, the critical-path
  pass in the project's working calendar (earliest and latest dates,
  float, the critical path) on the WBS workspace; each run's milestone
  dates kept append-only for the trend; a progress milestone reached by
  one person and approved by another sets the element's percent;
  technical completion waits for every activity done and every milestone
  reached or cancelled. The **Progress** workspace: BCWS, BCWP, ACWP,
  CPI, SPI, EAC and VAC to a chosen day, element by element and summed up
  the tree, with the measurements, the milestones and their trend.
  Migration 0248.
- REQ-PM-001 PM-3 — execution: a purchase order, a payable and a purchase
  invoice may be assigned to a project element and cost code; the order's
  approval (or an order-less payable's opening) commits against the
  element's availability, the invoice's posting carries the project
  dimension and converts the promise — services as the cost, goods as
  stock until issued — and its reversal gives the promise back;
  cancellation releases it with the reason. The **Material Issues**
  document (issue at FIFO, return at the cost it went out at, the one-time
  form id), **Project Costs** (the line items beside the journal's
  figure) and **Procurement** (each promise, converted, released, open).
  Migration 0247.
- REQ-PM-001 PM-2 — planning and budget: the cost plan in versions with
  its spread by month (**Cost Plan**), the budget as documents — original,
  supplement, return, transfer — raised by one person and approved by
  another, the original writing the baseline once (**Budgets**, the
  new-document grid of elements × cost codes); availability control per
  element against the tolerance profile (warning notifications to the
  responsible person and the project manager, the stop line refusing the
  commitment, a raised line with a reason from the WBS element dialog);
  change orders with lines, two approvals and the supplement they raise
  (**Change Orders**). Migration 0246.
- REQ-PM-001 PM-1 — the Project System's structure: project types,
  tolerance profiles and cost codes as master data on the **Project
  Settings** screen; the `PRJ-{BRANCH}-{YYYY}-{SERIAL}` series; the WBS
  coding mask (five levels) with the planning, account-assignment and
  billing indicators, read by `recordCost` and `issueToProject`; the status
  profile (release by another person, hold and resume with reasons,
  technical completion, reopen once, close); the **Project Master** list
  and record, **Contracts** and the **WBS** workspace under the Projects
  section. Migration 0245.
- REQ-HARDEN-001 HARDEN-3/4 (part) — detail pages tell a missing record
  from a failed read (E1–E3, HD12 gate), the foreign-key indexes the hot
  paths join on (migration 0244, HD13), the dashboard's receipts filtered
  before the limit (G6), the service receipt chip translated (H1), a mobile
  Playwright project with the Arabic 390px pass over every delivered list
  and settings screen (I1/I2, HD16), the daily health check naming a
  bank/cash account whose ledger account is gone (F5), root notes moved to
  `docs/notes/` and the scratch script removed (J1, J3).
- REQ-IMPROVE-001 IMPROVE-2a — closing controls: the closed-period lock at
  the database (journals, stock movements, close in sequence; migration
  0243), the period-close checklist on the Accounting Periods screen with
  the hard close refused while a blocking check fails, the nightly
  `closing-checks` job, and `docs/CONTROLS.md` with its gate test.
- REQ-WA-001 WA-1/WA-2 — the WhatsApp bridge (`npm run whatsapp-bridge`,
  Baileys, pairing kept in the database), the `whatsapp` notification channel
  with its contacts, settings and message log on the **WhatsApp** screen, and
  the read-only query bot for the CEO (stock, payable and application status,
  SWIFT pending, due this week, stopped payables, supplier and customer
  balances with the statement as PDF, today's summary — Arabic and English;
  the model router when `ANTHROPIC_API_KEY` is set). Migration 0242.
- REQ-HARDEN-001 F1–F3 — the outbox finally delivers: the notification
  delivery runner, the e-mail sender over SMTP, retries on the D-HD-4
  schedule, `deliver-notifications` every five minutes in the crontab.
- REQ-HR-001 Stage HR-1 — people and organisation (`/hr/employees`,
  `/hr/organisation`, HR Settings). Migration 0241.
- REQ-LEGACY-001 — the legacy books import (`/administration/legacy-import`),
  reading the old system's `.xls`/`.xlsx` books into partners, items,
  warehouses, opening balances and opening stock, once, with a dry run.
  Migration 0240.

### Fixed
- REQ-HARDEN-001 G5 / HD15 — the goods receipt, purchase order, service receipt, recurring contract, PD, loan, payment application and shipment (B/L) registers page at 50 with a true count: the filters and the search run in SQL, the header shows the total, and the standard pager appears past one page. Before, three stopped silently at 200 rows and five read every row and filtered in memory.

### Migration notes
- 0240–0244 are additive (0244 adds indexes only). 0243 adds triggers: after it, a period that is `closed` refuses postings and stock movements at the table, and a period cannot be closed before the earlier ones of its year. 0242 adds an enum value (`whatsapp`) and must run
  on its own before the bridge starts (the migrator runs it as one
  transaction; nothing in the same file uses the value).
- After deploying: install the crontab (`install-cron.sh`, done by
  `deploy.sh`) so `deliver-notifications` runs; on the VPS install
  `deploy/whatsapp-bridge.service` and pair (`docs/RUNBOOK-whatsapp.md`).

## 1.0.0 — 2026-10-02

The first numbered release: everything delivered from the foundation to the
REQ-AP-001 cut-over, plus REQ-HARDEN-001 stages 1–2 and REQ-IMPROVE-001
stage 1.

### Added
- REQ-IMPROVE-001 Stage 1 — Operations: nightly encrypted backup sets with
  off-site copy and rotation (`backup.sh`), the crontab in the repository with
  locking, timeouts and per-job logs (`crontab.erp`, `run-job.sh`,
  `install-cron.sh`), the weekly restore drill calling `verify-recovery`,
  `/healthz`, the daily health check, the **Background Jobs** and **Backup
  and Health** screens, request ids and error digests in the log and on the
  error page, the export row cap with rendering after commit, the staging
  copy script with its scrub, the live-marker guard on every fixture script,
  the host-build runbook, the nginx and pm2 examples with the maintenance
  page, the production audit gate and Dependabot, e2e in CI against a
  database.
- REQ-HARDEN-001 Stages 1–2: sign-in hardening (lockout, temporary password
  expiry, MFA enrolment grace), permission-change propagation, RLS on every
  remaining table, business dates in Asia/Baghdad, integer money everywhere.

### Changed
- WhatsApp bot: the agent model is `claude-sonnet-5-5` again (migration 0251),
  by direction; 0245 had replaced it with `claude-sonnet-5`. Superseded by
  the sponsor's WhatsApp configuration: Noah on `claude-opus-5-5` (0247).
- `next` 16.3.8 (security), `nodemailer` 10; `package.json` version is real.
- Deploys build beside the running application and swap; the previous build
  is kept as `.next-prev`; a deploy ships only what is on `origin/main`.

### Migrations
- `0238_harden_access`, `0239_improve_operations` — additive; no data change.

### Rollback
- Application: `RUNBOOK-host-build.md` § 8. Data: the pre-migration dump,
  restored beside the live database (`RUNBOOK-database-recovery.md`).
