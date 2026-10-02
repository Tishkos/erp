/**
 * REQ-PM-001 Stage PM-5 — the billing and recognition rules, worked by hand.
 */
import { describe, expect, it } from 'vitest';
import { assertWithinContract, cumulativePercent, dueSince, etcOf, lineState, planLineGross, recognitionOf } from '@/server/domain/project-billing';
import { parseDecimal } from '@/server/domain/money';

const iqd = (v: string) => parseDecimal(v, 4n);
const pct = (v: string) => parseDecimal(v, 4n);

describe('the billing plan', () => {
  it('a percentage line bills its share of the contract as it stands, an amount line its amount', () => {
    expect(planLineGross({ basis: 'percent', percentOfContract: pct('30'), amountIqd: null }, iqd('1000000'))).toBe(iqd('300000'));
    // 12.5 % of 1,234,567 = 154,320.875 → 154,320.875 exactly at four decimals.
    expect(planLineGross({ basis: 'percent', percentOfContract: pct('12.5'), amountIqd: null }, iqd('1234567'))).toBe(iqd('154320.875'));
    expect(planLineGross({ basis: 'amount', percentOfContract: null, amountIqd: iqd('200000') }, iqd('1000000'))).toBe(iqd('200000'));
    expect(() => planLineGross({ basis: 'percent', percentOfContract: pct('100.0001'), amountIqd: null }, iqd('1'))).toThrow(/at most 100/);
  });

  it('a date line is due on its date; a milestone line once its milestone is reached and approved, from the day it was reached', () => {
    expect(dueSince({ dueTrigger: 'date', dueOn: '2026-07-15' }, null, '2026-07-14')).toBeNull();
    expect(dueSince({ dueTrigger: 'date', dueOn: '2026-07-15' }, null, '2026-07-15')).toBe('2026-07-15');
    expect(dueSince({ dueTrigger: 'milestone', dueOn: null }, { reachedOn: '2026-08-03', reachedApprovedAt: null }, '2026-10-01')).toBeNull();
    expect(dueSince({ dueTrigger: 'milestone', dueOn: null }, { reachedOn: '2026-08-03', reachedApprovedAt: new Date() }, '2026-10-01')).toBe('2026-08-03');
    expect(lineState('planned', '2026-08-03')).toBe('due');
    expect(lineState('planned', null)).toBe('planned');
    expect(lineState('billed', '2026-08-03')).toBe('billed');
  });

  it('the certificates never go past the contract, and their cumulative share is exact', () => {
    expect(() => assertWithinContract(iqd('900000'), iqd('100000'), iqd('1000000'))).not.toThrow();
    expect(() => assertWithinContract(iqd('900000'), iqd('100000.0001'), iqd('1000000'))).toThrow(/above the contract value of 1000000/);
    expect(cumulativePercent(iqd('200000'), iqd('1000000'))).toBe(pct('20'));
    expect(cumulativePercent(iqd('1'), iqd('3'))).toBe(pct('33.3333'));
    expect(cumulativePercent(iqd('2'), iqd('3'))).toBe(pct('66.6667'));
    expect(cumulativePercent(iqd('5'), iqd('0'))).toBe(0n);
  });
});

describe('the estimate to complete (§10, §11)', () => {
  it('typed wins; else the unearned budget ÷ CPI; else the unearned budget; never below zero', () => {
    // Budget 800,000, earned 400,000 for 300,000 spent: CPI 1.333…, ETC 300,000.
    expect(etcOf({ budgetIqd: iqd('800000'), earnedIqd: iqd('400000'), actualIqd: iqd('300000'), typedIqd: null })).toBe(iqd('300000'));
    // Nothing measured: the whole budget remains.
    expect(etcOf({ budgetIqd: iqd('800000'), earnedIqd: 0n, actualIqd: iqd('300000'), typedIqd: null })).toBe(iqd('800000'));
    expect(etcOf({ budgetIqd: iqd('800000'), earnedIqd: iqd('800000'), actualIqd: iqd('900000'), typedIqd: null })).toBe(0n);
    expect(etcOf({ budgetIqd: iqd('800000'), earnedIqd: iqd('400000'), actualIqd: iqd('300000'), typedIqd: iqd('700000') })).toBe(iqd('700000'));
  });
});

describe('percentage of completion, cost to cost (D-PM-1)', () => {
  it('contract × actual ÷ EAC less billed: to WIP when earned runs ahead', () => {
    const r = recognitionOf({ contractIqd: iqd('1000000'), actualIqd: iqd('300000'), eacIqd: iqd('600000'), billedIqd: iqd('200000') });
    expect(r).toMatchObject({ percent: pct('50'), recognisedIqd: iqd('500000'), adjustmentIqd: iqd('300000'), onerous: false });
  });

  it('to deferred revenue when billing runs ahead; the money from the exact ratio; a loss contract flagged', () => {
    const r = recognitionOf({ contractIqd: iqd('1000000'), actualIqd: iqd('400000'), eacIqd: iqd('1100000'), billedIqd: iqd('700000') });
    expect(r).toMatchObject({ percent: pct('36.3636'), recognisedIqd: iqd('363636.3636'), adjustmentIqd: iqd('-336363.6364'), onerous: true });
  });

  it('never more than the contract, nothing before any cost', () => {
    expect(recognitionOf({ contractIqd: iqd('100'), actualIqd: iqd('120'), eacIqd: iqd('110'), billedIqd: 0n })).toMatchObject({ percent: pct('100'), recognisedIqd: iqd('100') });
    expect(recognitionOf({ contractIqd: iqd('100'), actualIqd: 0n, eacIqd: iqd('80'), billedIqd: iqd('30') })).toMatchObject({ percent: 0n, recognisedIqd: 0n, adjustmentIqd: iqd('-30') });
  });
});
