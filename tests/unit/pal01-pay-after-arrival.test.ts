/**
 * Imports paid after the goods arrive (0426) — the pure rules: where a payment
 * clock starts, the register's filter value, the refusal of an advance, and
 * what the goods journey says of such an import.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PayAfterArrivalError, assertNoAdvance, paymentClockStart, paymentTimingOf } from '@/server/domain/pay-after-arrival';
import { goodsJourney, goodsWhereNow, type GoodsJourneyFacts } from '@/server/domain/import-goods-journey';

describe('paymentClockStart', () => {
  it('an ordinary import keeps its own start', () => {
    expect(paymentClockStart('2026-09-01', false, null)).toBe('2026-09-01');
    expect(paymentClockStart('2026-09-01', false, '2026-10-28')).toBe('2026-09-01');
  });
  it('paid after arrival: no clock until the goods are in, then from the later day', () => {
    expect(paymentClockStart('2026-09-01', true, null)).toBeNull();
    expect(paymentClockStart('2026-09-01', true, '2026-10-28')).toBe('2026-10-28');
    expect(paymentClockStart('2026-11-05', true, '2026-10-28')).toBe('2026-11-05');
  });
});

describe('paymentTimingOf', () => {
  it('reads the two values and nothing else', () => {
    expect(paymentTimingOf('after_arrival')).toBe('after_arrival');
    expect(paymentTimingOf('before_arrival')).toBe('before_arrival');
    expect(paymentTimingOf('later')).toBeNull();
    expect(paymentTimingOf(['after_arrival'])).toBeNull();
    expect(paymentTimingOf(undefined)).toBeNull();
  });
});

describe('assertNoAdvance', () => {
  it('passes without an advance and refuses one, naming the import', () => {
    expect(() => assertNoAdvance('IMP-HQ-2026-000001', false)).not.toThrow();
    expect(() => assertNoAdvance('IMP-HQ-2026-000001', true)).toThrow(PayAfterArrivalError);
    expect(() => assertNoAdvance(null, true)).toThrow(/This import is paid after the goods arrive/);
  });
});

const base: GoodsJourneyFacts = {
  advance: null,
  heldOn: null,
  heldNow: false,
  released: null,
  posted: null,
  legacy: null,
  payAfterArrival: null,
  shipping: { bls: [], containers: [], containersAddedOn: null },
  customs: null,
  landed: null,
  payableNo: 'IMP-HQ-2026-000099',
} as unknown as GoodsJourneyFacts;

describe('the goods journey of an import paid after arrival', () => {
  it('a sheet import waiting for its first SWIFT is In Process, not On Process', () => {
    const legacy = { paid: null, waiting: { applicationNo: 'PAYAPP-HQ-2026-000001' } };
    const waiting = goodsJourney({ ...base, legacy });
    expect(waiting.map((step) => step.step)).toContain('on_process');
    expect(goodsWhereNow({ ...base, legacy }).place).toBe('on_process');

    const later = { ...base, legacy, payAfterArrival: { on: '2026-10-24' } };
    const steps = goodsJourney(later);
    expect(steps.map((step) => step.step)).not.toContain('on_process');
    expect(steps.find((step) => step.step === 'in_process')).toMatchObject({ state: 'done', on: '2026-10-24' });
    expect(goodsWhereNow(later).place).toBe('in_process');
  });

  it('an advance agreed on a draft is not drawn as a hold to come', () => {
    const advance = { invoiceNo: 'PUR-HQ-2026-000001', posted: false, basis: 'amount', percent: null, amount: '100', currency: 'USD', applicationNo: null } as const;
    expect(goodsJourney({ ...base, advance }).map((step) => step.step)).toContain('on_process');
    expect(goodsJourney({ ...base, advance, payAfterArrival: { on: null } }).map((step) => step.step)).not.toContain('on_process');
  });

  it('goods released by the switch read as done, without an application', () => {
    const advance = { invoiceNo: 'PUR-HQ-2026-000001', posted: true, basis: 'amount', percent: null, amount: '100', currency: 'USD', applicationNo: null } as const;
    const steps = goodsJourney({ ...base, advance, heldOn: '2026-09-01', heldNow: false, posted: { invoiceNo: 'PUR-HQ-2026-000001', on: '2026-09-01' }, payAfterArrival: { on: '2026-10-24' } });
    expect(steps.find((step) => step.step === 'on_process')).toMatchObject({ state: 'done' });
    expect(steps.find((step) => step.step === 'in_process')).toMatchObject({ state: 'done', on: '2026-10-24' });
  });
});

describe('0426', () => {
  it('adds the flag with its named-by check and the two log codes', () => {
    const sql = readFileSync('src/server/db/migrations/0426_import_pay_after_arrival.sql', 'utf8');
    expect(sql).toMatch(/payable_pay_after_arrival_named/);
    expect(sql).toMatch(/payable_pay_after_arrival_import/);
    expect(sql).toMatch(/'PAY_AFTER_ARRIVAL_SET'/);
    expect(sql).toMatch(/'PAY_AFTER_ARRIVAL_CLEARED'/);
  });
});
