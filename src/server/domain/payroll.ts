/**
 * Payroll — REQ-HR-001 Stage HR-3 (§6, §9): the arithmetic, with no database.
 *
 * A line is computed from facts (R2), never typed as a total:
 *
 *   base salary      the compensation row in force at the month's end, for the
 *                    working days of the month the person was employed
 *                    (base × employed days ÷ working days);
 *   absence          the day's rate (base ÷ working days) × the days the sheet
 *                    recorded absent plus the unpaid leave approved, never
 *                    more than the base paid;
 *   fixed            the person's own figure, or the component's default when
 *                    it has one, for the employed days;
 *   percent of base  the person's own rate, or the default, of the base
 *                    earned — the base paid less the absence;
 *   manual           typed on the run's line, with its note (§9).
 *
 * A person's stop takes a component off them (an exemption). Every figure is
 * rounded to the whole dinar, half up: IQD has no smaller coin in use, and a
 * payslip, its journal and its payment agree to the dinar (H5).
 *
 * The journal (§9 "Posting") is planned here too, so the screen, the test and
 * the posting read one function: Dr each earning's expense by department —
 * the base less its absence — and each employer cost; Cr each deduction and
 * employer cost where it is owed, an advance recovered to the advances
 * account (HR-4); Cr the net to salaries payable.
 */
import type { PayCalculation, PayComponentKind } from './hr';
import { MONEY_SCALE, divideHalfUp } from './money';

export const PAYROLL_STATUSES = ['draft', 'submitted', 'approved', 'posted', 'paid', 'reversed', 'cancelled'] as const;
export type PayrollStatus = (typeof PAYROLL_STATUSES)[number];

/** What each status may become — the run's whole life. */
export const PAYROLL_TRANSITIONS: Readonly<Record<PayrollStatus, readonly PayrollStatus[]>> = {
  draft: ['submitted', 'cancelled'],
  submitted: ['draft', 'approved', 'cancelled'],
  approved: ['draft', 'posted', 'cancelled'],
  posted: ['paid', 'reversed'],
  paid: [],
  reversed: [],
  cancelled: [],
};

export class PayrollError extends Error {
  readonly code = 'PAYROLL';
  constructor(message: string) {
    super(message);
    this.name = 'PayrollError';
  }
}

export function assertPayrollTransition(runNo: string, from: string, to: PayrollStatus): void {
  const allowed = PAYROLL_TRANSITIONS[from as PayrollStatus] ?? [];
  if (!allowed.includes(to)) throw new PayrollError(`${runNo} is ${from}; it cannot become ${to}.`);
}

const UNIT = 10n ** MONEY_SCALE;
const HUNDRED = 100n;

/** To the whole dinar, half up. */
export function toDinar(amount: bigint): bigint {
  return divideHalfUp(amount, UNIT) * UNIT;
}

// ---------------------------------------------------------------------------
// The month
// ---------------------------------------------------------------------------

/** "YYYY-MM" → its first and last day. */
export function monthOf(month: string): { first: string; last: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new PayrollError(`'${month}' is not a month; write it YYYY-MM.`);
  const [year, mm] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(year, mm, 0)).getUTCDate();
  return { first: `${month}-01`, last: `${month}-${String(last).padStart(2, '0')}` };
}

/** The part of the month the person was employed, or null when none of it. */
export function employedSpan(person: { hireDate: string; endDate: string | null }, first: string, last: string): { from: string; to: string } | null {
  const from = person.hireDate > first ? person.hireDate : first;
  const to = person.endDate && person.endDate < last ? person.endDate : last;
  return from <= to ? { from, to } : null;
}

// ---------------------------------------------------------------------------
// A line
// ---------------------------------------------------------------------------

export interface ComponentRule {
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string | null;
  readonly kind: PayComponentKind;
  readonly calculation: PayCalculation;
  /** Scaled by 10⁴: dinars for a fixed component, a percentage for a percent one. */
  readonly defaultValue: bigint;
  readonly sortOrder: number;
}

/** A person's own figure for a component (scaled by 10⁴), or its stop. */
export interface PersonalFigure {
  readonly componentCode: string;
  readonly amount: bigint | null;
  readonly stopped: boolean;
}

export interface MonthFacts {
  /** The monthly base salary in force, scaled by 10⁴. */
  readonly baseSalary: bigint;
  /** Working days of the month on the calendar. */
  readonly workingDays: number;
  /** Working days of the month the person was employed. */
  readonly employedDays: number;
  /** Working days the sheet recorded absent. */
  readonly absentDays: number;
  /** Approved unpaid leave in the month, in hundredths of a day. */
  readonly unpaidLeave: bigint;
  /** HR-4 — what the person's advances and loans have due by the month (scaled by 10⁴). */
  readonly advanceRecovery?: bigint;
}

export interface TypedEntry {
  readonly componentCode: string;
  /** Scaled by 10⁴. */
  readonly amount: bigint;
  readonly note: string | null;
}

export interface ComputedComponent {
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string | null;
  readonly kind: PayComponentKind;
  readonly calculation: PayCalculation;
  /** The percentage applied (scaled by 10⁴), for a percent component. */
  readonly rate: bigint | null;
  /** Days in hundredths: the base's employed days, the absence's days. */
  readonly quantity: bigint | null;
  readonly amount: bigint;
  readonly note: string | null;
  readonly sortOrder: number;
}

export interface ComputedLine {
  readonly components: readonly ComputedComponent[];
  readonly basePaid: bigint;
  readonly absence: bigint;
  /** The base paid less the absence — what a percent of base is taken of. */
  readonly baseEarned: bigint;
  readonly gross: bigint;
  readonly deductions: bigint;
  readonly net: bigint;
  readonly employerCost: bigint;
}

const byOrder = (a: ComponentRule, b: ComponentRule) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code);

/** One person's month. Pure: the same facts give the same payslip. */
export function computeLine(facts: MonthFacts, rules: readonly ComponentRule[], personal: readonly PersonalFigure[], typed: readonly TypedEntry[]): ComputedLine {
  const working = BigInt(Math.max(0, facts.workingDays));
  const employed = BigInt(Math.max(0, Math.min(facts.employedDays, facts.workingDays)));
  const share = (monthly: bigint) => (working === 0n ? 0n : toDinar(divideHalfUp(monthly * employed, working)));
  const figure = (code: string) => personal.find((p) => p.componentCode === code) ?? null;
  const sorted = [...rules].sort(byOrder);

  const baseRule = sorted.find((r) => r.calculation === 'base_salary') ?? null;
  const absenceRule = sorted.find((r) => r.calculation === 'absence') ?? null;
  const basePaid = baseRule ? share(facts.baseSalary) : 0n;
  const absentUnits = BigInt(Math.max(0, facts.absentDays)) * HUNDRED + (facts.unpaidLeave > 0n ? facts.unpaidLeave : 0n);
  const absenceRaw = absenceRule && working > 0n ? toDinar(divideHalfUp(facts.baseSalary * absentUnits, working * HUNDRED)) : 0n;
  const absence = absenceRaw > basePaid ? basePaid : absenceRaw;
  const baseEarned = basePaid - absence;

  const components: ComputedComponent[] = [];
  const push = (rule: ComponentRule, amount: bigint, extra: { rate?: bigint | null; quantity?: bigint | null; note?: string | null } = {}) =>
    components.push({
      code: rule.code,
      nameEn: rule.nameEn,
      nameAr: rule.nameAr,
      kind: rule.kind,
      calculation: rule.calculation,
      rate: extra.rate ?? null,
      quantity: extra.quantity ?? null,
      amount,
      note: extra.note ?? null,
      sortOrder: rule.sortOrder,
    });

  for (const rule of sorted) {
    const own = figure(rule.code);
    switch (rule.calculation) {
      case 'base_salary':
        push(rule, basePaid, { quantity: employed * HUNDRED });
        break;
      case 'absence':
        if (absence > 0n || absentUnits > 0n) push(rule, absence, { quantity: absentUnits });
        break;
      case 'fixed': {
        if (own?.stopped) break;
        const monthly = own?.amount ?? rule.defaultValue;
        if (!own && monthly === 0n) break;
        const amount = share(monthly);
        if (amount > 0n) push(rule, amount);
        break;
      }
      case 'percent_of_base': {
        if (own?.stopped) break;
        const rate = own?.amount ?? rule.defaultValue;
        if (rate === 0n) break;
        push(rule, toDinar(divideHalfUp(baseEarned * rate, HUNDRED * UNIT)), { rate });
        break;
      }
      case 'manual': {
        if (own?.stopped) break;
        const entry = typed.find((t) => t.componentCode === rule.code);
        const amount = entry?.amount ?? 0n;
        if (amount < 0n) throw new PayrollError(`${rule.nameEn} cannot be negative.`);
        push(rule, amount, { note: entry?.note ?? null });
        break;
      }
      case 'advance_recovery':
        // Taken once everything else is known, below.
        break;
    }
  }

  const sum = (kind: PayComponentKind) => components.filter((c) => c.kind === kind).reduce((total, c) => total + c.amount, 0n);
  // HR-4 — the advances' recovery comes last: what is due, never so much that the net goes below nothing;
  // what it cannot take stays owed and is due again next month.
  const recoveryRule = sorted.find((r) => r.calculation === 'advance_recovery') ?? null;
  const due = facts.advanceRecovery ?? 0n;
  if (recoveryRule && due > 0n) {
    const room = sum('earning') - sum('deduction');
    const take = room <= 0n ? 0n : due < room ? due : room;
    if (take > 0n) push(recoveryRule, take);
    components.sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
  }
  const gross = sum('earning');
  const deductions = sum('deduction');
  return { components, basePaid, absence, baseEarned, gross, deductions, net: gross - deductions, employerCost: sum('employer_cost') };
}

/** A manual figure says why (§9, the database's `payroll_line_component_manual_note`). */
export function assertTypedEntries(employeeNo: string, entries: readonly TypedEntry[], rules: readonly ComponentRule[]): void {
  for (const entry of entries) {
    const rule = rules.find((r) => r.code === entry.componentCode);
    if (!rule || rule.calculation !== 'manual') throw new PayrollError(`${entry.componentCode} is not typed on the run; it is computed.`);
    if (entry.amount < 0n) throw new PayrollError(`${employeeNo}: ${rule.nameEn} cannot be negative.`);
    if (entry.amount > 0n && !(entry.note ?? '').trim()) throw new PayrollError(`${employeeNo}: ${rule.nameEn} of ${toDecimal(entry.amount)} needs its note — what it is for.`);
  }
}

const toDecimal = (scaled: bigint) => {
  const whole = scaled / UNIT;
  const fraction = (scaled < 0n ? -scaled : scaled) % UNIT;
  return fraction === 0n ? whole.toString() : `${whole}.${fraction.toString().padStart(Number(MONEY_SCALE), '0').replace(/0+$/, '')}`;
};

// ---------------------------------------------------------------------------
// The journal
// ---------------------------------------------------------------------------

export type PayrollRole = 'salary_expense' | 'payroll_employer_cost' | 'payroll_withholding' | 'employee_advance' | 'net_pay';

export interface ComponentAccounts {
  readonly expenseAccountId: string | null;
  readonly liabilityAccountId: string | null;
}

export interface JournalLinePlan {
  readonly role: PayrollRole;
  /** The component's own account; null leaves it to the posting mapping. */
  readonly accountId: string | null;
  /** The benefiting department, on the cost lines. */
  readonly departmentCode: string | null;
  readonly side: 'debit' | 'credit';
  readonly amount: bigint;
  /** The component the line carries, when it is one component's. */
  readonly componentCode: string | null;
}

export interface PlannedPayrollLine {
  readonly departmentCode: string;
  readonly net: bigint;
  readonly components: readonly { readonly code: string; readonly kind: string; readonly calculation: string; readonly amount: bigint }[];
}

/**
 * The run's journal, balanced by construction: the absence comes off the
 * base's own expense line, a deduction is owed where its component says, the
 * net is owed to the people. Lines of nothing are left out.
 */
export function journalPlan(lines: readonly PlannedPayrollLine[], accounts: ReadonlyMap<string, ComponentAccounts>): JournalLinePlan[] {
  const debits = new Map<string, { role: PayrollRole; accountId: string | null; departmentCode: string; componentCode: string; amount: bigint }>();
  const credits = new Map<string, { role: PayrollRole; accountId: string | null; componentCode: string; amount: bigint }>();
  let net = 0n;
  const account = (code: string) => accounts.get(code) ?? { expenseAccountId: null, liabilityAccountId: null };
  const debit = (role: PayrollRole, code: string, departmentCode: string, amount: bigint) => {
    const key = `${role}|${code}|${departmentCode}`;
    const prior = debits.get(key);
    debits.set(key, { role, accountId: account(code).expenseAccountId, departmentCode, componentCode: code, amount: (prior?.amount ?? 0n) + amount });
  };
  const credit = (code: string, amount: bigint, role: PayrollRole = 'payroll_withholding') => {
    const prior = credits.get(code);
    // An advance recovered is the person's debt repaid: it credits the advances account, not a liability.
    credits.set(code, { role, accountId: role === 'employee_advance' ? null : account(code).liabilityAccountId, componentCode: code, amount: (prior?.amount ?? 0n) + amount });
  };

  for (const line of lines) {
    net += line.net;
    const base = line.components.find((c) => c.calculation === 'base_salary');
    for (const c of line.components) {
      if (c.amount === 0n) continue;
      if (c.kind === 'earning') debit('salary_expense', c.code, line.departmentCode, c.amount);
      else if (c.kind === 'employer_cost') {
        debit('payroll_employer_cost', c.code, line.departmentCode, c.amount);
        credit(c.code, c.amount);
      } else if (c.calculation === 'absence') {
        // Pay not earned is cost not incurred: it comes off the base's expense.
        if (base) debit('salary_expense', base.code, line.departmentCode, -c.amount);
        else credit(c.code, c.amount);
      } else if (c.calculation === 'advance_recovery') credit(c.code, c.amount, 'employee_advance');
      else credit(c.code, c.amount);
    }
  }

  const plan: JournalLinePlan[] = [];
  for (const d of [...debits.values()].sort(
    (a, b) => a.departmentCode.localeCompare(b.departmentCode) || (a.role === b.role ? 0 : a.role === 'salary_expense' ? -1 : 1) || a.componentCode.localeCompare(b.componentCode),
  )) {
    if (d.amount !== 0n) plan.push({ role: d.role, accountId: d.accountId, departmentCode: d.departmentCode, side: 'debit', amount: d.amount, componentCode: d.componentCode });
  }
  for (const c of [...credits.values()].sort((a, b) => a.componentCode.localeCompare(b.componentCode))) {
    if (c.amount !== 0n) plan.push({ role: c.role, accountId: c.accountId, departmentCode: null, side: 'credit', amount: c.amount, componentCode: c.componentCode });
  }
  if (net !== 0n) plan.push({ role: 'net_pay', accountId: null, departmentCode: null, side: 'credit', amount: net, componentCode: null });
  return plan;
}

/** Debits equal credits — said once more before anything is posted. */
export function planBalances(plan: readonly JournalLinePlan[]): boolean {
  const debit = plan.filter((l) => l.side === 'debit').reduce((sum, l) => sum + l.amount, 0n);
  const credit = plan.filter((l) => l.side === 'credit').reduce((sum, l) => sum + l.amount, 0n);
  return debit === credit && plan.every((l) => l.amount > 0n);
}
