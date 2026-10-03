/**
 * IMPROVEMENT-002 — the B/L, written properly (sponsor, 2026-10-03).
 *
 *   table    Containers are rows: each its number (ISO 6346, check digit
 *            refused when wrong), its own size/type and seal, and what it
 *            carries of each model — typed, or divided when a model is left
 *            empty; never more than was ordered. The ETA is required.
 *   correct  A B/L's boxes are corrected while nothing on it is received; a
 *            container's number, size/type and seal likewise.
 *   cancel   A B/L or a container entered by mistake is cancelled with its
 *            reason (never deleted), and the B/L number may be entered again.
 *   report   What arrived short or damaged is listed as an exception; the B/L
 *            prints.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, rejection } from './setup';
import { withScope } from '@/server/db/client';
import * as ap from '@/server/services/ap-invoice';
import * as shipments from '@/server/services/shipments';
import * as shipmentPrint from '@/server/print/shipment-documents';
import { messagesFor } from '@/server/print/i18n';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

const IN_PROCESS = 'WH-IM2B-INPROC';
let world: TradingWorld;
let invoiceId: string;
let payableId: string;
let lineId: string;

const q = (value: string) => parseQuantity(value);

async function importOf(quantity: string) {
  const made = await withScope(scope(world.clerk), (tx) =>
    ap.create(tx, world.clerk, {
      supplierId: world.supplierId,
      supplierInvoiceNo: `BL-${randomUUID().slice(0, 6)}`,
      branchCode: BAGHDAD,
      invoiceDate: '2026-09-01',
      dueDate: '2026-11-01',
      isImport: true,
      lines: [{ itemCode: PANEL, description: 'Solar Panel 550W', quantity: q(quantity), unitPriceIqd: parseDecimal('10000', 4n), uomCode: 'EA', isInventory: true, warehouseCode: WAREHOUSE }],
    }),
  );
  const { rows } = await ownerPool.query(`select payable_id from ap_invoice where id = $1`, [made.id]);
  const { rows: lines } = await ownerPool.query(`select id from payable_order_line where payable_id = $1 and superseded_at is null`, [rows[0].payable_id]);
  return { invoiceId: made.id, payableId: rows[0].payable_id as string, lineId: lines[0].id as string };
}

async function postInvoice() {
  await withScope(scope(world.clerk), (tx) => ap.submit(tx, world.clerk, invoiceId));
  await withScope(scope(world.manager), (tx) => ap.post(tx, world.manager, invoiceId));
}

const bl = (blNo: string, rows: shipments.ContainerRowInput[], extra: Partial<shipments.CreateBlInput> = {}) =>
  withScope(scope(world.clerk), (tx) =>
    shipments.createBl(tx, world.clerk, { payableId, blNo, blDate: '2026-09-20', eta: '2026-10-25', portOfDischargeCode: 'PRT-0001', containerRows: rows, ...extra }),
  );
const containersOf = async () =>
  (
    await ownerPool.query(
      `select c.id, c.container_no, c.size_type, c.seal_no, c.eta::text as eta, c.cancelled_at is not null as cancelled,
              coalesce((select sum(l.planned_qty) from shipment_container_line l where l.container_id = c.id and l.superseded_at is null), 0)::text as planned
         from shipment_container c where c.payable_id = $1 order by c.container_no`,
      [payableId],
    )
  ).rows as { id: string; container_no: string; size_type: string | null; seal_no: string | null; eta: string; cancelled: boolean; planned: string }[];

beforeEach(async () => {
  world = await buildTradingWorld();
  await ownerPool.query(
    `insert into warehouse (code, name, branch_code, warehouse_type, is_transit, shipment_stage) values ($1,'In Process',$2,'transit',true,'in_process')`,
    [IN_PROCESS, BAGHDAD],
  );
  ({ invoiceId, payableId, lineId } = await importOf('1000'));
  await postInvoice();
});

describe('table · a row per container, what it carries, never more than ordered', () => {
  it('records each container with its own size/type, seal and typed quantity', async () => {
    await bl('MEDU1000001', [
      { containerNo: 'MSCU1234566', sizeType: '40HC', sealNo: 'SL-1', quantities: { [lineId]: q('600') } },
      { containerNo: 'tghu 765432-0', sizeType: '20GP', sealNo: 'SL-2', quantities: { [lineId]: q('400') } },
    ]);
    expect(await containersOf()).toEqual([
      expect.objectContaining({ container_no: 'MSCU1234566', size_type: '40HC', seal_no: 'SL-1', planned: '600.000000', eta: '2026-10-25' }),
      expect.objectContaining({ container_no: 'TGHU7654320', size_type: '20GP', seal_no: 'SL-2', planned: '400.000000' }),
    ]);
  });

  it('divides a model left empty, and refuses more than is left of the order', async () => {
    await bl('MEDU1000002', [{ containerNo: 'MSCU1234566', quantities: { [lineId]: q('300') } }]);
    // 700 left: typed beyond it is refused, naming what is left.
    expect(await rejection(bl('MEDU1000003', [{ containerNo: 'TGHU7654320', quantities: { [lineId]: q('701') } }]))).toMatch(/only 700 is left/);
    // Left empty: the 700 divided over the two new containers.
    await bl('MEDU1000003', [{ containerNo: 'TGHU7654320' }, { containerNo: 'CAIU2345678' }]);
    expect((await containersOf()).map((c) => [c.container_no, c.planned])).toEqual([
      ['CAIU2345678', '350.000000'],
      ['MSCU1234566', '300.000000'],
      ['TGHU7654320', '350.000000'],
    ]);
    // A container's plan changed by hand is held to the same line.
    const first = (await containersOf()).find((c) => c.container_no === 'MSCU1234566')!;
    expect(
      await rejection(
        withScope(scope(world.clerk), (tx) =>
          shipments.setContainerLines(tx, world.clerk, first.id, [{ itemCode: PANEL, description: 'Solar Panel 550W', plannedQty: '301', uomCode: 'EA' }]),
        ),
      ),
    ).toMatch(/only 300 is left/);
  });

  it('refuses a wrong check digit, a size/type that is not one, a number listed twice, and a B/L with no ETA', async () => {
    expect(await rejection(bl('MEDU1000004', [{ containerNo: 'MSCU1234565' }]))).toMatch(/should be 6/);
    expect(await rejection(bl('MEDU1000004', [{ containerNo: 'MSCU1234566', sizeType: '99XX' }]))).toMatch(/not a container size/);
    expect(await rejection(bl('MEDU1000004', [{ containerNo: 'MSCU1234566' }, { containerNo: 'MSCU 123456-6' }]))).toMatch(/listed twice/);
    expect(await rejection(bl('MEDU1000004', [{ containerNo: 'MSCU1234566' }], { eta: null }))).toMatch(/Give the ETA/);
  });
});

describe('correct and cancel · a B/L or a container typed wrong', () => {
  it('corrects the B/L’s boxes, and the containers on its ETA follow it', async () => {
    const made = await bl('MEDU1000005', [{ containerNo: 'MSCU1234566' }]);
    const { blNo } = await withScope(scope(world.clerk), (tx) =>
      shipments.updateBl(tx, world.clerk, made.id, { blNo: 'MEDU1000006', blDate: '2026-09-21', eta: '2026-11-02', vessel: 'MSC Aurora', voyage: 'AA123' }),
    );
    expect(blNo).toBe('MEDU1000006');
    expect((await containersOf())[0]!.eta).toBe('2026-11-02');
    const { rows } = await ownerPool.query(`select summary from payable_event where payable_id = $1 and event_code = 'FIELD_CHANGED' order by recorded_at desc limit 1`, [payableId]);
    expect(rows[0].summary).toContain('blNo MEDU1000005 → MEDU1000006');
  });

  it('cancels a B/L with its containers; its number may be entered again; a received one cannot be cancelled', async () => {
    const made = await bl('MEDU1000007', [{ containerNo: 'MSCU1234566' }, { containerNo: 'TGHU7654320' }]);
    expect(await rejection(withScope(scope(world.manager), (tx) => shipments.cancelBl(tx, world.manager, made.id, ' ')))).toMatch(/Say why/);
    await withScope(scope(world.manager), (tx) => shipments.cancelBl(tx, world.manager, made.id, 'Typed against the wrong import'));
    expect((await containersOf()).every((c) => c.cancelled)).toBe(true);
    // The same number and the same containers, entered again.
    const again = await bl('MEDU1000007', [{ containerNo: 'MSCU1234566', quantities: { [lineId]: q('1000') } }]);
    const view = await withScope(scope(world.clerk), (tx) => shipments.viewBl(tx, 'MEDU1000007'));
    expect(view.bl.id).toBe(again.id);
    // Received: the B/L stands.
    const live = (await containersOf()).find((c) => !c.cancelled)!;
    const { rows: lines } = await ownerPool.query(`select id from shipment_container_line where container_id = $1 and superseded_at is null`, [live.id]);
    await withScope(scope(world.clerk), (tx) =>
      shipments.receive(tx, world.clerk, {
        documentId: randomUUID(),
        containerId: live.id,
        warehouseCode: WAREHOUSE,
        receiptDate: '2026-10-28',
        lines: [{ containerLineId: lines[0].id, receivedQty: q('1000'), damagedQty: 0n }],
      }),
    );
    expect(await rejection(withScope(scope(world.manager), (tx) => shipments.cancelBl(tx, world.manager, again.id, 'Too late')))).toMatch(/received containers/);
    expect(
      await rejection(withScope(scope(world.clerk), (tx) => shipments.updateBl(tx, world.clerk, again.id, { blNo: 'MEDU1000007', blDate: '2026-09-20', eta: '2026-11-01' }))),
    ).toMatch(/received containers/);
  });

  it('corrects a container’s number, size/type and seal, and cancels one with its reason', async () => {
    await bl('MEDU1000008', [{ containerNo: 'MSCU1234566' }, { containerNo: 'TGHU7654320' }]);
    const [, tghu] = await containersOf();
    expect(await rejection(withScope(scope(world.clerk), (tx) => shipments.updateContainer(tx, world.clerk, tghu!.id, { containerNo: 'TGHU7654321' })))).toMatch(/should be 0/);
    await withScope(scope(world.clerk), (tx) => shipments.updateContainer(tx, world.clerk, tghu!.id, { containerNo: 'CAIU2345678', sizeType: '40hc', sealNo: 'SL-9' }));
    const after = await containersOf();
    expect(after.find((c) => c.id === tghu!.id)).toMatchObject({ container_no: 'CAIU2345678', size_type: '40HC', seal_no: 'SL-9' });
    await withScope(scope(world.manager), (tx) => shipments.cancelContainer(tx, world.manager, tghu!.id, 'Not loaded on this vessel'));
    const listed = await withScope(scope(world.clerk), (tx) => shipments.listContainers(tx, { payableId, view: 'all' }));
    expect(listed.map((c) => c.containerNo)).toEqual(['MSCU1234566']);
    const cancelled = await withScope(scope(world.clerk), (tx) => shipments.listContainers(tx, { payableId, view: 'cancelled' }));
    expect(cancelled.map((c) => [c.containerNo, c.cancelReason])).toEqual([['CAIU2345678', 'Not loaded on this vessel']]);
  });
});

describe('report · the exceptions, and the B/L as a document', () => {
  it('lists what arrived short or damaged, and prints the B/L with its containers', async () => {
    await bl('MEDU1000009', [
      { containerNo: 'MSCU1234566', sizeType: '40HC', quantities: { [lineId]: q('500') } },
      { containerNo: 'TGHU7654320', sizeType: '40HC', quantities: { [lineId]: q('500') } },
    ]);
    const [first] = await containersOf();
    const { rows: lines } = await ownerPool.query(`select id from shipment_container_line where container_id = $1 and superseded_at is null`, [first!.id]);
    // Expected 500, arrived 480 whole and 5 damaged: 15 short.
    await withScope(scope(world.clerk), (tx) =>
      shipments.receive(tx, world.clerk, {
        documentId: randomUUID(),
        containerId: first!.id,
        warehouseCode: WAREHOUSE,
        receiptDate: '2026-10-28',
        lines: [{ containerLineId: lines[0].id, receivedQty: q('480'), damagedQty: q('5') }],
        varianceReason: '15 cartons missing, 5 crushed',
      }),
    );
    const exceptions = await withScope(scope(world.clerk), (tx) => shipments.listContainers(tx, { view: 'exceptions' }));
    expect(exceptions.map((c) => [c.containerNo, c.received, c.damaged, c.short])).toEqual([['MSCU1234566', '480.000000', '5.000000', '15.000000']]);

    const built = await withScope(scope(world.manager), (tx) =>
      shipmentPrint.billOfLading({ tx, principal: world.manager.principal, branchCode: BAGHDAD, locale: 'en', m: messagesFor('en') }, 'MEDU1000009'),
    );
    expect(built!.model.title).toBe('Bill of Lading');
    expect(built!.model.tables[0]!.rows.map((row) => [row.cells.container, row.cells.size])).toEqual([
      ['MSCU1234566', '40HC'],
      ['TGHU7654320', '40HC'],
    ]);
    expect(built!.model.tables[1]!.rows[0]!.cells).toMatchObject({ container: 'MSCU1234566', planned: '500', received: '480', damaged: '5', short: '15' });
  });
});
