/**
 * REQ-HARDEN-001 HD8 — money is never a double where it is stored or compared.
 *
 *   B1  value ÷ quantity for a found item's unit cost, in integers.
 *   B2  the sheet's cleared verdict compares scaled integers.
 *   B3  the reconciliation statement's variance is an integer difference.
 *   B4  "ties" is exact, not within an epsilon.
 *   B5  the grids' running totals are integers.
 */
import { describe, expect, it } from 'vitest';
import { MONEY_SCALE, divideHalfUp, parseDecimal, toDecimalString } from '@/server/domain/money';
import { clearingFromSheet } from '@/server/domain/payables-migration';
import { reconciliationTotals } from '@/server/services/open-items';
import { lineTotal, scaled, toText } from '@/lib/decimal';

/** Exact half-up division on bigints, written the slow way, as the oracle. */
function oracle(n: bigint, d: bigint): bigint {
  const twice = n * 2n;
  const q = twice / d;
  const r = twice % d;
  // half-up: floor((2n + d) / (2d))
  void q;
  void r;
  const sign = n < 0n !== d < 0n ? -1n : 1n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  return sign * ((2n * an + ad) / (2n * ad));
}

describe('B1 · integer division, half up', () => {
  it('matches the exact oracle on ten thousand random cases', () => {
    let seed = 12345;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let i = 0; i < 10_000; i += 1) {
      const n = BigInt(random()) * BigInt(random()) * (random() % 2 ? 1n : -1n);
      const d = BigInt(random() % 100_000) + 1n;
      expect(divideHalfUp(n, d)).toBe(oracle(n, d));
    }
  });

  it('keeps the fils on a five-billion-dinar layer, where a double cannot', () => {
    // 5,000,000,000.0000000000 over 3 units: value at scale 10, quantity at scale 6.
    const value = parseDecimal('5000000000.0000000001', 10n);
    const quantity = parseDecimal('3', 6n);
    const unitCost = divideHalfUp(value, quantity);
    expect(toDecimalString(unitCost, MONEY_SCALE)).toBe('1666666666.6667');
    // The old arithmetic: Number() of a 20-digit value has lost its last digits.
    expect(Number('50000000000000000001') === 50000000000000000001).toBe(true); // both are the same rounded double…
    expect(BigInt(Number('50000000000000000001'))).not.toBe(50000000000000000001n); // …which is not the value.
  });
});

describe('B2 · the cleared verdict', () => {
  const row = (amount: string, quantity: string) =>
    ({ row: 1, key: 'K', reference: 'K', supplierName: 'S', supplierKey: 's', amount, quantity, legacyCleared: false }) as never;
  const pmt = (amount: string) => ({ row: 1, key: 'K', reference: 'K', amount, swiftDate: '2026-01-01', applicationDate: '2026-01-01', bank: 'MANSOUR' }) as never;
  const pd = () => ({ row: 1, key: 'K', reference: 'K', pdNo: '1', statusLabel: 'Totally written off' }) as never;
  const bl = (totalQty: string) => ({ row: 1, key: 'K', blNo: 'B', shippingStatus: 'Inbounded', totalQty, containers: ['MSCU1234565'], invalidContainers: [] }) as never;

  it('adds 0.1 and 0.2 to 0.3 — a double does not', () => {
    const verdict = clearingFromSheet(row('0.3', '1'), [pmt('0.1'), pmt('0.2')], [pd()], [bl('1')]);
    expect(verdict.fullyPaid).toBe(true);
    expect(verdict.cleared).toBe(true);
    expect(0.1 + 0.2 === 0.3).toBe(false);
  });

  it('compares received against invoiced quantity exactly', () => {
    expect(clearingFromSheet(row('100', '0.0001'), [pmt('100')], [pd()], [bl('0.0001')]).allReceived).toBe(true);
    expect(clearingFromSheet(row('100', '0.0002'), [pmt('100')], [pd()], [bl('0.0001')]).allReceived).toBe(false);
  });
});

describe('B3 / B4 · the reconciliation ties exactly', () => {
  it('sums as integers and says so', () => {
    const rows = [
      { partyCode: 'A', partyName: 'A', ledgerIqd: '0.1000', documentsIqd: '0.3000', unexplainedIqd: '-0.2000', unappliedCreditsIqd: '0.2000', otherNonInvoiceDebitIqd: '0.0000', oldestDate: null },
      { partyCode: 'B', partyName: 'B', ledgerIqd: '0.2000', documentsIqd: '0.0000', unexplainedIqd: '0.2000', unappliedCreditsIqd: '0.0000', otherNonInvoiceDebitIqd: '0.2000', oldestDate: null },
    ];
    const totals = reconciliationTotals(rows);
    expect(totals).toEqual({
      ledgerIqd: '0.3000',
      documentsIqd: '0.3000',
      unexplainedIqd: '0.0000',
      unappliedCreditsIqd: '0.2000',
      otherNonInvoiceDebitsIqd: '0.2000',
      ties: true,
    });
  });
});

describe('B5 · the grid arithmetic in the browser', () => {
  it('quantity × price − discount with no floating point', () => {
    expect(toText(lineTotal('3', '0.1', '0.2')!, 4)).toBe('0.1');
    expect(toText(lineTotal('1,000', '1,234.5678', '')!, 4)).toBe('1234567.8');
    expect(lineTotal('abc', '1', '')).toBeNull();
    expect(scaled('', 4)).toBeNull();
    expect(scaled('-0.5', 4)).toBe(-5000n);
    expect(toText(-5000n, 4)).toBe('-0.5');
  });
});
