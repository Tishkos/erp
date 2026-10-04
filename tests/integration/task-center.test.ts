/**
 * Task Center (platform phase, Agent 3) — the service and the database, as the
 * people who would use it.
 *
 *   TK1  assignment scope: a person may give a task only to the people the
 *        rules let them — themselves, those who report to them (directly or
 *        through others), the members of a section they manage, and, for a
 *        holder of `administer`, anyone in the branch; the dropdown lists
 *        exactly that, and a manager is not everyone's manager
 *   TK2  an assignment outside that scope is refused by the service and, when
 *        the service is bypassed, by the trigger
 *   TK3  the lifecycle: the road, who takes each step, reasons, timestamps the
 *        database stamps, a double press moving the task once, no deletion
 *   TK4  who can see a task: a draft its raiser alone; the parties, the
 *        watchers, the section's manager and whoever the assignee reports to
 *   TK5  notices go through the notification service, once, to people who may
 *        open the task and never to the person who acted; the sweep is deduped
 *        and works for a system operator who is not a flagged super user
 *   TK6  the Dashboard summary and the Exceptions feeds, and the Team view
 *   TK7  the platform pieces a task joins: Global Search, record notes,
 *        attachments, the Document Center's record link, Reply in Chat
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { asApp, ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import { registerAttachmentRuntime } from '@/server/attachments-runtime';
import { businessToday } from '@/server/domain/business-date';
import { registerAllRecords } from '@/server/records';
import * as attachments from '@/server/services/attachments';
import * as authz from '@/server/services/authorization';
import * as globalSearch from '@/server/services/global-search';
import * as recordNotes from '@/server/services/record-notes';
import * as taskSweep from '@/server/services/task-sweep';
import * as tasks from '@/server/services/tasks';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BGW = 'BGW';
const ERB = 'ERB';
const today = businessToday();

interface Person extends ActorContext {
  readonly id: string;
  readonly name: string;
}

interface Spec {
  readonly roles?: readonly string[];
  readonly branch?: string;
  readonly sections?: readonly string[];
  readonly manages?: readonly string[];
  readonly employee?: { readonly no: string; readonly department: string; readonly managerOf?: string };
}

const employeeIds: Record<string, string> = {};

async function person(name: string, spec: Spec = {}): Promise<Person> {
  const id = randomUUID();
  const branch = spec.branch ?? BGW;
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [id, `${id}@example.com`, name]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code, is_default) values ($1,$2,true)`, [id, branch]);
  for (const role of spec.roles ?? []) await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  for (const code of spec.sections ?? []) {
    await ownerPool.query(`insert into user_department_scope (user_id, department_code, is_manager) values ($1,$2,$3)`, [id, code, (spec.manages ?? []).includes(code)]);
  }
  if (spec.employee) {
    const manager = spec.employee.managerOf ? employeeIds[spec.employee.managerOf] : null;
    const { rows } = await ownerPool.query(
      `insert into employee (employee_no, full_name_en, branch_code, department_code, hire_date, app_user_id, manager_employee_id, created_by)
       values ($1,$2,$3,$4,'2024-01-01',$5,$6,$5) returning id`,
      [spec.employee.no, name, branch, spec.employee.department, id, manager],
    );
    employeeIds[name] = rows[0].id as string;
  }
  const principal = await withScope({ userId: id, branchCode: branch }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: branch, id, name };
}

const as = <T>(p: Person, fn: (tx: Parameters<Parameters<typeof withScope>[1]>[0]) => Promise<T>) => withScope({ userId: p.id, branchCode: p.branchCode }, fn);
const scopeOf = (p: Person) => ({ userId: p.id, branchCode: p.branchCode });

let ceo: Person; // administer: the whole branch
let fatima: Person; // accounting manager; manages FIN
let khaled: Person; // FIN officer, reports to Fatima
let sara: Person; // FIN officer, reports to Fatima
let noor: Person; // FIN officer, no employee record
let rami: Person; // OPS officer who reports to Fatima (not in FIN)
let tariq: Person; // OPS officer who reports to Khaled (so to Fatima, through him)
let omar: Person; // OPS officer, reports to nobody
let hana: Person; // HR manager; member of HRD only
let gus: Person; // FIN officer in Erbil
let eve: Person; // no role at all

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BGW, 'Baghdad');
  await seedBranch(ERB, 'Erbil');
  for (const [code, name] of [['FIN', 'Finance'], ['OPS', 'Operations'], ['HRD', 'Human Resources']]) {
    await ownerPool.query(`insert into department (code, name, is_finance) values ($1,$2,$3)`, [code, name, code === 'FIN']);
  }
  registerAllRecords();
  registerAttachmentRuntime();
  const files = new Map<string, Buffer>();
  attachments.registerStorage({ put: async (key, content) => void files.set(key, content), get: async (key) => files.get(key) ?? null });
  attachments.registerScanner(() => ({ status: 'clean' }));

  ceo = await person('Chief Executive', { roles: ['ceo'] });
  fatima = await person('Fatima Finance', { roles: ['accounting_manager'], sections: ['FIN'], manages: ['FIN'], employee: { no: 'E-001', department: 'FIN' } });
  khaled = await person('Khaled Accounts', { roles: ['accounting_officer'], sections: ['FIN'], employee: { no: 'E-002', department: 'FIN', managerOf: 'Fatima Finance' } });
  sara = await person('Sara Ledger', { roles: ['accounting_officer'], sections: ['FIN'], employee: { no: 'E-003', department: 'FIN', managerOf: 'Fatima Finance' } });
  noor = await person('Noor Cashier', { roles: ['accounting_officer'], sections: ['FIN'] });
  rami = await person('Rami Operations', { roles: ['accounting_officer'], sections: ['OPS'], employee: { no: 'E-005', department: 'OPS', managerOf: 'Fatima Finance' } });
  tariq = await person('Tariq Dispatch', { roles: ['accounting_officer'], sections: ['OPS'], employee: { no: 'E-004', department: 'OPS', managerOf: 'Khaled Accounts' } });
  omar = await person('Omar Operations', { roles: ['accounting_officer'], sections: ['OPS'], employee: { no: 'E-006', department: 'OPS' } });
  hana = await person('Hana People', { roles: ['hr_manager'], sections: ['HRD'] });
  gus = await person('Gus Erbil', { roles: ['accounting_officer'], branch: ERB, sections: ['FIN'] });
  eve = await person('Eve Nobody', { sections: ['FIN'] });
});

const create = (p: Person, input: Partial<tasks.TaskInput> = {}) =>
  as(p, (tx) => tasks.create(tx, p, { title: 'Reconcile the Erbil bank statement', departmentCode: 'FIN', ...input }));
const act = (p: Person, taskNo: string, action: Parameters<typeof tasks.act>[3], input: tasks.ActInput = {}) => as(p, (tx) => tasks.act(tx, p, taskNo, action, input));
const rowOf = async (taskNo: string) => (await ownerPool.query(`select * from task where task_no = $1`, [taskNo])).rows[0];
const eligible = async (p: Person, dept: string, branch = BGW) => (await as(p, (tx) => tasks.assigneesFor(tx, p, dept, branch))).map((a) => `${a.name}:${a.via}`).sort();
const noticesOf = async (taskNo: string, kind?: string) =>
  (await ownerPool.query(`select recipient_user_id as who, event_type as kind from notification where object_type = 'task' and object_id = $1 ${kind ? 'and event_type = $2' : ''} order by id`, kind ? [taskNo, kind] : [taskNo])).rows as { who: string; kind: string }[];
const auditOf = async (taskNo: string) => (await ownerPool.query(`select action from audit_event where object_type = 'task' and object_id = $1 order by id`, [taskNo])).rows.map((r) => r.action as string);

describe('TK1 · who may be given a task', () => {
  it('lists, for a section manager, herself, the section’s members and those who report to her — and no one else', async () => {
    expect(await eligible(fatima, 'FIN')).toEqual([
      'Fatima Finance:self',
      'Khaled Accounts:department',
      'Noor Cashier:department',
      'Rami Operations:report',
      'Sara Ledger:department',
      'Tariq Dispatch:report', // through Khaled
    ]);
  });

  it('does not make a manager everybody’s manager: not an unrelated section, not another branch, not someone with no grant', async () => {
    const names = (await eligible(fatima, 'FIN')).map((n) => n.split(':')[0]);
    for (const outside of ['Omar Operations', 'Gus Erbil', 'Eve Nobody', 'Chief Executive', 'Hana People']) expect(names).not.toContain(outside);
    // Nor in a section that is not hers to raise a task in.
    expect(await as(fatima, (tx) => tasks.sectionsFor(tx, fatima))).toEqual([{ code: 'FIN', name: 'Finance' }]);
    expect(await eligible(fatima, 'OPS')).toEqual([]);
  });

  it('gives a holder of administer the branch, in every section, and still not another branch or a person without the grant', async () => {
    const all = await eligible(ceo, 'OPS');
    expect(all).toContain('Omar Operations:organisation');
    expect(all).toContain('Khaled Accounts:organisation');
    expect(all).toContain('Chief Executive:self');
    expect(all.map((n) => n.split(':')[0])).not.toContain('Gus Erbil');
    expect(all.map((n) => n.split(':')[0])).not.toContain('Eve Nobody');
    expect((await as(ceo, (tx) => tasks.sectionsFor(tx, ceo))).map((s) => s.code).sort()).toEqual(['FIN', 'HRD', 'OPS']);
  });

  it('gives a holder of submit who manages no one only themselves, and an officer nothing at all', async () => {
    expect(await eligible(hana, 'HRD')).toEqual(['Hana People:self']);
    expect(await eligible(hana, 'FIN')).toEqual([]);
    expect(await as(khaled, (tx) => tasks.sectionsFor(tx, khaled))).toEqual([]);
    expect(await eligible(khaled, 'FIN')).toEqual([]);
  });

  it('is one answer for the list, the service and the database', async () => {
    const everyone = (await ownerPool.query(`select id from app_user`)).rows.map((r) => r.id as string);
    for (const [actor, dept] of [[fatima, 'FIN'], [ceo, 'FIN'], [ceo, 'OPS'], [hana, 'HRD'], [khaled, 'FIN']] as const) {
      const listed = new Set((await as(actor, (tx) => tasks.assigneesFor(tx, actor, dept, BGW))).map((a) => a.id));
      for (const candidate of everyone) {
        const via = await as(actor, (tx) => tasks.scopeOf(tx, actor.id, candidate, dept, BGW));
        expect(listed.has(candidate), `${actor.name} → ${candidate} in ${dept}`).toBe(via !== null);
      }
    }
  });

  it('drops a deactivated person from the list', async () => {
    await ownerPool.query(`update app_user set is_active = false where id = $1`, [noor.id]);
    expect((await eligible(fatima, 'FIN')).join()).not.toContain('Noor');
  });
});

describe('TK2 · an assignment outside the scope is refused', () => {
  it('is refused by the service, and leaves no task behind', async () => {
    for (const [stranger, why] of [[omar, /outside the people you may assign/], [gus, /outside the people you may assign/], [eve, /outside the people you may assign/], [ceo, /outside the people you may assign/]] as const) {
      const before = (await ownerPool.query(`select count(*)::int as n from task`)).rows[0].n;
      expect(await rejection(create(fatima, { assigneeId: stranger.id })), stranger.name).toMatch(why);
      expect((await ownerPool.query(`select count(*)::int as n from task`)).rows[0].n).toBe(before);
    }
  });

  it('is refused for a section that is not the assigner’s own', async () => {
    expect(await rejection(create(fatima, { departmentCode: 'OPS', assigneeId: omar.id }))).toMatch(/one of your own sections/);
    expect(await rejection(create(hana, { departmentCode: 'FIN', assigneeId: hana.id }))).toMatch(/one of your own sections/);
  });

  it('is refused to somebody who cannot do the work: no grant, or not in the branch', async () => {
    expect(await rejection(create(ceo, { assigneeId: eve.id }))).toMatch(/outside the people you may assign/);
    expect(await rejection(create(ceo, { assigneeId: gus.id }))).toMatch(/outside the people you may assign/);
  });

  it('is refused to a person with no right to assign at all', async () => {
    expect(await rejection(create(khaled, { assigneeId: khaled.id }))).toMatch(/not allowed|permission|may not/i);
  });

  it('is refused by the trigger when the service is bypassed', async () => {
    const draft = await create(fatima);
    // A raw insert already assigned, to a stranger.
    expect(
      await rejection(
        asApp(scopeOf(fatima), (q) =>
          q(
            `insert into task (task_no, title, status, department_code, branch_code, created_by, assigned_by, assignee_id, assigned_at)
             values ('TASK-901','Out of scope','assigned','FIN',$1,$2,$2,$3, now())`,
            [BGW, fatima.id, omar.id],
          ),
        ),
      ),
    ).toMatch(/outside the scope you may assign|starts as a draft/);
    // A draft given to a stranger.
    expect(await rejection(asApp(scopeOf(fatima), (q) => q(`update task set status='assigned', assignee_id=$2, assigned_by=$3 where task_no=$1`, [draft.taskNo, omar.id, fatima.id])))).toMatch(/outside the scope you may assign/);
    // A draft given to someone in scope, but claiming another person assigned it.
    expect(await rejection(asApp(scopeOf(fatima), (q) => q(`update task set status='assigned', assignee_id=$2, assigned_by=$3 where task_no=$1`, [draft.taskNo, khaled.id, ceo.id])))).toMatch(/assigned by the person assigning it/);
    // The same draft in scope goes through.
    await asApp(scopeOf(fatima), (q) => q(`update task set status='assigned', assignee_id=$2, assigned_by=$3 where task_no=$1`, [draft.taskNo, khaled.id, fatima.id]), { commit: true });
    expect((await rowOf(draft.taskNo)).status).toBe('assigned');
    // And a reassignment to a stranger is refused the same way.
    expect(await rejection(asApp(scopeOf(fatima), (q) => q(`update task set assignee_id=$2 where task_no=$1`, [draft.taskNo, omar.id])))).toMatch(/outside the scope you may assign|only when the task is reassigned/);
  });

  it('is refused by the trigger for a manager of another section giving work to this one', async () => {
    // Hana holds the right to assign, in her own section only: Khaled is outside it.
    const draft = await create(hana, { departmentCode: 'HRD' });
    expect(await rejection(asApp(scopeOf(hana), (q) => q(`update task set status='assigned', assignee_id=$2, assigned_by=$3 where task_no=$1`, [draft.taskNo, khaled.id, hana.id])))).toMatch(/outside the scope you may assign/);
    // And her own section's work to herself is in scope.
    await asApp(scopeOf(hana), (q) => q(`update task set status='assigned', assignee_id=$2, assigned_by=$2 where task_no=$1`, [draft.taskNo, hana.id]), { commit: true });
    expect((await rowOf(draft.taskNo)).assignee_id).toBe(hana.id);
  });

  it('refuses a watcher who could not open the task', async () => {
    const made = await create(fatima, { assigneeId: khaled.id });
    expect(await rejection(as(fatima, (tx) => tasks.setWatchers(tx, fatima, made.taskNo, [eve.id])))).toMatch(/watcher must be somebody who can open the task/);
    expect(await rejection(as(fatima, (tx) => tasks.setWatchers(tx, fatima, made.taskNo, [gus.id])))).toMatch(/watcher must be somebody who can open the task/);
    await as(fatima, (tx) => tasks.setWatchers(tx, fatima, made.taskNo, [noor.id]));
    expect((await rowOf(made.taskNo)).watcher_ids).toEqual([noor.id]);
  });
});

describe('TK3 · the lifecycle', () => {
  it('walks the road, every step audited, and the database stamps the moments', async () => {
    const made = await create(fatima, { assigneeId: khaled.id, priority: 'high', dueDate: today, tags: 'audit, q4' });
    expect(made.taskNo).toMatch(/^TASK-\d{3}$/);
    expect(made.assigned).toBe(true);
    let row = await rowOf(made.taskNo);
    expect(row).toMatchObject({ status: 'assigned', assignee_id: khaled.id, assigned_by: fatima.id, created_by: fatima.id, priority: 'high', branch_code: BGW });
    expect(row.tags).toEqual(['audit', 'q4']);

    await act(khaled, made.taskNo, 'accept');
    await act(khaled, made.taskNo, 'start');
    await act(khaled, made.taskNo, 'block', { reason: 'Waiting for the bank letter' });
    row = await rowOf(made.taskNo);
    expect(row).toMatchObject({ status: 'blocked', status_note: 'Waiting for the bank letter' });
    await act(khaled, made.taskNo, 'resume');
    await act(khaled, made.taskNo, 'submit');
    await act(fatima, made.taskNo, 'complete');
    row = await rowOf(made.taskNo);
    expect(row.status).toBe('completed');
    const stamps = ['assigned_at', 'accepted_at', 'started_at', 'submitted_at', 'completed_at'].map((k) => new Date(row[k]).getTime());
    expect(stamps.every((t) => Number.isFinite(t))).toBe(true);
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);

    expect(await auditOf(made.taskNo)).toEqual(['task.created', 'task.assigned', 'task.accepted', 'task.started', 'task.blocked', 'task.resumed', 'task.submitted', 'task.completed']);
  });

  it('shows each person only the steps they may take', async () => {
    const made = await create(fatima, { assigneeId: khaled.id });
    const view = async (p: Person) => (await as(p, (tx) => tasks.byNo(tx, p, made.taskNo)))?.actions ?? null;
    expect(await view(khaled)).toEqual(['accept', 'reject']);
    expect(await view(fatima)).toEqual(['reassign', 'cancel']);
    expect(await view(ceo)).toEqual(['reassign', 'cancel']);
    expect(await view(omar)).toBeNull();
    await act(khaled, made.taskNo, 'accept');
    await act(khaled, made.taskNo, 'start');
    await act(khaled, made.taskNo, 'submit', { reason: 'Done; see the attached workings' });
    expect(await view(khaled)).toEqual([]);
    expect(await view(fatima)).toEqual(['complete', 'return', 'cancel']);
  });

  it('refuses a step that is not the person’s, or not on the road', async () => {
    const made = await create(fatima, { assigneeId: khaled.id });
    expect(await rejection(act(fatima, made.taskNo, 'accept'))).toMatch(/Only the person it is assigned to can accept/);
    expect(await rejection(act(khaled, made.taskNo, 'complete'))).toMatch(/is assigned; it cannot be completed/);
    await act(khaled, made.taskNo, 'accept');
    expect(await rejection(act(khaled, made.taskNo, 'accept'))).toMatch(/is accepted; it cannot be accepted/);
    await act(khaled, made.taskNo, 'start');
    await act(khaled, made.taskNo, 'submit');
    expect(await rejection(act(khaled, made.taskNo, 'complete'))).toMatch(/Only the person who assigned it/);
    expect(await rejection(act(omar, made.taskNo, 'return', { reason: 'x' }))).toMatch(/No task '/);
  });

  it('wants a reason where the road asks for one', async () => {
    const made = await create(fatima, { assigneeId: khaled.id });
    expect(await rejection(act(khaled, made.taskNo, 'reject'))).toMatch(/Say why before the task is rejected/);
    await act(khaled, made.taskNo, 'accept');
    await act(khaled, made.taskNo, 'start');
    expect(await rejection(act(khaled, made.taskNo, 'block', { reason: '  ' }))).toMatch(/Say why before the task is blocked/);
    await act(khaled, made.taskNo, 'submit');
    expect(await rejection(act(fatima, made.taskNo, 'return'))).toMatch(/Say why before the task is returned/);
    await act(fatima, made.taskNo, 'return', { reason: 'The Erbil lines are missing' });
    expect((await rowOf(made.taskNo)).status).toBe('in_progress');
    expect(await rejection(act(fatima, made.taskNo, 'cancel'))).toMatch(/Say why before the task is cancelled/);
  });

  it('lets an assignee decline and the assigner hand it on — to someone in scope only', async () => {
    const made = await create(fatima, { assigneeId: khaled.id });
    await act(khaled, made.taskNo, 'reject', { reason: 'On leave next week' });
    expect(await rowOf(made.taskNo)).toMatchObject({ status: 'rejected', status_note: 'On leave next week' });
    expect(await rejection(act(fatima, made.taskNo, 'reassign', { reason: 'Hand on', assigneeId: omar.id }))).toMatch(/outside the people you may assign/);
    await act(fatima, made.taskNo, 'reassign', { reason: 'Sara has capacity', assigneeId: sara.id });
    expect(await rowOf(made.taskNo)).toMatchObject({ status: 'assigned', assignee_id: sara.id, assigned_by: fatima.id, accepted_at: null });
    expect(await auditOf(made.taskNo)).toContain('task.reassigned');
  });

  it('is held by the trigger too: a jump, a forged moment, someone else’s step', async () => {
    const made = await create(fatima, { assigneeId: khaled.id });
    expect(await rejection(asApp(scopeOf(khaled), (q) => q(`update task set status='completed' where task_no=$1`, [made.taskNo])))).toMatch(/cannot become completed/);
    // The moment is the database's, whatever the statement says.
    await asApp(scopeOf(khaled), (q) => q(`update task set status='accepted', accepted_at='2001-01-01' where task_no=$1`, [made.taskNo]), { commit: true });
    const row = await rowOf(made.taskNo);
    expect(new Date(row.accepted_at).getFullYear()).toBeGreaterThanOrEqual(new Date().getFullYear() - 1);
    await asApp(scopeOf(khaled), (q) => q(`update task set status='in_progress' where task_no=$1`, [made.taskNo]), { commit: true });
    await asApp(scopeOf(khaled), (q) => q(`update task set status='submitted' where task_no=$1`, [made.taskNo]), { commit: true });
    // The assignee cannot complete their own hand-in.
    expect(await rejection(asApp(scopeOf(khaled), (q) => q(`update task set status='completed' where task_no=$1`, [made.taskNo])))).toMatch(/only the person who assigned it completes it or returns it/);
    // Returning without a reason.
    expect(await rejection(asApp(scopeOf(fatima), (q) => q(`update task set status='in_progress' where task_no=$1`, [made.taskNo])))).toMatch(/say why|task_note_required|reason/i);
    // The creator, number and branch never change.
    expect(await rejection(asApp(scopeOf(fatima), (q) => q(`update task set created_by=$2 where task_no=$1`, [made.taskNo, khaled.id])))).toMatch(/never change/);
    expect(await rejection(asApp(scopeOf(fatima), (q) => q(`update task set task_no='TASK-999' where task_no=$1`, [made.taskNo])))).toMatch(/never change/);
  });

  it('keeps a completed or cancelled task as it is, and never deletes one', async () => {
    const made = await create(fatima, { assigneeId: khaled.id });
    await act(fatima, made.taskNo, 'cancel', { reason: 'No longer needed' });
    expect(await rowOf(made.taskNo)).toMatchObject({ status: 'cancelled', status_note: 'No longer needed' });
    expect(await rejection(act(fatima, made.taskNo, 'cancel', { reason: 'again' }))).toMatch(/is cancelled; it cannot be cancelled/);
    expect(await rejection(asApp(scopeOf(fatima), (q) => q(`update task set title='Renamed' where task_no=$1`, [made.taskNo])))).toMatch(/is cancelled and is final/);
    expect(await rejection(ownerPool.query(`delete from task where task_no = $1`, [made.taskNo]))).toMatch(/never deleted/);
    expect(await rejection(asApp(scopeOf(fatima), (q) => q(`delete from task where task_no = $1`, [made.taskNo])))).toMatch(/permission denied|never deleted/);
  });

  it('moves once when pressed twice', async () => {
    const made = await create(fatima, { assigneeId: khaled.id });
    const results = await Promise.allSettled([act(khaled, made.taskNo, 'accept'), act(khaled, made.taskNo, 'accept')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await auditOf(made.taskNo)).filter((a) => a === 'task.accepted')).toHaveLength(1);
    expect(await noticesOf(made.taskNo, 'task.accepted')).toHaveLength(1);
  });

  it('keeps a draft private to its raiser until it is assigned, and lets only the raiser assign it', async () => {
    const draft = await create(fatima);
    expect(draft.assigned).toBe(false);
    expect((await rowOf(draft.taskNo)).status).toBe('draft');
    expect(await as(fatima, (tx) => tasks.byNo(tx, fatima, draft.taskNo))).not.toBeNull();
    expect(await rejection(act(ceo, draft.taskNo, 'assign', { assigneeId: khaled.id }))).toMatch(/No task '/);
    await act(fatima, draft.taskNo, 'assign', { assigneeId: sara.id });
    expect((await rowOf(draft.taskNo)).assignee_id).toBe(sara.id);
  });

  it('keeps what a task says to its raiser, assigner and an administrator, and refuses a deadline in the past', async () => {
    const made = await create(fatima, { assigneeId: khaled.id, dueDate: today });
    expect(await rejection(as(khaled, (tx) => tasks.amend(tx, khaled, made.taskNo, { title: 'My own title' })))).toMatch(/Only the person who raised or assigned/);
    await as(fatima, (tx) => tasks.amend(tx, fatima, made.taskNo, { title: 'Reconcile the Erbil statement (revised)', priority: 'urgent' }));
    expect(await rowOf(made.taskNo)).toMatchObject({ title: 'Reconcile the Erbil statement (revised)', priority: 'urgent' });
    expect(await rejection(as(fatima, (tx) => tasks.amend(tx, fatima, made.taskNo, { dueDate: '2001-01-01' })))).toMatch(/already passed/);
    expect(await auditOf(made.taskNo)).toContain('task.updated');
    // The assignee hears that the work changed.
    expect((await noticesOf(made.taskNo, 'task.updated')).map((n) => n.who)).toEqual([khaled.id]);
  });
});

describe('TK4 · who can see a task', () => {
  const countAs = async (p: Person, taskNo: string) => (await asApp(scopeOf(p), (q) => q(`select count(*)::int as n from task where task_no = $1`, [taskNo]))).rows[0].n as number;

  it('shows a draft to its raiser alone — an administrator included', async () => {
    const draft = await create(fatima);
    expect(await countAs(fatima, draft.taskNo)).toBe(1);
    for (const other of [ceo, khaled, omar, hana]) expect(await countAs(other, draft.taskNo), other.name).toBe(0);
  });

  it('shows an assigned task to the parties, the section’s manager, those the assignee reports to, and an administrator', async () => {
    const made = await create(fatima, { assigneeId: tariq.id }); // Tariq is OPS; he reports to Khaled, who reports to Fatima
    const seen: Record<string, number> = {};
    for (const p of [fatima, tariq, khaled, ceo, sara, noor, rami, omar, hana, gus, eve]) seen[p.name] = await countAs(p, made.taskNo);
    expect(seen).toEqual({
      'Fatima Finance': 1, // assigned it
      'Tariq Dispatch': 1, // it is his
      'Khaled Accounts': 1, // Tariq reports to him
      'Chief Executive': 1, // administer
      'Sara Ledger': 0,
      'Noor Cashier': 0,
      'Rami Operations': 0,
      'Omar Operations': 0,
      'Hana People': 0,
      'Gus Erbil': 0,
      'Eve Nobody': 0,
    });
  });

  it('shows it to a named watcher, and to no one when the watcher is removed', async () => {
    const made = await create(fatima, { assigneeId: khaled.id });
    expect(await countAs(noor, made.taskNo)).toBe(0);
    await as(fatima, (tx) => tasks.setWatchers(tx, fatima, made.taskNo, [noor.id]));
    expect(await countAs(noor, made.taskNo)).toBe(1);
    await as(fatima, (tx) => tasks.setWatchers(tx, fatima, made.taskNo, []));
    expect(await countAs(noor, made.taskNo)).toBe(0);
  });

  it('answers “not found” for a task the person may not open, in the service and in the list', async () => {
    const made = await create(fatima, { assigneeId: khaled.id });
    expect(await as(omar, (tx) => tasks.byNo(tx, omar, made.taskNo))).toBeNull();
    const list = await as(omar, (tx) => tasks.listForScreen(tx, omar, { view: 'mine' }));
    expect(list.rows).toEqual([]);
    expect(await as(omar, (tx) => tasks.listForScreen(tx, omar, { view: 'team' })).then((r) => r.rows)).toEqual([]);
  });

  it('shows the assignee “my tasks” and the assigner “assigned by me”, with the buckets counted', async () => {
    const soon = await create(fatima, { assigneeId: khaled.id, dueDate: today });
    await create(fatima, { assigneeId: khaled.id });
    const mine = await as(khaled, (tx) => tasks.listForScreen(tx, khaled, { view: 'mine' }));
    expect(mine.rows).toHaveLength(2);
    expect(mine.rows[0]!.taskNo).toBe(soon.taskNo);
    expect(mine.rows[0]).toMatchObject({ dueState: 'today', status: 'assigned', progress: 10 });
    const counts = await as(khaled, (tx) => tasks.countsFor(tx, khaled, 'mine'));
    expect(counts).toMatchObject({ all: 2, open: 2, today: 1, overdue: 0, blocked: 0, completed: 0 });
    const given = await as(fatima, (tx) => tasks.listForScreen(tx, fatima, { view: 'assigned' }));
    expect(given.rows.map((r) => r.assigneeName)).toEqual(['Khaled Accounts', 'Khaled Accounts']);
    const team = await as(fatima, (tx) => tasks.teamWorkload(tx, fatima));
    expect(team).toEqual([expect.objectContaining({ assigneeName: 'Khaled Accounts', departmentCode: 'FIN', open: 2, overdue: 0 })]);
    expect(await as(fatima, (tx) => tasks.leadsAnyone(tx, fatima))).toBe(true);
    // Khaled leads Tariq (the employee record says so); Sara leads nobody.
    expect(await as(khaled, (tx) => tasks.leadsAnyone(tx, khaled))).toBe(true);
    expect(await as(sara, (tx) => tasks.leadsAnyone(tx, sara))).toBe(false);
    expect(await as(omar, (tx) => tasks.leadsAnyone(tx, omar))).toBe(false);
    expect(await as(ceo, (tx) => tasks.leadsAnyone(tx, ceo))).toBe(true);
  });
});

describe('TK5 · notices', () => {
  it('tells the assignee of the work, the assigner of the answer, and never the person who acted', async () => {
    const made = await create(fatima, { assigneeId: khaled.id });
    expect((await noticesOf(made.taskNo)).map((n) => [n.kind, n.who])).toEqual([['task.assigned', khaled.id]]);
    await act(khaled, made.taskNo, 'accept');
    await act(khaled, made.taskNo, 'start');
    await act(khaled, made.taskNo, 'block', { reason: 'Waiting for the bank letter' });
    const toFatima = (await noticesOf(made.taskNo)).filter((n) => n.who === fatima.id).map((n) => n.kind);
    expect(toFatima).toEqual(['task.accepted', 'task.started', 'task.blocked']);
    expect((await noticesOf(made.taskNo)).some((n) => n.who === khaled.id && n.kind !== 'task.assigned')).toBe(false);
    const row = (await ownerPool.query(`select subject, body, context, branch_code from notification where object_id = $1 and event_type = 'task.blocked'`, [made.taskNo])).rows[0];
    expect(row.subject).toContain(made.taskNo);
    expect(row.body).toContain('Waiting for the bank letter');
    expect(row.context).toMatchObject({ taskNo: made.taskNo, href: `/tasks/${made.taskNo}` });
    expect(row.branch_code).toBe(BGW);
  });

  it('tells a watcher, and leaves out someone who can no longer open the task', async () => {
    const made = await create(fatima, { assigneeId: khaled.id, watcherIds: [noor.id] });
    expect((await noticesOf(made.taskNo, 'task.assigned')).map((n) => n.who).sort()).toEqual([khaled.id, noor.id].sort());
    // Handing it to Sara takes it out of Khaled's sight, so Khaled is not told what he can no longer open.
    await act(fatima, made.taskNo, 'reassign', { reason: 'Sara has capacity', assigneeId: sara.id });
    const told = (await noticesOf(made.taskNo, 'task.reassigned')).map((n) => n.who);
    expect(told).toContain(sara.id);
    expect(told).toContain(noor.id);
    expect(told).not.toContain(fatima.id);
    expect(told).not.toContain(khaled.id);
  });

  it('raises each sweep notice once, to the people it is for', async () => {
    const soon = await create(fatima, { assigneeId: sara.id, dueDate: today });
    const late = await create(fatima, { assigneeId: khaled.id, dueDate: today });
    const draft = await create(fatima, { dueDate: today });
    await ownerPool.query(`update task set due_date = ($2::date - 5) where task_no = $1`, [late.taskNo, today]);
    // A system operator by role only, not a flagged super user.
    const operator = await person('Operator', { roles: ['system_administrator'] });
    const sweep = () => withScope({ userId: operator.id, branchCode: BGW, isSuperUser: true }, (tx) => taskSweep.run(tx, today));

    const first = await sweep();
    expect(first).toMatchObject({ dueSoon: 1, overdue: 1 });
    expect(first.created).toBeGreaterThanOrEqual(3);
    expect((await noticesOf(soon.taskNo, 'task.due_soon')).map((n) => n.who)).toEqual([sara.id]);
    expect((await noticesOf(late.taskNo, 'task.overdue')).map((n) => n.who).sort()).toEqual([khaled.id, fatima.id].sort());
    expect(await noticesOf(draft.taskNo)).toEqual([]);

    const again = await sweep();
    expect(again.created).toBe(0);
    // A week later it is late again, and is raised again.
    const nextWeek = await withScope({ userId: operator.id, branchCode: BGW, isSuperUser: true }, (tx) => taskSweep.run(tx, new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10)));
    expect(nextWeek.created).toBeGreaterThan(0);
  });

  it('reads the notices only through the notification service', async () => {
    const made = await create(fatima, { assigneeId: khaled.id });
    const kinds = (await ownerPool.query(`select distinct event_type from notification where object_type = 'task'`)).rows.map((r) => r.event_type as string);
    expect(kinds).toEqual(['task.assigned']);
    expect((await ownerPool.query(`select count(*)::int as n from notification where object_id = $1 and dedupe_key is not null`, [made.taskNo])).rows[0].n).toBe(1);
  });
});

describe('TK6 · the Dashboard and the Exceptions feeds', () => {
  it('summarises a person’s queue, what they gave out, and their team', async () => {
    const a = await create(fatima, { assigneeId: khaled.id, dueDate: today });
    const b = await create(fatima, { assigneeId: khaled.id });
    await act(khaled, a.taskNo, 'accept');
    await act(khaled, a.taskNo, 'start');
    await act(khaled, a.taskNo, 'submit');
    await act(khaled, b.taskNo, 'accept');
    await act(khaled, b.taskNo, 'start');
    await act(khaled, b.taskNo, 'block', { reason: 'Waiting' });

    const mine = await as(khaled, (tx) => tasks.dashboardSummary(tx, khaled, today));
    expect(mine.available).toBe(true);
    expect(mine.mine).toMatchObject({ open: 1, blocked: 1 });
    expect(mine.team).toEqual({ open: 0, overdue: 0, blocked: 0 }); // he leads Tariq, who has nothing yet
    expect((await as(sara, (tx) => tasks.dashboardSummary(tx, sara, today))).team).toBeNull();
    expect(mine.next.map((n) => n.taskNo)).toEqual([b.taskNo]);

    const boss = await as(fatima, (tx) => tasks.dashboardSummary(tx, fatima, today));
    expect(boss.assignedByMe).toMatchObject({ waitingForMe: 1, blocked: 1 });
    expect(boss.team).toMatchObject({ blocked: 1 });
    expect(boss.next).toEqual([]);

    expect((await as(fatima, (tx) => tasks.blockedTasks(tx, fatima))).map((t) => t.taskNo)).toEqual([b.taskNo]);
    expect(await as(omar, (tx) => tasks.blockedTasks(tx, omar))).toEqual([]);
  });

  it('is empty for a person with no access to tasks', async () => {
    await create(fatima, { assigneeId: khaled.id, dueDate: today });
    const none = await as(eve, (tx) => tasks.dashboardSummary(tx, eve, today));
    expect(none).toMatchObject({ available: false, team: null, next: [] });
    expect(none.mine).toEqual({ open: 0, dueToday: 0, dueSoon: 0, overdue: 0, blocked: 0 });
    expect(await as(eve, (tx) => tasks.overdueTasks(tx, eve))).toEqual([]);
  });

  it('lists an overdue task to those who may see it and not to others', async () => {
    const late = await create(fatima, { assigneeId: khaled.id, dueDate: today });
    await ownerPool.query(`update task set due_date = ($2::date - 3) where task_no = $1`, [late.taskNo, today]);
    const feed = await as(fatima, (tx) => tasks.overdueTasks(tx, fatima, 50, today));
    expect(feed).toEqual([expect.objectContaining({ taskNo: late.taskNo, daysLate: 3, href: `/tasks/${late.taskNo}` })]);
    expect(await as(omar, (tx) => tasks.overdueTasks(tx, omar, 50, today))).toEqual([]);
    expect((await as(ceo, (tx) => tasks.overdueTasks(tx, ceo, 50, today))).map((t) => t.taskNo)).toEqual([late.taskNo]);
  });
});

describe('TK7 · the platform pieces a task joins', () => {
  it('is found by Global Search by number, by those who may open it', async () => {
    const made = await create(fatima, { assigneeId: khaled.id });
    const found = (p: Person, query = made.taskNo) => globalSearch.searchAs(scopeOf(p) as never, p.principal, { query });
    const taskGroup = async (p: Person) => (await found(p)).groups.find((g) => g.key === 'task')?.rows.map((r) => r.number) ?? [];
    expect(await taskGroup(khaled)).toEqual([made.taskNo]);
    expect(await taskGroup(fatima)).toEqual([made.taskNo]);
    expect(await taskGroup(ceo)).toEqual([made.taskNo]);
    expect(await taskGroup(omar)).toEqual([]);
    expect(await taskGroup(eve)).toEqual([]);
    const row = (await found(khaled)).groups.find((g) => g.key === 'task')!.rows[0]!;
    expect(row.href).toBe(`/tasks/${made.taskNo}`);
    // By its serial, as the other documents are.
    const serial = String(Number(made.taskNo.slice(5)));
    expect((await found(khaled, `TASK-${serial}`)).groups.some((g) => g.key === 'task')).toBe(true);
    // A draft is found by its raiser alone.
    const draft = await create(fatima);
    expect(await taskGroup(ceo).then(() => found(ceo, draft.taskNo)).then((o) => o.groups.some((g) => g.key === 'task'))).toBe(false);
    expect((await found(fatima, draft.taskNo)).groups.some((g) => g.key === 'task')).toBe(true);
  });

  it('keeps notes and files to the people who can open the task', async () => {
    const made = await create(fatima, { assigneeId: khaled.id });
    await as(khaled, (tx) => recordNotes.addNote(tx, khaled, { object: 'task', recordId: made.taskNo, body: 'Started on the Erbil lines' }));
    expect((await as(fatima, (tx) => recordNotes.listNotes(tx, { object: 'task', recordId: made.taskNo }))).map((n) => n.body)).toEqual(['Started on the Erbil lines']);
    expect(await rejection(as(omar, (tx) => recordNotes.addNote(tx, omar, { object: 'task', recordId: made.taskNo, body: 'Hello' })))).toMatch(/No such record/);

    const id = (await rowOf(made.taskNo)).id as string;
    await as(khaled, (tx) => attachments.upload(tx, khaled, { objectType: 'task', objectId: id, fileName: 'workings.pdf', content: Buffer.from('%PDF-1.4 workings') }));
    expect(await rejection(as(omar, (tx) => attachments.upload(tx, omar, { objectType: 'task', objectId: id, fileName: 'x.pdf', content: Buffer.from('%PDF-1.4 x') })))).toBeTruthy();
    const listed = await as(fatima, (tx) => attachments.currentFor(tx, 'task', id));
    expect(listed.map((f) => f.fileName)).toEqual(['workings.pdf']);
  });

  it('names a record it is about only if the raiser may open it, and links only for those who may open that record', async () => {
    const first = await create(fatima, { assigneeId: khaled.id });
    // Hana cannot open Fatima's task, so she cannot say a task is about it.
    expect(await rejection(create(hana, { departmentCode: 'HRD', relatedType: 'task', relatedNo: first.taskNo }))).toMatch(/There is no task '.*' that you may open/);
    expect(await rejection(create(hana, { departmentCode: 'HRD', relatedType: 'task' }))).toMatch(/Name the kind of record and its number/);
    // Fatima can; the link shows for her, and not for someone who cannot open the related record.
    const about = await create(fatima, { assigneeId: sara.id, relatedType: 'task', relatedNo: first.taskNo, watcherIds: [noor.id] });
    const forFatima = await as(fatima, (tx) => tasks.byNo(tx, fatima, about.taskNo));
    expect(forFatima!.related).toMatchObject({ type: 'task', label: first.taskNo, href: `/tasks/${first.taskNo}` });
    const forSara = await as(sara, (tx) => tasks.byNo(tx, sara, about.taskNo));
    expect(forSara!.related).toMatchObject({ label: first.taskNo, href: null });
    // A task is not about itself.
    expect(await rejection(as(fatima, (tx) => tasks.amend(tx, fatima, about.taskNo, { relatedType: 'task', relatedNo: about.taskNo })))).toMatch(/related to itself/);
  });

  it('opens a conversation about the task in the same transaction, for the two people on it, and for no outsider', async () => {
    const made = await create(fatima, { assigneeId: khaled.id });
    const opened = await as(fatima, (tx) => tasks.openChat(tx, fatima, made.taskNo));
    expect(opened.counterpartId).toBe(khaled.id);
    const conversation = (await ownerPool.query(`select record_type, record_id, record_label, record_href from chat_conversation where id = $1`, [opened.conversationId])).rows[0];
    expect(conversation).toMatchObject({ record_type: 'task', record_id: (await rowOf(made.taskNo)).id, record_label: made.taskNo, record_href: `/tasks/${made.taskNo}` });
    // The same conversation is found again, from the other side.
    const again = await as(khaled, (tx) => tasks.openChat(tx, khaled, made.taskNo));
    expect(again.conversationId).toBe(opened.conversationId);
    // Nothing is sent by opening it.
    expect((await ownerPool.query(`select count(*)::int as n from chat_message where conversation_id = $1`, [opened.conversationId])).rows[0].n).toBe(0);
    // Someone who cannot open the task cannot open a conversation about it.
    expect(await rejection(as(omar, (tx) => tasks.openChat(tx, omar, made.taskNo)))).toMatch(/No task '/);
  });

  it('reads the task’s print model for those who may see it and refuses the rest', async () => {
    const made = await create(fatima, { assigneeId: khaled.id, description: 'Match every line of the March statement.' });
    const { prepareExport } = await import('@/server/print/export');
    const request = { key: 'task', format: 'pdf', locale: 'en', input: { id: made.taskNo, query: new URLSearchParams() } } as never;
    const mine = await withScope(scopeOf(khaled), (tx) => prepareExport(tx, { principal: khaled.principal, branchCode: BGW }, request));
    expect(mine.status).toBe(200);
    const text = JSON.stringify((mine as { model: unknown }).model);
    expect(text).toContain(made.taskNo);
    expect(text).toContain('Match every line of the March statement.');
    const theirs = await withScope(scopeOf(omar), (tx) => prepareExport(tx, { principal: omar.principal, branchCode: BGW }, request));
    expect(theirs.status).toBe(404);
    const nobody = await withScope(scopeOf(eve), (tx) => prepareExport(tx, { principal: eve.principal, branchCode: BGW }, request));
    expect(nobody.status).toBe(404);
  });
});
