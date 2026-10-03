import { formatBusinessDate } from '@/i18n/config';
import { businessDateOf, businessToday } from '../domain/business-date';
import { showDays } from '../domain/hr-time';
import * as requests from '../services/employee-requests';
import * as hr from '../services/hr-reports';
import type { BuildContext, Built } from './documents';
import { EXPORT_ROW_CAP, type Column, type PrintModel, type Row } from './model';

/**
 * REQ-HR-001 HR-6 — the HR reports (headcount, leave balances, the payroll
 * register, unsettled advances) and an issued letter, built from the
 * services the screens read and printed and exported through the ERP's own
 * renderers. The HR Reports screen draws the very same models, so the screen
 * and the copy state one set of figures.
 */
type Query = URLSearchParams;

export const HR_REPORTS = ['headcount', 'leave', 'payroll', 'advances'] as const;
export type HrReport = (typeof HR_REPORTS)[number];

/** Which export key each report prints under. */
export const HR_REPORT_KEY = {
  headcount: 'hr_headcount',
  leave: 'hr_leave_balances',
  payroll: 'hr_payroll_register',
  advances: 'hr_unsettled_advances',
} as const satisfies Record<HrReport, string>;

/** The grant each report is read under — the screen offers only what the reader may read. */
export const HR_REPORT_OBJECT = {
  headcount: 'hr_report',
  leave: 'hr_report',
  payroll: 'payroll_run',
  advances: 'employee_advance',
} as const satisfies Record<HrReport, string>;

const dateOf = (query: Query, name: string, fallback: string) => {
  const value = (query.get(name) ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
};

const model = (input: Pick<PrintModel, 'title' | 'filters' | 'tables'> & { fileName: string; orientation?: 'portrait' | 'landscape' }): PrintModel => ({
  kind: 'report',
  fields: [],
  summary: [],
  signatures: false,
  currency: 'IQD',
  orientation: input.orientation ?? 'landscape',
  sheetName: input.title.slice(0, 31),
  ...input,
});

const name = (ctx: BuildContext, row: { fullNameEn: string; fullNameAr: string | null }) => (ctx.locale === 'ar' && row.fullNameAr ? row.fullNameAr : row.fullNameEn);
/** Days are kept in hundredths (`domain/hr-time`); shown as the employee page shows them. */
const days = (hundredths: bigint) => showDays(hundredths);

/** People by branch, department and position at the period's end, with who joined and who left in it. */
export async function headcount(ctx: BuildContext, query: Query): Promise<Built | null> {
  const { m } = ctx;
  const to = dateOf(query, 'to', businessToday());
  const from = dateOf(query, 'from', `${to.slice(0, 4)}-01-01`);
  const rows = await hr.headcount(ctx.tx, from, to);
  const total = (key: 'headcount' | 'joiners' | 'leavers') => String(rows.reduce((sum, r) => sum + r[key], 0));
  return {
    model: model({
      title: m.print('titles.hr_headcount'),
      filters: [
        { label: m.admin('hr_reports.from'), value: formatBusinessDate(from, ctx.locale), ltr: true },
        { label: m.admin('hr_reports.to'), value: formatBusinessDate(to, ctx.locale), ltr: true },
      ],
      tables: [
        {
          columns: [
            { key: 'branch', label: m.column('branch'), kind: 'code' },
            { key: 'department', label: m.column('department'), kind: 'text', weight: 1.4 },
            { key: 'position', label: m.admin('hr_reports.position'), kind: 'text', weight: 1.4 },
            { key: 'headcount', label: m.admin('hr_reports.headcount'), kind: 'quantity' },
            { key: 'joiners', label: m.admin('hr_reports.joiners'), kind: 'quantity' },
            { key: 'leavers', label: m.admin('hr_reports.leavers'), kind: 'quantity' },
          ],
          rows: rows.map((r) => ({
            cells: {
              branch: r.branchCode,
              department: `${r.departmentCode} · ${r.departmentName}`,
              position: r.positionTitle ? `${r.positionCode} · ${r.positionTitle}` : m.admin('hr_reports.no_position'),
              headcount: String(r.headcount),
              joiners: String(r.joiners),
              leavers: String(r.leavers),
            },
          })),
          empty: m.admin('hr_reports.none'),
          totals: { label: m.admin('reports.totals'), cells: { headcount: total('headcount'), joiners: total('joiners'), leavers: total('leavers') } },
        },
      ],
      fileName: `hr-headcount_${from}_${to}`,
    }),
    branchCode: ctx.branchCode,
    objectId: `${from}:${to}`,
  };
}

/** Every working person's balance of every active type in a year. */
export async function leaveBalances(ctx: BuildContext, query: Query): Promise<Built | null> {
  const { m } = ctx;
  const yearText = (query.get('year') ?? '').trim();
  const year = /^\d{4}$/.test(yearText) ? Number(yearText) : Number(businessToday().slice(0, 4));
  const rows = await hr.leaveBalances(ctx.tx, year, EXPORT_ROW_CAP + 1);
  const columns: Column[] = [
    { key: 'employee', label: m.column('employee'), kind: 'text', weight: 1.6 },
    { key: 'department', label: m.column('department'), kind: 'code' },
    { key: 'type', label: m.admin('hr_reports.leave_type'), kind: 'text', weight: 1.2 },
    { key: 'carry', label: m.admin('hr_reports.carry_in'), kind: 'quantity' },
    { key: 'entitlement', label: m.admin('hr_reports.entitlement'), kind: 'quantity' },
    { key: 'adjustments', label: m.admin('hr_reports.adjustments'), kind: 'quantity' },
    { key: 'taken', label: m.admin('hr_reports.taken'), kind: 'quantity' },
    { key: 'pending', label: m.admin('hr_reports.pending'), kind: 'quantity' },
    { key: 'available', label: m.admin('hr_reports.available'), kind: 'quantity' },
  ];
  const out: Row[] = rows.map((r) => ({
    cells: {
      employee: `${r.employeeNo} · ${name(ctx, r)}`,
      department: r.departmentCode,
      type: ctx.locale === 'ar' && r.typeNameAr ? r.typeNameAr : r.typeNameEn,
      carry: days(r.carryIn),
      entitlement: days(r.entitlement),
      adjustments: days(r.adjustments),
      taken: days(r.taken),
      pending: days(r.pending),
      available: days(r.available),
    },
  }));
  return {
    model: model({
      title: m.print('titles.hr_leave_balances'),
      filters: [{ label: m.admin('hr_reports.year'), value: String(year), ltr: true }],
      // Days by type do not add across types: the table carries no totals.
      tables: [{ columns, rows: out, empty: m.admin('hr_reports.none') }],
      fileName: `hr-leave-balances_${year}`,
    }),
    branchCode: ctx.branchCode,
    objectId: String(year),
  };
}

/** A month's approved and posted runs, line by line, with their totals. */
export async function payrollRegister(ctx: BuildContext, query: Query): Promise<Built | null> {
  const { m } = ctx;
  const monthText = (query.get('month') ?? '').trim();
  const month = /^\d{4}-\d{2}$/.test(monthText) ? monthText : businessToday().slice(0, 7);
  const rows = await hr.payrollRegister(ctx.tx, month, EXPORT_ROW_CAP + 1);
  return {
    model: model({
      title: m.print('titles.hr_payroll_register'),
      filters: [{ label: m.admin('hr_reports.month'), value: month, ltr: true }],
      tables: [
        {
          columns: [
            { key: 'run', label: m.admin('hr_reports.run'), kind: 'code' },
            { key: 'branch', label: m.column('branch'), kind: 'code' },
            { key: 'employee', label: m.column('employee'), kind: 'text', weight: 1.6 },
            { key: 'department', label: m.column('department'), kind: 'code' },
            { key: 'payslip', label: m.admin('hr_reports.payslip'), kind: 'code' },
            { key: 'gross', label: m.admin('hr_reports.gross'), kind: 'money' },
            { key: 'deductions', label: m.admin('hr_reports.deductions'), kind: 'money' },
            { key: 'net', label: m.admin('hr_reports.net'), kind: 'money' },
            { key: 'employer', label: m.admin('hr_reports.employer_cost'), kind: 'money' },
          ],
          rows: rows.map((r) => ({
            cells: {
              run: r.runNo,
              branch: r.branchCode,
              employee: `${r.employeeNo} · ${name(ctx, r)}`,
              department: r.departmentCode,
              payslip: r.payslipNo,
              gross: r.grossIqd,
              deductions: r.deductionsIqd,
              net: r.netIqd,
              employer: r.employerCostIqd,
            },
          })),
          empty: m.admin('hr_reports.no_payroll'),
          totals: { label: m.admin('reports.totals'), cells: totalsOf(rows) },
        },
      ],
      fileName: `hr-payroll-register_${month}`,
    }),
    branchCode: ctx.branchCode,
    objectId: month,
  };
}

/** The register's money columns added up exactly, as scaled integers. */
function totalsOf(rows: readonly hr.PayrollRegisterRow[]) {
  const add = (key: 'grossIqd' | 'deductionsIqd' | 'netIqd' | 'employerCostIqd') => {
    const scale = 10_000n;
    const total = rows.reduce((sum, r) => {
      const [whole, fraction = ''] = r[key].split('.');
      return sum + BigInt(whole!) * scale + BigInt((fraction + '0000').slice(0, 4));
    }, 0n);
    return `${total / scale}.${String(total % scale).padStart(4, '0')}`;
  };
  return { gross: add('grossIqd'), deductions: add('deductionsIqd'), net: add('netIqd'), employer: add('employerCostIqd') };
}

/** Paid advances and loans still owing, how far behind and in which ageing bucket. */
export async function unsettledAdvances(ctx: BuildContext, query: Query): Promise<Built | null> {
  const { m } = ctx;
  const asOf = dateOf(query, 'as_of', businessToday());
  const rows = await hr.unsettledAdvances(ctx.tx, asOf, EXPORT_ROW_CAP + 1);
  return {
    model: model({
      title: m.print('titles.hr_unsettled_advances'),
      filters: [{ label: m.admin('hr_reports.as_of'), value: formatBusinessDate(asOf, ctx.locale), ltr: true }],
      tables: [
        {
          columns: [
            { key: 'advance', label: m.column('reference'), kind: 'code' },
            { key: 'kind', label: m.admin('hr_reports.kind'), kind: 'text' },
            { key: 'employee', label: m.column('employee'), kind: 'text', weight: 1.6 },
            { key: 'paid_on', label: m.admin('hr_reports.paid_on'), kind: 'date' },
            { key: 'amount', label: m.column('amount'), kind: 'money' },
            { key: 'recovered', label: m.admin('hr_reports.recovered'), kind: 'money' },
            { key: 'owed', label: m.admin('hr_reports.owed'), kind: 'money' },
            { key: 'behind', label: m.admin('hr_reports.behind_since'), kind: 'code' },
            { key: 'bucket', label: m.admin('hr_reports.bucket'), kind: 'code' },
          ],
          rows: rows.map((r) => ({
            cells: {
              advance: r.advanceNo,
              kind: m.admin(`advances.kind_${r.kind}`),
              employee: `${r.employeeNo} · ${name(ctx, r)}`,
              paid_on: r.paidOn,
              amount: r.amountIqd,
              recovered: r.recoveredIqd,
              owed: r.owedIqd,
              behind: r.behindSince ? r.behindSince.slice(0, 7) : null,
              bucket: r.bucket,
            },
          })),
          empty: m.admin('hr_reports.no_advances'),
          totals: { label: m.admin('reports.totals'), cells: { owed: sumMoney(rows.map((r) => r.owedIqd)) }, sum: ['owed'] },
        },
      ],
      fileName: `hr-unsettled-advances_${asOf}`,
    }),
    branchCode: ctx.branchCode,
    objectId: asOf,
  };
}

function sumMoney(values: readonly string[]): string {
  const scale = 10_000n;
  const total = values.reduce((sum, v) => {
    const negative = v.startsWith('-');
    const [whole, fraction = ''] = v.replace('-', '').split('.');
    const n = BigInt(whole!) * scale + BigInt((fraction + '0000').slice(0, 4));
    return sum + (negative ? -n : n);
  }, 0n);
  return `${total / scale}.${String((total < 0n ? -total : total) % scale).padStart(4, '0')}`;
}

/** An issued letter: its text as it was issued, with whom it is for and who issued it. */
export async function letter(ctx: BuildContext, requestNo: string): Promise<Built | null> {
  const { m, locale } = ctx;
  const found = await requests.byNo(ctx.tx, requestNo);
  if (!found || found.row.kind !== 'letter' || found.row.status !== 'issued' || !found.row.issuedText) return null;
  const { row, person } = found;
  const t = (key: string) => m.admin(`requests.${key}`);
  const paragraphs = row.issuedText!.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return {
    model: {
      kind: 'document',
      title: m.print('titles.hr_letter'),
      number: row.requestNo,
      status: m.admin('requests.status_issued'),
      posted: true,
      orientation: 'portrait',
      fields: [
        { label: m.column('reference'), value: row.requestNo, ltr: true },
        { label: t('issued_on'), value: formatBusinessDate(businessDateOf(row.issuedAt!), locale), ltr: true },
        { label: t('employee'), value: `${person.employeeNo} · ${locale === 'ar' && person.fullNameAr ? person.fullNameAr : person.fullNameEn}` },
        { label: t('letter_type'), value: t(`letter_type_${row.letterType}`) },
        { label: t('addressed_to'), value: row.addressedTo ?? '—' },
      ],
      filters: [],
      tables: [{ columns: [{ key: 'text', label: row.subject, kind: 'text' }], rows: paragraphs.map((text) => ({ cells: { text } })), empty: '—' }],
      summary: [],
      signatures: true,
      currency: 'IQD',
      fileName: row.requestNo,
      sheetName: row.requestNo,
    },
    branchCode: row.branchCode,
    objectId: row.id,
  };
}

export const BUILD: Record<HrReport, (ctx: BuildContext, query: Query) => Promise<Built | null>> = {
  headcount,
  leave: leaveBalances,
  payroll: payrollRegister,
  advances: unsettledAdvances,
};
