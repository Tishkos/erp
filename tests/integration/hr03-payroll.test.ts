/**
 * REQ-HR-001 Stage HR-3 — payroll, against the database.
 *
 *   H4  a run is computed from the facts (compensation, the person's own
 *       figures, the day sheet, the leave) and a typed total is impossible;
 *       whoever prepared it never approves it; posting books the mapped
 *       journal and issues the payslips, which are frozen; the net pay leaves
 *       a bank and a cash account; a run nothing was paid from is reversed
 *       whole and the month run again
 *   H5  the worked example (B-HR-15): payslip, journal and payment agree to
 *       the dinar
 *   R5  a person reads their own payslip and nothing else of the run; the
 *       forecast and the month's close read the pay without reading a salary
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, rejection } from './setup';
import { fundAccount } from './hr-funds';
import { BAGHDAD, buildTradingWorld, type TradingWorld } from './trading-fixture';
import { withScope } from '@/server/db/client';
import * as attendance from '@/server/services/attendance';
import * as authz from '@/server/services/authorization';
import * as banks from '@/server/services/bank-cash-accounts';
import * as cash from '@/server/services/cash-forecast';
import * as closing from '@/server/services/closing-checks';
import * as coa from '@/server/services/chart-of-accounts';
import * as employees from '@/server/services/employees';
import * as settings from '@/server/services/hr-settings';
import * as payroll from '@/server/services/payroll';
import type { ActorContext } from '@/server/services/chart-of-accounts';

let world: TradingWorld;
let manager: ActorContext;
let hr: ActorContext;
let karimUser: ActorContext;
let karimId = '';
let linaId = '';
let cashAccountId = '';
const accounts: Record<string, string> = {};

async function userWith(roles: string[], name: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [id, `${id}@example.com`, name]);
  for (const role of roles) await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code, is_default) values ($1,$2,true)`, [id, BAGHDAD]);
  await ownerPool.query(`insert into user_department_scope (user_id, department_code) values ($1,'FIN') on conflict do nothing`, [id]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BAGHDAD };
}

const as = <T>(ctx: ActorContext, fn: (tx: Parameters<Parameters<typeof withScope>[1]>[0]) => Promise<T>) => withScope({ userId: ctx.principal.userId, branchCode: BAGHDAD }, fn);

async function person(no: string, name: string, department: string, hireDate: string, extra: { endDate?: string; status?: string; appUserId?: string } = {}): Promise<string> {
  const { rows } = await ownerPool.query(
    `insert into employee (employee_no, full_name_en, branch_code, department_code, hire_date, status, end_date, app_user_id, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [no, name, BAGHDAD, department, hireDate, extra.status ?? (extra.endDate ? 'ended' : 'active'), extra.endDate ?? null, extra.appUserId ?? null, manager.principal.userId],
  );
  return rows[0].id as string;
}

async function journalOf(entryId: string) {
  const { rows } = await ownerPool.query(
    `select l.account_id, l.debit_iqd::text as dr, l.credit_iqd::text as cr, l.department_code, l.bank_account_code, e.posting_date::text as on
       from journal_line l join journal_entry e on e.id = l.journal_entry_id where l.journal_entry_id = $1 order by l.line_no`,
    [entryId],
  );
  return rows as { account_id: string; dr: string; cr: string; department_code: string | null; bank_account_code: string | null; on: string }[];
}
const roleOf = (id: string) => Object.entries(accounts).find(([, a]) => a === id)?.[0] ?? id;
const notified = async (userId: string, eventType: string) =>
  (await ownerPool.query(`select subject from notification where recipient_user_id = $1 and event_type = $2`, [userId, eventType])).rows.map((r) => r.subject as string);

/** September 2026 for Baghdad, typed and sent, as H5 has it. */
async function preparedSeptember() {
  const made = await as(hr, (tx) => payroll.create(tx, hr, { branchCode: BAGHDAD, month: '2026-09' }));
  await as(hr, (tx) =>
    payroll.saveTyped(tx, hr, made.runNo, [
      { employeeId: karimId, componentCode: 'OVERTIME', amount: '50000', note: 'Stock count, 12 September' },
      { employeeId: karimId, componentCode: 'INCOME_TAX', amount: '25000', note: "The accountant's worksheet" },
    ]),
  );
  return made;
}

beforeEach(async () => {
  world = await buildTradingWorld();
  manager = world.manager;
  hr = await userWith(['hr_manager'], 'HR Manager');
  karimUser = await userWith([], 'Karim Saleh');
  await ownerPool.query(`insert into department (code, name) values ('OPS','Operations') on conflict do nothing`);
  await ownerPool.query(`insert into bank (code, name) values ('RAF-HR3','Payroll Test Bank') on conflict do nothing`);

  let serial = 0;
  for (const [role, parent, name] of [
    ['salary_expense', 'X000001', 'Salaries and Wages'],
    ['payroll_employer_cost', 'X000001', 'Employer Social Security'],
    ['payroll_withholding', 'L000001', 'Payroll Deductions Payable'],
    ['net_pay', 'L000001', 'Salaries Payable'],
    ['ss_payable', 'L000001', 'Social Security Payable'],
    ['tax_payable', 'L000001', 'Income Tax Payable'],
    ['cash', 'A000001', 'Cash — Payroll Till'],
  ] as const) {
    const { rows: parents } = await ownerPool.query(`select id, account_type from chart_of_account where code = $1`, [parent]);
    const { rows } = await ownerPool.query(
      `insert into chart_of_account (code, name, account_type, parent_id, is_group, is_active, approval_status, level, currency_restriction)
       values ($1,$2,$3,$4,false,true,'approved',1,'IQD') returning id`,
      [`${parent.slice(0, 1)}7${String((serial += 1)).padStart(5, '0')}`, name, parents[0].account_type, parents[0].id],
    );
    accounts[role] = rows[0].id;
    await as(manager, (tx) => coa.setRequiredDimensions(tx, manager, rows[0].id, []));
  }
  accounts.bank = world.accounts.bank!;
  for (const [event, role] of [
    ['hr.payroll_run', 'salary_expense'],
    ['hr.payroll_run', 'payroll_employer_cost'],
    ['hr.payroll_run', 'payroll_withholding'],
    ['hr.payroll_run', 'net_pay'],
    ['hr.payroll_payment', 'net_pay'],
  ] as const) {
    await ownerPool.query(`insert into posting_rule (event_type, line_role, account_id, is_active, created_by) values ($1,$2,$3,true,$4)`, [event, role, accounts[role], manager.principal.userId]);
  }
  // Social security and tax are owed on their own accounts (§9 "Cr social security payable, Cr income tax payable").
  for (const [code, account] of [
    ['SS_EMPLOYEE', 'ss_payable'],
    ['SS_EMPLOYER', 'ss_payable'],
    ['INCOME_TAX', 'tax_payable'],
  ] as const) {
    const [row] = (await as(hr, (tx) => settings.payComponents(tx))).filter((c) => c.code === code);
    await as(hr, (tx) =>
      settings.updatePayComponent(tx, hr, code, {
        nameEn: row!.nameEn,
        nameAr: row!.nameAr,
        kind: row!.kind,
        calculation: row!.calculation,
        defaultValue: row!.defaultValue,
        taxable: row!.taxable,
        liabilityAccountId: accounts[account]!,
      }),
    );
  }
  const till = await as(manager, (tx) => banks.create(tx, manager, 'cash', { name: 'Payroll Till', glAccountId: accounts.cash!, currency: 'IQD', custodianUserId: manager.principal.userId }));
  // C-20 — the bank and the till hold money before the pay leaves them.
  await fundAccount(world, accounts.bank!, '10000000.0000');
  await fundAccount(world, accounts.cash!, '10000000.0000');
  cashAccountId = (await ownerPool.query(`select id from bank_cash_account where code = $1`, [till.code])).rows[0].id;

  karimId = await person('E-0001', 'Karim Saleh', 'FIN', '2025-01-01', { appUserId: karimUser.principal.userId });
  linaId = await person('E-0002', 'Lina Aziz', 'OPS', '2026-09-15');
  await person('E-0003', 'Sami Left', 'FIN', '2024-01-01', { endDate: '2026-08-31' });
  await person('E-0004', 'Noor Suspended', 'OPS', '2024-01-01', { status: 'suspended' });
  await as(hr, (tx) => employees.setCompensation(tx, hr, karimId, { effectiveFrom: '2025-01-01', baseSalaryIqd: '1500000', payMethod: 'bank', bankCode: 'RAF-HR3', accountNumber: 'RF-1001' }));
  await as(hr, (tx) => employees.setCompensation(tx, hr, linaId, { effectiveFrom: '2026-09-15', baseSalaryIqd: '1000000', payMethod: 'cash' }));
  await as(hr, (tx) => employees.setPayFigure(tx, hr, karimId, { componentCode: 'HOUSING', effectiveFrom: '2026-01-01', amount: '300000', note: 'Contract annex' }));
  await as(hr, (tx) => employees.setPayFigure(tx, hr, karimId, { componentCode: 'TRANSPORT', effectiveFrom: '2026-01-01', amount: '100000' }));
  // Absent on Tuesday 8 September.
  await as(hr, (tx) => attendance.saveSheet(tx, hr, { branchCode: BAGHDAD, day: '2026-09-08', entries: [{ employeeId: karimId, status: 'absent' }] }));
});

describe('H4 · a run computed from the facts', () => {
  it('gathers who the branch employed, computes each line, and keeps a total the sum of its parts', async () => {
    const made = await as(hr, (tx) => payroll.create(tx, hr, { branchCode: BAGHDAD, month: '2026-09' }));
    expect(made.runNo).toMatch(/^PAY-BGW-2026-\d{4}$/);
    const run = (await as(hr, (tx) => payroll.byNo(tx, made.runNo)))!;
    expect(run.run).toMatchObject({ status: 'draft', workingDays: 22, employees: 2, periodMonth: '2026-09-01', periodEnd: '2026-09-30', payDate: '2026-09-30' });
    // The leaver and the suspended are not paid; Lina from her first day.
    expect(run.lines.map(({ line }) => [line.employeeNo, line.employedDays, line.absentDays, line.payMethod])).toEqual([
      ['E-0001', 22, 1, 'bank'],
      ['E-0002', 12, 0, 'cash'],
    ]);

    // A manual figure needs its note, and only a manual component is typed.
    expect(await rejection(as(hr, (tx) => payroll.saveTyped(tx, hr, made.runNo, [{ employeeId: karimId, componentCode: 'OVERTIME', amount: '50000' }])))).toMatch(/needs its note/);
    expect(await rejection(as(hr, (tx) => payroll.saveTyped(tx, hr, made.runNo, [{ employeeId: karimId, componentCode: 'BASE', amount: '1', note: 'x' }])))).toMatch(/computed/);

    // A typed total is impossible: the line is held to the sum of its parts.
    expect(await rejection(ownerPool.query(`update payroll_line set net_iqd = 1 where employee_id = $1`, [karimId]))).toMatch(/payroll_line_net/);

    // The facts change, the draft follows: a second absence once computed again.
    await as(hr, (tx) => attendance.saveSheet(tx, hr, { branchCode: BAGHDAD, day: '2026-09-09', entries: [{ employeeId: karimId, status: 'absent' }] }));
    await as(hr, (tx) => payroll.recompute(tx, hr, made.runNo));
    const again = (await as(hr, (tx) => payroll.byNo(tx, made.runNo)))!;
    expect(again.lines[0]!.line.absentDays).toBe(2);
    expect(again.lines[0]!.components.find((c) => c.componentCode === 'ABSENCE')!.amountIqd).toBe('136364.0000');

    // One live run per branch per month.
    expect(await rejection(as(hr, (tx) => payroll.create(tx, hr, { branchCode: BAGHDAD, month: '2026-09' })))).toMatch(/already has PAY-BGW-2026-\d{4} \(draft\) for 2026-09/);
    // A month that has not begun is not prepared.
    expect(await rejection(as(hr, (tx) => payroll.create(tx, hr, { branchCode: BAGHDAD, month: '2099-01' })))).toMatch(/has not begun/);
  });

  it('refuses to send a run while somebody has no salary in force, naming them', async () => {
    await person('E-0005', 'New Hire', 'FIN', '2026-09-01');
    const made = await as(hr, (tx) => payroll.create(tx, hr, { branchCode: BAGHDAD, month: '2026-09' }));
    expect(await rejection(as(hr, (tx) => payroll.submit(tx, hr, made.runNo)))).toMatch(/E-0005 has no salary in force by 2026-09-30/);
  });

  it('is prepared only by a reader of compensation: the officer is refused, and the refusal is written', async () => {
    const officer = await userWith(['hr_officer'], 'HR Officer');
    expect(await rejection(as(officer, (tx) => payroll.create(tx, officer, { branchCode: BAGHDAD, month: '2026-09' })))).toMatch(/not permitted|denied|may not/i);
    const { rows } = await ownerPool.query(`select count(*)::int as n from audit_event where actor_user_id = $1 and outcome = 'denied'`, [officer.principal.userId]);
    expect(rows[0].n).toBeGreaterThan(0);
  });
});

describe('H4 · maker-checker', () => {
  it('whoever prepared or sent a run never approves it — the service says so and the database holds it', async () => {
    const both = await userWith(['hr_manager', 'accounting_manager'], 'HR and Finance');
    const made = await as(both, (tx) => payroll.create(tx, both, { branchCode: BAGHDAD, month: '2026-09' }));
    await as(both, (tx) => payroll.submit(tx, both, made.runNo));
    expect(await rejection(as(both, (tx) => payroll.approve(tx, both, made.runNo)))).toMatch(/You prepared PAY-BGW-2026-\d{4}; somebody else approves it/);
    expect(await rejection(as(hr, (tx) => payroll.approve(tx, hr, made.runNo)))).toBeTruthy();
    expect(await rejection(ownerPool.query(`update payroll_run set approved_by = created_by, status = 'approved' where run_no = $1`, [made.runNo]))).toMatch(/payroll_run_approver_not_preparer/);
    // Sent back with a note, it is a draft again and its preparer is told.
    await as(manager, (tx) => payroll.returnToDraft(tx, manager, made.runNo, 'Overtime for the stock count is missing'));
    expect((await as(both, (tx) => payroll.byNo(tx, made.runNo)))!.run).toMatchObject({ status: 'draft', returnNote: 'Overtime for the stock count is missing' });
    expect(await notified(both.principal.userId, 'hr.payroll_returned')).toHaveLength(1);
  });
});

describe('H5 · the worked example, posted and paid to the dinar', () => {
  it('posts the mapped journal, issues frozen payslips, and pays by bank and by cash', async () => {
    const made = await preparedSeptember();
    await as(hr, (tx) => payroll.submit(tx, hr, made.runNo));
    expect(await notified(manager.principal.userId, 'hr.payroll_submitted')).toEqual([`${made.runNo} waits for your approval`]);
    await as(manager, (tx) => payroll.approve(tx, manager, made.runNo));
    const posted = await as(manager, (tx) => payroll.post(tx, manager, made.runNo));

    const run = (await as(manager, (tx) => payroll.byNo(tx, made.runNo)))!;
    expect(run.run).toMatchObject({ status: 'posted', grossIqd: '2495455.0000', deductionsIqd: '192046.0000', netIqd: '2303409.0000', employerCostIqd: '237273.0000' });
    const karim = run.lines.find(({ line }) => line.employeeNo === 'E-0001')!;
    expect(karim.line).toMatchObject({ grossIqd: '1950000.0000', deductionsIqd: '164773.0000', netIqd: '1785227.0000', employerCostIqd: '171818.0000' });
    expect(karim.components.map((c) => [c.componentCode, c.amountIqd])).toEqual([
      ['BASE', '1500000.0000'],
      ['HOUSING', '300000.0000'],
      ['TRANSPORT', '100000.0000'],
      ['OVERTIME', '50000.0000'],
      ['ABSENCE', '68182.0000'],
      ['SS_EMPLOYEE', '71591.0000'],
      ['INCOME_TAX', '25000.0000'],
      ['SS_EMPLOYER', '171818.0000'],
    ]);
    expect(run.lines.map(({ line }) => line.payslipNo)).toEqual(['PSL-BGW-2026-000001', 'PSL-BGW-2026-000002']);

    // The journal: the cost by department (the base less its absence), what is owed and to whom.
    const lines = await journalOf(posted.journalEntryId);
    expect(lines.map((l) => [roleOf(l.account_id), l.dr, l.cr, l.department_code, l.on])).toEqual([
      ['salary_expense', '1431818.0000', '0.0000', 'FIN', '2026-09-30'],
      ['salary_expense', '300000.0000', '0.0000', 'FIN', '2026-09-30'],
      ['salary_expense', '50000.0000', '0.0000', 'FIN', '2026-09-30'],
      ['salary_expense', '100000.0000', '0.0000', 'FIN', '2026-09-30'],
      ['payroll_employer_cost', '171818.0000', '0.0000', 'FIN', '2026-09-30'],
      ['salary_expense', '545455.0000', '0.0000', 'OPS', '2026-09-30'],
      ['payroll_employer_cost', '65455.0000', '0.0000', 'OPS', '2026-09-30'],
      ['tax_payable', '0.0000', '25000.0000', null, '2026-09-30'],
      ['ss_payable', '0.0000', '98864.0000', null, '2026-09-30'],
      ['ss_payable', '0.0000', '237273.0000', null, '2026-09-30'],
      ['net_pay', '0.0000', '2303409.0000', null, '2026-09-30'],
    ]);

    // Posted, a payslip's figures and its lines do not change.
    expect(await rejection(ownerPool.query(`update payroll_line set gross_iqd = gross_iqd + 1, net_iqd = net_iqd + 1 where employee_id = $1`, [karimId]))).toMatch(/do not change/);
    expect(await rejection(ownerPool.query(`delete from payroll_line_component where line_id = $1`, [karim.line.id]))).toMatch(/not removed|do not change/);
    expect(await notified(karimUser.principal.userId, 'hr.payslip_issued')).toEqual(['Your payslip PSL-BGW-2026-000001 for 2026-09 is issued']);

    // R5 — Karim reads his own payslip, not Lina's, and not the run.
    const own = await as(karimUser, (tx) => payroll.payslip(tx, 'PSL-BGW-2026-000001'));
    expect(own?.line.netIqd).toBe('1785227.0000');
    expect(own?.run).toMatchObject({ runNo: made.runNo, status: 'posted', periodMonth: '2026-09-01', paidOn: null });
    expect(await as(karimUser, (tx) => payroll.payslip(tx, 'PSL-BGW-2026-000002'))).toBeNull();
    expect(await as(karimUser, (tx) => payroll.byNo(tx, made.runNo))).toBeNull();
    expect((await as(karimUser, (tx) => payroll.listForScreen(tx, {}))).total).toBe(0);

    // The forecast reads the pay still to go out on its pay date — totals only.
    const before = await as(manager, (tx) => cash.forecast(tx, manager, { from: '2026-09-01', to: '2026-10-31', branchCode: BAGHDAD }));
    expect(before.lines.filter((l) => l.source === 'payroll').map((l) => [l.periodStart, l.outflowIqd])).toEqual([['2026-09-30', '2303409.0000']]);

    // Paid: the bank transfer, then the cash. A paid run is not reversed.
    const bank = await as(manager, (tx) => payroll.pay(tx, manager, made.runNo, { payMethod: 'bank', bankCashAccountId: world.bankAccountId, paidOn: '2026-09-30', reference: 'Salary file 09/2026' }));
    expect(bank.amountIqd).toBe('1785227.0000');
    expect(await rejection(as(manager, (tx) => payroll.pay(tx, manager, made.runNo, { payMethod: 'cash', bankCashAccountId: world.bankAccountId, paidOn: '2026-09-30' })))).toMatch(
      /is a bank account; cash is paid from a cash account/,
    );
    expect(await rejection(as(manager, (tx) => payroll.reverse(tx, manager, made.runNo, 'Wrong month')))).toMatch(/has been paid from/);
    await as(manager, (tx) => payroll.pay(tx, manager, made.runNo, { payMethod: 'cash', bankCashAccountId: cashAccountId, paidOn: '2026-09-30', reference: 'CV-0930' }));
    expect(await rejection(as(manager, (tx) => payroll.pay(tx, manager, made.runNo, { payMethod: 'cash', bankCashAccountId: cashAccountId, paidOn: '2026-09-30' })))).toMatch(
      /is paid; a posted run is paid|is paid/,
    );

    const paid = (await as(manager, (tx) => payroll.byNo(tx, made.runNo)))!;
    expect(paid.run).toMatchObject({ status: 'paid', paidIqd: '2303409.0000' });
    expect(paid.payments.map((p) => [p.payMethod, p.amountIqd, p.lines])).toEqual([
      ['bank', '1785227.0000', 1],
      ['cash', '518182.0000', 1],
    ]);
    const { rows: balances } = await ownerPool.query(
      `select l.account_id, sum(l.debit_iqd - l.credit_iqd)::text as b, max(l.bank_account_code) as party
         from journal_line l join journal_entry e on e.id = l.journal_entry_id
        where e.status = 'posted' and l.account_id = any($1::uuid[]) group by l.account_id`,
      [[accounts.net_pay, accounts.bank, accounts.cash]],
    );
    const balance = (role: string) => balances.find((b) => b.account_id === accounts[role]);
    expect(balance('net_pay')!.b).toBe('0.0000');
    // Each was funded with 10,000,000 (C-20); the pay left them.
    expect(balance('bank')!.b).toBe('8214773.0000');
    expect(balance('cash')!.b).toBe('9481818.0000');
    expect(balance('bank')!.party).toBeTruthy();
    expect((await as(karimUser, (tx) => payroll.payslip(tx, 'PSL-BGW-2026-000001')))?.run).toMatchObject({ status: 'paid', paidOn: '2026-09-30', paymentReference: 'Salary file 09/2026' });

    const after = await as(manager, (tx) => cash.forecast(tx, manager, { from: '2026-09-01', to: '2026-10-31', branchCode: BAGHDAD }));
    expect(after.lines.filter((l) => l.source === 'payroll')).toEqual([]);
  });
});

describe('H4 · reversed whole, and the month run again', () => {
  it('mirrors the journal, frees the month, and keeps the payslips it issued', async () => {
    const made = await preparedSeptember();
    await as(hr, (tx) => payroll.submit(tx, hr, made.runNo));
    await as(manager, (tx) => payroll.approve(tx, manager, made.runNo));
    const posted = await as(manager, (tx) => payroll.post(tx, manager, made.runNo));
    expect(await rejection(as(hr, (tx) => payroll.reverse(tx, hr, made.runNo, 'Wrong rates')))).toBeTruthy();
    const reversal = await as(manager, (tx) => payroll.reverse(tx, manager, made.runNo, 'Housing was not due in September'));
    const { rows } = await ownerPool.query(`select id from journal_entry where entry_no = $1`, [reversal.entryNo]);
    const original = await journalOf(posted.journalEntryId);
    const mirrored = await journalOf(rows[0].id);
    expect(mirrored.map((l) => [l.account_id, l.dr, l.cr])).toEqual(original.map((l) => [l.account_id, l.cr, l.dr]));
    expect((await as(manager, (tx) => payroll.byNo(tx, made.runNo)))!.run).toMatchObject({ status: 'reversed', reversalReason: 'Housing was not due in September' });
    expect(
      (await ownerPool.query(`select count(*)::int as n from payroll_line where run_id = (select id from payroll_run where run_no = $1) and payslip_no is not null`, [made.runNo])).rows[0].n,
    ).toBe(2);

    // The month again: a new run, cancelled with its reason, then a third.
    const rerun = await as(hr, (tx) => payroll.create(tx, hr, { branchCode: BAGHDAD, month: '2026-09' }));
    expect(rerun.runNo).not.toBe(made.runNo);
    await as(hr, (tx) => payroll.cancel(tx, hr, rerun.runNo, 'Prepared twice'));
    expect((await as(hr, (tx) => payroll.create(tx, hr, { branchCode: BAGHDAD, month: '2026-09' }))).runNo).toMatch(/^PAY-BGW-2026-/);
  });
});

describe('the person, the screens and the close', () => {
  it('keeps a person’s own figures as dated rows under the compensation grant', async () => {
    const officer = await userWith(['hr_officer'], 'HR Officer');
    expect(await rejection(as(officer, (tx) => employees.setPayFigure(tx, officer, karimId, { componentCode: 'HOUSING', effectiveFrom: '2026-10-01', amount: '350000' })))).toBeTruthy();
    expect(await rejection(as(hr, (tx) => employees.setPayFigure(tx, hr, karimId, { componentCode: 'BASE', effectiveFrom: '2026-10-01', amount: '1' })))).toMatch(/read from the salary/);
    await as(hr, (tx) => employees.setPayFigure(tx, hr, karimId, { componentCode: 'SS_EMPLOYEE', effectiveFrom: '2026-10-01', stopped: true, note: 'Retired, exempt' }));
    const figures = await as(hr, (tx) => employees.payFiguresOf(tx, hr, karimId));
    expect(figures.map((f) => [f.componentCode, f.amount, f.stopped])).toEqual([
      ['SS_EMPLOYEE', null, true],
      // Newest first: transport was recorded after housing, from the same day.
      ['TRANSPORT', '100000.0000', false],
      ['HOUSING', '300000.0000', false],
    ]);
    expect((await as(officer, (tx) => tx.execute(sql`select count(*)::int as n from employee_pay_component`))).rows).toEqual([{ n: 0 }]);
    expect(await rejection(ownerPool.query(`update employee_pay_component set amount = 1 where employee_id = $1`, [karimId]))).toMatch(/append-only/);
    const history = await as(hr, (tx) => employees.historyOf(tx, karimId));
    expect(history.map((h) => h.field)).toContain('pay_component:SS_EMPLOYEE');
  });

  it('waits on the right desk, and the month’s close warns until the payroll is posted', async () => {
    const made = await preparedSeptember();
    await as(hr, (tx) => payroll.submit(tx, hr, made.runNo));
    expect((await as(manager, (tx) => payroll.waitingFor(tx, manager))).map((w) => [w.runNo, w.action])).toEqual([[made.runNo, 'approve']]);
    expect(await as(hr, (tx) => payroll.waitingFor(tx, hr))).toEqual([]);

    const september = { id: '', fiscalYearCode: 'FY2026', periodNo: 9, name: 'September 2026', startsOn: '2026-09-01', endsOn: '2026-09-30', status: 'open' as const };
    const warned = await as(manager, (tx) => closing.report(tx, september));
    expect(warned.checks.find((c) => c.code === 'payroll_posted')).toMatchObject({ state: 'warn', figure: '1', detail: [`${BAGHDAD}: ${made.runNo} (submitted)`] });
    await as(manager, (tx) => payroll.approve(tx, manager, made.runNo));
    await as(manager, (tx) => payroll.post(tx, manager, made.runNo));
    expect((await as(manager, (tx) => payroll.waitingFor(tx, manager))).map((w) => [w.runNo, w.action, w.netIqd])).toEqual([[made.runNo, 'pay', '2303409.0000']]);
    // The checklist reads the same for somebody who may not see a salary.
    const clerk = world.clerk;
    const passed = await as(clerk, (tx) => closing.report(tx, september));
    expect(passed.checks.find((c) => c.code === 'payroll_posted')).toMatchObject({ state: 'pass', figure: '0' });
    const october = { ...september, periodNo: 10, name: 'October 2026', startsOn: '2026-10-01', endsOn: '2026-10-31' };
    expect((await as(clerk, (tx) => closing.report(tx, october))).checks.find((c) => c.code === 'payroll_posted')).toMatchObject({ state: 'warn', detail: [`${BAGHDAD}: no payroll run`] });
  });
});
