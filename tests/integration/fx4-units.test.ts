/**
 * REQ-FIX-001 FIX-4 — units of measure that work (the sponsor: "buying a
 * product, you cannot select the type of the unit").
 *
 *   FX10  a box of 24 bought at 24,000 a box is 24 pieces in stock at 1,000
 *         each: the FIFO layer, the warehouse value and the journal agree;
 *         returned by the box, 24 pieces leave.
 *   FX11  a unit the item does not keep is refused, with the way to add it;
 *         a quantity that does not divide into the base is refused; the base
 *         unit cannot be deactivated; one purchase default.
 *   FX12  the unit survives the draft: saved on a line, read back, posted in it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, rejection } from './setup';
import { withScope } from '@/server/db/client';
import * as ap from '@/server/services/ap-invoice';
import * as gr from '@/server/services/goods-return';
import * as ar from '@/server/services/ar-invoice';
import * as units from '@/server/services/item-units';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

let world: TradingWorld;
const iqd = (value: string) => parseDecimal(value, 4n);
const qty = (value: string) => parseQuantity(value);

async function invoiceInBoxes(boxes: string, pricePerBox: string, uomCode = 'BOX') {
  const made = await withScope(scope(world.clerk), (tx) =>
    ap.create(tx, world.clerk, {
      supplierId: world.supplierId,
      supplierInvoiceNo: `FX4-${Math.random().toString(36).slice(2, 8)}`,
      branchCode: BAGHDAD,
      invoiceDate: '2026-09-05',
      dueDate: '2026-10-05',
      lines: [{ itemCode: PANEL, description: 'Solar Panel 550W', quantity: qty(boxes), unitPriceIqd: iqd(pricePerBox), uomCode, isInventory: true, warehouseCode: WAREHOUSE }],
    } as ap.CreateApInvoiceInput),
  );
  return made.id;
}

const post = async (invoiceId: string) => {
  await withScope(scope(world.clerk), (tx) => ap.submit(tx, world.clerk, invoiceId));
  await withScope(scope(world.manager), (tx) => ap.post(tx, world.manager, invoiceId));
};

const stock = async () =>
  (
    await ownerPool.query(
      `select coalesce(sum(remaining_quantity), 0)::text as quantity, coalesce(sum(remaining_quantity * unit_cost_iqd), 0)::text as value
         from cost_layer where item_code = $1 and warehouse_code = $2`,
      [PANEL, WAREHOUSE],
    )
  ).rows[0];

beforeEach(async () => {
  world = await buildTradingWorld();
  await withScope(scope(world.manager), (tx) => units.addUnit(tx, world.manager, PANEL, { uomCode: 'BOX', numerator: 24n, isPurchaseDefault: true }));
});

describe('FX10 · bought by the box, counted by the piece', () => {
  it('2 boxes at 24,000 a box are 48 pieces at 1,000 each — the layer, the value and the journal agree', async () => {
    const before = await stock();
    const invoiceId = await invoiceInBoxes('2', '24000');
    await post(invoiceId);

    const { rows: movement } = await ownerPool.query(
      `select m.quantity::text, l.unit_cost_iqd::text from inventory_movement m join cost_layer l on l.created_by_movement_id = m.id where m.source_document_id = $1`,
      [invoiceId],
    );
    expect(movement[0]).toMatchObject({ quantity: '48.000000', unit_cost_iqd: '1000.0000' });
    const after = await stock();
    expect(Number(after.quantity) - Number(before.quantity)).toBe(48);
    expect(Number(after.value) - Number(before.value)).toBe(48000);

    const { rows: journal } = await ownerPool.query(
      `select sum(l.debit_iqd)::text as debit from journal_line l join ap_invoice i on i.journal_entry_id = l.journal_entry_id where i.id = $1 and l.account_id = $2`,
      [invoiceId, world.accounts.inventory],
    );
    expect(journal[0].debit).toBe('48000.0000');

    // Returned by the box: one box is 24 pieces out of the warehouse.
    const { rows: line } = await ownerPool.query(`select id from ap_invoice_line where ap_invoice_id = $1`, [invoiceId]);
    const created = await withScope(scope(world.clerk), (tx) =>
      gr.createFromInvoice(tx, world.clerk, {
        apInvoiceId: invoiceId,
        returnDate: '2026-09-10',
        reason: 'One box arrived cracked',
        offsetKind: 'payable',
        lines: [{ apInvoiceLineId: line[0].id, quantity: qty('1') }],
      }),
    );
    await withScope(scope(world.manager), (tx) => gr.approve(tx, world.manager, created.id));
    await withScope(scope(world.manager), (tx) => gr.post(tx, world.manager, created.id));
    const returned = await stock();
    expect(Number(after.quantity) - Number(returned.quantity)).toBe(24);
    expect(Number(after.value) - Number(returned.value)).toBe(24000);
  });

  it('a line in no unit starts in the purchase default', async () => {
    const made = await withScope(scope(world.clerk), (tx) =>
      ap.create(tx, world.clerk, {
        supplierId: world.supplierId,
        supplierInvoiceNo: 'FX4-DEFAULT',
        branchCode: BAGHDAD,
        invoiceDate: '2026-09-05',
        dueDate: '2026-10-05',
        lines: [{ itemCode: PANEL, description: 'Solar Panel 550W', quantity: qty('1'), unitPriceIqd: iqd('24000'), isInventory: true, warehouseCode: WAREHOUSE }],
      } as ap.CreateApInvoiceInput),
    );
    const { rows } = await ownerPool.query(`select uom_code from ap_invoice_line where ap_invoice_id = $1`, [made.id]);
    expect(rows[0].uom_code).toBe('BOX');
  });
});

describe('FX11 · what is refused', () => {
  it('a unit the item does not keep, with the way to add it', async () => {
    expect(await rejection(invoiceInBoxes('1', '1000', 'KG'))).toMatch(/ITM-PANEL is not kept in KG.*Units/);
  });

  it('a quantity that does not divide into the base', async () => {
    await withScope(scope(world.manager), (tx) => units.addUnit(tx, world.manager, PANEL, { uomCode: 'M', numerator: 1n, denominator: 3n }));
    const invoiceId = await invoiceInBoxes('1', '300', 'M');
    expect(await rejection(post(invoiceId))).toMatch(/not a whole number/);
  });

  it('the base unit stays, a unit goes with a reason and its default falls back to the base', async () => {
    expect(await rejection(withScope(scope(world.manager), (tx) => units.deactivate(tx, world.manager, PANEL, 'EA', 'no')))).toMatch(/base unit/);
    // The database holds it too.
    expect(await rejection(ownerPool.query(`update item_uom set active = false, deactivated_reason = 'x' where uom_code = 'EA' and item_id = (select id from item where code = $1)`, [PANEL]))).toMatch(
      /base unit of an item stays active/,
    );
    await withScope(scope(world.manager), (tx) => units.deactivate(tx, world.manager, PANEL, 'BOX', 'Supplier sells loose now'));
    const listed = await withScope(scope(world.manager), (tx) => units.unitsOf(tx, PANEL));
    expect(listed.map((unit) => [unit.uomCode, unit.active, unit.isPurchaseDefault])).toEqual([
      ['EA', true, true],
      ['BOX', false, false],
    ]);
    expect(await rejection(invoiceInBoxes('1', '24000'))).toMatch(/not kept in BOX/);
    // Brought back, with a new conversion.
    await withScope(scope(world.manager), (tx) => units.addUnit(tx, world.manager, PANEL, { uomCode: 'BOX', numerator: 12n }));
    expect((await withScope(scope(world.manager), (tx) => units.conversionOf(tx, PANEL, 'BOX'))).numerator).toBe(12n);
  });

  it('a sale is written in the base unit — another unit is refused, none is the base', async () => {
    const sell = (uomCode?: string) =>
      withScope(scope(world.clerk), (tx) =>
        ar.createDirect(tx, world.clerk, {
          customerId: world.customerId,
          branchCode: BAGHDAD,
          invoiceDate: '2026-09-06',
          dueDate: '2026-10-06',
          lines: [{ itemCode: PANEL, quantity: qty('1'), unitPriceIqd: iqd('1500'), warehouseCode: WAREHOUSE, ...(uomCode ? { uomCode } : {}) }],
        }),
      );
    expect(await rejection(sell('BOX'))).toMatch(/written in the item's base unit, EA/);
    const made = await sell();
    const { rows } = await ownerPool.query(`select uom_code from ar_invoice_line where ar_invoice_id = $1`, [made.id]);
    expect(rows[0].uom_code).toBe('EA');
  });

  it('one purchase default at a time', async () => {
    await withScope(scope(world.manager), (tx) => units.setDefault(tx, world.manager, PANEL, 'EA', 'purchase'));
    const { rows } = await ownerPool.query(`select uom_code from item_uom where item_id = (select id from item where code = $1) and is_purchase_default and active`, [PANEL]);
    expect(rows.map((row) => row.uom_code)).toEqual(['EA']);
  });
});

describe('FX12 · the unit survives the draft', () => {
  it('saved on a line, read back and posted in it', async () => {
    const invoiceId = await invoiceInBoxes('1', '24000', 'EA');
    const { rows: line } = await ownerPool.query(`select id from ap_invoice_line where ap_invoice_id = $1`, [invoiceId]);
    await withScope(scope(world.clerk), (tx) =>
      ap.saveLine(tx, world.clerk, invoiceId, line[0].id, { itemCode: PANEL, quantity: qty('3'), unitPriceIqd: iqd('24000'), warehouseCode: WAREHOUSE, uomCode: 'BOX' }),
    );
    const { rows: saved } = await ownerPool.query(`select uom_code, quantity::text from ap_invoice_line where id = $1`, [line[0].id]);
    expect(saved[0]).toMatchObject({ uom_code: 'BOX', quantity: '3.000000' });
    await post(invoiceId);
    const { rows: movement } = await ownerPool.query(`select quantity::text from inventory_movement where source_document_id = $1`, [invoiceId]);
    expect(movement[0].quantity).toBe('72.000000');
  });
});
