/**
 * REQ-FIX-001 FIX-5 — HR structure and the user link.
 *
 *   FX13  a new user is an employee unless unticked: one transaction, linked,
 *         numbered from the branch's series, hired today, history and audit;
 *         unticked, only a sign-in; no branch or no department is refused
 *         and nothing is made.
 *   FX14  the backfill makes one employee per active user and never two;
 *         an inactive user is passed over; a user with no department is put
 *         in the first active one and the history says so.
 *   FX16  a position's code is minted; the Departments and Positions
 *         registers count the people the reader may see.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as employees from '@/server/services/employees';
import * as hrSettings from '@/server/services/hr-settings';
import * as structure from '@/server/services/hr-structure';
import * as users from '@/server/services/users';
import { businessToday } from '@/server/domain/business-date';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BRANCH = 'HQ';
let admin: ActorContext;
let hr: ActorContext;

async function userWith(roles: string[], departments: string[] = []): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [id, `${id}@example.com`, roles.join('+')]);
  for (const role of roles) await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code, is_default) values ($1,$2,true)`, [id, BRANCH]);
  for (const code of departments) await ownerPool.query(`insert into user_department_scope (user_id, department_code) values ($1,$2)`, [id, code]);
  const principal = await withScope({ userId: id, branchCode: BRANCH }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BRANCH };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BRANCH });
const employeeOf = async (userId: string) =>
  (await ownerPool.query(`select employee_no, branch_code, department_code, position_code, hire_date::text, status, created_by from employee where app_user_id = $1`, [userId])).rows;

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BRANCH, 'Head Office');
  await seedBranch('ERB', 'Erbil');
  await ownerPool.query(`insert into department (code, name, is_finance) values ('FIN','Finance',true), ('OPS','Operations',false) on conflict do nothing`);
  admin = await userWith(['system_administrator']);
  hr = await userWith(['hr_manager']);
});

describe('FX13 · a new user is an employee unless unticked', () => {
  it('ticked: the user and the employee in one transaction, linked, hired today, with history and audit', async () => {
    const made = await withScope(scope(admin), (tx) =>
      users.create(tx, admin, { email: 'sara@example.com', displayName: 'Sara Ahmed', branchCodes: [BRANCH], departmentCodes: ['OPS', 'FIN'], employee: {} }),
    );
    expect(made.employeeNo).toMatch(/^EMP-HQ-\d+$/);
    const [row] = await employeeOf(made.id);
    expect(row).toMatchObject({ employee_no: made.employeeNo, branch_code: BRANCH, department_code: 'OPS', hire_date: businessToday(), status: 'active', created_by: admin.principal.userId });

    const { rows: history } = await ownerPool.query(`select field, after_value from employee_history h join employee e on e.id = h.employee_id where e.app_user_id = $1 order by field`, [made.id]);
    expect(history.map((entry) => entry.field)).toEqual(['branch_code', 'department_code', 'employment_kind', 'hired', 'status']);
    const { rows: audit } = await ownerPool.query(`select action from audit_event where object_id in ($1, $2) order by action`, [made.employeeNo, made.id]);
    expect(audit.map((entry) => entry.action)).toEqual(['app_user.created', 'employee.created']);

    // The person is found from the account.
    expect(await withScope(scope(admin), (tx) => employees.ofUser(tx, made.id))).toMatchObject({ employeeNo: made.employeeNo, fullNameEn: 'Sara Ahmed' });
  });

  it('the employee department and position chosen on the form win over the first department ticked', async () => {
    const seat = await withScope(scope(hr), (tx) => hrSettings.createPosition(tx, hr, { titleEn: 'Accountant', departmentCode: 'FIN' }));
    const made = await withScope(scope(admin), (tx) =>
      users.create(tx, admin, { email: 'omar@example.com', displayName: 'Omar', branchCodes: [BRANCH], departmentCodes: ['OPS'], employee: { departmentCode: 'FIN', positionCode: seat.code } }),
    );
    expect((await employeeOf(made.id))[0]).toMatchObject({ department_code: 'FIN', position_code: seat.code });
  });

  it('unticked: only a sign-in', async () => {
    const made = await withScope(scope(admin), (tx) => users.create(tx, admin, { email: 'audit@example.com', displayName: 'External auditor', branchCodes: [BRANCH], departmentCodes: ['FIN'] }));
    expect(made.employeeNo).toBeNull();
    expect(await employeeOf(made.id)).toEqual([]);
  });

  it('no branch, or no department, is refused — and neither the user nor the employee is made', async () => {
    expect(await rejection(withScope(scope(admin), (tx) => users.create(tx, admin, { email: 'nob@example.com', displayName: 'No branch', departmentCodes: ['FIN'], employee: {} })))).toMatch(
      /works at a branch/,
    );
    expect(await rejection(withScope(scope(admin), (tx) => users.create(tx, admin, { email: 'nod@example.com', displayName: 'No department', branchCodes: [BRANCH], employee: {} })))).toMatch(
      /belongs to a department/,
    );
    const { rows } = await ownerPool.query(`select email from app_user where email in ('nob@example.com', 'nod@example.com')`);
    expect(rows).toEqual([]);
  });

  it('a branch the creator does not work in is said in words, and nothing is made', async () => {
    expect(
      await rejection(
        withScope(scope(admin), (tx) => users.create(tx, admin, { email: 'erb@example.com', displayName: 'Erbil person', branchCodes: ['ERB'], departmentCodes: ['OPS'], employee: {} })),
      ),
    ).toMatch(/kept in branch ERB, which you do not work in/);
    expect((await ownerPool.query(`select 1 from app_user where email = 'erb@example.com'`)).rows).toEqual([]);
  });
});

describe('FX14 · the backfill', () => {
  it('one employee per active user, never two, the inactive passed over, an assumed department said', async () => {
    const before = (await ownerPool.query(`select count(*)::int as n from app_user u where u.is_active and not exists (select 1 from employee e where e.app_user_id = u.id)`)).rows[0].n;
    const withDept = await userWith(['accounting_officer'], ['FIN']);
    const inactive = await userWith(['accounting_officer'], ['FIN']);
    await ownerPool.query(`update app_user set is_active = false where id = $1`, [inactive.principal.userId]);

    const first = await withScope(scope(admin), (tx) => employees.ensureForUsers(tx, admin));
    expect(first.made).toHaveLength(before + 1);
    expect(first.skipped).toEqual([]);
    expect((await employeeOf(withDept.principal.userId))[0]).toMatchObject({ department_code: 'FIN', branch_code: BRANCH });
    expect(await employeeOf(inactive.principal.userId)).toEqual([]);

    // The admin and the HR manager had no department: the first active one, said in the history.
    const assumed = first.made.find((entry) => entry.email === `${admin.principal.userId}@example.com`)!;
    expect(assumed).toMatchObject({ departmentCode: 'FIN', departmentAssumed: true });
    const { rows: reason } = await ownerPool.query(`select h.reason from employee_history h join employee e on e.id = h.employee_id where e.employee_no = $1 and h.field = 'hired'`, [
      assumed.employeeNo,
    ]);
    expect(reason[0].reason).toMatch(/had no department, so FIN until HR moves the person/);

    // Never two.
    const second = await withScope(scope(admin), (tx) => employees.ensureForUsers(tx, admin));
    expect(second.made).toEqual([]);
    const { rows: counts } = await ownerPool.query(`select app_user_id, count(*)::int as n from employee where app_user_id is not null group by app_user_id having count(*) > 1`);
    expect(counts).toEqual([]);
  });
});

describe('FX16 · departments and positions', () => {
  it('a position is minted a code, and the registers count holders, seats and vacancies', async () => {
    const head = await withScope(scope(hr), (tx) => hrSettings.createPosition(tx, hr, { titleEn: 'Head of Finance', departmentCode: 'FIN' }));
    const clerk = await withScope(scope(hr), (tx) => hrSettings.createPosition(tx, hr, { titleEn: 'Clerk', departmentCode: 'FIN', reportsToCode: head.code }));
    expect(head.code).toMatch(/^POS-\d{4}$/);
    expect(clerk.code).not.toBe(head.code);

    await withScope(scope(admin), (tx) =>
      users.create(tx, admin, { email: 'head@example.com', displayName: 'Head', branchCodes: [BRANCH], departmentCodes: ['FIN'], employee: { positionCode: head.code } }),
    );

    const departments = await withScope(scope(hr), (tx) => structure.departments(tx));
    expect(departments.find((row) => row.code === 'FIN')).toMatchObject({ headcount: 1, seats: 2, vacant: 1 });
    const detail = await withScope(scope(hr), (tx) => structure.departmentByCode(tx, 'FIN'));
    expect(detail!.seats.map((seat) => [seat.code, seat.depth, seat.holders.length])).toEqual([
      [head.code, 0, 1],
      [clerk.code, 1, 0],
    ]);
    const seat = await withScope(scope(hr), (tx) => structure.positionByCode(tx, head.code));
    expect(seat!.row).toMatchObject({ holders: 1, departmentName: 'Finance' });
    expect(seat!.reports.map((r) => r.code)).toEqual([clerk.code]);
    expect(await withScope(scope(hr), (tx) => structure.positionByCode(tx, 'POS-9999'))).toBeNull();
  });
});
