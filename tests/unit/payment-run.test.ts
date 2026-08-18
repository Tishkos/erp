/**
 * Phase 07.2 and 07.3 — the payment-run rules, §15 and §17.
 *
 * Each test names the clause it comes from. Pure: no database, no clock.
 */
import { describe, expect, it } from 'vitest';
import {
  assertBeneficiaryPayable,
  BeneficiaryNotPayableError,
  classify,
  discountOpportunity,
  isHighRisk,
  rank,
  selectWithinFunds,
  type Candidate,
} from '@domain/payment-run';

const iqd = (whole: string) => BigInt(whole) * 10_000n;

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    reference: 'AP-0001',
    supplierCode: 'SUP-001',
    outstandingIqd: iqd('1000'),
    dueDate: '2026-02-01',
    currency: 'IQD',
    priority: 5,
    documentStatus: 'posted',
    supplierStatus: 'active',
    hasPayableBankDetails: true,
    ...overrides,
  };
}

describe('§15 criterion 2 · the proposal includes only eligible approved items', () => {
  it('includes a posted, due, unblocked item with approved bank details', () => {
    const result = classify(candidate(), '2026-02-15', 'IQD');
    expect(result.inclusion).toBe('selected');
    expect(result.reason).toBeNull();
  });

  it('excludes an item that has not been approved and posted', () => {
    const result = classify(candidate({ documentStatus: 'draft' }), '2026-02-15', 'IQD');
    expect(result.inclusion).toBe('excluded_unapproved');
    expect(result.reason).toMatch(/not a debt until it is approved and posted/);
  });

  it('excludes an item that is already paid', () => {
    const result = classify(candidate({ outstandingIqd: 0n }), '2026-02-15', 'IQD');
    expect(result.inclusion).toBe('excluded_settled');
  });

  it('excludes a blocked supplier, and says an override is needed (§15)', () => {
    const result = classify(candidate({ supplierStatus: 'blocked' }), '2026-02-15', 'IQD');
    expect(result.inclusion).toBe('excluded_blocked');
    expect(result.reason).toMatch(/authorised override/);
  });

  it('excludes a supplier on hold for the same reason', () => {
    const result = classify(candidate({ supplierStatus: 'on_hold' }), '2026-02-15', 'IQD');
    expect(result.inclusion).toBe('excluded_blocked');
    expect(result.reason).toMatch(/on hold/);
  });

  it('excludes an item in a currency the paying account does not hold (§17)', () => {
    const result = classify(candidate({ currency: 'USD' }), '2026-02-15', 'IQD');
    expect(result.inclusion).toBe('excluded_currency');
  });

  it('excludes a supplier with no approved bank details (§17)', () => {
    const result = classify(candidate({ hasPayableBankDetails: false }), '2026-02-15', 'IQD');
    expect(result.inclusion).toBe('excluded_no_bank_details');
    expect(result.reason).toMatch(/unverified beneficiary details/);
  });

  it('excludes an item that is not due yet — paying early is a decision', () => {
    const result = classify(candidate({ dueDate: '2026-03-01' }), '2026-02-15', 'IQD');
    expect(result.inclusion).toBe('excluded_not_due');
  });

  it('reports the fact that ends the question when several apply', () => {
    // Settled *and* blocked. "Already paid" is the answer somebody needs.
    const result = classify(
      candidate({ outstandingIqd: 0n, supplierStatus: 'blocked' }),
      '2026-02-15',
      'IQD',
    );
    expect(result.inclusion).toBe('excluded_settled');
  });

  it('never returns an exclusion without a reason', () => {
    const cases = [
      candidate({ documentStatus: 'draft' }),
      candidate({ outstandingIqd: 0n }),
      candidate({ supplierStatus: 'blocked' }),
      candidate({ currency: 'USD' }),
      candidate({ hasPayableBankDetails: false }),
      candidate({ dueDate: '2099-01-01' }),
    ];

    for (const one of cases) {
      const result = classify(one, '2026-02-15', 'IQD');
      expect(result.inclusion).not.toBe('selected');
      expect(result.reason).toBeTruthy();
    }
  });
});

describe('§15 · ranking by priority, then due date, then discount', () => {
  it('takes the higher priority first — 1 is the most urgent', () => {
    const ordered = rank([
      candidate({ reference: 'B', priority: 5 }),
      candidate({ reference: 'A', priority: 1 }),
    ]);
    expect(ordered.map((row) => row.reference)).toEqual(['A', 'B']);
  });

  it('takes the older debt first at equal priority', () => {
    const ordered = rank([
      candidate({ reference: 'NEW', dueDate: '2026-02-10' }),
      candidate({ reference: 'OLD', dueDate: '2026-01-10' }),
    ]);
    expect(ordered.map((row) => row.reference)).toEqual(['OLD', 'NEW']);
  });

  it('prefers the larger discount when priority and due date tie', () => {
    const ordered = rank([
      candidate({ reference: 'PLAIN', discountIqd: 0n }),
      candidate({ reference: 'DISCOUNTED', discountIqd: iqd('20') }),
    ]);
    expect(ordered.map((row) => row.reference)).toEqual(['DISCOUNTED', 'PLAIN']);
  });

  it('is deterministic — the same books always give the same run', () => {
    const items = [
      candidate({ reference: 'C' }),
      candidate({ reference: 'A' }),
      candidate({ reference: 'B' }),
    ];
    expect(rank(items).map((r) => r.reference)).toEqual(rank([...items].reverse()).map((r) => r.reference));
  });

  it('does not mutate what it was given', () => {
    const items = [candidate({ reference: 'B' }), candidate({ reference: 'A' })];
    rank(items);
    expect(items.map((row) => row.reference)).toEqual(['B', 'A']);
  });
});

describe('§15 · available cash bounds the run', () => {
  const classified = (refs: [string, string][]) =>
    refs.map(([reference, amount]) =>
      classify(candidate({ reference, outstandingIqd: iqd(amount) }), '2026-02-15', 'IQD'),
    );

  it('never selects more than the cash available', () => {
    const result = selectWithinFunds(
      classified([
        ['A', '600'],
        ['B', '600'],
      ]),
      iqd('1000'),
    );

    expect(result.selectedTotalIqd).toBeLessThanOrEqual(iqd('1000'));
    expect(result.selected).toHaveLength(1);
    expect(result.deferred).toHaveLength(1);
  });

  it('keeps going past an item that does not fit, rather than stopping', () => {
    const result = selectWithinFunds(
      classified([
        ['BIG', '900'],
        ['SMALL', '100'],
      ]).map((row, index) => ({ ...row, dueDate: index === 0 ? '2026-01-01' : '2026-01-02' })),
      iqd('500'),
    );

    // The big one leads the ranking and does not fit; the small one still goes.
    expect(result.selected.map((row) => row.reference)).toEqual(['SMALL']);
    expect(result.deferred.map((row) => row.reference)).toEqual(['BIG']);
  });

  it('never part-pays the item that did not fit', () => {
    const result = selectWithinFunds(classified([['A', '900']]), iqd('500'));
    expect(result.selected).toHaveLength(0);
    expect(result.deferred[0]!.outstandingIqd).toBe(iqd('900'));
  });

  it('says why a deferred item was deferred, and that it is otherwise eligible', () => {
    const result = selectWithinFunds(classified([['A', '900']]), iqd('500'));
    expect(result.deferred[0]!.inclusion).toBe('deferred_funds');
    expect(result.deferred[0]!.reason).toMatch(/eligible in every other respect/);
  });

  it('selects nothing when there is no cash, and refuses nothing on eligibility', () => {
    const result = selectWithinFunds(classified([['A', '100']]), 0n);
    expect(result.selected).toHaveLength(0);
    expect(result.deferred).toHaveLength(1);
    expect(result.excluded).toHaveLength(0);
  });

  it('keeps excluded items apart from deferred ones — they are different answers', () => {
    const rows = [
      classify(candidate({ reference: 'BLOCKED', supplierStatus: 'blocked' }), '2026-02-15', 'IQD'),
      classify(candidate({ reference: 'OK', outstandingIqd: iqd('100') }), '2026-02-15', 'IQD'),
    ];
    const result = selectWithinFunds(rows, iqd('50'));

    expect(result.excluded.map((row) => row.reference)).toEqual(['BLOCKED']);
    expect(result.deferred.map((row) => row.reference)).toEqual(['OK']);
    expect(result.deferredTotalIqd).toBe(iqd('100'));
  });
});

describe('Appendix D · discount opportunities are reported, not deducted', () => {
  it('values an open discount', () => {
    const result = discountOpportunity({
      outstandingIqd: iqd('1000'),
      discountPercent: 2n * 10_000n,
      discountDeadline: '2026-02-20',
      payOn: '2026-02-15',
    });
    expect(result.open).toBe(true);
    expect(result.amountIqd).toBe(iqd('20'));
  });

  it('is worth nothing once the deadline has passed', () => {
    const result = discountOpportunity({
      outstandingIqd: iqd('1000'),
      discountPercent: 2n * 10_000n,
      discountDeadline: '2026-02-10',
      payOn: '2026-02-15',
    });
    expect(result.open).toBe(false);
    expect(result.amountIqd).toBe(0n);
  });

  it('is worth nothing when the terms carry no discount', () => {
    const result = discountOpportunity({
      outstandingIqd: iqd('1000'),
      discountPercent: null,
      discountDeadline: null,
      payOn: '2026-02-15',
    });
    expect(result.amountIqd).toBe(0n);
  });

  it('counts the deadline day itself as still open', () => {
    const result = discountOpportunity({
      outstandingIqd: iqd('1000'),
      discountPercent: 10_000n,
      discountDeadline: '2026-02-15',
      payOn: '2026-02-15',
    });
    expect(result.open).toBe(true);
  });
});

describe('§17 · what counts as high-risk (D13)', () => {
  it('treats everything as high-risk when no threshold is configured', () => {
    expect(isHighRisk(1n, null)).toBe(true);
  });

  it('treats everything as high-risk at the zero default', () => {
    expect(isHighRisk(1n, 0n)).toBe(true);
    expect(isHighRisk(iqd('1000000'), 0n)).toBe(true);
  });

  it('takes the threshold as the lowest amount that is high-risk', () => {
    expect(isHighRisk(iqd('5000000'), iqd('5000000'))).toBe(true);
    expect(isHighRisk(iqd('4999999'), iqd('5000000'))).toBe(false);
  });
});

describe('§17 and §15 · beneficiary bank details', () => {
  const approved = { approvalStatus: 'approved', isActive: true, revision: 3 };

  it('accepts approved, active details', () => {
    expect(() => assertBeneficiaryPayable('SUP-001', approved)).not.toThrow();
  });

  it('refuses a supplier with no details at all', () => {
    expect(() => assertBeneficiaryPayable('SUP-001', null)).toThrow(BeneficiaryNotPayableError);
  });

  it('refuses details that have not been independently approved', () => {
    expect(() =>
      assertBeneficiaryPayable('SUP-001', { ...approved, approvalStatus: 'draft' }),
    ).toThrow(/not been independently approved/);
  });

  it('refuses details that are not active', () => {
    expect(() => assertBeneficiaryPayable('SUP-001', { ...approved, isActive: false })).toThrow(
      /not active/,
    );
  });

  it('refuses details that changed after the approval was given (§15)', () => {
    expect(() => assertBeneficiaryPayable('SUP-001', approved, 2)).toThrow(
      /changed after this payment was approved/,
    );
  });

  it('accepts details that are the ones the approver saw', () => {
    expect(() => assertBeneficiaryPayable('SUP-001', approved, 3)).not.toThrow();
  });

  it('does not compare a revision when none was recorded', () => {
    expect(() => assertBeneficiaryPayable('SUP-001', approved, null)).not.toThrow();
  });
});
