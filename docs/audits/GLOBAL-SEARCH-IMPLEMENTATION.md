# Global Search — implementation record (platform phase, Agent 5)

Branch `platform/global-search` · worktree `/home/claude/wt/search` · databases
`erp_search` / `erp_test_search` · port 3005 · migration `0330_global_search`
(journal `idx` 220, `when` 1795900000140).

This is a record of what was built and how to extend it. It claims no more than
the targeted checks listed in "Checks run" show; nothing here has been run
against the merged tree, the full unit suite or the full integration suite.

## 1. What it is

One search box for the whole ERP: **Ctrl/Cmd+K** from anywhere opens a palette,
a phrase is sent to the server, and what comes back is grouped by record type
(customers, suppliers, employees, items, … purchase invoices, … B/Ls,
containers, PDs, files) together with the screens the person may open. "See all
results" opens `/search`, a list screen with the same groups, paged.

* **Server-side only.** The browser holds the phrase and the answer. No table, no
  index and no list of records is ever sent to the client for filtering there.
* **As the asker.** Every query runs in the asker's own transaction (their RLS
  scope), which PostgreSQL holds read-only (`set local transaction_read_only`)
  with a 5 s statement timeout. A type the asker has no view grant for is never
  queried.
* **Read-only, no memory.** Search writes no row — no audit event, no history of
  phrases. (`gs-global-search` › "the search writes nothing" holds both.)

## 2. Architecture

```
Palette (components/global-search.tsx)  ──GET /search/results?q=──►  route.ts ─┐
/search page (app/(app)/search/page.tsx) ───────────────────────────────────────┤
                                                                                ▼
                          services/global-search.ts   search() / searchAs()
                            │ planQuery()  (domain/search.ts — pure)
                            │ for each registered type the asker may view:
                            │    savepoint → runTableType() | type.run()  → rollback on failure
                            ▼
              search/registry.ts  ◄── search/entities/*.ts (declarations)
              search/table-query.ts  (one SQL per table type)
              search/present.ts + deps.ts (translation, dates, money — server side)
```

| File | Role |
|---|---|
| `src/server/domain/search.ts` | Pure. Phrase normalisation, number shapes (`API-BGW-2026-12`, `AP-12`, `12`), series matching against `doc_sequence`, tiers, ordering, status chips, screens matching, `foldText`, `rawVariants`, `prefixUpperBound`. |
| `src/server/search/types.ts` | The declaration shapes: `SearchTableType`, `SearchCustomType`. |
| `src/server/search/registry.ts` | `registerSearchType`, `unregisterSearchType`, `searchTypes`, `searchType`. Held on `globalThis[Symbol.for('qimah.search.types')]` so the route, the page and server actions share one map. |
| `src/server/search/entities/` | `masters.ts`, `documents.ts`, `logistics.ts`, `files.ts`; `index.ts` holds `BUILT_IN` and `registerBuiltInSearchTypes()`. |
| `src/server/search/table-query.ts` | Turns a table declaration into one SQL statement (branches per number / serial / reference / name / party, ids joined back once). |
| `src/server/services/global-search.ts` | `search(tx, principal, input)`, `searchAs(scope, principal, input)`, `mayView`, `mayAmount`, `visibleScreens`. |
| `src/server/search/present.ts`, `deps.ts` | Status through `search.status.<code>`, group heading through `search.types.<key>`, dates through `formatBusinessDate`, money through `formatMoney`. |
| `src/app/(app)/search/results/route.ts` | The palette's JSON endpoint (401 when signed out; empty for a restricted session). |
| `src/app/(app)/search/page.tsx` | `/search?q=&type=&page=` — list-screen model (AdminPage → SectionTabs → title → register tables → paging). |
| `src/components/global-search.tsx` | The palette (the existing component, props unchanged, rewritten in place; it was the screens-only palette). `erp-shell.tsx` is **not** touched — it already imported `GlobalSearch`. |

### Ranking

Tiers: **0** the whole number/code/name is the phrase · **1** the phrase's serial
(`AP-12` → serial 12 of a series whose prefix begins AP) · **2** begins with ·
**3** contains · **4** names the record's party (invoices *of* "Al Noor").
Groups are ordered by best tier (2 and 3 count as one "name hit"), then master
records before documents before logistics before files (`priority`), so a name
finds the customer before the invoices that merely name it, and a document number
typed whole finds that document first and alone. Series are read from
`doc_sequence` at query time, so a series added tomorrow (`TASK`) is understood
the moment it exists.

### Folding

`search_fold(text)` (migration 0330, IMMUTABLE SQL) and `foldText` (TypeScript)
are the same function: lower case, Arabic marks and tatweel dropped, alef family →
ا, ى → ي, ة → ه, ؤ → و, ئ → ي, Arabic-Indic and Extended digits → 0–9.
`gs-global-search` › "search_fold in the database and foldText in the code agree"
holds them equal.

## 3. What is registered today

| Group (`key`) | Table | View grant | List screen | Money shown under |
|---|---|---|---|---|
| `customer`, `supplier` | `business_partner` | `business_partner` | `/sales/customers`, `/payables/suppliers` | — |
| `employee` | `employee` | `employee` | `/hr/employees` | **never** (number, name, status only) |
| `item` | `item` | `item` | `/inventory/items` | selling price under `price_list` |
| `warehouse` | `warehouse` (no RLS; `app_branch_allowed` applied in the query) | `warehouse` | `/master-data/warehouses` | — |
| `bank_cash_account` | `bank_cash_account` | `bank_account` | `/master-data/bank-accounts` | — |
| `chart_of_account` | `chart_of_account` | `chart_of_account` | `/master-data/chart-of-accounts` | — |
| `project` | `project` | `project` | `/projects` | contract value |
| `ap_invoice`, `ar_invoice` | same | same | `/payables/invoices`, `/sales/ar-invoices` | total |
| `supplier_payment`, `customer_receipt`, `payment_application` | same | same | their registers | amount |
| `purchase_order`, `goods_receipt`, `sales_return` | same | same | their registers | — |
| `journal_entry` | `journal_entry` | `journal_entry` | `/finance/journals` | total debit |
| `bank_loan` | `bank_loan` | `bank_loan` | `/treasury/loans` | principal (loans are company-wide, as the screen is: `bank_loan_scope app_signed_in()`) |
| `payable` (import application, local purchase, service, rent, advance) | `payable` | `payable` | `/payables` | amount |
| `bill_of_lading`, `shipment_container`, `customs_pd`, `customs_declaration` | same | same | their registers | declaration value |
| `attachment` | `attachment` + parent check | `attachment` | — (opens the parent record) | — |
| screens | the menu tree | the shell's own rule | — | — |

Not registered, on purpose: sales orders and delivery notes (their list routes
are not delivered — a result must open), and nothing for tasks, documents or
chat (those arrive with their own modules, below).

## 4. Permissions — the rule, and how it is held

A result is returned only if **both** hold:

1. the asker holds the type's view grant (`can(principal, 'view', object)`) and
   its list screen is served (`visibleRoute(route)`); a type failing this is not
   queried at all, so it cannot be found by a count, a "no results" difference or
   another field matching;
2. the row passes the table's own row policy / branch scope — the query runs as
   the asker, so PostgreSQL applies it before anything is returned.

Where a table has **no** row policy (warehouse) the type's `where` carries the
branch rule (`app_branch_allowed`). **Files** are seen by whoever could download
them: `attachment` view + the attachment row policy + the check the file's parent
type registered with the attachment service (`attachments.mayAccessParent`, a new
export of the existing rule `assertParentAccess` as a question). A file whose
parent refuses it is dropped; a file of a record whose screen is not served opens
`/attachments/<id>` rather than the record.

Tests (`tests/integration/gs-global-search.test.ts`, 39): a person with no grants
finds nothing whatever they type; a person with only `ap_invoice` finds invoices
and not suppliers or files; a BGW officer does not find an EBL invoice, B/L,
container, PD, file or warehouse, by number, name or reference; EBL's user does;
the file test covers "holds `attachment` but not `ap_invoice`"; money is absent
without the grant; an employee never carries pay, even for a super user.

## 5. Performance — the finding that shaped the queries

**Row-level security and LIKE.** A table under a row policy has the policy applied
*before* the query's own conditions, and PostgreSQL lets only **leakproof**
operators run ahead of it. `=`, `<`, `<=`, `>`, `>=` on text/uuid/int are
leakproof; `LIKE`, `lower()`, `search_fold()`, `regexp_replace`, `translate` and
every pg_trgm operator are not. On such a table a trigram index is therefore never
an index condition, and the person's query becomes a filter over every row they may
see. The first design (GIN trigram indexes on every searched column) measured, on a
volume database (300,000 purchase invoices, 150,000 partners, 50,000 items, 60,000
files; the other tables empty): 0.75–1.4 s for a super user and 4–7 s, with
statement timeouts, for a branch-scoped one.

What is built instead (`table-query.ts`, header comment; `0330` header):

* **Tables with no row policy** (partners, items, warehouses, accounts, bank/cash
  accounts) keep their trigram GIN indexes over `search_fold(column)`. Which tables
  have a policy is read from `pg_class.relrowsecurity` once per process
  (`rowSecurityTables`).
* **Numbers and references** (`number`, `refs`) on a policed table are looked up
  with comparisons only — `col >= 'X' and col < 'Y'` for "begins with"
  (`prefixUpperBound`; the database is collated C), over the spellings a person may
  have typed (as typed, upper, lower, spaces dropped — `rawVariants`, at most 12) —
  on plain btrees, across the **whole** table, however old the row.
* **Names and descriptions** (`text`) on a policed table are matched folded, with
  LIKE, **inside the 10,000 newest rows the asker may see** (`CONTAINS_WINDOW`,
  newest by the type's `recent` column, read by index
  `(<date> DESC NULLS LAST)`), so a keystroke costs a bounded amount whatever the
  table's size.
* **Party names** ("invoices of Al Noor") find the party in `business_partner`
  (trigram, no policy), then the documents by foreign key.
* **Files**: the name as stored (partial btree, whole table) plus folded
  contains inside the 10,000 newest current clean files; parents are looked up by
  key (not `key::text`, which defeated the primary key) and the parent check stops
  as soon as the page is full.

Measured after the redesign on the same volume database (`searchAs`, 3 runs per
phrase, a shared and loaded sandbox): super user 90–330 ms; branch-scoped user
110–420 ms, for numbers (`API-BGW-2026-123456`, `AP-123456`, `123456`), references
(`SI-4242`), names (`steel`, `zagros trading co 1234`), files (`invoice`,
`scan-4242`, `sc`) and a phrase that matches nothing. Caveats, stated plainly:
only `ap_invoice` and `attachment` had volume among the policed tables, so a
deployment with several large policed tables pays the window scan for each (about
80 ms for the one measured, a branch-scoped user); the ap_invoice figure
was taken with the table physically ordered by date (as chronologically inserted
rows are) — with the rows in random order the same window scan measured about 450
ms; none of this is a load test.

**The documented limit.** A *name or infix* match on a large policed table sees
the newest 10,000 rows; an older row is still found by its number, its serial, its
reference's beginning, its party's name, or (for partners/items/accounts) any
substring. `gs-global-search` › "reads a reference across the whole table, and a
name only inside the newest rows" inserts 10,010 newer invoices and shows both
sides of this.

## 6. Database changes

`0330_global_search.sql` — nothing changes a row or a policy; dropping any of it
only makes search slower.

* `CREATE EXTENSION IF NOT EXISTS pg_trgm` (already installed by 0212).
* `search_fold(text)` IMMUTABLE PARALLEL SAFE STRICT SQL function; `GRANT EXECUTE` to `erp_app`.
* 9 trigram GIN indexes on the tables without a row policy.
* 12 btrees on references and shipping numbers of policed tables (partial unique
  indexes there cover live rows only), 17 `(<date> DESC NULLS LAST)` btrees for
  the window, 2 partial btrees on `attachment` (name, newest).
* `doc_number_allocation(serial)` — "AP-1024" asks which documents of these series
  carry serial 1024, which the unique `(sequence_key, scope_key, serial)` cannot answer.

`tests/unit/gs-search-indexes.test.ts` reads the migration as text and fails if a
declared `refs` or `recent` column of a policed table has no matching index.

**Note on the two databases of this branch.** 0330 was first committed with
trigram indexes on every column and applied to `erp_search` and `erp_test_search`,
then rewritten (unpushed at the time). The delta was applied to both by hand
(`drop index` of the unused trigram indexes, then the new file, all statements
`IF NOT EXISTS`). No other database ever recorded the first version. The journal
entry did not change.

## 7. Routes and screens

* `GET /search/results?q=` — JSON groups for the palette (no-store; `q` cut at 200).
* `/search?q=&type=&page=` — delivered (`DELIVERED` in `domain/screens.ts`);
  menu item `global_search` already existed under object `dashboard`, with no
  further page gate; each group is shown only if its type passes `mayView`.
  Ten rows per group on the overview, 25 per page for one group (`type=`).
* Palette: Ctrl/Cmd+K, ArrowUp/Down, Enter opens, Escape closes; the last row is
  "See all results"; 180 ms debounce, in-flight requests aborted; fewer than two
  characters search screens only (records need 2, substring matches need 3).

English and Arabic: the `search` namespace (UI strings, `types.<key>`,
`status.<code>`) was appended to both message files and to `CLIENT_NAMESPACES`.
Arabic at 390 px, right to left, no horizontal overflow, is checked by the
Playwright spec; the screenshots are in `/home/claude/shots/search/`.

**Design gaps (existing classes only, per AGENTS.md).** Nothing new was added to
any stylesheet. Two things had no class to take: a compact **group heading** in
the palette (the existing `erp-search__empty` row is reused, `role="presentation"`)
and **row meta** (status chip, date, amount, party) inside a palette row (laid out
with the existing `erp-search__text`/`status` classes). If the sponsor wants a
dedicated heading style it is a stylesheet decision.

## 8. What the next agents need (Task Center, Document Center, anyone)

Registering a record type is **one declaration and one array entry**. Nothing else
in the search changes: the grant, the row policy, the ranking, the number matching
(`TASK-100`), the group heading and "see all" follow from it.

```ts
// src/server/search/entities/tasks.ts
import { sql } from 'drizzle-orm';
import type { SearchTableType } from '../types';

export const task: SearchTableType = {
  kind: 'table',
  key: 'task',                         // translation key search.types.task; group key
  priority: 50,                        // masters 10–29, documents 30–59, logistics 60–79, files 90
  grant: { object: 'task' },           // view grant that lets the asker see tasks at all
  route: '/tasks',                     // list screen; searched only where it is served (visibleRoute)
  table: 'task',                       // aliased `t` in every expression below
  id: sql`t.id`,                       // the key the attachment table names it by (add textId: true for a text code)
  attachmentType: 'task',              // files of tasks open the task (optional)
  series: ['TASK'],                    // doc_sequence keys — "TASK-100", "TA-100", "100" all find serial 100
  number: sql`t.task_no`,              // a plain t.column with a unique/plain btree
  text: [sql`t.title`],                // names matched folded (inside the newest rows on a policed table)
  refs: [],                            // btree-indexed references matched as stored over the whole table
  recent: sql`t.created_at`,           // REQUIRED with text on a policed table; index (created_at DESC NULLS LAST)
  title: sql`t.title`,
  status: sql`t.status`,               // a code; shown through search.status.<code>
  date: sql`t.due_date`,
  party: sql`null::text`,
  // amount: { value, currency, grant? } only where the asker may see money for the object
  href: (row) => `/tasks/${encodeURIComponent(row.number)}`,
};
```

Then add `task` to `BUILT_IN` in `src/server/search/entities/index.ts` (one import,
one array entry). A module that cannot be a single table (the Document Center's
cloud files) declares `kind: 'custom'` with `run(tx, request): Promise<{ rows, more }>`,
where `request.plan.query` is the normalised phrase (`display`, `tokens`,
`numberCandidates`; `rawVariants(query)` and `prefixUpperBound` for index-friendly
comparisons), `request.limit`/`offset` the page, `request.mayAmount` whether money
may be shown, and `request.principal` the asker — the transaction `tx` already
carries their RLS scope. A custom type owns its own access check (as `files.ts`
does with `mayAccessParent`) and must never return a row the asker cannot open.

Checklist for a new type:

1. `doc_sequence` key in `series` (the numbering config is read at query time).
2. **Index it as it is looked up** if its table is under RLS: a btree on `number`
   (plain, not only partial), on each `refs` column, and
   `(recent DESC NULLS LAST)`. `tests/unit/gs-search-indexes.test.ts` enforces this
   for the three declaration modules it imports — add the new module to its list.
   A table with no policy gets a trigram GIN over `search_fold(column)` instead.
3. Messages: `search.types.<key>` and any new `search.status.<code>` in both
   `messages/en.json` and `messages/ar.json`, and the code in `CHIP`
   (`domain/search.ts`) — `gs-search-domain` fails on a type or status with no
   translation in either language.
4. The grant object must be the one the list screen is gated by
   (`gs-global-search` › "every table type is searched under the object its list
   screen is gated by").
5. A type with money declares `amount` and, when the figure has its own grant,
   `amount.grant`. An employee-like record with a private figure declares none.
6. Add one integration case: a person without the grant, and a person outside the
   branch, do not find it (copy the `TASK-100` case in `gs-global-search`, which
   creates a table, registers a type and finds it by number, serial and prefix).

To make a *type* appear without editing `BUILT_IN`, call
`registerSearchType(spec)` at module load — but the search route only knows what
has been imported in its process, which is why `BUILT_IN` is the supported way.

## 9. Shared files touched (all additive)

| File | Change |
|---|---|
| `messages/en.json`, `messages/ar.json` | appended the `search` namespace |
| `src/i18n/client-messages.ts` | `'search'` added to `CLIENT_NAMESPACES` |
| `src/server/domain/screens.ts` | `'/search'` added to `DELIVERED` |
| `tests/unit/screen-catalogue.test.ts` | `'/search'` added to the delivered list |
| `src/server/services/attachments.ts` | new export `mayAccessParent` (the existing parent rule as a question) |
| `src/server/db/migrations/meta/_journal.json` | entry for 0330 |
| `src/components/global-search.tsx` | rewritten in place (same props, same screens behaviour, records added) |
| `AGENTS.md` | one section appended |

`src/components/erp-shell.tsx` and `src/server/domain/menu.ts` are untouched.

## 10. Checks run (all targeted; everything through `/home/claude/bin/heavy`)

| Command | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | clean |
| `npx vitest run --project unit tests/unit/gs-search-domain.test.ts tests/unit/gs-search-indexes.test.ts` | 58 passed |
| `npx vitest run --project unit tests/unit/screen-catalogue.test.ts tests/unit/fx1-menu.test.ts` | 23 passed |
| `npx vitest run --project integration tests/integration/gs-global-search.test.ts` (own database `erp_test_search`) | 39 passed |
| `npx playwright test -c playwright.local.config.ts tests/e2e/global-search.spec.ts --workers=1` | 5 passed |
| volume measurements (scratch scripts, deleted) | section 5 |

Not run: the full unit suite, the full integration suite, `theme-readability`,
a migration run from an empty database (the rewritten 0330 was applied to two
databases that already had the earlier version, every statement `IF NOT EXISTS`).

## 11. Remaining limitations

* The name window above (10,000 newest rows per policed type).
* A page deeper than the file candidates (120–600, scaled by offset) can end early
  when many files are refused by their parents.
* `MAX_OFFSET` 1,000 per group; a phrase is cut at 80 characters and 4 words.
* Statuses reach the chips through a hand-kept map (`CHIP`/`STATUS_CODES`); a new
  status falls back to the neutral chip and a humanised label until it is added.
* The search does not rank by recency or popularity within a tier beyond the
  type's `date`.
* No sales orders / delivery notes until their screens are delivered; no tasks,
  documents or chat until those modules register.
* Not exercised: a deployment where `pg_trgm` cannot be created by the migration
  role (it is a trusted extension and was installed by 0212 here).
* Latency figures are from one sandbox under load, one large policed table, no
  concurrency.

## 12. Commits

`5324222` migration · `27a9a4c` domain, registry, entities, service · `76f0ccd`
presenter, padded serials, integration test · `46b9f43` palette, `/search`,
route, messages · `709ea44` deliver `/search`, Playwright spec, message tests ·
`5b529af` row-policy-aware queries and indexes · this document and the AGENTS.md
section follow.
