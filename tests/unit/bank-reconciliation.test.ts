/**
 * Phase 07.7 — bank reconciliation matching and arithmetic, §17.
 *
 * Pure: no database, no clock.
 */
import { describe, expect, it } from 'vitest';
import {
  assertFinalisable,
  assertMatchBalances,
  MatchDoesNotBalanceError,
  proposeMatches,
  reconcile,
  score,
  UnexplainedDifferenceError,
  type LedgerSide,
  type StatementSide,
} from '@domain/bank-reconciliation';

const iqd = (whole: string) => BigInt(whole) * 10_000n;

function statement(overrides: Partial<StatementSide> = {}): StatementSide {
  return {
    id: 'S1',
    bookingDate: '2026-02-10',
    amountIqd: iqd('-1500'),
    reference: 'TRF-9001',
    counterparty: 'Supplier One',
    ...overrides,
  };
}

function ledger(overrides: Partial<LedgerSide> = {}): LedgerSide {
  return {
    id: 'L1',
    postingDate: '2026-02-10',
    amountIqd: iqd('-1500'),
    reference: 'TRF-9001',
    counterparty: 'Supplier One',
    ...overrides,
  };
}

describe('§17 · matching by amount, date, reference and counterparty', () => {
  it('scores a perfect match highest', () => {
    expect(score(statement(), ledger())).toBe(100);
  });

  it('refuses to score two different amounts at all', () => {
    // Not a weak match — not a match. Scoring it would invite somebody to
    // confirm a difference away.
    expect(score(statement(), ledger({ amountIqd: iqd('-1501') }))).toBeNull();
  });

  it('refuses to score entries too far apart in time', () => {
    expect(score(statement(), ledger({ postingDate: '2026-01-20' }))).toBeNull();
  });

  it('still matches across a few days of clearing', () => {
    const near = score(statement(), ledger({ postingDate: '2026-02-08' }));
    expect(near).not.toBeNull();
    expect(near!).toBeLessThan(100);
  });

  it('scores lower without a matching reference', () => {
    const withRef = score(statement(), ledger())!;
    const without = score(statement(), ledger({ reference: 'OTHER' }))!;
    expect(without).toBeLessThan(withRef);
  });

  it('scores lower without a matching counterparty', () => {
    const withParty = score(statement(), ledger())!;
    const without = score(statement(), ledger({ counterparty: 'Somebody Else' }))!;
    expect(without).toBeLessThan(withParty);
  });

  it('ignores punctuation and case in a reference, which banks vary freely', () => {
    expect(score(statement({ reference: 'trf 9001' }), ledger({ reference: 'TRF-9001' }))).toBe(
      100,
    );
  });

  it('gives partial credit where one reference contains the other', () => {
    const partial = score(
      statement({ reference: 'PAYMENT TRF-9001 BATCH' }),
      ledger({ reference: 'TRF-9001' }),
    )!;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(100);
  });
});

describe('§17 · proposals are suggestions, never decisions', () => {
  it('pairs the obvious ones', () => {
    const proposals = proposeMatches(
      [statement({ id: 'S1' }), statement({ id: 'S2', amountIqd: iqd('4000'), reference: 'DEP-1' })],
      [ledger({ id: 'L1' }), ledger({ id: 'L2', amountIqd: iqd('4000'), reference: 'DEP-1' })],
    );

    expect(proposals).toHaveLength(2);
    expect(proposals.map((p) => [p.statementLineIds[0], p.ledgerItemIds[0]])).toEqual(
      expect.arrayContaining([
        ['S1', 'L1'],
        ['S2', 'L2'],
      ]),
    );
  });

  it('uses each entry once, taking the best pairing first', () => {
    // Two ledger items could match S1; only the one with the reference should.
    const proposals = proposeMatches(
      [statement({ id: 'S1' })],
      [ledger({ id: 'L-WEAK', reference: null, counterparty: null }), ledger({ id: 'L-STRONG' })],
    );

    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.ledgerItemIds).toEqual(['L-STRONG']);
  });

  it('proposes nothing when nothing matches', () => {
    expect(proposeMatches([statement()], [ledger({ amountIqd: iqd('99') })])).toEqual([]);
  });

  it('says why it proposed each one', () => {
    const [proposal] = proposeMatches([statement()], [ledger()]);
    expect(proposal!.why).toMatch(/amount/);
    expect(proposal!.why).toMatch(/reference TRF-9001/);
    expect(proposal!.why).toMatch(/same day/);
  });

  it('is deterministic — two people see the same workspace', () => {
    const lines = [statement({ id: 'S1' }), statement({ id: 'S2' })];
    const items = [ledger({ id: 'L1' }), ledger({ id: 'L2' })];

    const first = proposeMatches(lines, items);
    const second = proposeMatches([...lines].reverse(), [...items].reverse());

    expect(first.map((p) => p.statementLineIds[0])).toEqual(
      second.map((p) => p.statementLineIds[0]),
    );
  });
});

describe('§12.5 · one statement line against a batch (the Phase 09 case)', () => {
  it('accepts several ledger items totalling one statement line', () => {
    expect(() =>
      assertMatchBalances([iqd('-10000')], [iqd('-4000'), iqd('-3500'), iqd('-2500')]),
    ).not.toThrow();
  });

  it('accepts several statement lines against one ledger item', () => {
    expect(() => assertMatchBalances([iqd('600'), iqd('400')], [iqd('1000')])).not.toThrow();
  });

  it('refuses a match whose sides do not total the same', () => {
    expect(() => assertMatchBalances([iqd('-10000')], [iqd('-9000')])).toThrow(
      MatchDoesNotBalanceError,
    );
  });

  it('names the alternative rather than only the rule', () => {
    expect(() => assertMatchBalances([iqd('-1000')], [iqd('-975')])).toThrow(
      /post it as an adjustment and match that too/,
    );
  });
});

describe('§17 criterion 3 · the reconciled balance agrees to the G/L', () => {
  it('adds deposits in transit and subtracts unpresented payments', () => {
    const result = reconcile({
      statementClosingIqd: iqd('12475'),
      ledgerBalanceIqd: iqd('12975'),
      depositsInTransitIqd: iqd('900'),
      unpresentedPaymentsIqd: iqd('400'),
    });

    expect(result.reconciledBalanceIqd).toBe(iqd('12975'));
    expect(result.differenceIqd).toBe(0n);
    expect(result.balanced).toBe(true);
  });

  it('balances when the two records already agree', () => {
    const result = reconcile({
      statementClosingIqd: iqd('5000'),
      ledgerBalanceIqd: iqd('5000'),
      depositsInTransitIqd: 0n,
      unpresentedPaymentsIqd: 0n,
    });
    expect(result.balanced).toBe(true);
  });

  it('reports what is left over when something is missing', () => {
    const result = reconcile({
      statementClosingIqd: iqd('12475'),
      ledgerBalanceIqd: iqd('12500'),
      depositsInTransitIqd: 0n,
      unpresentedPaymentsIqd: 0n,
    });

    // A 25 bank charge nobody has recorded.
    expect(result.differenceIqd).toBe(iqd('-25'));
    expect(result.balanced).toBe(false);
  });

  it('treats a timing difference as an explanation, not an error', () => {
    // The cheque was written on the 28th and has not been presented. Both
    // records are right; the reconciliation says so.
    const result = reconcile({
      statementClosingIqd: iqd('1000'),
      ledgerBalanceIqd: iqd('700'),
      depositsInTransitIqd: 0n,
      unpresentedPaymentsIqd: iqd('300'),
    });
    expect(result.balanced).toBe(true);
  });
});

describe('§17 · finalising over an unexplained difference is refused', () => {
  const balanced = reconcile({
    statementClosingIqd: iqd('1000'),
    ledgerBalanceIqd: iqd('1000'),
    depositsInTransitIqd: 0n,
    unpresentedPaymentsIqd: 0n,
  });

  const out = reconcile({
    statementClosingIqd: iqd('1000'),
    ledgerBalanceIqd: iqd('1025'),
    depositsInTransitIqd: 0n,
    unpresentedPaymentsIqd: 0n,
  });

  it('lets a balanced reconciliation through', () => {
    expect(() => assertFinalisable(balanced)).not.toThrow();
  });

  it('refuses one that is out', () => {
    expect(() => assertFinalisable(out)).toThrow(UnexplainedDifferenceError);
  });

  it('has no override — an adjustment explains the difference, it does not waive it', () => {
    // There is deliberately no second argument to reach for. The only way past
    // this is to post the adjustment, after which the arithmetic balances.
    expect(assertFinalisable.length).toBe(1);
  });

  it('says what the difference is and what to do about it', () => {
    expect(() => assertFinalisable(out)).toThrow(/bank charge, interest, a returned payment/);
  });
});
