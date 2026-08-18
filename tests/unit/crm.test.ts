/**
 * Phase 08 — CRM rules, §6 and Appendix B.
 *
 * Pure: no database, no clock.
 */
import { describe, expect, it } from 'vitest';
import {
  assertIdentityCarried,
  assertLostHasReason,
  assertStageTransition,
  conversionRate,
  DUPLICATE_CRITERIA,
  findDuplicates,
  IdentityNotCarriedError,
  LostNeedsReasonError,
  pipelineByStage,
  StageTransitionError,
  type Identity,
} from '@domain/crm';

const iqd = (whole: string) => BigInt(whole) * 10_000n;

function identity(overrides: Partial<Identity> = {}): Identity {
  return {
    name: 'Al Rasheed Trading Co.',
    phone: '+964 770 123 4567',
    email: 'accounts@alrasheed.iq',
    registrationNo: 'REG-88213',
    bankAccountNumber: 'IQ98 NBIQ 8501 2345 6789',
    ...overrides,
  };
}

describe('§6 · duplicate detection on all five criteria', () => {
  it('names all five', () => {
    expect(DUPLICATE_CRITERIA).toEqual([
      'name',
      'phone',
      'email',
      'registration_number',
      'bank_details',
    ]);
  });

  it('finds an exact duplicate on every one of them', () => {
    const hits = findDuplicates(identity(), identity());
    expect(hits.map((h) => h.criterion)).toEqual([...DUPLICATE_CRITERIA]);
  });

  it('finds nothing between two different companies', () => {
    const other = identity({
      name: 'Tigris Supplies',
      phone: '+964 750 999 8888',
      email: 'info@tigris.iq',
      registrationNo: 'REG-11111',
      bankAccountNumber: 'IQ11 NBIQ 1111 1111 1111',
    });
    expect(findDuplicates(identity(), other)).toEqual([]);
  });

  it('reports every criterion that matched, not just the first', () => {
    // Same phone and same email, different name.
    const hits = findDuplicates(
      identity({ name: 'Rasheed Trading', registrationNo: null, bankAccountNumber: null }),
      identity(),
    );
    expect(hits.map((h) => h.criterion)).toEqual(['phone', 'email']);
  });

  it('sees the same phone number dialled three ways', () => {
    for (const phone of ['07701234567', '00964 770 123 4567', '+964-770-1234567']) {
      const hits = findDuplicates(identity({ phone }), identity());
      expect(hits.map((h) => h.criterion)).toContain('phone');
    }
  });

  it('sees the same company name punctuated differently', () => {
    const hits = findDuplicates(identity({ name: 'al-rasheed trading co' }), identity());
    expect(hits.map((h) => h.criterion)).toContain('name');
  });

  it('sees the same IBAN spaced differently', () => {
    const hits = findDuplicates(
      identity({ bankAccountNumber: 'iq98nbiq850123456789' }),
      identity(),
    );
    expect(hits.map((h) => h.criterion)).toContain('bank_details');
  });

  it('does not merge two addresses that differ before the @', () => {
    const hits = findDuplicates(identity({ email: 'accounts.iq@alrasheed.iq' }), identity());
    expect(hits.map((h) => h.criterion)).not.toContain('email');
  });

  it('treats a missing field as unknown rather than as a match', () => {
    const blank = identity({
      name: null,
      phone: null,
      email: null,
      registrationNo: null,
      bankAccountNumber: null,
    });
    expect(findDuplicates(blank, blank)).toEqual([]);
  });

  it('ignores a phone too short to be one', () => {
    const hits = findDuplicates(identity({ phone: '12' }), identity({ phone: '12' }));
    expect(hits.map((h) => h.criterion)).not.toContain('phone');
  });

  it('detects rather than prevents — it returns hits, it does not throw', () => {
    expect(() => findDuplicates(identity(), identity())).not.toThrow();
  });
});

describe('Appendix B · opportunity stages', () => {
  it('allows the ordinary path', () => {
    expect(() => assertStageTransition('open', 'qualified')).not.toThrow();
    expect(() => assertStageTransition('qualified', 'won')).not.toThrow();
    expect(() => assertStageTransition('won', 'closed')).not.toThrow();
  });

  it('allows losing from either open or qualified', () => {
    expect(() => assertStageTransition('open', 'lost')).not.toThrow();
    expect(() => assertStageTransition('qualified', 'lost')).not.toThrow();
  });

  it('refuses to win an opportunity nobody qualified', () => {
    expect(() => assertStageTransition('open', 'won')).toThrow(StageTransitionError);
  });

  it('refuses to re-open a decided opportunity', () => {
    for (const from of ['won', 'lost', 'closed'] as const) {
      expect(() => assertStageTransition(from, 'open')).toThrow(/already been decided/);
    }
  });

  it('says a fresh approach is a new opportunity, and why', () => {
    expect(() => assertStageTransition('lost', 'qualified')).toThrow(
      /keeps the pipeline honest about how often we win/,
    );
  });

  it('requires a reason for a loss', () => {
    expect(() => assertLostHasReason('lost', null)).toThrow(LostNeedsReasonError);
    expect(() => assertLostHasReason('lost', '   ')).toThrow(LostNeedsReasonError);
    expect(() => assertLostHasReason('lost', 'Price')).not.toThrow();
  });

  it('asks for no reason when the opportunity was not lost', () => {
    expect(() => assertLostHasReason('won', null)).not.toThrow();
  });
});

describe('§6 criterion 1 · identity survives a conversion', () => {
  const source = {
    partnerId: 'partner-1',
    leadSourceCode: 'REFERRAL',
    campaignCode: 'SPRING-2026',
  };

  it('accepts a faithful copy', () => {
    expect(() => assertIdentityCarried(source, { ...source })).not.toThrow();
  });

  it('refuses a changed customer', () => {
    expect(() => assertIdentityCarried(source, { ...source, partnerId: 'partner-2' })).toThrow(
      IdentityNotCarriedError,
    );
  });

  it('refuses a changed source or campaign', () => {
    expect(() => assertIdentityCarried(source, { ...source, leadSourceCode: 'WEB' })).toThrow(
      /lead source changed/,
    );
    expect(() => assertIdentityCarried(source, { ...source, campaignCode: 'OTHER' })).toThrow(
      /campaign changed/,
    );
  });

  it('lets a conversion fill in a customer the lead did not have', () => {
    // §6 — a lead may exist without a partner; an opportunity may not. Filling
    // it in is the conversion doing its job, not an identity changing.
    expect(() =>
      assertIdentityCarried(
        { partnerId: null, leadSourceCode: 'REFERRAL', campaignCode: null },
        { partnerId: 'partner-1', leadSourceCode: 'REFERRAL', campaignCode: 'SPRING-2026' },
      ),
    ).not.toThrow();
  });

  it('says why it matters, not only that it is wrong', () => {
    expect(() => assertIdentityCarried(source, { ...source, partnerId: 'other' })).toThrow(
      /which campaign produced which revenue/,
    );
  });
});

describe('Appendix D · pipeline and conversion arithmetic', () => {
  const entries = [
    { stage: 'open' as const, ownerUserId: 'u1', expectedValueIqd: iqd('1000'), probabilityPercent: 20 },
    { stage: 'open' as const, ownerUserId: 'u2', expectedValueIqd: iqd('500'), probabilityPercent: 40 },
    { stage: 'qualified' as const, ownerUserId: 'u1', expectedValueIqd: iqd('2000'), probabilityPercent: 75 },
  ];

  it('totals by stage', () => {
    const totals = pipelineByStage(entries);
    expect(totals).toHaveLength(2);
    expect(totals[0]).toMatchObject({ stage: 'open', count: 2, expectedValueIqd: '1500.0000' });
    expect(totals[1]).toMatchObject({ stage: 'qualified', count: 1, expectedValueIqd: '2000.0000' });
  });

  it('weights by probability — what is on the table, and what to believe', () => {
    const totals = pipelineByStage(entries);
    expect(totals[0]!.weightedValueIqd).toBe('400.0000'); // 1,000×20% + 500×40%
    expect(totals[1]!.weightedValueIqd).toBe('1500.0000'); // 2,000×75%
  });

  it('keeps the stages in Appendix B order', () => {
    const totals = pipelineByStage([
      { stage: 'won', ownerUserId: 'u1', expectedValueIqd: iqd('1'), probabilityPercent: 100 },
      { stage: 'open', ownerUserId: 'u1', expectedValueIqd: iqd('1'), probabilityPercent: 10 },
    ]);
    expect(totals.map((t) => t.stage)).toEqual(['open', 'won']);
  });

  it('reports nothing for a stage with nothing in it', () => {
    expect(pipelineByStage([])).toEqual([]);
  });

  it('computes a conversion rate from counts, to one decimal', () => {
    expect(conversionRate(3, 12)).toBe(25);
    expect(conversionRate(1, 3)).toBe(33.3);
  });

  it('is zero rather than undefined when nothing came from a source', () => {
    expect(conversionRate(0, 0)).toBe(0);
  });
});
