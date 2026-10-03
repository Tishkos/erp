/**
 * REQ-HR-001 Stage HR-4 — advances, loans and equipment, against the database.
 *
 *   H6  an advance is asked for (by the person, R5), endorsed by their
 *       manager, approved by Finance — never by the asker, the person or the
 *       endorser — and paid from a bank account; payroll recovers it month by
 *       month until nothing is owed, a missed month is caught up, a reversed
 *       run gives its recovery back, cash may settle what remains and never
 *       more; the sweep raises an advance behind its schedule once
 *   §10 equipment handed out and returned with its condition; a leaver's
 *       clearance is what is still out and still owed
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, rejection } from './setup';
import { fundAccount } from './hr-funds';
import { BAGHDAD, buildTradingWorld, type TradingWorld } from './trading-fixture';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import * as advances from '@/server/services/employee-advances';
import * as equipment from '@/server/services/employee-assets';
import * as employees from '@/server/services/employees';
import * as hrSweep from '@/server/services/hr-sweep';
import * as payroll from '@/server/services/payroll';
import type { ActorContext } from '@/server/services/chart-of-accounts';

let world: TradingWorld;
let manager: ActorContext;
let hr: ActorContext;
let karimUser: ActorContext;
let bossUser: ActorContext;
let karimId = '';
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

const balance = async (role: string) =>
  (
    await ownerPool.query(
      `select coalesce(sum(l.debit_iqd - l.credit_iqd), 0)::text as b from journal_line l join journal_entry e on e.id = l.journal_entry_id where e.status in ('posted', 'reversed') and l.account_id = $1`,
      [accounts[role]],
    )
  ).rows[0].b as string;
const advanceRow = async (advanceNo: string) =>
  (await ownerPool.query(`select status, recovered_iqd::text as recovered from employee_advance where advance_no = $1`, [advanceNo])).rows[0] as { status: string; recovered: string };

/** A loan Karim asks for himself, endorsed by his manager, approved by Finance, paid in July. */
async function paidLoan(amount = '600000', instalments = 3, firstMonth = '2026-08') {
  const made = await as(karimUser, (tx) => advances.create(tx, karimUser, { employeeId: karimId, kind: 'loan', amount, instalments, firstRecoveryMonth: firstMonth, reason: 'Car repair' }));
  await as(karimUser, (tx) => advances.submit(tx, karimUser, made.advanceNo));
  await as(bossUser, (tx) => advances.endorse(tx, bossUser, made.advanceNo, 'Agreed'));
  await as(manager, (tx) => advances.approve(tx, manager, made.advanceNo));
  await as(manager, (tx) => advances.pay(tx, manager, made.advanceNo, { bankCashAccountId: world.bankAccountId, on: '2026-07-25', reference: 'TRF-77' }));
  return made.advanceNo;
}

/** A month's payroll for Baghdad: prepared by HR, approved and posted by Finance. */
async function postedRun(month: string) {
  const made = await as(hr, (tx) => payroll.create(tx, hr, { branchCode: BAGHDAD, month }));
  await as(hr, (tx) => payroll.submit(tx, hr, made.runNo));
  await as(manager, (tx) => payroll.approve(tx, manager, made.runNo));
  await as(manager, (tx) => payroll.post(tx, manager, made.runNo));
  return made.runNo;
}
const advanceOn = async (runNo: string) => {
  const run = (await as(manager, (tx) => payroll.byNo(tx, runNo)))!;
  return run.lines[0]!.components.find((c) => c.componentCode === 'ADVANCE')?.amountIqd ?? null;
};

beforeEach(async () => {
  world = await buildTradingWorld();
  manager = world.manager;
  hr = await userWith(['hr_manager'], 'HR Manager');
  karimUser = await userWith([], 'Karim Saleh');
  bossUser = await userWith([], 'Boss');
  let serial = 0;
  for (const [role, parent, name] of [
    ['salary_expense', 'X000001', 'Salaries and Wages'],
    ['payroll_withholding', 'L000001', 'Payroll Deductions Payable'],
    ['payroll_employer_cost', 'X000001', 'Employer Social Security'],
    ['net_pay', 'L000001', 'Salaries Payable'],
    ['employee_advance', 'A000001', 'Employee Advances and Loans'],
  ] as const) {
    const { rows: parents } = await ownerPool.query(`select id, account_type from chart_of_account where code = $1`, [parent]);
    const { rows } = await ownerPool.query(
      `insert into chart_of_account (code, name, account_type, parent_id, is_group, is_active, approval_status, level, currency_restriction)
       values ($1,$2,$3,$4,false,true,'approved',1,'IQD') returning id`,
      [`${parent.slice(0, 1)}6${String((serial += 1)).padStart(5, '0')}`, name, parents[0].account_type, parents[0].id],
    );
    accounts[role] = rows[0].id;
    await as(manager, (tx) => coa.setRequiredDimensions(tx, manager, rows[0].id, []));
  }
  accounts.bank = world.accounts.bank!;
  // C-20 — the bank holds money before an advance leaves it.
  await fundAccount(world, accounts.bank, '10000000.0000');
  for (const [event, role] of [
    ['hr.payroll_run', 'salary_expense'],
    ['hr.payroll_run', 'payroll_withholding'],
    ['hr.payroll_run', 'payroll_employer_cost'],
    ['hr.payroll_run', 'net_pay'],
    ['hr.payroll_run', 'employee_advance'],
    ['hr.employee_advance', 'employee_advance'],
    ['hr.employee_advance_repayment', 'employee_advance'],
  ] as const) {
    await ownerPool.query(`insert into posting_rule (event_type, line_role, account_id, is_active, created_by) values ($1,$2,$3,true,$4)`, [event, role, accounts[role], manager.principal.userId]);
  }
  const { rows: boss } = await ownerPool.query(
    `insert into employee (employee_no, full_name_en, branch_code, department_code, hire_date, app_user_id, created_by) values ('E-0009','Boss',$1,'FIN','2020-01-01',$2,$3) returning id`,
    [BAGHDAD, bossUser.principal.userId, manager.principal.userId],
  );
  const { rows: karim } = await ownerPool.query(
    `insert into employee (employee_no, full_name_en, branch_code, department_code, hire_date, app_user_id, manager_employee_id, created_by) values ('E-0001','Karim Saleh',$1,'FIN','2025-01-01',$2,$3,$4) returning id`,
    [BAGHDAD, karimUser.principal.userId, boss[0].id, manager.principal.userId],
  );
  karimId = karim[0].id;
  // Only Karim is paid in these runs: the boss's salary is not in force (he is suspended for the test).
  await ownerPool.query(`update employee set status = 'suspended' where id = $1`, [boss[0].id]);
  await as(hr, (tx) => employees.setCompensation(tx, hr, karimId, { effectiveFrom: '2025-01-01', baseSalaryIqd: '1500000', payMethod: 'cash' }));
});

describe('H6 · asked, endorsed, approved, paid', () => {
  it('is asked for by the person, endorsed by their manager and approved by Finance — never by the asker, the person or the endorser', async () => {
    const made = await as(karimUser, (tx) =>
      advances.create(tx, karimUser, { employeeId: karimId, kind: 'loan', amount: '600000', instalments: 3, firstRecoveryMonth: '2026-08', reason: 'Car repair' }),
    );
    expect(made.advanceNo).toMatch(/^EADV-BGW-2026-\d{5}$/);
    expect(await rejection(as(karimUser, (tx) => advances.create(tx, karimUser, { employeeId: karimId, kind: 'advance', amount: '100000', instalments: 2, reason: 'x' })))).toMatch(/one instalment/);
    expect(await rejection(as(karimUser, (tx) => advances.create(tx, karimUser, { employeeId: karimId, kind: 'advance', amount: '100.5', reason: 'x' })))).toMatch(/whole dinars/);
    await as(karimUser, (tx) => advances.submit(tx, karimUser, made.advanceNo));
    expect(await rejection(as(karimUser, (tx) => advances.endorse(tx, karimUser, made.advanceNo)))).toMatch(/somebody else endorses it/);
    expect(await rejection(as(manager, (tx) => advances.approve(tx, manager, made.advanceNo)))).toMatch(/cannot become approved/);
    await as(bossUser, (tx) => advances.endorse(tx, bossUser, made.advanceNo, 'Agreed'));
    expect(await rejection(as(bossUser, (tx) => advances.approve(tx, bossUser, made.advanceNo)))).toBeTruthy();
    expect(await rejection(ownerPool.query(`update employee_advance set approved_by = endorsed_by, status = 'approved' where advance_no = $1`, [made.advanceNo]))).toMatch(
      /employee_advance_approver_not_requester/,
    );
    await as(manager, (tx) => advances.approve(tx, manager, made.advanceNo));
    await as(manager, (tx) => advances.pay(tx, manager, made.advanceNo, { bankCashAccountId: world.bankAccountId, on: '2026-07-25', reference: 'TRF-77' }));
    expect(await advanceRow(made.advanceNo)).toMatchObject({ status: 'paid', recovered: '0.0000' });
    expect(await balance('employee_advance')).toBe('600000.0000');
    expect(await balance('bank')).toBe('9400000.0000');
    const detail = (await as(karimUser, (tx) => advances.byNo(tx, made.advanceNo)))!;
    expect(detail.months.map((m) => [m.month, m.instalmentIqd])).toEqual([
      ['2026-08-01', '200000.0000'],
      ['2026-09-01', '200000.0000'],
      ['2026-10-01', '200000.0000'],
    ]);
  });
});

describe('H6 · recovered from the pay until nothing is owed', () => {
  it('takes each month’s instalment, catches a missed month up, gives back what a reversed run took, and settles', async () => {
    const advanceNo = await paidLoan();
    // August's payroll was never run: September takes August's and September's.
    const september = await postedRun('2026-09');
    expect(await advanceOn(september)).toBe('400000.0000');
    expect(await advanceRow(advanceNo)).toMatchObject({ status: 'paid', recovered: '400000.0000' });
    expect(await balance('employee_advance')).toBe('200000.0000');

    // Reversed, the run gives its recovery back.
    await as(manager, (tx) => payroll.reverse(tx, manager, september, 'Rerun with the overtime'));
    expect(await advanceRow(advanceNo)).toMatchObject({ status: 'paid', recovered: '0.0000' });
    expect(await balance('employee_advance')).toBe('600000.0000');
    const { rows: recoveries } = await ownerPool.query(`select source, amount_iqd::text as amount from employee_advance_recovery order by recorded_at`);
    expect(recoveries).toEqual([
      { source: 'payroll', amount: '400000.0000' },
      { source: 'payroll_reversal', amount: '-400000.0000' },
    ]);

    const again = await postedRun('2026-09');
    expect(await advanceOn(again)).toBe('400000.0000');
    // Cash may settle what remains — never more (H6).
    expect(await rejection(as(manager, (tx) => advances.repayInCash(tx, manager, advanceNo, { amount: '250000', bankCashAccountId: world.bankAccountId, on: '2026-10-01' })))).toMatch(
      /200000\.0000 IQD still owed; 250000\.0000 IQD is more than remains/,
    );
    const repaid = await as(manager, (tx) => advances.repayInCash(tx, manager, advanceNo, { amount: '200000', bankCashAccountId: world.bankAccountId, on: '2026-10-01', reference: 'CV-11' }));
    expect(repaid.status).toBe('settled');
    expect(await advanceRow(advanceNo)).toMatchObject({ status: 'settled', recovered: '600000.0000' });
    expect(await balance('employee_advance')).toBe('0.0000');
    // Settled, the next payroll takes nothing.
    const october = await as(hr, (tx) => payroll.create(tx, hr, { branchCode: BAGHDAD, month: '2026-10' }));
    expect(await advanceOn(october.runNo)).toBeNull();
  });

  it('the morning sweep raises a loan behind its schedule once a month', async () => {
    const advanceNo = await paidLoan();
    const sweep = (asOf: string) => as(hr, (tx) => hrSweep.run(tx, hr.principal, asOf));
    const first = await sweep('2026-10-02');
    expect(first.advancesBehind).toBe(1);
    const { rows } = await ownerPool.query(`select count(*)::int as n from notification where event_type = 'hr.advance_behind' and object_id = $1`, [advanceNo]);
    expect(rows[0].n).toBeGreaterThan(0);
    const before = rows[0].n as number;
    await sweep('2026-10-03');
    const { rows: after } = await ownerPool.query(`select count(*)::int as n from notification where event_type = 'hr.advance_behind' and object_id = $1`, [advanceNo]);
    expect(after[0].n).toBe(before);
    const detail = (await as(manager, (tx) => advances.byNo(tx, advanceNo)))!;
    expect(detail.behind).toMatchObject({ since: '2026-08-01' });
  });
});

describe('§10 · equipment and the clearance', () => {
  it('hands out and takes back with the condition each way; a leaver’s clearance is what is out and what is owed', async () => {
    const laptop = await as(hr, (tx) => equipment.handOut(tx, hr, karimId, { kind: 'item', description: 'Laptop Dell 5420', serialNo: 'SN-5420-77', handedOutOn: '2026-09-01', condition: 'New' }));
    await as(hr, (tx) => equipment.handOut(tx, hr, karimId, { kind: 'item', description: 'Phone', handedOutOn: '2026-09-01' }));
    expect(await rejection(as(hr, (tx) => equipment.handOut(tx, hr, karimId, { kind: 'item', handedOutOn: '2026-09-01' })))).toMatch(/description/);
    await paidLoan('300000', 1, '2026-12');
    expect(await as(hr, (tx) => equipment.clearanceOf(tx, karimId))).toEqual({ assetsOut: 2, advancesOwedIqd: '300000.0000', clear: false });

    await as(hr, (tx) => equipment.returnAsset(tx, hr, laptop.id, { returnedOn: '2026-09-30', condition: 'Scratched lid' }));
    expect(await rejection(as(hr, (tx) => equipment.returnAsset(tx, hr, laptop.id, { returnedOn: '2026-09-30' })))).toMatch(/came back on 2026-09-30/);
    const held = await as(hr, (tx) => equipment.ofEmployee(tx, karimId));
    expect(held.map((h) => [h.description, h.returnedOn, h.returnCondition])).toEqual([
      ['Phone', null, null],
      ['Laptop Dell 5420', '2026-09-30', 'Scratched lid'],
    ]);
    // The officer keeps the register; nobody without the grant hands anything out.
    expect(await rejection(as(karimUser, (tx) => equipment.handOut(tx, karimUser, karimId, { kind: 'item', description: 'Chair', handedOutOn: '2026-09-01' })))).toBeTruthy();
  });
});
