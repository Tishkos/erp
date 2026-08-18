/**
 * Phase 10 domain unit tests — §11.
 *
 * Every case names the blueprint clause it comes from. These are the rules that
 * can be decided without a database; the integration suite proves the same rules
 * hold at the database as well.
 */
import { describe, expect, it } from 'vitest';
import {
  allocateAcrossFundings,
  assertCloseable,
  assertJobTransition,
  carrierPerformance,
  closeBlockers,
  isAllowedJobTransition,
  jobMargin,
  JobNotCloseableError,
  JobStatusSkipError,
  LOGISTICS_JOB_STATUSES,
  missingEvidence,
  splitRecognition,
} from '@domain/logistics';
import { parseDecimal } from '@domain/money';

const iqd = (value: string) => parseDecimal(value, 4n);

describe('Appendix B — Logistics Job statuses', () => {
  it('lists exactly Appendix B\'s progression, with no Pending Approval state', () => {
    // Appendix B: "Draft, Approved, In Progress, Delivered, Settled, Closed,
    // Cancelled". Purchase Order and Goods Receipt both have a Pending Approval
    // state and this document does not — the absence is honoured, not filled in.
    expect(LOGISTICS_JOB_STATUSES).toEqual([
      'draft',
      'approved',
      'partially_executed',
      'executed',
      'settled',
      'closed',
    ]);
    expect(LOGISTICS_JOB_STATUSES).not.toContain('submitted');
  });

  it('allows each step of the workflow in turn (10.2)', () => {
    expect(isAllowedJobTransition('draft', 'approved')).toBe(true);
    expect(isAllowedJobTransition('approved', 'partially_executed')).toBe(true);
    expect(isAllowedJobTransition('partially_executed', 'executed')).toBe(true);
    expect(isAllowedJobTransition('executed', 'settled')).toBe(true);
    expect(isAllowedJobTransition('settled', 'closed')).toBe(true);
  });

  it('rejects skips — 10.2: "rejects skips"', () => {
    expect(isAllowedJobTransition('draft', 'executed')).toBe(false);
    expect(isAllowedJobTransition('approved', 'settled')).toBe(false);
    expect(isAllowedJobTransition('partially_executed', 'closed')).toBe(false);
    expect(isAllowedJobTransition('draft', 'closed')).toBe(false);
  });

  it('never runs backwards — §11.2 is a sequence of things that happened', () => {
    expect(isAllowedJobTransition('executed', 'partially_executed')).toBe(false);
    expect(isAllowedJobTransition('settled', 'executed')).toBe(false);
    expect(isAllowedJobTransition('approved', 'draft')).toBe(false);
  });

  it('cancels only before anything can have posted (§28.1, Q10-3)', () => {
    expect(isAllowedJobTransition('draft', 'cancelled')).toBe(true);
    expect(isAllowedJobTransition('approved', 'cancelled')).toBe(true);
    // From In Progress onward a job may carry posted cost and client funding,
    // and what becomes of that money is a Finance decision this phase must not
    // make.
    expect(isAllowedJobTransition('partially_executed', 'cancelled')).toBe(false);
    expect(isAllowedJobTransition('executed', 'cancelled')).toBe(false);
    expect(isAllowedJobTransition('settled', 'cancelled')).toBe(false);
  });

  it('treats closed and cancelled as the end of the job', () => {
    expect(isAllowedJobTransition('closed', 'settled')).toBe(false);
    expect(isAllowedJobTransition('cancelled', 'approved')).toBe(false);
  });

  it('names the workflow when it refuses a skip', () => {
    try {
      assertJobTransition('LJB-BGW-2026-000001', 'draft', 'settled');
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(JobStatusSkipError);
      expect((error as Error).message).toContain('Draft');
      expect((error as Error).message).toContain('Settled');
      expect((error as Error).message).toContain('Appendix B');
    }
  });
});

describe('§11.3 — job margin', () => {
  it('is the service charge less the allocated direct cost', () => {
    // §11.3: "direct logistics expenses are allocated to the job and deducted
    // from the logistics service charge to determine job margin".
    const margin = jobMargin({ serviceChargeIqd: iqd('1500000'), directCostIqd: iqd('900000') });

    expect(margin.marginIqd).toBe(iqd('600000'));
    expect(margin.marginBasisPoints).toBe(4000); // 40.00%
  });

  it('reports a loss rather than clamping at zero', () => {
    // A job that cost more than it charged is a fact the Gross Margin report
    // has to be able to show (§11.5).
    const margin = jobMargin({ serviceChargeIqd: iqd('100000'), directCostIqd: iqd('250000') });
    expect(margin.marginIqd).toBe(iqd('-150000'));
    expect(margin.marginBasisPoints).toBe(-15000);
  });

  it('has no margin percentage when nothing was charged', () => {
    const margin = jobMargin({ serviceChargeIqd: 0n, directCostIqd: iqd('5000') });
    expect(margin.marginIqd).toBe(iqd('-5000'));
    expect(margin.marginBasisPoints).toBeNull();
  });

  it('matches a hand-worked example (10.5 gate)', () => {
    // Charged: freight 1,200,000 + customs handling 300,000 = 1,500,000
    // Costs:   sea freight 700,000 + customs duty 150,000 + haulage 200,000
    //        = 1,050,000
    // Margin:  450,000
    const charge = iqd('1200000') + iqd('300000');
    const cost = iqd('700000') + iqd('150000') + iqd('200000');
    expect(jobMargin({ serviceChargeIqd: charge, directCostIqd: cost }).marginIqd).toBe(
      iqd('450000'),
    );
  });
});

describe('§11.4 — recognition against clearing and receivable', () => {
  it('discharges what the client funded and bills the rest', () => {
    const split = splitRecognition(iqd('600000'), iqd('1000000'));
    expect(split.fromClearingIqd).toBe(iqd('600000'));
    expect(split.fromReceivableIqd).toBe(iqd('400000'));
  });

  it('bills nothing when the job was funded in full', () => {
    const split = splitRecognition(iqd('1000000'), iqd('1000000'));
    expect(split.fromClearingIqd).toBe(iqd('1000000'));
    expect(split.fromReceivableIqd).toBe(0n);
  });

  it('never debits the clearing account past what was funded', () => {
    // The whole reason funded-first is the only sensible reading: a liability
    // clearing account in debit is an unfunded balance dressed as held money.
    const split = splitRecognition(iqd('2000000'), iqd('500000'));
    expect(split.fromClearingIqd).toBe(iqd('500000'));
    expect(split.fromReceivableIqd).toBe(0n);
  });

  it('bills the whole charge when nothing was funded', () => {
    const split = splitRecognition(0n, iqd('750000'));
    expect(split.fromClearingIqd).toBe(0n);
    expect(split.fromReceivableIqd).toBe(iqd('750000'));
  });

  it('refuses a negative recognition — that is a credit note', () => {
    expect(() => splitRecognition(iqd('100'), iqd('-1'))).toThrow(RangeError);
  });
});

describe('§11.4 — discharging fundings that credited different stages', () => {
  const fundings = [
    { id: 'f1', clearingRole: 'deferred_service_balance', amountIqd: iqd('400000'), fundingDate: '2026-03-01' },
    { id: 'f2', clearingRole: 'client_logistics_clearing', amountIqd: iqd('300000'), fundingDate: '2026-03-15' },
  ];

  it('takes the oldest funding first, so the journal is reproducible (§24)', () => {
    const debits = allocateAcrossFundings(fundings, iqd('500000'));

    expect(debits).toEqual([
      { role: 'client_logistics_clearing', amountIqd: iqd('100000'), fundingIds: ['f2'] },
      { role: 'deferred_service_balance', amountIqd: iqd('400000'), fundingIds: ['f1'] },
    ]);
  });

  it('leaves neither clearing account holding a residue when all is discharged', () => {
    const debits = allocateAcrossFundings(fundings, iqd('700000'));
    const total = debits.reduce((sum, d) => sum + d.amountIqd, 0n);
    expect(total).toBe(iqd('700000'));
    expect(debits.map((d) => d.role).sort()).toEqual([
      'client_logistics_clearing',
      'deferred_service_balance',
    ]);
  });

  it('groups two fundings that used the same role into one debit line', () => {
    const same = [
      { id: 'a', clearingRole: 'client_logistics_clearing', amountIqd: iqd('100'), fundingDate: '2026-01-01' },
      { id: 'b', clearingRole: 'client_logistics_clearing', amountIqd: iqd('200'), fundingDate: '2026-01-02' },
    ];
    expect(allocateAcrossFundings(same, iqd('300'))).toEqual([
      { role: 'client_logistics_clearing', amountIqd: iqd('300'), fundingIds: ['a', 'b'] },
    ]);
  });

  it('refuses to discharge more than is held', () => {
    expect(() => allocateAcrossFundings(fundings, iqd('900000'))).toThrow(/did not derive/);
  });

  it('discharges nothing when nothing is being recognised against funding', () => {
    expect(allocateAcrossFundings(fundings, 0n)).toEqual([]);
  });
});

describe('10.7 — delivery evidence', () => {
  it('names what a job still has to prove', () => {
    expect(missingEvidence(['pod', 'customs_clearance'], ['pod'])).toEqual(['customs_clearance']);
  });

  it('is satisfied when everything required is held', () => {
    expect(missingEvidence(['pod'], ['pod', 'photo'])).toEqual([]);
  });

  it('requires nothing when the service type configures nothing', () => {
    // The blueprint nowhere says what each service must prove; an empty list is
    // the Logistics department's decision, not a default this phase invents.
    expect(missingEvidence([], [])).toEqual([]);
  });
});

describe('10.2 and 10.8 — what stops a job closing', () => {
  const clean = {
    jobNo: 'LJB-BGW-2026-000001',
    unbilledChargeIqd: 0n,
    unsettledCostIqd: 0n,
    openClientBalanceIqd: 0n,
    openLegCount: 0,
    openClaimCount: 0,
  };

  it('lets a settled, fully billed job close', () => {
    expect(closeBlockers(clean)).toEqual([]);
    expect(() => assertCloseable(clean)).not.toThrow();
  });

  it('refuses an unbilled charge — 10.2', () => {
    const blockers = closeBlockers({ ...clean, unbilledChargeIqd: iqd('250000') });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('not been billed');
  });

  it('refuses an unposted cost — 10.8: "unrecorded cost"', () => {
    const blockers = closeBlockers({ ...clean, unsettledCostIqd: iqd('90000') });
    expect(blockers[0]).toContain('not posted');
  });

  it('refuses an open client balance — 10.8', () => {
    const blockers = closeBlockers({ ...clean, openClientBalanceIqd: iqd('-100') });
    expect(blockers[0]).toContain('client balance');
  });

  it('reports every reason at once rather than one at a time', () => {
    const blockers = closeBlockers({
      ...clean,
      unbilledChargeIqd: iqd('1'),
      unsettledCostIqd: iqd('1'),
      openClientBalanceIqd: iqd('1'),
      openLegCount: 2,
      openClaimCount: 1,
    });
    expect(blockers).toHaveLength(5);
  });

  it('throws with every reason listed', () => {
    try {
      assertCloseable({ ...clean, openLegCount: 1, openClaimCount: 1 });
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(JobNotCloseableError);
      expect((error as Error).message).toContain('route leg');
      expect((error as Error).message).toContain('claim');
    }
  });
});

describe('10.3 — carrier performance', () => {
  it('scores a leg on time when it arrived by the planned date', () => {
    const performance = carrierPerformance([
      { plannedArrival: '2026-03-10', actualArrival: '2026-03-09' },
      { plannedArrival: '2026-03-10', actualArrival: '2026-03-10' },
      { plannedArrival: '2026-03-10', actualArrival: '2026-03-12' },
    ]);

    expect(performance.delivered).toBe(3);
    expect(performance.onTime).toBe(2);
    expect(performance.late).toBe(1);
    expect(performance.onTimeBasisPoints).toBe(6667);
  });

  it('does not score a leg the carrier never agreed a date for', () => {
    const performance = carrierPerformance([
      { plannedArrival: null, actualArrival: '2026-03-09' },
      { plannedArrival: '2026-03-10', actualArrival: '2026-03-11' },
    ]);

    expect(performance.delivered).toBe(2);
    expect(performance.onTime).toBe(0);
    expect(performance.late).toBe(1);
    expect(performance.onTimeBasisPoints).toBe(0);
  });

  it('has no score before anything has arrived', () => {
    const performance = carrierPerformance([
      { plannedArrival: '2026-03-10', actualArrival: null },
    ]);

    expect(performance.legs).toBe(1);
    expect(performance.delivered).toBe(0);
    expect(performance.onTimeBasisPoints).toBeNull();
  });

  it('compares ISO date strings, never JS Date', () => {
    // A Date here would make "arrived on time" depend on the server's offset.
    // 2026-03-10 vs 2026-03-09 must be decided by the calendar, not the clock.
    const performance = carrierPerformance([
      { plannedArrival: '2026-12-31', actualArrival: '2027-01-01' },
    ]);
    expect(performance.late).toBe(1);
  });
});
