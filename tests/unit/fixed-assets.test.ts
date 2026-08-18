/**
 * Phase 12 — fixed asset rules, §18 and Appendix E (IAS 16).
 *
 * Pure: no database, no clock.
 */
import { describe, expect, it } from 'vitest';
import {
  assertAvailable,
  assertImpairable,
  carryingValue,
  disposalOutcome,
  ImpairmentTooLargeError,
  monthlyCharge,
  NotYetAvailableError,
  type AssetBasis,
} from '@domain/fixed-assets';

const iqd = (whole: string) => BigInt(whole) * 10_000n;

function basis(overrides: Partial<AssetBasis> = {}): AssetBasis {
  return {
    acquisitionCostIqd: iqd('120000'),
    residualValueIqd: iqd('12000'),
    usefulLifeMonths: 36,
    method: 'straight_line',
    availableForUseOn: '2026-03-01',
    ...overrides,
  };
}

describe('§18.5 · depreciation cannot begin before the Available for Use Date', () => {
  it('accepts a period that ends on or after the date', () => {
    expect(() => assertAvailable('FA-1', '2026-03-01', '2026-03-31')).not.toThrow();
    expect(() => assertAvailable('FA-1', '2026-03-31', '2026-03-31')).not.toThrow();
  });

  it('refuses a period that ends before it', () => {
    expect(() => assertAvailable('FA-1', '2026-03-01', '2026-02-28')).toThrow(NotYetAvailableError);
  });

  it('says why, in terms of what depreciation is', () => {
    expect(() => assertAvailable('FA-1', '2026-03-01', '2026-01-31')).toThrow(
      /an asset nobody can use yet is not being used up/,
    );
  });

  it('charges nothing for a period before the date', () => {
    // Acquired in January, available in March: January is nil.
    const charge = monthlyCharge(basis(), 0n, '2026-01-01', '2026-01-31');
    expect(charge.chargeIqd).toBe(0n);
    expect(charge.accumulatedAfterIqd).toBe(0n);
  });

  it('charges from the month the asset becomes available', () => {
    const charge = monthlyCharge(basis(), 0n, '2026-03-01', '2026-03-31');
    // (120,000 − 12,000) ÷ 36 = 3,000 a month.
    expect(charge.chargeIqd).toBe(iqd('3000'));
  });
});

describe('§18 · straight line', () => {
  it('spreads cost less residual over the useful life', () => {
    const charge = monthlyCharge(basis(), 0n, '2026-03-01', '2026-03-31');
    expect(charge.chargeIqd).toBe(iqd('3000'));
    expect(charge.carryingValueAfterIqd).toBe(iqd('117000'));
  });

  it('prorates the first part month on days', () => {
    // Available on the 20th of a 31-day month: 12 days of 31.
    const charge = monthlyCharge(
      basis({ availableForUseOn: '2026-03-20' }),
      0n,
      '2026-03-01',
      '2026-03-31',
    );
    expect(charge.chargeIqd).toBe((iqd('3000') * 12n) / 31n);
    expect(charge.chargeIqd).toBeLessThan(iqd('3000'));
  });

  it('charges a full month thereafter', () => {
    const first = monthlyCharge(
      basis({ availableForUseOn: '2026-03-20' }),
      0n,
      '2026-03-01',
      '2026-03-31',
    );
    const second = monthlyCharge(
      basis({ availableForUseOn: '2026-03-20' }),
      first.accumulatedAfterIqd,
      '2026-04-01',
      '2026-04-30',
    );
    expect(second.chargeIqd).toBe(iqd('3000'));
  });

  it('stops exactly at residual value', () => {
    // One month short of fully depreciated: 35 × 3,000 = 105,000 charged.
    const charge = monthlyCharge(basis(), iqd('105000'), '2029-02-01', '2029-02-28');
    expect(charge.chargeIqd).toBe(iqd('3000'));
    expect(charge.carryingValueAfterIqd).toBe(iqd('12000'));
    expect(charge.fullyDepreciated).toBe(true);
  });

  it('trims the last charge rather than overshooting', () => {
    const charge = monthlyCharge(basis(), iqd('107000'), '2029-03-01', '2029-03-31');
    expect(charge.chargeIqd).toBe(iqd('1000'));
    expect(charge.carryingValueAfterIqd).toBe(iqd('12000'));
  });

  it('charges nothing once residual value is reached', () => {
    const charge = monthlyCharge(basis(), iqd('108000'), '2029-04-01', '2029-04-30');
    expect(charge.chargeIqd).toBe(0n);
    expect(charge.fullyDepreciated).toBe(true);
  });

  it('never takes carrying value below residual, over a whole life', () => {
    let accumulated = 0n;
    for (let month = 0; month < 48; month += 1) {
      const charge = monthlyCharge(basis(), accumulated, '2026-03-01', '2026-03-31');
      accumulated = charge.accumulatedAfterIqd;
    }
    expect(iqd('120000') - accumulated).toBe(iqd('12000'));
  });
});

describe('§18 · reducing balance', () => {
  const rb = () => basis({ method: 'reducing_balance' });

  it('takes a proportion of what is left, so the charge falls', () => {
    const first = monthlyCharge(rb(), 0n, '2026-03-01', '2026-03-31');
    const second = monthlyCharge(rb(), first.accumulatedAfterIqd, '2026-04-01', '2026-04-30');

    expect(first.chargeIqd).toBeGreaterThan(0n);
    expect(second.chargeIqd).toBeLessThan(first.chargeIqd);
  });

  it('also stops at residual value', () => {
    let accumulated = 0n;
    for (let month = 0; month < 200; month += 1) {
      const charge = monthlyCharge(rb(), accumulated, '2026-03-01', '2026-03-31');
      accumulated = charge.accumulatedAfterIqd;
      if (charge.chargeIqd === 0n) break;
    }
    expect(iqd('120000') - accumulated).toBeGreaterThanOrEqual(iqd('12000'));
  });

  it('obeys the Available for Use Date like every other method', () => {
    expect(monthlyCharge(rb(), 0n, '2026-01-01', '2026-01-31').chargeIqd).toBe(0n);
  });
});

describe('§18 · a nil or impossible basis charges nothing', () => {
  it('charges nothing when residual equals cost', () => {
    const charge = monthlyCharge(
      basis({ residualValueIqd: iqd('120000') }),
      0n,
      '2026-03-01',
      '2026-03-31',
    );
    expect(charge.chargeIqd).toBe(0n);
  });

  it('charges nothing when the useful life is zero', () => {
    const charge = monthlyCharge(basis({ usefulLifeMonths: 0 }), 0n, '2026-03-01', '2026-03-31');
    expect(charge.chargeIqd).toBe(0n);
  });
});

describe('§18.8 · net book value keeps impairment apart from depreciation', () => {
  it('subtracts both', () => {
    const value = carryingValue({
      acquisitionCostIqd: iqd('120000'),
      accumulatedDepreciationIqd: iqd('30000'),
      accumulatedImpairmentIqd: iqd('10000'),
    });
    expect(value.netBookValueIqd).toBe(iqd('80000'));
  });

  it('keeps the two visible separately, because they reconcile separately', () => {
    const value = carryingValue({
      acquisitionCostIqd: iqd('120000'),
      accumulatedDepreciationIqd: iqd('30000'),
      accumulatedImpairmentIqd: iqd('10000'),
    });
    expect(value.accumulatedDepreciationIqd).toBe(iqd('30000'));
    expect(value.accumulatedImpairmentIqd).toBe(iqd('10000'));
  });
});

describe('§18 · impairment cannot take an asset below nothing', () => {
  const value = carryingValue({
    acquisitionCostIqd: iqd('120000'),
    accumulatedDepreciationIqd: iqd('30000'),
    accumulatedImpairmentIqd: 0n,
  });

  it('accepts an impairment within carrying value', () => {
    expect(() => assertImpairable('FA-1', value, iqd('50000'))).not.toThrow();
  });

  it('accepts one exactly equal to it', () => {
    expect(() => assertImpairable('FA-1', value, iqd('90000'))).not.toThrow();
  });

  it('refuses one beyond it', () => {
    expect(() => assertImpairable('FA-1', value, iqd('90001'))).toThrow(ImpairmentTooLargeError);
  });

  it('refuses an impairment of nothing', () => {
    expect(() => assertImpairable('FA-1', value, 0n)).toThrow(ImpairmentTooLargeError);
  });

  it('names the alternative', () => {
    expect(() => assertImpairable('FA-1', value, iqd('200000'))).toThrow(/that is a disposal/);
  });
});

describe('§18.6 · disposal', () => {
  const value = carryingValue({
    acquisitionCostIqd: iqd('120000'),
    accumulatedDepreciationIqd: iqd('90000'),
    accumulatedImpairmentIqd: iqd('10000'),
  });

  it('computes a gain when proceeds exceed carrying value', () => {
    const result = disposalOutcome(value, iqd('25000'));
    expect(result.netBookValueIqd).toBe(iqd('20000'));
    expect(result.gainOrLossIqd).toBe(iqd('5000'));
    expect(result.isGain).toBe(true);
  });

  it('computes a loss when they fall short', () => {
    const result = disposalOutcome(value, iqd('15000'));
    expect(result.gainOrLossIqd).toBe(-iqd('5000'));
    expect(result.isGain).toBe(false);
  });

  it('reports neither when they match exactly', () => {
    const result = disposalOutcome(value, iqd('20000'));
    expect(result.gainOrLossIqd).toBe(0n);
    expect(result.isGain).toBe(true);
  });

  it('handles a scrapping with no proceeds', () => {
    const result = disposalOutcome(value, 0n);
    expect(result.gainOrLossIqd).toBe(-iqd('20000'));
  });
});
