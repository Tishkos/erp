/**
 * REQ-HR-001 Stage HR-4 — the advances' arithmetic, with no database.
 *
 * A loan of 1,000,000 IQD in three instalments from October 2026: 333,333,
 * 333,333 and 333,334. What a month's pay recovers is what is due by then
 * less what is back — a month that recovered nothing is caught up — and
 * never more than is owed, nor so much that the net pay goes below nothing.
 */
import { describe, expect, it } from 'vitest';
import { AdvanceError, allocateRecovery, assertAdvanceTransition, assertWholeDinars, behindSince, dueBy, instalmentPlan, monthsBetween, nextMonth, recoveryFor } from '@/server/domain/advances';
import { PAY_CALCULATIONS } from '@/server/domain/hr';
import { parseDecimal } from '@/server/domain/money';
import { computeLine, journalPlan, type ComponentRule } from '@/server/domain/payroll';

const iqd = (value: string) => parseDecimal(value, 4n);
const loan = { amount: iqd('1000000'), instalments: 3, firstRecoveryMonth: '2026-10-01' };

describe('H6 · the schedule', () => {
  it('splits a loan into whole-dinar instalments that add up exactly', () => {
    expect(instalmentPlan(iqd('1000000'), 3)).toEqual([iqd('333333'), iqd('333333'), iqd('333334')]);
    expect(instalmentPlan(iqd('500000'), 1)).toEqual([iqd('500000')]);
    expect(() => instalmentPlan(iqd('500000'), 0)).toThrow(AdvanceError);
    expect(() => instalmentPlan(iqd('500000'), 61)).toThrow(/1 to 60/);
    expect(() => assertWholeDinars(iqd('100.5'), 'The amount')).toThrow(/whole dinars/);
  });

  it('says what is due by each month, and nothing before the first', () => {
    expect(dueBy(loan, '2026-09-01')).toBe(0n);
    expect(dueBy(loan, '2026-10-01')).toBe(iqd('333333'));
    expect(dueBy(loan, '2026-11-01')).toBe(iqd('666666'));
    expect(dueBy(loan, '2027-03-01')).toBe(iqd('1000000'));
    expect(monthsBetween('2026-11-01', '2027-02-01')).toBe(3);
    expect(nextMonth('2026-12-15')).toBe('2027-01-01');
  });

  it('recovers what is due less what is back, catching a missed month up, never more than is owed', () => {
    expect(recoveryFor(loan, 0n, '2026-10-01')).toBe(iqd('333333'));
    // October's payroll recovered nothing: November takes both.
    expect(recoveryFor(loan, 0n, '2026-11-01')).toBe(iqd('666666'));
    expect(recoveryFor(loan, iqd('333333'), '2026-11-01')).toBe(iqd('333333'));
    // Cash handed back ahead of the schedule: nothing more is due until it catches up.
    expect(recoveryFor(loan, iqd('700000'), '2026-11-01')).toBe(0n);
    expect(recoveryFor(loan, iqd('700000'), '2026-12-01')).toBe(iqd('300000'));
    expect(recoveryFor(loan, iqd('1000000'), '2027-12-01')).toBe(0n);
  });

  it('knows since when a loan is behind', () => {
    expect(behindSince(loan, 0n, '2026-09-01')).toBeNull();
    expect(behindSince(loan, 0n, '2026-11-01')).toBe('2026-10-01');
    expect(behindSince(loan, iqd('333333'), '2026-11-01')).toBe('2026-11-01');
    expect(behindSince(loan, iqd('666666'), '2026-11-01')).toBeNull();
  });

  it('spreads a recovery over a person’s advances, the oldest first', () => {
    const shares = allocateRecovery(
      [
        { id: 'old', schedule: { amount: iqd('300000'), instalments: 1, firstRecoveryMonth: '2026-09-01' }, recovered: 0n },
        { id: 'new', schedule: loan, recovered: 0n },
      ],
      iqd('500000'),
      '2026-10-01',
    );
    expect(shares).toEqual([
      { id: 'old', amount: iqd('300000') },
      { id: 'new', amount: iqd('200000') },
    ]);
  });

  it('moves only along its life', () => {
    expect(() => assertAdvanceTransition('EADV-1', 'submitted', 'endorsed')).not.toThrow();
    expect(() => assertAdvanceTransition('EADV-1', 'submitted', 'approved')).toThrow(/cannot become approved/);
    expect(() => assertAdvanceTransition('EADV-1', 'paid', 'cancelled')).toThrow(AdvanceError);
  });
});

describe('H6 · the payroll takes what is due, and no more than the pay', () => {
  const RULES: ComponentRule[] = [
    { code: 'BASE', nameEn: 'Base salary', nameAr: null, kind: 'earning', calculation: 'base_salary', defaultValue: 0n, sortOrder: 10 },
    { code: 'SS_EMPLOYEE', nameEn: 'Social security', nameAr: null, kind: 'deduction', calculation: 'percent_of_base', defaultValue: iqd('5'), sortOrder: 60 },
    { code: 'ADVANCE', nameEn: 'Advance and loan recovery', nameAr: null, kind: 'deduction', calculation: 'advance_recovery', defaultValue: 0n, sortOrder: 65 },
    { code: 'INCOME_TAX', nameEn: 'Income tax', nameAr: null, kind: 'deduction', calculation: 'manual', defaultValue: 0n, sortOrder: 70 },
  ];

  it('recovers the month’s instalment as a deduction, in its place on the payslip', () => {
    const line = computeLine(
      { baseSalary: iqd('1500000'), workingDays: 22, employedDays: 22, absentDays: 0, unpaidLeave: 0n, advanceRecovery: iqd('200000') },
      RULES,
      [],
      [{ componentCode: 'INCOME_TAX', amount: iqd('25000'), note: 'worksheet' }],
    );
    expect(line.components.map((c) => [c.code, c.amount])).toEqual([
      ['BASE', iqd('1500000')],
      ['SS_EMPLOYEE', iqd('75000')],
      ['ADVANCE', iqd('200000')],
      ['INCOME_TAX', iqd('25000')],
    ]);
    expect(line.net).toBe(iqd('1200000'));
  });

  it('takes no more than leaves the net at nothing; the rest is due next month', () => {
    const line = computeLine({ baseSalary: iqd('300000'), workingDays: 22, employedDays: 22, absentDays: 0, unpaidLeave: 0n, advanceRecovery: iqd('500000') }, RULES, [], []);
    expect(line.components.find((c) => c.code === 'ADVANCE')!.amount).toBe(iqd('285000'));
    expect(line.net).toBe(0n);
  });

  it('credits what is recovered to the advances account in the run’s journal', () => {
    const line = computeLine({ baseSalary: iqd('1500000'), workingDays: 22, employedDays: 22, absentDays: 0, unpaidLeave: 0n, advanceRecovery: iqd('200000') }, RULES, [], []);
    const plan = journalPlan([{ departmentCode: 'FIN', net: line.net, components: line.components }], new Map());
    expect(plan.filter((p) => p.side === 'credit').map((p) => [p.role, p.componentCode, p.amount])).toEqual([
      ['employee_advance', 'ADVANCE', iqd('200000')],
      ['payroll_withholding', 'SS_EMPLOYEE', iqd('75000')],
      ['net_pay', null, iqd('1225000')],
    ]);
  });

  it('reads the recovery from the advances, as the base from the salary', () => {
    expect(PAY_CALCULATIONS).toContain('advance_recovery');
  });
});
