/**
 * Phase 13 — investment rules, §13 and Appendix E (IFRS 9).
 *
 * Pure: no database, no clock, and — the point of this phase — **no category
 * list and no valuation method**. Several tests below assert an absence, because
 * §13 says the treatment differs by instrument and Finance defines the
 * categories. A test that named a method would freeze D2's answer as firmly as
 * the code would.
 */
import { describe, expect, it } from 'vitest';
import {
  assertApprovedForAcquisition,
  assertProposalComplete,
  assertRequiredFields,
  assertValuationMethod,
  baseEquivalent,
  disposalOutcome,
  DisposalTooLargeError,
  latestValuation,
  missingRequiredFields,
  NotApprovedForAcquisitionError,
  portfolioTotals,
  ProposalIncompleteError,
  proposalGaps,
  RequiredFieldsMissingError,
  ValuationMethodUnknownError,
  valuationHistory,
  type ApprovalState,
  type ProposalFields,
} from '@domain/investments';

const iqd = (whole: string) => BigInt(whole) * 10_000n;
const units = (whole: string) => BigInt(whole) * 1_000_000n;

function proposal(overrides: Partial<ProposalFields> = {}): ProposalFields {
  return {
    typeCode: 'TYPE-A',
    amountIqd: iqd('500000'),
    currencyCode: 'IQD',
    expectedReturn: '8% per annum',
    riskAssessment: 'Moderate — counterparty is rated',
    ...overrides,
  };
}

function approvals(overrides: Partial<ApprovalState> = {}): ApprovalState {
  return {
    managementApprovedBy: 'user-management',
    fundingApprovedBy: 'user-treasury',
    isRelatedParty: false,
    relatedPartyApprovedBy: null,
    relatedPartyApprovalRequired: false,
    ...overrides,
  };
}

describe('§13 workflow step 1 · a proposal states five things', () => {
  it('accepts one that states all five', () => {
    expect(() => assertProposalComplete(proposal())).not.toThrow();
  });

  it('reports every gap at once, not the first', () => {
    const gaps = proposalGaps(
      proposal({ currencyCode: null, expectedReturn: '  ', riskAssessment: null }),
    );
    expect(gaps).toHaveLength(3);
    expect(gaps).toContain('a currency');
    expect(gaps).toContain('the expected return');
    expect(gaps).toContain('a risk assessment');
  });

  it('treats whitespace as absent, because it is', () => {
    expect(proposalGaps(proposal({ riskAssessment: '   ' }))).toContain('a risk assessment');
  });

  it('treats an amount of nothing as absent', () => {
    expect(proposalGaps(proposal({ amountIqd: 0n }))).toContain('an amount');
    expect(proposalGaps(proposal({ amountIqd: -1n }))).toContain('an amount');
  });

  it('names what is missing in the message', () => {
    expect(() => assertProposalComplete(proposal({ riskAssessment: null }))).toThrow(
      ProposalIncompleteError,
    );
    expect(() => assertProposalComplete(proposal({ riskAssessment: null }))).toThrow(
      /a risk assessment/,
    );
  });
});

describe('§13.1 · required fields come from the type, not from this file', () => {
  it('demands what the configuration demands, and nothing else', () => {
    const required = ['counterparty', 'custodian', 'maturityDate'];
    const missing = missingRequiredFields(required, {
      counterparty: 'Gulf Holdings',
      custodian: null,
      maturityDate: '',
      somethingElse: 'ignored',
    });
    expect(missing).toEqual(['custodian', 'maturityDate']);
  });

  it('demands nothing when the type demands nothing', () => {
    expect(missingRequiredFields([], {})).toEqual([]);
  });

  it('accepts a non-string value as present', () => {
    // A number, a boolean and a date are all supplied values. Only null,
    // undefined and blank text are absences.
    expect(missingRequiredFields(['units', 'listed'], { units: 100, listed: false })).toEqual([]);
  });

  it('names the type and the fields, and says the fix is configuration', () => {
    expect(() => assertRequiredFields('BOND', ['isin'], {})).toThrow(RequiredFieldsMissingError);
    expect(() => assertRequiredFields('BOND', ['isin'], {})).toThrow(/is configuration/);
  });

  it('adding a type is not a code change — the function never sees a type list', () => {
    // The 13.1 gate, as a property: any type code with any field list works.
    for (const [code, fields] of [
      ['ANYTHING', ['a']],
      ['INVENTED-LATER', ['x', 'y', 'z']],
    ] as const) {
      expect(() => assertRequiredFields(code, fields, {})).toThrow(RequiredFieldsMissingError);
    }
  });
});

describe('§13 acceptance 1 · both approvals before acquisition', () => {
  it('accepts management plus funding', () => {
    expect(() => assertApprovedForAcquisition(approvals())).not.toThrow();
  });

  it('refuses without management approval', () => {
    expect(() =>
      assertApprovedForAcquisition(approvals({ managementApprovedBy: null })),
    ).toThrow(/management has not approved/);
  });

  it('refuses without funding approval', () => {
    expect(() => assertApprovedForAcquisition(approvals({ fundingApprovedBy: null }))).toThrow(
      /funding source has not been approved/,
    );
  });

  it('checks the two separately, so one signature cannot stand for both', () => {
    const one = 'the-same-person';
    // Even the same person twice is two approvals; what must not happen is one
    // approval satisfying both checks.
    expect(() =>
      assertApprovedForAcquisition(
        approvals({ managementApprovedBy: one, fundingApprovedBy: null }),
      ),
    ).toThrow(NotApprovedForAcquisitionError);
  });

  it('refuses a related-party investment whose type demands the extra approval', () => {
    expect(() =>
      assertApprovedForAcquisition(
        approvals({ isRelatedParty: true, relatedPartyApprovalRequired: true }),
      ),
    ).toThrow(/related-party/);
  });

  it('accepts it once that approval is given', () => {
    expect(() =>
      assertApprovedForAcquisition(
        approvals({
          isRelatedParty: true,
          relatedPartyApprovalRequired: true,
          relatedPartyApprovedBy: 'user-board',
        }),
      ),
    ).not.toThrow();
  });

  it('does not demand it where the type does not — the requirement is configuration', () => {
    expect(() =>
      assertApprovedForAcquisition(
        approvals({ isRelatedParty: true, relatedPartyApprovalRequired: false }),
      ),
    ).not.toThrow();
  });
});

describe('§13 · valuation methods are Finance’s, and this file knows none', () => {
  it('refuses a valuation with no method', () => {
    expect(() => assertValuationMethod(null, ['whatever'])).toThrow(ValuationMethodUnknownError);
    expect(() => assertValuationMethod('  ', ['whatever'])).toThrow(ValuationMethodUnknownError);
  });

  it('refuses a method Finance has not configured', () => {
    expect(() => assertValuationMethod('fair_value', [])).toThrow(ValuationMethodUnknownError);
  });

  it('accepts any method Finance has configured, whatever it is called', () => {
    // The 13.5 discipline as a property: the domain has no opinion about which
    // methods exist, only that this one was approved.
    for (const method of ['cost', 'fair_value', 'equity_method', 'something-finance-invents']) {
      expect(() => assertValuationMethod(method, [method])).not.toThrow();
    }
  });

  it('says whose decision it is, and names D2', () => {
    expect(() => assertValuationMethod(null, [])).toThrow(/D2/);
  });
});

describe('§13 · historical valuations are preserved, not overwritten', () => {
  const history = [
    { valuedOn: '2026-06-30', method: 'm1', valueIqd: iqd('520000'), approvedBy: 'u2' },
    { valuedOn: '2026-03-31', method: 'm1', valueIqd: iqd('500000'), approvedBy: 'u1' },
    { valuedOn: '2026-09-30', method: 'm2', valueIqd: iqd('480000'), approvedBy: 'u3' },
  ];

  it('orders oldest first, so "the value at the time" is a lookup', () => {
    expect(valuationHistory(history).map((v) => v.valuedOn)).toEqual([
      '2026-03-31',
      '2026-06-30',
      '2026-09-30',
    ]);
  });

  it('carries the method used at the time, with the value', () => {
    const ordered = valuationHistory(history);
    expect(ordered[0]!.method).toBe('m1');
    expect(ordered[2]!.method).toBe('m2');
  });

  it('keeps every approver — §13 acceptance 2', () => {
    expect(valuationHistory(history).map((v) => v.approvedBy)).toEqual(['u1', 'u2', 'u3']);
  });

  it('does not mutate what it was given', () => {
    const input = [...history];
    valuationHistory(input);
    expect(input.map((v) => v.valuedOn)).toEqual(history.map((v) => v.valuedOn));
  });

  it('reports the latest, and null when there is none', () => {
    expect(latestValuation(history)!.valuedOn).toBe('2026-09-30');
    expect(latestValuation([])).toBeNull();
  });
});

describe('§13.6 · disposal reduces units and carrying value proportionally', () => {
  const holding = { unitsHeld: units('1000'), carryingValueIqd: iqd('500000') };

  it('takes the units’ share of carrying value', () => {
    const result = disposalOutcome(holding, units('250'), iqd('140000'));
    expect(result.carryingValueDisposedIqd).toBe(iqd('125000'));
    expect(result.carryingValueRemainingIqd).toBe(iqd('375000'));
    expect(result.unitsRemaining).toBe(units('750'));
  });

  it('computes a gain when proceeds beat the carrying value disposed', () => {
    const result = disposalOutcome(holding, units('250'), iqd('140000'));
    expect(result.realisedResultIqd).toBe(iqd('15000'));
  });

  it('computes a loss when they fall short', () => {
    const result = disposalOutcome(holding, units('250'), iqd('100000'));
    expect(result.realisedResultIqd).toBe(-iqd('25000'));
  });

  it('clears to exactly zero on a full disposal', () => {
    const result = disposalOutcome(holding, units('1000'), iqd('600000'));
    expect(result.isFullDisposal).toBe(true);
    expect(result.unitsRemaining).toBe(0n);
    expect(result.carryingValueRemainingIqd).toBe(0n);
    expect(result.realisedResultIqd).toBe(iqd('100000'));
  });

  it('reaches exactly zero through a sequence of awkward partials', () => {
    // The reason the remainder is a subtraction rather than a second
    // multiplication: three roundings of a third do not have to sum to the whole.
    let current = { unitsHeld: units('1000'), carryingValueIqd: iqd('1000') };
    for (const slice of ['333', '333', '334']) {
      const result = disposalOutcome(current, units(slice), 0n);
      current = {
        unitsHeld: result.unitsRemaining,
        carryingValueIqd: result.carryingValueRemainingIqd,
      };
    }
    expect(current.unitsHeld).toBe(0n);
    expect(current.carryingValueIqd).toBe(0n);
  });

  it('recognises a full disposal by units, not by a caller’s claim', () => {
    expect(disposalOutcome(holding, units('999'), 0n).isFullDisposal).toBe(false);
  });

  it('refuses more units than are held', () => {
    expect(() => disposalOutcome(holding, units('1001'), 0n)).toThrow(DisposalTooLargeError);
  });

  it('refuses a disposal of nothing', () => {
    expect(() => disposalOutcome(holding, 0n, 0n)).toThrow(DisposalTooLargeError);
    expect(() => disposalOutcome(holding, -units('1'), 0n)).toThrow(DisposalTooLargeError);
  });

  it('handles a scrapped holding with no proceeds', () => {
    const result = disposalOutcome(holding, units('1000'), 0n);
    expect(result.realisedResultIqd).toBe(-iqd('500000'));
  });
});

describe('§13.8 · portfolio totals, with unrealised derived rather than stored', () => {
  const lines = [
    {
      costIqd: iqd('500000'),
      carryingValueIqd: iqd('560000'),
      incomeIqd: iqd('20000'),
      realisedResultIqd: 0n,
    },
    {
      costIqd: iqd('300000'),
      carryingValueIqd: iqd('250000'),
      incomeIqd: iqd('5000'),
      realisedResultIqd: iqd('10000'),
    },
  ];

  it('sums cost, carrying value, income and realised result', () => {
    const totals = portfolioTotals(lines);
    expect(totals.costIqd).toBe(iqd('800000'));
    expect(totals.carryingValueIqd).toBe(iqd('810000'));
    expect(totals.incomeIqd).toBe(iqd('25000'));
    expect(totals.realisedResultIqd).toBe(iqd('10000'));
  });

  it('derives unrealised as carrying value less cost', () => {
    expect(portfolioTotals(lines).unrealisedResultIqd).toBe(iqd('10000'));
  });

  it('keeps realised and unrealised separate — §13.8 asks for both', () => {
    // The case that matters is the one where they point opposite ways: a
    // portfolio that has banked a gain and is carrying a loss. Netted into one
    // number it reads as break-even, which is true of neither half.
    const totals = portfolioTotals([
      {
        costIqd: iqd('400000'),
        carryingValueIqd: iqd('340000'),
        incomeIqd: 0n,
        realisedResultIqd: iqd('60000'),
      },
    ]);
    expect(totals.realisedResultIqd).toBe(iqd('60000'));
    expect(totals.unrealisedResultIqd).toBe(-iqd('60000'));
    expect(totals.totalReturnIqd).toBe(0n);
  });

  it('reports an empty portfolio as zeros rather than refusing', () => {
    const totals = portfolioTotals([]);
    expect(totals.costIqd).toBe(0n);
    expect(totals.totalReturnIqd).toBe(0n);
  });

  it('reports a loss-making portfolio without flinching', () => {
    const totals = portfolioTotals([
      { costIqd: iqd('100000'), carryingValueIqd: iqd('40000'), incomeIqd: 0n, realisedResultIqd: 0n },
    ]);
    expect(totals.unrealisedResultIqd).toBe(-iqd('60000'));
    expect(totals.totalReturnIqd).toBe(-iqd('60000'));
  });
});

describe('§13 · foreign currency stores both sides', () => {
  it('converts at the rate given, not at a rate it looks up', () => {
    // 9,000 USD at 1,310 IQD, rate scale 1e8 as exchange_rate stores it.
    const usd = 9_000n * 10_000n;
    expect(baseEquivalent(usd, 1_310n * 100_000_000n, 100_000_000n)).toBe(11_790_000n * 10_000n);
  });

  it('is exact arithmetic, with no float in the path', () => {
    const odd = baseEquivalent(1n, 3n, 7n);
    expect(typeof odd).toBe('bigint');
  });
});
