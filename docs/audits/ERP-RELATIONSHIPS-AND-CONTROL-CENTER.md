# ERP Relationships and Control Center — implementation record

Platform phase, Wave 4, Builder Agent 9. Branch `platform/control-center`, one migration
(`0390_control_center_grants`, journal idx 235, `when` 1795900000200). Controls C-82 to C-85.
The Exception Center's controls were renumbered to C-78 to C-81 (RULES-PLATFORM §11).

This is a record of what was built and checked, not a statement that the system is ready for production.
Nothing here was run against the live database, and the machine the checks ran on is a small sandbox.

## 1. Architecture

Two features that share one idea: **a screen that only reads, as the person reading it.**

```
domain/control-center.ts      the catalogue (31 CHECKS, 6 domains), states, readings, arithmetic, job rules   (pure)
domain/relationships.ts       the steps of the four chains, visibility, "not yet", caps                      (pure)
services/control-center.ts    run(): one check at a time, as the viewer, read-only, savepoint + timeout each
services/control-center-readers.ts   READERS[checkCode]: each calls the service that already owns the question
services/relationships.ts     graphFor(): the chain around an import / supplier / customer / item
components/admin/related-records.tsx  the stacked "Related records" section (window and panel variants)
app/(app)/control-center/page.tsx            the report screen
app/(app)/control-center/relationships/page.tsx   the chain on a page of its own
```

* **Control Center.** `run(tx, {principal, branchCode, domain?, only?, host?})` makes the transaction read-only
  (`set local transaction_read_only = on`), then asks each check in `CHECKS` in turn. A check runs only if the
  viewer holds `view` on every screen it summarises (`requires`); otherwise it is `not_checked` and says which
  screen. Each check runs in its own savepoint under `statement_timeout` (`CHECK_TIMEOUT_MS` = 10 s); the run has a
  budget (`RUN_BUDGET_MS` = 90 s) after which the checks not reached are `unavailable`. A check that errors is
  `unavailable` with the reason (`reasonFromError`: timeout, budget, error, no_host_data, not_configured). Nothing
  is stored: the answer is computed on every request. There is no score or percentage; the headline is the count of
  checks in each state per domain, and the summary adds up to the registers beneath it.
* **Related records.** `graphFor(tx, {principal, branchCode}, kind, key)` returns the root and the steps of its
  chain. A step is drawn only if the viewer holds its `requires` (STAGE_SOURCES of the Home import journey where the
  step is one of its stages); each node is a row read through the service or table that owns it, passed through
  `attachments.mayAccessParent` for its module's record rule; a link is given only if the viewer holds the target
  screen. A step's state is `present`, `pending` ("Not yet") or `unavailable`; `pending` is derived from the data
  (`stateOf`): the step before it has records and this one has none. Steps beyond the first pending one are
  omitted, and a cancelled import goes on to nothing.

## 2. What was implemented

**Control Center — 31 checks.**

| Domain | Checks |
|---|---|
| Accounting (7) | trial balance · journal integrity · bank reconciliation · bank/cash accounts → ledger account · posting roles mapped · exchange-difference roles mapped · posting failures |
| Inventory (5) | stock at FIFO cost against the inventory accounts · negative stock · FIFO layers against movements · documents against the stock ledger · stock in transit |
| Receivables (2) | control account against the customer sub-ledger · statements against ageing |
| Payables (3) | control account against the supplier sub-ledger · statements against ageing · supplier credits against their applications |
| Logistics (4) | imports in transit (shipped/received over ordered, short in transit) · landed costs waiting · customs (PD/declaration) · shipment delays |
| System (10) | scheduled jobs · outbox queues · notification deliveries · WhatsApp bridge · cloud files · system health (migrations, backups, disk) · users without a role · unknown permission objects · super users · users and employees |

Each result carries the figures compared (money as scaled bigints, formatted by locale), the first eight items that
need attention (`ITEM_CAP`; the rest are counted: "N more"), and the road to the record or screen. The Exception
Center's open count per domain is shown beside each domain with a link to `/exceptions?domain=`.

**Related records — four chains** (`STEPS`):

| Chain (root) | Steps |
|---|---|
| Import (`payable_no`) | purchase invoices · B/L · containers · customs PDs · declarations · landed cost (locks) · receipts · stock position · FIFO layers |
| Supplier (partner code) | purchase orders · goods receipts · purchase invoices · payments · statement · ageing |
| Customer (partner code) | sales invoices · receipts · credit notes · returns · statement · ageing |
| Item (item code) | warehouses · layers · movements · source documents |

A "Shipment" is not drawn as a separate row: the platform has no shipment table; the B/L is the shipment header and
the containers are its lines (decided by default, section 11).

**Screens.** `/control-center` (report: filter form of Selects, Summary register, one stacked register per domain,
all existing classes) and `/control-center/relationships?type=import|supplier|customer|item&id=…`. The stacked
section is on the import page (`/payables/[payableNo]`), the supplier/customer profile
(`/master-data/business-partners/[code]`) and the item page (`/master-data/items/[code]`).

## 3. Data source

Every figure is read from the service or view that owns the question; the Control Center has no query of its own
where a service exists (`readers` name them): `trial-balance`, `journals`/`gl_integrity_issue`, `bank-reconciliation`,
`bank-cash-accounts` (via `system-health.unlinkedBankAccounts`), `posting-map` and the posting-failure register,
`inventory-checks`, `fifo-valuation`, `stock-position`, `receivables`/`payables` reconciliation and `open-items`
(statement and ageing), `supplier-credit-memos`, `shipments`/`logistics-views`, `customs`, `landed-cost`,
`jobs` + the crontab (host files), `outbox`, `system-health` (`stuckDeliveries`, backups, disk, migrations),
`authorization` (role grants). Detectors of the Exception Center are re-used through `runDetector`, which applies
the Exception Center's own visibility contract.

## 4. Permissions

* New permission object **`control_center`**, `view`, granted by 0390 to `ceo`, `accounting_manager`,
  `system_administrator` (a super user holds every verb). Everyone else gets the standard Denied page; the menu item
  is hidden (`visibleRoute` + menu grants).
* Each check re-asks the grants of the screens it summarises, so a CEO who lacks `posting_rule` is told "Not checked
  for you: it reads Posting Mappings" rather than shown a green tick or a zero.
* Branches are held by row-level security (the viewer's scope). Two owner-owned views, `gl_integrity_issue` and
  `stock_position`, do **not** follow RLS (`erp_owner` is a super user): the readers keep only the journals the
  viewer can read under RLS and apply `app_branch_allowed` in the stock queries. Detector findings are dropped when
  their branch is not the viewer's or `mayAccessParent` refuses the record.
* The chain page `/control-center/relationships` is open to whoever may open the root record (the import's
  `payable`, a partner, an item), not to the Control Center's audience; a record the viewer may not open is "not
  found", like one that does not exist. A node's `from` that names a record is kept only if the same chain shows that
  record (`settleReferences`).
* Nothing writes. The only form on `/control-center` is the filter; "Run checks now" is the page asked again.

## 5. Database changes

`0390_control_center_grants.sql`: three `role_grant` rows (`control_center`/`view` for the roles above) and a bump of
every user's `permissions_version` so open sessions pick the grant up. No table, column, trigger or view. Journal idx
235, `when` 1795900000200. No new table means no entry in `resetTestData` or `format-live-database.sh`.

## 6. Routes

| Route | Who | Notes |
|---|---|---|
| `/control-center` | `view` on `control_center` | `?domain=`, `?state=`; registered in `menu.ts` (Home), `screens.ts` (report), the screen catalogue |
| `/control-center/relationships` | `view` on the root's object | `?type=&id=`; not a menu item (a drill-down) |
| import / partner / item pages | as before | gain the stacked "Related records" section |

## 7. Shared files touched (all additive)

`src/server/domain/menu.ts` (one `page(...)` in Home) · `src/server/domain/screens.ts` (one kind, one route) ·
`tests/unit/screen-catalogue.test.ts` (counts 251→252, 367→368) · `messages/en.json`, `messages/ar.json`
(`page.control_center`, `admin.control_center.*`, `admin.relationships.*`) ·
`src/app/(app)/payables/[payableNo]/page.tsx`, `src/app/(app)/master-data/business-partners/[code]/page.tsx`,
`src/app/(app)/master-data/items/[code]/page.tsx` (one stacked section each) ·
`src/server/services/system-health.ts` (two helpers extracted so `check` and the Control Center cannot disagree:
`stuckDeliveries`, `unlinkedBankAccounts`; behaviour of `check` unchanged) ·
`src/server/services/exception-detectors/accounting.ts` (`FX_ROLE` exported) ·
`tests/e2e/payables.spec.ts`, `tests/e2e/logistics.spec.ts`, `tests/e2e/im2-bl.spec.ts`,
`tests/e2e/theme-readability.spec.ts` (ten locators `getByRole('link', { name: <B/L | PD | container> })` gained
`.first()`: the import page now shows each of those records twice, in its register and in Related records, and a
strict locator saw two) ·
`src/server/db/migrations/meta/_journal.json` (idx 235) · `docs/CONTROLS.md` (Exception Center rows renumbered
C-78..C-81; C-82..C-85 added) · `docs/audits/EXCEPTION-CENTER-IMPLEMENTATION.md` (three references to the old control
numbers) · `AGENTS.md` (one new section; the Exception Center section's control numbers).

## 8. Targeted checks run

All on this branch, own databases `erp_control` / `erp_test_control`, through `heavy`.

| Check | Result |
|---|---|
| `tests/unit/cc01-control-center.test.ts` + `cc01-relationships.test.ts` | 33 + 19 passing |
| Unit batch: cc01 ×2, screen-catalogue, fx1-menu, delivered-screens, hd18, hd19, i18n-catalogue, sv01 ×2, im15-controls-register, ex01-exceptions, dash-messages | 13 files, 189 passing |
| `tests/integration/cc01-control-center.test.ts` | 31 passing (real import world; healthy world all `ok`; injected unbalanced journal, unmapped role, stuck delivery, stale job, stock without journal, negative stock each flip exactly the right check with exact evidence and an openable path; permission matrix officer / manager / CEO / outsider / admin / partial grants / Erbil branch user; timeouts and budget become `unavailable`; the run changes nothing — table digests equal) |
| `tests/integration/cc01-relationships.test.ts` | 24 passing (the import B/L → containers → PD → declaration → landed cost → receipts → stock → FIFO layers, node by node; "not yet" for a draft and a B/L-only import; cancelled import; supplier / customer / item chains with the Control Center's statement and ageing figures equal; a step absent per missing grant; Erbil user finds nothing; a failing step is `unavailable`, others intact; no writes) |
| `tests/e2e/control-center.spec.ts` (`playwright.local.config.ts`, chromium, seeded `erp_control`, port 3009) | 7 passing |
| `tsc --noEmit` | clean |
| `tests/e2e/theme-readability.spec.ts --workers=1` | 14 passing (it failed first, on the duplicate-link locator above) |
| The specs whose locators changed: `payables.spec.ts` · `logistics.spec.ts` · `im2-bl.spec.ts` | 9 · 5 · 3 passing |

Screenshots (`/home/claude/shots/control/`): `control-center-desktop-en`, `control-center-mobile-ar`,
`import-related-desktop-en`, `import-related-mobile-ar`, `relationships-import-desktop-en`,
`relationships-import-mobile-ar`, beside the models they copy `model-invoices-{desktop-en,mobile-ar}`,
`model-invoice-record-{desktop-en,mobile-ar}`.

## 9. Commits

`2dd4a7f` grants, catalogue, readers, runner · `6fd512f` pages, graph, menu, messages · `f4e4920` unit tests ·
`267452a` integration suite on a real import; checks follow the viewer's branches · `4b39d4b` relationships suite;
a node names only records the graph shows · `c0657eb` Playwright spec, controls, AGENTS.md; evidence drawn one
figure per line · plus the commit of this record.

## 10. Remaining limitations

* **Mobile.** At 390 px the registers behave as every `sapTable` does (they scroll inside their window): the first
  column is the check, its state and evidence are a swipe away, as the status column is in the Purchase Invoices
  register. No new CSS was added to change this.
* **Defects found in other agents' code (not changed here, except where listed in section 7):**
  * Exception Center `inventory.gl_difference` subtracts provisional value and reports a false difference on a clean
    import; the Control Center's `inventory.stock_vs_gl` compares layers to the ledger the way the closing checks and
    Inventory Checks do (`difference != 0`) and shows the provisional part for the eye only.
  * Exception Center `accounting.gl_integrity` finding carries `branchCode: null`, so it is company-wide in that
    centre; the Control Center filters the same issues by what the viewer can read.
  * The event `inventory.goods_receipt` is not on `POSTING_MAP`, so Posting Mappings cannot map it; the integration
    world inserts its rules by hand.
  * `users.listAll` lists only users who have a credential `auth_account`; users without one are invisible to
    `platform.users_without_role`.
  * `platform.system_health` messages are English only (they come from `services/system-health`).
* **This machine.** The sandbox disk is nearly full, so `platform.system_health` truthfully reports `disk_low`, and no
  nightly backup exists, so `backup_missing`. The integration suite tolerates both. The scheduled-jobs and backup
  checks answer for the host they run on, and are `unavailable` where the host files do not exist.
* **The seeded dev CEO** lacks `posting_rule`, `bank_reconciliation` and `supplier_credit_memo` views, so four of its
  checks read "Not checked for you". That is the contract, not a defect; whether the CEO should hold those views is
  the owner's decision.
* **Caps.** A chain shows at most six nodes per step (`NODE_CAP`) and reads at most 24 (`FETCH_LIMIT`); the rest are
  counted ("N more") or, past the read limit, "more than shown".
* **Not exercised:** a production-sized database (checks are bounded by the statement timeout, not tuned against
  volume), the live host's cron and backup files, and a real Nextcloud / WhatsApp connection (those checks read
  settings only).

## 11. Decided by default (owner to confirm)

1. The audience is the CEO, the accounting manager and the system administrator.
2. The Control Center follows the **viewer's** grants, so different people see different checks as "not checked".
3. No "Shipment" node: the B/L is the shipment header.
4. A chain page is open to whoever may open the root record, not only to the Control Center's audience.
5. A step that the process has not reached is omitted; "Not yet" is drawn only for the next step after the last
   one that has records.
6. Control numbers C-82 to C-85; Exception Center renumbered C-78 to C-81.

## 12. What the next agents need

* A new check: `CHECKS` entry + `READERS` entry + `admin.control_center.check.<code>.title/.what` (and its figure,
  item and reason keys) in both locales + a scenario in `cc01-control-center.test.ts` that flips it. The unit test
  holds catalogue, readers and messages equal.
* A new chain step: `STEPS` + a reader in `services/relationships.ts` + `admin.relationships.step.<chain>_<step>`
  + cases in `cc01-relationships.test.ts`. Name another record in `from` only with `fromRecord: true`.
* Never read `gl_integrity_issue` or `stock_position` unfiltered in a screen for non-super users.
* The shared test world is `tests/integration/cc01-world.ts` (`buildChainWorld`, `person`, `as`, `maintenance`,
  `expectOpenable`): reuse it; use your own `DATABASE_URL_TEST`.
* Workflow Automation (C-86 to C-89) may link a rule's subject to `/control-center/relationships` through
  `relationshipsHref(kind, key)`.
