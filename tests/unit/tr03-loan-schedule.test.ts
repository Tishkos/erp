/**
 * The schedule a bank's letter describes — by direction, 2026-10-03.
 *
 * "Four instalments does not tell you how the 50,000 is divided. 12,500 × 4;
 * 10,000 × 3 then 20,000; nothing then 50,000 — those are completely different
 * loans."
 *
 * So the method is part of the offer, and each one is worked here against
 * figures a person can check by hand: a 50,000 facility over four quarters at
 * 8% a year. Change the builder and this test says which instalment moved.
 */
import { describe, expect, it } from 'vitest';
import { buildSchedule, dueDates, LoanError } from '@/server/domain/loans';

const money = (text: string): bigint => {
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * 10_000n + BigInt((fraction + '0000').slice(0, 4));
};
const shown = (value: bigint) => (Number(value) / 10_000).toFixed(2);

/** The offer: 50,000 drawn on 3 October, four quarters from 3 January. */
const OFFER = {
  principal: money('50000'),
  commission: 0n,
  spreadCommission: false,
  interestPctPa: money('8'),
  count: 4,
  frequency: 'quarterly' as const,
  firstDueDate: '2027-01-03',
  startDate: '2026-10-03',
};

describe('TR-03 · how the principal comes back', () => {
  it('equal principal: the same principal each time, a falling instalment', () => {
    const rows = buildSchedule({ ...OFFER, principalMethod: 'equal_principal' });
    expect(rows.map((row) => shown(row.principal))).toEqual([
      '12500.00',
      '12500.00',
      '12500.00',
      '12500.00',
    ]);
    // Interest falls as the balance does, so each total is smaller than the last.
    const totals = rows.map((row) => row.total);
    expect(totals[0]! > totals[1]!).toBe(true);
    expect(totals[1]! > totals[2]!).toBe(true);
    expect(totals[2]! > totals[3]!).toBe(true);
  });

  it('bullet: nothing, nothing, nothing, all of it', () => {
    const rows = buildSchedule({ ...OFFER, principalMethod: 'bullet' });
    expect(rows.map((row) => shown(row.principal))).toEqual(['0.00', '0.00', '0.00', '50000.00']);
    // Interest is charged throughout, on the whole balance.
    expect(rows.every((row) => row.interest > 0n)).toBe(true);
  });

  it('equal instalments: the same total each time, to the cent', () => {
    const rows = buildSchedule({ ...OFFER, principalMethod: 'equal_instalments' });
    const totals = rows.map((row) => row.total);
    // Every instalment but the last is the same; the last absorbs the rounding.
    expect(shown(totals[0]!)).toBe(shown(totals[1]!));
    expect(shown(totals[1]!)).toBe(shown(totals[2]!));
    const drift = totals[3]! - totals[0]!;
    expect(drift > -money('1') && drift < money('1')).toBe(true);
    // And the principal rises as the interest falls.
    expect(rows[0]!.principal < rows[3]!.principal).toBe(true);
  });

  it('every method repays the principal exactly once', () => {
    for (const principalMethod of ['equal_principal', 'equal_instalments', 'bullet', 'custom'] as const) {
      const rows = buildSchedule({ ...OFFER, principalMethod });
      const repaid = rows.reduce((sum, row) => sum + row.principal, 0n);
      expect([principalMethod, shown(repaid)]).toEqual([principalMethod, '50000.00']);
    }
  });

  it('repays exactly whatever the count and the figure', () => {
    for (const count of [1, 2, 3, 5, 7, 12, 36]) {
      for (const principal of ['1', '1000', '50000', '1234567.89']) {
        for (const principalMethod of ['equal_principal', 'equal_instalments', 'bullet'] as const) {
          const rows = buildSchedule({
            ...OFFER,
            principal: money(principal),
            count,
            frequency: 'monthly',
            principalMethod,
          });
          const repaid = rows.reduce((sum, row) => sum + row.principal, 0n);
          expect([principalMethod, count, principal, repaid]).toEqual([
            principalMethod,
            count,
            principal,
            money(principal),
          ]);
        }
      }
    }
  });
});

describe('TR-03 · how the interest is worked out', () => {
  it('flat is on the original principal and is the larger figure', () => {
    const reducing = buildSchedule({ ...OFFER, interestBasis: 'reducing' });
    const flat = buildSchedule({ ...OFFER, interestBasis: 'flat' });
    const sum = (rows: readonly { interest: bigint }[]) => rows.reduce((total, row) => total + row.interest, 0n);
    expect(sum(flat) > sum(reducing)).toBe(true);
    // Flat is the same every instalment; reducing falls.
    expect(shown(flat[0]!.interest)).toBe(shown(flat[1]!.interest));
    expect(reducing[0]!.interest > reducing[3]!.interest).toBe(true);
  });

  it('a loan with no rate carries no interest at all', () => {
    const rows = buildSchedule({ ...OFFER, interestPctPa: null });
    expect(rows.every((row) => row.interest === 0n)).toBe(true);
    expect(rows.map((row) => shown(row.total))).toEqual(['12500.00', '12500.00', '12500.00', '12500.00']);
  });
});

describe('TR-03 · the grace period', () => {
  it('principal grace: nothing repaid inside it, all of it over the rest', () => {
    const rows = buildSchedule({ ...OFFER, grace: 'principal', graceUntil: '2027-04-30' });
    // The first two fall on or before 30 April.
    expect(rows.map((row) => shown(row.principal))).toEqual(['0.00', '0.00', '25000.00', '25000.00']);
    // Interest is still charged throughout.
    expect(rows.every((row) => row.interest > 0n)).toBe(true);
  });

  it('interest grace: not forgiven — it lands on the first instalment after', () => {
    const plain = buildSchedule(OFFER);
    const rows = buildSchedule({ ...OFFER, grace: 'interest', graceUntil: '2027-04-30' });
    expect([shown(rows[0]!.interest), shown(rows[1]!.interest)]).toEqual(['0.00', '0.00']);
    // The third carries its own and the two held back.
    expect(rows[2]!.interest).toBe(plain[0]!.interest + plain[1]!.interest + plain[2]!.interest);
    // Nothing is lost between the two schedules.
    const sum = (list: readonly { interest: bigint }[]) => list.reduce((total, row) => total + row.interest, 0n);
    expect(sum(rows)).toBe(sum(plain));
  });

  it('refuses a grace that covers every instalment, or one with no date', () => {
    expect(() => buildSchedule({ ...OFFER, grace: 'principal', graceUntil: '2030-01-01' })).toThrow(LoanError);
    expect(() => buildSchedule({ ...OFFER, grace: 'both', graceUntil: null })).toThrow(/runs to a date/);
  });
});

describe('TR-03 · how often it falls due', () => {
  it('steps by the frequency the letter states', () => {
    expect(dueDates('2027-01-03', 3, 'monthly')).toEqual(['2027-01-03', '2027-02-03', '2027-03-03']);
    expect(dueDates('2027-01-03', 3, 'quarterly')).toEqual(['2027-01-03', '2027-04-03', '2027-07-03']);
    expect(dueDates('2027-01-03', 3, 'semiannual')).toEqual(['2027-01-03', '2027-07-03', '2028-01-03']);
    expect(dueDates('2027-01-03', 3, 'annual')).toEqual(['2027-01-03', '2028-01-03', '2029-01-03']);
  });

  it('a day past the month end lands on its last day', () => {
    expect(dueDates('2027-01-31', 3, 'monthly')).toEqual(['2027-01-31', '2027-02-28', '2027-03-31']);
  });
});
