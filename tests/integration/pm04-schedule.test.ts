/**
 * REQ-PM-001 Stage PM-4 — schedule, progress, earned value.
 *
 *   PM8 `pm04-scheduling`  — the forward pass gives every activity its
 *                            earliest dates and float from the dependencies
 *                            and the calendar; the critical path has zero
 *                            float; a milestone of usage `progress` sets the
 *                            element's percent when it is reached and
 *                            approved by somebody else.
 *   PM9 `pm04-earned-value` — BCWS, BCWP, ACWP, CPI, SPI and EAC follow §10
 *                            from the plan spread, approved progress and
 *                            actuals, element by element and rolled up.
 *   PM3 (completed)        — technical completion refuses while an activity
 *                            is open.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as projects from '@/server/services/projects';
import * as pb from '@/server/services/project-budget';
import * as psch from '@/server/services/project-schedule';
import * as ps from '@/server/services/project-system';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseDecimal } from '@domain/money';

const BAGHDAD = 'BGW';
const price = (v: string) => parseDecimal(v, 4n);
let engineer: ActorContext;
let manager: ActorContext;
let releaser: ActorContext;
let seq = 0;

async function createUser(role: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [id, `${id}@example.com`, `${role}-${(seq += 1)}`]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BAGHDAD]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BAGHDAD };
}
const as = <T>(ctx: ActorContext, fn: (tx: Parameters<Parameters<typeof withScope>[1]>[0]) => Promise<T>) => withScope({ userId: ctx.principal.userId, branchCode: BAGHDAD }, fn);

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  engineer = await createUser('project_manager');
  manager = await createUser('accounting_manager');
  releaser = await createUser('accounting_manager');
  // A Sunday–Thursday week with Thursday 8 October 2026 a holiday.
  await ownerPool.query(`insert into working_calendar (code, name_en, year, working_days, created_by) values ('PM4-2026','PM-4 test',2026,'sun,mon,tue,wed,thu',$1)`, [manager.principal.userId]);
  await ownerPool.query(`insert into working_calendar_holiday (calendar_code, holiday_date, name_en) values ('PM4-2026','2026-10-08','Holiday')`);
});

/** Released, counting in the test calendar from Sunday 4 October, with Civil (budget 1,000,000) and Steel (500,000). */
async function staged() {
  const { projectCode } = await as(engineer, (tx) =>
    ps.createDefinition(tx, engineer, { name: 'Hangar', typeCode: 'INTERNAL', code: 'HANGAR', branchCode: BAGHDAD, managerUserId: manager.principal.userId, baselineStartsOn: '2026-10-04', baselineEndsOn: '2026-12-31' }),
  );
  const root = `${projectCode}-1`;
  const civil = (await as(engineer, (tx) => ps.addElement(tx, engineer, projectCode, { parentCode: root, name: 'Civil' }))).code;
  const steel = (await as(engineer, (tx) => ps.addElement(tx, engineer, projectCode, { parentCode: root, name: 'Steel' }))).code;
  await as(engineer, (tx) => psch.setCalendar(tx, engineer, projectCode, 'PM4-2026'));
  await as(releaser, (tx) => ps.release(tx, releaser, projectCode));
  const doc = await as(engineer, (tx) => pb.createBudgetDocument(tx, engineer, projectCode, { kind: 'original', description: 'Tender', lines: [{ wbsCode: civil, costCode: 'SUB', amountIqd: '1000000' }, { wbsCode: steel, costCode: 'MAT', amountIqd: '500000' }] }));
  await as(engineer, (tx) => pb.submitBudgetDocument(tx, engineer, doc.documentNo));
  await as(releaser, (tx) => pb.approveBudgetDocument(tx, releaser, doc.documentNo));
  return { projectCode, root, civil, steel };
}

/** The hand-worked network of tests/unit/pm04-project-schedule.test.ts, on two elements. */
async function network(projectCode: string, civil: string, steel: string) {
  const add = (wbsCode: string, name: string, durationDays: number | null, extra: Partial<psch.ActivityInput> = {}) =>
    as(engineer, (tx) => psch.addActivity(tx, engineer, projectCode, { wbsCode, name, ...(durationDays === null ? { kind: 'milestone', milestoneUsage: 'progress', progressPercent: '100' } : { durationDays }), ...extra }));
  const a = await add(civil, 'Survey', 3);
  const b = await add(civil, 'Foundations', 5);
  const c = await add(steel, 'Order steel', 2);
  const d = await add(steel, 'Steel frame', 4);
  const m = await add(steel, 'Frame complete', null);
  const e = await add(steel, 'Cladding', 3);
  const link = (p: string, s: string, kind = 'FS', lagDays = 0) => as(engineer, (tx) => psch.addDependency(tx, engineer, projectCode, { predecessorCode: p, successorCode: s, kind, lagDays }));
  await link(a.code, b.code);
  await link(a.code, c.code, 'SS', 1);
  await link(b.code, d.code);
  await link(c.code, d.code);
  await link(d.code, m.code);
  await link(m.code, e.code);
  return { a: a.code, b: b.code, c: c.code, d: d.code, m: m.code, e: e.code };
}

describe('PM8 · pm04-scheduling — the critical path, the milestones and their trend', () => {
  it('codes activities A0010…, schedules them in the project calendar, and marks the critical path', async () => {
    const { projectCode, civil, steel } = await staged();
    const n = await network(projectCode, civil, steel);
    expect(Object.values(n)).toEqual(['A0010', 'A0020', 'A0030', 'A0040', 'A0050', 'A0060']);
    const result = await as(engineer, (tx) => psch.scheduleProject(tx, engineer, projectCode, 'first plan'));
    expect(result).toEqual({ finish: '2026-10-25', criticalPath: ['A0010', 'A0020', 'A0040', 'A0050', 'A0060'], run: 1 });
    const { activities } = await as(engineer, (tx) => psch.activities(tx, projectCode));
    const by = Object.fromEntries(activities.map((x) => [x.code, x]));
    expect(by.A0020).toMatchObject({ earliestStart: '2026-10-07', earliestFinish: '2026-10-14', totalFloat: 0, isCritical: true });
    expect(by.A0030).toMatchObject({ earliestStart: '2026-10-05', latestStart: '2026-10-13', totalFloat: 5, isCritical: false });
    expect(by.A0050).toMatchObject({ kind: 'milestone', earliestFinish: '2026-10-20', isCritical: true });
    const { rows } = await ownerPool.query(`select schedule_run, scheduled_finish_on::text as f from project where code = $1`, [projectCode]);
    expect(rows[0]).toEqual({ schedule_run: 1, f: '2026-10-25' });

    // A loop is refused; a cancelled activity leaves the schedule; a re-plan writes a second trend row.
    expect(await rejection(as(engineer, (tx) => psch.addDependency(tx, engineer, projectCode, { predecessorCode: n.e, successorCode: n.a })))).toMatch(/loop/);
    expect(await rejection(as(engineer, (tx) => psch.addDependency(tx, engineer, projectCode, { predecessorCode: n.a, successorCode: n.b })))).toMatch(/already linked/);
    await as(engineer, (tx) => psch.updateActivity(tx, engineer, projectCode, n.b, { durationDays: 7 }));
    const replanned = await as(engineer, (tx) => psch.scheduleProject(tx, engineer, projectCode, 'foundations longer'));
    expect(replanned.finish).toBe('2026-10-27');
    const trend = await as(engineer, (tx) => psch.milestoneTrend(tx, projectCode));
    expect(trend.runs).toEqual([1, 2]);
    expect(trend.milestones[0]).toMatchObject({ code: n.m, dates: ['2026-10-20', '2026-10-22'], slipDays: 2 });
    // The trend is history: a row is not rewritten.
    expect(await rejection(ownerPool.query(`update project_milestone_history set scheduled_on = '2026-01-01' where project_code = $1`, [projectCode]))).toMatch(/history/);
  });

  it('a progress milestone reached by one person and approved by another sets the element percent', async () => {
    const { projectCode, civil, steel } = await staged();
    const n = await network(projectCode, civil, steel);
    await as(engineer, (tx) => psch.scheduleProject(tx, engineer, projectCode));
    expect(await rejection(as(engineer, (tx) => psch.reachMilestone(tx, engineer, projectCode, n.a, '2026-10-01')))).toMatch(/not a milestone/);
    expect(await rejection(as(engineer, (tx) => psch.reachMilestone(tx, engineer, projectCode, n.m, '2099-01-01')))).toMatch(/day that has come/);
    await as(engineer, (tx) => psch.reachMilestone(tx, engineer, projectCode, n.m, '2026-10-01'));
    expect(await rejection(as(engineer, (tx) => psch.approveMilestone(tx, engineer, projectCode, n.m)))).toMatch(/denied|by you/i);
    expect(await rejection(as(engineer, (tx) => psch.cancelActivity(tx, engineer, projectCode, n.m, 'x')))).toMatch(/reported reached/);
    await as(manager, (tx) => psch.approveMilestone(tx, manager, projectCode, n.m));
    const { rows } = await ownerPool.query(`select wbs_code, measured_on::text as on, percent_complete::text as pct, measured_by, approved_by, activity_id is not null as from_milestone from project_progress where project_code = $1`, [projectCode]);
    expect(rows).toEqual([{ wbs_code: steel, on: '2026-10-01', pct: '100.0000', measured_by: engineer.principal.userId, approved_by: manager.principal.userId, from_milestone: true }]);
    const { activities } = await as(engineer, (tx) => psch.activities(tx, projectCode));
    expect(activities.find((x) => x.code === n.m)).toMatchObject({ status: 'done', reachedOn: '2026-10-01' });
  });

  it('PM3 — technical completion waits for every activity done and every milestone reached or cancelled', async () => {
    const { projectCode, civil } = await staged();
    const work = await as(engineer, (tx) => psch.addActivity(tx, engineer, projectCode, { wbsCode: civil, name: 'Pour slab', durationDays: 2 }));
    const date = await as(engineer, (tx) => psch.addActivity(tx, engineer, projectCode, { wbsCode: civil, name: 'Handover', kind: 'milestone', milestoneUsage: 'date' }));
    expect(await rejection(as(manager, (tx) => ps.technicalComplete(tx, manager, projectCode)))).toMatch(new RegExp(`open work: ${work.code}, ${date.code}`));
    expect(await rejection(as(engineer, (tx) => psch.recordActual(tx, engineer, projectCode, work.code, { percentComplete: '40' })))).toMatch(/names the day it started/);
    await as(engineer, (tx) => psch.recordActual(tx, engineer, projectCode, work.code, { actualStart: '2026-09-28', percentComplete: '40' }));
    expect(await rejection(as(engineer, (tx) => psch.recordActual(tx, engineer, projectCode, work.code, { percentComplete: '100' })))).toMatch(/names the day it finished/);
    await as(engineer, (tx) => psch.recordActual(tx, engineer, projectCode, work.code, { actualFinish: '2026-09-30' }));
    await as(engineer, (tx) => psch.cancelActivity(tx, engineer, projectCode, date.code, 'handover is the contract close'));
    await as(manager, (tx) => ps.technicalComplete(tx, manager, projectCode));
    const { rows } = await ownerPool.query(`select status from project where code = $1`, [projectCode]);
    expect(rows[0]!.status).toBe('closing');
  });
});

describe('PM9 · pm04-earned-value — §10 element by element and rolled up', () => {
  it('BCWS from the plan, BCWP from approved progress × budget, ACWP from costs; CPI, SPI, EAC, VAC; parents from money, not ratios', async () => {
    const { projectCode, root, civil, steel } = await staged();
    // The plan: Civil 1,000,000 spread over Sep–Dec (250,000 a month); Steel 500,000 in November.
    await as(engineer, (tx) => pb.createPlanVersion(tx, engineer, projectCode, { name: 'Plan' }));
    await as(engineer, (tx) => pb.spreadPlan(tx, engineer, projectCode, { wbsCode: civil, costCode: 'SUB', from: '2026-09-01', to: '2026-12-31', totalIqd: '1000000' }));
    await as(engineer, (tx) => pb.setPlanLine(tx, engineer, projectCode, { wbsCode: steel, costCode: 'MAT', period: '2026-11-01', amountIqd: '500000' }));
    // Civil measured at 40 % by the engineer, approved by the manager; a later unapproved 90 % does not count.
    const m1 = await as(engineer, (tx) => psch.measure(tx, engineer, projectCode, { wbsCode: civil, measuredOn: '2026-09-30', percentComplete: '40' }));
    await as(manager, (tx) => projects.approveProgress(tx, manager, m1.id));
    await as(engineer, (tx) => psch.measure(tx, engineer, projectCode, { wbsCode: civil, measuredOn: '2026-10-01', percentComplete: '90' }));
    expect(await rejection(as(engineer, (tx) => psch.measure(tx, engineer, projectCode, { wbsCode: civil, measuredOn: '2026-10-01', percentComplete: '95' })))).toMatch(/already measured/);
    expect(await rejection(as(engineer, (tx) => psch.measure(tx, engineer, projectCode, { wbsCode: civil, measuredOn: '2026-09-29', percentComplete: '101' })))).toMatch(/between 0 and 100/);
    // Civil has spent 500,000 to the end of September.
    await as(manager, (tx) => projects.recordCost(tx, manager, projectCode, { costCode: 'SUB', kind: 'invoice', description: 'Excavation', incurredOn: '2026-09-20', amountIqd: price('500000'), wbsCode: civil }));

    const tree = await as(engineer, (tx) => psch.earnedValueTree(tx, projectCode, '2026-09-30'));
    const by = Object.fromEntries(tree.map((r) => [r.code, r]));
    // Civil: BCWS 250,000 (September), BCWP 400,000, ACWP 500,000 → CPI 0.80, SPI 1.60, EAC 1,250,000, VAC −250,000.
    expect(by[civil]).toMatchObject({ budgetIqd: '1000000.0000', plannedIqd: '250000.0000', earnedIqd: '400000.0000', actualIqd: '500000.0000', percentComplete: 40, cpi: '0.80', spi: '1.60', eacIqd: '1250000.0000', vacIqd: '-250000.0000', measuredPercent: '40.0000' });
    // Steel: nothing planned, earned or spent yet; EAC is its budget.
    expect(by[steel]).toMatchObject({ plannedIqd: '0.0000', earnedIqd: '0.0000', cpi: null, spi: null, eacIqd: '500000.0000', vacIqd: '0.0000' });
    // The root sums the money first: BCWP 400,000 of 1,500,000; CPI 0.80; EAC 500,000 + 1,100,000 ÷ 0.8 = 1,875,000.
    expect(by[root]).toMatchObject({ budgetIqd: '1500000.0000', earnedIqd: '400000.0000', actualIqd: '500000.0000', cpi: '0.80', spi: '1.60', eacIqd: '1875000.0000', vacIqd: '-375000.0000' });
    expect(by[root]!.percentComplete).toBeCloseTo(26.67, 2);

    // To mid-November the plan has grown: Civil 250,000 × 2 + 250,000 × 15/30; Steel 500,000 × 15/30.
    const later = Object.fromEntries((await as(engineer, (tx) => psch.earnedValueTree(tx, projectCode, '2026-11-15'))).map((r) => [r.code, r]));
    expect(later[civil]!.plannedIqd).toBe('625000.0000');
    expect(later[steel]!.plannedIqd).toBe('250000.0000');
    const list = await as(engineer, (tx) => psch.measurements(tx, projectCode));
    expect(list.map((m) => [m.measuredOn, m.percentComplete, m.approvedByName !== null])).toEqual([
      ['2026-10-01', '90.0000', false],
      ['2026-09-30', '40.0000', true],
    ]);
  });
});
