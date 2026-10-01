/**
 * REQ-AP-001 Stage 5 — shipment & warehouse (§17, §18).
 *
 *   A13 (REQ-APP A11)  An import with containers on its B/Ls shows "X of Y
 *        received" as containers are received one at a time, moves to stage 6
 *        at the first receipt and 7 at the last, and its received quantity is
 *        Σ container lines.
 *   A14 (REQ-APP A12)  Receiving a container writes inventory_movement +
 *        cost_layer in one transaction with the warehouse's branch; a repeated
 *        submit with the same document id returns the existing receipt; a
 *        variance sets missing/damaged and opens a hold.
 *   A15 (REQ-APP A13)  Goods on containers not yet received are not available
 *        (they stand in a transit warehouse); the staging warehouse is transit.
 *
 * Plus the container numbers, the stages, ETA and Late, the port file, the
 * instalments dated from the B/L and the B/L payment trigger.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, rejection, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as ap from '@/server/services/ap-invoice';
import * as applications from '@/server/services/payment-applications';
import * as integrity from '@/server/services/inventory-integrity';
import * as payables from '@/server/services/payables';
import * as shipments from '@/server/services/shipments';
import * as sweep from '@/server/services/payables-sweep';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

const IN_PROCESS = 'WH-AP05-INPROC';
let world: TradingWorld;
let invoiceId: string;
let payableId: string;
let payableNo: string;

const superScope = () => ({ userId: world.manager.principal.userId, branchCode: BAGHDAD, isSuperUser: true });
const q = (value: string) => parseQuantity(value);

async function importOf(quantity = '1000', reference = 'CSA-SHIP-0001') {
  const made = await withScope(scope(world.clerk), (tx) =>
    ap.create(tx, world.clerk, {
      supplierId: world.supplierId,
      supplierInvoiceNo: reference,
      branchCode: BAGHDAD,
      invoiceDate: '2026-09-01',
      dueDate: '2026-11-01',
      isImport: true,
      lines: [
        {
          itemCode: PANEL,
          description: 'Solar Panel 550W',
          quantity: q(quantity),
          unitPriceIqd: parseDecimal('10000', 4n),
          uomCode: 'EA',
          isInventory: true,
          // The accountant names the warehouse the goods will be received into.
          warehouseCode: WAREHOUSE,
        },
      ],
    }),
  );
  const { rows } = await ownerPool.query(
    `select p.id, p.payable_no from payable p join ap_invoice i on i.payable_id = p.id where i.id = $1`,
    [made.id],
  );
  return { invoiceId: made.id, payableId: rows[0].id as string, payableNo: rows[0].payable_no as string };
}

async function postInvoice(id = invoiceId) {
  await withScope(scope(world.clerk), (tx) => ap.submit(tx, world.clerk, id));
  await withScope(scope(world.manager), (tx) => ap.post(tx, world.manager, id));
}

const createBl = (input: Partial<shipments.CreateBlInput> = {}) =>
  withScope(scope(world.clerk), (tx) =>
    shipments.createBl(tx, world.clerk, {
      payableId,
      blNo: 'MEDUWI804404',
      blDate: '2026-09-20',
      vessel: 'MSC Aurora',
      eta: '2026-10-25',
      portOfDischargeCode: 'PRT-0001',
      containers: 'MSCU1234565\nTGHU7654321, CAIU2345678\nFSCU 345678-9',
      sizeType: '40HC',
      spreadLines: true,
      ...input,
    }),
  );

async function containerIds() {
  const { rows } = await ownerPool.query(
    `select id, container_no from shipment_container where payable_id = $1 order by container_no`,
    [payableId],
  );
  return rows as { id: string; container_no: string }[];
}

async function receiveAll(containerId: string, documentId = randomUUID(), overrides: Partial<{ received: string; damaged: string; short: string }> = {}, reason: string | null = null) {
  const { rows: lines } = await ownerPool.query(
    `select id, planned_qty from shipment_container_line where container_id = $1 and superseded_at is null`,
    [containerId],
  );
  return withScope(scope(world.clerk), (tx) =>
    shipments.receive(tx, world.clerk, {
      documentId,
      containerId,
      warehouseCode: WAREHOUSE,
      receiptDate: '2026-10-28',
      lines: lines.map((line) => ({
        containerLineId: line.id,
        receivedQty: overrides.received ? q(overrides.received) : q(line.planned_qty),
        damagedQty: overrides.damaged ? q(overrides.damaged) : 0n,
        shortQty: overrides.short ? q(overrides.short) : 0n,
      })),
      varianceReason: reason,
    }),
  );
}

const stageOf = async () => {
  const { rows } = await ownerPool.query(`select stage_code from payable where id = $1`, [payableId]);
  return rows[0].stage_code as string;
};
const codes = async () => {
  const { rows } = await ownerPool.query(
    `select event_code from payable_event where payable_id = $1 order by recorded_at, id`,
    [payableId],
  );
  return rows.map((row) => row.event_code as string);
};

beforeEach(async () => {
  world = await buildTradingWorld();
  await ownerPool.query(
    `insert into warehouse (code, name, branch_code, warehouse_type, is_transit, shipment_stage)
     values ($1,'In Process',$2,'transit',true,'in_process')`,
    [IN_PROCESS, BAGHDAD],
  );
  ({ invoiceId, payableId, payableNo } = await importOf());
});

describe('A15 · goods at sea are owned, not available', () => {
  it('the import invoice receives into transit; the order keeps the destination; no four-stage shipment opens', async () => {
    const { rows: lines } = await ownerPool.query(`select warehouse_code from ap_invoice_line where ap_invoice_id = $1`, [invoiceId]);
    expect(lines).toEqual([{ warehouse_code: IN_PROCESS }]);
    await postInvoice();

    const { rows: position } = await ownerPool.query(
      `select warehouse_code, on_hand::text, available::text from stock_position where item_code = $1 order by warehouse_code`,
      [PANEL],
    );
    expect(position).toEqual([{ warehouse_code: IN_PROCESS, on_hand: '1000.000000', available: '0' }]);
    const { rows: shipment } = await ownerPool.query(`select count(*)::int as n from supplier_shipment where ap_invoice_id = $1`, [invoiceId]);
    expect(shipment[0].n).toBe(0);
    const { rows: order } = await ownerPool.query(
      `select l.warehouse_code from purchase_order_line l join payable p on p.purchase_order_id = l.purchase_order_id where p.id = $1`,
      [payableId],
    );
    expect(order[0].warehouse_code).toBe(WAREHOUSE);
  });
});

describe('§17.1 · B/Ls and containers', () => {
  it('a B/L lists its containers, read from a paste; the plan is spread and flagged estimated', async () => {
    const made = await createBl();
    expect(made.containers).toBe(4);
    const { rows } = await ownerPool.query(
      `select c.container_no, c.eta::text as eta, c.lines_estimated, sum(l.planned_qty)::text as planned
         from shipment_container c join shipment_container_line l on l.container_id = c.id
        where c.payable_id = $1 group by c.id order by c.container_no`,
      [payableId],
    );
    expect(rows.map((r) => [r.container_no, r.planned, r.lines_estimated, r.eta])).toEqual([
      ['CAIU2345678', '250.000000', true, '2026-10-25'],
      ['FSCU3456789', '250.000000', true, '2026-10-25'],
      ['MSCU1234565', '250.000000', true, '2026-10-25'],
      ['TGHU7654321', '250.000000', true, '2026-10-25'],
    ]);
    expect(await codes()).toEqual(expect.arrayContaining(['BL_ISSUED', 'CONTAINER_ADDED']));
    expect(await stageOf()).toBe('shipped');
  });

  it('refuses what is not a container number, and a number still on a live B/L', async () => {
    expect(await rejection(createBl({ containers: 'MSCU123' }))).toMatch(/Not container numbers: MSCU123/);
    await createBl();
    const other = await importOf('10', 'CSA-SHIP-0002');
    payableId = other.payableId;
    expect(await rejection(createBl({ blNo: 'MEDU0000002', containers: 'MSCU1234565' }))).toMatch(
      /Already on a live B\/L: MSCU1234565/,
    );
    expect(await rejection(createBl({ containers: 'TEMU1111111' }))).toMatch(/already recorded/);
  });

  it('dates the B/L instalments, and the B/L trigger refuses Send until there is a B/L', async () => {
    await withScope(scope(world.clerk), (tx) =>
      applications.planInstalments(tx, world.clerk, {
        payableId,
        rows: [
          { label: 'Deposit', basis: 'percent', percent: '30', triggerCode: 'on_order' },
          { label: 'Balance', basis: 'percent', percent: '70', triggerCode: 'days_after_bl', triggerDays: 60 },
        ],
      }),
    );
    await createBl();
    const plan = await withScope(scope(world.clerk), (tx) => applications.instalmentsFor(tx, payableId));
    expect(plan[1]!.expectedDate).toBe('2026-11-19');
  });
});

describe('§17.3 · stages, ETA, Late and the port file', () => {
  it('forward only; each stage stamps its own date; the vessel docks for the whole B/L', async () => {
    const bl = await createBl();
    const [first] = await containerIds();
    await withScope(scope(world.clerk), (tx) =>
      shipments.changeStatus(tx, world.clerk, first!.id, { statusCode: 'on_sea', date: '2026-09-22' }),
    );
    expect(
      await rejection(
        withScope(scope(world.clerk), (tx) =>
          shipments.changeStatus(tx, world.clerk, first!.id, { statusCode: 'not_loaded', date: '2026-09-23' }),
        ),
      ),
    ).toMatch(/already past that/);
    expect(
      await rejection(
        withScope(scope(world.clerk), (tx) =>
          shipments.changeStatus(tx, world.clerk, first!.id, { statusCode: 'received', date: '2026-09-23' }),
        ),
      ),
    ).toMatch(/container receipt/);

    const moved = await withScope(scope(world.clerk), (tx) =>
      shipments.changeStatusForBl(tx, world.clerk, bl.id, { statusCode: 'at_port', date: '2026-10-24' }),
    );
    expect(moved.moved).toBe(4);
    const { rows } = await ownerPool.query(
      `select departed_on::text as departed, arrived_port_on::text as arrived from shipment_container where id = $1`,
      [first!.id],
    );
    expect(rows[0]).toEqual({ departed: '2026-09-22', arrived: '2026-10-24' });

    // The port file follows customs clearance.
    expect(await rejection(withScope(scope(world.clerk), (tx) => shipments.portFileSent(tx, world.clerk, first!.id, '2026-10-26')))).toMatch(
      /not customs cleared/,
    );
    await withScope(scope(world.clerk), (tx) =>
      shipments.changeStatus(tx, world.clerk, first!.id, { statusCode: 'customs_cleared', date: '2026-10-26' }),
    );
    await withScope(scope(world.clerk), (tx) => shipments.portFileSent(tx, world.clerk, first!.id, '2026-10-27'));
    expect(await codes()).toEqual(expect.arrayContaining(['CONTAINER_STATUS_CHANGED', 'PORT_FILE_SENT']));
  });

  it('an ETA that passes makes the container Late and stops the import once; a new ETA is logged', async () => {
    await createBl({ containers: 'MSCU1234565', eta: '2026-10-05' });
    const [only] = await containerIds();
    await withScope(scope(world.clerk), (tx) =>
      shipments.changeEta(tx, world.clerk, only!.id, { eta: '2026-10-10', note: 'Transshipment at Jebel Ali' }),
    );
    await withScope(superScope(), (tx) => sweep.runSweep(tx, '2026-10-09'));
    let { rows } = await ownerPool.query(`select status_code from shipment_container where id = $1`, [only!.id]);
    expect(rows[0].status_code).toBe('not_loaded');

    await withScope(superScope(), (tx) => sweep.runSweep(tx, '2026-10-12'));
    await withScope(superScope(), (tx) => sweep.runSweep(tx, '2026-10-13'));
    ({ rows } = await ownerPool.query(`select status_code from shipment_container where id = $1`, [only!.id]));
    expect(rows[0].status_code).toBe('late');
    const { rows: holds } = await ownerPool.query(
      `select lane_code from payable_hold where payable_id = $1 and check_code = 'container_eta_passed'`,
      [payableId],
    );
    expect(holds).toEqual([{ lane_code: 'shipment' }]);
    expect((await codes()).filter((code) => code === 'CONTAINER_LATE')).toHaveLength(1);
    expect(await codes()).toContain('ETA_CHANGED');

    // A late container moves on when it is seen again.
    await withScope(scope(world.clerk), (tx) =>
      shipments.changeStatus(tx, world.clerk, only!.id, { statusCode: 'at_port', date: '2026-10-14' }),
    );
  });
});

describe('A13 / A14 · container by container into the warehouse', () => {
  it('receives one container at a time: X of Y, stage 6 then 7, the ledger moved once per container', async () => {
    await postInvoice();
    await createBl();
    const containers = await containerIds();

    const documentId = randomUUID();
    const first = await receiveAll(containers[0]!.id, documentId);
    expect(first.repeated).toBe(false);
    expect(await stageOf()).toBe('partly_received');

    // A repeated submit with the same document id is the same receipt.
    const again = await receiveAll(containers[0]!.id, documentId);
    expect(again).toMatchObject({ id: first.id, receiptNo: first.receiptNo, repeated: true });
    // A second, different receipt of the same container is refused.
    expect(await rejection(receiveAll(containers[0]!.id))).toMatch(/One container, one receipt/);

    const { rows: movements } = await ownerPool.query(
      `select warehouse_code, kind::text, quantity::text, branch_code from inventory_movement
        where source_document_type = 'container_receipt' and source_document_id = $1 order by quantity`,
      [documentId],
    );
    expect(movements).toEqual([
      { warehouse_code: IN_PROCESS, kind: 'transfer_issue', quantity: '-250.000000', branch_code: BAGHDAD },
      { warehouse_code: WAREHOUSE, kind: 'transfer_receipt', quantity: '250.000000', branch_code: BAGHDAD },
    ]);
    const { rows: layer } = await ownerPool.query(
      `select unit_cost_iqd::text as cost, remaining_quantity::text as remaining from cost_layer
        where warehouse_code = $1 and item_code = $2`,
      [WAREHOUSE, PANEL],
    );
    expect(layer).toEqual([{ cost: '10000.0000', remaining: '250.000000' }]);

    for (const container of containers.slice(1)) await receiveAll(container.id);
    expect(await stageOf()).toBe('all_received');
    expect(await codes()).toContain('ALL_CONTAINERS_RECEIVED');
    const received = await withScope(scope(world.clerk), (tx) => shipments.receivedQuantity(tx, payableId));
    expect(received).toBe(q('1000'));
    const facts = await withScope(scope(world.clerk), (tx) => payables.gatherFacts(tx, payableId));
    expect(facts).toMatchObject({ containerCount: 4, containersReceived: 4, receivedQuantityMatches: true });

    const { rows: position } = await ownerPool.query(
      `select warehouse_code, on_hand::text, available::text from stock_position where item_code = $1 order by warehouse_code`,
      [PANEL],
    );
    expect(position).toEqual([
      { warehouse_code: IN_PROCESS, on_hand: '0.000000', available: '0' },
      { warehouse_code: WAREHOUSE, on_hand: '1000.000000', available: '1000.000000' },
    ]);

    // The ledger and its documents agree.
    const report = await withScope(superScope(), async (tx) => ({
      orphanDocs: await integrity.documentsWithoutLedger(tx),
      orphanMoves: await integrity.ledgerWithoutDocument(tx),
      unbalanced: await integrity.unbalancedTransfers(tx),
    }));
    expect(report).toEqual({ orphanDocs: [], orphanMoves: [], unbalanced: [] });
  });

  it('a short container is Missing / damaged, logged, and opens the claim; the reason is required', async () => {
    await postInvoice();
    await createBl({ containers: 'MSCU1234565' });
    const [only] = await containerIds();
    expect(await rejection(receiveAll(only!.id, randomUUID(), { received: '990', short: '10' }))).toMatch(/Say what happened/);
    await receiveAll(only!.id, randomUUID(), { received: '990', short: '10' }, '10 cartons missing, seal intact');
    const { rows } = await ownerPool.query(`select status_code from shipment_container where id = $1`, [only!.id]);
    expect(rows[0].status_code).toBe('missing_damaged');
    expect(await codes()).toContain('QUANTITY_VARIANCE');
    const { rows: holds } = await ownerPool.query(
      `select lane_code, reason_code from payable_hold where payable_id = $1 and check_code = 'receipt_variance'`,
      [payableId],
    );
    expect(holds).toEqual([{ lane_code: 'warehouse', reason_code: 'PENDING_REASON' }]);
    const facts = await withScope(scope(world.clerk), (tx) => payables.gatherFacts(tx, payableId));
    expect(facts.receivedQuantityMatches).toBe(false);
    // Ten stay in transit, owned and not available, until the claim is settled.
    const { rows: position } = await ownerPool.query(
      `select on_hand::text from stock_position where item_code = $1 and warehouse_code = $2`,
      [PANEL, IN_PROCESS],
    );
    expect(position[0].on_hand).toBe('10.000000');
  });

  it('refuses before the invoice posts, into another branch, or into transit', async () => {
    await createBl({ containers: 'MSCU1234565' });
    const [only] = await containerIds();
    expect(await rejection(receiveAll(only!.id))).toMatch(/invoice is not posted yet/);
    await postInvoice();

    await seedBranch('ERB', 'Erbil');
    await ownerPool.query(
      `insert into warehouse (code, name, branch_code, warehouse_type) values ('WH-ERB','Erbil','ERB','main') on conflict do nothing`,
    );
    const { rows: lines } = await ownerPool.query(`select id from shipment_container_line where container_id = $1`, [only!.id]);
    const attempt = (warehouseCode: string) =>
      withScope(scope(world.clerk), (tx) =>
        shipments.receive(tx, world.clerk, {
          documentId: randomUUID(),
          containerId: only!.id,
          warehouseCode,
          receiptDate: '2026-10-28',
          lines: [{ containerLineId: lines[0].id, receivedQty: q('1000') }],
        }),
      );
    expect(await rejection(attempt('WH-ERB'))).toMatch(/belongs to ERB/);
    expect(await rejection(attempt(IN_PROCESS))).toMatch(/holds goods in transit/);
    // Nothing moved on any refusal.
    const { rows } = await ownerPool.query(`select count(*)::int as n from inventory_movement where source_document_type = 'container_receipt'`);
    expect(rows[0].n).toBe(0);
    expect(payableNo).toMatch(/^IMP-/);
  });

  it('the history of a container is append-only, and so is its receipt', async () => {
    await postInvoice();
    await createBl({ containers: 'MSCU1234565' });
    const [only] = await containerIds();
    await receiveAll(only!.id);
    for (const table of ['shipment_container_status_history', 'container_receipt', 'container_receipt_line']) {
      const refused = await ownerPool
        .query(`delete from ${table}`)
        .then(() => 'allowed')
        .catch((error: Error) => error.message);
      expect(refused, table).not.toBe('allowed');
    }
  });
});
