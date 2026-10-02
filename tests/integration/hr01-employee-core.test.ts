/**
 * REQ-HR-001 Stage HR-1 — the employee record (H1, H2, H8).
 *
 *   H1  creating an employee allocates EMP-…, writes the first history
 *       rows; every change of department, manager, position, kind or
 *       status is a new dated row; UPDATE on history raises.
 *   H2  compensation is invisible to a role without the grant: the service
 *       refuses and writes the denial, the database returns no row.
 *   H8  the settings masters write their audit in the same transaction and
 *       are deactivated, never deleted.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import { employeeCompensation } from '@/server/db/schema';
import * as authz from '@/server/services/authorization';
import * as employees from '@/server/services/employees';
import * as settings from '@/server/services/hr-settings';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BRANCH = 'BGW';
let manager: ActorContext;
let officer: ActorContext;
let accountant: ActorContext;

async function createUser(branch: string, ...roles: string[]): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [id, `${id}@example.com`, `User ${roles.join('+')}`]);
  for (const role of roles) await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, branch]);
  await ownerPool.query(`insert into user_department_scope (user_id, department_code) values ($1,'FIN') on conflict do nothing`, [id]);
  const principal = await withScope({ userId: id, branchCode: branch }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: branch };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: ctx.branchCode });
const as = <T,>(ctx: ActorContext, work: (tx: Parameters<Parameters<typeof withScope>[1]>[0]) => Promise<T>) => withScope(scope(ctx), work);

beforeAll(async () => {
  await resetTestData();
  await seedBranch(BRANCH, 'Baghdad');
  await ownerPool.query(`insert into department (code, name, is_finance) values ('FIN','Finance',true) on conflict do nothing`);
  await ownerPool.query(`insert into department (code, name, is_finance) values ('OPS','Operations',false) on conflict do nothing`);
  manager = await createUser(BRANCH, 'hr_manager');
  officer = await createUser(BRANCH, 'hr_officer');
  accountant = await createUser(BRANCH, 'accounting_manager');
});

describe('H1 · the employee record', () => {
  let gm: { id: string; employeeNo: string };
  let clerk: { id: string; employeeNo: string };

  it('allocates EMP-{BRANCH}-{SERIAL} and writes the first history rows', async () => {
    await as(manager, (tx) => settings.createPosition(tx, manager, { code: 'GM', titleEn: 'General Manager', departmentCode: 'OPS' }));
    await as(manager, (tx) => settings.createPosition(tx, manager, { code: 'CLERK', titleEn: 'Clerk', departmentCode: 'FIN', reportsToCode: 'GM' }));
    gm = await as(manager, (tx) => employees.create(tx, manager, { fullNameEn: 'General Manager', departmentCode: 'OPS', positionCode: 'GM', hireDate: '2024-01-01', employmentKind: 'permanent' }));
    expect(gm.employeeNo).toBe(`EMP-${BRANCH}-0001`);
    clerk = await as(officer, (tx) =>
      employees.create(tx, officer, { fullNameEn: 'Clerk One', fullNameAr: 'كاتب', departmentCode: 'FIN', positionCode: 'CLERK', managerEmployeeId: gm.id, hireDate: '2025-03-15', employmentKind: 'contract', phone: '0770' }),
    );
    expect(clerk.employeeNo).toBe(`EMP-${BRANCH}-0002`);
    const history = await as(manager, (tx) => employees.historyOf(tx, clerk.id));
    expect(history.map((h) => `${h.field}=${h.afterValue}`).sort()).toEqual(
      ['branch_code=BGW', 'department_code=FIN', 'employment_kind=contract', 'hired=2025-03-15', `manager_employee_id=${gm.id}`, 'position_code=CLERK', 'status=active'].sort(),
    );
    expect(history.every((h) => h.effectiveFrom === '2025-03-15')).toBe(true);
    const audit = await ownerPool.query(`select count(*)::int as n from audit_event where action = 'employee.created' and object_id = $1`, [clerk.employeeNo]);
    expect(audit.rows[0].n).toBe(1);
  });

  it('refuses a manager who is themselves, or who has left; refuses an unknown department', async () => {
    expect(await rejection(as(manager, (tx) => employees.move(tx, manager, gm.id, { managerEmployeeId: gm.id })))).toMatch(/own manager/);
    expect(await rejection(as(manager, (tx) => employees.create(tx, manager, { fullNameEn: 'X', departmentCode: 'NOPE', hireDate: '2026-01-01', employmentKind: 'daily' })))).toMatch(/names no department/);
    expect(await rejection(as(manager, (tx) => employees.create(tx, manager, { fullNameEn: 'X', departmentCode: 'FIN', hireDate: '2026-13-01', employmentKind: 'daily' })))).toMatch(/YYYY-MM-DD/);
  });

  it('writes a dated row for every move, and none for a move that changes nothing', async () => {
    const changed = await as(officer, (tx) =>
      employees.move(tx, officer, clerk.id, { effectiveFrom: '2026-06-01', reason: 'Promotion', departmentCode: 'OPS', positionCode: 'GM', employmentKind: 'permanent' }),
    );
    expect(changed).toBe(3);
    const none = await as(officer, (tx) => employees.move(tx, officer, clerk.id, { effectiveFrom: '2026-06-02', departmentCode: 'OPS', positionCode: 'GM', employmentKind: 'permanent', managerEmployeeId: gm.id }));
    expect(none).toBe(0);
    const history = await as(manager, (tx) => employees.historyOf(tx, clerk.id));
    const june = history.filter((h) => h.effectiveFrom === '2026-06-01');
    expect(june.map((h) => `${h.field}:${h.beforeValue}>${h.afterValue}`).sort()).toEqual(['department_code:FIN>OPS', 'employment_kind:contract>permanent', 'position_code:CLERK>GM']);
    expect(june.every((h) => h.reason === 'Promotion')).toBe(true);
    const row = await as(manager, (tx) => employees.byNo(tx, clerk.employeeNo));
    expect(row).toMatchObject({ departmentCode: 'OPS', positionCode: 'GM', employmentKind: 'permanent', managerName: 'General Manager' });
  });

  it('identity corrections are audited, not history', async () => {
    const before = (await as(manager, (tx) => employees.historyOf(tx, clerk.id))).length;
    await as(officer, (tx) => employees.updateIdentity(tx, officer, clerk.id, { fullNameEn: 'Clerk One Corrected', phone: '0780' }));
    const after = (await as(manager, (tx) => employees.historyOf(tx, clerk.id))).length;
    expect(after).toBe(before);
    const row = await as(manager, (tx) => employees.byNo(tx, clerk.employeeNo));
    expect(row?.fullNameEn).toBe('Clerk One Corrected');
    const audit = await ownerPool.query(`select count(*)::int as n from audit_event where action = 'employee.identity_updated' and object_id = $1`, [clerk.employeeNo]);
    expect(audit.rows[0].n).toBe(1);
  });

  it('a history row cannot be changed or removed, even by the owner', async () => {
    const { rows } = await ownerPool.query(`select id from employee_history limit 1`);
    await expect(ownerPool.query(`update employee_history set reason = 'x' where id = $1`, [rows[0].id])).rejects.toThrow(/append-only/);
    await expect(ownerPool.query(`delete from employee_history where id = $1`, [rows[0].id])).rejects.toThrow(/append-only/);
  });

  it('suspends, reinstates and ends with dated rows; an ended employee cannot be a manager or move', async () => {
    expect(await rejection(as(officer, (tx) => employees.setStatus(tx, officer, clerk.id, { status: 'suspended', reason: 'x' })))).toMatch(/Permission denied/);
    await as(manager, (tx) => employees.setStatus(tx, manager, clerk.id, { status: 'suspended', effectiveFrom: '2026-07-01', reason: 'Investigation' }));
    await as(manager, (tx) => employees.setStatus(tx, manager, clerk.id, { status: 'active', effectiveFrom: '2026-07-10' }));
    expect(await rejection(as(manager, (tx) => employees.setStatus(tx, manager, clerk.id, { status: 'ended', effectiveFrom: '2026-08-01' })))).toMatch(/say why/);
    await as(manager, (tx) => employees.setStatus(tx, manager, clerk.id, { status: 'ended', effectiveFrom: '2026-08-01', reason: 'Resigned' }));
    const row = await as(manager, (tx) => employees.byNo(tx, clerk.employeeNo));
    expect(row).toMatchObject({ status: 'ended', endDate: '2026-08-01', endReason: 'Resigned' });
    const history = await as(manager, (tx) => employees.historyOf(tx, clerk.id));
    expect(history.filter((h) => h.field === 'status').map((h) => `${h.effectiveFrom}:${h.beforeValue ?? '-'}>${h.afterValue}`)).toEqual([
      '2026-08-01:active>ended',
      '2026-07-10:suspended>active',
      '2026-07-01:active>suspended',
      '2025-03-15:->active',
    ]);
    expect(history.find((h) => h.field === 'ended')?.afterValue).toBe('2026-08-01');
    expect(await rejection(as(manager, (tx) => employees.move(tx, manager, gm.id, { managerEmployeeId: clerk.id })))).toMatch(/left the company/);
    expect(await rejection(as(manager, (tx) => employees.move(tx, manager, clerk.id, { departmentCode: 'FIN' })))).toMatch(/left the company/);
  });

  it('links a sign-in once, and the linked person reads their own record', async () => {
    await as(manager, (tx) => employees.linkUser(tx, manager, gm.id, officer.principal.userId));
    expect(await rejection(as(manager, (tx) => employees.linkUser(tx, manager, clerk.id, officer.principal.userId)))).toMatch(/already linked/);
    const row = await as(manager, (tx) => employees.byNo(tx, gm.employeeNo));
    expect(row?.appUserId).toBe(officer.principal.userId);
    await as(manager, (tx) => employees.linkUser(tx, manager, gm.id, null));
    expect((await as(manager, (tx) => employees.byNo(tx, gm.employeeNo)))?.appUserId).toBeNull();
  });

  it('draws the organisation from the rows', async () => {
    const tree = await as(officer, (tx) => employees.organisation(tx));
    const ops = tree.find((d) => d.departmentCode === 'OPS')!;
    expect(ops.headcount).toBe(1);
    expect(ops.positions.map((p) => [p.code, p.depth, p.holders.map((h) => h.employeeNo)])).toEqual([['GM', 0, [gm.employeeNo]]]);
    const fin = tree.find((d) => d.departmentCode === 'FIN')!;
    expect(fin.positions.map((p) => [p.code, p.depth])).toEqual([['CLERK', 0]]);
    expect(fin.headcount).toBe(0);
  });
});

describe('H2 · compensation is its own grant', () => {
  let person: { id: string; employeeNo: string };

  it('the HR manager records a dated row; the history says only that it changed', async () => {
    person = await as(manager, (tx) => employees.create(tx, manager, { fullNameEn: 'Paid Person', departmentCode: 'FIN', hireDate: '2026-01-01', employmentKind: 'permanent' }));
    await as(manager, (tx) => employees.setCompensation(tx, manager, person.id, { effectiveFrom: '2026-01-01', baseSalaryIqd: '1500000', payMethod: 'cash' }));
    expect(await rejection(as(manager, (tx) => employees.setCompensation(tx, manager, person.id, { effectiveFrom: '2026-02-01', baseSalaryIqd: '1600000', payMethod: 'bank' })))).toMatch(/name the bank/);
    await as(manager, (tx) => employees.setCompensation(tx, manager, person.id, { effectiveFrom: '2026-02-01', baseSalaryIqd: '1600000', payMethod: 'cash', note: 'Review' }));
    const rows = await as(manager, (tx) => employees.compensationOf(tx, manager, person.id));
    expect(rows.map((r) => [r.effectiveFrom, r.baseSalaryIqd])).toEqual([
      ['2026-02-01', '1600000.0000'],
      ['2026-01-01', '1500000.0000'],
    ]);
    const history = await as(officer, (tx) => employees.historyOf(tx, person.id));
    const salary = history.filter((h) => h.field === 'base_salary_iqd');
    expect(salary).toHaveLength(2);
    expect(salary.every((h) => h.beforeValue === null && h.afterValue === null)).toBe(true);
  });

  it('the HR officer is refused by the service, the refusal is written, and the database returns no row', async () => {
    expect(await rejection(as(officer, (tx) => employees.compensationOf(tx, officer, person.id)))).toMatch(/Permission denied/);
    const denial = await ownerPool.query(`select count(*)::int as n from audit_event where outcome = 'denied' and actor_user_id = $1 and object_type = 'employee_compensation'`, [officer.principal.userId]);
    expect(denial.rows[0].n).toBeGreaterThan(0);
    // Straight at the table, under the officer's scope: the policy hides every row.
    const seen = await as(officer, (tx) => tx.select({ id: employeeCompensation.id }).from(employeeCompensation));
    expect(seen).toEqual([]);
    const asManager = await as(manager, (tx) => tx.select({ id: employeeCompensation.id }).from(employeeCompensation));
    expect(asManager).toHaveLength(2);
    // The accounting manager reads but does not write (D-HR-7).
    const asAccountant = await as(accountant, (tx) => employees.compensationOf(tx, accountant, person.id));
    expect(asAccountant).toHaveLength(2);
    expect(await rejection(as(accountant, (tx) => employees.setCompensation(tx, accountant, person.id, { effectiveFrom: '2026-03-01', baseSalaryIqd: '1', payMethod: 'cash' })))).toMatch(/Permission denied/);
    expect(await rejection(as(officer, (tx) => employees.setCompensation(tx, officer, person.id, { effectiveFrom: '2026-03-01', baseSalaryIqd: '1', payMethod: 'cash' })))).toMatch(/Permission denied/);
  });

  it('a compensation row cannot be changed or removed', async () => {
    const { rows } = await ownerPool.query(`select id from employee_compensation limit 1`);
    await expect(ownerPool.query(`update employee_compensation set base_salary_iqd = 1 where id = $1`, [rows[0].id])).rejects.toThrow(/append-only/);
    await expect(ownerPool.query(`delete from employee_compensation where id = $1`, [rows[0].id])).rejects.toThrow(/append-only/);
  });
});

describe('H8 · the settings are master data, deactivated never deleted', () => {
  it('positions, components, leave types and calendars are rows with their audit', async () => {
    expect(await rejection(as(officer, (tx) => settings.createPayComponent(tx, officer, { code: 'BONUS', nameEn: 'Bonus', kind: 'earning', calculation: 'manual', taxable: true })))).toMatch(/Permission denied/);
    await as(manager, (tx) => settings.createPayComponent(tx, manager, { code: 'BONUS', nameEn: 'Bonus', kind: 'earning', calculation: 'manual', taxable: true }));
    expect(await rejection(as(manager, (tx) => settings.createPayComponent(tx, manager, { code: 'BONUS', nameEn: 'Bonus', kind: 'earning', calculation: 'manual', taxable: true })))).toMatch(/already a pay component/);
    expect(await rejection(as(manager, (tx) => settings.createPayComponent(tx, manager, { code: 'PCT', nameEn: 'x', kind: 'deduction', calculation: 'percent_of_base', defaultValue: '150', taxable: false })))).toMatch(/cannot exceed 100/);
    expect(await rejection(as(manager, (tx) => settings.setPayComponentActive(tx, manager, 'BONUS', false)))).toMatch(/say why/);
    await as(manager, (tx) => settings.setPayComponentActive(tx, manager, 'BONUS', false, 'Not used'));
    const components = await as(officer, (tx) => settings.payComponents(tx));
    expect(components.find((c) => c.code === 'BONUS')?.active).toBe(false);
    // The seeded statutory components are there for HR-3 (D-HR-3).
    expect(components.map((c) => c.code)).toEqual(expect.arrayContaining(['BASE', 'SS_EMPLOYEE', 'SS_EMPLOYER', 'INCOME_TAX']));

    await as(manager, (tx) => settings.createLeaveType(tx, manager, { code: 'STUDY', nameEn: 'Study leave', daysPerYear: '5', paid: false, requiresAttachment: true }));
    expect(await rejection(as(manager, (tx) => settings.createLeaveType(tx, manager, { code: 'BAD', nameEn: 'x', daysPerYear: 'ten', paid: true, requiresAttachment: false })))).toMatch(/number of days/);
    await as(manager, (tx) => settings.setLeaveTypeActive(tx, manager, 'STUDY', false, 'Policy withdrawn'));

    await as(manager, (tx) => settings.createCalendar(tx, manager, { code: 'IQ-2027', nameEn: 'Iraq 2027', year: '2027', workingDays: 'sun, mon,tue,wed,thu,funday' }));
    const calendar = (await as(officer, (tx) => settings.calendars(tx))).find((c) => c.code === 'IQ-2027')!;
    expect(calendar.workingDays).toBe('sun,mon,tue,wed,thu');
    await as(manager, (tx) => settings.addHoliday(tx, manager, 'IQ-2027', { holidayDate: '2027-01-01', nameEn: 'New Year' }));
    expect(await rejection(as(manager, (tx) => settings.addHoliday(tx, manager, 'IQ-2027', { holidayDate: '2026-01-01', nameEn: 'Wrong year' })))).toMatch(/fall in 2027/);
    expect(await rejection(as(manager, (tx) => settings.addHoliday(tx, manager, 'IQ-2027', { holidayDate: '2027-01-01', nameEn: 'Twice' })))).toMatch(/already a holiday/);
    await as(manager, (tx) => settings.removeHoliday(tx, manager, 'IQ-2027', '2027-01-01'));

    const audit = await ownerPool.query(
      `select action from audit_event where action in ('pay_component.created','pay_component.deactivated','leave_type.created','leave_type.deactivated','working_calendar.created','working_calendar.holiday_added','working_calendar.holiday_removed','position.created') order by action`,
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'leave_type.created',
      'leave_type.deactivated',
      'pay_component.created',
      'pay_component.deactivated',
      'position.created',
      'position.created',
      'working_calendar.created',
      'working_calendar.holiday_added',
      'working_calendar.holiday_removed',
    ]);
    const deletes = await ownerPool.query(
      `select table_name from information_schema.role_table_grants where grantee = 'erp_app' and privilege_type = 'DELETE' and table_name in ('employee','employee_history','employee_compensation','position','pay_component','leave_type','working_calendar')`,
    );
    expect(deletes.rows).toEqual([]);
  });
});
