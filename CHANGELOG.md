# Changelog

Every release has a version, a tag, scope, migration notes, test evidence and
a rollback plan (blueprint §25; REQ-IMPROVE-001 OP-11). The version is
`package.json`'s and is what the footer shows; the tag is `v<version>`;
`docs/RELEASE.md` says how one is cut.

## Unreleased

### Added
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
- `next` 16.3.8 (security), `nodemailer` 10; `package.json` version is real.
- Deploys build beside the running application and swap; the previous build
  is kept as `.next-prev`; a deploy ships only what is on `origin/main`.

### Migrations
- `0238_harden_access`, `0239_improve_operations` — additive; no data change.

### Rollback
- Application: `RUNBOOK-host-build.md` § 8. Data: the pre-migration dump,
  restored beside the live database (`RUNBOOK-database-recovery.md`).
