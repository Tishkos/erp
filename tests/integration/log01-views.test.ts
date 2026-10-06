/**
 * REQ-LOG-001 — the registers the four Logistics headings show, read over
 * the engines' own rows (`services/logistics-views.ts`), and the print
 * models the four doors need (`print/logistics-documents.ts`).
 *
 *   documents  Customs Documents and Shipment Documents list the files the
 *              records' own paperclips hold — no second document system.
 *   tracking   Every live container, how late, what it waits for next; the
 *              Shipments register is one row per import with a B/L.
 *   charges    The duty and freight registers are the import's charges by
 *              state; withdrawn ones say so.
 *   print      The PD, the container, its receipt, the declaration and the
 *              port each build a document from the reader's own scope.
 *   grants     0300 / 0301: the new menu objects are held by the roles that
 *              hold what they read, and by nobody else.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { containerNo } from '../support/container-number';
import { ownerPool } from './setup';
import { withScope } from '@/server/db/client';
import * as attachments from '@/server/services/attachments';
import * as declarations from '@/server/services/customs-declarations';
import * as landed from '@/server/services/landed-cost';
import * as views from '@/server/services/logistics-views';
import * as shipments from '@/server/services/shipments';
import { registerAllRecords } from '@/server/records';
import { messagesFor } from '@/server/print/i18n';
import * as docs from '@/server/print/logistics-documents';
import { EXPORT_ACCESS, mayExport } from '@/server/print/access';
import { blWith, buildImportWorld, charge, importOf, iqd, lock, pdTo, receive, registerPd, scope, type ImportWorld } from './logistics-fixture';

let world: ImportWorld;
let payableId: string;
let payableNo: string;
let bl: Awaited<ReturnType<typeof blWith>>;
let pdId: string;
const BOX_A = containerNo('TGHU', 700001);
const BOX_B = containerNo('TGHU', 700002);

beforeEach(async () => {
  world = await buildImportWorld();
  ({ payableId } = await importOf(world, '400', { reference: 'VIEWS-1' }));
  payableNo = (await ownerPool.query(`select payable_no from payable where id = $1`, [payableId])).rows[0].payable_no;
  bl = await blWith(world, payableId, [
    { no: BOX_A, qty: '250' },
    { no: BOX_B, qty: '150' },
  ], { eta: '2026-08-10' });
  pdId = (await registerPd(world, payableId, '8100')).id;
});

const build = () => ({ tx: null as never, principal: world.manager.principal, branchCode: 'BGW', locale: 'en' as const, m: messagesFor('en') });

describe('documents · the files the records hold, by the record', () => {
  it('lists customs and shipment papers with the record each hangs on, and nothing twice', async () => {
    registerAllRecords();
    const upload = (objectType: string, objectId: string, fileName: string) =>
      withScope(scope(world.clerk), (tx) => attachments.upload(tx, world.clerk, { objectType, objectId, fileName, content: Buffer.from(`paper ${fileName}`) }));
    const declared = await withScope(scope(world.clerk), (tx) => declarations.create(tx, world.clerk, { payableId, pdId, declaredValue: iqd('4000000') }));
    await upload('customs_pd', pdId, 'pd-8100.txt');
    await upload('customs_declaration', declared.id, 'lodgement.txt');
    await upload('bill_of_lading', bl.blId, 'bl-original.txt');
    await upload('shipment_container', bl.containerIds[0]!, 'seal-photo.txt');
    await upload('payable', payableId, 'proforma.txt');
    // The import's sections keep their own papers (2026-10-06): customs and shipping ones are listed with the import.
    await upload('payable_customs', payableId, 'broker-letter.txt');
    await upload('payable_shipment', payableId, 'packing-list.txt');
    await upload('payable_payments', payableId, 'swift-copy.txt');

    const customsDocs = await withScope(scope(world.clerk), (tx) => views.documentsRegister(tx, 'customs', {}));
    expect(customsDocs.rows.map((r) => [r.objectType, r.fileName, r.recordNo, r.payableNo]).sort()).toEqual([
      ['customs_declaration', 'lodgement.txt', declared.declarationNo, payableNo],
      ['customs_pd', 'pd-8100.txt', '8100', payableNo],
      ['payable_customs', 'broker-letter.txt', payableNo, payableNo],
    ]);
    const shipmentDocs = await withScope(scope(world.clerk), (tx) => views.documentsRegister(tx, 'shipment', {}));
    expect(shipmentDocs.rows.map((r) => [r.objectType, r.fileName, r.recordNo]).sort()).toEqual([
      ['bill_of_lading', 'bl-original.txt', bl.blNo],
      ['payable', 'proforma.txt', payableNo],
      ['payable_shipment', 'packing-list.txt', payableNo],
      ['shipment_container', 'seal-photo.txt', BOX_A],
    ]);
    const onlyBls = await withScope(scope(world.clerk), (tx) => views.documentsRegister(tx, 'shipment', { objectType: 'bill_of_lading' }));
    expect(onlyBls.total).toBe(1);
    const searched = await withScope(scope(world.clerk), (tx) => views.documentsRegister(tx, 'shipment', { search: 'seal' }));
    expect(searched.rows.map((r) => r.fileName)).toEqual(['seal-photo.txt']);
  });
});

describe('tracking and shipments · where every container is', () => {
  it('says the stage, the delay and the next action, and one row per import with its B/Ls', async () => {
    const moveTo = (id: string, statusCode: string, statusDate: string) =>
      withScope(scope(world.clerk), (tx) => shipments.changeStatus(tx, world.clerk, id, { statusCode, date: statusDate }));
    await moveTo(bl.containerIds[0]!, 'on_sea', '2026-07-22');
    await moveTo(bl.containerIds[0]!, 'at_port', '2026-08-12');
    await moveTo(bl.containerIds[0]!, 'customs_cleared', '2026-08-14');
    await moveTo(bl.containerIds[1]!, 'on_sea', '2026-07-22');

    const onTime = await withScope(scope(world.clerk), (tx) => views.shipmentTracking(tx, { asOf: '2026-08-05' }));
    expect(onTime.rows.map((r) => [r.containerNo, r.statusCode, r.delayDays, r.nextAction])).toEqual([
      [BOX_A, 'customs_cleared', 0, 'send_port_file'],
      [BOX_B, 'on_sea', 0, 'await_arrival'],
    ]);
    const late = await withScope(scope(world.clerk), (tx) => views.shipmentTracking(tx, { asOf: '2026-08-17' }));
    expect(late.rows.map((r) => [r.containerNo, r.delayDays, r.pdSummary, r.customsClearedOn])).toEqual([
      [BOX_A, 7, '8100 · Submitted', '2026-08-14'],
      [BOX_B, 7, '8100 · Submitted', null],
    ]);
    await withScope(scope(world.clerk), (tx) => shipments.portFileSent(tx, world.clerk, bl.containerIds[0]!, '2026-08-15'));
    expect((await withScope(scope(world.clerk), (tx) => views.shipmentTracking(tx, { view: 'cleared' }))).rows.map((r) => r.nextAction)).toEqual(['receive']);
    await receive(world, bl.containerIds[0]!, { on: '2026-08-16' });
    const open = await withScope(scope(world.clerk), (tx) => views.shipmentTracking(tx, { view: 'open' }));
    expect(open.rows.map((r) => r.containerNo)).toEqual([BOX_B]);
    const all = await withScope(scope(world.clerk), (tx) => views.shipmentTracking(tx, { view: 'all' }));
    expect(all.rows.find((r) => r.containerNo === BOX_A)).toMatchObject({ statusCode: 'received', delayDays: null, nextAction: null, warehouseCode: 'WH-MAIN' });

    const register = await withScope(scope(world.clerk), (tx) => views.shipmentsRegister(tx, {}));
    expect(register.rows.map((r) => [r.payableNo, r.blNos, r.containerCount, r.received, r.open, r.leastStatusCode, r.ports, r.pdSummary])).toEqual([
      [payableNo, bl.blNo, 2, 1, 1, 'on_sea', 'Shanghai → Umm Qasr', '8100 · Submitted'],
    ]);
    expect((await withScope(scope(world.clerk), (tx) => views.shipmentsRegister(tx, { view: 'arrived' }))).rows).toEqual([]);
    expect((await withScope(scope(world.clerk), (tx) => views.shipmentsRegister(tx, { search: BOX_B }))).total).toBe(1);
    expect((await withScope(scope(world.clerk), (tx) => views.shipmentsRegister(tx, { search: 'nothing-like-this' }))).total).toBe(0);
  });
});

describe('charges and allocation · the import’s money, by state', () => {
  it('lists duties and freight by state, totals them, and reads the allocation lock by lock', async () => {
    await charge(world, payableId, 'customs_asycuda', '120000');
    const freight = await charge(world, payableId, 'freight', '80000');
    const extra = await charge(world, payableId, 'other', '5000', 'Fumigation');
    await withScope(scope(world.manager), (tx) => landed.cancelCharge(tx, world.manager, extra.id, 'Wrong import'));

    let duties = await withScope(scope(world.clerk), (tx) => views.dutiesRegister(tx, {}));
    expect(duties.rows.map((r) => [r.chargeTypeCode, r.amountIqd, r.state, r.payableNo])).toEqual([['customs_asycuda', '120000.0000', 'unlocked', payableNo]]);
    let freightRows = await withScope(scope(world.clerk), (tx) => views.freightRegister(tx, {}));
    expect(freightRows.rows.map((r) => [r.chargeTypeCode, r.state, r.cancelReason])).toEqual([
      ['other', 'withdrawn', 'Wrong import'],
      ['freight', 'unlocked', null],
    ]);
    expect((await withScope(scope(world.clerk), (tx) => views.freightRegister(tx, { state: 'withdrawn' }))).rows.map((r) => r.id)).toEqual([extra.id]);
    expect((await withScope(scope(world.clerk), (tx) => views.freightRegister(tx, { state: 'unlocked' }))).rows.map((r) => r.id)).toEqual([freight.id]);
    expect(await withScope(scope(world.clerk), (tx) => views.chargeTotals(tx, ['freight', 'port_forwarding', 'other']))).toEqual({ lockedIqd: '0.0000', unlockedIqd: '80000.0000', live: 1 });

    // Lock: both containers in, the PD written off.
    await receive(world, bl.containerIds[0]!);
    await receive(world, bl.containerIds[1]!);
    await pdTo(world, pdId, 'totally_written_off', '2026-08-29');
    const done = await lock(world, payableId, { basisCode: 'by_quantity' });
    duties = await withScope(scope(world.clerk), (tx) => views.dutiesRegister(tx, {}));
    expect(duties.rows[0]).toMatchObject({ state: 'locked', lockSequence: 1, lockDate: '2026-08-30' });
    expect(duties.rows[0]!.entryNo).toMatch(/^JE-/);
    expect((await withScope(scope(world.clerk), (tx) => views.chargeTotals(tx, ['customs_asycuda']))).lockedIqd).toBe('120000.0000');

    const register = await withScope(scope(world.clerk), (tx) => views.landedCostsRegister(tx, { view: 'locked' }));
    expect(register.rows.map((r) => [r.payableNo, r.state, r.allocation, r.lockCount, r.lockedIqd, r.inventoryIqd, r.cogsIqd, r.finalValueIqd])).toEqual([
      [payableNo, 'locked', 'complete', 1, '200000.0000', '200000.0000', '0.0000', '4200000.0000'],
    ]);
    const allocation = await withScope(scope(world.clerk), (tx) => views.costAllocation(tx, { lockId: done.id }));
    expect(allocation.rows.map((r) => [r.layerOriginalQty, r.unitCostBefore, r.unitCostAfter, r.allocatedIqd])).toEqual([
      ['250', '10000.0000', '10500.0000', '125000.0000'],
      ['150', '10000.0000', '10500.0000', '75000.0000'],
    ]);
    expect(allocation.rows[0]!.charges).toContain('customs_asycuda');
    expect(allocation.rows[0]!.charges).toContain('freight');
    // A late charge: the register says so, and the duty beside it stays locked.
    await charge(world, payableId, 'port_forwarding', '10000');
    expect((await withScope(scope(world.clerk), (tx) => views.landedCostsRegister(tx, {}))).rows[0]).toMatchObject({ state: 'late_charges', allocation: 'partial', unlockedIqd: '10000.0000' });
  });
});

describe('print · the four doors’ printer', () => {
  it('builds the PD, the container, its receipt, the declaration and the port from the reader’s scope', async () => {
    const receipt = await receive(world, bl.containerIds[0]!, { on: '2026-08-16' });
    const declared = await withScope(scope(world.clerk), (tx) => declarations.create(tx, world.clerk, { payableId, pdId, declaredValue: iqd('4000000'), declaredDuty: iqd('200000') }));
    await charge(world, payableId, 'customs_asycuda', '210000');

    const ctx = build();
    const pd = await withScope(scope(world.manager), (tx) => docs.customsPd({ ...ctx, tx }, '8100'));
    expect(pd?.model).toMatchObject({ kind: 'document', number: '8100', title: 'Customs Pre-Declaration' });
    expect(pd?.model.tables[1]?.rows.map((r) => [r.cells.bl, r.cells.container, r.cells.received])).toEqual([
      [bl.blNo, BOX_A, '2026-08-16'],
      [bl.blNo, BOX_B, null],
    ]);
    const container = await withScope(scope(world.manager), (tx) => docs.shipmentContainer({ ...ctx, tx }, BOX_B));
    expect(container?.model).toMatchObject({ number: BOX_B, title: 'Container' });
    expect(container?.model.fields.find((f) => f.label === 'Customs status')?.value).toBe('8100 · Submitted');
    const paper = await withScope(scope(world.manager), (tx) => docs.containerReceipt({ ...ctx, tx }, receipt.receiptNo));
    expect(paper?.model).toMatchObject({ number: receipt.receiptNo, title: 'Container Receipt', signatures: true });
    expect(paper?.model.tables[0]?.totals?.cells).toMatchObject({ moved: '250', cost: '2500000.0000' });
    const declaration = await withScope(scope(world.manager), (tx) => docs.customsDeclaration({ ...ctx, tx }, declared.declarationNo));
    expect(declaration?.model).toMatchObject({ number: declared.declarationNo, title: 'Customs Declaration', posted: false, status: 'Draft' });
    expect(declaration?.model.tables[0]?.rows.map((r) => r.cells.amount)).toEqual(['210000.0000']);
    expect(declaration?.model.summary.map((f) => f.value)).toEqual(['IQD 200000.0000', '210000.0000', '0.0000']);
    const port = await withScope(scope(world.manager), (tx) => docs.port({ ...ctx, tx }, 'PRT-0001'));
    expect(port?.model).toMatchObject({ number: 'PRT-0001', title: 'Port' });
    expect(port?.model.tables[0]?.rows.map((r) => r.cells.bl)).toEqual([bl.blNo]);
    // Nothing for a number that is not there.
    expect(await withScope(scope(world.manager), (tx) => docs.customsDeclaration({ ...ctx, tx }, 'CDN-NOPE'))).toBeNull();
    expect(await withScope(scope(world.manager), (tx) => docs.containerReceipt({ ...ctx, tx }, 'CREC-NOPE'))).toBeNull();
    // Access: the PD's copy under customs_pd, the receipt's under the container's object.
    expect(EXPORT_ACCESS.customs_pd.object).toBe('customs_pd');
    expect(EXPORT_ACCESS.container_receipt.object).toBe('shipment_container');
    expect(mayExport(world.manager.principal, 'customs_declaration', 'pdf')).toBe(true);
  });
});

describe('grants · 0300 and 0301, held by whoever reads what they read', () => {
  it('gives each new object to the roles of the object it reads, and the declaration the PD’s verbs', async () => {
    const holders = async (object: string, verb: string) =>
      (await ownerPool.query(`select role_code from role_grant where object = $1 and verb = $2 order by role_code`, [object, verb])).rows.map((r) => r.role_code as string);
    const union = (a: string[], b: string[]) => [...new Set([...a, ...b])].sort();
    expect(await holders('in_transit', 'view')).toEqual(union(await holders('supplier_shipment', 'view'), await holders('shipment_container', 'view')));
    expect(await holders('landed_cost_register', 'view')).toEqual(await holders('landed_cost', 'view'));
    expect(await holders('cost_allocation', 'view')).toEqual(await holders('landed_cost', 'view'));
    expect(await holders('customs_duty', 'view')).toEqual(union(await holders('landed_cost', 'view'), await holders('customs_pd', 'create')));
    expect(await holders('freight_cost', 'view')).toEqual(union(await holders('landed_cost', 'view'), await holders('bill_of_lading', 'create')));
    expect(await holders('port', 'view')).toEqual(await holders('bill_of_lading', 'view'));
    expect(await holders('port', 'create')).toEqual(await holders('bill_of_lading', 'create'));
    expect(await holders('customs_declaration', 'view')).toEqual(await holders('customs_pd', 'view'));
    expect(await holders('customs_declaration', 'create')).toEqual(await holders('customs_pd', 'create'));
    expect(await holders('customs_declaration', 'submit')).toEqual(await holders('customs_pd', 'edit_draft'));
    expect(await holders('customs_declaration', 'reverse_cancel')).toEqual(await holders('customs_pd', 'import'));
    expect(await holders('customs_pd', 'print')).toEqual(await holders('customs_pd', 'view'));
    expect(await holders('shipment_container', 'print')).toEqual(await holders('shipment_container', 'view'));
    // Nobody got a write on the money through a Logistics heading.
    for (const object of ['customs_duty', 'freight_cost', 'landed_cost_register', 'cost_allocation', 'in_transit']) {
      const { rows } = await ownerPool.query(`select distinct verb::text from role_grant where object = $1 and verb not in ('view', 'print', 'export')`, [object]);
      expect(rows, object).toEqual([]);
    }
  });
});
