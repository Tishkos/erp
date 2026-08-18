/**
 * Phase 06.6 — the A/R invoicing rules, tested where they are pure.
 *
 *   - §7.4 the invoice is issued on the same date as the delivery
 *   - §7.7 invoiced quantities reconcile to what was delivered
 *   - Appendix B's Partially Paid and Paid, derived from money
 *
 * The "no invoice without a Delivery Note" gate is structural — a NOT NULL
 * column and a trigger — so it is proved against the database.
 */
import { describe, expect, it } from 'vitest';
import {
  assertInvoiceDateMatchesDelivery,
  assertWithinBalance,
  assertWithinDelivered,
  openBalance,
  outstandingInvoicing,
  settlementStatusFor,
  InvoiceDateMismatchError,
  OverAllocationError,
  OverInvoiceError,
} from '@domain/ar-invoicing';
import { parseQuantity } from '@domain/uom';
import { parseDecimal } from '@domain/money';

const q = (units: string) => parseQuantity(units);
const iqd = (amount: string) => parseDecimal(amount, 4n);

describe('06.6 gate · the invoice date is the delivery date (§7.4)', () => {
  it('accepts the delivery date', () => {
    expect(() => assertInvoiceDateMatchesDelivery('2026-02-13', '2026-02-13')).not.toThrow();
  });

  it('refuses a later date', () => {
    expect(() => assertInvoiceDateMatchesDelivery('2026-02-20', '2026-02-13')).toThrow(
      InvoiceDateMismatchError,
    );
  });

  it('refuses an earlier date — an invoice cannot precede its delivery either', () => {
    expect(() => assertInvoiceDateMatchesDelivery('2026-02-10', '2026-02-13')).toThrow(
      InvoiceDateMismatchError,
    );
  });

  it('refuses a date one day out — an equality, not a tolerance', () => {
    // A "within a day or two" rule would be a rule about when somebody got round
    // to it. The clause exists because the cost posted on the delivery date.
    expect(() => assertInvoiceDateMatchesDelivery('2026-02-14', '2026-02-13')).toThrow(
      InvoiceDateMismatchError,
    );
  });

  it('names both dates and says what to do (§25)', () => {
    try {
      assertInvoiceDateMatchesDelivery('2026-02-20', '2026-02-13');
      expect.unreachable('should have refused');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('2026-02-13');
      expect(message).toContain('2026-02-20');
      expect(message).toContain('Issue it on the delivery date');
    }
  });
});

describe('06.6 gate · invoiced quantities cannot exceed delivered (§7.7)', () => {
  it('allows billing what was delivered', () => {
    expect(() =>
      assertWithinDelivered('ITM-1', { delivered: q('60'), alreadyInvoiced: 0n }, q('60')),
    ).not.toThrow();
  });

  it('allows billing a delivery in stages', () => {
    expect(() =>
      assertWithinDelivered('ITM-1', { delivered: q('60'), alreadyInvoiced: q('40') }, q('20')),
    ).not.toThrow();
  });

  it('refuses one unit beyond what was delivered', () => {
    expect(() =>
      assertWithinDelivered('ITM-1', { delivered: q('60'), alreadyInvoiced: 0n }, q('60.000001')),
    ).toThrow(OverInvoiceError);
  });

  it('judges the excess cumulatively', () => {
    expect(() =>
      assertWithinDelivered('ITM-1', { delivered: q('60'), alreadyInvoiced: q('40') }, q('30')),
    ).toThrow(OverInvoiceError);
  });

  it('refuses a zero line rather than recording one', () => {
    expect(() =>
      assertWithinDelivered('ITM-1', { delivered: q('60'), alreadyInvoiced: 0n }, 0n),
    ).toThrow(RangeError);
  });

  it('reports what is still to invoice, never a negative', () => {
    expect(outstandingInvoicing({ delivered: q('60'), invoiced: q('40') })).toBe(q('20'));
    expect(outstandingInvoicing({ delivered: q('60'), invoiced: q('60') })).toBe(0n);
  });

  it('says what is left to bill (§25)', () => {
    try {
      assertWithinDelivered(
        'ITM-CABLE',
        { delivered: q('60'), alreadyInvoiced: q('50') },
        q('20'),
      );
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as Error).message).toContain('still to invoice: 10');
    }
  });
});

describe('06.6 · Partially Paid and Paid are derived from the money (Appendix B)', () => {
  it('is posted while nothing has been allocated', () => {
    expect(settlementStatusFor({ totalIqd: iqd('1000'), allocatedIqd: 0n })).toBe('posted');
  });

  it('is partially paid while a balance remains', () => {
    expect(settlementStatusFor({ totalIqd: iqd('1000'), allocatedIqd: iqd('400') })).toBe(
      'partially_executed',
    );
  });

  it('is paid when the allocation reaches the total', () => {
    expect(settlementStatusFor({ totalIqd: iqd('1000'), allocatedIqd: iqd('1000') })).toBe(
      'settled',
    );
  });

  it('is still partially paid one dinar short', () => {
    expect(settlementStatusFor({ totalIqd: iqd('1000'), allocatedIqd: iqd('999.9999') })).toBe(
      'partially_executed',
    );
  });

  it('reports the open balance, never a negative', () => {
    expect(openBalance({ totalIqd: iqd('1000'), allocatedIqd: iqd('400') })).toBe(iqd('600'));
    expect(openBalance({ totalIqd: iqd('1000'), allocatedIqd: iqd('1000') })).toBe(0n);
  });

  it('refuses an allocation beyond the invoice — the excess is a credit, not a bigger bill', () => {
    expect(() =>
      assertWithinBalance(
        'INV-1',
        { totalIqd: iqd('1000'), allocatedIqd: iqd('900') },
        iqd('200'),
      ),
    ).toThrow(OverAllocationError);
  });

  it('allows an allocation that exactly closes the invoice', () => {
    expect(() =>
      assertWithinBalance(
        'INV-1',
        { totalIqd: iqd('1000'), allocatedIqd: iqd('900') },
        iqd('100'),
      ),
    ).not.toThrow();
  });
});
