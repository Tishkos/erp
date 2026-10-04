/**
 * Inventory Checks — IMPROVEMENT-002: the read-only health of the stock
 * ledger, on one screen. Separate from Item Reconciliation, which is the
 * adjustment document: this shows a difference and where it comes from, and
 * never repairs anything.
 *
 * Built on the checks that already exist — `inventory-integrity.ts` (the
 * nightly job's four questions), the historical valuation against the G/L,
 * the landed-cost locks' own account — plus the structural ones a reader asks
 * of a FIFO ledger: every layer's remaining is its original less what was
 * consumed, no layer below zero, every movement in its warehouse's branch,
 * transfers still on the way, documents that moved stock and posted no
 * journal of their own, and the destination role a landed-cost lock would
 * need and cannot find.
 *
 * States: `healthy`, `warning` (worth a look, nothing wrong with the books),
 * `error` (the books disagree with themselves). A check's history is not
 * kept, so "resolved" is a check that is healthy now and was named in an
 * earlier integrity notification — the nightly job's log holds that.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { businessToday } from '../domain/business-date';
import type { Principal } from '../domain/permissions';
import { PermissionDeniedError, can } from '../domain/permissions';
import * as integrity from './inventory-integrity';
import * as valuation from './inventory-valuation';

export const PERMISSION_OBJECT = 'inventory_movement';

export type CheckState = 'healthy' | 'warning' | 'error';

export const CHECK_CODES = [
  'documents_without_ledger',
  'ledger_without_document',
  'unbalanced_transfers',
  'ledger_layer_mismatch',
  'negative_positions',
  'fifo_layers',
  'warehouse_branch',
  'transfers_in_transit',
  'movements_not_posted',
  'valuation_against_gl',
  'landed_cost_locks',
  'landed_cost_roles',
] as const;
export type CheckCode = (typeof CHECK_CODES)[number];

export interface InventoryCheck {
  readonly code: CheckCode;
  readonly state: CheckState;
  /** The figure the check looked at: a count, a difference. */
  readonly figure: string;
  /** Where the figure comes from — the service or the rule that holds it. */
  readonly source: string;
  /** The rows behind the figure, for the screen (capped). */
  readonly detail: readonly string[];
  /** The screen that shows the same thing in full. */
  readonly route: string;
}

export interface InventoryChecksReport {
  readonly asOf: string;
  readonly checks: readonly InventoryCheck[];
}

const CAP = 50;
const rowsOf = <T>(result: { rows: unknown[] }) => result.rows as T[];

function outcome(code: CheckCode, failing: number, severity: 'warning' | 'error', figure: string, source: string, detail: readonly string[], route: string): InventoryCheck {
  return { code, state: failing > 0 ? severity : 'healthy', figure, source, detail: detail.slice(0, CAP), route };
}

/** Every check, asked now. Reads only. */
export async function run(tx: Tx, principal: Principal): Promise<InventoryChecksReport> {
  if (!can(principal, 'view', PERMISSION_OBJECT)) throw new PermissionDeniedError(principal.userId, 'view', PERMISSION_OBJECT);
  const asOf = businessToday();
  const checks: InventoryCheck[] = [];

  // 1–5. The nightly integrity job's questions, each on its own row.
  const report = await integrity.check(tx);
  checks.push(
    outcome(
      'documents_without_ledger',
      report.documentsWithoutLedger.length,
      'error',
      String(report.documentsWithoutLedger.length),
      'inventory-integrity.documentsWithoutLedger',
      report.documentsWithoutLedger.map((d) => `${d.documentType} ${d.documentNo}`),
      '/inventory/stock-ledger',
    ),
  );
  checks.push(
    outcome(
      'ledger_without_document',
      report.ledgerWithoutDocument.length,
      'error',
      String(report.ledgerWithoutDocument.length),
      'inventory-integrity.ledgerWithoutDocument',
      report.ledgerWithoutDocument.map((m) => `${m.sourceDocumentType} ${m.sourceDocumentId} · ${m.itemCode} @ ${m.warehouseCode} ${m.quantity}`),
      '/inventory/stock-movements',
    ),
  );
  checks.push(
    outcome(
      'unbalanced_transfers',
      report.unbalancedTransfers.length,
      'error',
      String(report.unbalancedTransfers.length),
      'inventory-integrity.unbalancedTransfers',
      report.unbalancedTransfers.map((t) => `${t.documentNo ?? t.sourceDocumentId} · ${t.itemCode}: issued ${t.issued}, received ${t.received}`),
      '/inventory/transfers',
    ),
  );
  const mismatched = report.adriftPositions.filter((p) => p.issue === 'ledger_layer_mismatch');
  const negative = report.adriftPositions.filter((p) => p.issue === 'negative_position');
  checks.push(
    outcome('ledger_layer_mismatch', mismatched.length, 'error', String(mismatched.length), 'inventory-integrity.adriftPositions', mismatched.map((p) => `${p.itemCode} @ ${p.warehouseCode}: ledger − layers = ${p.detail}`), '/inventory/fifo-valuation'),
  );
  checks.push(
    outcome('negative_positions', negative.length, 'warning', String(negative.length), 'inventory-integrity.adriftPositions', negative.map((p) => `${p.itemCode} @ ${p.warehouseCode}: ${p.detail}`), '/inventory/availability'),
  );

  // 6. FIFO: remaining = original − Σ consumption, never below zero, never above the original.
  const fifo = rowsOf<{ id: string; itemCode: string; warehouseCode: string; original: string; remaining: string; consumed: string }>(
    await tx.execute(sql`
      select cl.id, cl.item_code as "itemCode", cl.warehouse_code as "warehouseCode", cl.original_quantity::text as original,
             cl.remaining_quantity::text as remaining, coalesce(sum(c.quantity), 0)::text as consumed
        from cost_layer cl left join cost_layer_consumption c on c.layer_id = cl.id
       group by cl.id
      having cl.remaining_quantity < 0 or cl.remaining_quantity > cl.original_quantity
          or cl.remaining_quantity <> cl.original_quantity - coalesce(sum(c.quantity), 0)
       order by cl.item_code, cl.warehouse_code limit ${CAP + 1}`),
  );
  checks.push(
    outcome('fifo_layers', fifo.length, 'error', fifo.length > CAP ? `${CAP}+` : String(fifo.length), 'cost_layer / cost_layer_consumption (0025)', fifo.map((l) => `${l.itemCode} @ ${l.warehouseCode}: original ${l.original}, consumed ${l.consumed}, remaining ${l.remaining}`), '/inventory/stock-ledger'),
  );

  // 7. Every movement and layer in its warehouse's branch (0215 holds new rows).
  const branches = rowsOf<{ itemCode: string; warehouseCode: string; movementBranch: string; warehouseBranch: string; n: number }>(
    await tx.execute(sql`
      select m.item_code as "itemCode", m.warehouse_code as "warehouseCode", m.branch_code as "movementBranch", w.branch_code as "warehouseBranch", count(*)::int as n
        from inventory_movement m join warehouse w on w.code = m.warehouse_code
       where m.branch_code <> w.branch_code
       group by 1, 2, 3, 4 order by 1, 2 limit ${CAP + 1}`),
  );
  checks.push(
    outcome('warehouse_branch', branches.length, 'error', String(branches.reduce((sum, b) => sum + b.n, 0)), 'inventory_movement.branch_code = warehouse.branch_code (0215)', branches.map((b) => `${b.itemCode} @ ${b.warehouseCode}: ${b.n} in ${b.movementBranch}, warehouse is ${b.warehouseBranch}`), '/inventory/stock-movements'),
  );

  // 8. Transfers still on the way: issued, not wholly received.
  const transit = rowsOf<{ transferNo: string; itemCode: string; outstanding: string; issuedOn: string }>(
    await tx.execute(sql`
      select t.transfer_no as "transferNo", l.item_code as "itemCode", (l.issued_quantity - l.received_quantity)::text as outstanding,
             coalesce(t.issued_on, t.created_at::date)::text as "issuedOn"
        from warehouse_transfer t join warehouse_transfer_line l on l.transfer_id = t.id
       where t.status::text in ('in_transit', 'partially_received', 'investigating') and l.issued_quantity > l.received_quantity
       order by t.transfer_no limit ${CAP + 1}`),
  );
  checks.push(outcome('transfers_in_transit', transit.length, 'warning', String(transit.length), 'warehouse_transfer_line issued − received', transit.map((t) => `${t.transferNo} · ${t.itemCode}: ${t.outstanding} since ${t.issuedOn}`), '/inventory/transfers'));

  // 9. Movements of a posting kind with no journal of their own and no document journal behind them.
  const unposted = rowsOf<{ kind: string; n: number; value: string }>(
    await tx.execute(sql`
      select m.kind::text as kind, count(*)::int as n,
             coalesce(round(sum(case when m.quantity > 0 then (select cl.original_quantity * cl.unit_cost_iqd from cost_layer cl where cl.created_by_movement_id = m.id limit 1)
                                     else (select sum(c.cost_iqd) from cost_layer_consumption c where c.movement_id = m.id) end), 4), 0)::text as value
        from inventory_movement m
       where m.journal_entry_id is null
         and m.kind::text in ('goods_receipt', 'delivery', 'write_off', 'damage', 'count_adjustment', 'opening_stock', 'sales_return', 'goods_return')
         and not exists (
           select 1 from journal_entry e
            where e.source_doc_id = m.source_document_id
               or (m.source_document_type = 'ar_invoice' and e.id = (select journal_entry_id from ar_invoice where id::text = m.source_document_id))
               or (m.source_document_type in ('ap_invoice', 'supplier_shipment') and e.id = (select journal_entry_id from ap_invoice where id::text = m.source_document_id))
               or (m.source_document_type = 'goods_return' and e.id = (select journal_entry_id from goods_return where id::text = m.source_document_id))
               or (m.source_document_type = 'stock_adjustment' and e.id = (select journal_entry_id from stock_adjustment where id::text = m.source_document_id))
               or (m.source_document_type = 'opening_stock' and e.id = (select journal_entry_id from opening_stock where id::text = m.source_document_id)))
       group by m.kind order by m.kind`),
  );
  checks.push(
    outcome('movements_not_posted', unposted.length, 'warning', String(unposted.reduce((sum, u) => sum + u.n, 0)), 'inventory_movement.journal_entry_id', unposted.map((u) => `${u.kind}: ${u.n} (${u.value} IQD)`), '/inventory/stock-movements'),
  );

  // 10. The layers against the inventory accounts, today, exact.
  const against = await valuation.stockAgainstGl(tx, asOf);
  const differs = against.differenceIqd !== '0.0000' && !/^-?0\.0000$/.test(against.differenceIqd);
  checks.push(
    outcome(
      'valuation_against_gl',
      differs ? 1 : 0,
      'warning',
      against.differenceIqd,
      'inventory-valuation.stockAgainstGl',
      [`layers ${against.layersIqd} · accounts ${against.glIqd} · not yet posted ${against.provisionalIqd}`],
      '/inventory/valuation',
    ),
  );

  // 11. Every landed-cost lock whole: into stock + departed + rounding = total (0285 holds it at commit).
  const locks = rowsOf<{ reference: string; total: string; inventory: string; departed: string }>(
    await tx.execute(sql`
      select p.payable_no || '/' || k.sequence as reference, round(k.total_iqd, 4)::text as total,
             coalesce((select round(sum(a.inventory_iqd), 4) from landed_cost_layer_adjustment a where a.lock_id = k.id), 0)::text as inventory,
             coalesce((select round(sum(d.amount_iqd), 4) from landed_cost_departure d where d.lock_id = k.id and d.kind in ('departure', 'rounding')), 0)::text as departed
        from landed_cost_lock k join payable p on p.id = k.payable_id
       where k.total_iqd <> coalesce((select sum(a.inventory_iqd) from landed_cost_layer_adjustment a where a.lock_id = k.id), 0)
                           + coalesce((select sum(d.amount_iqd) from landed_cost_departure d where d.lock_id = k.id and d.kind in ('departure', 'rounding')), 0)
       order by p.payable_no, k.sequence limit ${CAP + 1}`),
  );
  checks.push(outcome('landed_cost_locks', locks.length, 'error', String(locks.length), 'landed_cost_lock_accounted (0285)', locks.map((l) => `${l.reference}: total ${l.total}, into stock ${l.inventory}, departed ${l.departed}`), '/payables'));

  // 12. The destination roles a lock would need: write-offs and damage want inventory_loss mapped.
  const roles = rowsOf<{ role: string; event: string; mapped: boolean; pending: number }>(
    await tx.execute(sql`
      select 'inventory_loss' as role, 'inventory.write_off' as event,
             exists (select 1 from posting_rule r where r.event_type in ('inventory.write_off', 'inventory.damage') and r.line_role = 'inventory_loss' and r.is_active) as mapped,
             (select count(*)::int from inventory_movement m where m.kind::text in ('write_off', 'damage')) as pending
      union all
      select 'inventory_adjustment', 'inventory.stock_adjustment',
             exists (select 1 from posting_rule r where r.event_type = 'inventory.stock_adjustment' and r.line_role = 'inventory_adjustment' and r.is_active),
             (select count(*)::int from inventory_movement m where m.kind::text = 'count_adjustment')`),
  );
  const unmapped = roles.filter((r) => !r.mapped);
  checks.push(
    outcome(
      'landed_cost_roles',
      unmapped.length,
      'warning',
      String(unmapped.length),
      'posting_rule (Posting Mappings)',
      unmapped.map((r) => `${r.role} (${r.event}) is not mapped · ${r.pending} movement(s) of that kind so far`),
      '/finance/posting-mappings',
    ),
  );

  return { asOf, checks };
}
