/**
 * The goods' journey on the import's page — the pure steps (2026-10-07).
 *
 *   * an import held for its advance starts On Process (Without SWIFT), current
 *     while held, with the note naming the application to be paid; once the
 *     release is on the log, On Process is done and In Process is done with the
 *     application that released it;
 *   * an import without an advance (or one agreed before the hold existed)
 *     starts at In Process, done when its invoice posted;
 *   * the logistics steps are done, part-way or pending from the rows alone, a
 *     step whose evidence has no date says so, and a lane the viewer may not
 *     read is not drawn;
 *   * the current step is the first in order that is not done.
 */
import { describe, expect, it } from 'vitest';
import { advanceAmountOf, goodsJourney, goodsWhereNow, heldForAdvance, type GoodsJourneyFacts } from '@/server/domain/import-goods-journey';

const bare: GoodsJourneyFacts = {
  payableNo: 'PAY-HQ-2026-000001',
  advance: null,
  heldOn: null,
  heldNow: false,
  released: null,
  posted: null,
  shipping: { bls: [], containers: [], containersAddedOn: null },
  customs: { pds: [], clearedDeclarations: [] },
  landed: { liveCharges: 0, locks: [] },
};

const advance = {
  invoiceNo: 'PI-HQ-2026-000001',
  posted: true,
  basis: 'percent' as const,
  percent: '20.0000',
  amount: null,
  currency: 'USD',
  applicationNo: 'PAP-HQ-2026-000003',
};

const steps = (facts: GoodsJourneyFacts) => goodsJourney(facts).map((step) => `${step.step}:${step.state}${step.current ? '*' : ''}`);

describe('IMP01 · the goods’ journey', () => {
  it('held for the advance: On Process is current with the note; the rest pending', () => {
    const facts: GoodsJourneyFacts = { ...bare, advance, heldNow: true, heldOn: '2026-09-01', posted: { invoiceNo: advance.invoiceNo, on: '2026-09-01' } };
    expect(heldForAdvance(facts)).toBe(true);
    expect(steps(facts)).toEqual([
      'on_process:partial*',
      'in_process:pending',
      'bl:pending',
      'containers:pending',
      'customs:pending',
      'clearance:pending',
      'landed_cost:pending',
      'received:pending',
    ]);
    const [held] = goodsJourney(facts);
    expect(held).toMatchObject({ on: '2026-09-01', document: { kind: 'purchase_invoice', no: advance.invoiceNo }, detail: { key: 'journey_on_process_amount' } });
    expect(held!.note).toMatchObject({ key: 'journey_held_note', document: { kind: 'payment_application', no: 'PAP-HQ-2026-000003' } });
    expect(advanceAmountOf(advance)).toEqual({ kind: 'percent', value: '20', currency: 'USD' });
    expect(advanceAmountOf({ ...advance, basis: 'amount', percent: null, amount: '2000.0000' })).toEqual({ kind: 'amount', value: '2000.0000', currency: 'USD' });
  });

  it('released: On Process and In Process done, In Process names the application and its date', () => {
    const facts: GoodsJourneyFacts = {
      ...bare,
      advance,
      heldOn: '2026-09-01',
      released: { applicationNo: 'PAP-HQ-2026-000003', on: '2026-09-12' },
      posted: { invoiceNo: advance.invoiceNo, on: '2026-09-01' },
    };
    const journey = goodsJourney(facts);
    expect(journey.slice(0, 3).map((step) => `${step.step}:${step.state}${step.current ? '*' : ''}`)).toEqual(['on_process:done', 'in_process:done', 'bl:pending*']);
    expect(journey[0]!.note).toBeNull();
    expect(journey[1]).toMatchObject({ on: '2026-09-12', document: { kind: 'payment_application', no: 'PAP-HQ-2026-000003' }, detail: { key: 'journey_released' } });
  });

  it('no advance — or one agreed before the hold existed — starts at In Process, the invoice posted', () => {
    const plain: GoodsJourneyFacts = { ...bare, posted: { invoiceNo: 'PI-HQ-2026-000002', on: '2026-09-02' } };
    expect(goodsJourney(plain)[0]).toMatchObject({ step: 'in_process', state: 'done', on: '2026-09-02', detail: { key: 'journey_invoice_posted' } });
    expect(goodsJourney(plain).some((step) => step.step === 'on_process')).toBe(false);
    // Agreed and posted, but nothing was ever held and nothing released: no hold to show.
    const before: GoodsJourneyFacts = { ...plain, advance: { ...advance, applicationNo: null } };
    expect(heldForAdvance(before)).toBe(false);
    expect(goodsJourney(before)[0]!.step).toBe('in_process');
    // Agreed and not posted yet: the hold is still to come.
    const unposted: GoodsJourneyFacts = { ...bare, advance: { ...advance, posted: false } };
    expect(steps(unposted).slice(0, 2)).toEqual(['on_process:pending*', 'in_process:pending']);
    // Nothing posted at all.
    expect(steps(bare)[0]).toBe('in_process:pending*');
  });

  it('the logistics steps follow the rows: part-way, done, and a missing date said so', () => {
    const facts: GoodsJourneyFacts = {
      ...bare,
      posted: { invoiceNo: 'PI-1', on: '2026-09-02' },
      shipping: {
        bls: [{ blNo: 'MEDU000001', blDate: '2026-09-20' }],
        containers: [
          { id: 'c1', containerNo: 'MSCU1234566', customsClearedOn: '2026-10-20', receivedOn: '2026-10-28' },
          { id: 'c2', containerNo: 'MSCU7654321', customsClearedOn: null, receivedOn: null },
        ],
        containersAddedOn: null,
      },
      customs: { pds: [{ pdNo: '9330', year: 2026, statusName: 'Validated', statusDate: '2026-09-05' }], clearedDeclarations: [] },
      landed: { liveCharges: 2, locks: [] },
    };
    expect(steps(facts)).toEqual([
      'in_process:done',
      'bl:done',
      'containers:done',
      'customs:done',
      'clearance:partial*',
      'landed_cost:partial',
      'received:partial',
    ]);
    const byStep = Object.fromEntries(goodsJourney(facts).map((step) => [step.step, step]));
    expect(byStep.containers).toMatchObject({ on: null, detail: { key: 'journey_containers', params: { count: 2 } } });
    expect(byStep.customs).toMatchObject({ on: '2026-09-05', document: { kind: 'pd', no: '9330', year: 2026 } });
    expect(byStep.clearance).toMatchObject({ on: '2026-10-20', detail: { params: { cleared: 1, total: 2 } } });
    expect(byStep.received).toMatchObject({ on: '2026-10-28', document: { kind: 'container', no: 'MSCU1234566', id: 'c1' }, detail: { params: { received: 1, total: 2 } } });

    // All in and locked: every step done, none current.
    const all: GoodsJourneyFacts = {
      ...facts,
      shipping: { ...facts.shipping!, containers: facts.shipping!.containers.map((box) => ({ ...box, customsClearedOn: '2026-10-20', receivedOn: '2026-10-29' })) },
      landed: { liveCharges: 2, locks: [{ sequence: 1, lockDate: '2026-10-30' }] },
    };
    expect(goodsJourney(all).every((step) => step.state === 'done' && !step.current)).toBe(true);
    expect(goodsJourney(all).find((step) => step.step === 'landed_cost')).toMatchObject({ on: '2026-10-30', detail: { params: { sequence: 1 } } });
  });

  it('says where the goods are now — every container on its own, the import split when they are (2026-10-07)', () => {
    const box = (id: string, extra: Partial<NonNullable<GoodsJourneyFacts['shipping']>['containers'][number]>) => ({
      id,
      containerNo: `MSCU${id}`,
      customsClearedOn: null,
      receivedOn: null,
      statusCode: 'not_loaded',
      ...extra,
    });
    const facts: GoodsJourneyFacts = {
      ...bare,
      posted: { invoiceNo: 'PI-1', on: '2026-09-02' },
      shipping: {
        bls: [{ blNo: 'MEDU000001', blDate: '2026-09-20' }],
        containers: [
          box('1', { statusCode: 'received', receivedOn: '2026-10-28', warehouseCode: 'WH-MAIN', warehouseName: 'Main Warehouse' }),
          box('2', { statusCode: 'on_sea', eta: '2026-11-02' }),
          box('3', { statusCode: 'late', eta: '2026-10-01' }),
          box('4', { statusCode: 'at_port', arrivedPortOn: '2026-10-25' }),
          box('5', { statusCode: 'not_loaded' }),
        ],
        containersAddedOn: null,
      },
    };
    const now = goodsWhereNow(facts);
    expect(now.place).toBe('split');
    expect(now.counts.map((row) => `${row.place}:${row.count}`)).toEqual(['in_process:1', 'on_board:2', 'at_port:1', 'received:1']);
    expect(now.counts.find((row) => row.place === 'received')!.warehouses).toEqual(['Main Warehouse']);
    expect(now.containers.map((one) => one.place)).toEqual(['received', 'on_board', 'on_board', 'at_port', 'in_process']);
    expect(now.containers[2]).toMatchObject({ late: true, eta: '2026-10-01' });
    expect(now.containers[3]).toMatchObject({ since: '2026-10-25' });
    // The received step names the warehouse.
    expect(goodsJourney(facts).find((step) => step.step === 'received')).toMatchObject({ state: 'partial', place: ['Main Warehouse'] });

    // All on the sea: one place.
    const sailing: GoodsJourneyFacts = { ...facts, shipping: { ...facts.shipping!, containers: [box('6', { statusCode: 'on_sea' }), box('7', { statusCode: 'on_sea' })] } };
    expect(goodsWhereNow(sailing)).toMatchObject({ place: 'on_board', counts: [{ place: 'on_board', count: 2 }] });

    // No container yet: where the invoice put the goods — held for the advance, or in process; nothing before posting.
    const held: GoodsJourneyFacts = { ...bare, advance, heldNow: true, heldOn: '2026-09-01', posted: { invoiceNo: advance.invoiceNo, on: '2026-09-01' } };
    expect(goodsWhereNow(held).place).toBe('on_process');
    expect(goodsWhereNow({ ...bare, posted: { invoiceNo: 'PI-1', on: '2026-09-02' } }).place).toBe('in_process');
    expect(goodsWhereNow(bare).place).toBeNull();
    // A container not loaded while the goods are held is held with them.
    expect(goodsWhereNow({ ...held, shipping: { ...facts.shipping!, containers: [box('8', {})] } }).containers[0]!.place).toBe('on_process');
  });

  it('a lane the viewer may not read is not drawn', () => {
    const facts: GoodsJourneyFacts = { ...bare, shipping: null, customs: null, landed: null };
    expect(steps(facts)).toEqual(['in_process:pending*']);
    // Declarations alone (no B/L grant) still say whether customs cleared.
    const declared: GoodsJourneyFacts = { ...facts, customs: { pds: [], clearedDeclarations: [{ declarationNo: 'CDN-HQ-2026-000001', statusDate: '2026-10-01' }] } };
    expect(goodsJourney(declared).find((step) => step.step === 'clearance')).toMatchObject({
      state: 'done',
      on: '2026-10-01',
      document: { kind: 'customs_declaration', no: 'CDN-HQ-2026-000001' },
    });
  });
});

describe('IMP01 · a migrated import has no invoice here: its payment applications say where the goods stand (2026-10-13)', () => {
  const waiting = { paid: null, waiting: { applicationNo: 'PAYAPP-HQ-2026-000040' } };
  const paid = { paid: { applicationNo: 'PAYAPP-HQ-2026-000041', on: '2026-06-19' }, waiting: null };
  const bl = { bls: [{ blNo: 'GGZ3177955', blDate: '2026-09-17' }], containers: [], containersAddedOn: null };

  it('waiting for its first SWIFT it is On Process (Without SWIFT), with the application that waits', () => {
    const facts: GoodsJourneyFacts = { ...bare, legacy: waiting };
    expect(steps(facts).slice(0, 3)).toEqual(['on_process:partial*', 'in_process:pending', 'bl:pending']);
    expect(goodsJourney(facts)[0]).toMatchObject({
      document: { kind: 'payment_application', no: 'PAYAPP-HQ-2026-000040' },
      detail: { key: 'journey_legacy_waiting' },
    });
    expect(goodsWhereNow(facts).place).toBe('on_process');
  });

  it('with a SWIFT it is In Process since the SWIFT date, and never shows a hold it did not have', () => {
    const facts: GoodsJourneyFacts = { ...bare, legacy: paid };
    expect(steps(facts).slice(0, 2)).toEqual(['in_process:done', 'bl:pending*']);
    expect(goodsJourney(facts)[0]).toMatchObject({
      on: '2026-06-19',
      document: { kind: 'payment_application', no: 'PAYAPP-HQ-2026-000041' },
      detail: { key: 'journey_legacy_paid' },
    });
    expect(goodsWhereNow(facts).place).toBe('in_process');
  });

  it('goods already on a B/L are past the hold whatever was paid; with nothing recorded nothing is claimed', () => {
    const shipped: GoodsJourneyFacts = { ...bare, legacy: waiting, shipping: bl };
    expect(steps(shipped).slice(0, 2)).toEqual(['in_process:done', 'bl:done']);
    expect(goodsJourney(shipped)[0]).toMatchObject({ on: null, detail: { key: 'journey_legacy_shipped' } });
    const nothing: GoodsJourneyFacts = { ...bare, legacy: { paid: null, waiting: null } };
    expect(steps(nothing)[0]).toBe('in_process:pending*');
    expect(goodsJourney(nothing)[0]).toMatchObject({ detail: { key: 'journey_legacy_unpaid' } });
    expect(goodsWhereNow(nothing).place).toBeNull();
  });

  it('a container tells its own place: on board, at port, received', () => {
    const box = (id: string, statusCode: string) => ({ id, containerNo: `MSCU000000${id}`, customsClearedOn: null, receivedOn: null, statusCode });
    const sailing: GoodsJourneyFacts = {
      ...bare,
      legacy: paid,
      shipping: { ...bl, containers: [box('1', 'on_sea'), box('2', 'at_port'), box('3', 'received')] },
    };
    expect(goodsWhereNow(sailing).containers.map((one) => one.place)).toEqual(['on_board', 'at_port', 'received']);
    expect(goodsWhereNow(sailing).place).toBe('split');
  });

  it('once an invoice posts here the import reads as any other', () => {
    const facts: GoodsJourneyFacts = { ...bare, legacy: waiting, posted: { invoiceNo: 'PUR-HQ-2026-000009', on: '2026-10-13' } };
    expect(goodsJourney(facts)[0]).toMatchObject({ step: 'in_process', state: 'done', detail: { key: 'journey_invoice_posted' } });
    expect(goodsWhereNow(facts).place).toBe('in_process');
  });
});
