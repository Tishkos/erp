/**
 * REQ-HR-001 Stage HR-3 — the payroll arithmetic, with no database.
 *
 * H5's worked example (B-HR-15): Karim Saleh, Finance, September 2026 — 22
 * working days on the Iraq calendar (Sunday to Thursday, no holiday in the
 * month). Base 1,500,000 IQD; housing 300,000 and transport 100,000 as his
 * own figures; absent one day (Tuesday 8 September); 50,000 overtime and
 * 25,000 income tax typed with their notes; social security 5 % employee and
 * 12 % employer of the base earned. Every figure to the whole dinar.
 */
import { describe, expect, it } from 'vitest';
import { PAY_CALCULATIONS } from '@/server/domain/hr';
import { PayrollError, assertPayrollTransition, assertTypedEntries, computeLine, employedSpan, journalPlan, monthOf, planBalances, toDinar, type ComponentRule } from '@/server/domain/payroll';
import { parseDecimal } from '@/server/domain/money';

const iqd = (value: string) => parseDecimal(value, 4n);
const shown = (value: bigint) => (value / 10_000n).toString() + (value % 10_000n === 0n ? '' : `.${(value % 10_000n).toString().padStart(4, '0')}`);

const RULES: ComponentRule[] = [
  { code: 'BASE', nameEn: 'Base salary', nameAr: null, kind: 'earning', calculation: 'base_salary', defaultValue: 0n, sortOrder: 10 },
  { code: 'HOUSING', nameEn: 'Housing allowance', nameAr: null, kind: 'earning', calculation: 'fixed', defaultValue: 0n, sortOrder: 20 },
  { code: 'TRANSPORT', nameEn: 'Transport allowance', nameAr: null, kind: 'earning', calculation: 'fixed', defaultValue: 0n, sortOrder: 30 },
  { code: 'OVERTIME', nameEn: 'Overtime', nameAr: null, kind: 'earning', calculation: 'manual', defaultValue: 0n, sortOrder: 40 },
  { code: 'ABSENCE', nameEn: 'Absence deduction', nameAr: null, kind: 'deduction', calculation: 'absence', defaultValue: 0n, sortOrder: 50 },
  { code: 'SS_EMPLOYEE', nameEn: 'Social security — employee share', nameAr: null, kind: 'deduction', calculation: 'percent_of_base', defaultValue: iqd('5'), sortOrder: 60 },
  { code: 'INCOME_TAX', nameEn: 'Income tax', nameAr: null, kind: 'deduction', calculation: 'manual', defaultValue: 0n, sortOrder: 70 },
  { code: 'SS_EMPLOYER', nameEn: 'Social security — employer share', nameAr: null, kind: 'employer_cost', calculation: 'percent_of_base', defaultValue: iqd('12'), sortOrder: 80 },
];

const karim = () =>
  computeLine(
    { baseSalary: iqd('1500000'), workingDays: 22, employedDays: 22, absentDays: 1, unpaidLeave: 0n },
    RULES,
    [
      { componentCode: 'HOUSING', amount: iqd('300000'), stopped: false },
      { componentCode: 'TRANSPORT', amount: iqd('100000'), stopped: false },
    ],
    [
      { componentCode: 'OVERTIME', amount: iqd('50000'), note: 'Stock count, 12 September' },
      { componentCode: 'INCOME_TAX', amount: iqd('25000'), note: "The accountant's worksheet" },
    ],
  );

describe('H5 · the worked example, to the dinar', () => {
  it('computes each component from the facts', () => {
    const line = karim();
    expect(line.components.map((c) => [c.code, shown(c.amount)])).toEqual([
      ['BASE', '1500000'],
      ['HOUSING', '300000'],
      ['TRANSPORT', '100000'],
      ['OVERTIME', '50000'],
      // 1,500,000 ÷ 22 = 68,181.82 a day → 68,182.
      ['ABSENCE', '68182'],
      // 5 % of the base earned, 1,431,818 → 71,590.90 → 71,591.
      ['SS_EMPLOYEE', '71591'],
      ['INCOME_TAX', '25000'],
      // 12 % of 1,431,818 → 171,818.16 → 171,818.
      ['SS_EMPLOYER', '171818'],
    ]);
    expect(shown(line.baseEarned)).toBe('1431818');
    expect(shown(line.gross)).toBe('1950000');
    expect(shown(line.deductions)).toBe('164773');
    expect(shown(line.net)).toBe('1785227');
    expect(shown(line.employerCost)).toBe('171818');
    // The day counts ride on the line: the base's 22 days, the absence's one.
    expect(line.components.find((c) => c.code === 'BASE')!.quantity).toBe(2200n);
    expect(line.components.find((c) => c.code === 'ABSENCE')!.quantity).toBe(100n);
  });

  it('pays a part month for the working days employed', () => {
    // Lina joins on Tuesday 15 September: 12 of the 22 working days.
    const lina = computeLine({ baseSalary: iqd('1000000'), workingDays: 22, employedDays: 12, absentDays: 0, unpaidLeave: 0n }, RULES, [], []);
    expect(lina.components.map((c) => [c.code, shown(c.amount)])).toEqual([
      ['BASE', '545455'],
      ['OVERTIME', '0'],
      ['SS_EMPLOYEE', '27273'],
      ['INCOME_TAX', '0'],
      ['SS_EMPLOYER', '65455'],
    ]);
    expect(shown(lina.net)).toBe('518182');
  });

  it('counts unpaid leave as absence, half days half, never more than the base paid', () => {
    const half = computeLine({ baseSalary: iqd('2200000'), workingDays: 22, employedDays: 22, absentDays: 0, unpaidLeave: 50n }, RULES, [], []);
    expect(shown(half.absence)).toBe('50000');
    const all = computeLine({ baseSalary: iqd('2200000'), workingDays: 22, employedDays: 5, absentDays: 9, unpaidLeave: 0n }, RULES, [], []);
    expect(shown(all.basePaid)).toBe('500000');
    expect(shown(all.absence)).toBe('500000');
    expect(all.baseEarned).toBe(0n);
  });

  it('takes a component off a person who is stopped on it, and uses their own rate', () => {
    const exempt = computeLine(
      { baseSalary: iqd('1000000'), workingDays: 20, employedDays: 20, absentDays: 0, unpaidLeave: 0n },
      RULES,
      [
        { componentCode: 'SS_EMPLOYEE', amount: null, stopped: true },
        { componentCode: 'SS_EMPLOYER', amount: iqd('10'), stopped: false },
      ],
      [],
    );
    expect(exempt.components.map((c) => c.code)).not.toContain('SS_EMPLOYEE');
    expect(shown(exempt.employerCost)).toBe('100000');
  });

  it('rounds to the whole dinar, half up', () => {
    expect(toDinar(iqd('68181.4999'))).toBe(iqd('68181'));
    expect(toDinar(iqd('68181.5'))).toBe(iqd('68182'));
  });
});

describe('H5 · the journal the run posts', () => {
  const accounts = new Map([
    ['SS_EMPLOYEE', { expenseAccountId: null, liabilityAccountId: 'acc-ss' }],
    ['SS_EMPLOYER', { expenseAccountId: null, liabilityAccountId: 'acc-ss' }],
    ['INCOME_TAX', { expenseAccountId: null, liabilityAccountId: 'acc-tax' }],
  ]);

  it('debits the cost by department — the base less its absence — and credits what is owed', () => {
    const line = karim();
    const lina = computeLine({ baseSalary: iqd('1000000'), workingDays: 22, employedDays: 12, absentDays: 0, unpaidLeave: 0n }, RULES, [], []);
    const plan = journalPlan(
      [
        { departmentCode: 'FIN', net: line.net, components: line.components },
        { departmentCode: 'OPS', net: lina.net, components: lina.components },
      ],
      accounts,
    );
    expect(plan.map((p) => [p.side, p.role, p.componentCode, p.departmentCode, p.accountId, shown(p.amount)])).toEqual([
      ['debit', 'salary_expense', 'BASE', 'FIN', null, '1431818'],
      ['debit', 'salary_expense', 'HOUSING', 'FIN', null, '300000'],
      ['debit', 'salary_expense', 'OVERTIME', 'FIN', null, '50000'],
      ['debit', 'salary_expense', 'TRANSPORT', 'FIN', null, '100000'],
      ['debit', 'payroll_employer_cost', 'SS_EMPLOYER', 'FIN', null, '171818'],
      ['debit', 'salary_expense', 'BASE', 'OPS', null, '545455'],
      ['debit', 'payroll_employer_cost', 'SS_EMPLOYER', 'OPS', null, '65455'],
      ['credit', 'payroll_withholding', 'INCOME_TAX', null, 'acc-tax', '25000'],
      ['credit', 'payroll_withholding', 'SS_EMPLOYEE', null, 'acc-ss', '98864'],
      ['credit', 'payroll_withholding', 'SS_EMPLOYER', null, 'acc-ss', '237273'],
      ['credit', 'net_pay', null, null, null, '2303409'],
    ]);
    expect(planBalances(plan)).toBe(true);
  });
});

describe('H4 · the rules of a run', () => {
  it('knows a month by its first and last day, and a part month by the hire and the leaving', () => {
    expect(monthOf('2026-09')).toEqual({ first: '2026-09-01', last: '2026-09-30' });
    expect(monthOf('2028-02')).toEqual({ first: '2028-02-01', last: '2028-02-29' });
    expect(() => monthOf('2026-13')).toThrow(PayrollError);
    expect(employedSpan({ hireDate: '2026-09-15', endDate: null }, '2026-09-01', '2026-09-30')).toEqual({ from: '2026-09-15', to: '2026-09-30' });
    expect(employedSpan({ hireDate: '2020-01-01', endDate: '2026-09-10' }, '2026-09-01', '2026-09-30')).toEqual({ from: '2026-09-01', to: '2026-09-10' });
    expect(employedSpan({ hireDate: '2026-10-01', endDate: null }, '2026-09-01', '2026-09-30')).toBeNull();
  });

  it('moves only along its life', () => {
    expect(() => assertPayrollTransition('PAY-1', 'draft', 'submitted')).not.toThrow();
    expect(() => assertPayrollTransition('PAY-1', 'draft', 'posted')).toThrow(/cannot become posted/);
    expect(() => assertPayrollTransition('PAY-1', 'paid', 'reversed')).toThrow(PayrollError);
    expect(() => assertPayrollTransition('PAY-1', 'posted', 'reversed')).not.toThrow();
  });

  it('asks a typed figure for its note, and types only a manual component', () => {
    expect(() => assertTypedEntries('E-1', [{ componentCode: 'OVERTIME', amount: iqd('1000'), note: '' }], RULES)).toThrow(/needs its note/);
    expect(() => assertTypedEntries('E-1', [{ componentCode: 'BASE', amount: iqd('1000'), note: 'x' }], RULES)).toThrow(/computed/);
    expect(() => assertTypedEntries('E-1', [{ componentCode: 'OVERTIME', amount: 0n, note: null }], RULES)).not.toThrow();
  });

  it('reads the base salary and the absence from the facts', () => {
    expect(PAY_CALCULATIONS).toEqual(['base_salary', 'fixed', 'percent_of_base', 'manual', 'absence', 'advance_recovery']);
  });
});
