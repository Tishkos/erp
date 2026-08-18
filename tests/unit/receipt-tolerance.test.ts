/**
 * §8.4 — the receipt tolerance, as arithmetic.
 *
 * These are the cases where a floating-point implementation quietly gives the
 * wrong answer, and where the wrong answer means a manager is not asked.
 */
import { describe, expect, it } from 'vitest';
import {
  allowedQuantity,
  isLineComplete,
  isOverReceipt,
  outstandingQuantity,
} from '@domain/receipt-tolerance';

/** Quantities carry six decimal places; 1 unit is 1_000_000. */
const units = (n: number | string) => {
  const [whole = '0', fraction = ''] = String(n).split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6));
};

describe('§8.4 · the ceiling a receipt is judged against', () => {
  it('allows exactly what was ordered when the tolerance is zero', () => {
    expect(allowedQuantity(units(100), '0')).toBe(units(100));
  });

  it('computes a fractional percentage exactly', () => {
    // 2.5% of 100 is 2.5 — not 2.4999999999999996, which is what
    // 100 * 0.025 gives in binary floating point.
    expect(allowedQuantity(units(100), '2.5')).toBe(units('102.5'));
  });

  it('handles a tolerance with four decimal places', () => {
    expect(allowedQuantity(units(1000), '0.1234')).toBe(units('1001.234'));
  });

  it('truncates towards needing a manager rather than away from one', () => {
    // 1% of 7 units is 0.07; on a quantity that cannot divide evenly the
    // remainder is dropped, so the ceiling is never generous by a rounding.
    const ceiling = allowedQuantity(units(3), '0.0001');
    expect(ceiling).toBeLessThanOrEqual(units('3.000003'));
    expect(ceiling).toBeGreaterThanOrEqual(units(3));
  });

  it('refuses a negative tolerance, and says why', () => {
    expect(() => allowedQuantity(units(100), '-5')).toThrow(/Under-receipt is normal/);
  });

  it('refuses a negative order quantity', () => {
    expect(() => allowedQuantity(-1n, '0')).toThrow(RangeError);
  });
});

describe('§8.4 · over-receipt is judged on the cumulative quantity', () => {
  const ordered = units(100);

  it('accepts a delivery that lands exactly on the ordered quantity', () => {
    expect(
      isOverReceipt({ ordered, alreadyReceived: units(60), arriving: units(40), tolerancePercent: '0' }),
    ).toBe(false);
  });

  it('catches the third partial delivery, not the first', () => {
    const tolerancePercent = '0';
    expect(isOverReceipt({ ordered, alreadyReceived: 0n, arriving: units(40), tolerancePercent })).toBe(
      false,
    );
    expect(
      isOverReceipt({ ordered, alreadyReceived: units(40), arriving: units(40), tolerancePercent }),
    ).toBe(false);
    // 40 + 40 + 40 = 120 against 100 ordered.
    expect(
      isOverReceipt({ ordered, alreadyReceived: units(80), arriving: units(40), tolerancePercent }),
    ).toBe(true);
  });

  it('lets a tolerance absorb a small over-delivery', () => {
    expect(
      isOverReceipt({ ordered, alreadyReceived: units(98), arriving: units(4), tolerancePercent: '5' }),
    ).toBe(false);
  });

  it('still catches an over-delivery past the tolerance', () => {
    expect(
      isOverReceipt({ ordered, alreadyReceived: units(98), arriving: units(8), tolerancePercent: '5' }),
    ).toBe(true);
  });

  it('treats one unit past the ceiling as over-receipt', () => {
    // The boundary is where this rule earns its keep: 105.000001 against a 5%
    // tolerance on 100 is over, and a percentage computed in floats says it is
    // not.
    expect(
      isOverReceipt({
        ordered,
        alreadyReceived: 0n,
        arriving: units('105.000001'),
        tolerancePercent: '5',
      }),
    ).toBe(true);
    expect(
      isOverReceipt({ ordered, alreadyReceived: 0n, arriving: units(105), tolerancePercent: '5' }),
    ).toBe(false);
  });
});

describe('§8.4 · what is still expected', () => {
  it('reports the open balance of a partly received line', () => {
    expect(
      outstandingQuantity({ ordered: units(100), received: units(30), closed: 0n }),
    ).toEqual({ outstanding: units(70), overReceived: 0n });
  });

  it('reports nothing outstanding when the line is over-received', () => {
    // Not −4: a negative outstanding reads as an instruction to send stock
    // back, and sending stock back is a Goods Return (§8.8).
    expect(
      outstandingQuantity({ ordered: units(100), received: units(104), closed: 0n }),
    ).toEqual({ outstanding: 0n, overReceived: units(4) });
  });

  it('counts a cancelled balance as no longer expected (§8.7)', () => {
    expect(
      outstandingQuantity({ ordered: units(100), received: units(60), closed: units(40) }),
    ).toEqual({ outstanding: 0n, overReceived: 0n });
  });

  it('completes a line by receipt, by closure, or by both', () => {
    expect(isLineComplete({ ordered: units(100), received: units(100), closed: 0n })).toBe(true);
    expect(isLineComplete({ ordered: units(100), received: 0n, closed: units(100) })).toBe(true);
    expect(isLineComplete({ ordered: units(100), received: units(60), closed: units(40) })).toBe(true);
    expect(isLineComplete({ ordered: units(100), received: units(99), closed: 0n })).toBe(false);
  });

  it('completes a line that was over-received', () => {
    expect(isLineComplete({ ordered: units(100), received: units(104), closed: 0n })).toBe(true);
  });
});
