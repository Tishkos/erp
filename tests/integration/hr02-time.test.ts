/**
 * REQ-HR-001 Stage HR-2 — time: leave and attendance, against the database.
 *
 *   H3  leave counted on the year's calendar, refused past the balance with
 *       the balance named, a sick note required, a type that may borrow
 *   H4  decided by the person's manager (by the link) or the HR manager —
 *       never by whoever asked, never by the person; refused with a note;
 *       a granted leave cancelled only by the HR manager, its days returned
 *   H4b a person with a sign-in asks for their own leave (R5)
 *   H4c the day sheet: present or absent with times, corrected with the
 *       change audited, never over a leave; the month reads leave over the
 *       sheet over the calendar; payroll's summary counts paid and unpaid
 *   H4d the sweep: a contract ending, a request waiting, annual leave that
 *       will lapse — each raised once
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as attachments from '@/server/services/attachments';
import * as attendance from '@/server/services/attendance';
import * as authz from '@/server/services/authorization';
import * as employees from '@/server/services/employees';
import * as hrSweep from '@/server/services/hr-sweep';
import * as leave from '@/server/services/leave';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BRANCH = 'HQ';
let hrOfficer: ActorContext;
let hrManager: ActorContext;
let boss: ActorContext;
let staff: ActorContext;
let bossEmployeeId = '';
let staffEmployeeId = '';
let otherEmployeeId = '';

async function userWith(roles: string[]): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [id, `${id}@example.com`, roles.join('+') || 'Staff']);
  for (const role of roles) await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code, is_default) values ($1,$2,true)`, [id, BRANCH]);
  const principal = await withScope({ userId: id, branchCode: BRANCH }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BRANCH };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BRANCH });
const as = <T>(ctx: ActorContext, fn: (tx: Parameters<Parameters<typeof withScope>[1]>[0]) => Promise<T>) => withScope(scope(ctx), fn);

async function hire(name: string, managerEmployeeId: string | null = null, extra: Partial<employees.EmployeeInput> = {}): Promise<string> {
  const made = await as(hrOfficer, (tx) =>
    employees.create(tx, hrOfficer, { fullNameEn: name, departmentCode: 'OPS', hireDate: '2024-01-01', employmentKind: 'permanent', managerEmployeeId, ...extra }),
  );
  return made.id;
}

const notificationsOf = async (userId: string, eventType: string) =>
  (await ownerPool.query(`select subject from notification where recipient_user_id = $1 and event_type = $2`, [userId, eventType])).rows.map((r) => r.subject as string);

async function ask(ctx: ActorContext, employeeId: string, leaveTypeCode: string, fromDate: string, toDate: string, extra: Partial<leave.LeaveInput> = {}) {
  return as(ctx, (tx) => leave.create(tx, ctx, { employeeId, leaveTypeCode, fromDate, toDate, ...extra }));
}

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BRANCH, 'Head Office');
  await ownerPool.query(`insert into department (code, name) values ('OPS','Operations') on conflict do nothing`);
  hrOfficer = await userWith(['hr_officer']);
  hrManager = await userWith(['hr_manager']);
  boss = await userWith([]);
  staff = await userWith([]);
  bossEmployeeId = await hire('Boss');
  staffEmployeeId = await hire('Staff Member', bossEmployeeId);
  otherEmployeeId = await hire('Other Member', bossEmployeeId, { employmentKind: 'contract', contractEndDate: '2026-10-20' });
  await ownerPool.query(`update employee set app_user_id = $1 where id = $2`, [boss.principal.userId, bossEmployeeId]);
  await ownerPool.query(`update employee set app_user_id = $1 where id = $2`, [staff.principal.userId, staffEmployeeId]);
  const files = new Map<string, Buffer>();
  attachments.registerStorage({ put: async (key, content) => void files.set(key, content), get: async (key) => files.get(key) ?? null });
  attachments.registerScanner(() => ({ status: 'clean' }));
});

describe('H3 · counted on the calendar, held to the balance', () => {
  it('Sunday 11 to Thursday 22 October is ten days: the weekend between is not taken', async () => {
    const made = await ask(hrOfficer, staffEmployeeId, 'ANNUAL', '2026-10-11', '2026-10-22');
    const { rows } = await ownerPool.query(`select request_no, days::text, status from leave_request where id = $1`, [made.id]);
    expect(rows[0]).toMatchObject({ days: '10.00', status: 'draft' });
    expect(rows[0].request_no).toMatch(/^LVE-HQ-2026-\d{6}$/);
  });

  it('past the balance is refused with what remains; a type that may borrow lends up to its limit', async () => {
    // Hired 2024: 30 a year, 10 carried twice — 40 in 2026. An adjustment of −37 leaves 3.
    await as(hrManager, (tx) =>
      leave.adjustBalance(tx, hrManager, { employeeId: staffEmployeeId, leaveTypeCode: 'ANNUAL', year: 2026, days: '-37', kind: 'adjustment', reason: 'Taken before the system' }),
    );
    const [annual] = (await as(hrOfficer, (tx) => leave.balances(tx, staffEmployeeId, 2026))).filter((b) => b.leaveTypeCode === 'ANNUAL');
    expect(annual).toMatchObject({ carryIn: 1000n, entitlement: 3000n, adjustments: -3700n, balance: 300n });

    const four = await ask(hrOfficer, staffEmployeeId, 'ANNUAL', '2026-11-01', '2026-11-04');
    expect(await rejection(as(hrOfficer, (tx) => leave.submit(tx, hrOfficer, four.id)))).toMatch(/4 days of Annual leave in 2026 asked, 3 remain — at most 3 can be granted/);

    // Unpaid leave has no days a year and is not held to a balance.
    const unpaid = await ask(hrOfficer, bossEmployeeId, 'UNPAID', '2026-11-01', '2026-11-30');
    await as(hrOfficer, (tx) => leave.submit(tx, hrOfficer, unpaid.id));
    // Sick leave: 30 a year and 5 may be borrowed — 35 days are granted, not 36.
    await as(hrManager, (tx) =>
      leave.adjustBalance(tx, hrManager, { employeeId: bossEmployeeId, leaveTypeCode: 'SICK', year: 2026, days: '-29', kind: 'adjustment', reason: 'Taken before the system' }),
    );
    const sick = await ask(hrOfficer, bossEmployeeId, 'SICK', '2026-12-06', '2026-12-14');
    await as(hrOfficer, (tx) => attachments.upload(tx, hrOfficer, { objectType: leave.PERMISSION_OBJECT, objectId: sick.id, fileName: 'note.pdf', content: Buffer.from('%PDF-1.4 note') }));
    expect(await rejection(as(hrOfficer, (tx) => leave.submit(tx, hrOfficer, sick.id)))).toMatch(/7 days of Sick leave in 2026 asked, 1 remain \(and 5 may be borrowed\) — at most 6 can be granted/);
    await as(hrOfficer, (tx) => leave.updateDraft(tx, hrOfficer, sick.id, { leaveTypeCode: 'SICK', fromDate: '2026-12-06', toDate: '2026-12-13' }));
    await as(hrOfficer, (tx) => leave.submit(tx, hrOfficer, sick.id));
  });

  it('a sick note is required before a sick leave is sent; overlapping days are refused', async () => {
    const sick = await ask(hrOfficer, staffEmployeeId, 'SICK', '2026-10-04', '2026-10-05');
    expect(await rejection(as(hrOfficer, (tx) => leave.submit(tx, hrOfficer, sick.id)))).toMatch(/needs its paper \(a sick note\) attached/);
    await as(hrOfficer, (tx) => attachments.upload(tx, hrOfficer, { objectType: leave.PERMISSION_OBJECT, objectId: sick.id, fileName: 'note.pdf', content: Buffer.from('%PDF-1.4 sick note') }));
    await as(hrOfficer, (tx) => leave.submit(tx, hrOfficer, sick.id));

    const clash = await ask(hrOfficer, staffEmployeeId, 'ANNUAL', '2026-10-05', '2026-10-06');
    expect(await rejection(as(hrOfficer, (tx) => leave.submit(tx, hrOfficer, clash.id)))).toMatch(/overlap LVE-HQ-2026-\d{6} \(2026-10-04 to 2026-10-05\)/);
  });

  it('a span with no working day, a span before the hire date or past the contract, is refused', async () => {
    expect(await rejection(ask(hrOfficer, staffEmployeeId, 'ANNUAL', '2026-10-09', '2026-10-10'))).toMatch(/has no working day in it/);
    expect(await rejection(ask(hrOfficer, staffEmployeeId, 'ANNUAL', '2023-12-31', '2024-01-02'))).toMatch(/was hired on 2024-01-01/);
    expect(await rejection(ask(hrOfficer, otherEmployeeId, 'ANNUAL', '2026-10-18', '2026-10-22'))).toMatch(/employment ends on 2026-10-20/);
  });
});

describe('H4 · decided by the manager or the HR manager, never by the asker or the person', () => {
  it('the manager is told, decides by the link; the asker and the person are told', async () => {
    const made = await ask(hrOfficer, staffEmployeeId, 'ANNUAL', '2026-10-11', '2026-10-15');
    await as(hrOfficer, (tx) => leave.submit(tx, hrOfficer, made.id));
    expect(await notificationsOf(boss.principal.userId, 'hr.leave_submitted')).toEqual([expect.stringMatching(/Staff Member asks for 5 days of Annual leave/)]);

    expect(await rejection(as(hrOfficer, (tx) => leave.approve(tx, hrOfficer, made.id)))).toMatch(/cannot decide it \(maker-checker\)/);
    expect(await rejection(as(staff, (tx) => leave.approve(tx, staff, made.id)))).toMatch(/cannot decide their own leave/);
    await as(boss, (tx) => leave.approve(tx, boss, made.id, 'Enjoy'));

    const { rows } = await ownerPool.query(`select status, decided_by, decision_note from leave_request where id = $1`, [made.id]);
    expect(rows[0]).toMatchObject({ status: 'approved', decided_by: boss.principal.userId, decision_note: 'Enjoy' });
    expect(await notificationsOf(hrOfficer.principal.userId, 'hr.leave_approved')).toHaveLength(1);
    expect(await notificationsOf(staff.principal.userId, 'hr.leave_approved')).toHaveLength(1);
    const [annual] = (await as(hrOfficer, (tx) => leave.balances(tx, staffEmployeeId, 2026))).filter((b) => b.leaveTypeCode === 'ANNUAL');
    expect(annual).toMatchObject({ taken: 500n, balance: 3500n });
  });

  it('somebody else, neither the manager nor an HR manager, is refused and the refusal is written', async () => {
    const outsider = await userWith(['accounting_manager']);
    const made = await ask(hrOfficer, staffEmployeeId, 'ANNUAL', '2026-10-11', '2026-10-12');
    await as(hrOfficer, (tx) => leave.submit(tx, hrOfficer, made.id));
    await rejection(as(outsider, (tx) => leave.approve(tx, outsider, made.id)));
    const { rows } = await ownerPool.query(`select count(*)::int as n from audit_event where actor_user_id = $1 and outcome = 'denied'`, [outsider.principal.userId]);
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it('refused with a note; a granted leave cancelled only by the HR manager, its days come back', async () => {
    const one = await ask(hrOfficer, staffEmployeeId, 'ANNUAL', '2026-10-11', '2026-10-12');
    await as(hrOfficer, (tx) => leave.submit(tx, hrOfficer, one.id));
    expect(await rejection(as(hrManager, (tx) => leave.refuse(tx, hrManager, one.id, ' ')))).toMatch(/decision_note/);
    await as(hrManager, (tx) => leave.refuse(tx, hrManager, one.id, 'Stock count that week'));

    const two = await ask(hrOfficer, staffEmployeeId, 'ANNUAL', '2026-10-18', '2026-10-19');
    await as(hrOfficer, (tx) => leave.submit(tx, hrOfficer, two.id));
    await as(hrManager, (tx) => leave.approve(tx, hrManager, two.id));
    expect(await rejection(as(hrOfficer, (tx) => leave.cancel(tx, hrOfficer, two.id, 'Changed plans')))).toBeTruthy();
    await as(hrManager, (tx) => leave.cancel(tx, hrManager, two.id, 'Changed plans'));
    const [annual] = (await as(hrOfficer, (tx) => leave.balances(tx, staffEmployeeId, 2026))).filter((b) => b.leaveTypeCode === 'ANNUAL');
    expect(annual!.taken).toBe(0n);
    // Nothing was deleted: both requests stand, with their reasons.
    const { rows } = await ownerPool.query(`select status, coalesce(decision_note, cancel_reason) as why from leave_request where employee_id = $1 order by from_date`, [staffEmployeeId]);
    expect(rows).toEqual([
      { status: 'refused', why: 'Stock count that week' },
      { status: 'cancelled', why: 'Changed plans' },
    ]);
  });

  it('H4b · a person asks for their own leave; their manager decides it', async () => {
    const own = await ask(staff, staffEmployeeId, 'ANNUAL', '2026-11-08', '2026-11-09', { reason: 'Family' });
    await as(staff, (tx) => leave.submit(tx, staff, own.id));
    expect(await rejection(as(staff, (tx) => leave.approve(tx, staff, own.id)))).toMatch(/cannot decide it/);
    // They cannot ask for somebody else.
    expect(await rejection(ask(staff, bossEmployeeId, 'ANNUAL', '2026-11-08', '2026-11-09'))).toBeTruthy();
    await as(boss, (tx) => leave.approve(tx, boss, own.id));
    expect((await as(boss, (tx) => leave.waitingFor(tx, boss))).length).toBe(0);
  });
});

describe('H4c · the day sheet and what a day was', () => {
  it('present with times, absent; corrected and audited; never over a leave', async () => {
    const leaveDay = await ask(hrOfficer, otherEmployeeId, 'ANNUAL', '2026-09-29', '2026-09-29');
    await as(hrOfficer, (tx) => leave.submit(tx, hrOfficer, leaveDay.id));
    await as(hrManager, (tx) => leave.approve(tx, hrManager, leaveDay.id));

    await as(hrOfficer, (tx) =>
      attendance.saveSheet(tx, hrOfficer, {
        branchCode: BRANCH,
        day: '2026-09-29',
        entries: [
          { employeeId: staffEmployeeId, status: 'present', checkIn: '08:00', checkOut: '16:30' },
          { employeeId: bossEmployeeId, status: 'absent' },
        ],
      }),
    );
    const day = await as(hrOfficer, (tx) => attendance.sheet(tx, { branchCode: BRANCH, day: '2026-09-29' }));
    expect(day.rows.map((r) => [r.fullNameEn, r.status, r.checkIn, r.checkOut, r.leaveRequestNo !== null])).toEqual([
      ['Boss', 'absent', null, null, false],
      ['Staff Member', 'present', '08:00', '16:30', false],
      ['Other Member', 'leave', null, null, true],
    ]);
    expect(
      await rejection(as(hrOfficer, (tx) => attendance.saveSheet(tx, hrOfficer, { branchCode: BRANCH, day: '2026-09-29', entries: [{ employeeId: otherEmployeeId, status: 'present' }] }))),
    ).toMatch(/is on leave that day/);
    expect(await rejection(as(hrOfficer, (tx) => attendance.saveSheet(tx, hrOfficer, { branchCode: BRANCH, day: '2099-01-01', entries: [] })))).toMatch(/has not come yet/);

    // A correction: the boss was in after all.
    await as(hrOfficer, (tx) => attendance.saveSheet(tx, hrOfficer, { branchCode: BRANCH, day: '2026-09-29', entries: [{ employeeId: bossEmployeeId, status: 'present', checkIn: '09:15' }] }));
    const { rows } = await ownerPool.query(`select after_value from audit_event where action = 'attendance.recorded' order by occurred_at`);
    expect(rows).toHaveLength(2);
    expect(rows[1].after_value.changes).toEqual([{ employeeNo: expect.stringMatching(/^EMP-HQ-/), before: 'absent', after: 'present 09:15' }]);
  });

  it('the month reads leave over the sheet over the calendar; the summary counts paid and unpaid', async () => {
    // A late sick note excuses the absence the sheet recorded on Tuesday 29 September.
    await as(hrOfficer, (tx) => attendance.saveSheet(tx, hrOfficer, { branchCode: BRANCH, day: '2026-09-29', entries: [{ employeeId: staffEmployeeId, status: 'absent' }] }));
    await as(hrOfficer, (tx) => attendance.saveSheet(tx, hrOfficer, { branchCode: BRANCH, day: '2026-09-28', entries: [{ employeeId: staffEmployeeId, status: 'present' }] }));
    const sick = await ask(hrOfficer, staffEmployeeId, 'SICK', '2026-09-29', '2026-09-29');
    await as(hrOfficer, (tx) => attachments.upload(tx, hrOfficer, { objectType: leave.PERMISSION_OBJECT, objectId: sick.id, fileName: 'note.pdf', content: Buffer.from('%PDF-1.4 note') }));
    await as(hrOfficer, (tx) => leave.submit(tx, hrOfficer, sick.id));
    await as(boss, (tx) => leave.approve(tx, boss, sick.id));
    const unpaid = await ask(hrOfficer, staffEmployeeId, 'UNPAID', '2026-09-30', '2026-09-30', { halfDayEnd: true });
    await as(hrOfficer, (tx) => leave.submit(tx, hrOfficer, unpaid.id));
    await as(boss, (tx) => leave.approve(tx, boss, unpaid.id));

    const days = await as(hrOfficer, (tx) => attendance.daysOf(tx, staffEmployeeId, '2026-09-25', '2026-10-01'));
    expect(days.map((d) => [d.day, d.status])).toEqual([
      ['2026-09-25', 'rest'],
      ['2026-09-26', 'rest'],
      ['2026-09-27', 'unrecorded'],
      ['2026-09-28', 'present'],
      ['2026-09-29', 'leave'],
      ['2026-09-30', 'leave'],
      ['2026-10-01', 'unrecorded'],
    ]);
    const summary = await as(hrOfficer, (tx) => attendance.summary(tx, staffEmployeeId, '2026-09-25', '2026-10-01'));
    expect(summary).toMatchObject({ present: 1, absent: 0, unrecorded: 2, restDays: 2, paidLeave: 100n, unpaidLeave: 50n });
  });
});

describe('H4d · the sweep', () => {
  it('a contract ending, a request waiting, annual leave lapsing — each raised once', async () => {
    const waiting = await ask(hrOfficer, staffEmployeeId, 'ANNUAL', '2026-12-06', '2026-12-07');
    await as(hrOfficer, (tx) => leave.submit(tx, hrOfficer, waiting.id));
    await ownerPool.query(`update leave_request set submitted_at = '2026-11-20T09:00:00+03:00' where id = $1`, [waiting.id]);

    const sweep = (asOf: string) => as(hrManager, (tx) => hrSweep.run(tx, hrManager.principal, asOf));
    const first = await sweep('2026-11-25');
    expect(first).toMatchObject({ contractsExpiring: 0, leaveWaiting: 1 });
    expect(await notificationsOf(boss.principal.userId, 'hr.leave_waiting')).toHaveLength(1);

    // The contract ends 20 October: inside the 30 days from 1 October.
    await sweep('2026-10-01');
    await sweep('2026-10-01');
    expect(await notificationsOf(hrManager.principal.userId, 'hr.contract_expiring')).toHaveLength(1);

    // 18 December: the staff member has 40 − 2 pending days of annual leave, 10 carry — the rest lapses.
    await sweep('2026-12-18');
    await sweep('2026-12-18');
    expect(await notificationsOf(hrManager.principal.userId, 'hr.leave_lapsing')).toHaveLength(3);
    expect(await notificationsOf(staff.principal.userId, 'hr.leave_lapsing')).toEqual(['28 days of Annual leave will not carry into 2027']);
    expect(await notificationsOf(boss.principal.userId, 'hr.leave_waiting')).toHaveLength(1);
  });
});
