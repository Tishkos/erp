# Inventory finish — implementation notes (2026-10-04)

Branch `feat/inventory-finish` (from `feat/platform-layer`). Owner's rule held throughout:
*Final Cost + FIFO + exact Inventory/GL reconciliation must be trustworthy before Inventory
is considered complete.* Nothing here is a second stock, FIFO, valuation or COGS engine, and
nothing here claims the system is ready for production.

## Architecture

* `inventory_movement` stays the only source of stock quantity; `cost_layer` and
  `cost_layer_consumption` carry value. The two new record pages and their print models are
  **readers** of those tables: `services/stock-operations.ts` gained `transferView` and
  `adjustmentView` (and the private `positionsOf`, `layersOfDocument`). They write nothing.
* A document's *layers* are the FIFO layers it worked on: for stock that went out, each
  `cost_layer_consumption` row its issue movement wrote (date, batch, quantity, the cost the
  layer carried); for stock that came in, the layer its receipt created.
* A document's *positions* are the Stock Ledger's own running balance: `after` is the sum of
  the item's movements in the warehouse up to the document's last row in the ledger's order
  `(movement_date, created_at, id)`, `moved` is the document's net change, and
  `before = after − moved` in scaled bigints, so the three always add up. A later document,
  even on the same day, never changes an earlier one's figures.
* The landed-cost engine was not redesigned. One defect in the Final Cost reconciliation of a
  pre-0280 lock was found and fixed (see *Implemented*, item 3).

## Implemented

1. **Record pages** `/inventory/transfers/[transferNo]` and `/inventory/stock-reconciliation/[reconNo]`,
   copying the Opening Stock / Stock Count record (AdminPage → DocumentWindow with header fields,
   status chip, the layers as its lines; the before/after positions — and for a reconciliation the
   journal — stacked under it as `sapDoc/sapWindow/sapTitle` sections). Title-bar doors in the
   standing order: Printer (`ExportIcon`, keys `transfer` / `item_reconciliation`), Paperclip
   (`RecordAttachmentsDoor`), Notes (`RecordNotesDoor`), Clock (`HistoryButton` + `RecordHistory`).
   Item, both warehouses, branch and the journal are `ProfileLink`s. The list numbers open the
   records (`document-link.ts`, `profiles.ts` kinds `stock_transfer` / `stock_reconciliation`,
   `stock-flows.hrefOf`). The forms and their one-time `document_id` are untouched.
   Status: a transfer is `Recorded` (green) when the Stock Movement ledger holds what it says it
   moved, else `No ledger entry` (red); a reconciliation shows its journal's status.
   Costs on these two pages are the ledger's exact figures (12.5 a unit, 37.5 for three), four
   places kept, trailing zeros dropped — not whole dinars — so the layers add up where a reader can check.
2. **Print models** (`print/inventory-documents.ts`; the older one-row builders in `print/documents.ts`
   were removed): header facts, the layers table (batch, layer date, quantity, unit cost to 4 places,
   value, totals by `sumQuantity` / `sumMoney`), the positions table (before / change / after), and for a
   reconciliation the posting table with the journal number — the posting table only for a reader who may
   `view` `journal_entry`.
3. **`lc03-final-cost`: the four `it.todo` cases are real tests** (a project Material Issue with its number
   and no project/WBS anywhere in the trace or the printed copy; goods return + write-off + Item
   Reconciliation grouped by movement kind and destination role with their numbers; a rounding residue as
   its own group counted in the lock's reconciliation; a pre-0280 lock). **Defect found by the last one and
   fixed:** for a lock written before 0280 (cost of sales on the lock, no `landed_cost_departure` rows) the
   trace said `balanced: false`, `differenceIqd` = that cost of sales, although the lock's own record
   (`inventory_iqd + cogs_iqd = total_iqd`) is whole. `domain/final-cost.reconcileLock` now counts the lock's
   `unattributedIqd`; the trace still shows it, the printed copy adds it to the lock's *Departed* column and
   says why no row lists it (`admin.landed_cost.unattributed_departures`, EN + AR). The test fails without the
   fix (`accountedIqd 5000`, `differenceIqd 5000`). The model already counted such a share as departed; it
   still does, with the same figures as before the rows were removed.
4. **Exact sums**: the Warehouses Report (`inventory/fifo-valuation`) and the warehouse profile sum value
   with `sumMoney` (each value rounded half up to 4 places, summed in bigint — the print copy's own function)
   and show quantities through `parseQuantity`; the stock-count variance count compares `parseQuantity(…) !== 0n`
   (also in `print/inventory-documents.ts`). The one `Number(row.totalIqd).toLocaleString('en-US')` left on the
   Opening Stock list is a single value formatted for display, not a sum.

## Data source

`stock_transfer`, `stock_adjustment`, `inventory_movement`, `cost_layer`, `cost_layer_consumption`,
`journal_entry` / `journal_line`, `warehouse`, `item`. Audit and notes through the existing `audit_event` /
record-notes (objects `warehouse_transfer` and `stock_reconciliation`, the ones the writers already audit).

## Permissions

* Pages: `view` on `warehouse_transfer` / `stock_reconciliation` (`stock.TRANSFER_OBJECT` /
  `RECONCILIATION_OBJECT`), branch scope by the tables' row-level security as for the lists.
* Attachments: `create` on the object to add (the door is shown to anyone who may view);
  parent-access checks were already registered in `attachments-runtime.ts` (`warehouse_transfer`,
  `stock_reconciliation`) — nothing to add. Notes: targets already in `record-notes.ts`.
* Print: `EXPORT_ACCESS` entries for `transfer` and `item_reconciliation` already existed and are unchanged;
  the reconciliation's journal section additionally needs `view` on `journal_entry`.

## Database changes

None. Migrations 0303–0304 and journal times …113–114 were not used.

## Routes

New: `/inventory/transfers/[transferNo]`, `/inventory/stock-reconciliation/[reconNo]`
(both under `visibleRoute` of their list). Export keys unchanged (`transfer`, `item_reconciliation`).
No menu changes.

## Shared files touched (additive unless noted)

`messages/en.json`, `messages/ar.json` (new keys under `admin.transfers`, `admin.reconciliation`,
`admin.landed_cost.unattributed_departures`); `src/server/print/registry.ts` (two entries re-pointed to
`inventory-documents`); `src/server/print/documents.ts` (**removed** the two old one-row builders `transfer`
and `itemReconciliation` and the now-unused `stock` import — a deletion, at a place other agents may append
to); `src/server/domain/profiles.ts` (two kinds); `src/components/admin/document-link.ts` (two cases);
`src/server/services/stock-flows.ts` (`hrefOf`); `docs/notes/doors-coverage.md` (two rows); `AGENTS.md`
(one bullet in the existing Inventory landed-cost section); `tests/e2e/inventory-screens.spec.ts`
(see *Remaining limitations*). Inventory-owned: `stock-operations.ts`, `inventory-documents.ts`,
`landed-cost-documents.ts`, `final-cost.ts` (service + domain), the pages.
`docs/CONTROLS.md` untouched: no trigger or constraint was added.

## Targeted checks run (all on `erp_invfinish` / `erp_test_invfinish`, through `heavy`)

* Typecheck clean.
* Integration gate: `lc01-landed-cost-routing` 24, `lc02-goods-return-landed` 7, `lc03-final-cost` 9
  (was 5 + 4 todo), `ap07-landed-cost` 5, `ops15-inventory-ledger` 41, `ops16-document-table-lists` 3 — all green.
  Also `ops14-print-export` 25 and the new `inventory-finish-records` 4.
* Unit: `lc-final-cost` 14 (one new case), `profiles`, `hd18-no-raw-enum`, `hd19-client-messages`,
  `i18n-catalogue`, `screen-catalogue` — 46 in all, green.
* E2E: `inventory-record-pages.spec.ts` 3 passed; `inventory-screens.spec.ts` 8 passed, 1 skipped (Opening Stock:
  the dev seed has no opening-stock document, the spec skips itself).
* Screenshots in `/home/claude/shots/inventory-finish/`: `transfer-record`, `reconciliation-record`, each beside
  `model-stock-count-record`, `-desktop-en.png` and `-mobile-ar.png` (no horizontal scroll at 390 px).

## Commits

`529fa73` exact sums · `50285a0` record pages and print models · `6eda375` lc03 tests + pre-0280 fix ·
`306a68b` exact costs, codes in positions · `d34c010` e2e, doors rows, AGENTS note ·
`ac5b3c0` integration test of the views and prints. (Final docs commit follows.)

## Remaining limitations

* A write-off (stock-state movement) names no numbered document: its departure row is shown by movement kind
  and destination role, with no document number. Giving it one is a stock-states change, not done here.
* `theme-readability.spec.ts` (90 palette/accent combinations) was not run; the two pages use only existing
  classes and tokens and no palette code changed.
* At 390 px the positions and posting tables scroll horizontally inside their wrap, as the model's lines table
  does; the page itself does not.
* `Number()` remains in shared admin components of other modules (`account-statement`, `journal-lines-grid`,
  `invoice-lines-grid`, …) and in `formatMoney` / `formatQuantity` themselves (the last step before `Intl`);
  not Inventory's, not touched.
* The Transfer / Reconciliation create actions still return to the list (as before), not to the new record.
* `inventory-screens.spec.ts` had two latent defects exposed by running after the new spec: the availability
  row was picked by item only (another store may hold it) and the value expectation ignored half-dinar rounding
  for an odd quantity at 12.5; both fixed, plus `SHOTS_DIR` to keep screenshots out of the shared directory.
* Dev-server runs cannot fetch Google Fonts (warnings only; fallback font in the screenshots).

## What next agents need

* To link to a transfer or a reconciliation from another page use `ProfileLink` / `profileHref` with kind
  `stock_transfer` / `stock_reconciliation`, or `documentHref` for a movement's `source_document_type`.
* A new stock-moving document that wants a record page: `layersOfDocument` + `positionsOf` in
  `stock-operations.ts` are generic over `(source_document_type, source_document_id)`.
* A lock's reconciliation is `domain/final-cost.reconcileLock`; keep `unattributedIqd` in step with
  `figuresOf`'s `legacy` rule (cost of sales on the lock, no departure rows).
* E2E data: the new spec creates a warehouse, a transfer and a reconciliation in the dev database and names
  ITM-SEED's inventory account if it is empty; run it against an isolated database only.
