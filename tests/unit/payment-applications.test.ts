/**
 * REQ-AP-001 §15.2–§15.5 — the payment application's rules, decidable
 * without a database: the instalment plan, the status machine, the checks on
 * Send and Applied / Paid / Remaining.
 */
import { describe, expect, it } from 'vitest';
import {
  PaymentApplicationError,
  SendRefusedError,
  accountTypeFor,
  addDays,
  assertTransition,
  confirmationEvent,
  failing,
  fundsCheck,
  instalmentStatus,
  isApplied,
  isLive,
  isPaid,
  isReserved,
  needsPayeeAccount,
  payeeCheck,
  pendingCheckFor,
  planAmounts,
  totals,
} from '@domain/payment-applications';

const m = (value: string) => {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 10_000n + BigInt(fraction.padEnd(4, '0'));
};

const SEEDED = [
  ['draft', 'approved'],
  ['draft', 'cancelled'],
  ['approved', 'sent'],
  ['approved', 'rejected'],
  ['approved', 'cancelled'],
  ['sent', 'confirmed'],
  ['sent', 'rejected'],
  ['sent', 'cancelled'],
  ['confirmed', 'debited'],
].map(([fromStatus, toStatus]) => ({ fromStatus: fromStatus!, toStatus: toStatus!, active: true }));

describe('§15.2 · planAmounts', () => {
  it('splits 10% / 90% of the invoice exactly', () => {
    const amounts = planAmounts(m('35000'), [
      { label: 'Deposit', basis: 'percent', percent: '10', triggerCode: 'on_order' },
      { label: 'Balance', basis: 'percent', percent: '90', triggerCode: 'days_after_bl', triggerDays: 60 },
    ]);
    expect(amounts).toEqual([m('3500'), m('31500')]);
  });

  it('lets the last row absorb a third’s rounding, and only that', () => {
    const amounts = planAmounts(m('100.00'), [
      { label: 'a', basis: 'percent', percent: '33.3333', triggerCode: 'on_order' },
      { label: 'b', basis: 'percent', percent: '33.3333', triggerCode: 'on_order' },
      { label: 'c', basis: 'percent', percent: '33.3333', triggerCode: 'on_order' },
    ]);
    expect(amounts.reduce((a, b) => a + b, 0n)).toBe(m('100'));
    expect(amounts[2]).toBe(m('33.3334'));
  });

  it('refuses a plan that is short or over by more than rounding, naming the difference', () => {
    expect(() =>
      planAmounts(m('1000'), [
        { label: 'a', basis: 'percent', percent: '30', triggerCode: 'on_order' },
        { label: 'b', basis: 'percent', percent: '60', triggerCode: 'on_order' },
      ]),
    ).toThrow(/short by 100\.00/);
    expect(() =>
      planAmounts(m('1000'), [
        { label: 'a', basis: 'amount', amountTxn: m('600'), triggerCode: 'on_order' },
        { label: 'b', basis: 'amount', amountTxn: m('500'), triggerCode: 'on_order' },
      ]),
    ).toThrow(/over by 100\.00/);
  });

  it('mixes fixed amounts and percentages, and counts instalments already kept', () => {
    const amounts = planAmounts(
      m('1000'),
      [
        { label: 'b', basis: 'amount', amountTxn: m('200'), triggerCode: 'before_shipment' },
        { label: 'c', basis: 'percent', percent: '50', triggerCode: 'against_bl_copy' },
      ],
      m('300'),
    );
    expect(amounts).toEqual([m('200'), m('500')]);
  });

  it('refuses nonsense in words', () => {
    expect(() => planAmounts(m('1000'), [])).toThrow(PaymentApplicationError);
    expect(() =>
      planAmounts(m('1000'), [{ label: ' ', basis: 'percent', percent: '100', triggerCode: 'on_order' }]),
    ).toThrow(/needs a label/);
    expect(() =>
      planAmounts(m('1000'), [{ label: 'x', basis: 'percent', percent: 'ten', triggerCode: 'on_order' }]),
    ).toThrow(/not a percentage/);
    expect(() =>
      planAmounts(m('0'), [{ label: 'x', basis: 'percent', percent: '100', triggerCode: 'on_order' }]),
    ).toThrow(/no amount yet/);
  });
});

describe('§15.3 · the status machine', () => {
  it('allows the drawn path and refuses the rest in words', () => {
    expect(() => assertTransition('PAYAPP-1', SEEDED, 'draft', 'approved')).not.toThrow();
    expect(() => assertTransition('PAYAPP-1', SEEDED, 'confirmed', 'debited')).not.toThrow();
    expect(() => assertTransition('PAYAPP-1', SEEDED, 'draft', 'sent')).toThrow(/cannot become 'sent'/);
    expect(() => assertTransition('PAYAPP-1', SEEDED, 'confirmed', 'cancelled')).toThrow(PaymentApplicationError);
  });

  it('a deactivated transition is refused', () => {
    const rows = SEEDED.map((row) =>
      row.fromStatus === 'draft' && row.toStatus === 'cancelled' ? { ...row, active: false } : row,
    );
    expect(() => assertTransition('PAYAPP-1', rows, 'draft', 'cancelled')).toThrow();
  });

  it('classifies statuses as §15.5 counts them', () => {
    expect(['draft', 'approved', 'sent', 'confirmed', 'debited'].every(isLive)).toBe(true);
    expect(isLive('rejected') || isLive('cancelled')).toBe(false);
    expect(['approved', 'sent'].every(isReserved)).toBe(true);
    expect(isReserved('confirmed')).toBe(false);
    expect(['sent', 'confirmed', 'debited'].every(isApplied)).toBe(true);
    expect(isApplied('approved')).toBe(false);
    expect(['confirmed', 'debited'].every(isPaid)).toBe(true);
  });
});

describe('§15.3 · what each method needs', () => {
  it('SWIFT and transfers go to a supplier bank account; cash from a cash account', () => {
    expect(needsPayeeAccount('swift')).toBe(true);
    expect(needsPayeeAccount('transfer')).toBe(true);
    expect(needsPayeeAccount('cash')).toBe(false);
    expect(needsPayeeAccount('cheque')).toBe(false);
    expect(accountTypeFor('cash')).toBe('cash');
    expect(accountTypeFor('cheque')).toBe('bank');
    expect(confirmationEvent('swift')).toBe('SWIFT_CONFIRMED');
    expect(confirmationEvent('cheque')).toBe('CHEQUE_PAID');
    expect(pendingCheckFor('swift')).toBe('swift_pending');
    expect(pendingCheckFor('cash')).toBe('transfer_pending');
  });
});

describe('§15.3 · the checks on Send', () => {
  it('funds count this application’s own reservation once', () => {
    expect(
      fundsCheck({ accountCode: 'BNK-1', availableIqd: m('0'), ownReservationIqd: m('500'), amountIqd: m('500') })
        .outcome,
    ).toBe('pass');
    const short = fundsCheck({ accountCode: 'BNK-1', availableIqd: m('100'), ownReservationIqd: 0n, amountIqd: m('500') });
    expect(short.outcome).toBe('fail');
    expect(short.detail).toMatch(/BNK-1 has 100\.00 IQD available against 500\.00 IQD/);
  });

  it('the payee must be named, the supplier’s, and verified', () => {
    const verified = { approvalStatus: 'approved', isActive: true, bankName: 'BOC', accountNumber: 'CN-1' };
    expect(payeeCheck({ kind: 'swift', account: null, belongsToSupplier: false }).outcome).toBe('fail');
    expect(payeeCheck({ kind: 'swift', account: verified, belongsToSupplier: false }).detail).toMatch(/different partner/);
    expect(
      payeeCheck({ kind: 'transfer', account: { ...verified, approvalStatus: 'submitted' }, belongsToSupplier: true })
        .detail,
    ).toMatch(/not verified/);
    expect(payeeCheck({ kind: 'swift', account: verified, belongsToSupplier: true }).outcome).toBe('pass');
    expect(payeeCheck({ kind: 'cash', account: null, belongsToSupplier: false }).outcome).toBe('not_applicable');
  });

  it('only failures refuse; the refusal names every cause', () => {
    const checks = [
      { code: 'pd_validated' as const, outcome: 'warning' as const, detail: 'PD?' },
      { code: 'funds' as const, outcome: 'fail' as const, detail: 'No money.' },
      { code: 'payee_account' as const, outcome: 'fail' as const, detail: 'Not verified.' },
    ];
    const failed = failing(checks);
    expect(failed.map((c) => c.code)).toEqual(['funds', 'payee_account']);
    expect(new SendRefusedError('PAYAPP-9', failed).message).toMatch(/No money\. Not verified\./);
  });
});

describe('§15.5 · Applied / Paid / Remaining', () => {
  it('counts sent as applied, confirmed as paid, and nothing rejected', () => {
    const result = totals(m('35000'), [
      { status: 'confirmed', amountTxn: m('3500'), amountIqd: m('4585000') },
      { status: 'sent', amountTxn: m('10000'), amountIqd: m('13100000') },
      { status: 'approved', amountTxn: m('5000'), amountIqd: m('6550000') },
      { status: 'rejected', amountTxn: m('9999'), amountIqd: m('1') },
    ]);
    expect(result.appliedTxn).toBe(m('13500'));
    expect(result.paidTxn).toBe(m('3500'));
    expect(result.remainingTxn).toBe(m('31500'));
    expect(result.reservedTxn).toBe(m('15000'));
    expect(result.fullyPaid).toBe(false);
  });

  it('fully paid to the minor unit', () => {
    expect(totals(m('100'), [{ status: 'debited', amountTxn: m('100'), amountIqd: m('131000') }]).fullyPaid).toBe(true);
    expect(totals(m('0'), []).fullyPaid).toBe(false);
  });

  it('instalment status follows its applications', () => {
    expect(instalmentStatus([])).toBe('planned');
    expect(instalmentStatus(['rejected'])).toBe('planned');
    expect(instalmentStatus(['rejected', 'sent'])).toBe('applied');
    expect(instalmentStatus(['confirmed'])).toBe('paid');
    expect(addDays('2026-09-01', 60)).toBe('2026-10-31');
  });
});
