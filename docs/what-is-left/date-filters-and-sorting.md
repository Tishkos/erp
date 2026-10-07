# Date filters and sorting on every register — what is done and what is left

By direction, 2026-10-07: "filters on table by dates between or by ascending descending by date … just add filter button for it and do that for table … the tables first comes latest ones made for all". The work stopped part-way for a deploy. This note is the handoff.

## The rule

* Every register has a **Filter** button in its toolbar (`ListToolbar`). It opens a window with *Date from*, *Date to* (the shared `Field type="date"`, i.e. the Intent date picker) and *Order*: Newest first / Oldest first.
* **Newest first is the default on every register.** The date is the register's own document date (invoice date, posting date, B/L date, the day an application was sent or raised…). Rows of the same day are ordered by when they were made, or by their number.
* The parameters are `from`, `to` and `sort` (`newest` | `oldest`). The default order is never written into an address.
* A paged register filters and orders **in SQL**. A register read whole filters and orders **on the server, over every row**, before anything is drawn. Never sort a page in the browser.

## The pieces

| File | What it is |
|---|---|
| `src/server/domain/register-dates.ts` | The pure rule: `registerDatesOf(params)`, `registerDatesParams` / `registerDatesQuery` (to carry the dates on the other links and forms), `applyRegisterDates(rows, dateOf, dates, stampOf)` for a register read whole, and `REGISTER_DATE_PARAMS` / `REGISTER_DATE_SLOT` for the saved-view registry. |
| `src/server/services/register-dates-sql.ts` | The same rule in SQL for a paged register: `withinDates(day, dates)` (the WHERE), `datesOrder(day, dates, ...ties)` (the ORDER BY), and `businessDayOf(timestampColumn)` (a moment as its Baghdad business day). |
| `src/components/admin/register-filter.tsx` | `<RegisterFilter dates keep path dateLabel? names? fields? />`, the button and its GET form. `<DatesHidden dates />` carries the dates in the screen's own filter form. |
| `src/components/admin/register-filter-dialog.tsx` | The client shell: a native `<dialog>`, as the Views button's. The button is marked `data-register-filter` and says "Filter (n)" while something is set. |
| Messages | `admin.register_filter.*`; `savedViews.params.sort`, `savedViews.values.sort.{newest,oldest}` (both catalogues). |

## How to do one register

1. **Read.**
   * Paged service (`listForScreen` / `registerPage`): add `readonly dates?: RegisterDates | null` to its filter. Put `withinDates(<date column>, filter.dates)` in the WHERE that both the count and the rows use. Replace the ORDER BY with `...datesOrder(<date column>, filter.dates, <created_at>, <id or number>)`. If the read has other callers whose order matters (Home, WhatsApp), apply the new order only when `filter.dates` is given (see `payables.workbench`).
   * Register read whole: in the page (or in `screen-registers.ts` when Home's pinned count reads it too), use `applyRegisterDates(rows, (r) => r.<date>, dates, (r) => r.<number>)`.
2. **Page.**
   * `const dates = registerDatesOf(params)` and pass it to the read.
   * In `ListToolbar`: `hidden={{ …, ...registerDatesParams(dates) }}`, and as a child `<RegisterFilter dates={dates} keep={{ q: outcome.q, <the screen's other params> }} path="<route>" />` (before `<SavedViewsMenu>` when there is one).
   * In the screen's own GET filter form: `<DatesHidden dates={dates} />`.
   * In the pager's query: `registerDatesQuery(dates)`.
   * A screen whose own form already has a date window (Stock Movements, Stock Receipts / Issues) gets only an *Order* select in that form, labelled with `admin.register_filter.sort*`, and `sort` in its pager links.
3. **Saved views.** If the screen has a `VIEWABLE_ROUTES` entry (`domain/saved-view-routes.ts`), spread `...REGISTER_DATE_PARAMS` into its `params` and add `slots: [REGISTER_DATE_SLOT]`. A screen with its own date names adds only `sort: REGISTER_DATE_PARAMS.sort`. If it has a pinned counter (`services/saved-view-counts.ts`), pass `dates: registerDatesOf(p)`. `tests/unit/sv01-saved-view-routes.test.ts` must pass.
4. **Tests.** An integration test that reads a register's first row may need the new order. `hd15-register-paging` shows how: assert newest first, then oldest first and a window through `dates`. Run `sv01` ×2, `i18n-catalogue`, `hd18` and `hd19`, then the register's own e2e spec (`--workers=1`).

## Done

| Register | Route | How |
|---|---|---|
| Purchase Invoices | `/payables/invoices` | `screen-registers.invoiceRegister` (whole read; Home's pinned count too); saved view `payables.invoices` + range slot |
| Import Applications | `/payables` | `payables.workbench` with `dates` (SQL; Home and WhatsApp keep the triage order) |
| Payment Applications | `/payables/payment-applications` | `payment-applications.listForScreen` (SQL; the date is the day sent, else the day raised). No longer "longest waiting first"; oldest first gives that back |
| Supplier Payments | `/payables/supplier-payments` | whole read, payment date |
| Goods Returns | `/payables/goods-returns` | whole read, return date |
| Shipments (B/Ls) | `/payables/shipments` | `shipments.listBlsForScreen` (SQL, B/L date); saved view `imports.shipments` + range slot |
| Sales Invoices | `/sales/ar-invoices` | whole read, invoice date; saved view `sales.invoices` + range slot |
| Customer Receipts | `/sales/customer-receipts` | whole read, receipt date; saved view `sales.receipts` + range slot |
| Sales Returns | `/sales/sales-returns` | whole read, requested date |
| Journals | `/finance/journals` | whole read, posting date (keeps the fiscal calendar's `month`) |
| Stock Movements | `/inventory/stock-movements` | own date window already; *Order* added to its form, `stock.movements` `sort`; saved view `inventory.stock_movements` gets `sort` |
| Stock Receipts / Stock Issues | `/inventory/stock-receipts`, `/inventory/stock-issues` | own date window already; *Order* added, `stock-flows.forScreen` `sort`; the search now keeps the other filters |
| Transfers | `/inventory/transfers` | whole read, transfer date |
| Item Reconciliation | `/inventory/stock-reconciliation` | whole read, adjustment date |
| Manual Additions | `/inventory/manual-additions` | `manual-stock-addition.listForScreen` (SQL, posting date) |

## Left (by route)

The list was already newest first, unless noted.

* **Logistics / customs:**
  * `/payables/pd`: still **soonest to expire first**. `hd15` asserts that order; change the test with it.
  * `/payables/pd/asycuda`
  * `/payables/containers`: has an ETA window under its own names `eta_from` / `eta_to`; it needs an *Order* in its form, ordered by ETA.
  * `/logistics/shipments`: ordered by the earliest ETA still at sea.
  * `/logistics/shipment-tracking`
  * `/logistics/customs-declarations`
  * `/logistics/landed-costs`
  * `/logistics/cost-allocation`
  * `/logistics/customs-duties`, `/logistics/freight-costs` (`charge-register.tsx`)
  * `/logistics/customs-documents`, `/logistics/shipment-documents` (`document-register.tsx`)
  * `/logistics/in-transit`
  * `/logistics/ports`: a master list. Is a date order wanted?
* **Payables:** `/payables/purchase-orders`, `/payables/goods-receipts`, `/payables/service-receipts`, `/payables/advances`, `/payables/contracts`, `/payables/credit-memos`, `/payables/supplier-credits`.
* **Receivables:** `/sales/credit-notes`, `/sales/customer-credits`.
* **Treasury:** `/treasury/transfers`, `/treasury/deposits`, `/treasury/loans`, `/treasury/bank-reconciliation`, `/treasury/payments-receipts` (has its own from/to; it needs only an *Order*).
* **HR:** `/hr/advances`, `/hr/leave`, `/hr/requests`, `/hr/documents`, `/hr/performance`, `/hr/recruitment`, `/hr/payroll`, `/hr/employees` (a master list, hire date?).
* **Inventory:** `/inventory/stock-count`, `/inventory/opening-stock`.
* **Projects:** `/projects`, `/projects/budgets`, `/projects/change-orders`, `/projects/material-issues`, `/projects/costs`, `/projects/procurement`, `/projects/billing`.
* **Platform:** `/tasks`, `/exceptions`, `/notifications`, `/approvals`, `/administration/automation` (runs).
* **Not registers of documents (leave as they are unless asked):** Availability, Stock Ledger (a running balance reads oldest first), the reports, master-data lists.

## Known issues

* `/payables/payment-applications` changed order: newest first, where it used to be longest waiting first (`hd15-register-paging` was updated to match). The register's subtitle no longer claims an order.
* The search box of `/payables`, `/payables/payment-applications` and the stock receipt/issue registers now keeps the screen's other filters. Before, a search dropped them.
* A whole-read register orders on the server over every row it reads. Moving those reads into SQL paging is a separate job (HD15).
* No e2e covers the Filter window yet. Suggested: open `/payables/invoices`, press Filter, set a window and Oldest first, apply, and check the first row and that `from` / `to` / `sort` are in the address.
