/**
 * Phase 06.10 — the receipt-allocation rules, tested where they are pure.
 *
 *   - §16 allocation cannot exceed the available receipt balance
 *   - §16 unidentified receipts credit a clearing account
 *   - Appendix B's Allocated, derived from the money
 *
 * The invoice side of the same ceiling lives in `ar-invoicing.test.ts`, next to
 * the invoice's own balance. Both are checked on every allocation.
 */
import { describe, expect, it } from 'vitest';
import {
  assertWithinReceipt,
  creditRoleFor,
  oldestFirst,
  proposeAllocation,
  receiptStatusFor,
  unapplied,
  ReceiptOverAllocatedError,
} from '@domain/receipt-allocation';
import { parseDecimal } from '@domain/money';

const iqd = (amount: string) => parseDecimal(amount, 4n);

describe('06.10 gate · allocation cannot exceed the receipt balance (§16)', () => {
  it('allows an allocation within what is left', () => {
    expect(() =>
      assertWithinReceipt('RCT-1', { amountIqd: iqd('1000'), allocatedIqd: iqd('400') }, iqd('600')),
    ).not.toThrow();
  });

  it('refuses one dinar beyond it', () => {
    expect(() =>
      assertWithinReceipt(
        'RCT-1',
        { amountIqd: iqd('1000'), allocatedIqd: iqd('400') },
        iqd('600.0001'),
      ),
    ).toThrow(ReceiptOverAllocatedError);
  });

  it('refuses a zero or negative allocation', () => {
    expect(() =>
      assertWithinReceipt('RCT-1', { amountIqd: iqd('1000'), allocatedIqd: 0n }, 0n),
    ).toThrow(RangeError);
  });

  it('reports what is unapplied, never a negative', () => {
    expect(unapplied({ amountIqd: iqd('1000'), allocatedIqd: iqd('400') })).toBe(iqd('600'));
    expect(unapplied({ amountIqd: iqd('1000'), allocatedIqd: iqd('1000') })).toBe(0n);
  });

  it('says how much is left and what to do about the rest (§25)', () => {
    try {
      assertWithinReceipt(
        'RCT-7',
        { amountIqd: iqd('1000'), allocatedIqd: iqd('900') },
        iqd('300'),
      );
      expect.unreachable('should have refused');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('RCT-7');
      expect(message).toContain('100.0000');
      expect(message).toContain('record the rest as a second receipt');
    }
  });
});

describe('06.10 gate · unidentified receipts go to a clearing account (§16)', () => {
  it('credits the customer when the payer is known', () => {
    expect(creditRoleFor('a-customer-id')).toBe('customer_receivable');
  });

  it('credits clearing when the payer is not', () => {
    // The debit is always the bank — money arriving is a fact whatever else is
    // unknown. It is the credit that moves.
    expect(creditRoleFor(null)).toBe('customer_clearing');
    expect(creditRoleFor(undefined)).toBe('customer_clearing');
  });
});

describe('06.10 · Allocated is derived from the money (Appendix B)', () => {
  it('is posted while any of it is unapplied', () => {
    expect(receiptStatusFor({ amountIqd: iqd('1000'), allocatedIqd: 0n })).toBe('posted');
    expect(receiptStatusFor({ amountIqd: iqd('1000'), allocatedIqd: iqd('999.9999') })).toBe(
      'posted',
    );
  });

  it('is allocated once every dinar is applied', () => {
    expect(receiptStatusFor({ amountIqd: iqd('1000'), allocatedIqd: iqd('1000') })).toBe('settled');
  });
});

describe('06.10 · the oldest-first proposal (§16 one-to-many)', () => {
  const invoices = [
    { id: 'march', dueDate: '2026-03-15', openIqd: iqd('400') },
    { id: 'january', dueDate: '2026-01-15', openIqd: iqd('300') },
    { id: 'february', dueDate: '2026-02-15', openIqd: iqd('500') },
  ];

  it('spreads a receipt across several invoices, oldest first', () => {
    const plan = proposeAllocation(
      { amountIqd: iqd('1000'), allocatedIqd: 0n },
      invoices,
    );

    expect(plan).toEqual([
      { arInvoiceId: 'january', amountIqd: iqd('300') },
      { arInvoiceId: 'february', amountIqd: iqd('500') },
      { arInvoiceId: 'march', amountIqd: iqd('200') },
    ]);
  });

  it('stops when the receipt runs out', () => {
    const plan = proposeAllocation({ amountIqd: iqd('350'), allocatedIqd: 0n }, invoices);

    expect(plan).toEqual([
      { arInvoiceId: 'january', amountIqd: iqd('300') },
      { arInvoiceId: 'february', amountIqd: iqd('50') },
    ]);
  });

  it('proposes nothing for a fully applied receipt', () => {
    expect(
      proposeAllocation({ amountIqd: iqd('1000'), allocatedIqd: iqd('1000') }, invoices),
    ).toEqual([]);
  });

  it('skips invoices with nothing outstanding', () => {
    const plan = proposeAllocation({ amountIqd: iqd('1000'), allocatedIqd: 0n }, [
      { id: 'paid', dueDate: '2026-01-01', openIqd: 0n },
      { id: 'open', dueDate: '2026-02-01', openIqd: iqd('400') },
    ]);

    expect(plan).toEqual([{ arInvoiceId: 'open', amountIqd: iqd('400') }]);
  });

  it('never proposes more than the invoice is owed', () => {
    const plan = proposeAllocation({ amountIqd: iqd('10000'), allocatedIqd: 0n }, invoices);
    const total = plan.reduce((sum, line) => sum + line.amountIqd, 0n);

    // 300 + 500 + 400 — the receipt has more, and the invoices do not want it.
    expect(total).toBe(iqd('1200'));
  });
});

/**
 * The case the sponsor put in writing, in their figures.
 *
 * *"we make an invoice today and tomorrow, today was 50,000 IQD and tomorrow
 * is 100,000 IQD; customer tomorrow pays 50,000 — it means 50,000 from the
 * receipt paid for the first one; if it pays 100,000 it means the second
 * invoice is partially paid."*
 */
describe('06.10 · what the money means', () => {
  const monday = { id: 'monday', dueDate: '2026-03-02', invoiceNo: 'INV-1', openIqd: iqd('50000') };
  const tuesday = { id: 'tuesday', dueDate: '2026-03-03', invoiceNo: 'INV-2', openIqd: iqd('100000') };

  it('50,000 pays Monday and leaves Tuesday untouched', () => {
    expect(proposeAllocation({ amountIqd: iqd('50000'), allocatedIqd: 0n }, [tuesday, monday])).toEqual([
      { arInvoiceId: 'monday', amountIqd: iqd('50000') },
    ]);
  });

  it('100,000 settles Monday and part-pays Tuesday', () => {
    expect(proposeAllocation({ amountIqd: iqd('100000'), allocatedIqd: 0n }, [tuesday, monday])).toEqual([
      { arInvoiceId: 'monday', amountIqd: iqd('50000') },
      // 100,000 less Monday's 50,000 — Tuesday is half done, not settled.
      { arInvoiceId: 'tuesday', amountIqd: iqd('50000') },
    ]);
  });

  it('orders two invoices due on one day by their own date, then their number', () => {
    const sameDay = [
      { id: 'b', dueDate: '2026-04-01', invoiceDate: '2026-03-02', invoiceNo: 'INV-9', openIqd: iqd('10') },
      { id: 'a', dueDate: '2026-04-01', invoiceDate: '2026-03-01', invoiceNo: 'INV-8', openIqd: iqd('10') },
      { id: 'c', dueDate: '2026-04-01', invoiceDate: '2026-03-02', invoiceNo: 'INV-7', openIqd: iqd('10') },
    ];
    // Raised first wins; between the two raised together, the lower number.
    expect(oldestFirst(sameDay).map((invoice) => invoice.id)).toEqual(['a', 'c', 'b']);
  });

  it('gives the same order however the rows arrive', () => {
    const rows = [tuesday, monday];
    expect(oldestFirst(rows).map((row) => row.id)).toEqual(['monday', 'tuesday']);
    expect(oldestFirst([...rows].reverse()).map((row) => row.id)).toEqual(['monday', 'tuesday']);
  });
});
