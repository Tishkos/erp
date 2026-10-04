# Saved views and the personal workspace — implementation handoff

Platform phase, Wave 2, Agent 8. Branch `platform/saved-views`, base `94f02ef`.
Migration block 0360 (journal idx 226, `when` 1795900000170). Controls C-74 to C-77.

This document says what exists, what it reads, what it refuses, and what the
next agents need. It does not claim production readiness: the feature was built
and exercised on a development database and a local production build, not on a
live host.

## 1. Architecture

**A view is a screen's question, never its answer.** A saved view stores the
query-string configuration of a list or report screen: the registry key of the
screen, the parameters it declared, the names of relative-date rules, the view's
name and its owner. It never stores a row, a record id or an amount owed.

```
 page.tsx ── savedViewsFor(key, searchParams) ──► stateFor()  ─┬─ default view? ► redirect()
    │                                                           └─ SavedViewsState
    ├─ reads its filters from saved.current.params
    ├─ runs its OWN query (service + RLS + branch scope), as the viewer
    └─ <SavedViewsMenu state={saved} />  ─► ViewsDialog (save form, views as cards)
                                             └─ forms ► profile/views/actions.ts ► services/saved-views.ts ► audit
```

Four layers, each small:

1. **Registry** — `src/server/domain/saved-view-routes.ts`. One `ViewableRoute`
   per screen: `key` (`area.screen`, stored for ever), `route`, `params`
   (name → `text | token | enum | flag | date | amount`, enums with a label
   source), optional `slots` (a `range` over two date parameters or a `point`
   over one). The header of the file is the "how to add a screen" guide.
2. **Pure rules** — `src/server/domain/saved-views.ts`. `sanitiseParams` (what
   the address says), `storedFrom` (what is kept), `resolveStored` (what is
   opened today: rules evaluated from `businessToday()`, a parameter the screen
   no longer accepts dropped and reported), `defaultRedirect`, name rules. No
   database, no clock of its own.
3. **Service** — `src/server/services/saved-views.ts`. Two halves in one file:
   the list framework's old `save/listFor/open/defaultFor/remove` (now limited
   to `kind = 'list'`) and the screen-view half: `createRouteView`,
   `renameRouteView`, `duplicateRouteView`, `deleteRouteView`,
   `setDefaultRouteView`, `pinRouteView`, `listRouteViews`, `stateFor`,
   `pinnedFor`, `availabilityOf`. Every change writes its audit event in the same
   transaction.
4. **Screens** — `savedViewsFor` (`src/server/saved-views-gate.ts`) in the page,
   `SavedViewsMenu` (`src/components/saved-views/`) in the toolbar, forms in
   `src/app/(app)/profile/views/actions.ts`.

**Counts without a second query.** The screens' filters moved into shared
functions that both the page and the pinned counter call:
`src/server/domain/register-filters.ts` (`rowMatches`, `filterInvoiceRegister`,
`filterContainerRegister`, `filterPartnerRegister`) and
`src/server/services/screen-registers.ts` (`invoiceRegister`,
`containerRegister`, `partnerRegister`). `services/saved-view-counts.ts` has one
counter per counted screen, each calling the screen's own function.

## 2. What was implemented

* **Table change, not a new table.** `saved_view` (0019) gained `kind`
  (`list` = the list framework's rows, untouched; `route` = a screen view) and
  `pinned_at`. See section 5.
* **Registry of 16 screens** (section 6) covering Payables invoices, Sales
  invoices and receipts, Imports/containers, Inventory availability and stock
  lists, Business partner lists, and the logistics registers. The Task Center
  slot is left open (section 9).
* **Save current view** — a name dialog in the Views menu. The form keeps the
  filters on screen exactly as the registry accepts them; where a screen has a
  date slot, a select offers "keep these dates" or a rule (this month, last 30
  days, today, end of month …). Rules are stored as rule names and evaluated with
  `businessToday()` each time the view opens.
* **Views menu** next to the filters (in the `ListToolbar` children slot; a
  report with no toolbar puts it in `AdminPage` `actions`). Per view: Open,
  rename (in place), duplicate, delete (confirm), make default / clear default,
  pin / unpin to Home. Badges: Showing now, Default, On Home, Unavailable plus
  the reason. A dropped stored parameter is announced with a note on the view.
* **Default view** applies on a bare arrival only (no registered parameter and no
  `sv` in the address). `?sv=none` is the way round it ("Show without a view").
  `saved` and `error` travel with the redirect.
* **`/profile/views`** — the management list (register table, rename, badges,
  all actions, "Saved views" fact with a count on `/profile`).
* **`savedViews.pinnedFor(tx, principal, { branchCode?, today?, counts? })`** —
  returns `{ title, route, params, count?, … }` per pinned view for the Home
  page (section 10 for the full shape).
* **No fake success.** Every action returns to the page with `saved=1` only after
  the commit, or with `error=` in the person's language.
* **Audit** — `saved_view.created | renamed | duplicated | deleted | default_set
  | default_cleared | pinned | unpinned`, labelled in both locales; a displaced
  default is audited too.
* **New filter controls** that the saved views needed, using existing
  components: Purchase Invoices *Minimum amount* (compared as scaled bigints),
  Containers *ETA from / to*, Customers and Suppliers *Status*.
* English and Arabic (both message files), RTL, mobile 390 px.

## 3. Data source

* Reads and writes only `saved_view` (and `audit_event`). A view's `query` column
  holds `{ "v": 1, "params": { … }, "dates": { slot: rule } }`, at most 4 kB.
* Opening a view is a link to the screen with the parameters in the address. The
  screen then runs **its own** server query. Nothing in the saved-views code
  composes SQL against business tables except the pinned counters, which call
  the screen's own register function (`invoiceRegister`, `containerRegister`,
  `partnerRegister`, or the screen's `…ForScreen` service) in a savepoint.
* A count is never stored. Home asks again each time.
* "Today" is `businessToday()` (Asia/Baghdad); audit payloads carry ISO strings.

## 4. Permissions

* **Owner-only, enforced by the database.** The read policy shows other people's
  *list* views only; a route view is read by its owner and nobody else — a super
  user included. `saved_view_route_private` (check) forbids `is_shared` on a
  route view. There is no sharing.
* **Every run applies the viewer's grants now.** `availabilityOf` asks
  `visibleRoute` and `can(verb, object)` (the menu item's own, or a registry
  override) for the current principal. A view of a screen the person can no
  longer open is listed as **unavailable with the reason** (`no_access`,
  `not_delivered`, `unknown_screen`), never hidden; it has no link, no default
  redirect, no new default/pin/copy and no count, but can still be renamed,
  un-defaulted, unpinned and deleted.
* **The screen decides the rows.** Because opening a view only navigates to the
  screen, the screen's own service, RLS and branch scope answer. A view cannot
  show more than the viewer may see today. Tested with a real `role_grant`
  delete and a real change of branch (count 0 in another branch).
* `confirm` of delete uses the existing `ConfirmButton`.

## 5. Database changes

`src/server/db/migrations/0360_saved_route_views.sql` (journal idx 226,
`when` 1795900000170, after the journal's previous last entry):

* `saved_view.kind text not null default 'list'`, `saved_view.pinned_at timestamptz`.
* Checks: `saved_view_kind_known`, `saved_view_route_private`,
  `saved_view_route_keyed`, `saved_view_route_config`, `saved_view_route_name`,
  `saved_view_pin_is_route`.
* Index `saved_view_pinned_idx`.
* Trigger `saved_view_route_guard`: a view keeps its owner, kind and screen for
  life; at most 100 route views per person and 12 pinned.
* Read policy recreated: owner, or shared with `kind = 'list'`.
* `src/server/db/schema/ui.ts` mirrors the columns.

`saved_view` is in `resetTestData` and in ops16's `NOT_DOCUMENTS` (no document,
no journal, no stock). Controls: C-74 to C-77 in `docs/CONTROLS.md`.

## 6. Routes

Registry (key → route), 16 screens:

| Key | Route | Counted on Home |
|---|---|---|
| `payables.invoices` | `/payables/invoices` | yes |
| `payables.open_items` | `/payables/open-items` | yes |
| `payables.suppliers` | `/payables/suppliers` | yes |
| `sales.receivables` | `/sales/receivables` | yes |
| `sales.invoices` | `/sales/ar-invoices` | no |
| `sales.receipts` | `/sales/customer-receipts` | no |
| `sales.customers` | `/sales/customers` | yes |
| `imports.containers` | `/payables/containers` | yes |
| `imports.shipments` | `/payables/shipments` | no |
| `imports.pd` | `/payables/pd` | yes |
| `logistics.shipment_tracking` | `/logistics/shipment-tracking` | no |
| `logistics.in_transit` | `/logistics/in-transit` | no |
| `logistics.customs_declarations` | `/logistics/customs-declarations` | yes |
| `inventory.availability` | `/inventory/availability` | yes |
| `inventory.stock_movements` | `/inventory/stock-movements` | no |
| `inventory.stock_ledger` | `/inventory/stock-ledger` | no |

New screens: `/profile/views` (management list). New server actions:
`profile/views/actions.ts` (`saveView`, `renameView`, `duplicateView`,
`deleteView`, `setDefaultView`, `pinView`). No new API route. Global Search is
deliberately untouched (no registration).

## 7. Shared files touched (additive only)

Messages: `messages/en.json`, `messages/ar.json` (namespace `savedViews`,
`audit_action.saved_view.*`, `admin.audit.kinds.saved_view`,
`admin.expenses.min_amount`, `admin.shipments.eta_from/eta_to`,
`admin.partners.status_all/filter`).

Database: `src/server/db/migrations/meta/_journal.json` (one entry),
`src/server/db/schema/ui.ts`.

Components: `src/components/admin/index.tsx` (`matches` delegates to
`rowMatches`), `confirm-button.tsx` (per-dialog title id via `useId`),
`partner-list.tsx` (shared register, status filter, menu),
`open-items-report.tsx` (menu, supplier side only), `receivables-ageing.tsx`
(menu).

Pages (each: `savedViewsFor` + `SavedViewsMenu`, and where noted a filter
control): `payables/invoices` (Minimum amount), `payables/containers` (ETA
from/to), `payables/shipments`, `payables/pd`, `sales/ar-invoices`,
`sales/customer-receipts`, `logistics/shipment-tracking`,
`logistics/in-transit`, `logistics/customs-declarations`,
`inventory/availability`, `inventory/stock-movements`,
`inventory/stock-ledger`, `profile/page.tsx` (Saved views fact).

Docs: `docs/CONTROLS.md` (C-74 to C-77), `AGENTS.md` (one section).

Not touched: the Dashboard, Global Search, `erp-shell.tsx`, any CSS file.

## 8. Targeted checks run

All through `/home/claude/bin/heavy`, on this worktree's own databases
(`erp_views`, `erp_test_views`). The full unit and integration suites were not run.

| Check | Command | Result |
|---|---|---|
| Unit: rules and registry | `npx vitest run --project unit tests/unit/sv01-saved-views.test.ts tests/unit/sv01-saved-view-routes.test.ts` | 35 passed (24 + 11) |
| Unit guards | `… tests/unit/{hd18-no-raw-enum,hd19-client-messages,screens-name-their-own-route,hd12-errors-not-404,fx1-menu,fx1-set-up-people-menu,i18n-catalogue,delivered-screens,screen-catalogue,im04-live-guard}.test.ts` | all passed |
| Controls register | `… tests/unit/im15-controls-register.test.ts` | 2 of 3 passed; "numbered without gaps" fails: first row is C-74 where C-66 is expected. C-66 to C-73 belong to the Task and Notification builders and are not in this branch. Expected to clear on merge. |
| Integration | `npx vitest run --project integration tests/integration/sv01-saved-views.test.ts tests/integration/hd07-business-today.test.ts tests/integration/platform-list-framework.test.ts` | 56 passed (sv01: 27) |
| Document tables | `npx vitest run --project integration tests/integration/ops16-document-table-lists.test.ts` | 3 passed |
| Typecheck | `npm run typecheck` | clean |
| Playwright | `npx playwright test -c playwright.local.config.ts tests/e2e/saved-views.spec.ts --workers=1 --project=chromium` | 4 passed |
| Theme | `… tests/e2e/theme-readability.spec.ts --workers=1 --project=chromium` | 14 passed |

How the browser runs were made: the dev server is OOM-killed by the shared
cgroup, so a production build was used (`NODE_ENV=production
NEXT_DIST_DIR=.next-prod NEXT_FONT_GOOGLE_MOCKED_RESPONSES=… next build`, then
`next start -p 3008`, with the mock fonts served on 3999). `.env` sets
`NODE_ENV=development`; a build run with it fails at `/_global-error` prerender —
set `NODE_ENV=production` for the build. `tsconfig.json` was reverted after
every build.

What the tests cover:

* Unit: parameter validation per kind, relative date rules for several `today`
  values, dropping stored parameters the screen no longer accepts, default-view
  selection (bare arrival only), name rules, and that the registry matches the
  shell (every route a delivered menu screen, every label in both locales, every
  key asked for by a page that draws the menu).
* Integration (own database): create/rename/duplicate/delete/default/pin with the
  audit event for each and no row or event for a refusal; relative rules;
  default race and pin double-submit; owner isolation including a super user;
  database constraints; a revoked grant (real `role_grant` delete) and a changed
  branch; dropped and orphaned params; `pinnedFor` ordering, counts and the
  bigint boundary of Minimum amount; `stateFor` redirects.
* Playwright: save a filtered Payables list, reload, apply, set default, `sv=none`,
  pin, audit order; `/profile/views` rename, name-taken error, delete after a
  confirmation; every registered screen offers the menu; Arabic 390 px views menu.

Screenshots in `/home/claude/shots/views/`: `invoices-list-desktop-en`,
`invoices-list-mobile-ar`, `invoices-views-menu-desktop-en`,
`invoices-views-menu-empty-desktop-en`, `profile-views-desktop-en`,
`profile-views-mobile-ar`, `views-menu-mobile-ar`, `stock-ledger-views-desktop-en`.

## 9. Commits

| Hash | Subject |
|---|---|
| `be74891` | pure rules, screen registry, migration 0360 (screen views in saved_view, pinning) |
| `10e14cf` | screen-view service (create, rename, duplicate, delete, default, pin), shared registers and pinned counts |
| `f614a74` | Views menu, /profile/views, server actions, 16 screens wired, shared registers |
| `7e9ceda` | registry unit test and integration suite |
| `0420b7b` | menu as inbox cards, closes on link, Playwright spec, controls C-74 to C-77, AGENTS section |

The final commit (this document) follows `0420b7b` on the branch.

## 10. Remaining limitations

* **No sort and no column selection are stored.** None of the registered screens
  takes either from the address; when one does, add the parameter to its entry.
* **No sharing**, by design (check constraint and read policy).
* **Home draws pins only once the Dashboard calls `pinnedFor`.** The Dashboard
  was not edited, as instructed.
* **The Tasks slot is open.** `tasks.my` is described in the registry header and
  is not declared, because an entry for an unserved route would only show as
  unavailable.
* **Counters exist for 9 of 16 screens.** A pin of the other seven opens fine and
  shows no count (`count: null`).
* **Controls register gap** C-66 to C-73 (above) until the other builders merge.
* **No Global Search registration**, by instruction.
* **The Views button on report screens** (open items, receivables ageing, stock
  movements, stock ledger) sits in `AdminPage` `actions`, not in a `ListToolbar`,
  because those screens have none.
* **`/profile/views` is a register table** and scrolls sideways on a phone like
  every register; the per-screen menu uses inbox cards for that reason.
* A raw date or amount in a view's description is shown as stored (for example
  `1000000`), not locale-formatted.
* Exercised on a development database and a local production build only. Nothing
  here was run against a live host, and this is not a statement of production
  readiness.

## 11. What the next agents need from you

**Dashboard (Agent 2).** Call, inside `withCurrentUser` so the transaction carries
the viewer's scope:

```ts
const pins = await savedViews.pinnedFor(tx, principal, { branchCode });
```

Each element: `{ id, title, route, params, href, available, unavailable, count,
screenKey, routeKey, dropped, pinnedAt }`, oldest pin first. Draw `title` as a
link to `href` (null when unavailable), `count` beside it when it is not null, and
the `unavailable` reason (`savedViews.unavailable_<reason>`) when `available` is
false. `count` is the screen's own query run as the viewer, in a savepoint; a
failed or missing counter gives `null`, never an error. Pass `{ counts: false }`
for a title-only list. Never cache or store the count.

**Task Center (Agent 3).** Add one entry to `VIEWABLE_ROUTES` — for example
`{ key: 'tasks.my', route: '/tasks', params: { view: …, due_from: …, due_to: … },
slots: [{ id: 'due', kind: 'range', from: 'due_from', to: 'due_to' }] }`
— then in the page, after its permission check, `const saved = await
savedViewsFor('tasks.my', searchParams)` and `<SavedViewsMenu state={saved} />` in
its toolbar. The route must be a delivered menu screen. Optionally add a counter
in `services/saved-view-counts.ts` that calls the Task Center's own list query.
`tests/unit/sv01-saved-view-routes.test.ts` fails if a label, a slot parameter or
the route is missing.

**Anyone adding a screen.** Follow the "how to add a screen" header of
`saved-view-routes.ts`; read filters from `saved.current.params` where you want
the registry's validation; keep the page's query in one function that a counter
can call.

**Whoever merges.** Migration 0360 uses journal `when` 1795900000170 and idx 226;
order it against the other builders' migrations by `_journal.json` `when`, never by
file name. Add C-66 to C-73 from the other builders and the
`im15-controls-register` gap closes. `messages/en.json` and `ar.json` are the
likeliest textual conflicts (namespace `savedViews` is self-contained).
