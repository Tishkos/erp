/**
 * Related records (platform phase, Agent 9) — the chains of real records, against a real import.
 *
 * The world is the one the Control Center suite shares (`cc01-world`): an import of 500 panels bought, shipped in
 * two containers, cleared through a PD and a declaration, costed, received and locked; a customer who bought,
 * paid part, returned and was credited; a supplier whose order was received and who was paid. Then:
 *
 *   REL1  the import's chain, node by node: every node is a row, joined to the one before it by its own foreign
 *         key, and every node with a page opens a page the viewer may enter
 *   REL2  "not yet" is a fact about the process: an import with an invoice and nothing shipped is not yet at the
 *         B/L and says nothing of what comes after; a cancelled one goes on to nothing
 *   REL3  supplier, customer and item chains, with the figures the Control Center reads the same way
 *   REL4  who sees what: a step the viewer may not open is absent — not empty, not zero — whatever the data
 *   REL5  one step failing never blanks the chain
 *   REL6  it reads and writes nothing
 */
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { ownerPool } from './setup';
import { BAGHDAD, PANEL, WAREHOUSE, blWith, importOf, iqd, q, scope } from './logistics-fixture';
import { ERBIL, as, buildChainWorld, expectOpenable, maintenance, person, type ChainWorld, type Person } from './cc01-world';
import { containerNo } from '../support/container-number';
import { withScope } from '@/server/db/client';
import { can } from '@/server/domain/permissions';
import { MONEY_SCALE, parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import {
  FETCH_LIMIT,
  NODE_CAP,
  ROOT_KINDS,
  ROOT_OBJECT,
  SOURCE_DOCUMENT_OBJECT,
  STEPS,
  stepOf,
  visibleSteps,
  type RelGraph,
  type RelNode,
  type RelStep,
  type RootKind,
} from '@/server/domain/relationships';
import * as control from '@/server/services/control-center';
import * as po from '@/server/services/purchase-order';
import * as relationships from '@/server/services/relationships';
import { READER_CODES } from '@/server/services/relationships';
import type { ActorContext } from '@/server/services/chart-of-accounts';

let world: ChainWorld;
let tracer: Person; // every grant a chain asks for
let officer: Person; // accounting officer
let logistics: Person; // logistics officer
let outsider: Person; // a role that grants nothing
let erbilTracer: Person; // every grant, in the Erbil branch
let supplierCode: string;
let customerCode: string;
let before: Record<string, string>;

const graph = (p: ActorContext, kind: RootKind, key: string): Promise<RelGraph | null> =>
  as(p, (tx) => relationships.graphFor(tx, { principal: p.principal, branchCode: p.branchCode ?? BAGHDAD }, kind, key));

const stepOfGraph = (g: RelGraph, code: string): RelStep => {
  const found = g.steps.find((s) => s.code === code);
  expect(found, `step ${code} of ${g.steps.map((s) => s.code).join(', ')}`).toBeDefined();
  return found!;
};
const codes = (g: RelGraph): string[] => g.steps.map((s) => s.code);
const states = (g: RelGraph): [string, string][] => g.steps.map((s) => [s.code, s.state]);
const labels = (step: RelStep): (string | null)[] => step.nodes.map((n) => n.label);
const keys = (step: RelStep): string[] => step.nodes.map((n) => n.key);
const dec = (value: string | null | undefined): bigint => parseDecimal(value ?? '0', MONEY_SCALE);

async function roleWith(code: string, grants: readonly string[]) {
  await ownerPool.query(`insert into role (code, name) values ($1,$1) on conflict do nothing`, [code]);
  for (const object of grants) await ownerPool.query(`insert into role_grant (role_code, object, verb) values ($1,$2,'view') on conflict do nothing`, [code, object]);
}

/** Every grant a chain asks for: the roots', the steps', and the documents a movement can name. */
const EVERY_GRANT = [
  ...new Set([
    ...Object.values(ROOT_OBJECT),
    ...STEPS.flatMap((s) => s.requires),
    ...Object.values(SOURCE_DOCUMENT_OBJECT),
    'warehouse',
    'item',
    'customer_credit_memo',
    // The Control Center's statement and ageing figures are compared with the chain's.
    'control_center',
  ]),
].sort();

/** A person who holds every grant but one. */
async function without(object: string): Promise<Person> {
  const role = `rel_without_${object}`;
  await roleWith(
    role,
    EVERY_GRANT.filter((g) => g !== object),
  );
  return person(`Without ${object}`, [role]);
}

/** The business tables a read must never touch. */
const WATCHED = ['ap_invoice', 'ar_invoice', 'payable', 'journal_entry', 'journal_line', 'subledger_entry', 'inventory_movement', 'cost_layer', 'shipment_container', 'bill_of_lading', 'customs_pd', 'customs_declaration', 'landed_cost_lock', 'container_receipt', 'audit_event'] as const;
async function snapshot(): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const table of WATCHED) {
    const { rows } = await ownerPool.query(`select count(*)::int as n, coalesce(md5(string_agg(t::text, '|' order by t::text)), '') as h from ${table} t`);
    result[table] = `${rows[0].n}:${rows[0].h}`;
  }
  return result;
}

beforeAll(async () => {
  world = await buildChainWorld();
  await roleWith('rel_all', EVERY_GRANT);
  await roleWith('rel_nothing', []);
  tracer = await person('Tracer', ['rel_all']);
  erbilTracer = await person('Erbil Tracer', ['rel_all'], ERBIL);
  officer = await person('Accounting Officer', ['accounting_officer']);
  logistics = await person('Logistics Officer', ['logistics_officer']);
  outsider = await person('Outsider', ['rel_nothing']);
  supplierCode = (await ownerPool.query(`select code from business_partner where id = $1`, [world.supplierId])).rows[0].code;
  customerCode = (await ownerPool.query(`select code from business_partner where id = $1`, [world.customerId])).rows[0].code;
  before = await snapshot();
}, 300_000);

// ---------------------------------------------------------------------------
describe('REL1 · an import, the whole way', () => {
  it('has a reader for every step of every chain, and a step for every reader', () => {
    expect([...READER_CODES].sort()).toEqual(STEPS.map((s) => s.code).sort());
    for (const kind of ROOT_KINDS) expect(STEPS.some((s) => s.chain === kind), kind).toBe(true);
  });

  it('draws the application, the B/L, the containers, customs, the declaration, landed cost, receipts, stock and layers — in that order', async () => {
    const g = (await graph(tracer, 'import', world.imp.payableNo))!;
    expect(g.root).toMatchObject({ kind: 'import', key: world.imp.payableNo, label: world.imp.payableNo, name: 'Jinko Solar', open: true });
    expect(g.root.href).toContain(world.imp.payableNo);
    expect(states(g)).toEqual([
      ['import.invoice', 'present'],
      ['import.bl', 'present'],
      ['import.container', 'present'],
      ['import.customs', 'present'],
      ['import.declaration', 'present'],
      ['import.landed_cost', 'present'],
      ['import.receipt', 'present'],
      ['import.inventory', 'present'],
      ['import.layer', 'present'],
    ]);
    expect(g.steps.every((s) => s.more === 0 && !s.truncated)).toBe(true);

    const invoice = stepOfGraph(g, 'import.invoice').nodes[0]!;
    expect(invoice).toMatchObject({ kind: 'ap_invoice', key: world.imp.invoiceId, label: world.imp.invoiceNo, from: world.imp.payableNo, status: 'posted' });
    expect(dec(invoice.figure!.value)).toBe(dec('5000000'));

    const bl = stepOfGraph(g, 'import.bl').nodes[0]!;
    expect(bl).toMatchObject({ kind: 'bill_of_lading', key: world.bl.blId, label: world.bl.blNo, from: world.imp.payableNo });
    expect(bl.note).toMatchObject({ key: 'bl', params: { vessel: 'MSC AURORA', etaDate: '2026-08-25' } });

    const containers = stepOfGraph(g, 'import.container');
    expect(labels(containers)).toEqual([expect.any(String), expect.any(String)]);
    expect(new Set(labels(containers))).toEqual(new Set(world.bl.containerIds.length === 2 ? labels(containers) : []));
    expect(containers.nodes.every((n) => n.from === world.bl.blNo && n.statusName)).toBe(true);

    const pd = stepOfGraph(g, 'import.customs').nodes[0]!;
    expect(pd).toMatchObject({ kind: 'customs_pd', key: world.pd.id, label: world.pd.pdNo, from: world.imp.payableNo });
    expect(pd.note).toMatchObject({ key: 'pd', params: { expiryDate: '2027-03-01' } });

    const declaration = stepOfGraph(g, 'import.declaration').nodes[0]!;
    expect(declaration).toMatchObject({ kind: 'customs_declaration', label: world.declarationNo, from: world.pd.pdNo, status: 'cleared' });
    expect(declaration.note).toMatchObject({ key: 'declaration', params: { reference: 'BG-2026-77881' } });

    const lock = stepOfGraph(g, 'import.landed_cost').nodes[0]!;
    expect(lock).toMatchObject({ kind: 'landed_cost_lock', key: world.lockId, label: null });
    expect(dec(lock.figure!.value)).toBe(dec('500000'));

    const receipts = stepOfGraph(g, 'import.receipt');
    expect(labels(receipts)).toEqual(world.receiptNos);
    expect(receipts.nodes.map((n) => n.from)).toEqual(labels(containers));
    expect(receipts.nodes.map((n) => n.date)).toEqual(['2026-08-28', '2026-09-10']);

    const stock = stepOfGraph(g, 'import.inventory').nodes[0]!;
    expect(stock).toMatchObject({ kind: 'stock_position', label: PANEL, from: WAREHOUSE });
    const held = (await ownerPool.query(`select coalesce(sum(held), 0)::text as n from stock_position where item_code = $1 and warehouse_code = $2`, [PANEL, WAREHOUSE])).rows[0].n as string;
    expect(parseQuantity(stock.figure!.value)).toBe(parseQuantity(held));
    expect(parseQuantity(held)).toBeGreaterThan(0n);

    const layers = stepOfGraph(g, 'import.layer');
    expect(layers.nodes.map((n) => n.from)).toEqual(world.receiptNos);
    // The first container's layer sold from (100 panels went out, oldest first); the second untouched.
    expect(layers.nodes.map((n) => parseQuantity(n.figure!.value))).toEqual([parseQuantity('200'), parseQuantity('200')]);
    expect(layers.nodes[0]!.note).toMatchObject({ key: 'layer_item', params: { item: PANEL, warehouse: WAREHOUSE } });
  });

  it('every node is a row, joined to the one before it by the foreign key it already has', async () => {
    const g = (await graph(tracer, 'import', world.imp.payableNo))!;
    const exists = async (table: string, step: string) => {
      const ids = keys(stepOfGraph(g, step));
      const { rows } = await ownerPool.query(`select count(*)::int as n from ${table} where id::text = any($1::text[])`, [ids]);
      expect(rows[0].n, `${step}: ${table}`).toBe(ids.length);
      expect(ids.length).toBeGreaterThan(0);
    };
    await exists('ap_invoice', 'import.invoice');
    await exists('bill_of_lading', 'import.bl');
    await exists('shipment_container', 'import.container');
    await exists('customs_pd', 'import.customs');
    await exists('customs_declaration', 'import.declaration');
    await exists('landed_cost_lock', 'import.landed_cost');
    await exists('container_receipt', 'import.receipt');
    await exists('cost_layer', 'import.layer');

    const join = async (text: string, ids: string[], expected: string) => {
      const { rows } = await ownerPool.query(text, [ids]);
      expect(rows.map((r) => r.v)).toEqual([expected]);
    };
    // invoice → import
    await join(`select distinct p.payable_no as v from ap_invoice i join payable p on p.id = i.payable_id where i.id::text = any($1::text[])`, keys(stepOfGraph(g, 'import.invoice')), world.imp.payableNo);
    // container → B/L
    await join(`select distinct b.bl_no as v from shipment_container c join bill_of_lading b on b.id = c.bl_id where c.id::text = any($1::text[])`, keys(stepOfGraph(g, 'import.container')), world.bl.blNo);
    // declaration → PD
    await join(`select distinct p.pd_no as v from customs_declaration d join customs_pd p on p.id = d.pd_id where d.id::text = any($1::text[])`, keys(stepOfGraph(g, 'import.declaration')), world.pd.pdNo);
    // receipt → container → the same import
    await join(
      `select distinct p.payable_no as v from container_receipt r join payable p on p.id = r.payable_id where r.id::text = any($1::text[])`,
      keys(stepOfGraph(g, 'import.receipt')),
      world.imp.payableNo,
    );
    // layer → the movement that made it → the receipt it came from
    const { rows } = await ownerPool.query(
      `select r.receipt_no as v from cost_layer cl
         join inventory_movement m on m.id = cl.created_by_movement_id
         join container_receipt r on r.id::text = m.source_document_id
        where cl.id::text = any($1::text[]) order by r.receipt_no`,
      [keys(stepOfGraph(g, 'import.layer'))],
    );
    expect(rows.map((r) => r.v)).toEqual([...world.receiptNos].sort());
  });

  it('every node with a page opens a page of the application that the viewer may enter', async () => {
    const g = (await graph(tracer, 'import', world.imp.payableNo))!;
    let opened = 0;
    for (const step of g.steps) {
      for (const node of step.nodes) {
        if (node.href === null) continue;
        expectOpenable(tracer, node.href.replace(/#.*$/, ''));
        opened += 1;
      }
    }
    expect(opened).toBeGreaterThanOrEqual(8);
    expectOpenable(tracer, g.root.href);
  });
});

// ---------------------------------------------------------------------------
describe('REL2 · "not yet" is a fact about the process', () => {
  it('an import with an invoice and nothing shipped is not yet at the B/L, and nothing beyond is drawn', async () => {
    const fresh = await importOf(world, '5', { reference: 'REL-NEW' });
    const g = (await graph(tracer, 'import', fresh.payableId ? await payableNo(fresh.payableId) : ''))!;
    expect(states(g)).toEqual([
      ['import.invoice', 'present'],
      ['import.bl', 'pending'],
    ]);
    expect(stepOfGraph(g, 'import.bl').nodes).toEqual([]);

    // A container shipped: customs and the receipt are what come next; what comes after them is left out, not "not yet".
    await blWith(world, fresh.payableId, [{ no: containerNo('MSCU', 760201), qty: '5' }], { eta: '2026-10-20' });
    const shipped = (await graph(tracer, 'import', await payableNo(fresh.payableId)))!;
    expect(states(shipped)).toEqual([
      ['import.invoice', 'present'],
      ['import.bl', 'present'],
      ['import.container', 'present'],
      ['import.customs', 'pending'],
      ['import.receipt', 'pending'],
    ]);
  });

  it('a draft invoice is drawn as a draft; the shipment is still not yet', async () => {
    const draft = await importOf(world, '3', { reference: 'REL-DRAFT', post: false });
    const g = (await graph(tracer, 'import', await payableNo(draft.payableId)))!;
    expect(stepOfGraph(g, 'import.invoice').nodes[0]).toMatchObject({ label: draft.invoiceNo, status: 'draft' });
    expect(states(g)).toEqual([
      ['import.invoice', 'present'],
      ['import.bl', 'pending'],
    ]);
  });

  it('an import that was cancelled goes on to nothing: its steps are drawn as they are, none "not yet"', async () => {
    const dead = await importOf(world, '2', { reference: 'REL-DEAD' });
    const no = await payableNo(dead.payableId);
    await maintenance((c) =>
      c.query(`update payable set cancelled_at = now(), cancelled_by = $2::uuid, cancel_reason = 'Order withdrawn' where id = $1`, [dead.payableId, tracer.principal.userId]),
    );
    const g = (await graph(tracer, 'import', no))!;
    expect(g.root.open).toBe(false);
    expect(states(g)).toEqual([['import.invoice', 'present']]);
  });

  it('a record that is not an import, a code that does not exist, and a code of the other kind, all draw nothing', async () => {
    expect(await graph(tracer, 'import', 'NO-SUCH-IMPORT')).toBeNull();
    expect(await graph(tracer, 'import', '')).toBeNull();
    expect(await graph(tracer, 'supplier', customerCode)).toBeNull();
    expect(await graph(tracer, 'customer', supplierCode)).toBeNull();
    expect(await graph(tracer, 'item', 'NO-SUCH-ITEM')).toBeNull();
  });
});

const stepsOfImport = (): string[] => STEPS.filter((s) => s.chain === 'import').map((s) => s.code);

async function payableNo(id: string): Promise<string> {
  return (await ownerPool.query(`select payable_no from payable where id = $1`, [id])).rows[0].payable_no as string;
}

// ---------------------------------------------------------------------------
describe('REL3 · a supplier, a customer, an item', () => {
  it('the supplier: orders, receipts, invoices, payments, and the statement and ageing the Control Center reads', async () => {
    const g = (await graph(tracer, 'supplier', supplierCode))!;
    expect(g.root).toMatchObject({ kind: 'supplier', key: supplierCode, name: 'Jinko Solar', open: true });
    const present = g.steps.filter((s) => s.state === 'present').map((s) => s.code);
    expect(present).toEqual(['supplier.purchase_order', 'supplier.goods_receipt', 'supplier.invoice', 'supplier.payment', 'supplier.statement', 'supplier.ageing']);

    // Every order of the supplier, newest first — the import's own and the one this world bought panels on.
    const { rows: orders } = await ownerPool.query(`select order_no from purchase_order where supplier_id = $1 order by order_date desc, order_no desc`, [world.supplierId]);
    expect(orders.length).toBeGreaterThan(1);
    expect(labels(stepOfGraph(g, 'supplier.purchase_order'))).toEqual(orders.map((r) => r.order_no));
    expect(labels(stepOfGraph(g, 'supplier.purchase_order'))).toContain(world.order.orderNo);
    expect(stepOfGraph(g, 'supplier.goods_receipt').nodes[0]).toMatchObject({ label: world.goodsReceiptNo, from: world.order.orderNo });
    const { rows: invoices } = await ownerPool.query(`select invoice_no from ap_invoice where supplier_id = $1`, [world.supplierId]);
    expect([...labels(stepOfGraph(g, 'supplier.invoice'))].sort()).toEqual(invoices.map((r) => r.invoice_no).sort());
    expect(labels(stepOfGraph(g, 'supplier.invoice'))).toContain(world.imp.invoiceNo);
    expect(stepOfGraph(g, 'supplier.payment').nodes[0]).toMatchObject({ label: world.paymentNo, status: 'posted' });
    expect(dec(stepOfGraph(g, 'supplier.payment').nodes[0]!.figure!.value)).toBe(dec('1000000'));

    // The statement and the ageing are the figures the Control Center's payables check compares.
    const run = await as(tracer, (tx) =>
      control.run(tx, { principal: tracer.principal, branchCode: BAGHDAD, only: ['payables.statement_ageing'], host: {} }),
    );
    const check = run.results[0]!;
    expect(dec(stepOfGraph(g, 'supplier.statement').nodes[0]!.figure!.value)).toBe(dec(check.figures.find((f) => f.key === 'statement')!.amountIqd!));
    expect(dec(stepOfGraph(g, 'supplier.ageing').nodes[0]!.figure!.value)).toBe(dec(check.figures.find((f) => f.key === 'ageing')!.amountIqd!));
    expect(dec(stepOfGraph(g, 'supplier.ageing').nodes[0]!.figure!.value)).toBeGreaterThan(0n);
  });

  it('a supplier with an order and nothing received: the receipt and the invoice are not yet; payment, statement and ageing are left out', async () => {
    const { rows } = await ownerPool.query(
      `insert into business_partner (code, legal_name, is_customer, is_supplier, status, active) values ('SUP-REL-NEW','Fresh Supplier',false,true,'active',true) returning id`,
    );
    const order = await withScope(scope(world.clerk), (tx) =>
      po.create(tx, world.clerk, {
        supplierId: rows[0].id,
        branchCode: BAGHDAD,
        orderDate: '2026-09-28',
        lines: [{ lineType: 'inventory_item', itemCode: PANEL, description: 'Panel', quantity: q('4'), uomCode: 'EA', unitPriceIqd: iqd('10000'), branchCode: BAGHDAD, warehouseCode: WAREHOUSE }],
      }),
    );
    await withScope(scope(world.clerk), (tx) => po.submit(tx, world.clerk, order.id));
    await withScope(scope(world.manager), (tx) => po.approve(tx, world.manager, order.id));
    const g = (await graph(tracer, 'supplier', 'SUP-REL-NEW'))!;
    expect(states(g)).toEqual([
      ['supplier.purchase_order', 'present'],
      ['supplier.goods_receipt', 'pending'],
      ['supplier.invoice', 'pending'],
    ]);
  });

  it('the customer: invoice, receipt, credit note, return — each joined to what it came from', async () => {
    const g = (await graph(tracer, 'customer', customerCode))!;
    expect(g.root).toMatchObject({ kind: 'customer', key: customerCode, name: 'Al Noor Trading' });
    expect(g.steps.filter((s) => s.state === 'present').map((s) => s.code)).toEqual([
      'customer.invoice',
      'customer.receipt',
      'customer.credit',
      'customer.return',
      'customer.statement',
      'customer.ageing',
    ]);
    // Posted, then half paid by the receipt: the status is the invoice's own.
    expect(stepOfGraph(g, 'customer.invoice').nodes[0]).toMatchObject({ label: world.sale.invoiceNo, status: 'partially_executed', from: customerCode });
    expect(dec(stepOfGraph(g, 'customer.invoice').nodes[0]!.figure!.value)).toBe(dec('1500000'));
    expect(stepOfGraph(g, 'customer.receipt').nodes[0]).toMatchObject({ label: world.customerReceiptNo });
    expect(dec(stepOfGraph(g, 'customer.receipt').nodes[0]!.figure!.value)).toBe(dec('500000'));
    // The credit note names the return it answers; the return names the invoice it took goods back from.
    expect(stepOfGraph(g, 'customer.credit').nodes[0]).toMatchObject({ label: world.creditMemoNo, from: world.salesReturnNo });
    expect(stepOfGraph(g, 'customer.return').nodes[0]).toMatchObject({ label: world.salesReturnNo, from: world.sale.invoiceNo });
    const run = await as(tracer, (tx) =>
      control.run(tx, { principal: tracer.principal, branchCode: BAGHDAD, only: ['receivables.statement_ageing'], host: {} }),
    );
    const check = run.results[0]!;
    expect(dec(stepOfGraph(g, 'customer.statement').nodes[0]!.figure!.value)).toBe(dec(check.figures.find((f) => f.key === 'statement')!.amountIqd!));
    expect(dec(stepOfGraph(g, 'customer.ageing').nodes[0]!.figure!.value)).toBe(dec(check.figures.find((f) => f.key === 'ageing')!.amountIqd!));
  });

  it('a customer who has bought nothing has no chain: nothing drawn, nothing "not yet"', async () => {
    await ownerPool.query(`insert into business_partner (code, legal_name, is_customer, is_supplier, status, active) values ('CUST-REL-NEW','Fresh Customer',true,false,'active',true)`);
    const g = (await graph(tracer, 'customer', 'CUST-REL-NEW'))!;
    expect(g.steps).toEqual([]);
  });

  it('the item: where it stands, the layers that cost it, the movements that moved it, the documents behind them', async () => {
    const g = (await graph(tracer, 'item', PANEL))!;
    expect(g.root).toMatchObject({ kind: 'item', key: PANEL, label: PANEL, name: 'Solar Panel 550W', open: false });
    expect(g.steps.map((s) => s.code)).toEqual(['item.warehouse', 'item.layer', 'item.movement', 'item.document']);
    expect(g.steps.every((s) => s.state === 'present')).toBe(true);

    // Warehouses: exactly the positions that hold something, with the ledger's own quantity.
    const { rows: positions } = await ownerPool.query(`select warehouse_code, held::text as held from stock_position where item_code = $1 and (held <> 0 or reserved <> 0) order by warehouse_code`, [PANEL]);
    const warehouses = stepOfGraph(g, 'item.warehouse');
    expect(labels(warehouses)).toEqual(positions.map((r) => r.warehouse_code));
    expect(warehouses.nodes.map((n) => parseQuantity(n.figure!.value))).toEqual(positions.map((r) => parseQuantity(r.held)));

    // Layers: every layer with stock left, as the FIFO valuation counts them.
    const { rows: layers } = await ownerPool.query(`select count(*)::int as n from cost_layer where item_code = $1 and remaining_quantity > 0`, [PANEL]);
    const drawn = stepOfGraph(g, 'item.layer');
    expect(drawn.nodes.length + drawn.more).toBe(layers[0].n);

    // Movements: the latest, capped, with the rest counted and not drawn.
    const { rows: moved } = await ownerPool.query(`select count(*)::int as n from inventory_movement where item_code = $1`, [PANEL]);
    const movements = stepOfGraph(g, 'item.movement');
    expect(movements.nodes.length).toBeLessThanOrEqual(NODE_CAP);
    expect(movements.nodes.length + movements.more).toBe(Math.min(moved[0].n, FETCH_LIMIT));
    expect(movements.more).toBeGreaterThan(0);

    // Documents: the documents that moved it, each of a kind the viewer may open.
    const documents = stepOfGraph(g, 'item.document');
    expect(documents.nodes.length).toBeGreaterThan(0);
    for (const node of documents.nodes) {
      expect(SOURCE_DOCUMENT_OBJECT[node.kind], node.kind).toBeDefined();
      if (node.href) expectOpenable(tracer, node.href);
    }
  });
});

// ---------------------------------------------------------------------------
describe('REL4 · who sees what', () => {
  it('a person who may not open the record gets no chain, and a role that grants nothing gets none of the four', async () => {
    for (const [kind, key] of [
      ['import', world.imp.payableNo],
      ['supplier', supplierCode],
      ['customer', customerCode],
      ['item', PANEL],
    ] as const) {
      expect(await graph(outsider, kind, key), `${kind} for the outsider`).toBeNull();
    }
  });

  it('a person in another branch does not even find the import — it is a record they cannot read', async () => {
    expect(await graph(erbilTracer, 'import', world.imp.payableNo)).toBeNull();
    // The supplier is a master record they may open, but the Baghdad documents around it are not theirs: nothing is
    // drawn, and nothing says there is anything to draw.
    const supplier = await graph(erbilTracer, 'supplier', supplierCode);
    expect(supplier).not.toBeNull();
    expect(supplier!.steps).toEqual([]);
    expect(JSON.stringify(supplier)).not.toContain(world.imp.invoiceNo);
    expect(JSON.stringify(supplier)).not.toContain(world.order.orderNo);
    const customer = await graph(erbilTracer, 'customer', customerCode);
    expect(customer!.steps).toEqual([]);
    const item = await graph(erbilTracer, 'item', PANEL);
    // Stock is by branch: the item is theirs to open, the quantities in Baghdad are not.
    expect(JSON.stringify(item)).not.toContain(WAREHOUSE);
    expect(item!.steps.every((s) => s.nodes.length === 0)).toBe(true);
  });

  it('a step the viewer may not open is absent — not empty, not zero — for each grant it needs', async () => {
    const full = (await graph(tracer, 'import', world.imp.payableNo))!;
    for (const object of ['ap_invoice', 'shipment_container', 'customs_declaration', 'customs_pd', 'landed_cost_register', 'inventory_movement', 'bill_of_lading']) {
      const viewer = await without(object);
      const g = (await graph(viewer, 'import', world.imp.payableNo))!;
      const expected = codes(full).filter((code) => !stepOf(code)!.requires.includes(object));
      expect(codes(g), `without ${object}`).toEqual(expected);
      expect(g.steps.every((s) => s.state === 'present'), `without ${object}`).toBe(true);
      // Nothing of the absent steps is anywhere in what the viewer is given.
      const text = JSON.stringify(g);
      if (object === 'ap_invoice') expect(text).not.toContain(world.imp.invoiceNo);
      if (object === 'customs_declaration') expect(text).not.toContain(world.declarationNo);
      if (object === 'shipment_container') for (const no of world.receiptNos) expect(text, no).not.toContain(no);
      if (object === 'landed_cost_register') expect(text).not.toContain('landed_cost_lock');
    }
  });

  it('what the viewer is shown is only what the grants of the real roles open', async () => {
    for (const kind of ROOT_KINDS) {
      const key = kind === 'import' ? world.imp.payableNo : kind === 'supplier' ? supplierCode : kind === 'customer' ? customerCode : PANEL;
      for (const viewer of [officer, logistics, world.manager]) {
        const g = await graph(viewer, kind, key);
        if (!can(viewer.principal, 'view', ROOT_OBJECT[kind])) {
          expect(g, `${kind}`).toBeNull();
          continue;
        }
        if (g === null) continue;
        const allowed = new Set(visibleSteps(kind, viewer.principal).map((s) => s.code));
        for (const step of g.steps) expect(allowed.has(step.code), `${kind}: ${step.code}`).toBe(true);
        // A node's link is given only where the viewer may open the page it names.
        for (const step of g.steps) {
          for (const node of step.nodes) if (node.href) expectOpenable(viewer, node.href.replace(/#.*$/, ''));
        }
      }
    }
    // Whatever a role does not hold is not drawn: the steps of the chain the logistics officer lacks a grant for are absent.
    const asLogistics = (await graph(logistics, 'import', world.imp.payableNo))!;
    const missing = stepsOfImport().filter((code) => !visibleSteps('import', logistics.principal).some((s) => s.code === code));
    for (const code of missing) expect(codes(asLogistics)).not.toContain(code);
  });

  it('a node says where it came from only in numbers the same chain shows: a receipt does not name an invoice the viewer cannot open', async () => {
    const full = (await graph(tracer, 'customer', customerCode))!;
    const receipt = stepOfGraph(full, 'customer.receipt').nodes.find((n) => n.label === world.customerReceiptNo)!;
    expect(receipt.from, 'the receipt names the invoice it was applied to').toBe(world.sale.invoiceNo);

    const viewer = await without('ar_invoice');
    const g = (await graph(viewer, 'customer', customerCode))!;
    expect(codes(g)).not.toContain('customer.invoice');
    const hidden = stepOfGraph(g, 'customer.receipt').nodes.find((n) => n.label === world.customerReceiptNo)!;
    expect(hidden.from).toBeNull();
    expect(JSON.stringify(g)).not.toContain(world.sale.invoiceNo);
    // The credit note still names its return: the viewer sees the returns.
    expect(stepOfGraph(g, 'customer.credit').nodes[0]!.from).toBe(world.salesReturnNo);
  });

  it('a link is not given to a record the viewer cannot open, though the record is shown (the step is theirs)', async () => {
    // Holds the shipping and the stock, but not the item master: the position is drawn, its item link is not.
    const viewer = await without('item');
    const g = (await graph(viewer, 'import', world.imp.payableNo))!;
    const stock = stepOfGraph(g, 'import.inventory').nodes[0]!;
    expect(stock.href).toBeNull();
    const layer = stepOfGraph(g, 'import.layer').nodes[0]!;
    expect(layer.href).not.toBeNull(); // the stock ledger, which the viewer holds
  });
});

// ---------------------------------------------------------------------------
describe('REL5 · one step failing never blanks the chain', () => {
  it('a step that cannot be read is drawn as such; the others are drawn as they are', async () => {
    const locker = await ownerPool.connect();
    try {
      await locker.query('begin');
      await locker.query('lock table container_receipt in access exclusive mode');
      const g = (await as(tracer, async (tx) => {
        await tx.execute(sql`select set_config('statement_timeout', '300', true)`);
        return relationships.graphFor(tx, { principal: tracer.principal, branchCode: BAGHDAD }, 'import', world.imp.payableNo);
      }))!;
      const failed = g.steps.filter((s) => s.state === 'unavailable').map((s) => s.code);
      expect(failed).toContain('import.receipt');
      for (const step of g.steps.filter((s) => s.state === 'unavailable')) expect(step).toMatchObject({ nodes: [], more: 0, truncated: false });
      // Steps that do not read the table are untouched.
      for (const code of ['import.invoice', 'import.bl', 'import.container', 'import.customs', 'import.declaration', 'import.landed_cost']) {
        expect(stepOfGraph(g, code).state, code).toBe('present');
      }
    } finally {
      await locker.query('rollback');
      locker.release();
    }
    const again = (await graph(tracer, 'import', world.imp.payableNo))!;
    expect(again.steps.every((s) => s.state === 'present')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('REL6 · it reads and writes nothing', () => {
  it('no chain of any kind for any viewer changes a business table or the audit trail', async () => {
    const snap = await snapshot();
    for (const viewer of [tracer, officer, logistics, world.manager, outsider, erbilTracer]) {
      for (const [kind, key] of [
        ['import', world.imp.payableNo],
        ['supplier', supplierCode],
        ['customer', customerCode],
        ['item', PANEL],
      ] as const) {
        await graph(viewer, kind, key);
      }
    }
    expect(await snapshot()).toEqual(snap);
    // And nothing was disturbed by the other tests' extra documents in the tables the world built.
    expect(before.audit_event).toBeDefined();
  });

  it('works in a transaction PostgreSQL holds read-only', async () => {
    const g = await as(tracer, async (tx) => {
      await tx.execute(sql`set local transaction_read_only = on`);
      return relationships.graphFor(tx, { principal: tracer.principal, branchCode: BAGHDAD }, 'import', world.imp.payableNo);
    });
    expect(g!.steps.length).toBeGreaterThanOrEqual(9);
  });

  it('draws the same chain twice', async () => {
    const a = await graph(tracer, 'import', world.imp.payableNo);
    const b = await graph(tracer, 'import', world.imp.payableNo);
    expect(b).toEqual(a);
  });

  it('says nothing of a node that carries no more than the page shows: the cap leaves the rest counted', async () => {
    const extra = (node: RelNode) => node.key;
    const g = (await graph(tracer, 'item', PANEL))!;
    for (const step of g.steps) {
      expect(step.nodes.length, step.code).toBeLessThanOrEqual(NODE_CAP);
      expect(new Set(step.nodes.map(extra)).size, `${step.code} is listed once each`).toBe(step.nodes.length);
    }
  });
});
