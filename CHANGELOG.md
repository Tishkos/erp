# Changelog

Every release has a version, a tag, scope, migration notes, test evidence and
a rollback plan (blueprint §25; REQ-IMPROVE-001 OP-11). The version is
`package.json`'s and is what the footer shows; the tag is `v<version>`;
`docs/RELEASE.md` says how one is cut.

## Unreleased

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
