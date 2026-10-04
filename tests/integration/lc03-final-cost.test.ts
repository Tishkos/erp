/**
 * IMPROVEMENT-002 — what an import's goods finally cost, and where every dinar
 * of its landed cost went (`services/final-cost.ts`).
 *
 *   * one lock, nothing sold: the final unit cost is the invoice price plus
 *     the charges per unit, exactly — and the figures the import page showed
 *     before are unchanged;
 *   * three locks on the same layers: the chain of unit costs, and each lock's
 *     charges by type, split over the layer by the largest remainder;
 *   * stock moved on before a lock: the moved stock is on hand and its charges
 *     are not lost (the audit's A1 and A2);
 *   * every lock reconciles: what went into stock and what followed departed
 *     stock is its total, exactly.
 *
 * The import is built as `ap07-landed-cost.test.ts` builds it.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool } from './setup';
import { withScope, type Tx } from '@/server/db/client';
import { registerDepartureRuntime } from '@/server/departures-runtime';
import * as ap from '@/server/services/ap-invoice';
import * as customs from '@/server/services/customs-pd';
import * as inventory from '@/server/services/inventory';
import * as landed from '@/server/services/landed-cost';
import * as finalCosts from '@/server/services/final-cost';
import * as inventoryReports from '@/server/services/inventory-reports';
import * as shipments from '@/server/services/shipments';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';
import { fundBank } from './hr-funds';

const IN_PROCESS = 'WH-LC03-INPROC';
const SECOND = 'WH-LC03-ERBIL';
let world: TradingWorld;
let invoiceId: string;
let invoiceNo: string;
let payableId: string;
let pdId: string;
let serial = 0;
const iqd = (value: string) => parseDecimal(value, 4n);
const q = (value: string) => parseQuantity(value);

/** A posted journal, as an accountant would post one: Dr `debit` Cr `credit`. */
async function journal(debit: string, credit: string, amount: string, on = '2026-08-20') {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows: periods } = await client.query(
      `select id from fiscal_period where starts_on <= $1::date and ends_on >= $1::date limit 1`,
      [on],
    );
    const entryNo = `JV-LC03-${(serial += 1)}`;
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

/** A charge from its own posted journal; answers the journal's number (the charge's source document). */
const charge = async (type: string, amount: string, reason: string | null = null) => {
  const entryNo = await journal(world.accounts.landed_cost_clearing!, world.accounts.bank!, amount);
  await withScope(scope(world.clerk), (tx) =>
    landed.addCharge(tx, world.clerk, { payableId, chargeTypeCode: type, journalEntryNo: entryNo, amountIqd: iqd(amount), reason }),
  );
  return entryNo;
};
const lock = (input: Partial<landed.LockInput> = {}) =>
  withScope(scope(world.manager), (tx) => landed.lock(tx, world.manager, { payableId, lockDate: '2026-08-30', ...input }));
const writeOffPd = () =>
  withScope(scope(world.clerk), (tx) =>
    customs.changeStatus(tx, world.clerk, pdId, { statusCode: 'totally_written_off', effectiveDate: '2026-08-25' }),
  );
const read = <T>(fn: (tx: Tx) => Promise<T>) => withScope(scope(world.manager), fn);
const finalCost = () => read((tx) => finalCosts.finalCost(tx, payableId));
const trace = () => read((tx) => finalCosts.finalCostTrace(tx, payableId));

/** The layers the container receipts created, oldest first. */
async function receivedLayers() {
  const { rows } = await ownerPool.query(
    `select cl.id
       from cost_layer cl join inventory_movement m on m.id = cl.created_by_movement_id
      where m.source_document_type = 'container_receipt' and m.kind = 'transfer_receipt'
      order by cl.layer_date, cl.sequence`,
  );
  return rows.map((row) => row.id as string);
}

/** Moves `quantity` of one received layer to the second warehouse, as a stock transfer does. */
async function transfer(layerId: string, quantity: string, documentNo: string) {
  await withScope(scope(world.manager), async (tx) =>
    inventory.relocate(tx, world.manager, {
      itemCode: PANEL,
      fromWarehouseCode: WAREHOUSE,
      toWarehouseCode: SECOND,
      branchCode: BAGHDAD,
      quantity: q(quantity),
      movementDate: '2026-08-16',
      layers: (await inventory.layersOf(tx, PANEL, WAREHOUSE)).filter((layer) => layer.id === layerId),
      sourceDocumentType: 'stock_transfer',
      sourceDocumentId: documentNo,
      sourceLineId: '1',
    }),
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
        receiptDate: '2026-08-10',
        lines: lines.map((line) => ({ containerLineId: line.id, receivedQty: q(line.planned_qty), damagedQty: 0n, shortQty: 0n })),
        varianceReason: null,
      }),
    );
  }
}

/** Every lock whole, and every model's identity with nothing left unexplained. */
function expectAccountedFor(result: finalCosts.FinalCostTrace) {
  expect(result.locks.length).toBeGreaterThan(0);
  for (const entry of result.locks) {
    expect(entry.reconciliation, entry.lockNo).toMatchObject({ balanced: true, chargesMatch: true, differenceIqd: '0.0000' });
    expect(entry.reconciliation.accountedIqd).toBe(entry.totalIqd);
    expect(entry.reconciliation.unattributedIqd).toBe('0.0000');
  }
  for (const model of result.models) {
    expect(model.totals.unexplainedIqd, model.itemCode).toBe('0.0000');
    expect(iqd(model.totals.purchaseValueIqd) + iqd(model.totals.chargesIqd)).toBe(
      iqd(model.totals.stockValueIqd) + iqd(model.totals.departedIqd) + iqd(model.totals.consumedIqd),
    );
  }
}

beforeEach(async () => {
  registerDepartureRuntime();
  world = await buildTradingWorld();
  await fundBank(world, '1000000.0000');
  await ownerPool.query(
    `insert into warehouse (code, name, branch_code, warehouse_type, is_transit, shipment_stage)
     values ($1,'In Process',$2,'transit',true,'in_process'), ($3,'Erbil Store',$2,'branch',false,null)`,
    [IN_PROCESS, BAGHDAD, SECOND],
  );
  const { rows: parent } = await ownerPool.query(`select id from chart_of_account where code = 'A000001'`);
  const { rows: clearing } = await ownerPool.query(
    `insert into chart_of_account (code, name, account_type, parent_id, is_group, is_active, approval_status, level, currency_restriction)
     values ('A970003','Landed Cost Clearing','asset',$1,false,true,'approved',1,'IQD') returning id`,
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

  // 100 panels at 10,000 — agreed in dollars at 1,250, so 8 USD a panel.
  const made = await withScope(scope(world.clerk), (tx) =>
    ap.create(tx, world.clerk, {
      supplierId: world.supplierId,
      supplierInvoiceNo: 'CSA-LC03-0001',
      branchCode: BAGHDAD,
      invoiceDate: '2026-07-01',
      dueDate: '2026-09-01',
      isImport: true,
      agreedCurrency: 'USD',
      agreedRate: '1250',
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
  const { rows } = await ownerPool.query(`select payable_id, invoice_no from ap_invoice where id = $1`, [invoiceId]);
  payableId = rows[0].payable_id;
  invoiceNo = rows[0].invoice_no;
  await withScope(scope(world.clerk), (tx) => ap.submit(tx, world.clerk, invoiceId));
  await withScope(scope(world.manager), (tx) => ap.post(tx, world.manager, invoiceId));

  await withScope(scope(world.clerk), (tx) =>
    shipments.createBl(tx, world.clerk, {
      payableId,
      blNo: 'MEDULC030001',
      blDate: '2026-07-20',
      eta: '2026-08-05',
      containers: 'MSCU1234566\nTGHU7654320',
      spreadLines: true,
    }),
  );
  await receiveAll();
  const pd = await withScope(scope(world.clerk), (tx) =>
    customs.register(tx, world.clerk, { payableId, pdNo: '6603', registrationDate: '2026-07-02', expiryDate: '2027-01-01' }),
  );
  pdId = pd.id;
  await withScope(scope(world.clerk), (tx) =>
    customs.changeStatus(tx, world.clerk, pdId, { statusCode: 'validated', effectiveDate: '2026-07-05' }),
  );
});

describe('LC-3 · the final cost', () => {
  it('one lock, nothing sold: invoice price plus the charges per unit, exactly — and the page’s figures unchanged', async () => {
    expect(await finalCost()).toEqual([]); // nothing locked: a forecast is the preview's
    const freight = await charge('freight', '3000');
    const duty = await charge('customs_asycuda', '2000');
    await writeOffPd();
    const done = await lock({ basisCode: 'by_value' });
    expect([done.totalIqd, done.inventoryIqd, done.cogsIqd]).toEqual(['5000.0000', '5000.0000', '0.0000']);

    const [row] = await finalCost();
    expect(row).toEqual({
      itemCode: PANEL,
      receivedQty: '100',
      onHandQty: '100',
      invoicedUnitIqd: '10000.0000',
      chargesUnitIqd: '50.0000',
      finalUnitIqd: '10050.0000',
      chargesIqd: '5000.0000',
      finalValueIqd: '1005000.0000',
      purchaseValueIqd: '1000000.0000',
      stockValueIqd: '1005000.0000',
      departedIqd: '0.0000',
      consumedIqd: '0.0000',
      unexplainedIqd: '0.0000',
    });

    // The import page's figures, from the function it reads today, are the same.
    const before = await read((tx) => landed.finalCost(tx, payableId));
    expect(before).toHaveLength(1);
    const { purchaseValueIqd: _p, stockValueIqd: _s, departedIqd: _d, consumedIqd: _c, unexplainedIqd: _u, ...same } = row!;
    expect(same).toEqual(before[0]);

    // …and the Warehouses Report holds the same value.
    const valuation = await read((tx) => inventoryReports.valuation(tx, world.manager.principal, {}));
    const panel = valuation.find((entry) => entry.itemCode === PANEL && entry.warehouseCode === WAREHOUSE);
    expect(iqd(panel!.valueIqd.replace(/(\.\d{4})\d*$/, '$1'))).toBe(iqd(row!.finalValueIqd));

    // The trace: the purchase behind each received layer, the lock, its charges.
    const result = await trace();
    expect(result.payableNo).toMatch(/\S/);
    expect(result.models).toHaveLength(1);
    const [model] = result.models;
    expect(model!.totals).toEqual(row);
    expect(model!.layers).toHaveLength(2);
    for (const layer of model!.layers) {
      expect(layer).toMatchObject({
        receivedQty: '50',
        onHandQty: '50',
        chargesIqd: '2500.0000',
        finalUnitIqd: '10050.0000',
        unitCostChain: ['10000.0000', '10050.0000'],
        unitCostChainText: '10,000 → 10,050',
        layerUnitCostChainText: '10,000 → 10,050',
        departures: [],
      });
      expect(layer.purchase).toMatchObject({
        unitIqd: '10000.0000',
        valueIqd: '500000.0000',
        unitFrom: 'lock',
        invoice: { invoiceNo },
        // Derived, not read: the invoice line holds dinars.
        agreed: { currency: 'USD', rate: '1250.00000000', derivedUnitTxn: '8.0000', derivedValueTxn: '400.0000' },
      });
      // Followed by fact once relocations name their origin (0280); by the
      // transfer pair of the same receipt line before that.
      expect(['origin_layer', 'paired_transfer']).toContain(layer.purchase.invoice!.foundBy);
      expect(layer.lineage).toEqual([
        expect.objectContaining({ layerId: layer.layerId, parentLayerId: null, link: 'received', remainingQty: '50', unitCostIqd: '10050.0000' }),
      ]);
      const [step] = layer.locks;
      expect(step).toMatchObject({
        lockNo: `${result.payableNo}/1`,
        sequence: 1,
        lockDate: '2026-08-30',
        basisCode: 'by_value',
        allocatedIqd: '2500.0000',
        ownAllocatedIqd: '2500.0000',
        followedIqd: '0.0000',
        unitCostBeforeIqd: '10000.0000',
        unitCostAfterIqd: '10050.0000',
        unitChangeIqd: '50.0000',
        addedPerReceivedUnitIqd: '50.0000',
        landedUnitAfterIqd: '10050.0000',
        followed: [],
      });
      expect(step!.entryNo).toMatch(/\S/);
      // 2,500 over freight 3,000 : duty 2,000.
      expect(step!.chargeTypes).toEqual([
        {
          chargeTypeCode: 'customs_asycuda',
          chargeTypeName: expect.any(String),
          amountIqd: '2000.0000',
          sources: [{ sourceType: 'journal_entry', sourceNo: duty, amountIqd: '2000.0000' }],
          layerShareIqd: '1000.0000',
        },
        {
          chargeTypeCode: 'freight',
          chargeTypeName: expect.any(String),
          amountIqd: '3000.0000',
          sources: [{ sourceType: 'journal_entry', sourceNo: freight, amountIqd: '3000.0000' }],
          layerShareIqd: '1500.0000',
        },
      ]);
    }
    expect(result.locks).toEqual([
      expect.objectContaining({
        lockNo: `${result.payableNo}/1`,
        totalIqd: '5000.0000',
        reconciliation: expect.objectContaining({
          totalIqd: '5000.0000',
          chargesIqd: '5000.0000',
          inventoryIqd: '5000.0000',
          departureIqd: '0.0000',
          roundingIqd: '0.0000',
          recordedInventoryIqd: '5000.0000',
          recordedDepartedIqd: '0.0000',
        }),
      }),
    ]);
    expectAccountedFor(result);
  });

  it('three locks on the same layers: the chain of unit costs, and each lock’s charges split by largest remainder', async () => {
    await charge('freight', '12000');
    await charge('customs_asycuda', '8000');
    await writeOffPd();
    await lock({ basisCode: 'by_value' }); // 20,000: +200 a panel
    await charge('port_forwarding', '10000');
    await lock({ basisCode: 'by_quantity', lockDate: '2026-09-05' }); // 10,000: +100
    // 10,000 in three nearly equal parts: each layer's 5,000 splits 1,666.66665
    // / 1,666.66665 / 1,666.6667 — the tie's odd 0.0001 to the earlier type.
    await charge('freight', '3333.3333');
    await charge('customs_asycuda', '3333.3333');
    await charge('other', '3333.3334', 'Fumigation certificate');
    await lock({ basisCode: 'by_quantity', lockDate: '2026-09-10' }); // 10,000: +100

    const [row] = await finalCost();
    expect(row).toMatchObject({
      receivedQty: '100',
      onHandQty: '100',
      invoicedUnitIqd: '10000.0000',
      chargesUnitIqd: '400.0000',
      finalUnitIqd: '10400.0000',
      chargesIqd: '40000.0000',
      finalValueIqd: '1040000.0000',
      purchaseValueIqd: '1000000.0000',
    });
    const before = await read((tx) => landed.finalCost(tx, payableId));
    expect(before[0]).toMatchObject({ finalUnitIqd: '10400.0000', chargesIqd: '40000.0000' });

    const result = await trace();
    const layers = result.models[0]!.layers;
    expect(layers).toHaveLength(2);
    for (const layer of layers) {
      // The chain is per received unit and the layer's own: nothing left, so they agree.
      expect(layer.unitCostChainText).toBe('10,000 → 10,200 → 10,300 → 10,400');
      expect(layer.layerUnitCostChainText).toBe('10,000 → 10,200 → 10,300 → 10,400');
      expect(layer.locks.map((step) => [step.sequence, step.allocatedIqd, step.unitChangeIqd, step.addedPerReceivedUnitIqd])).toEqual([
        [1, '10000.0000', '200.0000', '200.0000'],
        [2, '5000.0000', '100.0000', '100.0000'],
        [3, '5000.0000', '100.0000', '100.0000'],
      ]);
      const split = (sequence: number) =>
        layer.locks
          .find((step) => step.sequence === sequence)!
          .chargeTypes.map((type) => [type.chargeTypeCode, type.layerShareIqd]);
      expect(split(1)).toEqual([
        ['customs_asycuda', '4000.0000'],
        ['freight', '6000.0000'],
      ]);
      expect(split(2)).toEqual([['port_forwarding', '5000.0000']]);
      expect(split(3)).toEqual([
        ['customs_asycuda', '1666.6667'],
        ['freight', '1666.6666'],
        ['other', '1666.6667'],
      ]);
      for (const step of layer.locks) {
        const shares = step.chargeTypes.reduce((sum, type) => sum + iqd(type.layerShareIqd), 0n);
        expect(shares).toBe(iqd(step.allocatedIqd));
      }
    }
    expect(result.locks.map((entry) => [entry.sequence, entry.totalIqd, entry.chargeTypes.map((type) => type.chargeTypeCode)])).toEqual([
      [1, '20000.0000', ['customs_asycuda', 'freight']],
      [2, '10000.0000', ['port_forwarding']],
      [3, '10000.0000', ['customs_asycuda', 'freight', 'other']],
    ]);
    expectAccountedFor(result);
  });

  it('stock moved on before the lock: on hand wherever it stands, and none of its charges lost (A1, A2, A3)', async () => {
    const [first, second] = await receivedLayers();
    // All fifty of the second layer to Erbil, ten of the first.
    await transfer(second!, '50', 'TRF-LC03-1');
    await transfer(first!, '10', 'TRF-LC03-2');
    await charge('freight', '5000');
    await writeOffPd();
    const done = await lock({ basisCode: 'by_value' });
    // Moved stock is stock: everything restated, nothing to cost of sales.
    expect([done.totalIqd, done.inventoryIqd, done.cogsIqd]).toEqual(['5000.0000', '5000.0000', '0.0000']);

    const [row] = await finalCost();
    expect(row).toEqual({
      itemCode: PANEL,
      receivedQty: '100',
      // 40 in the main store, 10 + 50 in Erbil (A2: not 40).
      onHandQty: '100',
      invoicedUnitIqd: '10000.0000',
      // The emptied layer's 2,500 counted (A1: not 25 a unit).
      chargesUnitIqd: '50.0000',
      finalUnitIqd: '10050.0000',
      chargesIqd: '5000.0000',
      // Remaining × cost wherever it stands (A3).
      finalValueIqd: '1005000.0000',
      purchaseValueIqd: '1000000.0000',
      stockValueIqd: '1005000.0000',
      departedIqd: '0.0000',
      // A transfer within the lineage is neither consumed nor new.
      consumedIqd: '0.0000',
      unexplainedIqd: '0.0000',
    });

    // The Warehouses Report, across both stores, holds the same value.
    const valuation = await read((tx) =>
      inventoryReports.valuation(tx, world.manager.principal, { itemCode: PANEL, allPermittedBranches: true }),
    );
    const held = valuation
      .filter((entry) => entry.warehouseCode === WAREHOUSE || entry.warehouseCode === SECOND)
      .reduce((sum, entry) => sum + iqd(entry.valueIqd.replace(/(\.\d{4})\d*$/, '$1')), 0n);
    expect(held).toBe(iqd(row!.finalValueIqd));

    const result = await trace();
    const [one, two] = result.models[0]!.layers;
    // The first: forty stayed, ten went on — its share split between them.
    expect(one).toMatchObject({ layerId: first, onHandQty: '50', chargesIqd: '2500.0000', unitCostChainText: '10,000 → 10,050' });
    expect(one!.lineage.map((layer) => [layer.link, layer.warehouseCode, layer.remainingQty, layer.unitCostIqd])).toEqual([
      ['received', WAREHOUSE, '40', '10050.0000'],
      // The transfer wrote the fact (0285 origin_layer_id): followed by it, not by the lock's own note.
      ['origin_layer', SECOND, '10', '10050.0000'],
    ]);
    expect(one!.locks[0]).toMatchObject({
      allocatedIqd: '2500.0000',
      ownAllocatedIqd: '2000.0000',
      followedIqd: '500.0000',
      unitChangeIqd: '50.0000',
      followed: [expect.objectContaining({ warehouseCode: SECOND, viaLayerId: first, allocatedIqd: '500.0000', inventoryIqd: '500.0000' })],
    });
    // The second: emptied before the lock, so its own unit cost never moved —
    // but every unit it received cost 50 more, now standing in Erbil.
    expect(two).toMatchObject({
      layerId: second,
      receivedQty: '50',
      onHandQty: '50',
      chargesIqd: '2500.0000',
      finalUnitIqd: '10050.0000',
      unitCostChainText: '10,000 → 10,050',
      layerUnitCostChainText: '10,000 → 10,000',
    });
    expect(two!.locks[0]).toMatchObject({
      allocatedIqd: '2500.0000',
      ownAllocatedIqd: '0.0000',
      followedIqd: '2500.0000',
      unitCostBeforeIqd: null,
      unitChangeIqd: null,
      addedPerReceivedUnitIqd: '50.0000',
      followed: [expect.objectContaining({ warehouseCode: SECOND, viaLayerId: second, onHandQty: '50', unitCostAfterIqd: '10050.0000' })],
    });
    expect(two!.lineage.map((layer) => [layer.link, layer.warehouseCode, layer.remainingQty])).toEqual([
      ['received', WAREHOUSE, '0'],
      ['origin_layer', SECOND, '50'],
    ]);
    expectAccountedFor(result);
  });

  it('nothing received: no final cost, an empty trace; received but not locked: the purchase alone', async () => {
    const made = await withScope(scope(world.clerk), (tx) =>
      ap.create(tx, world.clerk, {
        supplierId: world.supplierId,
        supplierInvoiceNo: 'CSA-LC03-0002',
        branchCode: BAGHDAD,
        invoiceDate: '2026-07-03',
        dueDate: '2026-09-03',
        isImport: true,
        lines: [
          {
            itemCode: PANEL,
            description: 'Solar Panel 550W',
            quantity: q('5'),
            unitPriceIqd: iqd('10000'),
            uomCode: 'EA',
            isInventory: true,
            warehouseCode: WAREHOUSE,
          },
        ],
      }),
    );
    await withScope(scope(world.clerk), (tx) => ap.submit(tx, world.clerk, made.id));
    await withScope(scope(world.manager), (tx) => ap.post(tx, world.manager, made.id));
    const { rows } = await ownerPool.query(`select payable_id from ap_invoice where id = $1`, [made.id]);
    const other = rows[0].payable_id as string;
    expect(other).not.toBe(payableId);
    expect(await read((tx) => finalCosts.finalCost(tx, other))).toEqual([]);
    expect(await read((tx) => finalCosts.finalCostTrace(tx, other))).toMatchObject({ payableId: other, models: [], locks: [] });

    // This import, received but not locked: the trace shows the purchase, no lock.
    expect(await finalCost()).toEqual([]);
    const result = await trace();
    expect(result.locks).toEqual([]);
    expect(result.models[0]!.layers.map((layer) => [layer.purchase.unitFrom, layer.unitCostChainText, layer.locks.length])).toEqual([
      ['layer', '10,000', 0],
      ['layer', '10,000', 0],
    ]);
  });

  /*
   * Stock that had left before a lock. The departure engine (writing
   * `landed_cost_departure`) is built in parallel; until it is merged a lock
   * with a departed share is refused at commit by 0280's deferred check, so
   * these are written once it is in.
   */
  it.todo('a layer sold out before the lock (50 sold, 5,000 of charges) shows 100 a received unit, not 0 (A1), departed under delivery → cost of sales with the AR invoice number');
  it.todo('three locks after part of the stock was sold: 150 a received unit, not 130 (A1), and each lock reconciles with its departure rows');
  it.todo('a project material issue before the lock: the Material Issue number and the transaction type are shown, never the project code or the WBS element');
  it.todo('a sales return after the lock: the return layer is in the lineage (on hand), the return row sits beside its departure, departed is net of it, nothing unexplained');
  it.todo('a goods return, a write-off and an Item Reconciliation before the lock: grouped by movement kind and destination role with their document numbers');
  it.todo('a rounding residue with no movement behind it is its own group and counts in the lock’s reconciliation');
  it.todo('a transfer after the last lock is followed by cost_layer.origin_layer_id: on hand and value include it, nothing unexplained');
  it.todo('a lock written before 0280 (cost of sales, no departure rows): unattributed in its reconciliation, counted as departed in the model');
});
