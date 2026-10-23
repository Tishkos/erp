/**
 * Imports paid after the goods arrive (0426, 2026-10-24, by direction: "import
 * application payment after import … like the whole import is done then";
 * "a button where we skip … the current import which pays later … for
 * creating new import and in existing application"; "add filter for them").
 *
 *   PAL1  an invoice ticked "Pay after the goods arrive" opens an import that
 *         is paid after arrival; posting it holds no goods and raises no
 *         advance; asking an advance on it is refused.
 *   PAL2  the sweep runs no payment clock for it until every container is
 *         received, then from the day the last one came in; an ordinary
 *         import is stopped as before.
 *   PAL3  switched on for an import held for its advance: the goods move to In
 *         Process, its payment-clock stop is resolved with the reason, the log
 *         and the audit say who and why; switched off again it is ordinary.
 *   PAL4  the register's Payment timing filter.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, rejection } from './setup';
import { withScope } from '@/server/db/client';
import { registerAllRecords } from '@/server/records';
import * as ap from '@/server/services/ap-invoice';
import * as payables from '@/server/services/payables';
import * as payAfterArrival from '@/server/services/pay-after-arrival';
import * as shipments from '@/server/services/shipments';
import * as sweep from '@/server/services/payables-sweep';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

const IN_PROCESS = 'WH-PAL-INPROC';
const HOLD = 'WH-PAL-NOSWIFT';
const SWIFT = 'PAL-SWIFT';
let world: TradingWorld;

const iqd = (value: string) => parseDecimal(value, 4n);
const q = (value: string) => parseQuantity(value);

async function importInvoice(reference: string, extra: Partial<ap.CreateApInvoiceInput> = {}) {
  const made = await withScope(scope(world.clerk), (tx) =>
    ap.create(tx, world.clerk, {
      supplierId: world.supplierId,
      supplierInvoiceNo: reference,
      branchCode: BAGHDAD,
      invoiceDate: '2026-09-01',
      dueDate: '2026-11-01',
      isImport: true,
      lines: [{ itemCode: PANEL, description: 'Solar Panel 550W', quantity: q('100'), unitPriceIqd: iqd('10000'), uomCode: 'EA', isInventory: true, warehouseCode: WAREHOUSE }],
      ...extra,
    } as ap.CreateApInvoiceInput),
  );
  const { rows } = await ownerPool.query(`select payable_id from ap_invoice where id = $1`, [made.id]);
  return { invoiceId: made.id, payableId: rows[0].payable_id as string };
}

const withAdvance = { advancePercent: '20', advancePaymentMethodCode: SWIFT } as const;

/** Posted, and dated 1 September so the sweep's clocks do not depend on the day the suite runs. */
async function post(invoiceId: string) {
  await withScope(scope(world.clerk), (tx) => ap.submit(tx, world.clerk, invoiceId));
  await withScope(scope(world.manager), (tx) => ap.post(tx, world.manager, invoiceId));
  await ownerPool.query(`update ap_invoice set posted_at = '2026-09-01T09:00:00+03:00' where id = $1`, [invoiceId]);
}

const held = async (warehouseCode: string) =>
  (await ownerPool.query(`select coalesce(sum(held), 0)::numeric(19,6)::text as n from stock_position where item_code = $1 and warehouse_code = $2`, [PANEL, warehouseCode])).rows[0].n as string;

const log = async (payableId: string) =>
  (await ownerPool.query(`select event_code, summary from payable_event where payable_id = $1 order by recorded_at`, [payableId])).rows as { event_code: string; summary: string }[];

const stops = async (payableId: string, check: string) =>
  (await ownerPool.query(`select status, resolution from payable_hold where payable_id = $1 and check_code = $2 order by created_at`, [payableId, check])).rows as {
    status: string;
    resolution: string | null;
  }[];

const runSweep = (asOf: string) =>
  withScope({ userId: world.manager.principal.userId, branchCode: BAGHDAD, isSuperUser: true }, (tx) => sweep.runSweep(tx, asOf));

const setPayLater = (payableId: string, on: boolean, reason: string) =>
  withScope(scope(world.clerk), (tx) => payAfterArrival.setPayAfterArrival(tx, world.clerk, { payableId, on, reason }));

async function blAndContainer(payableId: string) {
  await withScope(scope(world.clerk), (tx) =>
    shipments.createBl(tx, world.clerk, {
      payableId,
      blNo: `MEDU${randomUUID().slice(0, 6)}`,
      blDate: '2026-09-20',
      eta: '2026-10-25',
      portOfDischargeCode: 'PRT-0001',
      containers: 'MSCU1234566',
      spreadLines: true,
    }),
  );
  const { rows } = await ownerPool.query(
    `select c.id, l.id as line_id from shipment_container c join shipment_container_line l on l.container_id = c.id and l.superseded_at is null where c.payable_id = $1`,
    [payableId],
  );
  return { containerId: rows[0].id as string, lineId: rows[0].line_id as string };
}

const receive = (containerId: string, lineId: string, receiptDate: string) =>
  withScope(scope(world.clerk), (tx) =>
    shipments.receive(tx, world.clerk, {
      documentId: randomUUID(),
      containerId,
      warehouseCode: WAREHOUSE,
      receiptDate,
      lines: [{ containerLineId: lineId, receivedQty: q('100'), damagedQty: q('0') }],
      varianceReason: null,
    }),
  );

beforeEach(async () => {
  registerAllRecords();
  world = await buildTradingWorld();
  await ownerPool.query(
    `insert into warehouse (code, name, branch_code, warehouse_type, is_transit, shipment_stage) values
       ($1,'In Process',$3,'transit',true,'in_process'),
       ($2,'On Process (Without SWIFT)',$3,'transit',true,'without_swift')`,
    [IN_PROCESS, HOLD, BAGHDAD],
  );
  await ownerPool.query(`insert into payment_method (code, name, kind, confirmation_kind) values ($1,'SWIFT transfer','bank','swift')`, [SWIFT]);
});

describe('PAL1 · an import opened to be paid after its goods arrive', () => {
  it('is flagged from the invoice, holds nothing at posting and raises no advance', async () => {
    const { invoiceId, payableId } = await importInvoice('PAL1-0001', { payAfterArrival: true });
    const row = await withScope(scope(world.clerk), (tx) => payables.load(tx, payableId));
    expect(row.payAfterArrival).toBe(true);
    expect(row.payAfterArrivalSetBy).toBe(world.clerk.principal.userId);
    expect(row.payAfterArrivalReason).toBe(payables.PAY_AFTER_ARRIVAL_AT_BIRTH);
    expect((await log(payableId)).map((line) => line.event_code)).toContain('PAY_AFTER_ARRIVAL_SET');

    await post(invoiceId);
    expect(await held(HOLD)).toBe('0.000000');
    expect(await held(IN_PROCESS)).toBe('100.000000');
    const { rows } = await ownerPool.query(`select count(*)::int as n from payment_application where payable_id = $1`, [payableId]);
    expect(rows[0].n).toBe(0);
  });

  it('refuses an advance asked on it — ticked on the invoice, or on an invoice joining it', async () => {
    const asked = await rejection(
      importInvoice('PAL1-0002', { payAfterArrival: true, ...withAdvance, advancePaidFromAccountId: world.bankAccountId }),
    );
    expect(asked).toMatch(/paid after the goods arrive, so its invoice asks no advance/);

    const { payableId } = await importInvoice('PAL1-0003', { payAfterArrival: true });
    const joined = await rejection(
      importInvoice('PAL1-0004', { payableId, ...withAdvance, advancePaidFromAccountId: world.bankAccountId }),
    );
    expect(joined).toMatch(/IMP-.* is paid after the goods arrive/);
  });

  it('only an import is paid after its goods arrive (the database holds it too)', async () => {
    const { payableId } = await importInvoice('PAL1-0005');
    const refused = await rejection(
      ownerPool.query(`update payable set pay_after_arrival = true where id = $1`, [payableId]),
    );
    expect(refused).toMatch(/payable_pay_after_arrival_named/);
  });
});

describe('PAL2 · the sweep runs no payment clock until the goods are in', () => {
  it('no stop while on its way; once received, the clock runs from the day the last container came in', async () => {
    const later = await importInvoice('PAL2-0001', { payAfterArrival: true });
    await post(later.invoiceId);
    const ordinary = await importInvoice('PAL2-0002');
    await post(ordinary.invoiceId);

    // Seven days is the seeded limit for an invoice posted and not funded; 1 September + 7 is long gone.
    await runSweep('2026-10-20');
    expect(await stops(ordinary.payableId, 'invoice_unfunded')).toHaveLength(1);
    expect(await stops(later.payableId, 'invoice_unfunded')).toHaveLength(0);

    const { containerId, lineId } = await blAndContainer(later.payableId);
    await receive(containerId, lineId, '2026-10-28');
    // Received on 28 October: five days later the clock is within its limit…
    await runSweep('2026-11-02');
    expect(await stops(later.payableId, 'invoice_unfunded')).toHaveLength(0);
    // …and past it a stop opens, counted from the arrival.
    await runSweep('2026-11-10');
    expect(await stops(later.payableId, 'invoice_unfunded')).toHaveLength(1);
  });
});

describe('PAL3 · switched on for an import already on its way', () => {
  it('releases the goods held for the advance, resolves the payment-clock stop, and can be switched off again', async () => {
    const { invoiceId, payableId } = await importInvoice('PAL3-0001', { ...withAdvance, advancePaidFromAccountId: world.bankAccountId });
    await post(invoiceId);
    expect(await held(HOLD)).toBe('100.000000');
    await runSweep('2026-10-20');
    expect(await stops(payableId, 'invoice_unfunded')).toEqual([{ status: 'open', resolution: null }]);

    const done = await setPayLater(payableId, true, 'Supplier agreed to be paid on arrival');
    expect(done.holdsResolved).toBe(1);
    expect(await held(HOLD)).toBe('0.000000');
    expect(await held(IN_PROCESS)).toBe('100.000000');
    expect(await stops(payableId, 'invoice_unfunded')).toEqual([
      { status: 'resolved', resolution: 'Paid after the goods arrive — Supplier agreed to be paid on arrival' },
    ]);
    const lines = await log(payableId);
    expect(lines.map((line) => line.event_code)).toEqual(expect.arrayContaining(['PAY_AFTER_ARRIVAL_SET', 'ADVANCE_RELEASED', 'HOLD_RESOLVED']));
    expect(lines.find((line) => line.event_code === 'ADVANCE_RELEASED')!.summary).toMatch(/without a payment: Supplier agreed/);
    const { rows: audits } = await ownerPool.query(
      `select action, after_value->>'reason' as reason from audit_event where object_id = $1 and action like 'payable.pay_after_arrival%'`,
      [payableId],
    );
    expect(audits).toEqual([{ action: 'payable.pay_after_arrival_set', reason: 'Supplier agreed to be paid on arrival' }]);

    // The sweep leaves it alone now; the advance application it raised still stands, nothing was cancelled.
    await runSweep('2026-10-21');
    expect((await stops(payableId, 'invoice_unfunded')).filter((stop) => stop.status === 'open')).toHaveLength(0);

    // Twice is refused; off again it is an ordinary import, and the goods stay where they are.
    expect(await rejection(setPayLater(payableId, true, 'again'))).toMatch(/already paid after the goods arrive/);
    expect(await rejection(setPayLater(payableId, false, '  '))).toMatch(/Say why/);
    await setPayLater(payableId, false, 'Supplier wants the deposit after all');
    const row = await withScope(scope(world.clerk), (tx) => payables.load(tx, payableId));
    expect(row).toMatchObject({ payAfterArrival: false, payAfterArrivalSetBy: null, payAfterArrivalReason: null });
    expect(await held(IN_PROCESS)).toBe('100.000000');
    await runSweep('2026-10-22');
    expect((await stops(payableId, 'invoice_unfunded')).filter((stop) => stop.status === 'open')).toHaveLength(1);
  });
});

describe('PAL4 · the register’s Payment timing filter', () => {
  it('lists the imports paid after arrival, or the others', async () => {
    const later = await importInvoice('PAL4-0001', { payAfterArrival: true });
    const ordinary = await importInvoice('PAL4-0002');
    const list = (timing: 'before_arrival' | 'after_arrival') =>
      withScope(scope(world.clerk), (tx) => payables.workbench(tx, { typeCode: 'import', timing, pageSize: 100 }));
    const after = await list('after_arrival');
    expect(after.rows.map((row) => row.id)).toContain(later.payableId);
    expect(after.rows.map((row) => row.id)).not.toContain(ordinary.payableId);
    expect(after.rows.every((row) => row.payAfterArrival)).toBe(true);
    const before = await list('before_arrival');
    expect(before.rows.map((row) => row.id)).toContain(ordinary.payableId);
    expect(before.rows.map((row) => row.id)).not.toContain(later.payableId);
  });
});
