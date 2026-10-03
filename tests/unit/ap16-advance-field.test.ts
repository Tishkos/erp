/**
 * The figure beside the percentage and the figure asked of the bank are one
 * rule — §15.3, by direction 2026-10-03.
 *
 * The form shows what 20 per cent of the invoice comes to while it is still
 * being typed; the server works the same share out again from the total it has
 * just committed, and that is the one the bank is asked for. The form never
 * submits its own arithmetic, because a form that did could lie about it.
 *
 * So there are two implementations — `advanceOf` on the server, `advanceShare`
 * in the browser, the second duplicated because a client component here does
 * not import from `src/server` — and the whole point of them is that they
 * agree. These run both over the same figures and fail if they ever part
 * company.
 */
import { describe, expect, it } from 'vitest';
import { advanceOf } from '@/server/domain/payment-applications';
import { advanceShare } from '@/components/admin/advance-field';

/** The money scale: 265,720.0000 as the books hold it. */
const iqd = (text: string): bigint => {
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * 10_000n + BigInt((fraction + '0000').slice(0, 4));
};

const TOTALS = [
  '0',
  '0.0001',
  '1',
  '7',
  '1000',
  '1234.5678',
  '265720',
  '404105773.17',
  '9199874500',
] as const;

const PERCENTS = [
  '',
  '0',
  '0.004',
  '0.005',
  '1',
  '3.3333',
  '20',
  '20.5',
  '20.00001',
  '33.3333',
  '33.3335',
  '50',
  '99.9999',
  '100',
  'twenty',
  '20%',
  '-20',
] as const;

describe('AP-16 · the screen and the server work out the same advance', () => {
  it.each(TOTALS)('agrees on every percentage against a total of %s', (total) => {
    for (const percent of PERCENTS) {
      expect(advanceShare(iqd(total), percent)).toBe(advanceOf(iqd(total), percent));
    }
  });

  it('agrees on the case the whole feature exists for', () => {
    // 20% of the Shenzhen invoice.
    expect(advanceShare(iqd('265720'), '20')).toBe(iqd('53144'));
    expect(advanceOf(iqd('265720'), '20')).toBe(iqd('53144'));
  });

  it('both say nothing rather than nought', () => {
    // A request to a bank for no money would need an approval and a signature
    // for nothing, so neither side offers one.
    expect(advanceShare(iqd('0.01'), '0.01')).toBeNull();
    expect(advanceOf(iqd('0.01'), '0.01')).toBeNull();
  });

  /*
   * A hundred is the ceiling — by direction, 2026-10-03: "advance payment
   * should never be more than 100 please".
   *
   * The two sides say no in different voices on purpose. The box on the screen
   * has already refused the keystroke, so `advanceShare` is reached only by a
   * figure that was not typed into it and answers nothing. `advanceOf` is what
   * the bank is asked for, so it raises: a caller that got here with 120% is a
   * caller with a defect, and silently paying nothing would hide it until
   * somebody wondered where the advance went.
   */
  it('neither side works out an advance of more than the invoice', () => {
    const total = iqd('265720');
    expect(advanceShare(total, '100')).toBe(iqd('265720'));
    expect(advanceOf(total, '100')).toBe(iqd('265720'));

    for (const over of ['100.0001', '101', '120', '1000']) {
      expect(advanceShare(total, over)).toBeNull();
      expect(() => advanceOf(total, over)).toThrow(/more than 100/);
    }
  });

  it('agrees across a sweep of percentages a person might actually type', () => {
    // Every tenth of a per cent from nought to a hundred, against a total with
    // fils in it — the arithmetic either matches everywhere or it does not
    // match at all, and a handful of spot checks would not tell the difference.
    const total = iqd('1234.5678');
    for (let tenth = 0; tenth <= 1000; tenth += 1) {
      const percent = (tenth / 10).toFixed(1);
      expect(advanceShare(total, percent)).toBe(advanceOf(total, percent));
    }
  });
});
