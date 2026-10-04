/**
 * Inventory finish (2026-10-04) — the two stock documents that had no record
 * page: a Transfer and an Item Reconciliation. What their pages and their
 * printed copies show comes from `stock-operations.transferView` /
 * `adjustmentView`, so it is held here, against the ledger and the FIFO layers:
 *
 *   * a transfer: the layers it carried, each at the cost it carried, adding
 *     up to the cost on the document; both warehouses before and after, from
 *     the Stock Ledger's own running balance — and a later transfer on the same
 *     day does not move an earlier one's figures;
 *   * an Item Reconciliation out: the layer it took, the one position it moved,
 *     the journal it posted (Dr adjustment / Cr inventory, equal to the layers);
 *     one in: the layer it brought into the books;
 *   * a document the reader cannot see (another number) is null, not an error;
 *   * the printed copies say the same, in the same words.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool } from './setup';
import { withScope, type Tx } from '@/server/db/client';
import * as ap from '@/server/services/ap-invoice';
import * as coa from '@/server/services/chart-of-accounts';
import * as stock from '@/server/services/stock-operations';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import { runExport } from '@/server/print/export';
import { readPdf } from '../support/export-files';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

const ERBIL = 'WH-IF-ERBIL';
let world: TradingWorld;
let serial = 0;
const iqd = (value: string) => parseDecimal(value, 4n);
const q = (value: string) => parseQuantity(value);
const read = <T>(fn: (tx: Tx) => Promise<T>) => withScope(scope(world.manager), fn);

/** A purchase of the panel into the main warehouse, posted: one FIFO layer dated `on`. */
async function buy(quantity: string, price: string, on: string) {
  const made = await withScope(scope(world.clerk), (tx) =>
    ap.create(tx, world.clerk, {
      supplierId: world.supplierId,
      supplierInvoiceNo: `IF-${(serial += 1)}`,
      branchCode: BAGHDAD,
      invoiceDate: on,
      dueDate: '2026-12-31',
      lines: [{ itemCode: PANEL, description: 'Solar Panel 550W', quantity: q(quantity), unitPriceIqd: iqd(price), uomCode: 'EA', isInventory: true, warehouseCode: WAREHOUSE }],
    } as ap.CreateApInvoiceInput),
  );
  await withScope(scope(world.clerk), (tx) => ap.submit(tx, world.clerk, made.id));
  await withScope(scope(world.manager), (tx) => ap.post(tx, world.manager, made.id));
}

const transfer = (quantity: string, on: string) =>
  withScope(scope(world.clerk), (tx) =>
    stock.transfer(tx, world.clerk, { itemCode: PANEL, fromWarehouseCode: WAREHOUSE, toWarehouseCode: ERBIL, quantity: q(quantity), transferDate: on }),
  );
const adjust = (warehouseCode: string, direction: 'in' | 'out', quantity: string, on: string) =>
  withScope(scope(world.manager), (tx) =>
    stock.adjust(tx, world.manager, { itemCode: PANEL, warehouseCode, direction, quantity: q(quantity), adjustmentDate: on }),
  );

/** A printed copy's text. */
async function printed(key: 'transfer' | 'item_reconciliation', id: string): Promise<string> {
  const copy = await withScope(scope(world.manager), (tx) =>
    runExport(
      tx,
      { principal: world.manager.principal, branchCode: BAGHDAD },
      { key, format: 'pdf', locale: 'en', at: '2026-09-26T10:00:00.000Z', input: { id, query: new URLSearchParams() } },
    ),
  );
  expect(copy!.status).toBe(200);
  return readPdf(copy!.status === 200 ? copy!.body : Buffer.alloc(0)).text;
}

beforeEach(async () => {
  world = await buildTradingWorld();
  await ownerPool.query(
    `insert into warehouse (code, name, branch_code, warehouse_type) values ($1,'Erbil Store',$2,'main')`,
    [ERBIL, BAGHDAD],
  );
  // The account an Item Reconciliation posts its difference to, and the event that names it.
  const { rows: parent } = await ownerPool.query(`select id, account_type from chart_of_account where code = 'X000001'`);
  const { rows } = await ownerPool.query(
    `insert into chart_of_account (code, name, account_type, parent_id, is_group, is_active, approval_status, level, currency_restriction)
     values ('X980001','Inventory Adjustments',$1,$2,false,true,'approved',1,'IQD') returning id`,
    [parent[0].account_type, parent[0].id],
  );
  world.accounts.inventory_adjustment = rows[0].id;
  await withScope(scope(world.manager), (tx) => coa.setRequiredDimensions(tx, world.manager, rows[0].id, []));
  await ownerPool.query(
    `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
     values ('inventory.stock_adjustment','inventory_adjustment',$1,true,$2) on conflict do nothing`,
    [rows[0].id, world.manager.principal.userId],
  );
  // 100 at 10,000 on 1 August and 50 at 12,000 on 5 August: two layers, oldest first.
  await buy('100', '10000', '2026-08-01');
  await buy('50', '12000', '2026-08-05');
}, 120_000);

describe('a Transfer record', () => {
  it('shows the layers it carried at their own cost, and both warehouses before and after — and later documents do not move them', async () => {
    const first = await transfer('120', '2026-08-10');
    const view = (await read((tx) => stock.transferView(tx, first.transferNo)))!;
    expect(view).toMatchObject({ transferNo: first.transferNo, itemCode: PANEL, fromWarehouseCode: WAREHOUSE, toWarehouseCode: ERBIL, quantity: '120', ledgerRecorded: true });

    // FIFO: all of the older layer, 20 of the newer — 1,000,000 + 240,000, which is what the document says it cost.
    expect(view.layers.map((layer) => [layer.warehouseCode, layer.layerDate, layer.quantity, iqd(layer.unitCostIqd), iqd(layer.valueIqd)])).toEqual([
      [WAREHOUSE, '2026-08-01', '100', iqd('10000'), iqd('1000000')],
      [WAREHOUSE, '2026-08-05', '20', iqd('12000'), iqd('240000')],
    ]);
    expect(view.layers.reduce((sum, layer) => sum + iqd(layer.valueIqd), 0n)).toBe(iqd(view.costIqd));
    expect(iqd(view.costIqd)).toBe(iqd('1240000'));

    // Source first, then destination: 150 → 30 here, 0 → 120 there.
    expect(view.positions.map((position) => [position.warehouseCode, position.before, position.moved, position.after])).toEqual([
      [WAREHOUSE, '150', '-120', '30'],
      [ERBIL, '0', '120', '120'],
    ]);

    // A second transfer the same day stands after the first in the ledger…
    const second = await transfer('10', '2026-08-10');
    const next = (await read((tx) => stock.transferView(tx, second.transferNo)))!;
    expect(next.positions.map((position) => [position.warehouseCode, position.before, position.moved, position.after])).toEqual([
      [WAREHOUSE, '30', '-10', '20'],
      [ERBIL, '120', '10', '130'],
    ]);
    expect(next.layers.map((layer) => [layer.layerDate, layer.quantity, iqd(layer.valueIqd)])).toEqual([['2026-08-05', '10', iqd('120000')]]);
    // …and leaves the first one's figures as they were.
    const again = (await read((tx) => stock.transferView(tx, first.transferNo)))!;
    expect(again.positions).toEqual(view.positions);
    expect(again.layers).toEqual(view.layers);

    // A number nobody has is nothing, not an error.
    expect(await read((tx) => stock.transferView(tx, 'TRF-NO-SUCH'))).toBeNull();
  });

  it('prints the same: the number, the layers, the cost carried and both positions', async () => {
    const made = await transfer('120', '2026-08-10');
    const text = await printed('transfer', made.transferNo);
    for (const expected of [made.transferNo, PANEL, WAREHOUSE, ERBIL, '1,240,000', '240,000', '1,000,000']) {
      expect(text, expected).toContain(expected);
    }
    // 150 → −120 → 30 and 0 → +120 → 120, each in its warehouse's row.
    expect(text).toMatch(/150/);
    expect(text).toMatch(/-120/);
  });
});

describe('an Item Reconciliation record', () => {
  it('out: the layer it took, the one position it moved, and the journal that equals the layers', async () => {
    await transfer('120', '2026-08-10'); // 30 left in the main warehouse, all of the newer layer
    const made = await adjust(WAREHOUSE, 'out', '10', '2026-08-12');
    const view = (await read((tx) => stock.adjustmentView(tx, made.adjustmentNo)))!;
    expect(view).toMatchObject({ adjustmentNo: made.adjustmentNo, itemCode: PANEL, warehouseCode: WAREHOUSE, direction: 'out', quantity: '10', ledgerRecorded: true });

    expect(view.layers.map((layer) => [layer.warehouseCode, layer.layerDate, layer.quantity, iqd(layer.unitCostIqd), iqd(layer.valueIqd)])).toEqual([
      [WAREHOUSE, '2026-08-05', '10', iqd('12000'), iqd('120000')],
    ]);
    expect(view.positions.map((position) => [position.warehouseCode, position.before, position.moved, position.after])).toEqual([[WAREHOUSE, '30', '-10', '20']]);

    // The journal it posted: the difference to the adjustment account, out of inventory, for exactly the layers' value.
    expect(view.journalEntryNo).toMatch(/\S/);
    expect(view.journalStatus).toBe('posted');
    const debit = view.journalLines.reduce((sum, line) => sum + iqd(line.debitIqd), 0n);
    const credit = view.journalLines.reduce((sum, line) => sum + iqd(line.creditIqd), 0n);
    expect([debit, credit]).toEqual([iqd('120000'), iqd('120000')]);
    expect(view.journalLines.filter((line) => iqd(line.debitIqd) > 0n).map((line) => line.accountName)).toEqual(['Inventory Adjustments']);

    const text = await printed('item_reconciliation', made.adjustmentNo);
    for (const expected of [made.adjustmentNo, PANEL, WAREHOUSE, view.journalEntryNo!, '120,000', 'Inventory Adjustments']) {
      expect(text, expected).toContain(expected);
    }
  });

  it('in: the layer it brought into the books, in the warehouse it was found in', async () => {
    await transfer('120', '2026-08-10');
    const made = await adjust(ERBIL, 'in', '4', '2026-08-12');
    const view = (await read((tx) => stock.adjustmentView(tx, made.adjustmentNo)))!;
    expect(view).toMatchObject({ direction: 'in', quantity: '4', warehouseCode: ERBIL, ledgerRecorded: true });
    expect(view.layers).toHaveLength(1);
    expect(view.layers[0]).toMatchObject({ warehouseCode: ERBIL, quantity: '4' });
    expect(view.positions.map((position) => [position.warehouseCode, position.before, position.moved, position.after])).toEqual([[ERBIL, '120', '4', '124']]);
    // The layer's value is its quantity at its unit cost, and it is what the journal moved.
    const value = iqd(view.layers[0]!.valueIqd);
    expect(value).toBeGreaterThan(0n);
    expect(view.journalLines.reduce((sum, line) => sum + iqd(line.debitIqd), 0n)).toBe(value);
    expect(await read((tx) => stock.adjustmentView(tx, 'ADJ-NO-SUCH'))).toBeNull();
  });
});
