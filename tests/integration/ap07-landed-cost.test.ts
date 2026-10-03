/**
 * REQ-AP-001 Stage 7 — closing and the landed cost (§20.1, §20.2).
 *
 *   A18 (REQ-APP-001 A15)  The landed cost is locked only once every PD is
 *        totally written off; locking allocates the charges over the layers
 *        the containers created — the share still on hand restates the
 *        layer's unit cost (Dr Inventory), the share sold is cost of sales,
 *        the share moved on follows the stock — Cr the clearing account; a
 *        late charge is a dated adjustment, never an edit.
 *   A19 (REQ-APP-001 A16)  An import is cleared by nobody: the last of the
 *        three conditions stamps it (CLEARED, stage 8, read-only); when a
 *        condition stops holding it is re-opened with CORRECTION.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, rejection } from './setup';
import { withScope } from '@/server/db/client';
import * as ap from '@/server/services/ap-invoice';
import * as applications from '@/server/services/payment-applications';
import * as customs from '@/server/services/customs-pd';
import * as inventory from '@/server/services/inventory';
import * as landed from '@/server/services/landed-cost';
import * as payables from '@/server/services/payables';
import * as shipments from '@/server/services/shipments';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';
import { fundBank } from './hr-funds';

const IN_PROCESS = 'WH-AP07-INPROC';
const SECOND = 'WH-AP07-ERBIL';
const SWIFT = 'PM-T001';
let world: TradingWorld;
let invoiceId: string;
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
    const entryNo = `JV-AP07-${(serial += 1)}`;
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

const charge = (type: string, amount: string, reason: string | null = null) =>
  journal(world.accounts.landed_cost_clearing!, world.accounts.bank!, amount).then((entryNo) =>
    withScope(scope(world.clerk), (tx) =>
      landed.addCharge(tx, world.clerk, {
        payableId,
        chargeTypeCode: type,
        journalEntryNo: entryNo,
        amountIqd: iqd(amount),
        reason,
      }),
    ),
  );
const lock = (input: Partial<landed.LockInput> = {}) =>
  withScope(scope(world.manager), (tx) => landed.lock(tx, world.manager, { payableId, lockDate: '2026-10-30', ...input }));
const pdTo = (statusCode: string, on: string) =>
  withScope(scope(world.clerk), (tx) => customs.changeStatus(tx, world.clerk, pdId, { statusCode, effectiveDate: on }));
const codes = async () =>
  (
    await ownerPool.query(`select event_code from payable_event where payable_id = $1 order by recorded_at, id`, [payableId])
  ).rows.map((row) => row.event_code as string);

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

/** The layers the receipts created, oldest first, with the batch they carry. */
async function receiptLayers() {
  const { rows } = await ownerPool.query(
    `select cl.id, cl.warehouse_code, cl.remaining_quantity::text as remaining, cl.unit_cost_iqd::text as unit, m.batch_number
       from cost_layer cl join inventory_movement m on m.id = cl.created_by_movement_id
      where cl.item_code = $1 and cl.warehouse_code in ($2, $3)
      order by cl.warehouse_code desc, cl.layer_date, cl.sequence`,
    [PANEL, WAREHOUSE, SECOND],
  );
  return rows as { id: string; warehouse_code: string; remaining: string; unit: string; batch_number: string | null }[];
}

beforeEach(async () => {
  world = await buildTradingWorld();
  // C-20: the charges below are paid out of the bank, so it holds money first.
  await fundBank(world, '1000000.0000');
  await ownerPool.query(
    `insert into warehouse (code, name, branch_code, warehouse_type, is_transit, shipment_stage)
     values ($1,'In Process',$2,'transit',true,'in_process'), ($3,'Erbil Store',$2,'branch',false,null)`,
    [IN_PROCESS, BAGHDAD, SECOND],
  );
  // The clearing account the charges are parked on, mapped for the lock.
  const { rows: parent } = await ownerPool.query(`select id from chart_of_account where code = 'A000001'`);
  const { rows: clearing } = await ownerPool.query(
    `insert into chart_of_account (code, name, account_type, parent_id, is_group, is_active, approval_status, level, currency_restriction)
     values ('A970001','Landed Cost Clearing','asset',$1,false,true,'approved',1,'IQD') returning id`,
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
      supplierInvoiceNo: 'CSA-COST-0001',
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
  const { rows } = await ownerPool.query(`select payable_id from ap_invoice where id = $1`, [invoiceId]);
  payableId = rows[0].payable_id;
  await withScope(scope(world.clerk), (tx) => ap.submit(tx, world.clerk, invoiceId));
  await withScope(scope(world.manager), (tx) => ap.post(tx, world.manager, invoiceId));

  await withScope(scope(world.clerk), (tx) =>
    shipments.createBl(tx, world.clerk, {
      payableId,
      blNo: 'MEDUAP070001',
      blDate: '2026-09-20',
      eta: '2026-10-05',
      containers: 'MSCU1234566\nTGHU7654320',
      spreadLines: true,
    }),
  );
  await receiveAll();
  const pd = await withScope(scope(world.clerk), (tx) =>
    customs.register(tx, world.clerk, { payableId, pdNo: '6600', registrationDate: '2026-09-02', expiryDate: '2027-03-01' }),
  );
  pdId = pd.id;
  await pdTo('validated', '2026-09-05');
});

describe('A18 · the landed cost, locked', () => {
  it('waits for the PDs; then on hand restates the layer, sold is cost of sales, moved follows the stock', async () => {
    await charge('freight', '100000');
    await charge('customs_asycuda', '50000');
    expect(await rejection(lock())).toMatch(/every PD is totally written off/);

    // Ten sold from the oldest layer, ten of the second moved to Erbil.
    const [first, second] = await receiptLayers();
    await withScope(scope(world.manager), (tx) =>
      inventory.issue(tx, world.manager, {
        itemCode: PANEL,
        warehouseCode: WAREHOUSE,
        branchCode: BAGHDAD,
        quantity: q('10'),
        movementDate: '2026-10-15',
        kind: 'delivery',
        batchNumber: first!.batch_number,
        sourceDocumentType: 'test',
        sourceDocumentId: 'SALE-1',
      }),
    );
    await withScope(scope(world.manager), async (tx) =>
      inventory.relocate(tx, world.manager, {
        itemCode: PANEL,
        fromWarehouseCode: WAREHOUSE,
        toWarehouseCode: SECOND,
        branchCode: BAGHDAD,
        quantity: q('10'),
        movementDate: '2026-10-16',
        layers: (await inventory.layersOf(tx, PANEL, WAREHOUSE)).filter((layer) => layer.id === second!.id),
        sourceDocumentType: 'stock_transfer',
        sourceDocumentId: 'TRF-AP07-1',
        sourceLineId: '1',
      }),
    );

    await pdTo('totally_written_off', '2026-10-25');
    const done = await lock({ basisCode: 'by_value' });
    expect([done.sequence, done.totalIqd, done.inventoryIqd, done.cogsIqd]).toEqual([1, '150000.0000', '135000.0000', '15000.0000']);

    // Every PANEL layer that carries the import's stock now costs 11,500.
    const layers = await receiptLayers();
    expect(layers.map((layer) => [layer.warehouse_code, layer.remaining, layer.unit])).toEqual([
      [WAREHOUSE, '40.000000', '11500.0000'],
      [WAREHOUSE, '40.000000', '11500.0000'],
      [SECOND, '10.000000', '11500.0000'],
    ]);

    const { rows: lines } = await ownerPool.query(
      `select l.line_role, l.warehouse_code, l.debit_iqd::text as debit, l.credit_iqd::text as credit
         from journal_line l where l.journal_entry_id = $1 order by l.line_no`,
      [done.journalEntryId],
    );
    expect(lines).toEqual([
      { line_role: 'inventory', warehouse_code: WAREHOUSE, debit: '120000.0000', credit: '0.0000' },
      { line_role: 'cogs', warehouse_code: null, debit: '15000.0000', credit: '0.0000' },
      { line_role: 'inventory', warehouse_code: SECOND, debit: '15000.0000', credit: '0.0000' },
      { line_role: 'landed_cost_clearing', warehouse_code: null, debit: '0.0000', credit: '150000.0000' },
    ]);
    const { rows: charges } = await ownerPool.query(
      `select count(*) filter (where lock_id is not null)::int as locked from landed_cost_charge where payable_id = $1`,
      [payableId],
    );
    expect(charges[0].locked).toBe(2);
    const log = await codes();
    expect(log).toContain('LANDED_COST_LOCKED');
    expect(log).toContain('ITEM_COST_ALLOCATED');

    // A charge after the lock is a dated adjustment, by quantity this time.
    expect(await rejection(lock())).toMatch(/already in its landed cost/);
    await charge('port_forwarding', '20000');
    const adjustment = await lock({ basisCode: 'by_quantity', lockDate: '2026-11-05' });
    expect([adjustment.sequence, adjustment.totalIqd]).toEqual([2, '20000.0000']);
    const { rows: adjusted } = await ownerPool.query(
      `select count(*)::int as n from landed_cost_layer_adjustment where lock_id = $1`,
      [adjustment.id],
    );
    expect(adjusted[0].n).toBe(3);
    // Locks and their adjustments are never rewritten.
    expect(
      await rejection(ownerPool.query(`update landed_cost_lock set total_iqd = 1 where id = $1`, [done.id])),
    ).toMatch(/append-only|not allowed|immutable|reject/i);
  });

  it('allocates manually per model, and refuses amounts that do not add up', async () => {
    await charge('freight', '30000');
    await pdTo('totally_written_off', '2026-10-25');
    expect(
      await rejection(lock({ basisCode: 'manual', manual: new Map([[PANEL, iqd('29000')]]) })),
    ).toMatch(/add up to 29,000\.00 IQD.*30,000\.00 IQD/);
    const done = await lock({ basisCode: 'manual', manual: new Map([[PANEL, iqd('30000')]]) });
    // Nothing sold: all of it stays in stock, 300 IQD a panel on 100.
    expect([done.inventoryIqd, done.cogsIqd]).toEqual(['30000.0000', '0.0000']);
    expect((await receiptLayers()).map((layer) => layer.unit)).toEqual(['10300.0000', '10300.0000']);
  });

  it('a charge comes from a posted document: `other` says why; the goods are not a charge; an unlocked one may be withdrawn', async () => {
    const entryNo = await journal(world.accounts.landed_cost_clearing!, world.accounts.bank!, '5000');
    const add = (type: string, reason: string | null = null, journalNo = entryNo) =>
      withScope(scope(world.clerk), (tx) =>
        landed.addCharge(tx, world.clerk, { payableId, chargeTypeCode: type, journalEntryNo: journalNo, amountIqd: iqd('5000'), reason }),
      );
    expect(await rejection(add('other'))).toMatch(/Say what an "other" charge is/);
    expect(await rejection(add('purchase'))).toMatch(/the goods themselves/);
    expect(await rejection(add('freight', null, 'JV-NOPE'))).toMatch(/No journal JV-NOPE/);
    const made = await add('other', 'Fumigation certificate');
    expect(await rejection(add('freight'))).toMatch(/duplicate|unique/i);
    await withScope(scope(world.manager), (tx) => landed.cancelCharge(tx, world.manager, made.id, 'Entered on the wrong import'));
    expect((await codes()).filter((code) => code === 'CHARGE_RECORDED')).toHaveLength(1);
    await add('freight');
  });
});

describe('A19 · cleared by nobody, re-opened with a reason', () => {
  it('the last condition clears it; a cleared import is read-only; a lost condition re-opens it', async () => {
    // Paid in full: one SWIFT for the whole invoice, confirmed.
    await ownerPool.query(`insert into payment_method (code, name, kind, confirmation_kind) values ($1,'SWIFT','bank','swift')`, [SWIFT]);
    const { rows: payee } = await ownerPool.query(
      `insert into partner_bank_account (partner_id, bank_name, account_number, swift, currency, approval_status, is_active)
       values ($1,'Bank of China','CN-1','BKCHCNBJ','IQD','approved',true) returning id`,
      [world.supplierId],
    );
    await journal(world.accounts.bank!, world.accounts.grni!, '5000000', '2026-09-01');
    const app = await withScope(scope(world.clerk), (tx) =>
      applications.create(tx, world.clerk, {
        payableId,
        paymentMethodCode: SWIFT,
        bankCashAccountId: world.bankAccountId,
        payeeBankAccountId: payee[0].id,
        amountTxn: iqd('1000000'),
        onDate: '2026-10-01',
      }),
    );
    await withScope(scope(world.manager), (tx) => applications.approve(tx, world.manager, app.id));
    await withScope(scope(world.clerk), (tx) =>
      applications.send(tx, world.clerk, app.id, { applicationDate: '2026-10-01', bankReference: 'B-1', overrideReason: null }),
    );
    await withScope(scope(world.manager), (tx) =>
      applications.confirm(tx, world.manager, app.id, { confirmedOn: '2026-10-03', reference: 'MT103-AP07' }),
    );
    const before = await withScope(scope(world.manager), (tx) => payables.load(tx, payableId));
    expect(before.closedAt).toBeNull();

    // The PD written off is the last condition: cleared in its transaction.
    await pdTo('totally_written_off', '2026-10-25');
    const after = await withScope(scope(world.manager), (tx) => payables.load(tx, payableId));
    expect(after.stageCode).toBe('cleared');
    expect(after.closedAt).not.toBeNull();
    expect(await codes()).toContain('CLEARED');
    expect(
      await rejection(
        withScope(scope(world.clerk), (tx) =>
          applications.create(tx, world.clerk, {
            payableId,
            paymentMethodCode: SWIFT,
            bankCashAccountId: world.bankAccountId,
            amountTxn: iqd('1'),
          }),
        ),
      ),
    ).toMatch(/cleared/);

    // A condition stops holding (the PD standing again): re-opened, with why.
    await ownerPool.query(`update customs_pd set status_code = 'validated' where id = $1`, [pdId]);
    await withScope(scope(world.manager), (tx) => payables.recomputeStage(tx, payableId, world.manager.principal.userId));
    const reopened = await withScope(scope(world.manager), (tx) => payables.load(tx, payableId));
    expect(reopened.closedAt).toBeNull();
    const { rows } = await ownerPool.query(
      `select summary from payable_event where payable_id = $1 and event_code = 'CORRECTION'`,
      [payableId],
    );
    expect(rows.map((row) => row.summary)).toEqual([expect.stringMatching(/re-opened: a PD is no longer totally written off/)]);
    // …and the clearing stays in the story.
    expect((await codes()).filter((code) => code === 'CLEARED')).toHaveLength(1);
  });
});
