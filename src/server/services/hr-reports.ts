/**
 * HR reports and the HR dashboard — REQ-HR-001 Stage HR-6 (§11a "Dashboard",
 * "Reports"; Part E "HR reports").
 *
 * Read-only, through the reader's own row security: a branch the reader does
 * not work in counts nothing, and a figure under a grant (pay, advances) is
 * read only when the reader holds it — the screens ask the same question
 * before they draw it. Every figure is counted from the facts (R2): the
 * employee rows and their dates, the leave requests, the posted runs, the
 * advances' recoveries.
 *
 *   headcount           people by branch, department and position at the end
 *                       of a period, with who joined and who left in it
 *   leave balances      every person's balance of every active type for a year,
 *                       as the employee page reads it (`leave.balances`)
 *   payroll register    a month's approved and posted runs, line by line
 *   unsettled advances  paid advances still owing, with how far behind
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { employee, employeeAdvance } from '../db/schema';
import { businessToday } from '../domain/business-date';
import { bucketFor } from '../domain/cash-advance';
import { behindSince } from '../domain/advances';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';
import { can } from '../domain/permissions';
import type { ActorContext } from './chart-of-accounts';
import * as hrSettings from './hr-settings';
import * as leave from './leave';

export const PERMISSION_OBJECT = 'hr_report';

const money = (value: bigint) => toDecimalString(value, MONEY_SCALE);
const scaled = (value: string | null | undefined) => parseDecimal((value ?? '0').trim() || '0', MONEY_SCALE);
type Reader = { principal: ActorContext['principal'] };

export interface HeadcountRow {
  readonly branchCode: string;
  readonly departmentCode: string;
  readonly departmentName: string;
  readonly positionCode: string | null;
  readonly positionTitle: string | null;
  readonly headcount: number;
  readonly joiners: number;
  readonly leavers: number;
}

/** People by branch, department and position (where they are now): at the period's end, and who joined and left in it. */
export async function headcount(tx: Tx, from: string, to: string): Promise<HeadcountRow[]> {
  const { rows } = await tx.execute(sql`
    select e.branch_code as "branchCode", e.department_code as "departmentCode", d.name as "departmentName",
           e.position_code as "positionCode", p.title_en as "positionTitle",
           count(*) filter (where e.hire_date <= ${to}::date and (e.end_date is null or e.end_date > ${to}::date))::int as headcount,
           count(*) filter (where e.hire_date between ${from}::date and ${to}::date)::int as joiners,
           count(*) filter (where e.end_date between ${from}::date and ${to}::date)::int as leavers
      from employee e
      join department d on d.code = e.department_code
      left join position p on p.code = e.position_code
     group by 1, 2, 3, 4, 5
    having count(*) filter (where e.hire_date <= ${to}::date and (e.end_date is null or e.end_date >= ${from}::date)) > 0
     order by 1, 2, 5 nulls last`);
  return rows as unknown as HeadcountRow[];
}

export interface LeaveBalanceRow {
  readonly employeeNo: string;
  readonly fullNameEn: string;
  readonly fullNameAr: string | null;
  readonly departmentCode: string;
  readonly leaveTypeCode: string;
  readonly typeNameEn: string;
  readonly typeNameAr: string | null;
  /** Hundredths of a day, as `domain/hr-time` keeps them. */
  readonly carryIn: bigint;
  readonly entitlement: bigint;
  readonly adjustments: bigint;
  readonly taken: bigint;
  readonly pending: bigint;
  readonly available: bigint;
}

/** Every working person's balance of every active type in a year — the employee page's figures, all at once. */
export async function leaveBalances(tx: Tx, year: number, limit: number): Promise<LeaveBalanceRow[]> {
  const people = await tx
    .select({ id: employee.id, employeeNo: employee.employeeNo, fullNameEn: employee.fullNameEn, fullNameAr: employee.fullNameAr, departmentCode: employee.departmentCode })
    .from(employee)
    .where(inArray(employee.status, ['active', 'suspended']))
    .orderBy(asc(employee.departmentCode), asc(employee.employeeNo))
    .limit(limit);
  const out: LeaveBalanceRow[] = [];
  for (const person of people) {
    for (const b of await leave.balances(tx, person.id, year)) {
      out.push({
        employeeNo: person.employeeNo,
        fullNameEn: person.fullNameEn,
        fullNameAr: person.fullNameAr,
        departmentCode: person.departmentCode,
        leaveTypeCode: b.leaveTypeCode,
        typeNameEn: b.nameEn,
        typeNameAr: b.nameAr,
        carryIn: b.carryIn,
        entitlement: b.entitlement,
        adjustments: b.adjustments,
        taken: b.taken,
        pending: b.pending,
        available: b.available,
      });
    }
  }
  return out;
}

export interface PayrollRegisterRow {
  readonly runNo: string;
  readonly runStatus: string;
  readonly branchCode: string;
  readonly employeeNo: string;
  readonly fullNameEn: string;
  readonly fullNameAr: string | null;
  readonly departmentCode: string;
  readonly payslipNo: string | null;
  readonly grossIqd: string;
  readonly deductionsIqd: string;
  readonly netIqd: string;
  readonly employerCostIqd: string;
}

/** A month's approved, posted and paid runs, line by line — read under the payroll grant (row security asks it). */
export async function payrollRegister(tx: Tx, month: string, limit: number): Promise<PayrollRegisterRow[]> {
  const { rows } = await tx.execute(sql`
    select r.run_no as "runNo", r.status as "runStatus", r.branch_code as "branchCode",
           l.employee_no as "employeeNo", l.full_name_en as "fullNameEn", l.full_name_ar as "fullNameAr", l.department_code as "departmentCode",
           l.payslip_no as "payslipNo", l.gross_iqd::text as "grossIqd", l.deductions_iqd::text as "deductionsIqd", l.net_iqd::text as "netIqd",
           l.employer_cost_iqd::text as "employerCostIqd"
      from payroll_line l
      join payroll_run r on r.id = l.run_id
     where r.period_month = ${`${month.slice(0, 7)}-01`}::date and r.status in ('approved', 'posted', 'paid')
     order by r.branch_code, l.department_code, l.employee_no
     limit ${limit}`);
  return rows as unknown as PayrollRegisterRow[];
}

export interface UnsettledAdvanceRow {
  readonly advanceNo: string;
  readonly kind: string;
  readonly employeeNo: string;
  readonly fullNameEn: string;
  readonly fullNameAr: string | null;
  readonly paidOn: string | null;
  readonly amountIqd: string;
  readonly recoveredIqd: string;
  readonly owedIqd: string;
  readonly behindSince: string | null;
  readonly bucket: string | null;
}

/** Paid advances and loans still owing on a day, with the month their oldest unrecovered instalment fell due. */
export async function unsettledAdvances(tx: Tx, asOf: string, limit: number): Promise<UnsettledAdvanceRow[]> {
  const rows = await tx
    .select({
      advanceNo: employeeAdvance.advanceNo,
      kind: employeeAdvance.kind,
      paidOn: employeeAdvance.paidOn,
      amountIqd: employeeAdvance.amountIqd,
      recoveredIqd: employeeAdvance.recoveredIqd,
      instalments: employeeAdvance.instalments,
      firstRecoveryMonth: employeeAdvance.firstRecoveryMonth,
      employeeNo: employee.employeeNo,
      fullNameEn: employee.fullNameEn,
      fullNameAr: employee.fullNameAr,
    })
    .from(employeeAdvance)
    .innerJoin(employee, eq(employee.id, employeeAdvance.employeeId))
    .where(and(eq(employeeAdvance.status, 'paid'), sql`${employeeAdvance.paidOn} <= ${asOf}::date`))
    .orderBy(asc(employeeAdvance.firstRecoveryMonth), asc(employeeAdvance.advanceNo))
    .limit(limit);
  // The month in progress is not behind yet: its payroll has not run.
  const [y, m] = asOf.split('-').map(Number) as [number, number];
  const lastMonth = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
  return rows.map((r) => {
    const amount = scaled(r.amountIqd);
    const recovered = scaled(r.recoveredIqd);
    const since = behindSince({ amount, instalments: r.instalments, firstRecoveryMonth: r.firstRecoveryMonth }, recovered, lastMonth);
    const end = since ? new Date(Date.UTC(Number(since.slice(0, 4)), Number(since.slice(5, 7)), 0)).toISOString().slice(0, 10) : null;
    return {
      advanceNo: r.advanceNo,
      kind: r.kind,
      employeeNo: r.employeeNo,
      fullNameEn: r.fullNameEn,
      fullNameAr: r.fullNameAr,
      paidOn: r.paidOn,
      amountIqd: r.amountIqd,
      recoveredIqd: r.recoveredIqd,
      owedIqd: money(amount - recovered),
      behindSince: since,
      bucket: end ? bucketFor(end, asOf) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// The HR dashboard
// ---------------------------------------------------------------------------

export interface HrDashboard {
  readonly asOf: string;
  readonly headcount: number;
  readonly joinersThisMonth: number;
  readonly leaversThisMonth: number;
  readonly onLeaveToday: readonly { readonly requestNo: string; readonly employeeNo: string; readonly fullNameEn: string; readonly typeNameEn: string; readonly toDate: string }[];
  readonly leaveWaiting: number;
  readonly requestsWaiting: number;
  readonly openVacancies: number;
  readonly reviewsInProgress: number;
  readonly documentsExpiring: number;
  readonly byDepartment: readonly { readonly departmentCode: string; readonly departmentName: string; readonly headcount: number }[];
  /** Under the payroll grant only: the last six months' posted cost (gross + the employer's). */
  readonly payrollCost: readonly { readonly month: string; readonly grossIqd: string; readonly employerCostIqd: string; readonly people: number }[] | null;
  /** Under the advances grant only. */
  readonly advancesOwedIqd: string | null;
}

/** The HR section's figures today, counted from the facts the reader may see. */
export async function dashboard(tx: Tx, ctx: Reader): Promise<HrDashboard> {
  const today = businessToday();
  const month = `${today.slice(0, 7)}-01`;
  const { document_expiry_warning_days: warnDays } = await hrSettings.parameters(tx);
  const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + warnDays * 86_400_000).toISOString().slice(0, 10);
  const one = async (query: ReturnType<typeof sql>) => Number(((await tx.execute(query)).rows[0] as { n: number | string } | undefined)?.n ?? 0);
  const [counts] = (
    await tx.execute(sql`
      select count(*) filter (where e.status in ('active', 'suspended'))::int as headcount,
             count(*) filter (where e.hire_date >= ${month}::date and e.hire_date <= ${today}::date)::int as joiners,
             count(*) filter (where e.end_date >= ${month}::date and e.end_date <= ${today}::date)::int as leavers
        from employee e`)
  ).rows as { headcount: number; joiners: number; leavers: number }[];
  const onLeaveToday = (
    await tx.execute(sql`
      select r.request_no as "requestNo", e.employee_no as "employeeNo", e.full_name_en as "fullNameEn", t.name_en as "typeNameEn", r.to_date::text as "toDate"
        from leave_request r
        join employee e on e.id = r.employee_id
        join leave_type t on t.code = r.leave_type_code
       where r.status = 'approved' and r.from_date <= ${today}::date and r.to_date >= ${today}::date
       order by r.to_date, e.employee_no
       limit 50`)
  ).rows as unknown as HrDashboard['onLeaveToday'];
  const byDepartment = (
    await tx.execute(sql`
      select e.department_code as "departmentCode", d.name as "departmentName", count(*)::int as headcount
        from employee e join department d on d.code = e.department_code
       where e.status in ('active', 'suspended')
       group by 1, 2
       order by 3 desc, 1`)
  ).rows as unknown as HrDashboard['byDepartment'];
  const payrollCost = can(ctx.principal, 'view', 'payroll_run')
    ? (
        (
          await tx.execute(sql`
            select to_char(r.period_month, 'YYYY-MM') as month, sum(r.gross_iqd)::text as "grossIqd", sum(r.employer_cost_iqd)::text as "employerCostIqd",
                   sum((select count(*) from payroll_line l where l.run_id = r.id))::int as people
              from payroll_run r
             where r.status in ('posted', 'paid')
             group by r.period_month
             order by r.period_month desc
             limit 6`)
        ).rows as unknown as { month: string; grossIqd: string; employerCostIqd: string; people: number }[]
      ).reverse()
    : null;
  const advancesOwedIqd = can(ctx.principal, 'view', 'employee_advance')
    ? (((await tx.execute(sql`select coalesce(sum(amount_iqd - recovered_iqd), 0)::text as owed from employee_advance where status = 'paid'`)).rows[0] as { owed: string }).owed ?? '0')
    : null;
  return {
    asOf: today,
    headcount: counts?.headcount ?? 0,
    joinersThisMonth: counts?.joiners ?? 0,
    leaversThisMonth: counts?.leavers ?? 0,
    onLeaveToday,
    leaveWaiting: await one(sql`select count(*)::int as n from leave_request where status = 'submitted'`),
    requestsWaiting: await one(sql`select count(*)::int as n from employee_request where status = 'submitted' or (status = 'approved' and kind in ('expense_claim', 'letter'))`),
    openVacancies: await one(sql`select count(*)::int as n from vacancy where status = 'open'`),
    reviewsInProgress: can(ctx.principal, 'view', 'performance_review')
      ? await one(sql`select count(*)::int as n from performance_review r join review_cycle c on c.code = r.cycle_code where c.status = 'open' and r.status in ('draft', 'rated')`)
      : 0,
    documentsExpiring: can(ctx.principal, 'view', 'employee_document')
      ? await one(sql`select count(*)::int as n from employee_document where status = 'valid' and expires_on <= ${horizon}::date`)
      : 0,
    byDepartment,
    payrollCost,
    advancesOwedIqd,
  };
}
