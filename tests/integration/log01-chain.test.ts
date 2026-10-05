/**
 * REQ-LOG-001 item 25 — the chain, end to end:
 *
 *   Import → Shipment (B/L) → Containers → PD → Customs Declaration →
 *   Clearance → Landed Costs → Goods Receipt → Inventory
 *
 * with the owner's scenario: 500 shipped → 300 received → 200 in transit →
 * the remaining 200 received later. At every step the Logistics reads say
 * the same as the engines they read, and goods in transit are never on hand
 * and never available.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { containerNo } from '../support/container-number';
import { ownerPool, rejection } from './setup';
import { withScope } from '@/server/db/client';
import * as declarations from '@/server/services/customs-declarations';
import * as landed from '@/server/services/landed-cost';
import * as views from '@/server/services/logistics-views';
import * as payables from '@/server/services/payables';
import { formatQuantity } from '@/server/domain/uom';
import {
  IN_PROCESS,
  PANEL,
  WAREHOUSE,
  blWith,
  buildImportWorld,
  charge,
  importOf,
  iqd,
  ledgerBalance,
  lock,
  pdTo,
  receive,
  registerPd,
  scope,
  type ImportWorld,
} from './logistics-fixture';

let world: ImportWorld;
const FIRST = containerNo('MSCU', 500001);
const SECOND_BOX = containerNo('MSCU', 500002);

beforeEach(async () => {
  world = await buildImportWorld();
});

const inTransitRow = async (payableId: string) =>
  (await withScope(scope(world.clerk), (tx) => views.inTransitInventory(tx, { payableId }))).rows.find((row) => row.itemCode === PANEL)!;
const available = async (warehouseCode: string) =>
  (await ownerPool.query(`select coalesce(sum(available), 0)::numeric(24,6)::text as n from stock_position where item_code = $1 and warehouse_code = $2`, [PANEL, warehouseCode])).rows[0].n as string;

describe('log01 · 500 shipped, 300 received, 200 in transit, 200 received later', () => {
  it('walks the chain, and every Logistics read agrees with the ledger at each step', async () => {
    // ── Import: 500 panels, posted → 500 in the In Process transit warehouse.
    const { payableId, invoiceNo } = await importOf(world, '500', { reference: 'CHAIN-500' });
    expect(await ledgerBalance(IN_PROCESS)).toBe('500.000000');
    expect(await ledgerBalance(WAREHOUSE)).toBe('0.000000');
    // The view holds the 500 in the transit warehouse (`held`) with nothing on hand and nothing available
    // (0287) — the ledger's sum, which the In-Transit read labels in transit, never on hand (REQ-LOG-001 §2).
    expect(await available(IN_PROCESS)).toBe('0.000000');

    let row = await inTransitRow(payableId);
    expect(row).toMatchObject({ ordered: '500', shipped: '0', inTransit: '500', received: '0', onHandFromImport: '0', invoiceNos: invoiceNo });
    expect(row.inTransitValueIqd).toBe('5000000.0000');

    // ── Shipment: one B/L, two containers — 300 and 200.
    const bl = await blWith(world, payableId, [
      { no: FIRST, qty: '300' },
      { no: SECOND_BOX, qty: '200' },
    ]);
    row = await inTransitRow(payableId);
    expect(row).toMatchObject({ shipped: '500', inTransit: '500', containers: 2, containersOpen: 2 });

    const shipmentsRegister = await withScope(scope(world.clerk), (tx) => views.shipmentsRegister(tx, { view: 'open' }));
    expect(shipmentsRegister.rows.map((r) => [r.blNos, r.containerCount, r.received, r.open])).toEqual([[bl.blNo, 2, 0, 2]]);
    const tracking = await withScope(scope(world.clerk), (tx) => views.shipmentTracking(tx, { asOf: '2026-08-01' }));
    expect(tracking.rows.map((r) => [r.containerNo, r.statusCode, r.nextAction, r.delayDays])).toEqual([
      [FIRST, 'not_loaded', 'load', 0],
      [SECOND_BOX, 'not_loaded', 'load', 0],
    ]);

    // ── PD, and the declaration against it: Draft → Submitted → Accepted → Assessed → Cleared.
    const pd = await registerPd(world, payableId, '9330');
    await pdTo(world, pd.id, 'validated', '2026-07-05');
    const declared = await withScope(scope(world.clerk), (tx) =>
      declarations.create(tx, world.clerk, {
        payableId,
        pdId: pd.id,
        declarationDate: '2026-08-20',
        currency: 'IQD',
        declaredValue: iqd('5000000'),
        declaredDuty: iqd('250000'),
        declaredTaxes: iqd('50000'),
        declaredFees: iqd('20000'),
        hsCode: '8541.43',
      }),
    );
    expect(declared.declarationNo).toMatch(/^CDN-BGW-2026-\d{6}$/);
    const move = (to: string, extra: Partial<declarations.MoveInput> = {}) =>
      withScope(scope(world.clerk), (tx) => declarations.move(tx, world.clerk, declared.id, { to, on: '2026-08-21', ...extra }));
    // Forward only, one step at a time, and Accepted needs customs' own number.
    expect(await rejection(move('cleared'))).toMatch(/from there it goes to submitted, cancelled/);
    await move('submitted');
    expect(await rejection(move('accepted'))).toMatch(/Customs gives its own number/);
    await move('accepted', { customsRef: 'BG-2026-77881' });
    await move('assessed');
    await move('cleared', { on: '2026-08-22' });
    const view = await withScope(scope(world.clerk), (tx) => declarations.viewByNo(tx, declared.declarationNo));
    expect(view.declaration.status).toBe('cleared');
    expect(view.isFinal).toBe(true);
    // The declared figures are words; nothing posted, nothing charged yet.
    expect(view.charged.totalIqd).toBe('0.0000');
    expect(view.declaredChargesTotal).toBe('320000.0000');

    // ── Clearance: the customs cost actually charged (the broker's journal) — declared beside charged.
    await charge(world, payableId, 'customs_asycuda', '300000');
    await charge(world, payableId, 'freight', '200000');
    const compared = await withScope(scope(world.clerk), (tx) => declarations.viewByNo(tx, declared.declarationNo));
    expect(compared.charged.totalIqd).toBe('300000.0000');
    expect(compared.charged.unlockedIqd).toBe('300000.0000');
    expect(compared.declaredChargesTotal).toBe('320000.0000'); // 20,000 apart: information, not an error.
    const duties = await withScope(scope(world.clerk), (tx) => views.dutiesRegister(tx, {}));
    expect(duties.rows.map((r) => [r.chargeTypeCode, r.amountIqd, r.state, r.pdSummary])).toEqual([['customs_asycuda', '300000.0000', 'unlocked', '9330 · Validated']]);
    const freight = await withScope(scope(world.clerk), (tx) => views.freightRegister(tx, {}));
    expect(freight.rows.map((r) => [r.chargeTypeCode, r.amountIqd, r.state])).toEqual([['freight', '200000.0000', 'unlocked']]);

    // ── Goods receipt 1: the first container, 300 — 300 on hand, 200 still in transit.
    const first = await receive(world, bl.containerIds[0]!, { on: '2026-08-28' });
    expect(first.receiptNo).toMatch(/^CREC-BGW-2026-\d{6}$/);
    expect(await ledgerBalance(IN_PROCESS)).toBe('200.000000');
    expect(await ledgerBalance(WAREHOUSE)).toBe('300.000000');
    expect(await available(WAREHOUSE)).toBe('300.000000');
    expect(await available(IN_PROCESS)).toBe('0.000000');
    row = await inTransitRow(payableId);
    expect(row).toMatchObject({ ordered: '500', shipped: '500', inTransit: '200', received: '300', onHandFromImport: '300', containersOpen: 1 });
    expect(row.inTransitValueIqd).toBe('2000000.0000');
    expect(row.transitWarehouses).toBe(`${IN_PROCESS} 200`);
    expect(row.receivedWarehouses).toBe(`${WAREHOUSE} 300`);
    // The ledger's transit balance and the import rows agree; the engines' own position says the same.
    const ledger = await withScope(scope(world.clerk), (tx) => views.transitWarehouses(tx));
    expect(ledger.rows.map((r) => [r.warehouseCode, r.itemCode, r.ledgerQuantity, r.available])).toEqual([[IN_PROCESS, PANEL, '200', '0']]);
    expect(await withScope(scope(world.clerk), (tx) => views.inTransitReconciliation(tx))).toEqual([]);
    const position = await withScope(scope(world.clerk), (tx) => payables.quantityPosition(tx, payableId));
    expect(formatQuantity(position.lines[0]!.inTransit)).toBe('200');
    expect(formatQuantity(position.lines[0]!.received)).toBe('300');

    // ── Landed cost: not lockable while a container is at sea, nor while the PD stands.
    let register = await withScope(scope(world.clerk), (tx) => views.landedCostsRegister(tx, {}));
    expect(register.rows.map((r) => [r.payableNo, r.state, r.allocation, r.unlockedIqd, r.containersReceived, r.containerCount])).toEqual([
      [expect.any(String), 'waiting_pds', 'none', '500000.0000', 1, 2],
    ]);
    await pdTo(world, pd.id, 'totally_written_off', '2026-08-29');
    register = await withScope(scope(world.clerk), (tx) => views.landedCostsRegister(tx, {}));
    expect(register.rows[0]!.state).toBe('waiting_containers');
    expect(await rejection(lock(world, payableId))).toMatch(/container|received/i);

    // ── Goods receipt 2: the remaining 200, later — nothing left in transit.
    await receive(world, bl.containerIds[1]!, { on: '2026-09-10' });
    expect(await ledgerBalance(IN_PROCESS)).toBe('0.000000');
    expect(await ledgerBalance(WAREHOUSE)).toBe('500.000000');
    row = await inTransitRow(payableId);
    expect(row).toMatchObject({ inTransit: '0', received: '500', onHandFromImport: '500', containersOpen: 0, transitWarehouses: null });
    expect((await withScope(scope(world.clerk), (tx) => views.transitWarehouses(tx))).rows).toEqual([]);
    expect((await withScope(scope(world.clerk), (tx) => views.shipmentTracking(tx, { view: 'open' }))).rows).toEqual([]);
    const facts = await withScope(scope(world.clerk), (tx) => payables.gatherFacts(tx, payableId));
    expect(facts.receivedQuantityMatches).toBe(true);
    expect(facts.allPdsWrittenOff).toBe(true);

    // ── Landed cost locked: 500,000 over 500 panels — every layer restated to 11,000.
    register = await withScope(scope(world.clerk), (tx) => views.landedCostsRegister(tx, { view: 'ready' }));
    expect(register.rows.map((r) => r.state)).toEqual(['ready']);
    const done = await lock(world, payableId, { basisCode: 'by_quantity', lockDate: '2026-09-12' });
    expect([done.totalIqd, done.inventoryIqd, done.cogsIqd]).toEqual(['500000.0000', '500000.0000', '0.0000']);

    // ── Inventory: the final cost the warehouse holds, and the registers say locked and allocated.
    const final = await withScope(scope(world.clerk), (tx) => landed.finalCost(tx, payableId));
    expect(final).toEqual([
      {
        itemCode: PANEL,
        receivedQty: '500',
        onHandQty: '500',
        invoicedUnitIqd: '10000.0000',
        chargesUnitIqd: '1000.0000',
        finalUnitIqd: '11000.0000',
        chargesIqd: '500000.0000',
        finalValueIqd: '5500000.0000',
      },
    ]);
    register = await withScope(scope(world.clerk), (tx) => views.landedCostsRegister(tx, {}));
    expect(register.rows[0]).toMatchObject({ state: 'locked', allocation: 'complete', lockedIqd: '500000.0000', unlockedIqd: '0.0000', finalValueIqd: '5500000.0000', receivedQty: '500', onHandQty: '500' });
    const allocation = await withScope(scope(world.clerk), (tx) => views.costAllocation(tx, { payableId }));
    expect(allocation.rows).toHaveLength(2);
    expect(allocation.rows.map((r) => [r.layerOriginalQty, r.unitCostBefore, r.unitCostAfter, r.layerUnitCostNow, r.allocatedIqd, r.inventoryIqd, r.cogsIqd, r.entryNo !== null])).toEqual([
      ['300', '10000.0000', '11000.0000', '11000.0000', '300000.0000', '300000.0000', '0.0000', true],
      ['200', '10000.0000', '11000.0000', '11000.0000', '200000.0000', '200000.0000', '0.0000', true],
    ]);
    expect(allocation.rows.every((r) => r.lockId === done.id)).toBe(true);
    const locks = await withScope(scope(world.clerk), (tx) => views.locks(tx, { payableId }));
    expect(locks.map((k) => [k.sequence, k.totalIqd, k.layers, k.charges, k.journalStatus])).toEqual([[1, '500000.0000', 2, 2, 'posted']]);
    const dutiesAfter = await withScope(scope(world.clerk), (tx) => views.dutiesRegister(tx, { state: 'locked' }));
    expect(dutiesAfter.rows.map((r) => [r.state, r.lockSequence, r.entryNo !== null])).toEqual([['locked', 1, true]]);
    const declaredAfter = await withScope(scope(world.clerk), (tx) => declarations.viewByNo(tx, declared.declarationNo));
    expect(declaredAfter.charged.lockedIqd).toBe('300000.0000');

    // The journey, in the import's own log.
    const { rows: log } = await ownerPool.query(`select event_code from payable_event where payable_id = $1 order by recorded_at, id`, [payableId]);
    const codes = log.map((r) => r.event_code as string);
    for (const expected of ['PD_SUBMITTED', 'DECLARATION_RAISED', 'DECLARATION_MOVED', 'DECLARATION_CLEARED', 'CONTAINER_RECEIVED', 'ALL_CONTAINERS_RECEIVED', 'LANDED_COST_LOCKED']) {
      expect(codes, expected).toContain(expected);
    }
  });
});
