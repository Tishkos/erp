/**
 * REQ-AP-001 — the payables domain rules, decidable without a database.
 *
 * The seed rails tested here are copies of the migration's seeds; the
 * integration suite (`ap01-stage-derivation`) asserts the database rows drive
 * the same answers, so the two cannot drift silently.
 */
import { describe, expect, it } from 'vitest';
import {
  NO_FACTS,
  PENDING_REASON,
  PayableValidationError,
  STAGE_RULES,
  UnknownStageRuleError,
  assertHoldComplete,
  deriveStage,
  limitInForce,
  referenceKey,
  type StageRow,
} from '@domain/payables';

// ---------------------------------------------------------------------------
// R1 — the reference key
// ---------------------------------------------------------------------------

describe('R1 · the supplier reference key', () => {
  it('normalises to upper-case letters and digits, as the sheet’s formulas did', () => {
    expect(referenceKey('CSA-AL0001-1')).toBe('CSAAL00011');
    expect(referenceKey(' csa al0001/1 ')).toBe('CSAAL00011');
    expect(referenceKey('inv_2026·003')).toBe('INV2026003');
  });

  it('refuses a reference that would normalise to nothing', () => {
    expect(() => referenceKey(' --- ')).toThrow(PayableValidationError);
  });
});

// ---------------------------------------------------------------------------
// §6 — stage derivation, one rail per seeded type
// ---------------------------------------------------------------------------

const rail = (...stages: Array<[string, string]>): StageRow[] =>
  stages.map(([code, ruleName], index) => ({
    code,
    ruleName,
    sequence: index + 1,
    active: true,
  }));

const IMPORT = rail(
  ['order_confirmed', 'opened'],
  ['invoiced_funded', 'import_invoiced_funded'],
  ['pd_registered', 'import_pd_registered'],
  ['payment_in_progress', 'payment_sent'],
  ['shipped', 'import_shipped'],
  ['partly_received', 'import_partly_received'],
  ['all_received', 'import_all_received'],
  ['cleared', 'import_cleared'],
);

const SERVICE = rail(
  ['requested', 'opened'],
  ['confirmed', 'service_confirmed'],
  ['invoiced', 'invoice_posted'],
  ['approved', 'invoice_approved'],
  ['payment_in_progress', 'payment_sent'],
  ['paid', 'fully_paid'],
  ['closed', 'closed_matched'],
);

describe('§6 · stage derivation', () => {
  it('a payable that exists and nothing more is at stage 1', () => {
    expect(deriveStage(IMPORT, NO_FACTS)).toBe('order_confirmed');
    expect(deriveStage(SERVICE, NO_FACTS)).toBe('requested');
  });

  it('derives the highest stage whose rule holds, not the first', () => {
    expect(
      deriveStage(IMPORT, { ...NO_FACTS, postedInvoiceCount: 1, livePdCount: 1 }),
    ).toBe('pd_registered');
  });

  it('R2 — deposit paid then shipped reads Shipped while the payment lane shows its own state', () => {
    // The sponsor’s own case: deposit paid (nothing pending), goods on the
    // water, balance not yet applied. Stage is 5; nothing about payment
    // completion is implied.
    const facts = {
      ...NO_FACTS,
      postedInvoiceCount: 1,
      containerCount: 5,
      containersReceived: 0,
    };
    expect(deriveStage(IMPORT, facts)).toBe('shipped');
  });

  it('R2 — an advance to a consultant: payment in progress while the service is unconfirmed', () => {
    const facts = { ...NO_FACTS, paymentSentCount: 1 };
    expect(deriveStage(SERVICE, facts)).toBe('payment_in_progress');
  });

  it('6 and 7 are exclusive: partly needs an unreceived container, all needs none', () => {
    const partly = { ...NO_FACTS, containerCount: 10, containersReceived: 3 };
    const all = { ...NO_FACTS, containerCount: 10, containersReceived: 10 };
    expect(deriveStage(IMPORT, partly)).toBe('partly_received');
    expect(deriveStage(IMPORT, all)).toBe('all_received');
  });

  it('8 requires 7: fully paid and written off is not cleared until every container is in', () => {
    const paidAndWrittenOff = {
      ...NO_FACTS,
      postedInvoiceCount: 1,
      fullyPaid: true,
      allPaymentsConfirmed: true,
      allPdsWrittenOff: true,
      receivedQuantityMatches: true,
      containerCount: 10,
      containersReceived: 9,
    };
    expect(deriveStage(IMPORT, paidAndWrittenOff)).toBe('partly_received');
    expect(
      deriveStage(IMPORT, { ...paidAndWrittenOff, containersReceived: 10 }),
    ).toBe('cleared');
  });

  it('skips a deactivated stage rather than failing on it', () => {
    const withoutPd = IMPORT.map((s) =>
      s.code === 'pd_registered' ? { ...s, active: false } : s,
    );
    expect(
      deriveStage(withoutPd, { ...NO_FACTS, postedInvoiceCount: 1, livePdCount: 1 }),
    ).toBe('order_confirmed');
  });

  it('names an unimplemented rule instead of guessing', () => {
    const bad = rail(['opened', 'opened'], ['later', 'rule_from_stage_9']);
    expect(() => deriveStage(bad, NO_FACTS)).toThrow(UnknownStageRuleError);
  });

  it('every seeded rule name is implemented', () => {
    for (const name of [
      'opened',
      'invoice_posted',
      'invoice_approved',
      'payment_sent',
      'fully_paid',
      'closed_matched',
      'import_invoiced_funded',
      'import_pd_registered',
      'import_shipped',
      'import_partly_received',
      'import_all_received',
      'import_cleared',
      'service_confirmed',
      'recurring_confirmed',
      'goods_received',
      'advance_approved',
      'advance_paid',
      'advance_settled',
    ]) {
      expect(STAGE_RULES[name], name).toBeTypeOf('function');
    }
  });
});

// ---------------------------------------------------------------------------
// §19 — completing a hold
// ---------------------------------------------------------------------------

describe('§19 · a hold is an answer, not a flag', () => {
  const complete = {
    reasonCode: 'BANK',
    reasonRequiresDetail: false,
    detail: null,
    ownerUserId: 'u1',
    nextAction: 'Call the bank’s trade desk',
    nextActionDue: '2026-10-05',
  };

  it('accepts reason + owner + next action + date', () => {
    expect(() => assertHoldComplete(complete)).not.toThrow();
  });

  it.each([
    ['the reason', { ...complete, reasonCode: PENDING_REASON }],
    ['the owner', { ...complete, ownerUserId: null }],
    ['the next action', { ...complete, nextAction: '  ' }],
    ['the date', { ...complete, nextActionDue: null }],
  ])('refuses without %s', (_label, input) => {
    expect(() => assertHoldComplete(input)).toThrow();
  });

  it('OTHER without detail is not a reason', () => {
    expect(() =>
      assertHoldComplete({
        ...complete,
        reasonCode: 'OTHER',
        reasonRequiresDetail: true,
        detail: '',
      }),
    ).toThrow(/detail/);
  });
});

// ---------------------------------------------------------------------------
// §19.3 — the limit in force
// ---------------------------------------------------------------------------

describe('§19.3 · time limits: most specific active row wins', () => {
  const row = (scope: string, limitDays: number, validFrom = '2026-01-01') => ({
    scope,
    limitDays,
    escalateAfterDays: 3,
    escalateToRole: 'accounting_manager',
    active: true,
    validFrom,
  });

  it('a bank row beats the general one', () => {
    const rows = [row('all', 14), row('bank:ARAB', 7)];
    expect(limitInForce(rows, { bankCode: 'ARAB' }, '2026-10-01')?.limitDays).toBe(7);
    expect(limitInForce(rows, { bankCode: 'NBI' }, '2026-10-01')?.limitDays).toBe(14);
  });

  it('a supplier row beats a bank row', () => {
    const rows = [row('bank:ARAB', 7), row('supplier:s-1', 3)];
    expect(
      limitInForce(rows, { bankCode: 'ARAB', supplierId: 's-1' }, '2026-10-01')?.limitDays,
    ).toBe(3);
  });

  it('a changed limit is a new row; the new one wins from its validity date', () => {
    const rows = [row('all', 14, '2026-01-01'), row('all', 10, '2026-09-01')];
    expect(limitInForce(rows, {}, '2026-10-01')?.limitDays).toBe(10);
    expect(limitInForce(rows, {}, '2026-06-01')?.limitDays).toBe(14);
  });

  it('an inactive or not-yet-valid row does not count', () => {
    const rows = [
      { ...row('all', 14), active: false },
      row('all', 10, '2027-01-01'),
    ];
    expect(limitInForce(rows, {}, '2026-10-01')).toBeNull();
  });
});
