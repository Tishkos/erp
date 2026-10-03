/**
 * IMPROVEMENT-002 — a supplier return after the landed cost is locked.
 *
 * An import's goods stand in layers its container receipts created out of the
 * transit warehouse, and a lock restates those layers: the invoice price plus
 * the share of freight, duty and clearance. A return against the invoice must
 *
 *   * find those goods by their lineage, not by the invoice's unit cost (which
 *     the lock changed) — before this it refused with "Only 0 …";
 *   * take them out of stock at what the layer now carries, and credit the
 *     supplier (or the bank) only what the invoice charged;
 *   * post the landed part of the returned units to its own line: purchase
 *     variance when the supplier does not pay it back, return clearing when
 *     they do — `reimburses_landed_cost`, No by default, frozen once posted.
 *
 * The world is ap07's: 100 panels at 10,000 IQD on one import, two containers
 * of 50 received into the main warehouse, the PD written off. Nothing is sold
 * before the lock, so the lock has no departed share.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, rejection } from './setup';
import { withScope } from '@/server/db/client';
import * as ap from '@/server/services/ap-invoice';
import * as customs from '@/server/services/customs-pd';
import * as gr from '@/server/services/goods-return';
import * as inventory from '@/server/services/inventory';
import * as landed from '@/server/services/landed-cost';
import * as shipments from '@/server/services/shipments';
import { costOf } from '@/server/domain/fifo';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';
import { fundBank } from './hr-funds';

const IN_PROCESS = 'WH-LC02-INPROC';
const RETURN_ON = '2026-10-31';
let world: TradingWorld;
let invoiceId: string;
let invoiceLineId: string;
let payableId: string;
let pdId: string;
let serial = 0;
const iqd = (value: string) => parseDecimal(value, 4n);
const q = (value: string) => parseQuantity(value);

/** A posted journal, as an accountant would post one: Dr `debit` Cr `credit`. */
async function journal(debit: string, credit: string, amount: string, on = '2026-10-20') {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows: periods } = await client.query(
      `select id from fiscal_period where starts_on <= $1::date and ends_on >= $1::date limit 1`,
      [on],
    );
    const entryNo = `JV-LC02-${(serial += 1)}`;
    const { rows: entry } = await client.query(
      `insert into journal_entry
         (entry_no, document_date, posting_date, fiscal_period_id, branch_code, description,
          status, total_debit_iqd, total_credit_iqd, created_by)
       values ($1,$2,$2,$3,$4,'Manual journal','draft',$5,$5,$6) returning id`,
      [entryNo, on, periods[0].id, BAGHDAD, amount, world.manager.principal.userId],
    );
    await client.query(
      `insert into journal_line
         (journal_entry_id, line_no, account_id, debit_txn, credit_txn,
          debit_iqd, credit_iqd, debit_usd, credit_usd, currency, branch_code)
       values ($1, 1, $2, $3, 0, $3, 0, 0, 0, 'IQD', $5),
              ($1, 2, $4, 0, $3, 0, $3, 0, 0, 'IQD', $5)`,
      [entry[0].id, debit, amount, credit, BAGHDAD],
    );
    await client.query(
      `update journal_entry set status = 'posted', approved_by = $2, posted_at = now() where id = $1`,
      [entry[0].id, world.manager.principal.userId],
    );
    await client.query('commit');
    return entryNo;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const charge = (type: string, amount: string) =>
  journal(world.accounts.landed_cost_clearing!, world.accounts.bank!, amount).then((entryNo) =>
    withScope(scope(world.clerk), (tx) =>
      landed.addCharge(tx, world.clerk, { payableId, chargeTypeCode: type, journalEntryNo: entryNo, amountIqd: iqd(amount) }),
    ),
  );
const pdTo = (statusCode: string, on: string) =>
  withScope(scope(world.clerk), (tx) => customs.changeStatus(tx, world.clerk, pdId, { statusCode, effectiveDate: on }));

/**
 * Freight 33,333 and duty 11,111, written off and locked by value over the two
 * container layers (50 panels at 10,000 each): 22,222 each, so every panel
 * now carries 10,444.44.
 */
async function lockCharges() {
  await charge('freight', '33333');
  await charge('customs_asycuda', '11111');
  await pdTo('totally_written_off', '2026-10-25');
  return withScope(scope(world.manager), (tx) =>
    landed.lock(tx, world.manager, { payableId, lockDate: '2026-10-30', basisCode: 'by_value' }),
  );
}

async function receiveAll() {
  const { rows: containers } = await ownerPool.query(
    `select id from shipment_container where payable_id = $1 order by container_no`,
    [payableId],
  );
  for (const container of containers) {
    const { rows: lines } = await ownerPool.query(
      `select id, planned_qty from shipment_container_line where container_id = $1 and superseded_at is null`,
      [container.id],
    );
    await withScope(scope(world.clerk), (tx) =>
      shipments.receive(tx, world.clerk, {
        documentId: randomUUID(),
        containerId: container.id,
        warehouseCode: WAREHOUSE,
        receiptDate: '2026-10-10',
        lines: lines.map((line) => ({ containerLineId: line.id, receivedQty: q(line.planned_qty), damagedQty: 0n, shortQty: 0n })),
        varianceReason: null,
      }),
    );
  }
}

/** Raises, approves and sends back `quantity` panels from the main warehouse. */
async function returnPanels(quantity: string, reimbursesLandedCost?: boolean) {
  const created = await withScope(scope(world.clerk), (tx) =>
    gr.createFromInvoice(tx, world.clerk, {
      apInvoiceId: invoiceId,
      returnDate: RETURN_ON,
      reason: 'Cracked glass on arrival',
      offsetKind: 'payable',
      ...(reimbursesLandedCost === undefined ? {} : { reimbursesLandedCost }),
      lines: [{ apInvoiceLineId: invoiceLineId, quantity: q(quantity), warehouseCode: WAREHOUSE }],
    }),
  );
  await withScope(scope(world.manager), (tx) => gr.approve(tx, world.manager, created.id));
  const posted = await withScope(scope(world.manager), (tx) => gr.post(tx, world.manager, created.id));
  return { ...created, ...posted };
}

/** The return's journal, line by line. */
async function journalOf(goodsReturnId: string) {
  const { rows } = await ownerPool.query(
    `select l.line_role as role, l.account_id as account, l.warehouse_code as warehouse,
            l.business_partner_code as partner, l.debit_iqd::text as debit, l.credit_iqd::text as credit
       from journal_line l
       join goods_return r on r.journal_entry_id = l.journal_entry_id
      where r.id = $1
      order by l.line_no`,
    [goodsReturnId],
  );
  return rows as { role: string; account: string; warehouse: string | null; partner: string | null; debit: string; credit: string }[];
}

/** The PANEL layers in the main warehouse, FIFO order. */
async function mainLayers() {
  const { rows } = await ownerPool.query(
    `select id, remaining_quantity::text as remaining, unit_cost_iqd::text as unit
       from cost_layer where item_code = $1 and warehouse_code = $2
      order by layer_date, sequence`,
    [PANEL, WAREHOUSE],
  );
  return rows as { id: string; remaining: string; unit: string }[];
}

beforeEach(async () => {
  world = await buildTradingWorld();
  await fundBank(world, '1000000.0000');
  await ownerPool.query(
    `insert into warehouse (code, name, branch_code, warehouse_type, is_transit, shipment_stage)
     values ($1,'In Process',$2,'transit',true,'in_process')`,
    [IN_PROCESS, BAGHDAD],
  );
  const { rows: parent } = await ownerPool.query(`select id from chart_of_account where code = 'A000001'`);
  const { rows: clearing } = await ownerPool.query(
    `insert into chart_of_account (code, name, account_type, parent_id, is_group, is_active, approval_status, level, currency_restriction)
     values ('A970002','Landed Cost Clearing','asset',$1,false,true,'approved',1,'IQD') returning id`,
    [parent[0].id],
  );
  world.accounts.landed_cost_clearing = clearing[0].id;
  await ownerPool.query(
    `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
     values ('payables.landed_cost','landed_cost_clearing',$1,true,$2)`,
    [clearing[0].id, world.manager.principal.userId],
  );
  await ownerPool.query(
    `insert into document_type_dimension (document_type_code, dimension, requirement)
     values ('landed_cost_lock','business_line','optional')
     on conflict (document_type_code, dimension) do update set requirement='optional'`,
  );

  const made = await withScope(scope(world.clerk), (tx) =>
    ap.create(tx, world.clerk, {
      supplierId: world.supplierId,
      supplierInvoiceNo: 'CSA-LC02-0001',
      branchCode: BAGHDAD,
      invoiceDate: '2026-09-01',
      dueDate: '2026-11-01',
      isImport: true,
      lines: [
        {
          itemCode: PANEL,
          description: 'Solar Panel 550W',
          quantity: q('100'),
          unitPriceIqd: iqd('10000'),
          uomCode: 'EA',
          isInventory: true,
          warehouseCode: WAREHOUSE,
        },
      ],
    }),
  );
  invoiceId = made.id;
  const { rows } = await ownerPool.query(
    `select i.payable_id, l.id as line_id from ap_invoice i join ap_invoice_line l on l.ap_invoice_id = i.id where i.id = $1`,
    [invoiceId],
  );
  payableId = rows[0].payable_id;
  invoiceLineId = rows[0].line_id;
  await withScope(scope(world.clerk), (tx) => ap.submit(tx, world.clerk, invoiceId));
  await withScope(scope(world.manager), (tx) => ap.post(tx, world.manager, invoiceId));

  await withScope(scope(world.clerk), (tx) =>
    shipments.createBl(tx, world.clerk, {
      payableId,
      blNo: 'MEDULC020001',
      blDate: '2026-09-20',
      eta: '2026-10-05',
      containers: 'MSCU1234566\nTGHU7654320',
      spreadLines: true,
    }),
  );
  await receiveAll();
  const pd = await withScope(scope(world.clerk), (tx) =>
    customs.register(tx, world.clerk, { payableId, pdNo: '6602', registrationDate: '2026-09-02', expiryDate: '2027-03-01' }),
  );
  pdId = pd.id;
  await pdTo('validated', '2026-09-05');
});

describe('IMPROVEMENT-002 · a supplier return after the landed cost is locked', () => {
  it('No (the default): stock leaves at the restated cost, the supplier at the invoice cost, the landed part to purchase variance', async () => {
    const done = await lockCharges();
    expect([done.totalIqd, done.inventoryIqd, done.cogsIqd]).toEqual(['44444.0000', '44444.0000', '0.0000']);
    expect((await mainLayers()).map((layer) => [layer.remaining, layer.unit])).toEqual([
      ['50.000000', '10444.4400'],
      ['50.000000', '10444.4400'],
    ]);

    // Before this change the lock's restated cost hid the goods: "Only 0 …".
    const back = await returnPanels('7');
    const { rows: header } = await ownerPool.query(
      `select reimburses_landed_cost, status from goods_return where id = $1`,
      [back.id],
    );
    expect(header[0]).toEqual({ reimburses_landed_cost: false, status: 'posted' });

    // 7 × 10,444.44 = 73,111.08 out of stock; 7 × 10,000 = 70,000 off the debt.
    expect(back.costIqd).toBe(iqd('73111.08'));
    expect(back.landedIqd).toBe(iqd('3111.08'));
    expect(await journalOf(back.id)).toEqual([
      { role: 'supplier_payable', account: world.accounts.supplier_payable, warehouse: null, partner: 'SUP-JINKO', debit: '70000.0000', credit: '0.0000' },
      { role: 'purchase_variance', account: world.accounts.purchase_variance, warehouse: WAREHOUSE, partner: 'SUP-JINKO', debit: '3111.0800', credit: '0.0000' },
      { role: 'inventory', account: world.accounts.inventory, warehouse: WAREHOUSE, partner: 'SUP-JINKO', debit: '0.0000', credit: '73111.0800' },
    ]);

    // The invoice is settled by what it charged for the goods, not by their landed cost.
    const { rows: invoice } = await ownerPool.query(
      `select settled_amount_iqd::text as settled, status from ap_invoice where id = $1`,
      [invoiceId],
    );
    expect(invoice[0]).toEqual({ settled: '70000.0000', status: 'partially_executed' });

    // FIFO: the oldest container layer gave the seven.
    expect((await mainLayers()).map((layer) => layer.remaining)).toEqual(['43.000000', '50.000000']);
  });

  it('Yes: the landed part waits in return clearing for the supplier’s credit', async () => {
    await lockCharges();
    const back = await returnPanels('7', true);
    const { rows: header } = await ownerPool.query(`select reimburses_landed_cost from goods_return where id = $1`, [back.id]);
    expect(header[0].reimburses_landed_cost).toBe(true);
    expect(await journalOf(back.id)).toEqual([
      { role: 'supplier_payable', account: world.accounts.supplier_payable, warehouse: null, partner: 'SUP-JINKO', debit: '70000.0000', credit: '0.0000' },
      { role: 'return_clearing', account: world.accounts.return_clearing, warehouse: WAREHOUSE, partner: 'SUP-JINKO', debit: '3111.0800', credit: '0.0000' },
      { role: 'inventory', account: world.accounts.inventory, warehouse: WAREHOUSE, partner: 'SUP-JINKO', debit: '0.0000', credit: '73111.0800' },
    ]);
  });

  it('the choice is frozen once the return is posted', async () => {
    await lockCharges();
    const back = await returnPanels('2');
    expect(
      await rejection(ownerPool.query(`update goods_return set reimburses_landed_cost = true where id = $1`, [back.id])),
    ).toMatch(/has shipped and posted/);
    const { rows } = await ownerPool.query(`select reimburses_landed_cost from goods_return where id = $1`, [back.id]);
    expect(rows[0].reimburses_landed_cost).toBe(false);
  });

  it('refuses, naming the role, when the landed part has no account to go to', async () => {
    await lockCharges();
    await ownerPool.query(
      `update posting_rule set is_active = false where event_type = 'purchasing.ap_invoice' and line_role = 'purchase_variance'`,
    );
    const created = await withScope(scope(world.clerk), (tx) =>
      gr.createFromInvoice(tx, world.clerk, {
        apInvoiceId: invoiceId,
        returnDate: RETURN_ON,
        reason: 'Cracked glass on arrival',
        offsetKind: 'payable',
        lines: [{ apInvoiceLineId: invoiceLineId, quantity: q('1'), warehouseCode: WAREHOUSE }],
      }),
    );
    await withScope(scope(world.manager), (tx) => gr.approve(tx, world.manager, created.id));
    expect(await rejection(withScope(scope(world.manager), (tx) => gr.post(tx, world.manager, created.id)))).toMatch(
      /'purchase_variance'/,
    );
    // Nothing moved: the stock and the return are as they were.
    expect((await mainLayers()).map((layer) => layer.remaining)).toEqual(['50.000000', '50.000000']);
  });

  it('follows the stock by origin_layer_id: a layer moved after the lock is found through its chain', async () => {
    // The relocations as the engine now writes them: each container layer names
    // the invoice's transit layer as its origin. Nothing else would recognise
    // them — the legacy matching is only for layers that carry no origin.
    const { rows: transit } = await ownerPool.query(
      `select cl.id from cost_layer cl join inventory_movement m on m.id = cl.created_by_movement_id
        where m.source_document_type = 'ap_invoice' and m.source_line_id = $1`,
      [invoiceLineId],
    );
    await ownerPool.query(`update cost_layer set origin_layer_id = $1 where item_code = $2 and warehouse_code = $3`, [
      transit[0].id,
      PANEL,
      WAREHOUSE,
    ]);
    await lockCharges();

    // Ten restated panels move on to Erbil, and the new layer names its origin.
    await ownerPool.query(
      `insert into warehouse (code, name, branch_code, warehouse_type) values ('WH-LC02-ERBIL','Erbil Store',$1,'branch')`,
      [BAGHDAD],
    );
    const [first] = await mainLayers();
    await withScope(scope(world.manager), async (tx) =>
      inventory.relocate(tx, world.manager, {
        itemCode: PANEL,
        fromWarehouseCode: WAREHOUSE,
        toWarehouseCode: 'WH-LC02-ERBIL',
        branchCode: BAGHDAD,
        quantity: q('10'),
        movementDate: RETURN_ON,
        layers: (await inventory.layersOf(tx, PANEL, WAREHOUSE)).filter((layer) => layer.id === first!.id),
        sourceDocumentType: 'stock_transfer',
        sourceDocumentId: 'TRF-LC02-1',
        sourceLineId: '1',
      }),
    );
    await ownerPool.query(
      `update cost_layer set origin_layer_id = $1 where item_code = $2 and warehouse_code = 'WH-LC02-ERBIL'`,
      [first!.id, PANEL],
    );

    const created = await withScope(scope(world.clerk), (tx) =>
      gr.createFromInvoice(tx, world.clerk, {
        apInvoiceId: invoiceId,
        returnDate: RETURN_ON,
        reason: 'Wrong colour frames',
        offsetKind: 'payable',
        lines: [{ apInvoiceLineId: invoiceLineId, quantity: q('4'), warehouseCode: 'WH-LC02-ERBIL' }],
      }),
    );
    await withScope(scope(world.manager), (tx) => gr.approve(tx, world.manager, created.id));
    const back = await withScope(scope(world.manager), (tx) => gr.post(tx, world.manager, created.id));
    // 4 × 10,444.44 = 41,777.76 out of Erbil; 40,000 off the debt.
    expect([back.costIqd, back.landedIqd]).toEqual([iqd('41777.76'), iqd('1777.76')]);
    expect((await journalOf(created.id)).map((line) => [line.role, line.warehouse, line.debit, line.credit])).toEqual([
      ['supplier_payable', null, '40000.0000', '0.0000'],
      ['purchase_variance', 'WH-LC02-ERBIL', '1777.7600', '0.0000'],
      ['inventory', 'WH-LC02-ERBIL', '0.0000', '41777.7600'],
    ]);
  });

  it('before any lock nothing changes: the invoice cost both sides, no landed line', async () => {
    const back = await returnPanels('5');
    expect(back.costIqd).toBe(iqd('50000'));
    expect(back.landedIqd).toBe(0n);
    expect(await journalOf(back.id)).toEqual([
      { role: 'supplier_payable', account: world.accounts.supplier_payable, warehouse: null, partner: 'SUP-JINKO', debit: '50000.0000', credit: '0.0000' },
      { role: 'inventory', account: world.accounts.inventory, warehouse: WAREHOUSE, partner: 'SUP-JINKO', debit: '0.0000', credit: '50000.0000' },
    ]);
  });

  it('afterwards the layers are worth exactly what the inventory account holds', async () => {
    await lockCharges();
    await returnPanels('7');

    // Σ remaining × unit cost, over every PANEL layer anywhere (transit included).
    const { rows: layers } = await ownerPool.query(
      `select remaining_quantity::text as remaining, unit_cost_iqd::text as unit from cost_layer where item_code = $1`,
      [PANEL],
    );
    const layerValue = layers.reduce((sum, layer) => sum + costOf(q(layer.remaining), iqd(layer.unit)), 0n);

    // The inventory account, moved by the invoice (+1,000,000), the lock
    // (+44,444) and the return (−73,111.08), and nothing else in this world.
    const { rows: ledger } = await ownerPool.query(
      `select coalesce(sum(l.debit_iqd - l.credit_iqd), 0)::text as balance
         from journal_line l join journal_entry e on e.id = l.journal_entry_id
        where l.account_id = $1 and e.status = 'posted'`,
      [world.accounts.inventory],
    );
    expect(layerValue).toBe(iqd('971332.92'));
    expect(iqd(ledger[0].balance)).toBe(layerValue);
  });
});
