/**
 * IMPROVEMENT-002 IM2-1 — the Import Application, made to work as the
 * sponsor left it (docs/improvement02.md §2.4, §4.1).
 *
 *   short    A container short of its plan: the shortfall is worked out, the
 *            quantity board says where every unit is, and the claim takes
 *            what did not arrive out of transit — the import can then clear.
 *   units    An import bought in boxes is received in boxes and moves units.
 *   funded   Stage 2 is reached with an application and no instalment plan;
 *            an application left without an amount asks for all that is left.
 *   direct   A supplier payment made straight against the import's invoice
 *            pays the import: it counts, and the cap knows it.
 *   dollars  An import read from a supplier's document in dollars: the
 *            invoice in dinars at the day's rate, the import in dollars, and
 *            its goods in transit though the document named no warehouse.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { fundBank } from './hr-funds';
import { ownerPool, rejection } from './setup';
import { withScope } from '@/server/db/client';
import * as ap from '@/server/services/ap-invoice';
import * as applications from '@/server/services/payment-applications';
import * as gr from '@/server/services/goods-return';
import * as units from '@/server/services/item-units';
import * as payables from '@/server/services/payables';
import * as pay from '@/server/services/supplier-payment';
import * as shipments from '@/server/services/shipments';
import { parseDecimal } from '@/server/domain/money';
import { formatQuantity, parseQuantity } from '@/server/domain/uom';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

const IN_PROCESS = 'WH-IM2-INPROC';
const SWIFT = 'SWIFT-IM2';
let world: TradingWorld;
let invoiceId: string;
let payableId: string;

const q = (value: string) => parseQuantity(value);
const iqd = (value: string) => parseDecimal(value, 4n);

async function importOf(quantity: string, options: { uomCode?: string; price?: string; reference?: string } = {}) {
  const made = await withScope(scope(world.clerk), (tx) =>
    ap.create(tx, world.clerk, {
      supplierId: world.supplierId,
      supplierInvoiceNo: options.reference ?? `IM2-${randomUUID().slice(0, 6)}`,
      branchCode: BAGHDAD,
      invoiceDate: '2026-09-01',
      dueDate: '2026-11-01',
      isImport: true,
      lines: [
        {
          itemCode: PANEL,
          description: 'Solar Panel 550W',
          quantity: q(quantity),
          unitPriceIqd: iqd(options.price ?? '10000'),
          uomCode: options.uomCode ?? 'EA',
          isInventory: true,
          warehouseCode: WAREHOUSE,
        },
      ],
    }),
  );
  const { rows } = await ownerPool.query(`select payable_id from ap_invoice where id = $1`, [made.id]);
  return { invoiceId: made.id, payableId: rows[0].payable_id as string };
}

async function postInvoice(id = invoiceId) {
  await withScope(scope(world.clerk), (tx) => ap.submit(tx, world.clerk, id));
  await withScope(scope(world.manager), (tx) => ap.post(tx, world.manager, id));
}

const createBl = (containers: string, onPayable = payableId) =>
  withScope(scope(world.clerk), (tx) =>
    shipments.createBl(tx, world.clerk, {
      payableId: onPayable,
      blNo: `MEDU${randomUUID().slice(0, 6)}`,
      blDate: '2026-09-20',
      eta: '2026-10-25',
      portOfDischargeCode: 'PRT-0001',
      containers,
      spreadLines: true,
    }),
  );

async function containers(onPayable = payableId) {
  const { rows } = await ownerPool.query(`select id, container_no from shipment_container where payable_id = $1 order by container_no`, [onPayable]);
  return rows as { id: string; container_no: string }[];
}

async function lineOf(containerId: string) {
  const { rows } = await ownerPool.query(
    `select id, planned_qty::text as planned, uom_code from shipment_container_line where container_id = $1 and superseded_at is null`,
    [containerId],
  );
  return rows[0] as { id: string; planned: string; uom_code: string | null };
}

const receive = async (containerId: string, counted: { received: string; damaged?: string; short?: string }, reason: string | null = null) => {
  const line = await lineOf(containerId);
  return withScope(scope(world.clerk), (tx) =>
    shipments.receive(tx, world.clerk, {
      documentId: randomUUID(),
      containerId,
      warehouseCode: WAREHOUSE,
      receiptDate: '2026-10-28',
      lines: [
        {
          containerLineId: line.id,
          receivedQty: q(counted.received),
          damagedQty: q(counted.damaged ?? '0'),
          ...(counted.short !== undefined ? { shortQty: q(counted.short) } : {}),
        },
      ],
      varianceReason: reason,
    }),
  );
};

const board = async (onPayable = payableId) => {
  const position = await withScope(scope(world.clerk), (tx) => payables.quantityPosition(tx, onPayable));
  return position.lines.map((line) => ({
    item: line.itemCode,
    ordered: formatQuantity(line.ordered),
    planned: formatQuantity(line.planned),
    received: formatQuantity(line.received),
    damaged: formatQuantity(line.damaged),
    short: formatQuantity(line.short),
    claimed: formatQuantity(line.claimed),
    inTransit: formatQuantity(line.inTransit),
    notYetShipped: formatQuantity(line.notYetShipped),
  }));
};
const facts = (onPayable = payableId) => withScope(scope(world.clerk), (tx) => payables.gatherFacts(tx, onPayable));
const stageOf = async (onPayable = payableId) =>
  (await ownerPool.query(`select stage_code from payable where id = $1`, [onPayable])).rows[0].stage_code as string;
const onHand = async (warehouseCode: string) =>
  (
    await ownerPool.query(`select coalesce(sum(on_hand), 0)::text as n from stock_position where item_code = $1 and warehouse_code = $2`, [
      PANEL,
      warehouseCode,
    ])
  ).rows[0].n as string;

beforeEach(async () => {
  world = await buildTradingWorld();
  await ownerPool.query(
    `insert into warehouse (code, name, branch_code, warehouse_type, is_transit, shipment_stage)
     values ($1,'In Process',$2,'transit',true,'in_process')`,
    [IN_PROCESS, BAGHDAD],
  );
});

describe('short · what did not arrive is worked out, shown and claimed', () => {
  beforeEach(async () => {
    ({ invoiceId, payableId } = await importOf('1000'));
    await postInvoice();
    await createBl('MSCU1234566\nTGHU7654320');
  });

  it('works out the short quantity, refuses one that does not add up, and lets more than planned arrive with nothing short', async () => {
    const [first, second] = await containers();
    // 500 planned: 450 whole and 20 damaged — so 30 short; a typed 10 does not add up.
    expect(await rejection(receive(second!.id, { received: '450', damaged: '20', short: '10' }, 'Seal broken'))).toMatch(/make the planned quantity/);
    await receive(second!.id, { received: '450', damaged: '20' }, 'Seal broken, 30 cartons missing');
    const { rows } = await ownerPool.query(`select short_qty::text as short from shipment_container_line where container_id = $1`, [second!.id]);
    expect(rows[0].short).toBe('30.000000');
    // The first container carried more than its plan: nothing on it is short.
    expect(await rejection(receive(first!.id, { received: '510', short: '5' }, 'Packed differently'))).toMatch(/nothing on that line is short/);
    await receive(first!.id, { received: '510' }, 'Packed differently');
    expect(await board()).toEqual([
      { item: PANEL, ordered: '1000', planned: '1000', received: '960', damaged: '20', short: '30', claimed: '0', inTransit: '40', notYetShipped: '0' },
    ]);
  });

  it('claims what is left in transit once every container is in; the return takes it out and the import can clear', async () => {
    const [first, second] = await containers();
    await receive(first!.id, { received: '500' });
    // One container still at sea: nothing is claimed yet.
    expect(await rejection(withScope(scope(world.clerk), (tx) => shipments.claimShortage(tx, world.clerk, { payableId, returnDate: '2026-10-29', reason: 'Short' })))).toMatch(
      /still to arrive/,
    );
    await receive(second!.id, { received: '470' }, '30 cartons missing, seal intact');
    expect((await facts()).receivedQuantityMatches).toBe(false);
    const { rows: openHolds } = await ownerPool.query(`select status from payable_hold where payable_id = $1 and check_code = 'receipt_variance'`, [payableId]);
    expect(openHolds).toEqual([{ status: 'open' }]);

    const claimed = await withScope(scope(world.manager), (tx) =>
      shipments.claimShortage(tx, world.manager, { payableId, returnDate: '2026-10-29', reason: '30 cartons missing in TGHU7654320', supplierReference: 'CLM-7' }),
    );
    expect(claimed.returns).toHaveLength(1);
    const { rows: lines } = await ownerPool.query(
      `select l.quantity::text as quantity, l.warehouse_code, g.offset_kind from goods_return_line l join goods_return g on g.id = l.goods_return_id where g.id = $1`,
      [claimed.returns[0]!.id],
    );
    expect(lines).toEqual([{ quantity: '30.000000', warehouse_code: IN_PROCESS, offset_kind: 'payable' }]);
    const { rows: holds } = await ownerPool.query(`select status, resolution from payable_hold where payable_id = $1 and check_code = 'receipt_variance'`, [payableId]);
    expect(holds[0].status).toBe('resolved');
    expect(holds[0].resolution).toContain(claimed.returns[0]!.returnNo);
    const { rows: logged } = await ownerPool.query(`select summary from payable_event where payable_id = $1 and event_code = 'SHORTAGE_CLAIMED'`, [payableId]);
    expect(logged[0].summary).toContain(`${PANEL} 30`);

    // The return goes the usual way; posted, the goods leave transit.
    await withScope(scope(world.manager), (tx) => gr.approve(tx, world.manager, claimed.returns[0]!.id));
    await withScope(scope(world.manager), (tx) => gr.post(tx, world.manager, claimed.returns[0]!.id));
    expect(await onHand(IN_PROCESS)).toBe('0.000000');
    expect((await board())[0]).toMatchObject({ received: '970', short: '30', claimed: '30', inTransit: '0' });
    expect((await facts()).receivedQuantityMatches).toBe(true);
    // Nothing more to claim.
    expect(await rejection(withScope(scope(world.manager), (tx) => shipments.claimShortage(tx, world.manager, { payableId, returnDate: '2026-10-30', reason: 'Again' })))).toMatch(
      /no shortage to claim/,
    );
  });

  it('a balance shipment is just another container: the board says what is not yet shipped', async () => {
    const first = (await containers()).find((c) => c.container_no === 'MSCU1234566');
    // Re-plan the first container down to 300 of its 500.
    await withScope(scope(world.clerk), (tx) =>
      shipments.setContainerLines(tx, world.clerk, first!.id, [{ itemCode: PANEL, description: 'Solar Panel 550W', plannedQty: '300', uomCode: 'EA' }]),
    );
    expect((await board())[0]).toMatchObject({ ordered: '1000', planned: '800', notYetShipped: '200' });
    await createBl('CAIU2345678');
    const third = (await containers()).find((c) => c.container_no === 'CAIU2345678');
    await withScope(scope(world.clerk), (tx) =>
      shipments.setContainerLines(tx, world.clerk, third!.id, [{ itemCode: PANEL, description: 'Solar Panel 550W', plannedQty: '200', uomCode: 'EA' }]),
    );
    expect((await board())[0]).toMatchObject({ planned: '1000', notYetShipped: '0' });
  });
});

describe('units · an import bought in boxes', () => {
  it('is planned and received in boxes, and moves units out of transit', async () => {
    await withScope(scope(world.manager), (tx) => units.addUnit(tx, world.manager, PANEL, { uomCode: 'BOX', numerator: 24n, isPurchaseDefault: true }));
    ({ invoiceId, payableId } = await importOf('10', { uomCode: 'BOX', price: '240000' }));
    await postInvoice();
    expect(await onHand(IN_PROCESS)).toBe('240.000000');
    await createBl('MSCU1234566');
    const [only] = await containers();
    expect(await lineOf(only!.id)).toMatchObject({ planned: '10.000000', uom_code: 'BOX' });
    await receive(only!.id, { received: '10' });
    expect(await onHand(IN_PROCESS)).toBe('0.000000');
    expect(await onHand(WAREHOUSE)).toBe('240.000000');
    expect((await board())[0]).toMatchObject({ ordered: '240', planned: '240', received: '240', inTransit: '0' });
    expect((await facts()).receivedQuantityMatches).toBe(true);
  });
});

describe('funded · stage 2 without a plan, and an application for all that is left', () => {
  beforeEach(async () => {
    await ownerPool.query(`insert into payment_method (code, name, kind, confirmation_kind) values ($1,'SWIFT transfer','bank','swift')`, [SWIFT]);
    ({ invoiceId, payableId } = await importOf('100'));
    await postInvoice();
  });

  it('asks for all that is left when no amount is given, and reaches Invoiced + funded once approved', async () => {
    const made = await withScope(scope(world.clerk), (tx) =>
      applications.create(tx, world.clerk, { payableId, paymentMethodCode: SWIFT, bankCashAccountId: world.bankAccountId, amountTxn: null, onDate: '2026-09-10' }),
    );
    const { rows } = await ownerPool.query(`select amount_txn::text as amount from payment_application where id = $1`, [made.id]);
    expect(rows[0].amount).toBe('1000000.0000');
    await withScope(scope(world.manager), (tx) => applications.approve(tx, world.manager, made.id));
    expect(await stageOf()).toBe('invoiced_funded');
    // Nothing is left to ask for now.
    expect(
      await rejection(
        withScope(scope(world.clerk), (tx) =>
          applications.create(tx, world.clerk, { payableId, paymentMethodCode: SWIFT, bankCashAccountId: world.bankAccountId, amountTxn: null, onDate: '2026-09-10' }),
        ),
      ),
    ).toMatch(/Nothing is left to ask the bank for/);
  });
});

describe('direct · a supplier payment against the import invoice pays the import', () => {
  it('counts towards paid and fully paid, and the cap on applications knows it', async () => {
    await ownerPool.query(`insert into payment_method (code, name, kind, confirmation_kind) values ($1,'SWIFT transfer','bank','swift')`, [SWIFT]);
    ({ invoiceId, payableId } = await importOf('100'));
    await postInvoice();
    await fundBank(world, '5000000.0000');
    const made = await withScope(scope(world.clerk), (tx) =>
      pay.create(tx, world.clerk, { supplierId: world.supplierId, bankCashAccountId: world.bankAccountId, branchCode: BAGHDAD, paymentDate: '2026-09-15', amountIqd: iqd('600000'), reference: 'TRF-IM2-1' }),
    );
    await withScope(scope(world.manager), (tx) => pay.post(tx, world.manager, made.id));
    await withScope(scope(world.manager), (tx) => pay.allocate(tx, world.manager, { supplierPaymentId: made.id, apInvoiceId: invoiceId, amountIqd: iqd('600000') }));

    const totals = await withScope(scope(world.clerk), (tx) => applications.totalsFor(tx, payableId));
    expect(totals.paidTxn).toBe(iqd('600000'));
    expect(totals.remainingTxn).toBe(iqd('400000'));
    expect(
      await rejection(
        withScope(scope(world.clerk), (tx) =>
          applications.create(tx, world.clerk, { payableId, paymentMethodCode: SWIFT, bankCashAccountId: world.bankAccountId, amountTxn: iqd('500000'), onDate: '2026-09-16' }),
        ),
      ),
    ).toMatch(/more than is left to ask the bank for/);
    // The rest, straight again: fully paid, every payment counted as confirmed.
    const rest = await withScope(scope(world.clerk), (tx) =>
      pay.create(tx, world.clerk, { supplierId: world.supplierId, bankCashAccountId: world.bankAccountId, branchCode: BAGHDAD, paymentDate: '2026-09-16', amountIqd: iqd('400000'), reference: 'TRF-IM2-2' }),
    );
    await withScope(scope(world.manager), (tx) => pay.post(tx, world.manager, rest.id));
    await withScope(scope(world.manager), (tx) => pay.allocate(tx, world.manager, { supplierPaymentId: rest.id, apInvoiceId: invoiceId, amountIqd: iqd('400000') }));
    const after = await facts();
    expect(after.fullyPaid).toBe(true);
    expect(after.allPaymentsConfirmed).toBe(true);
  });
});

describe('dollars · an import from a supplier document in USD', () => {
  it('books the invoice in dinars at the day’s rate, keeps the import in dollars, and lands the goods in transit', async () => {
    const made = await withScope(scope(world.clerk), (tx) =>
      ap.create(tx, world.clerk, {
        supplierId: world.supplierId,
        supplierInvoiceNo: 'PI-USD-1',
        branchCode: BAGHDAD,
        invoiceDate: '2026-09-01',
        isImport: true,
        importCurrency: 'USD',
        nonPoJustification: 'Raised from the supplier’s own document.',
        // As the reader gives it: no warehouse; 10 at $100 = 131,000 IQD each at 1,310.
        lines: [{ itemCode: PANEL, description: 'Solar Panel 550W', quantity: q('10'), unitPriceIqd: iqd('131000'), unitPriceTxn: iqd('100'), isInventory: true }],
      }),
    );
    const { rows: line } = await ownerPool.query(`select warehouse_code, unit_price::text as price from ap_invoice_line where ap_invoice_id = $1`, [made.id]);
    expect(line).toEqual([{ warehouse_code: IN_PROCESS, price: '131000.0000' }]);
    const { rows: owner } = await ownerPool.query(
      `select p.currency, p.amount_txn::text as txn from payable p join ap_invoice i on i.payable_id = p.id where i.id = $1`,
      [made.id],
    );
    expect(owner).toEqual([{ currency: 'USD', txn: '1000.0000' }]);
    await postInvoice(made.id);
    expect(await onHand(IN_PROCESS)).toBe('10.000000');
  });
});
