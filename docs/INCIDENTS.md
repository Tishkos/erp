# Incident register

One entry per incident: what was seen, what was actually wrong, what was
changed so it cannot recur, and what was decided along the way. Written when
the fix lands, by the person who made it, so the next reader does not relearn
it. A data anomaly gets an entry even when the code was never at fault — the
question "why does this row exist?" is the entry.

---

## 2026-09-27 · Transfers missing from the Stock Movement ledger; "Baghdad shows 250,350"

### Reported

1. The Transfer page listed `TRF-HQ-2026-000001` (100), `-000002` (50) and
   `-000003` (10) out of WH-HQ. The Stock Movement page showed only the 10.
2. "I made an AP Invoice to Baghdad for 500, then another for 250,000, then a
   sale of 300. Baghdad shows 250,350; it should be 250,200."

### What was actually wrong

**Report 1 — real, and not the application.** `transfer()` writes the OUT and
the IN in the same transaction as the document; `TRF-000003` proves the path.
The server's own pre-format dumps hold the missing rows: at 02:57 UTC the
ledger carried −100/+100 for TRF-000001, at 03:36 UTC −50/+50 for TRF-000002.
`scripts/ops/format-live-database.sh` was run five times that morning
(02:57, 03:36, 03:39, 04:02, 04:05). It deletes `inventory_movement`,
`cost_layer`, the journals, the invoices and the audit trail — with foreign
keys and triggers disabled — but its table list predated Operations block 7
and never learned `stock_transfer` or `stock_adjustment` (migration 0207). So
three documents outlived everything behind them: the two transfers and
`ADJ-HQ-2026-000001`, whose `journal_entry_id` named a journal that was gone.

The numbering collision this caused was patched the same morning ("skip stock
transfer numbers already in use") without asking why a number was already
taken. That patch hid the orphan for several hours.

**Report 2 — not a fault.** `API-000002` was 10 units at 50 IQD (500 IQD),
`API-000003` 500 units at 500 IQD (250,000 IQD), `INV-000002` 3 units at
100 IQD (300 IQD). On hand: 10 + 500 − 3 = **507 units**, which the ERP held.
250,350 is the Warehouses Report's *Total Price*: 7 × 50 + 500 × 500 = stock at
FIFO cost, in dinars. The 250,200 added invoice totals as if they were units
and subtracted a selling price from a column of costs.

### Also found on the way

* Reversing a receipt left its FIFO layer behind, so the Warehouses Report
  (then summing layers) could show stock the ledger said was gone.
* `positionOf` read the first row of a view grouped by branch, so a warehouse
  whose movements carried two branch codes was read partially.
* A concurrent double-post of a Purchase Invoice would receive the goods twice
  (the posting engine is idempotent by source and returned the first journal
  silently). AR had a row lock; AP, returns, opening stock and shipment stages
  did not.
* Two independent quantity implementations: the Warehouses Report summed
  `cost_layer.remaining_quantity`; everything else summed `inventory_movement`.
* `CASH-ACCOUNTANT_ERBIL` references a `chart_of_account` row that no longer
  exists — the same format, the same morning: the script deleted `E2E`-named
  accounts without the bank accounts that pointed at them. Found by the first
  restore drill, because `pg_restore` cannot recreate that foreign key.

### Repair

Production, with the owner's approval, after a backup
(`erp-before-orphan-removal-20260927-165535.dump`): the three orphan documents
were removed — not re-created — and an `audit_event` written for each with
the full row as `before_value`. Re-creating the movements was refused on
principle: WH-HQ held 80 units; an OUT of 150 would drive it negative and an IN
of 150 in WH-PORT would be stock nobody bought.

The Erbil cash account is left for the screen that now shows it
(commit `bbe05f1`): choose a G/L account for it, and the next drill passes.

### Changed so it cannot recur

| | |
|---|---|
| One truth for quantity | Warehouses Report quantity now comes from `inventory_movement`; value from the layers. `positionOf` sums all rows of a warehouse. |
| Ledger ↔ documents | `services/inventory-integrity.ts`: documents without rows, rows without documents, transfers out of balance, layers adrift, negative positions. Run nightly by cron (02:15), findings notified to accounting managers in-app; shown live as a banner on every stock screen; printed by `stock-movement-trace.ts`. |
| The format script | Lists `stock_transfer`, `stock_adjustment` and every document table; reports documents without ledger rows before and after; **refuses to run while `/opt/qs-erp-next/var/LIVE` exists** — placed 2026-09-27. Trials belong on a separate database. |
| The two table lists | `tests/integration/ops16-document-table-lists.test.ts` derives the document tables from the schema's foreign keys and fails if either the format script or `resetTestData` omits one. |
| Branch of a movement | Derived from the warehouse and refused on mismatch, in the service and by trigger (migration 0215). |
| Posting once | Row locks before the status check on AP post, goods-return post, sales-return accept, opening-stock approve, shipment advance. Transfer and Reconciliation take a one-time form id, so a double press finds the first document. |
| Receipt reversal | Consumes the layer it created; refused when stock has since left it. |
| Correcting a posted invoice | AP and AR invoices can be **reversed** with a reason: journal mirrored and linked, stock put back on its own FIFO layers, status `reversed`. Refused while a payment, return, credit memo or payment run rests on it. Decided 2026-09-27 (owner): reversal document, not returns-only. |
| Units and money | Column headers carry `(IQD)`; the Warehouses Report shows the unit and the average unit cost beside the total, on screen and in exports. |
| The Stock Ledger | `/inventory/stock-ledger`: one item, per warehouse, opening → every movement with a running balance → closing; every row opens its document. Stock Movement pages at 200 rows and says "x–y of N"; filters by document number. |
| Deploys | `deploy.sh` runs the integration suite; skipping needs a stated reason, recorded in `var/deploy-skips.log`. |
| Backups | Weekly restore drill (Sunday 03:00) restores the newest dump into a throwaway database and checks it — `scripts/ops/restore-drill.sh`, `/var/log/qs-erp/restore-drill.log`. |
| The stale test | The opening-stock test asserted the §14.4 maker-checker rule a day after the owner lifted it; updated with the rule. |

### Decisions taken (owner, 2026-09-27)

* No staging environment yet. The live database is live; the format script is
  disabled by the `LIVE` marker rather than by a second server.
* A posted invoice is corrected by a **reversal document**, refused once anything
  has been built on it.
* Server access unchanged; the credentials note moved out of the project folder
  to `~/.config/qs-erp/vps.md`.
* Currency and unit labels across inventory, purchasing and sales; not the whole
  application.
* `docs/` cleared of the earlier registers; this file and the runbook are the
  two that remain.
