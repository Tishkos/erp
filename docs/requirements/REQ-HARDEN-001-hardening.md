# REQ-HARDEN-001 — Hardening the payables release

| | |
|---|---|
| **Requirement ID** | `REQ-HARDEN-001` |
| **Release** | 1 (before go-live of REQ-AP-001 Stage 8 cut-over) |
| **Source** | Full-system audit of 2026-10-02 on `main` (stages 1–8 merged): three read-only sweeps (security · correctness · operations), the complete test battery, and hand-verification of the two defects the sponsor reported. |
| **Test case(s)** | Named per finding below; each fix lands with its test (the A2 discipline). |
| **Status** | HARDEN-1 BUILT (`harden/stage-1-access`), HARDEN-2 BUILT (`harden/stage-2-money-time`), both 2026-10-02; HARDEN-3 BUILT with REQ-WA-001 (F1–F3, F5 guard) and on `harden/stage-3-delivery` (E1–E3, HD12); HARDEN-4 BUILT: on `harden/stage-3-delivery` (G4/HD13, G6, H1, I1/I2/HD16, J1, J3), `harden/stage-4-registers` (G5/HD15) and `harden/stage-4-performance` (G1–G3/HD14, G7/HD19, H2–H3/HD18, I3/HD17), 2026-10-02. The A21 peak profile (50 users) is not met on the 2-vCPU build sandbox; §3.I records the figures and the cure (IMPROVE-4 PF-3, a second application process). |
| **Approved by** | *Not yet approved.* |

**How to read this document.** §1 is what the audit proved healthy. §2 is the
two defects the sponsor reported, with their root causes. §3 is the full
findings catalogue — every issue the sweeps surfaced, by theme, with severity
and evidence. §4 turns the catalogue into four delivery stages with numbered
criteria (HD1–HD20). §5 is the open decision register. Nothing in this
document has been implemented; the only change shipped with it is the
traceability header block on REQ-HR-001 and REQ-WA-001, which were failing
the 00.6 gate on `main`.

---

# §1 — Verified healthy (what the audit could NOT break)

* **The whole test battery passes on `main`**: 18/18 integration suites, 107
  passed + 1 conditionally skipped (the Stage-8 A20 replay of the real
  `QS_DASHBOARD.xlsx`, which skips itself where the sheet file is absent and
  will run at cut-over). Units: 1,315/1,317 — the two failures are the
  missing traceability headers fixed alongside this document.
* **Migrations discipline held through all eight stages**: nothing applied
  was rewritten, the journal's 161 timestamps are strictly increasing, and
  every new document table is in `resetTestData` and
  `format-live-database.sh`.
* **The design rule held**: zero new CSS files, zero inline styles, 
  SectionTabs and the standard windows on all 19 payables screens.
* **No committed secrets** (`.env*` ignored; every hit is `process.env`).
* **All 16 `SECURITY DEFINER` functions pin `search_path`**; dynamic SQL uses
  `format('%I'/'%L')`.
* **Every one of the 116 pages authenticates** through
  `requireContext`/`withCurrentUser`; deny-by-default stands.
* **The principal is read fresh every request** (no role caching server-side),
  and deactivating a user revokes all their sessions.
* **File storage is traversal-safe** (uuid/sha keys, encoded download names,
  `nosniff`, `Content-Disposition: attachment`).
* The payables sweep **does** have its ops wrapper and documented cron
  (`scripts/ops/payables-sweep.ts`, runbook §cron) — an earlier worry,
  disproven.

---

# §2 — The two reported defects, root-caused

## 2.1 "Gave the permission but it didn't update for the user"

**Root cause (confirmed):** the navigation shell is rendered by the layout,
and the layout deliberately persists across navigations —
`src/app/(app)/layout.tsx` documents it: *"the header, navigation and user
menu stay mounted … only the page segment below is replaced."* The server
reloads the principal per request, so the **pages** are always current — but
the **menu** the user is looking at is not re-rendered until a hard refresh
or a fresh sign-in. A granted section does not appear; a revoked one does
not disappear. Hence "sometimes works": it works after the user happens to
reload.

**Fix (HD1):** version the permission state — bump a `permissions_version`
(per user) whenever `user_role` / `role_grant` / scopes change; the shell
compares the version on each navigation response (one lightweight header or
a tiny route handler) and calls `router.refresh()` when stale, which
re-renders the layout. Criterion: grant → the user's next navigation shows
the new menu entry without a manual reload; revoke → entry gone the same
way; test `hd01-permission-refresh` (e2e, two browser contexts).

## 2.2 The temporary password

**Root cause (confirmed):** the enforcement gate exists but is wired to
nothing. `assertPasswordNotTemporary`
(`src/server/domain/authentication.ts:154`) — whose own comment says a
temp-password session *"may do exactly one thing"* — has **zero production
callers**. Sign-in never routes a `mustChangePassword` user to the change
form; the flag's only appearance is a pill on the admin's user page; and
temp passwords **never expire** (`passwordChangedAt` is written and read
nowhere). An admin-issued temporary password is a permanent password.

**Fix (HD2):** call the gate in `currentContext` (or a layout guard) so a
`mustChangePassword` session can reach only the change-password form and
sign-out; sign-in redirects there directly; temp passwords expire 72 h after
issue (re-issue replaces); the change clears the flag atomically. Test
`hd02-temp-password` (integration + e2e).

---

# §3 — Findings catalogue

Severity: **H** = wrong money, silent data exposure, or a defeated control ·
**M** = correctness/operational risk needing conditions · **L** = hygiene.
Every finding carries its evidence; none has been fixed yet unless marked.

## 3.A Security and access

| # | Sev | Finding | Evidence |
|---|---|---|---|
| A1 | H | **MFA is never enforced at sign-in** — `assertSecondFactor` has no production caller; a privileged role signs in on password alone. | `services/authentication.ts:233`, `app/sign-in/page.tsx:44` |
| A2 | H | **No rate limit / lockout / captcha on sign-in**; scrypt at N=2¹⁶ (~64 MB per guess) also makes the endpoint an unauthenticated memory-DoS path. | `app/sign-in/page.tsx:28-52`, `server/auth/index.ts:127` |
| A3 | H | **Temp-password gate unwired, no expiry** (= §2.2). | `domain/authentication.ts:154` |
| A4 | H | **No authentication audit events** — neither success nor failure is recorded; the sign-in action swallows errors with `.catch(() => null)`. | `app/sign-in/page.tsx:51` |
| A5 | H | **`attachment` / `attachment_access` have no RLS** — any authenticated query path can read every file row regardless of branch. | `migrations/0017:144-145` |
| A6 | H | **`bank_loan` / `bank_loan_instalment` lack RLS** while sibling `bank_loan_allocation` in the same migration has it — drift, not design. | `migrations/0235:325-326` vs `:274-276` |
| A7 | M | RLS absent on further business tables: `project_*` (8 tables, 0148), `client_kyc_record`/`_document` (0120 — identity PII), `ap_invoice_note` (0231), `payment_application_transition` (0232), `payables_migration_run` (0237), `cost_layer_consumption` (0025), `supplier_advance_settlement` (0037), `crm_contact` (0147), `notification` (0016), `import_batch`/`import_row` (0013). Also: `user_role`, `role_grant`, `user_branch_scope`, `user_department_scope` carry no policies. | per-file lines in the audit log |
| A8 | M | Mutations without `authz.authorize`: `document-actions.perform` (also skips the refusal audit), `ar-collections.resolvePromise`, `pick-list.complete`, `sales-return.close`, `workflow.submit` (trusts `submittedBy` from input). | `document-actions.ts:110`, `ar-collections.ts:413`, `pick-list.ts:547`, `sales-return.ts:901`, `workflow.ts:161-196` |
| A9 | M | `notifications.markRead`/`markActed` take no principal — any caller can clear another user's notification. | `notifications.ts:297,312` |
| A10 | M | **Open redirect**: `record-action.ts` passes form-supplied `returnTo` straight to `redirect()`. | `server/record-action.ts:31,51` |
| A11 | M | `attachments.recordDenial` opens a transaction without `applyScope` — works only because A5 exists; fixing A5 would silently drop denial records. | `services/attachments.ts:320` |
| A12 | M | Password max-age not implemented (`passwordChangedAt` never read). | `services/authentication.ts:114` |
| A13 | L | Upload typing is a blocklist (`.svg`/`.html` → `text/plain`); mitigated by download headers. | `domain/attachments.ts:156-186` |
| A14 | L | Unescaped `companyName` in the temp-password e-mail HTML. | `services/mail.ts:69-70,91` |
| A15 | L | Sign-in timing oracle (unknown e-mail returns before scrypt). | `services/authentication.ts:125-134` |
| A16 | L | `verifyPassword` trusts KDF parameters parsed from the stored hash. | `server/auth/index.ts:153-158` |
| A17 | L | `payable_event` child partitions carry no policies of their own (mitigated: only the parent is granted; the creator function should add them anyway). | `migrations/0226:47-115` |
| A18 | L | Partner name/code existence probeable before authorization. | `services/partners.ts:174-179,240` |

## 3.B Money correctness (floating point where money lives)

| # | Sev | Finding | Evidence |
|---|---|---|---|
| B1 | H | **Stored unit cost computed by float division** — `BigInt(Math.round((Number(value)/qty)*10_000))` feeds the cost layer and the GL. | `services/stock-operations.ts:327-329,458,462` |
| B2 | H | **Migration "cleared" verdict decided in float** (`Math.round(Number(v)*100)`; quantity equality via `*1e6` rounding). | `domain/payables-migration.ts:460-470` |
| B3 | H | **Reconciliation variance = double subtraction re-stringified as money** (`unexplainedIqd` etc. printed on statements). | `services/open-items.ts:513-553` |
| B4 | M | `ties` epsilon (0.00005) is finer than double resolution at IQD magnitudes — balanced books can read unbalanced. | `open-items.ts:571` |
| B5 | M | Display totals in float that users reconcile against posted figures: AP invoice line/total, landed-cost section total (`.toFixed(4)` → `money()`), client line grids. | `invoices/[invoiceNo]/page.tsx:154-160`, `payables/[payableNo]/page.tsx:1286-1289`, `invoice-lines-grid.tsx:226-231`, `opening-stock-lines.tsx:106-115` |
| B6 | M | `formatMoney`/`formatQuantity` route all amounts through `Number()` — round-trip breaks above ≈9.0e15 minor units. | `i18n/config.ts:60,95,117` |
| B7 | L | Float display math: GL inquiry balances, dashboard ordering, FIFO valuation page. | `gl-inquiry/*:73-74`, `dashboard.ts:541-574` |
| B8 | M | `mayReverse` compares settled money with `Number(x) === 0` (service re-checks; UI can hide the action). | `invoices/[invoiceNo]/page.tsx:217` |

## 3.C Concurrency (read-then-write without row locks)

| # | Sev | Finding | Evidence |
|---|---|---|---|
| C1 | H | **Payment applications**: `approve`/`send`/`confirm` transition on an unlocked read — two concurrent confirms both post and both allocate the loan draw. | `payment-applications.ts:111-115,499,663,794` |
| C2 | H | **Loans**: `payInstalment` (and approve/disburse/allocate/release) read unlocked — a double submit posts the repayment twice. | `loans.ts:97-101,521-540` |
| C3 | H | **Landed-cost lock**: `importOf → unlockedCharges → allocate → distribute` with no lock — two simultaneous locks allocate the same charges twice into inventory/COGS. | `landed-cost.ts:408-440` |
| C4 | M | Customs-PD `changeStatus` guards on an unlocked read; `payables.load` recomputes stage without a lock. | `customs-pd.ts:239-274`, `payables.ts:125-129` |
| C5 | — | Clean contrast: the older document services all lock (`ap-invoice.ts:253`, `shipments.ts:627`, `inventory.ts:1083` …) — the pattern exists; the newer services skipped it. | — |

## 3.D Business dates (UTC "today" in a UTC+3 business)

| # | Sev | Finding | Evidence |
|---|---|---|---|
| D1 | H | **~60 sites stamp `new Date().toISOString().slice(0,10)`** while all display is `Asia/Baghdad`: between 00:00–03:00 Baghdad every "today" is yesterday. The hazard is even documented (`db/types.ts:8-12`) — but no business-today helper exists. | repo-wide |
| D2 | H | Stored dates affected: stock-issue `movementDate` (availability page), sales-return `receivedOn`, contract `generateDue` (its idempotency key is the date), the per-service `today()` helpers in customs-pd/loans/payment-applications/landed-cost (lock date)/shipments/migration/journal-reversal. | per-file lines in the audit log |
| D3 | H | **The nightly sweeps take UTC today as `asOf`** — a small-hours Baghdad cron runs PD-expiry/container-late/instalment/due-notice passes dated one day early. | `scripts/ops/payables-sweep.ts:20`, `due-notices.ts:25` |
| D4 | M | SQL `current_date` (session zone) mixed with app-side UTC dates in the same result (loans overdue count, contracts, dashboard due-this-week). | `loans.ts:1092,1261`, `recurring-contracts.ts:578`, `dashboard.ts:202` |
| D5 | M | Hold notification `occurrence` dates (the de-dup/ageing key) stamped UTC. | `payable-holds.ts:186,289` |

**One fix for the family:** a single `businessToday()` (Asia/Baghdad) in
`domain/`, used everywhere a business date is stamped or compared; SQL
comparisons switch to a bound parameter from the same helper. Decision
D-HD-2 below fixes the zone authoritatively.

## 3.E Error handling

| # | Sev | Finding | Evidence |
|---|---|---|---|
| E1 | H | ~~**Bare `catch { return null } → notFound()`**~~ **Fixed (`harden/stage-3-delivery`):** every detail page narrows on `isNotFoundError` (`src/server/not-found.ts`) and rethrows the rest; HD12 → `tests/unit/hd12-errors-not-404.test.ts` greps the pages. Was: bare catch wraps the whole data load of every newer payables detail page (payable, payment-application, loan, PD, B/L, container, contract, advance) — any DB error renders as "record does not exist". The master-data pages show the correct pattern (narrow on `AdminNotFoundError`, rethrow the rest). | `payables/[payableNo]/page.tsx:191-194` + 7 siblings |
| E2 | M | ~~Journal entry page swallows its whole load the same way.~~ **Fixed** with E1. | `finance/journals/[entryNo]/page.tsx:88-92` |
| E3 | M | ~~`posting.mappedAccountFor` returns `null` on engine failure~~ **Fixed:** null only for `NoPostingRuleError`; an ambiguous mapping throws. Was: returns null on engine failure — indistinguishable from "no mapping configured". | `posting.ts:816-818` |
| E4 | L | Landed-cost preview hides allocation failures (`safeAllocate → null`). | `landed-cost.ts:346-349` |

## 3.F Jobs and delivery (the unplugged layer)

| # | Sev | Finding | Evidence |
|---|---|---|---|
| F1 | H | ~~**No channel sender is registered anywhere**~~ **Built with REQ-WA-001 WA-1 (2026-10-02):** `notification-runner.registerEmailSender` (SMTP), `whatsapp.registerWhatsappSender` (the bridge); a channel with no sender in a process is left pending for the process that owns it. | `notification-runner.ts`, `whatsapp.ts` |
| F2 | H | ~~**The delivery job handler is never installed** and **no job runner process exists**~~ **Built with REQ-WA-001 WA-1:** `notification-runner.runOnce` dispatches the outbox, runs `notification.deliver`, sweeps the owned channel; `scripts/ops/deliver-notifications.ts` every five minutes (crontab), the bridge every poll. HD10 → `tests/integration/wa01-bridge.test.ts`. | `notification-runner.ts`, `crontab.erp` |
| F3 | M | ~~A failed delivery can never be retried~~ **Built with REQ-WA-001 WA-1:** a `failed` row is re-attempted in place (`failed → sent` is allowed by the trigger; only `sent` is terminal) per D-HD-4 — 1 / 10 / 60 minutes, three attempts (`domain/notifications.isDeliveryDue`); `suppressed` for an unreachable recipient. No new column was needed. | `notifications.ts` › `attempt`, `deliverChannel` |
| F4 | M | All recurring jobs exist only as hand-installed crontab lines — a fresh VPS silently runs none (sweep, due-notices, integrity, statement checks, restore drill). | `scripts/ops/*`, runbook |
| F5 | M | ~~tracked only in prose, no guard~~ **Guarded:** the daily health check (`bank_account_unlinked`, a stop) names every bank/cash account whose ledger account is missing or inactive and where to re-link it (`tests/integration/im03-healthz.test.ts`). The live data itself is still to be re-linked on the screen. | runbook §cron |
| F6 | L | No exchange-rate fetch job (manual entry only); `nodemailer` installed, never imported. | `package.json:40,48` |

## 3.G Performance

| # | Sev | Finding | Evidence |
|---|---|---|---|
| G1 | H | ~~**The payable page issues ~25 service calls strictly sequentially**~~ **Fixed (`harden/stage-4-performance`):** one transaction, one loader (`payables/[payableNo]/load.ts`), every read the one the page draws and only for a reader who will see it — 50 statements in one session (about 70 across three before), held at ≤ 52 by HD14 → `tests/integration/hd14-payable-record.test.ts` › *reads an import payable, its attachments and its history in one transaction under the budget*. They stay sequential: a transaction is one connection and `pg` refuses concurrent queries on it, so the cure was fewer reads, not parallel ones. Was: the payable page issues ~25 service calls strictly sequentially in one transaction — latency is the sum of every round trip. | `payables/[payableNo]/page.tsx:122-194` |
| G2 | H | ~~`users.listAll` on every payable view~~ **Fixed:** `users.pickable` (active users, id and name — no credentials joined), read only when the reader may stop the payable; HD14 asserts no `auth_account` read. Was: `users.listAll` — unbounded, no active filter — loaded on **every** payable view just to fill owner dropdowns inside collapsed `<details>`. | same page `:131`, `users.ts:55-72` |
| G3 | M | ~~eight settings tables, three sessions~~ **Fixed:** `settings.activeHoldReasons` on the record and `settings.activeTypes` on the workbench instead of `overview`; the landed-cost preview only while a charge is unlocked, its bases and types only for the forms that use them, the lock state from the facts already read (`landedCost.lockableState`); Attachments and RecordHistory read in the page's transaction (`readAttachments` / `readHistory`, handed in as `preloaded`). Was: `settings.overview` fires 8 full-table reads for the 1 list the page uses; the landed-cost block adds 6 more unbounded sequential calls; Attachments + RecordHistory each open their own extra transaction (3 DB sessions per view). | same page `:130,162-172,1754,1765` |
| G4 | H | ~~**Missing FK indexes**~~ **Fixed:** migration `0244_fk_indexes.sql` (HD13, additive, IF NOT EXISTS) over the document ↔ journal, document ↔ account, payables and layer links. Was: missing FK indexes (Postgres does not auto-index FKs): `payment_application.supplier_id` (0232), `container_receipt_line.container_line_id`, `container_receipt.payable_id/warehouse/branch`, `shipment_container_line.container_id` (only a partial unique), `landed_cost_layer_adjustment.payable_id/item/warehouse/via_layer`, `bank_loan_allocation.landed_cost_charge_id`, `bank_loan.bank_code`, `customs_pd.bank_code/branch_code`. 0231/0237 are clean. | per-migration lines in the audit log |
| G5 | M | ~~Registers truncate silently at `limit 200`; the newer registers have no limit at all and filter/sort in JS~~ **Fixed (`harden/stage-4-registers`):** every register reads one page of 50 with a true count through `services/register-page.ts` (`registerPage`: a `count(*)` and a `LIMIT 50 OFFSET` over one WHERE) — goods receipts, purchase orders, service receipts (the inbox and the full list each paged), recurring contracts, PDs, loans, payment applications and B/Ls (`listForScreen` / `listBlsForScreen`); every filter the screen offers (PD and loan views, the applications' status views, the search box) is in the SQL, so the count, the page and the pager describe the same rows, and the sort orders are the old ones (the applications' days-waiting order is now an `order by`). The screens show the total and the standard `Pagination`. The payable page's own sections keep unpaged reads bounded by the import (`customs.list`, `paymentApplications.list`, `shipments.listBls`). HD15 → `tests/integration/hd15-register-paging.test.ts`. Was: registers truncate silently at `limit 200` with no count/paging (goods-receipts, purchase-orders, service-receipts) — while the newer registers (PD, loans, payment applications, shipments, contracts) have **no limit at all** and filter/sort in JS. The proper list engine (`list.ts`, LIMIT/OFFSET + count) exists and is bypassed by both. | `goods-receipt.ts:814` etc. vs `customs-pd.ts:659-700` etc. |
| G6 | M | ~~applies `limit 50` **before** the department filter~~ **Fixed:** the department predicate is in the query. Was: dashboard "receipts awaiting" applied limit 50 before the department filter — a manager's own rows can be cut off by other departments'. | `dashboard.ts:185-189` |
| G7 | H | **Fixed (`harden/stage-4-performance`), found by the A21 run:** every page carried the whole message catalogue to the browser — the root layout handed `NextIntlClientProvider` all of `messages/<locale>.json` (196 KB English, 249 KB Arabic), escaped again in the RSC payload: a payable workbench answered 408 KB. Only nine namespaces are used by client components; `src/i18n/client-messages.ts` (`CLIENT_NAMESPACES`) passes those (35 KB) and the workbench is 224 KB. HD19 → `tests/unit/hd19-client-messages.test.ts` › *every useTranslations names a namespace the provider hands the browser*. | `src/app/layout.tsx` |

## 3.H UI / i18n

| # | Sev | Finding | Evidence |
|---|---|---|---|
| H1 | M | ~~Raw enum rendered on the payable page's service chip~~ **Fixed:** the chip reads the `status` namespace. Was: raw enum on the service chip (`{receipt.status}`) while sibling pages translate it; invoice-status fallback prints the English code in Arabic. | `payables/[payableNo]/page.tsx:1664,560` |
| H2 | L | ~~no gate on the seeded names~~ **Fixed:** HD18 → `tests/integration/hd18-seeded-labels.test.ts` › *every pd_status / container_status / landed_cost_type / landed_cost_basis has its label in English and Arabic* reads what the migrations seeded and fails on a code without both keys (all present today). Was: PD/container/charge/basis names fall back to the stored English name in non-English locales without failing any gate. | same page `:1071,1216,1324,1451` |
| H3 | L | ~~three copies~~ **Fixed:** one `status_order` namespace for the purchase order, goods receipt and service receipt (their wording — *Submitted*, *Executed* — is not the invoice's *Pending approval*, *Posted — paid* in `status`, so they share a namespace of their own rather than borrowing one that says something else); the three copies are gone. HD18 → `tests/unit/hd18-no-raw-enum.test.ts` › *no namespace re-declares them*. And the raw codes that still reached a screen are translated with a `.has` fallback: the deliveries' status on Background Jobs, the event codes' lane on Payables Settings, the stop's lane and the audit outcome on the dashboard, a project cost's kind — HD18 › *every status, kind, state, outcome and lane in a screen is drawn through a translation*. Was: the same 11 status labels are maintained in ≥3 namespaces (drift risk per locale) instead of reusing the global `status` namespace. | `messages/en.json:2575+` |

## 3.I Test coverage

| # | Sev | Finding | Evidence |
|---|---|---|---|
| I1 | H | ~~**Playwright has exactly one project**~~ **Fixed:** a `mobile` project (Pixel 5) runs `tests/e2e/mobile-rtl.spec.ts` — every delivered list and settings screen of stages 3–8 and after, in Arabic at 390px, no horizontal scroll (HD16). Was: Desktop Chrome only — no mobile viewport exists anywhere, so no screen has mobile e2e coverage; the RTL spec only visits sign-in and chart-of-accounts. | `playwright.config.ts:27`, `tests/e2e/rtl.spec.ts` |
| I2 | M | ~~no e2e at any viewport~~ **Covered at the mobile viewport** by HD16 (service-receipts, contracts, open-items, purchase-orders, goods-receipts, banks); desktop flows for them remain to write. Was: screens with no e2e at any viewport: service-receipts, contracts, open-items, purchase-orders, goods-receipts, banks master; shipments/advances are smoke-only. | `tests/e2e/payables.spec.ts` route list |
| I3 | M | ~~never run~~ **Run 2026-10-02 (HD17), figures below.** There was no load script (the cited `tests/load/payables.js` did not exist); it is written now, with `scripts/load/seed-payables-volume.ts` for the volume. The theme suite (`theme-readability.spec.ts`, which visits the stage 3–8 registers) passes on this branch: 6 of 6. Was: A21 (10k payables < 1 s) has a load script but has never been run; the 90-combination theme e2e has not been run over the stage-3-8 screens. | `tests/load/payables.js` |

**A21 / HD17 — the run, 2026-10-02.** A production build (`next build` + `next start`, one process, as `deploy/ecosystem.example.cjs` runs it) of this branch on the build sandbox — 2 vCPU, 8 GB, PostgreSQL 16 on the same machine, k6 0.54 on the same machine too — over a database made for the run (`erp_load`: the dev seed, then 10,000 import payables and 200,000 status-log events from the seed script), signed in as the branch-scoped Accounting Manager, so row-level security is in every read. Each virtual user opens the workbench four ways (first page, a later page, a search, the stopped filter) and a payable record, reading each page 3–7 s.

| Profile | Requests/s | Workbench p95 (A21: < 1 s) | Payable page p95 (A21: < 1.5 s) | Failed |
|---|---|---|---|---|
| 1 user | 2.1 | 482 ms ✓ | 188 ms ✓ | 0 % |
| D5 normal — 20 users | 3.1 | 976 ms ✓ | 613 ms ✓ | 0 % |
| D5 peak — 50 users | 5.0 | 7.96 s ✗ | 5.53 s ✗ | 0 % |
| Ceiling — 5 users, no reading time | 6.1 | 1.29 s | 601 ms | 0 % |

Where the time goes. The application process saturates at about six pages a second on this machine (a CPU profile shows no single hot spot: rendering, the query builder and the driver, about 120–150 ms of one core per page); past that, requests queue, which is the peak row. Of a single workbench's ~400 ms, ~300 ms is PostgreSQL evaluating the branch policy row by row: `app_branch_allowed(branch_code)` calls `app_permitted_branches()` (a SECURITY DEFINER function, so never inlined) once per payable — 115 ms for the count over 10,000 rows, 190 ms for the page, against 25 ms for the same query without the policy. That is REQ-IMPROVE-001 PF-3 (`(SELECT app_permitted_branches())` in the policies, computed once per statement), scheduled in IMPROVE-4; it touches 118 policies, so it is not done piecemeal here. The second cure is the host's: a second application process (`instances: 2`) on a host with the cores for it. G7 halved each page's size but not its CPU.

To repeat it: `docs/RUNBOOK-host-build.md` › *Load run (A21)*.

## 3.J Hygiene

| # | Sev | Finding | Evidence |
|---|---|---|---|
| J1 | M | ~~`.claude-prt.mjs`~~ **Deleted** (`harden/stage-3-delivery`). | repo root |
| J2 | L | REQ-HR-001 / REQ-WA-001 lacked the 00.6 traceability header (**fixed in this commit** — the only change shipped with this document). | `tests/unit/requirement-traceability.test.ts` |
| J3 | L | ~~Root-level working notes~~ **Moved** to `docs/notes/`. | repo root |

---

# §4 — Delivery stages

| Stage | Delivers | Criteria |
|---|---|---|
| **HARDEN-1 — Access & accounts** · *built* | §2.1 + §2.2 (the sponsor's two bugs); sign-in rate limiting + lockout + auth audit events (A2, A4); MFA enforcement for privileged roles (A1); the RLS batch (A5–A7) with `recordDenial` scoped first (A11); the authz gaps (A8, A9); the open redirect (A10). Migration `0238_harden_access`. | HD1 → `tests/e2e/harden.spec.ts` › *HD2 then HD1 · a temporary password, then a role granted mid-session* · HD2 → `tests/integration/hd02-temp-password.test.ts` › *restricts the session to the password screen until it is replaced, then lifts* · HD3 → `tests/integration/hd03-signin-hardening.test.ts` › *locks the account from that address after five failures, for fifteen minutes* · HD4 → `tests/integration/hd04-mfa-gate.test.ts` › *gives a privileged account seven days to enrol, then restricts it to enrolment* · HD5 → `tests/integration/hd05-rls-coverage.test.ts` › *names no business table without row-level security* · HD6 → `tests/integration/hd06-authz-coverage.test.ts` › *resolving a promise to pay needs the collections grant, and the refusal is written* |
| **HARDEN-2 — Money & time** · *built* | `businessToday()` / `businessDateOf()` (`domain/business-date.ts`) and every one of the 54 UTC stamps and 5 SQL `current_date`s moved onto it (D1–D5); the float eliminations where money is stored or compared (B1–B4, B8) and the display totals (B5) on the invoice and payable pages and in both browser grids through `src/lib/decimal.ts`; row locks for payment applications, loans, the landed-cost lock, PD transitions and the stage recompute (C1–C4). | HD7 → `tests/integration/hd07-business-today.test.ts` › *01:00 in Baghdad on the 2nd is the 2nd for every stamp* (and a grep gate that no UTC stamp returns) · HD8 → `tests/unit/hd08-money-integer.test.ts` › *matches the exact oracle on ten thousand random cases* (B1–B5 reproduced: 0.1 + 0.2, a five-billion-dinar layer, the exact tie) · HD9 → `tests/integration/hd09-double-submit.test.ts` › *two concurrent confirms of one payment application post one supplier payment and draw the loan once* |
| **HARDEN-3 — Delivery & jobs** | The job runner process + `registerDeliveryHandler` + the email sender (F1–F3, retry policy decided in D-HD-4); jobs install added to `deploy.sh` (F4); the restore-drill defect re-linked (F5); error-handling pattern fix across the detail pages (E1–E3). | HD10 `hd10-outbox-delivers` (pending → sent on a live SMTP stub; failed → retried per policy) · HD11 `hd11-jobs-installed` (deploy on a clean host registers every cron) · HD12 `hd12-errors-not-404` (a forced DB error on a detail page renders the error state, not notFound) |
| **HARDEN-4 — Performance & coverage** · *built* | FK index migration (G4); payable-page diet (parallelise, drop `users.listAll`/`overview` to targeted reads — G1–G3); registers onto the list engine with real paging (G5, G6); mobile viewport project + RTL/e2e for the uncovered screens (I1, I2); A21 load run + theme run recorded (I3); i18n chips (H1–H3); hygiene deletions (J1, J3). | HD13 index migration additive-only · HD14 payable page ≤ 4 round trips, measured · HD15 every register pages at 50 with a true count → `tests/integration/hd15-register-paging.test.ts` › *pages at 50 with the true count; the view and the search are in the query* · HD16 mobile-RTL e2e over the stage-3-8 screens · HD17 A21 executed with numbers in the doc → §3.I (`tests/load/payables.js`) · HD18 no raw enum reaches the DOM → `tests/unit/hd18-no-raw-enum.test.ts` › *every status, kind, state, outcome and lane in a screen is drawn through a translation*, `tests/integration/hd18-seeded-labels.test.ts` · HD19 the browser gets the namespaces it uses → `tests/unit/hd19-client-messages.test.ts` · HD14 → `tests/integration/hd14-payable-record.test.ts` |

Order: HARDEN-1 and 2 before the Stage-8 **cut-over**; 3 and 4 may land in
the same week but must not delay go-live beyond D-HD-1.

# §5 — Decisions, OPEN

| # | Question | Proposed default |
|---|---|---|
| D-HD-1 | Does go-live wait for all four stages? | Cut-over waits for HARDEN-1 + HARDEN-2 only; 3–4 follow within two weeks. |
| D-HD-2 | The business time zone, authoritatively | `Asia/Baghdad` for every business date; UTC remains for timestamps (`timestamptz`); `businessToday()` is the only sanctioned "today". |
| D-HD-3 | Lockout policy | 5 failures → 15-minute lock per account+IP; audit row per refusal; no captcha this release. |
| D-HD-4 | Delivery retry policy | 3 attempts, exponential backoff (1 m / 10 m / 60 m); a new `retry` column rather than reverting the forward-only trigger; terminal failures surface on the administration notifications screen. |
| D-HD-5 | MFA scope | CEO + accounting_manager + any role holding `post` or `approve` on money documents; enrolment grace of 7 days from first privileged sign-in. |
| D-HD-6 | RLS exemptions | Pure lookup/seed tables may be exempt but must be listed in the hd05 test's explicit exemption list — silence is a failure. |

## §6 — Decisions taken in the HARDEN-1 build (2026-10-02, built unattended; the sponsor may reverse any)

| # | Decision |
|---|---|
| B-HD-1 | D-HD-3 as proposed (5 failures → 15 min per account + address), plus a per-address cap of **100** failures in the window whatever the account, against the scrypt memory-DoS path. Twenty was tried and locked a whole office behind one NAT address out of its own system. The address is `X-Real-IP` (set by nginx) with `X-Forwarded-For` only as the fallback. |
| B-HD-2 | A refused sign-in is a *returned* value, not a thrown error, so the `sign_in_attempt` row and its audit event commit; the form still shows one message for every credential reason, and its own message for the lockout and for an expired temporary password. |
| B-HD-3 | D-HD-5 as proposed, with `system_administrator` added to the roles that require a factor (it can reset any password). Inside the seven-day grace the account signs in and finds a daily reminder in the bell; after it the session reaches only *My profile → Security*. Enrolment shows the setup key and the `otpauth://` address (no QR image in this build — every authenticator takes a typed key). |
| B-HD-4 | A restricted session (`'password'` / `'mfa'`) is computed on every request from the user row, never stored, so replacing the password or confirming the enrolment lifts it at once. The shell renders with no menu for it; `/password` and `/profile/security` are the only screens that pass `allowRestricted`. |
| B-HD-5 | HD1 is a `permissions_version` on `app_user`, bumped by every role, grant, branch, department and activation change, read by the shell after every client-side navigation through `/session/version`; a change triggers `router.refresh()`. |
| B-HD-6 | HD5: the notification table's SELECT policy is the recipient's; raising for somebody else and marking everybody's copy acted go through two `SECURITY DEFINER` functions (`app_notify`, `app_notification_mark_acted`), because `INSERT … RETURNING` is subject to the SELECT policy. A scheduled sweep that must read every notification marks its transaction (`markSystemSweep`); no web request does. The permission and authentication tables stay exempt until IMPROVE-3 SG-5 gives their administration screens accessor functions. |
| B-HD-7 | HD6: `document-actions.perform` authorises the action's verb through `authorize` before the status check, so the refusal is audited and the branch is checked; `workflow.submit` takes the submitter from the caller's context; `notifications.markRead` is scoped to the recipient; `record-action` accepts only a same-site path. |
| B-HD-9 | HARDEN-2: the business zone is `ERP_TIMEZONE` (default `Asia/Baghdad`), the one the interface already formats with, so what is written and what is shown agree (D-HD-2 as proposed). Display-only `Number()` remains where it is the last step before `Intl.NumberFormat`; everywhere a figure is stored, compared or summed it is a scaled bigint. The locks are `SELECT … FOR UPDATE` on the row being transitioned, taken before the status check, in the pattern the older document services already used. |
| B-HD-8 | The seeded CEO also holds `system_administrator`: assigning a role needs the CEO's hat *and* `administer permission` (`permitCeo`), and nobody else in the seed held both — which is also why the sponsor "gave the permission" from a CEO-plus-administrator account. The Users screen offers roles only to a CEO; this is unchanged. |
