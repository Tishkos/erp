/**
 * REQ-HR-001 Stage HR-5 — recruitment and performance, against the database.
 *
 *   H9   a vacancy drafted by HR and opened by the HR manager takes
 *        applicants who move forward only, each move a stage row that
 *        cannot be changed; an offer hired becomes an employee through
 *        `employees.create` — one record per person, its first history row
 *        naming the application — and the last hire fills the vacancy and
 *        tells the rest of its pipeline no; an applicant is read under
 *        recruitment's own grant, and so is their CV
 *   H10  a cycle's reviews are started for the people with a manager who
 *        signs in; HR sets the goals, only the reviewer rates and finishes;
 *        the overall is the weighted average; the person reads their own and
 *        adds their word once; an HR manager who is neither the reviewer nor
 *        the person signs it off, and then it is the record; a cycle closes
 *        when every review is done
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import { registerAttachmentRuntime } from '@/server/attachments-runtime';
import * as attachments from '@/server/services/attachments';
import * as authz from '@/server/services/authorization';
import * as employees from '@/server/services/employees';
import * as hrSweep from '@/server/services/hr-sweep';
import * as performance from '@/server/services/performance';
import * as recruitment from '@/server/services/recruitment';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BRANCH = 'HQ';
let hrOfficer: ActorContext;
let hrManager: ActorContext;
let hrManager2: ActorContext;
let boss: ActorContext;
let staff: ActorContext;
let outsider: ActorContext;
let bossEmployeeId = '';
let staffEmployeeId = '';

async function userWith(roles: string[], name = roles.join('+') || 'Staff'): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [id, `${id}@example.com`, name]);
  for (const role of roles) await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code, is_default) values ($1,$2,true)`, [id, BRANCH]);
  const principal = await withScope({ userId: id, branchCode: BRANCH }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BRANCH };
}

const as = <T>(ctx: ActorContext, fn: (tx: Parameters<Parameters<typeof withScope>[1]>[0]) => Promise<T>) => withScope({ userId: ctx.principal.userId, branchCode: BRANCH }, fn);

async function hire(name: string, managerEmployeeId: string | null = null): Promise<string> {
  const made = await as(hrOfficer, (tx) => employees.create(tx, hrOfficer, { fullNameEn: name, departmentCode: 'OPS', hireDate: '2024-01-01', employmentKind: 'permanent', managerEmployeeId }));
  return made.id;
}

const notificationsOf = async (userId: string, eventType: string) =>
  (await ownerPool.query(`select subject from notification where recipient_user_id = $1 and event_type = $2`, [userId, eventType])).rows.map((r) => r.subject as string);

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BRANCH, 'Head Office');
  await ownerPool.query(`insert into department (code, name) values ('OPS','Operations') on conflict do nothing`);
  await ownerPool.query(`insert into position (code, title_en, department_code) values ('ACCT','Accountant','OPS')`);
  hrOfficer = await userWith(['hr_officer']);
  hrManager = await userWith(['hr_manager'], 'HR Manager');
  hrManager2 = await userWith(['hr_manager'], 'Second HR Manager');
  boss = await userWith([], 'Boss');
  staff = await userWith([], 'Staff Member');
  outsider = await userWith([], 'Outsider');
  bossEmployeeId = await hire('Boss');
  staffEmployeeId = await hire('Staff Member', bossEmployeeId);
  await ownerPool.query(`update employee set app_user_id = $1 where id = $2`, [boss.principal.userId, bossEmployeeId]);
  await ownerPool.query(`update employee set app_user_id = $1 where id = $2`, [staff.principal.userId, staffEmployeeId]);
  // The deployment's checks (the applicant's among them), with the bytes kept in memory.
  registerAttachmentRuntime();
  const files = new Map<string, Buffer>();
  attachments.registerStorage({ put: async (key, content) => void files.set(key, content), get: async (key) => files.get(key) ?? null });
  attachments.registerScanner(() => ({ status: 'clean' }));
});

async function openVacancy(headcount = 2) {
  const made = await as(hrOfficer, (tx) =>
    recruitment.createVacancy(tx, hrOfficer, { positionCode: 'ACCT', headcount, description: 'An accountant for the head office', opensOn: '2026-09-01', closesOn: '2026-09-30' }),
  );
  await as(hrManager, (tx) => recruitment.openVacancy(tx, hrManager, made.vacancyNo));
  return made.vacancyNo;
}

const apply = (vacancyNo: string, name: string) => as(hrOfficer, (tx) => recruitment.addApplicant(tx, hrOfficer, vacancyNo, { fullNameEn: name, phone: '0770 000 0000', source: 'Referral' }));

describe('H9 · recruitment', () => {
  it('a vacancy is drafted by HR, opened by the HR manager, and takes applicants who move forward only', async () => {
    const made = await as(hrOfficer, (tx) => recruitment.createVacancy(tx, hrOfficer, { positionCode: 'acct', headcount: 2, description: 'Two accountants' }));
    expect(made.vacancyNo).toMatch(/^VAC-HQ-\d{4}-0001$/);
    const draft = (await as(hrOfficer, (tx) => recruitment.vacancyByNo(tx, made.vacancyNo)))!;
    expect(draft.row.departmentCode).toBe('OPS');
    expect(draft.row.status).toBe('draft');
    expect(await rejection(as(hrOfficer, (tx) => recruitment.addApplicant(tx, hrOfficer, made.vacancyNo, { fullNameEn: 'Too Early' })))).toMatch(/is draft; applicants are added while it is open/);
    expect(await rejection(as(hrOfficer, (tx) => recruitment.openVacancy(tx, hrOfficer, made.vacancyNo)))).toMatch(/'approve' on 'recruitment' is not granted/);
    await as(hrManager, (tx) => recruitment.openVacancy(tx, hrManager, made.vacancyNo));

    const sara = await apply(made.vacancyNo, 'Sara Ahmed');
    expect(sara.applicantNo).toMatch(/^APL-HQ-\d{4}-00001$/);
    await as(hrOfficer, (tx) => recruitment.moveApplicant(tx, hrOfficer, sara.applicantNo, 'interview', 'Strong CV'));
    expect(await rejection(as(hrOfficer, (tx) => recruitment.moveApplicant(tx, hrOfficer, sara.applicantNo, 'screening')))).toMatch(/never back to screening/);
    expect(await rejection(as(hrOfficer, (tx) => recruitment.moveApplicant(tx, hrOfficer, sara.applicantNo, 'rejected')))).toMatch(/Say why/);
    const detail = (await as(hrOfficer, (tx) => recruitment.applicantByNo(tx, sara.applicantNo)))!;
    expect(detail.stages.map((s) => [s.fromStage, s.toStage])).toEqual([
      [null, 'applied'],
      ['applied', 'interview'],
    ]);
    expect(detail.next).toEqual(['offer', 'rejected', 'withdrawn']);
    // Every move is the record: it cannot be changed or taken back.
    expect(await rejection(ownerPool.query(`update applicant_stage set note = 'edited' where applicant_id = $1`, [sara.id]))).toMatch(/append-only|not allowed|cannot/i);
    expect(
      await rejection(ownerPool.query(`insert into applicant_stage (applicant_id, from_stage, to_stage, moved_by) values ($1,'interview','rejected',$2)`, [sara.id, hrOfficer.principal.userId])),
    ).toMatch(/applicant_stage_closing_note/);
  });

  it('an offer hired is an employee made through employees.create; the last hire fills the vacancy and closes the rest of its pipeline', async () => {
    const vacancyNo = await openVacancy(2);
    const sara = await apply(vacancyNo, 'Sara Ahmed');
    const omar = await apply(vacancyNo, 'Omar Khalil');
    const lina = await apply(vacancyNo, 'Lina Hassan');
    for (const who of [sara, omar]) await as(hrOfficer, (tx) => recruitment.moveApplicant(tx, hrOfficer, who.applicantNo, 'offer'));
    expect(await rejection(as(hrOfficer, (tx) => recruitment.hire(tx, hrOfficer, sara.applicantNo, { hireDate: '2026-10-01' })))).toMatch(/'approve' on 'recruitment' is not granted/);
    expect(await rejection(as(hrManager, (tx) => recruitment.hire(tx, hrManager, lina.applicantNo, { hireDate: '2026-10-01' })))).toMatch(/is at applied; a hire is an offer accepted/);
    // The offer reached the HR managers.
    expect(await notificationsOf(hrManager2.principal.userId, 'hr.applicant_offer')).toHaveLength(2);

    const hired = await as(hrManager, (tx) => recruitment.hire(tx, hrManager, sara.applicantNo, { hireDate: '2026-10-01', managerEmployeeId: bossEmployeeId, nationalId: '199012345678' }));
    expect(hired.employeeNo).toMatch(/^EMP-HQ-/);
    expect(hired.vacancyFilled).toBe(false);
    const { rows: person } = await ownerPool.query(`select branch_code, department_code, position_code, employment_kind, phone, manager_employee_id, hire_date::text from employee where id = $1`, [
      hired.employeeId,
    ]);
    expect(person[0]).toEqual({
      branch_code: 'HQ',
      department_code: 'OPS',
      position_code: 'ACCT',
      employment_kind: 'permanent',
      phone: '0770 000 0000',
      manager_employee_id: bossEmployeeId,
      hire_date: '2026-10-01',
    });
    const { rows: history } = await ownerPool.query(`select reason from employee_history where employee_id = $1 and field = 'hired'`, [hired.employeeId]);
    expect(history[0].reason).toBe(`Hired from ${sara.applicantNo} (${vacancyNo})`);
    expect(await notificationsOf(boss.principal.userId, 'hr.hired')).toEqual(['Sara Ahmed joins you on 2026-10-01']);
    expect((await as(hrManager, (tx) => recruitment.hiredFrom(tx, hired.employeeId)))?.applicantNo).toBe(sara.applicantNo);
    expect(await rejection(as(hrManager, (tx) => recruitment.hire(tx, hrManager, sara.applicantNo, { hireDate: '2026-10-01' })))).toMatch(/is at hired/);

    // One record per person (R1): the same national id is the same person.
    expect(await rejection(as(hrManager, (tx) => recruitment.hire(tx, hrManager, omar.applicantNo, { hireDate: '2026-10-01', nationalId: '199012345678' })))).toMatch(
      new RegExp(`is already ${hired.employeeNo}'s — one record per person`),
    );
    const second = await as(hrManager, (tx) => recruitment.hire(tx, hrManager, omar.applicantNo, { hireDate: '2026-10-05' }));
    expect(second.vacancyFilled).toBe(true);
    const filled = (await as(hrManager, (tx) => recruitment.vacancyByNo(tx, vacancyNo)))!;
    expect([filled.row.status, filled.row.hired, filled.holding]).toEqual(['filled', 2, 2]);
    const left = (await as(hrManager, (tx) => recruitment.applicantByNo(tx, lina.applicantNo)))!;
    expect(left.row.stage).toBe('rejected');
    expect(left.stages.at(-1)?.note).toBe(`${vacancyNo} is filled`);
    // The headcount holds at the database too.
    expect(await rejection(ownerPool.query(`update vacancy set hired = 3 where vacancy_no = $1`, [vacancyNo]))).toMatch(/vacancy_(filled|headcount)/);
    expect(await rejection(ownerPool.query(`update applicant set employee_id = null where id = $1`, [sara.id]))).toMatch(/applicant_hired_is_employee/);
  });

  it('an open vacancy is amended or closed with its reason, and its open applications end with it; the sweep raises one past its closing day', async () => {
    const vacancyNo = await openVacancy(3);
    const sara = await apply(vacancyNo, 'Sara Ahmed');
    await as(hrManager, (tx) => recruitment.amendOpen(tx, hrManager, vacancyNo, { closesOn: '2026-10-15', headcount: 2 }));
    expect((await as(hrManager, (tx) => recruitment.vacancyByNo(tx, vacancyNo)))!.row.headcount).toBe(2);

    const first = await as(hrManager, (tx) => hrSweep.run(tx, hrManager.principal, '2026-10-20'));
    expect(first.vacanciesOverdue).toBe(1);
    expect(await notificationsOf(hrManager.principal.userId, 'hr.vacancy_overdue')).toHaveLength(1);
    await as(hrManager, (tx) => hrSweep.run(tx, hrManager.principal, '2026-10-21'));
    expect(await notificationsOf(hrManager.principal.userId, 'hr.vacancy_overdue')).toHaveLength(1);

    expect(await rejection(as(hrManager, (tx) => recruitment.closeVacancy(tx, hrManager, vacancyNo, ' ')))).toMatch(/reason/);
    const closed = await as(hrManager, (tx) => recruitment.closeVacancy(tx, hrManager, vacancyNo, 'Budget withdrawn'));
    expect(closed.applicantsClosed).toBe(1);
    const after = (await as(hrManager, (tx) => recruitment.applicantByNo(tx, sara.applicantNo)))!;
    expect([after.row.stage, after.stages.at(-1)?.note]).toEqual(['rejected', `${vacancyNo} was closed: Budget withdrawn`]);
    expect(await rejection(as(hrOfficer, (tx) => recruitment.addApplicant(tx, hrOfficer, vacancyNo, { fullNameEn: 'Late' })))).toMatch(/is closed/);
  });

  it('an applicant is read under recruitment’s grant — the row policy asks for it — and so is their CV', async () => {
    const vacancyNo = await openVacancy(1);
    const sara = await apply(vacancyNo, 'Sara Ahmed');
    const file = await as(hrOfficer, (tx) =>
      attachments.upload(tx, hrOfficer, { objectType: recruitment.APPLICANT_OBJECT, objectId: sara.id, fileName: 'sara-cv.pdf', content: Buffer.from('%PDF-1.4\n% CV\n') }),
    );
    expect(await as(outsider, (tx) => recruitment.applicantByNo(tx, sara.applicantNo))).toBeNull();
    expect((await withScope({ userId: outsider.principal.userId, branchCode: BRANCH }, (tx) => tx.execute(sql`select count(*)::int as n from applicant`))).rows[0]).toEqual({ n: 0 });
    // The vacancy itself is no secret in its branch: it is what people apply for.
    expect(await as(outsider, (tx) => recruitment.vacancyByNo(tx, vacancyNo))).not.toBeNull();
    expect(await rejection(as(outsider, (tx) => attachments.download(tx, { principal: outsider.principal, branchCode: BRANCH }, file.attachmentId)))).toBeTruthy();
    const read = await as(hrManager, (tx) => attachments.download(tx, { principal: hrManager.principal, branchCode: BRANCH }, file.attachmentId));
    expect(read.fileName).toBe('sara-cv.pdf');
  });
});

describe('H10 · performance', () => {
  async function openCycle(code = '2026-H1') {
    await as(hrManager, (tx) => performance.createCycle(tx, hrManager, { code, nameEn: 'First half 2026', periodFrom: '2026-01-01', periodTo: '2026-06-30' }));
    await as(hrManager, (tx) => performance.openCycle(tx, hrManager, code));
    return code;
  }

  it('a cycle’s reviews are started for the people with a manager who signs in; one per person per cycle', async () => {
    await as(hrManager, (tx) => performance.createCycle(tx, hrManager, { code: '2026-h1', nameEn: 'First half 2026', periodFrom: '2026-01-01', periodTo: '2026-06-30' }));
    expect(await rejection(as(hrOfficer, (tx) => performance.createCycle(tx, hrOfficer, { code: 'X', nameEn: 'X', periodFrom: '2026-01-01', periodTo: '2026-01-31' })))).toMatch(
      /'configure' on 'hr_setting'/,
    );
    expect(await rejection(as(hrOfficer, (tx) => performance.startForCycle(tx, hrOfficer, { cycleCode: '2026-H1' })))).toMatch(/is draft; reviews are written while their cycle is open/);
    await as(hrManager, (tx) => performance.openCycle(tx, hrManager, '2026-H1'));

    const started = await as(hrOfficer, (tx) => performance.startForCycle(tx, hrOfficer, { cycleCode: '2026-H1' }));
    expect(started.made).toHaveLength(1);
    expect(started.skipped.map((s) => s.why)).toEqual(['no manager who signs in']);
    const review = (await as(hrOfficer, (tx) => performance.byNo(tx, started.made[0]!.reviewNo)))!;
    expect([review.person.id, review.row.reviewerUserId]).toEqual([staffEmployeeId, boss.principal.userId]);
    expect(await notificationsOf(boss.principal.userId, 'hr.review_assigned')).toHaveLength(1);
    // Running it again makes none; a second review for the same person is refused, and so is the database's.
    expect((await as(hrOfficer, (tx) => performance.startForCycle(tx, hrOfficer, { cycleCode: '2026-H1' }))).made).toHaveLength(0);
    expect(await rejection(as(hrOfficer, (tx) => performance.create(tx, hrOfficer, { cycleCode: '2026-H1', employeeId: staffEmployeeId })))).toMatch(/already has REV-/);
    // A person never reviews themself — the service and the trigger.
    expect(await rejection(as(hrOfficer, (tx) => performance.create(tx, hrOfficer, { cycleCode: '2026-H1', employeeId: bossEmployeeId, reviewerUserId: boss.principal.userId })))).toMatch(
      /does not review themself/,
    );
    expect(
      await rejection(
        ownerPool.query(`insert into performance_review (review_no, cycle_code, employee_id, branch_code, reviewer_user_id, created_by) values ('REV-X','2026-H1',$1,'HQ',$2,$2)`, [
          bossEmployeeId,
          boss.principal.userId,
        ]),
      ),
    ).toMatch(/does not review themself/);
  });

  it('HR sets the goals, only the reviewer rates and finishes; the overall is the weighted average; the person adds their word once; another HR manager signs it off', async () => {
    const cycle = await openCycle();
    const { reviewNo } = await as(hrOfficer, (tx) => performance.create(tx, hrOfficer, { cycleCode: cycle, employeeId: staffEmployeeId }));
    await as(hrOfficer, (tx) =>
      performance.saveGoals(tx, hrOfficer, reviewNo, [
        { title: 'Close the books by the 5th', target: 'Every month', weight: 60 },
        { title: 'Train the new clerk', weight: 30 },
      ]),
    );
    expect(await rejection(as(hrOfficer, (tx) => performance.saveGoals(tx, hrOfficer, reviewNo, [{ lineNo: 1, title: 'Close the books by the 5th', weight: 60, rating: 4 }])))).toMatch(
      /Only the reviewer rates/,
    );
    // Somebody neither HR nor the reviewer does not find it to change: row security hides it.
    expect(await rejection(as(outsider, (tx) => performance.saveGoals(tx, outsider, reviewNo, [{ title: 'Sneak', weight: 10 }])))).toMatch(/No review 'REV-/);
    expect(await rejection(as(hrOfficer, (tx) => performance.saveGoals(tx, hrOfficer, reviewNo, [{ title: 'Too much', weight: 20 }])))).toMatch(/make 110; they may not make more than 100/);
    expect(await rejection(as(hrOfficer, (tx) => performance.complete(tx, hrOfficer, reviewNo)))).toMatch(/rated by its reviewer/);

    // The reviewer rates, and finds the weights short.
    await as(boss, (tx) =>
      performance.saveGoals(tx, boss, reviewNo, [
        { lineNo: 1, title: 'Close the books by the 5th', target: 'Every month', weight: 60, rating: 4, comment: 'Late once' },
        { lineNo: 2, title: 'Train the new clerk', weight: 30, rating: 3 },
      ]),
    );
    expect(await rejection(as(boss, (tx) => performance.complete(tx, boss, reviewNo)))).toMatch(/weights make 90; they must make 100/);
    await as(boss, (tx) => performance.saveGoals(tx, boss, reviewNo, [{ lineNo: 2, title: 'Train the new clerk', weight: 40, rating: 3 }]));
    expect(await as(boss, (tx) => performance.complete(tx, boss, reviewNo, 'A steady half'))).toEqual({ overall: '3.60' });
    expect(await notificationsOf(staff.principal.userId, 'hr.review_rated')).toHaveLength(1);
    expect(await notificationsOf(hrManager.principal.userId, 'hr.review_to_sign_off')).toHaveLength(1);
    // Rated, the goals are frozen — the service and the trigger.
    expect(await rejection(as(boss, (tx) => performance.saveGoals(tx, boss, reviewNo, [{ lineNo: 1, title: 'Changed', weight: 60 }])))).toMatch(/change while it is a draft/);
    expect(await rejection(ownerPool.query(`update review_goal set rating = 5 where line_no = 1`))).toMatch(/goals change only while it is a draft/);

    // The person reads it — their own, through the row policy — and an outsider does not.
    expect((await as(staff, (tx) => performance.byNo(tx, reviewNo)))?.row.overallRating).toBe('3.60');
    expect(await as(outsider, (tx) => performance.byNo(tx, reviewNo))).toBeNull();
    expect((await as(staff, (tx) => performance.waitingFor(tx, staff))).map((w) => w.action)).toEqual(['comment']);
    await as(staff, (tx) => performance.comment(tx, staff, reviewNo, 'I asked for the training twice.'));
    expect(await rejection(as(staff, (tx) => performance.comment(tx, staff, reviewNo, 'Again')))).toMatch(/already given/);
    expect(await rejection(as(boss, (tx) => performance.comment(tx, boss, reviewNo, 'Not mine')))).toMatch(/Only Staff Member adds their word/);

    // Signed off by an HR manager — the reviewer is refused by the check.
    expect(await rejection(as(boss, (tx) => performance.signOff(tx, boss, reviewNo)))).toMatch(/'approve' on 'performance_review'/);
    expect(await rejection(ownerPool.query(`update performance_review set status = 'signed_off', signed_off_by = reviewer_user_id where review_no = $1`, [reviewNo]))).toMatch(
      /performance_review_signer_not_reviewer/,
    );
    expect(await rejection(ownerPool.query(`update performance_review set status = 'signed_off', signed_off_by = $2 where review_no = $1`, [reviewNo, staff.principal.userId]))).toMatch(
      /does not sign off their own review/,
    );
    expect((await as(hrManager, (tx) => performance.waitingFor(tx, hrManager))).map((w) => [w.reviewNo, w.action])).toEqual([[reviewNo, 'sign_off']]);
    await as(hrManager, (tx) => performance.signOff(tx, hrManager, reviewNo, 'Agreed'));
    expect(await notificationsOf(staff.principal.userId, 'hr.review_signed_off')).toHaveLength(1);
    // Signed off, it is the record.
    expect(await rejection(ownerPool.query(`update performance_review set overall_rating = 5 where review_no = $1`, [reviewNo]))).toMatch(/it is the record and is not changed/);
    expect(await rejection(as(hrManager, (tx) => performance.reopen(tx, hrManager, reviewNo, 'Second thoughts')))).toMatch(/cannot become draft/);
    expect((await as(staff, (tx) => performance.ofEmployee(tx, staffEmployeeId))).map((r) => [r.reviewNo, r.status, r.overallRating])).toEqual([[reviewNo, 'signed_off', '3.60']]);
  });

  it('a rated review goes back to its reviewer with the reason; a cycle closes only when every review is signed off or cancelled', async () => {
    const cycle = await openCycle();
    const { reviewNo } = await as(hrOfficer, (tx) => performance.create(tx, hrOfficer, { cycleCode: cycle, employeeId: staffEmployeeId }));
    const other = await as(hrOfficer, (tx) => performance.create(tx, hrOfficer, { cycleCode: cycle, employeeId: bossEmployeeId, reviewerUserId: hrManager.principal.userId }));
    await as(boss, (tx) => performance.saveGoals(tx, boss, reviewNo, [{ title: 'Everything', weight: 100, rating: 5 }]));
    expect((await as(boss, (tx) => performance.waitingFor(tx, boss))).map((w) => [w.reviewNo, w.action])).toEqual([[reviewNo, 'rate']]);
    await as(boss, (tx) => performance.complete(tx, boss, reviewNo));
    await as(hrManager2, (tx) => performance.reopen(tx, hrManager2, reviewNo, 'One goal is not enough'));
    const reopened = (await as(boss, (tx) => performance.byNo(tx, reviewNo)))!;
    expect([reopened.row.status, reopened.row.overallRating]).toEqual(['draft', null]);
    expect(await notificationsOf(boss.principal.userId, 'hr.review_reopened')).toEqual([`${reviewNo} is back with you: One goal is not enough`]);

    expect(await rejection(as(hrManager, (tx) => performance.closeCycle(tx, hrManager, cycle)))).toMatch(/has 2 review\(s\) not yet signed off or cancelled/);
    await as(boss, (tx) => performance.complete(tx, boss, reviewNo));
    // The HR manager who reviews the boss does not sign that review off; the second does.
    await as(hrManager, (tx) => performance.saveGoals(tx, hrManager, other.reviewNo, [{ title: 'Lead the team', weight: 100, rating: 4 }]));
    await as(hrManager, (tx) => performance.complete(tx, hrManager, other.reviewNo));
    expect(await rejection(as(hrManager, (tx) => performance.signOff(tx, hrManager, other.reviewNo)))).toMatch(/somebody else signs it off/);
    await as(hrManager2, (tx) => performance.signOff(tx, hrManager2, other.reviewNo));
    expect(await rejection(as(hrManager, (tx) => performance.cancel(tx, hrManager, reviewNo, ' ')))).toMatch(/reason/);
    await as(hrManager, (tx) => performance.cancel(tx, hrManager, reviewNo, 'Moved to the new cycle'));
    await as(hrManager, (tx) => performance.closeCycle(tx, hrManager, cycle));
    expect((await as(hrManager, (tx) => performance.cycles(tx))).map((c) => [c.code, c.status, c.reviews, c.signedOff])).toEqual([[cycle, 'closed', 1, 1]]);
    expect(await rejection(as(hrOfficer, (tx) => performance.create(tx, hrOfficer, { cycleCode: cycle, employeeId: staffEmployeeId })))).toMatch(/is closed/);
  });
});
