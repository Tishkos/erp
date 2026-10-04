# Home (role-based command center) and My Approvals — implementation handoff

Platform phase, Wave 3, Agent 2. Branch `platform/dashboard`, base `3403b6d`.
No migration, no table, no control row.

This document says what exists, what it reads, what it refuses, and what the
next agents need. It does not claim production readiness: the screens were built
and exercised on development databases (`erp_dashboard`, `erp_test_dashboard`)
and a local Next development server, not on a live host.

## 1. Architecture

**Home is a registry, not a page.** Which widgets a person gets is data
(`domain/dashboard-widgets.ts`); what each shows is the service that owns the
figure; how it is drawn is one presenter per *shape*.

```
 app/(app)/page.tsx ── home.forViewer(tx, {principal, branchCode}, visibleRoute)
        │                    │
        │                    ├─ composeFor(principal, served)      pure   domain/dashboard-widgets.ts
        │                    │     widgets + quick actions the grants/roles earn, ordered by family rank
        │                    └─ LOADERS[key](ctx)  one at a time, each in a savepoint (safe-read.ts),
        │                          15 s statement timeout, run AS THE VIEWER   services/home-loaders.ts
        │                          └─ the owning service (dashboard, payables, logistics-views, …)
        │                             → typed cells (domain/dashboard-data.ts)  — money stays a decimal string
        └─ components/admin/home-widgets.tsx   KpiRow · ChartsBand · ListBand · QuietBand · UnavailableBand
              formats last: formatMoney / formatBusinessDate / formatTimestamp, in the reader's locale
```

* **Registry** — 45 widgets in three zones (18 figures, 9 charts, 18 lists) and
  15 quick actions. Each has a `key`, `requires` (all of) and `requiresAny`
  (at least one of) `view`/`create`/`submit` grants, an optional `capability`, a
  `family`, a `weight`, and `lead`/`hideWhenEmpty` flags. `holdsCapability`:
  `management` = the `ceo` role; `approver` = a super user, any `approve` grant,
  or a managed department; `assigner` = `submit` on `task`. A super user passes
  every grant check (`can`), so the admin sees the most.
* **Composition** — `rankFamilies` ranks the viewer's *families*: `management` first
  for a CEO (who then reads the data families in the declared order, money first),
  otherwise by the share of each family's anchor grants held (a small family fully
  held outranks a large one barely touched), `employee` last; `composeFor` orders each
  zone by that rank and then by weight, and `lead` widgets (approvals waiting, the
  attention slot) come first. A data family the viewer holds nothing of is returned in
  `unavailable` and said once on the page. Nothing is read from an email or a user id.
* **Outcomes** — a loader answers `ready` (a figure, a table, a chart or the
  import journey), `empty` (the viewer may see it and there is nothing — the
  widget's own sentence), `unreadable` (the read threw: said on the page,
  logged with the widget key, the rest of the page unaffected) or `unwired`
  (the Exception Center's slot before it is registered: not drawn).
* **Cells** — `text · code · money · qty · count · date · instant · word · chip ·
  say · none`. Words are keys resolved at draw time, so a table is data until the
  page speaks it.
* **Import journey** — `domain/import-journey.ts` shapes the logistics services'
  own stage computation (`payables.workbench` row + the Shipments rail's stage)
  for the imports in progress into Import application → Shipping → B/L →
  Container → Customs → Clearance → Landed cost → Receipt → Inventory. A stage the
  viewer cannot read evidence for is not in `stages` (so a zero never stands for
  "not allowed"); the page says "Steps your role cannot read are not shown."
* **My Approvals** — `services/approval-center.ts` (rules in
  `domain/approval-center.ts`) gathers, each source in its own savepoint:
  the workflow engine's inbox, kept only where `mayActOnStep` holds (a step that
  forbids the submitter does not list their own document); documents that wait in
  `submitted` for an `approve` grant (purchase orders, payment applications,
  purchase invoices, service receipts); and the HR `waitingFor` feeds (leave,
  payroll, advance, review, hire, request). `list()` sorts, filters
  (`q`, `documentType`) and pages (25). `decide()` is the only writer.

## 2. What was implemented

* **Home (`/`)**: title and the role's quick actions (the first is primary; a
  route the shell does not serve is left out) → figure tiles → "Trends" (only
  charts that have data) → lists with rows → one *Nothing to show* table (each
  widget the viewer may see that has nothing, or could not be read, with its own
  sentence) → *Not available for your role* (one sentence per family).
* **Figures** (stat tile): approvals waiting, cash and bank, receivables,
  payables, overdue receivables/payables (management), stock value, result this
  year, payment applications open, imports in progress (warn icon and note when a
  container is late), stock movements today, open purchase orders, sales this
  month, HR overview, active projects, my open tasks, unread notifications,
  unread chat. A dinar figure of eight digits or more is shown compact ("1B IQD")
  with the exact amount as the tile's title; shorter ones are whole.
* **Charts** (existing `Chart` figure with its table twin): income and expenses
  by month, receivable and payable ageing, cash by account, sales invoiced and
  collected, top customers, stock value by warehouse, the import journey.
* **Lists**: waiting for my approval, my next tasks, pinned saved views, biggest
  imports in progress, payments due in seven days, delayed containers, containers
  waiting on customs, landed costs not yet locked, goods in transit, containers
  ready to receive, stock at or below minimum, today's stock movements, open
  purchase orders, who is on leave, active projects, unread notifications,
  findings, recent activity.
* **My Approvals (`/approvals`)**: copies the Purchase Invoices register
  (toolbar, filter row, register table, paging). Columns: document (opens the
  real document), submitted by, type, submitted, amount, current stage (chip),
  action required. Chart accounts, journals and supplier/customer bank accounts
  are decided from the row (Approve; Reject with a required reason) through the
  services that own them; every other type says what is required and opens its
  page. Banners for sources that could not be read or routed. My submissions and
  My decisions follow as stacked registers.
* **Words**: `home` namespace (45 widgets × title/empty, 15 quick actions,
  columns, notes, sentences, journey, severities, domains, per-family
  "unavailable") and additions to `admin.approvals`, in both `messages/en.json`
  and `messages/ar.json`. `tests/unit/dash-messages.test.ts` reads the registry
  and the loaders' source for every key they use.
* **The `attention` slot** (Exception Center) is a widget with a loader that
  asks a registered feed and answers `unwired` until there is one. See §11.
* **Not built, by direction**: no exceptions widget of its own, no per-user
  layout editor, no tables or migrations.

## 3. Data source

Every figure comes from the service that owns it, called as the viewer (RLS
applies). Where no service returns the shape Home needs, the loader runs a
read-only aggregate of its own, under the same transaction and RLS: the open
purchase orders and their list, payment applications open, sales this month,
and stock at or below minimum (shelf warehouses only — never the in-transit one).

| Widgets | Read from |
|---|---|
| Cash, balances, receivable/payable totals and ageing, result, month-by-month, top customers, stock by warehouse, findings | `services/dashboard` (`balances`, `receivableAgeing`, `payableAgeing`, `monthlyResult`, `topCustomers`, `stockByWarehouse`, `attentionFor` — made `export`, bodies unchanged) |
| Imports, major imports, import journey, payments due | `payables.workbench` + the Shipments rail's stage (`logistics-views`) |
| Delayed containers, containers waiting on customs / ready to receive, landed costs, goods in transit | `logistics-views` (`inTransitInventory`, the tracking and landed-cost registers) |
| Today's stock movements, stock movements today | `stock-operations` (`countMovements`, `movements`) |
| Stock value | `dashboard.stockByWarehouse` → `inventory-reports.valuation` |
| Stock at or below minimum, open purchase orders (figure and list), payment applications open, sales this month | read-only aggregates in the loader (`inventory_movement` + `item.min_stock_level`; `purchase_order`; `payment_application`; `ar_invoice`) |
| HR overview, who is on leave | `hr-reports` |
| Projects | `project-system` |
| Tasks | `tasks.dashboardSummary` (Task Center feed) |
| Notifications | `notifications.unreadCountFor` / `listFor` (Notification Center feed) |
| Pinned views | `savedViews.pinnedFor` (Saved Views feed) |
| Chat unread | `chat-read.unreadBadge` (Chat feed) |
| Recent activity | `list.rows` on `audit_event`; the event is `audit_action.<code>` (the audit screen's catalogue) or the code made readable; the kind is `admin.audit.kinds.<type>` |
| Approvals | `approval-center` (see §1) |

Money is compared and summed as scaled bigints (`sumMoney`, `moneyOf`); `Number`
appears only as the last step before `Intl.NumberFormat` or a chart mark. "Today"
is `businessToday()`. A submitted purchase invoice's `total_iqd` is still zero (it
is written at posting), so the approval list sums its lines exactly as
`ap-invoice.list` does for the register.

## 4. Permissions

* A widget is shown only if the viewer holds its `requires` (and one of
  `requiresAny`) and, where it names one, its capability. A widget the viewer
  holds is never drawn and refused: loaders also read through RLS.
* The seeded personas produce different pages (proven by
  `tests/integration/dash-home.test.ts`): CEO (management tiles, overdue
  amounts, major imports, recent activity, the approvals shortcut), accounting
  manager (money, approvals), accounting officer (money; no approvals, no
  management tiles), logistics officer (imports, containers, goods in transit),
  a warehouse-like role (stock only), Erbil officer (own branch), outsider (no
  figures, nine "No X data is available for your role." sentences), admin (all).
* `/approvals` is open to a person with `view workflow_instance` **or** the
  `approver` capability (an HR manager decides leave without ever viewing a
  workflow); otherwise `Denied`.
* Deciding: `approval-center.decide` refuses a document type that is not decided
  inline (`ApprovalNotRoutableError`), a rejection without a reason
  (`DecisionReasonMissingError`), and then the owning service applies its own
  rule — four eyes, role, department, period. The list says "Saved" only after
  the service returned; a refusal comes back in the service's own sentence.
* Branch scope: the loaders receive the viewer's branch; stock and ledger
  figures follow it (an Erbil officer sees Erbil).

## 5. Database changes

None. No migration, no table, no trigger, no seed, no `resetTestData` /
`format-live-database.sh` entry. Controls register: no row added (no enforced
control was added).

## 6. Routes

| Route | Change |
|---|---|
| `/` | Rewritten: `app/(app)/page.tsx` (composition only) |
| `/approvals` | Rewritten: `app/(app)/approvals/page.tsx`, `actions.ts` (`approveItem`, `rejectItem`) |

No route added, moved or removed. `RESTRICTION_ROUTE` and the menu are untouched.

## 7. Shared files touched (additive only)

* `src/server/services/dashboard.ts` — `export` added to `receivableAgeing`,
  `payableAgeing`, `balances`, `attentionFor`, `monthlyResult`,
  `stockByWarehouse`, `topCustomers`. Bodies unchanged.
* `src/server/services/approvals.ts` — `InboxItem.allowSelfApproval` (the step's
  own flag), selected in `inbox()`. No other caller reads it.
* `messages/en.json`, `messages/ar.json` — new `home` namespace; additions to
  `admin.approvals` (column, stage, action and type words). One trailing comma
  changed on an existing line; nothing renamed or removed.
* `AGENTS.md` — one section appended ("Home and My Approvals").
* New files: `domain/{dashboard-widgets,dashboard-data,dashboard-charts,import-journey,approval-center}.ts`,
  `services/{home,home-loaders,approval-center,safe-read}.ts`,
  `components/admin/home-widgets.tsx`, and the tests in §8.

`CLIENT_NAMESPACES` is unchanged: Home and My Approvals are server components.

## 8. Targeted checks run

On `erp_dashboard` (dev) and `erp_test_dashboard` (tests), never `.env` defaults
for a test run; every command through `heavy`.

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| Unit: `dash-widgets`, `dash-charts`, `dash-messages` | 67 passed (56 + 11) |
| Guards: `delivered-screens`, `fx1-menu`, `hd18-no-raw-enum`, `hd19-client-messages`, `i18n-catalogue`, `screen-catalogue`, `screens-name-their-own-route` (with the three above) | 109 passed in 10 files |
| Integration: `dash-home.test.ts` (own database) | 35 passed |
| Integration: `hd07-business-today.test.ts` (greps for `toISOString().slice`) | 2 passed |
| Playwright: `dash-home.spec.ts` | 8 passed |
| Playwright: `theme-readability.spec.ts` | 14 passed |

What `dash-home.test.ts` proves: composition differs for ceo / manager / officer /
outsider / admin / warehouse / logistics / Erbil; figures equal the services'
figures to the dinar (a 10 × 20,000 sale, a 100-panel import with a received
container and a late sweep, stock including transit); branch scope; every empty
state; the attention slot (a registered fake feed, a throwing feed, none); the
statement timeout is restored; approvals list only what the viewer can act on
(four eyes: a purchase order's creator is not asked, a super user is), filters and
paging, a rejection needs its reason, journal approve and reject, bank-account
verify, `ApprovalNotRoutableError`, the invoice's amount from its lines; low stock lists the shelf warehouse and not the in-transit one.

What `dash-home.spec.ts` proves in a browser: CEO, warehouse-role, officer and
no-role pages differ in headings, tiles and sentences; an account the officer
raised is not in the officer's list, is in the manager's with a link to the real
account, is approved from the row ("Saved"), leaves the waiting register and the
account page says Approved; an error in the address is the error banner, never
"Saved"; Arabic at 390px for `/`, `/approvals`, `/tasks`, `/payables/invoices`
has `dir=rtl`, no sideways scroll, no raw key and no console or page error.

Visual checks beyond the specs: a throwaway Playwright pass against the
test-database world (imports, containers, a late container, stock in two
warehouses, a sale, five waiting documents) as CEO-like, logistics, warehouse,
officer, Erbil and admin, desktop, and Arabic at 390px. It found and fixed:
money overflowing its tile, one yellow banner per empty chart or list, a
timestamp read back to front in Arabic, an invoice shown as "0 IQD", and
"Approved" with no record kind in Recent activity. The pass was not kept as a
spec (it needs the integration world).

Not run: full suites, `test:integration`, k6, other agents' specs, a production
build.

## 9. Commits

| Hash | What |
|---|---|
| `64ca020` | Registry, chart shaping, import journey and approval-list rules (pure) with unit tests |
| `99710b5` | Home loaders and composer, approval center service, safe-read; additive exports |
| `55a9eb6` | Integration test for composition, figures, scope, empty states and My Approvals |
| `9e6c5b9` | Screens, presenters, EN+AR messages, e2e spec, AGENTS.md section, invoice amount |
| (the commit that adds this file) | This document |

Screenshots: `/home/claude/shots/dashboard/` — `home-{ceo,officer,warehouse,outsider}-desktop-en.png`,
`home-ceo-mobile-ar.png`, `home-warehouse-mobile-ar.png`,
`approvals-manager-desktop-en.png`, and the neighbours at 390px Arabic
(`approvals-ceo-mobile-ar.png` beside `invoices-ceo-mobile-ar.png` and
`tasks-ceo-mobile-ar.png`, composed in `side-by-side-approvals-invoices-tasks-mobile-ar.png`).
The `rich-*.png` files are the data-rich pass of §8, taken before its last two
fixes (invoice amount, record kind in Recent activity).

## 10. Remaining limitations

* **No My Approvals entry in the HR manager's menu.** The page opens for them
  (the `approver` capability) but `menu.ts` gates the item on `workflow_instance`
  and is shared; not changed here.
* **Phone width is long for a CEO**: the stat tile grid is one column below
  ~430px (`.statRow` is `minmax(13rem, 1fr)`), so eighteen tiles stack. Not
  changed (no new CSS).
* **The `Chart` figure's disclosure text is the literal "Table"** in every
  language (pre-existing in `charts.tsx`); it shows in Arabic as "Table".
* **Only three document types are decided from the row.** Everything else opens
  its page, where its own button lives.
* **Stacked registers touch** on `/approvals` (`.sapRegister .sapWindow` has no
  bottom margin), as on the other register pages.
* **No layout is stored per user**, and the figure tiles are not capped: an admin
  sees every tile.
* **Event names in Recent activity** come from the `audit_action` catalogue where
  an entry exists, otherwise the code made readable; kinds from the 15 in
  `admin.audit.kinds`, otherwise the code made readable.
* **The attention slot is not wired** (§11).
* **`src/components/dashboard-workspace.tsx` is dead code** (nothing imports it)
  that predates this work; left alone.
* **A container is `late` only after `shipments.lateSweep`.** Home follows the
  engine; if the sweep does not run, nothing is delayed.
* Figures were exercised on development databases only, not against production
  volumes; the 15 s statement timeout bounds each read, and nothing was load-tested.

## 11. What the next agents need from you

**Wiring the Exception Center (the orchestrator, after the merge).** At the
bottom of `src/server/services/home-loaders.ts`:

```ts
import * as exceptions from './exceptions';

registerAttentionFeed({
  open: (tx, principal, options) => exceptions.openFor(tx, principal, options),
  counts: (tx, principal) => exceptions.countsFor(tx, principal),
});
```

The feed contract is `AttentionFeed` in the same file (RULES-PLATFORM §10):
`open(tx, principal, { limit })` returns `AttentionRow`s — `id`, `no`, `severity`
(`critical|high|medium|low`), `domain` (`accounting|receivables|payables|inventory|logistics|tasks|approvals|platform`),
`title`, `explanation`, `recordType`, `recordId`, `href`, `createdAt`, `ownerName`
— already filtered to what the principal may see; `counts(tx, principal)` returns
`{ total, bySeverity, byDomain }`. The widget is a `lead` list that hides when
empty and links "See all" to `/exceptions` (only if the shell serves it). Words for severities and areas are in `home.severity.*` and
`home.domain.*`. Tests unregister with `registerAttentionFeed(null)`.

**Adding a widget.** A row in `WIDGETS`; a loader in `LOADERS_BY_KEY` (the type
requires it); `home.widget.<key>.title|empty` and any `home.col.*`, `home.note.*`,
`home.say.*`, `home.value.*` the loader names, in both message files
(`dash-messages.test.ts` reads the loader source and fails on a missing one); a
case in `dash-home.test.ts`. A loader calls the service that owns the figure, as
the viewer, and returns typed cells; money stays a decimal string.

**Adding an inline approval.** An entry in `HANDLERS` (`resolve`, `approve`,
`reject`, calling the owning service) in `services/approval-center.ts`; a source
in `APPROVAL_SOURCES` if it is a new kind of queue; `admin.approvals.type_<code>`
in both files.

**Other agents.** Tasks, Notifications, Saved Views (pinned) and Chat are read
through their services' feed functions listed in §3; if one is renamed, the
loader (`home-loaders.ts`) is the only place to follow. The menu item for
`/approvals` (see §10) is `menu.ts`'s.

**Test hygiene.** `dash-home.test.ts` builds its world with the import fixtures
and needs its own database (`DATABASE_URL_TEST` pointing at one nobody else
resets). `dash-home.spec.ts` writes one fixture of its own as the owner (a
`dash_e2e_warehouse` role, `warehouse.home@example.com`) and is idempotent.
