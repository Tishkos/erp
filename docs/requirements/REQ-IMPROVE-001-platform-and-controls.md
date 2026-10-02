# REQ-IMPROVE-001 — Platform, closing and controls: what surrounds the code

| | |
|---|---|
| **Requirement ID** | `REQ-IMPROVE-001` |
| **Release** | 1 (operations stage before the REQ-AP-001 Stage 8 cut-over; the rest in the first release after it) |
| **Source** | Four read-only sweeps of `main` at `de7c3b2` on 2026-10-02 — security and access, operations and resilience, performance and data model, financial controls and integration — each told to look past what REQ-HARDEN-001 already lists; the claims that decide the priorities were re-verified by hand (the deploy script, `npm audit`, the FX and approval code, the period-close service, an `EXPLAIN` of the row-level-security policies as a branch user). |
| **Test case(s)** | Named per criterion in §4; each lands with its stage (the A2 discipline). |
| **Status** | DRAFT — findings verified with file:line evidence; nothing in this document is built. |
| **Approved by** | *Not yet approved.* |

**Why a second document after REQ-HARDEN-001.** HARDEN is a defect list:
things the code does wrong, each with a line number, each fixed in place. This
document is about what a defect sweep cannot see — how the system is backed
up, deployed, closed at month-end, governed and scaled. In the vocabulary of
the system this one copies: HARDEN is bug-fixing; this is *Basis*, the
*closing cockpit*, *GRC* and *performance tuning*. Where a finding here
touches one in HARDEN it says so and does not repeat it.

**How to read it.** §1 is what the sweeps could not fault. §2 is the two items
that should not wait for this document. §3 is the findings catalogue by
theme, with severity and evidence. §4 turns it into four stages with numbered
criteria IM1–IM24. §5 is the open decision register. §6 is what was found but
deliberately kept out, so this requirement stays an improvement list rather
than a second product.

---

# §1 — Verified healthy

* **No cross-site request path into a server action.** All 47 `'use server'`
  files go through `withCurrentUser` / `runAdmin*` / `requireContext`; no
  `allowedOrigins` widening (`next.config.ts:37-43`); no `/api` routes.
* **Session tokens** are opaque 32-byte values stored as SHA-256, read fresh
  per request; the cookie is httpOnly, Lax and Secure in production
  (`services/authentication.ts:281-310`, `app/sign-in/page.tsx:56-62`).
* **`erp_app` is NOSUPERUSER / NOBYPASSRLS**; nothing is granted to PUBLIC
  on tables; `CREATE ON SCHEMA public` is revoked.
* **Audit is append-only** by grant and by trigger (`0001:196-208,370`);
  refusals survive rollback (`services/audit.ts:69-77`); every print and
  export is audited with its filters (`print/export.ts:26,62,97`).
* **Attachments** are write-once (`'wx'`), traversal-safe, quarantined,
  size-limited, and carry retention and legal-hold fields.
* **Numbering does not serialise posting**: one Postgres sequence per key
  and scope, advisory lock only when a sequence is created
  (`0001:262-287`, `0214:21-61`).
* **Transactions wrap data loading only, not rendering**
  (`session.ts:108-122`).
* **Money columns are consistent**: `numeric(19,4)` for amounts, `(24,6)` for
  quantities (one outlier, `invoice_line.quantity`, `0162:17`).
* **Negative stock is refused**; batch/serial/expiry travel on movements;
  UoM conversion exists; customs duty is capitalised through landed cost.
* **Exchange rates are immutable** — superseded, never edited, audited
  (`0004:173-197`); callers cannot override a rate.
* **The desktop (Tauri) client runs no ERP code and holds no credentials.**

---

# §2 — Do these now, not with the document

| # | What | Evidence | Action |
|---|---|---|---|
| NOW-1 | **Nothing ever leaves the server.** The only database backups are the dumps `deploy.sh` takes before a deploy, written unencrypted to `/root/erp-backups` on the same disk and never rotated. Losing the VPS or its disk loses every book since go-live. | `scripts/ops/deploy.sh:103-106`, `docs/RUNBOOK-database-recovery.md:21-25` | Tonight: a cron `pg_dump -Fc` plus `pg_dumpall --globals-only`, encrypted (`age`), copied off the server (object storage or a second host). Formalised in OP-1. |
| NOW-2 | **`next@16.3.1` carries a critical unauthenticated RCE advisory** (image optimiser, GHSA-2xp9-vwfh-vxw4) and `/_next/image` is live because the sign-in page uses `next/image`. `npm audit --omit=dev` on 2026-10-02: 17 vulnerabilities, 1 critical, 6 high (next, undici, nodemailer, sharp). CI runs no audit; no Dependabot. | `app/sign-in/page.tsx:86-92`; audit run recorded in this document's source | Bump `next` to the patched 16.3.x and the rest via `npm audit fix`; add `npm audit --omit=dev --audit-level=high` to `ci.yml`. Formalised in SG-9. |

---

# §3 — Findings catalogue

Severity as in REQ-HARDEN-001: **H** = can lose or misstate the books, or
defeat a control · **M** = operational or correctness risk needing
conditions · **L** = hygiene. Two artefacts are not in the repository and
could not be checked: the nginx virtual host and `ecosystem.config.cjs`
(`deploy.sh:21-23`).

## 3.OP Operations and resilience ("Basis")

| # | Sev | Finding | Evidence |
|---|---|---|---|
| OP-1 | H | **No scheduled backup, no off-site copy, no WAL archiving, no rotation, no encryption.** Recovery point = "the last time somebody deployed". Attachments are outside `pg_dump` entirely and are only copied by accident, inside the app tarball on the same disk. Dumps include TOTP seeds (plaintext, `schema/auth.ts:130-135`), password hashes and KYC data. | `deploy.sh:103-106`, runbook §gap |
| OP-2 | H | **Every deploy breaks the live site for the length of the build.** `npm run build` runs while the old process still serves; Next's build empties `.next/` first (`cleanDistDir: true`), including the `standalone` directory pm2 runs from. A failed build exits under `set -e` and leaves the site down; rollback is manual. The printed database rollback (`pg_restore -c` over the live database) is the action the recovery runbook forbids. | `deploy.sh:119-142,162-166`; `node_modules/next/dist/build/index.js:623-624`; `RUNBOOK:82-87` |
| OP-3 | H | **Attachments may live inside the build directory.** With `ATTACHMENT_DIR` unset the store is `cwd/var/attachments`; the standalone server's cwd is `.next/standalone`, which every build deletes. `ERP-SYSTEM.md` states the opposite. *Verify the production `.env` before the next deploy.* | `attachments-runtime.ts:28-29`, `docs/ERP-SYSTEM.md:593-595` |
| OP-4 | M | **The post-deploy health check proves nothing about the database.** It accepts `200` from `/sign-in`, which renders even when the database is down because `optionalContext` swallows every error. The footer's "System is healthy" is a `select 1` on a page that already needed the database to render. The menu promises "Backup and Health" and "Background jobs" screens that are not delivered. | `deploy.sh:150`, `session.ts:86-90`, `components/app-footer.tsx:19-22`, `domain/menu.ts:437-438` |
| OP-5 | H | **No observability.** `src/server/logging.ts` (structured, redacted) has zero production callers; `console.error` is used directly (`posting.ts:477`). No request id — `audit_event.request_id` is filled with the session id (`admin-action.ts:26`); `client_ip` is always null because `requestOrigin()` has no callers (`session.ts:125`). `SENTRY_DSN` / OTEL variables are read nowhere; the error boundary drops `error.digest`. No log rotation; no alerts on disk, connections, cron failure, backup failure or certificate expiry. | as cited |
| OP-6 | M | **Production guards fail on the server.** `ensure-ceo-user.ts` and `db-reset.ts` refuse only non-local URLs; production is `127.0.0.1:5434` and `scripts/` is deployed there — run on the server they execute, and the former creates an active `ceo@example.com` with the fallback password `Ledger-Trial-Balance-7`, not temporary. `seed-dev.ts` checks `NODE_ENV`, which `.env.example` sets to `development`. The `LIVE` marker only guards `format-live-database.sh`. | `ensure-ceo-user.ts:22-30`, `db-reset.ts:24`, `seed-dev.ts:44` |
| OP-7 | M | **Jobs have no overlap lock, timeout or failure alert**, and the crontab is not in the repo. `due-notices` has no documented schedule or log. The weekly drill picks the newest `*.dump` whatever wrote it — `reset-statement-mapping.sh` writes a partial two-table dump into the same folder — and passes on a month-old dump. `scripts/verify-recovery.ts` is referenced by nothing. Restoring on a new host fails until the roles exist (`pg_dump` omits them); the runbook does not say so. | `restore-drill.sh:48,88-97`, `reset-statement-mapping.sh:34`, `package.json:24` |
| OP-8 | M | **The `payable_event` partition horizon is unmonitored**: partitions exist for 2026–2028, no DEFAULT partition, next year's is created by the sweep — which HARDEN F4 says is not installed. From 2029-01-01 every payable change would fail. `fiscal_year` for the next year is likewise opened by hand or every posting fails. | `0226:46-55`, `payables-sweep.ts:385-387`, `domain/periods.ts:48-51` |
| OP-9 | M | **Limits disagree.** Server actions cap at 4 MB while the attachment policy allows 25 MB and uploads go through server actions; nginx `client_max_body_size` is unknown. Exports (PDF/XLSX/DOCX) are rendered in memory **inside** the request transaction with no row cap; the stock-movement export silently stops at 1,000 rows while its filters say "all". No `--max-old-space-size` / `max_memory_restart`. | `next.config.ts:41`, `domain/attachments.ts:28`, `print/route.ts:31-37`, `stock-operations.ts:790`, `reports.ts:501` |
| OP-10 | M | **No staging environment and no anonymisation script**; every ops script defaults to production with the path and database hard-coded. The two drafts that follow this one (HR, WhatsApp) cannot be tested safely without it. | `INCIDENTS.md:94-95`, `deploy.sh:38,103` |
| OP-11 | L | **Release management is absent**: `package.json` is `0.0.0`, the footer's "v1.0.0" is a translation string, no tags, no CHANGELOG, no migration notes per release; CI claims otherwise (`ci.yml:4-5`). Deploys ship local `HEAD` (unpushed commits included) and build on the production server, which hosts 13 other sites; CI uses Node 24, the server Node 22, no `.nvmrc`. The e2e CI job has no database and so can test no signed-in flow. | `deploy.sh:31,50-56`, `ci.yml:19,94-105`, `messages/en.json:958` |
| OP-12 | L | **Disaster recovery covers the database on the same host only.** No host build document or infrastructure-as-code; nginx vhost, TLS, pm2 config, `.env`, crontab and firewall rules are on the server and nowhere else; credentials on one person's machine; no contacts section. | runbook, `INCIDENTS.md:98-99` |

## 3.FC Closing and financial controls ("closing cockpit")

| # | Sev | Finding | Evidence |
|---|---|---|---|
| FC-1 | H | **Foreign-exchange differences are not accounted for.** An invoice is booked at its date's rate; the payment is converted at the confirmation date's rate and allocated **in IQD** (`amountIqd: share`). There is no realised or unrealised FX gain/loss line role anywhere in the posting map (repo-wide grep: none). A fully paid USD invoice therefore stays part- or over-paid in dinars and surfaces only as "unexplained" on the statement. Period-end revaluation was deferred in REQ-AP-001 D27. `postTransfer` posts two bank lines only, so an off-rate cross-currency transfer cannot balance despite its own comment. | `payment-applications.ts:825,858-866`, `open-items.ts:513-541`, `treasury.ts:645-706` |
| FC-2 | H | **Period close is one click, permanent and unchecked.** No pre-close checks (unposted drafts, pending approvals, sub-ledger = GL, bank reconciled, depreciation run); months may close out of order; reopening "belongs to Phase 16"; `fiscal_year.status` is never written. **There is no year-end close**: no closing journal to retained earnings, no opening balances; statements carry an "accumulated result no year-end close has moved". | `periods.ts:214-264`, `finance/periods/page.tsx:163-170`, `financial-statements.ts:371-377`, `domain/journal.ts:30` |
| FC-3 | M | **Period control exists only in application code.** No trigger refuses a posted entry or a stock movement dated in a closed period; stock-only movements (transfers, relocations) skip the check entirely, so stock history in a closed month can change. | `posting.ts:314`, `stock-operations.ts:146-215`, `inventory.ts:1422` |
| FC-4 | H | **Sub-ledger to GL is never proved.** `subledger.reconciliation()` is called only by tests; the nightly integrity check compares stock *quantities* (layers vs movements), never stock **value** against the inventory account, although manual journals may hit control accounts and the stock-movement import writes layers with no journal. GRNI and landed-cost clearing have no ageing. The per-warehouse inventory sub-ledger drifts on every transfer (value moves without a journal). | `subledger.ts:194-224`, `inventory-integrity.ts:236-273`, `account-statement-check.ts:120-136`, `journal.ts:264-266` |
| FC-5 | H | **Approvals are uneven, and the money-out path with a screen has the weakest.** Manual journals and the chart of accounts are self-approved (`allow_self_approval = true`). The built Supplier Payments screen goes create → post; `accounting_manager` holds both verbs; `treasury.checkPayment` (the bank-account approval limit) is called only from three engine-only services. Item Reconciliation writes stock off at creation with one person and no reason. Sales invoice `approve`, write-off and bank transfer have no maker ≠ checker check. | `0006:351-359`, `0168:18-21`, `supplier-payment.ts:445-460`, `0039:189-193`, `stock-operations.ts:370-377,477`, `0207:97` |
| FC-6 | M | **No approval-limit matrix.** Thresholds are hard-coded per service (`domain/payment-run.ts:290`, `ar-collections.ts:82`, `domain/treasury.ts:76`, `domain/credit-control.ts:151`); workflow steps carry no amount condition; `escalate_after_hours` is seeded and never read; "delegated" is a free-text `onBehalfOf` with no register. Only four maker-checker rules exist in the database (`0053:27`, `0148:105`, `0149:75`, `0235:134`); ~20 more live in services. | as cited |
| FC-7 | M | **Rate controls.** One person publishes a rate with no checker, no tolerance against the prior rate, any back-dated effective date accepted; `rateOn` silently reaches *forward* to a future rate and has no staleness limit. | `exchange-rates.ts:116,186-194` |
| FC-8 | M | **Master-data governance is inconsistent.** Posting mappings, statement mapping, rates, bank-account limits and items change on one person's say with no effective date; item duplicate detection (`domain/item-duplicates.ts`) has no caller; the import framework is reachable from no screen, has no definitions for items, chart of accounts or opening balances, and its inventory import calls `inventory.receive` without `post` (layers, no journal). | `posting.ts:688-737`, `import-definitions.ts:137-160` |
| FC-9 | M | **No controls register.** Controls are scattered over database CHECKs, service checks and per-service thresholds; the control reports that exist (sequence gaps `numbering.ts:101`, period overrides `periods.ts:272`, posting failures `posting.ts:559`) have no screen. An auditor cannot be handed one list. | as cited |

## 3.SG Security governance ("GRC") — beyond HARDEN §3.A

| # | Sev | Finding | Evidence |
|---|---|---|---|
| SG-1 | H | **Separation of duties can be defeated by the administrator.** `system_administrator` holds `administer` on `app_user`, so it can reset the CEO's password and read the new one from the flash cookie, and reactivate deactivated users. Being made a department manager — which `system_administrator` or any existing manager can do — is by itself approval authority: `approveAsDepartmentManager` calls no `authorize`. A super user passes every `can()` and bypasses RLS with no reason, expiry or alert; `seed-dev.ts` makes `admin@example.com` one. | `users.ts:232-243`, `users/actions.ts:27-33`, `department-routing.ts:198-235`, `0158:20-26`, `permissions.ts:144,168` |
| SG-2 | H | **The audit trail has no tamper evidence and its auditor cannot read it.** No hash chain; `format-live-database.sh` ships a path that deletes `audit_event`. Admin changes and list exports are written with no branch, and branchless events are readable only by super users — the CEO, designated auditor (`0221:17-21`), is not one, so cannot see role grants, password resets or user creation. The audit screen exposes none of the actor/date/action/outcome filters its list supports, no before/after diff, no IP. | `0001:232-236`, `administration.ts:96-99`, `list.ts:321-335`, `audit/page.tsx:59-64,131-142` |
| SG-3 | M | **Sessions.** `better-auth` is configured but never mounted (no `/api/auth` handler); sign-in is a hand-written action, so the library's rate limiting, CSRF and refresh are inactive. Sessions are a fixed 8 h with no idle timeout, no concurrent-session cap, no revoke, no "sign out everywhere", no `__Host-` prefix, never purged; the client IP is the first `X-Forwarded-For` value (forgeable; a non-IP aborts sign-in). | `authentication.ts:45,298`, `auth/index.ts:72-81`, `sign-in/page.tsx:47`, `0014:153` |
| SG-4 | H | **The web process holds the owner database credential.** `deploy.sh` sources the whole `.env` — including `DATABASE_URL_OWNER` — into pm2's environment; deploys run as root, and the app very likely does too. The owner role bypasses RLS. | `deploy.sh:98,119,138-142` |
| SG-5 | H | **No RLS on the authentication tables** (`auth_session`, `auth_account` with password hashes, `auth_verification`, `user_mfa` with **plaintext TOTP seeds**) — not among HARDEN A5–A7. | `0014:150-157`, `schema/auth.ts:130-135` |
| SG-6 | M | **No HTTP security headers.** No `headers()` in `next.config.ts`, no middleware, nginx config not in the repo: no CSP, HSTS, `frame-ancestors`, Referrer-Policy or Permissions-Policy. Raw Postgres error text is placed in `?error=` (`admin-action.ts:89-99`). Route handlers (`sign-out`, exports) sit outside Next's Origin check. | `next.config.ts`, `src/app/**/route.ts` |
| SG-7 | M | **Database defence-in-depth.** No `statement_timeout`, `idle_in_transaction_session_timeout` or `lock_timeout` anywhere; PUBLIC keeps EXECUTE on most `SECURITY DEFINER` functions and CONNECT on the database (shared Postgres host); `erp_app` can update every `app_user` column including `is_super_user`; append-only triggers cover UPDATE/DELETE but not TRUNCATE. | `db/client.ts:26-33`, `0001:358`, `0164:60-61` |
| SG-8 | M | **Configuration.** ~15 env variables read ad hoc with no schema; `BETTER_AUTH_URL` defaults to localhost; the `.env.example` placeholder secret would be accepted; `ATTACHMENT_DIR`, `ERP_TIMEZONE`, `LOG_LEVEL` undocumented; S3/Sentry/OTEL documented but unread; `docker-compose.yml` publishes 5432 on all interfaces with a known password; no rotation runbook for `erp_app` / `erp_owner`. | `auth/index.ts:45`, `.env.example` |
| SG-9 | H | **Dependencies**: see NOW-2. GitHub Actions pinned by tag, no `permissions:` block; `shadcn` (a CLI) in runtime dependencies. | `ci.yml`, `package.json` |
| SG-10 | M | **Personal data.** No classification, no field-level encryption, no masking in lists or exports; audit snapshots deliberately keep bank account numbers; nothing can be erased (R3) — HR will add national IDs and salaries. Deploy tarballs copy KYC files unencrypted into `/root/erp-backups` forever. | `business-partner.ts:345-349`, `deploy.sh:105` |
| SG-11 | M | **Desktop client**: `"csp": null`, `withGlobalTauri`, updater off with empty `pubkey`, unsigned installer, `QS_ERP_URL` from the environment redirects the app with no https or host pin, downloads from any site saved silently. | `tauri.conf.json:12,17,48-53`, `src-tauri/src/lib.rs:35-45,86-91` |
| SG-12 | M | **Security-operations screens missing**: login history, sessions with revoke, permission-change report, who-can-approve/post report, MFA enrolment (service exists, no UI), super-user list and alerts, export-activity report; session lifetime is a constant in two files. | `auth/index.ts:41`, `authentication.ts:45` |

## 3.PF Performance and data architecture

| # | Sev | Finding | Evidence |
|---|---|---|---|
| PF-1 | H | **No stored balances.** Balance sheet, cash flow, GL balances, bank balances and the dashboard re-scan the journal from `0001-01-01` on every view; `journal_line` is indexed only by account and partner, with date and status on the header, so an account's history is read across all years before the date filter applies. The GL account page starts its running balance at 0 with no brought-forward figure. | `financial-statements.ts:385,456`, `trial-balance.ts:214-221,307-318`, `0006:82-84`, `gl-inquiry/[code]/page.tsx:69-75` |
| PF-2 | H | **`stock_position` is a view that re-sums all of `inventory_movement`** with a per-row in-transit subquery, read on every issue and once per item by `items.listAll`, which fills the pickers on five pages. Cost grows as items × movements. | `0027:31-77`, `inventory.ts:137-146`, `items.ts:92-94` |
| PF-3 | M | **RLS evaluates the branch function per header row.** `app_permitted_branches()` is `SECURITY DEFINER SET search_path`, which Postgres cannot inline; the comment says "once per query". An `EXPLAIN` as a branch user shows it in the per-row filter on `journal_entry` (the line table reaches it through a hashed subplan, which is fine). The list engine adds the same predicate to its own WHERE on top of RLS. | `0041:48-71`, `list.ts:192`, EXPLAIN recorded 2026-10-02 |
| PF-4 | M | **The dashboard**: 13 P&L scans of the journal, a full statement per bank account for one closing figure, the full integrity check and a full FIFO valuation, every unread notification row fetched to count them — one transaction, one failure blanks every later band. Open items count `settled` as open and filter in JS. | `dashboard.ts:62-69,146,232,369-390,411,467-498,529,642`, `open-items.ts:130,301` |
| PF-5 | M | **Posting engine**: per-line lookups before any insert; no multi-row inserts; a header-total trigger per line and a deferred recount per header update (quadratic in lines); **one journal per stock line**, so a 500-line delivery is ~500 journals, numbers, log and audit rows (~25k statements in one transaction holding the layer locks). `inventory.issue` locks every layer including exhausted ones. | `posting.ts:150-227,349-375`, `0006:128-146,204-207`, `inventory.ts:630-634,971-977` |
| PF-6 | M | **Identity resolved up to six times per page** (layout, shell, page, each `withCurrentUser`), each a transaction with ~9 queries, each selecting the full user row including the base64 avatar (up to ~540 KB) that is then sent to the client shell on every render. Nothing is cached — no `cache()`, no `unstable_cache`; posting rules, dimensions, rates and sequence definitions are re-read per posting. | `session.ts:47-82`, `authorization.ts:54-96`, `app-shell.tsx:45`, `users.ts:447` |
| PF-7 | M | **Pool and failure mode.** 20 connections, no timeouts (SG-7); layout, shell and page each hold one, so roughly 7–10 simultaneous page loads exhaust it — and under exhaustion `optionalContext` swallows the error and sends the user to `/sign-in`. | `client.ts:26-33`, `session.ts:85-105` |
| PF-8 | M | **Registers and paging** (extends HARDEN G5): journals, AR/AP invoices, receipts, payments, returns, transfers and adjustments are unbounded and filtered in JS; the list engine uses OFFSET and counts on every page; only 4 lists are registered on it. The stock-movements page runs 7 subqueries per row with `id::text = …` casts that defeat the uuid index — 18 columns hold uuids as text, forcing 54 such casts. | `journal.ts:1212-1231`, `list.ts:261-292`, `stock-operations.ts:686-721` |
| PF-9 | M | **Indexes beyond HARDEN G4**: `inventory_movement` lacks `(branch_code, movement_date)` and `(source_document_type, source_line_id)`; `cost_layer` lacks a partial on `remaining_quantity > 0` and an index on `created_by_movement_id`; `audit_event` has no `occurred_at` index though every view sorts by it and search is `ILIKE '%…%'` over five columns; no partial index for open invoices or incomplete workflows. | `0025:87-91`, `0001:144-146`, `lists/index.ts:129` |
| PF-10 | L | **Archival readiness**: only `payable_event` is partitioned (and by `recorded_at`, while read by `payable_id`); `audit_event`, the journal tables, movements, consumptions and `posting_log` are unpartitioned and append-only by trigger — no archival path short of dropping the triggers. `notification` rows accrue one per overdue invoice per recipient per day with no retention; `import_row.raw_values` and `auth_session` rows are kept forever. | `0226`, `due-notices.ts:114`, `0016:103-109` |
| PF-11 | L | **Data-model hygiene**: four status models (enums, text+CHECK, text+FK, text+transition table); `journal_line.branch_code` nullable though always filled; `payable.amount_*` without `>= 0`; dead or duplicate concepts carried (`warehouse_transfer` vs `stock_transfer`, `supplier_shipment` vs `shipment_container`, phase-00 `invoice` tables with no reader); the security mapping tables carry no granted-at / granted-by. | `0006:50`, `0225:138-139`, `0001:103-123` |

---

# §4 — Delivery stages

| Stage | Delivers | Criteria |
|---|---|---|
| **IMPROVE-1 — Operations ("Basis")** · *before the Stage 8 cut-over* | NOW-1 and NOW-2 if not already done; nightly dump + WAL archiving + off-site encrypted copy + rotation + attachments (OP-1); atomic deploy from a CI-built artefact with a maintenance page, `deploymentId`, expand/contract migration rule and a rollback that follows the runbook (OP-2); `ATTACHMENT_DIR` verified and mandatory (OP-3); `/healthz` (database, migrations at head, build id) used by the deploy and an external monitor, the footer badge reading it, the "Backup and Health" and "Background jobs" screens delivered (OP-4); `logger` wired with a request id from nginx, error tracking with the digest shown to the user, log rotation, alerts (OP-5); every write-capable script refuses while `var/LIVE` exists (OP-6); crontab in the repo with `flock`, timeout and log per job, drill picking only full dumps and failing on age, `verify-recovery` called by the drill, roles backed up (OP-7); partition- and fiscal-year-horizon alerts (OP-8); limits aligned and exports rendered after commit with a cap (OP-9); `make-staging-copy.sh` (OP-10); tags, CHANGELOG, `.nvmrc`, CI e2e with a database (OP-11); host-build document and secrets escrow (OP-12). | IM1 `im01-backup-restore` (a restore from the off-site copy on a clean host passes `verify-recovery`; RPO/RTO measured and written in the runbook) · IM2 `im02-zero-downtime-deploy` (a request in flight during deploy gets a maintenance response, never a 404/500) · IM3 `im03-healthz` (database down ⇒ `/healthz` 503, deploy aborts) · IM4 `im04-live-guard` (every script under `scripts/` that can write refuses with the marker present) · IM5 `im05-jobs-locked` (two overlapping runs of each job: one runs, one exits) · IM6 `im06-export-capped` (an export over the cap says so and renders outside the transaction) · IM7 `im07-staging-scrubbed` (no user e-mail, hash, MFA seed, KYC row or partner contact survives the copy) |
| **IMPROVE-2 — Closing and controls ("closing cockpit")** | Open items settled in transaction currency with realised FX posted to new mapped roles; period-end revaluation run with auto-reversal; balanced cross-currency transfers (FC-1); period-close checklist screen with blocking checks and sequence, reopen with two approvals, year-end close journal and next-year calendar (FC-2); closed-period trigger covering journals and stock movements (FC-3); sub-ledger-to-GL screen and nightly job for customers, suppliers, inventory value, bank and loans with zero-difference gates; GRNI / clearing ageing (FC-4); every money-out path through `checkPayment`, maker ≠ poster in the database for every money document, a second approver for manual journals on control accounts and for chart changes, stock reconciliation through count → variance approval (FC-5); one approval matrix (document type × amount band × role) used by every service, escalation and delegation wired (FC-6); rate second approver, tolerance, maximum age, no forward fallback for posting (FC-7); maker-checker and effective dates on mappings, item duplicate check called, import screen with definitions for items, chart of accounts and opening balances, inventory import posting (FC-8); `docs/CONTROLS.md` register and its gate test (FC-9). | IM8 `im08-fx-settlement` (a USD invoice paid at a different rate clears to zero in USD and posts the difference to FX gain/loss) · IM9 `im09-revaluation` (unrealised FX booked and reversed next period) · IM10 `im10-period-close` (close refused while a check fails; out-of-order close refused; closed-period posting and stock movement refused by the database) · IM11 `im11-year-end` (P&L closed to retained earnings; opening balances equal prior closing; trial balance shows opening / movement / closing) · IM12 `im12-subledger-equals-gl` (each control account equals its sub-ledger after the fixture; inventory value equals the layers) · IM13 `im13-maker-checker` (every money document in the schema has a database-level maker ≠ checker rule or a listed exemption) · IM14 `im14-approval-matrix` (a supplier payment above the band is refused without the role; below it posts) · IM15 `im15-controls-register` (every control in `CONTROLS.md` names a passing test; a money document absent from it fails the gate) |
| **IMPROVE-3 — Security governance ("GRC")** | Privileged-account actions (reset, reactivate, role or manager assignment for CEO/manager accounts) require a second administrator; `approveAsDepartmentManager` authorised; super-user flag with reason, expiry and an alert on use (SG-1); audit hash chain, branchless events readable by the designated auditor, filters/diff/IP on the screen, the erase path removed from the repo (SG-2); idle and absolute timeouts, concurrent-session cap, revoke and sign-out-everywhere, `__Host-` cookie, IP from a header nginx sets, session purge (SG-3); owner credential out of the app's environment, dedicated OS user (SG-4); RLS on the auth tables, TOTP seeds encrypted (SG-5); the six headers emitted by the app and asserted by test, Origin check on route handlers, error text not in the URL (SG-6); per-role timeouts, PUBLIC revokes, column-level grant on `is_super_user`, TRUNCATE guards (SG-7); zod env schema rejecting placeholders, rotation runbook (SG-8); audit gate in CI, actions pinned by SHA (SG-9); data classification, masking in exports, PII in erasable tables referenced by id (SG-10); signed desktop installer, updater on, baked-in URL wins in release builds, navigation allowlist (SG-11); the security-operations screens (SG-12). | IM16 `im16-sod-admin` (an administrator alone cannot reset or reactivate a CEO or manager account) · IM17 `im17-audit-chain` (a modified or deleted audit row breaks the chain and the nightly check reports it; the CEO sees role grants) · IM18 `im18-sessions` (idle timeout ends a session; revoke ends it on the next request; the cap refuses the N+1th) · IM19 `im19-headers` (all six headers present on `/sign-in` and an app page) · IM20 `im20-env-schema` (the placeholder secret refuses to boot in production) · IM21 `im21-auth-rls` (a branch user cannot read another user's session or MFA row) |
| **IMPROVE-4 — Performance and data architecture** | `account_period_balance` and `stock_balance` written in the posting transaction and reconciled nightly, giving the year-end close its opening figures and the statements their starting point (PF-1, PF-2); `(SELECT app_permitted_branches())` in the policies and the list engine's duplicate predicate removed, with an EXPLAIN gate run as a branch user (PF-3); dashboard bands from the balance tables, each in its own savepoint, notifications counted not fetched (PF-4); one journal per document, multi-row inserts, set-based totals and stock checks, exhausted layers excluded from locks (PF-5); per-request `cache()` for identity, process cache for configuration keyed by a version stamp, avatars as cacheable URLs (PF-6); pool sizing with timeouts and an honest error on exhaustion (PF-7); every register on the list engine with keyset paging and a capped count, uuid columns typed as uuid (PF-8); the index migration (PF-9); monthly partitions for `audit_event`, yearly for journal and movement tables, retention for notifications, import rows and sessions (PF-10); hygiene migrations (PF-11). | IM22 `im22-balances-agree` (balance tables equal a full recomputation after the fixture and after a reversal) · IM23 `im23-posting-throughput` (a 500-line delivery posts in under 5 s as one journal) · IM24 `im24-load` (the A21 figures — workbench < 1 s at 10k payables, statements < 2 s at 200k lines — measured with the k6 script and written in this document) |

Order: IMPROVE-1 before the cut-over (with HARDEN-1 and HARDEN-2); IMPROVE-2
first after it, because the first month-end will ask for it; 3 and 4 follow.
Each stage is its own branch and pull request, as REQ-AP-001 §25.

---

# §5 — Decisions, OPEN

| # | Question | Proposed default |
|---|---|---|
| D-IM-1 | Recovery point and recovery time | RPO 15 minutes (WAL archiving), RTO 2 hours, drilled monthly on a clean host; off-site = object storage in a different provider, encrypted with a key held by the owner. |
| D-IM-2 | Staging | Yes — same VPS, separate database `erp_staging`, pm2 name, port and vhost; refreshed weekly from the scrubbed copy; cron disabled. |
| D-IM-3 | Multi-company | Out of scope for this release; the scripts stay single-instance and say so. Revisit when a second company is real. |
| D-IM-4 | Retention | Audit and journals: forever (R3), partitioned, archived cold after 7 years; notifications 180 days; sessions 30 days after expiry; import rows 1 year; backups 7 daily / 4 weekly / 12 monthly / 7 yearly. |
| D-IM-5 | Supplier payments | The accounting manager may create *or* post a supplier payment, not both; above the bank account's limit the CEO posts, as for applications (REQ-AP-001 D30). |
| D-IM-6 | Manual journals | Self-approval allowed below a threshold on non-control accounts; a second approver on any control account or above the threshold; a monthly manual-journal review report. |
| D-IM-7 | FX accounts | Two new mapped roles, `fx.realised_gain_loss` and `fx.unrealised_gain_loss`, seeded under finance expense/income; revaluation on bank, supplier, customer and loan balances at month-end, reversed on the first of the next month. |
| D-IM-8 | Approval bands | Seeds, editable from day one: < 5 m IQD officer; 5–50 m manager; > 50 m CEO; per document type on the Payables Settings screen. |
| D-IM-9 | Super users | None on day-to-day accounts; the flag carries a reason and an expiry of at most 24 hours and is alerted to the CEO on use. |
| D-IM-10 | Audit tamper evidence | A per-row SHA-256 over the previous hash and the row, verified nightly and on the drill; anchored weekly off-site. |
| D-IM-11 | Session policy | 30-minute idle, 10-hour absolute, 3 concurrent sessions; configurable on a security settings screen. |

---

# §6 — Found, and kept out of this requirement

These are **functional gaps**, not improvements, and belong in a requirement
of their own (REQ-FIN-002, say) so this one stays a platform-and-controls list:

* Fixed assets: the engine is built (`services/fixed-assets.ts`) with no
  screen; recognition is not tied to an invoice line, so an asset can be
  recognised twice from one line. Depreciation is queue-only (HARDEN F2).
* Bank statement import: a row definition, no file parser, no screen;
  statement lines are IQD-only; no MT940/CAMT; reconciliation engine-only
  with fixed matching rules; no cheque register.
* Tax: `tax_code` / `tax_rate` exist in the schema only; no lines, accounts
  or reports; the "deductions extension point" REQ-AP-001 §27 refers to does
  not exist in the schema.
* Sales side: the built sales invoice checks only `is_customer` — no credit
  limit, credit hold, price list or below-cost check (credit control lives on
  engine-only sales orders); no quotations; credit memos, collections and
  write-off engine-only; dunning by in-app notice only.
* Budgets by GL / department / cost centre and PO commitment control.
* Printable documents missing from the registry: payment application and
  bank letter, purchase order, goods receipt, credit/debit memo, cash
  voucher, PD, count sheet; no ORIGINAL/COPY marking.
* `docs/ERP-SYSTEM.md` is out of date (purchasing routes, "engine only" for
  screens that exist, fixed assets "planned") and should be regenerated from
  `DELIVERED`.

---

## Review checklist

- [ ] Every finding has file:line evidence a reader can open.
- [ ] Nothing here repeats a REQ-HARDEN-001 item; overlaps name the HARDEN id.
- [ ] Every criterion names the test that will hold it up, to be linked when built (00.6).
- [ ] Every decision has a proposed default the sponsor can accept or change.
- [ ] §6 items are tracked somewhere before this document is approved.
