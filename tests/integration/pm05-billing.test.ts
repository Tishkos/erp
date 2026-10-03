/**
 * REQ-PM-001 Stage PM-5 — billing plan, certificates and their posting,
 * revenue recognition, forecast.
 *
 *   PM10 `pm05-billing-plan`  — a billing-plan line falls due on its
 *                               milestone or its date; the certificate it
 *                               raises carries retention and advance
 *                               recovery (Phase 11's arithmetic kept), is
 *                               approved by somebody else and posts to the
 *                               customer's account (D-PM-11).
 *   PM11 `pm05-recognition`   — with the method ratified, the period journal
 *                               posts contract × (actual ÷ EAC) less billed
 *                               to WIP or deferred revenue, reverses next
 *                               period, and is refused in a closed period;
 *                               before ratification nothing posts.
 *
 * The world is the trading fixture (open 2026 periods, a customer, a
 * receivable control account) with four project accounts mapped.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import * as periods from '@/server/services/periods';
import * as projects from '@/server/services/projects';
import * as pb from '@/server/services/project-budget';
import * as billing from '@/server/services/project-billing';
import * as psch from '@/server/services/project-schedule';
import * as ps from '@/server/services/project-system';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseDecimal } from '@domain/money';
import { BAGHDAD, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

const price = (v: string) => parseDecimal(v, 4n);
let world: TradingWorld;
let engineer: ActorContext;
let manager: ActorContext;
let accounts: Record<string, string>;

async function createUser(role: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [id, `${id}@example.com`, `${role}-pm05`]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BAGHDAD]);
  await ownerPool.query(`insert into user_department_scope (user_id, department_code) values ($1,'FIN') on conflict do nothing`, [id]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BAGHDAD };
}
const as = <T>(ctx: ActorContext, fn: (tx: Parameters<Parameters<typeof withScope>[1]>[0]) => Promise<T>) => withScope(scope(ctx), fn);

beforeEach(async () => {
  world = await buildTradingWorld();
  manager = world.manager;
  engineer = await createUser('project_manager');
  accounts = { customer_receivable: world.accounts.customer_receivable! };
  let serial = 0;
  for (const [role, parent, name, control] of [
    ['project_revenue', 'R000001', 'Contract Revenue', null],
    // A receivable from the customer, kept on the customer's sub-ledger (the map constrains it).
    ['project_retention_receivable', 'A000001', 'Retention Receivable', 'customer'],
    ['project_wip', 'A000001', 'Unbilled Contract Work (WIP)', null],
    ['project_deferred_revenue', 'L000001', 'Billings in Excess of Work', null],
  ] as const) {
    const { rows: parents } = await ownerPool.query(`select id, account_type from chart_of_account where code = $1`, [parent]);
    const { rows } = await ownerPool.query(
      `insert into chart_of_account (code, name, account_type, parent_id, is_group, is_active, approval_status, level, currency_restriction, control_account)
       values ($1,$2,$3,$4,false,true,'approved',1,'IQD',$5) returning id`,
      [`${parent.slice(0, 1)}8${String((serial += 1)).padStart(5, '0')}`, name, parents[0].account_type, parents[0].id, control],
    );
    accounts[role] = rows[0].id;
    await withScope(scope(manager), (tx) => coa.setRequiredDimensions(tx, manager, rows[0].id, []));
  }
  for (const [event, role] of [
    ['projects.certificate', 'customer_receivable'],
    ['projects.certificate', 'project_retention_receivable'],
    ['projects.certificate', 'project_revenue'],
    ['projects.recognition', 'project_wip'],
    ['projects.recognition', 'project_deferred_revenue'],
    ['projects.recognition', 'project_revenue'],
  ] as const) {
    await ownerPool.query(`insert into posting_rule (event_type, line_role, account_id, is_active, created_by) values ($1,$2,$3,true,$4)`, [event, role, accounts[role], manager.principal.userId]);
  }
});

/** A released customer project: contract 1,000,000, budget 800,000 on the root, retention 10 %, advance recovery 20 %. */
async function contract() {
  const { projectCode } = await as(engineer, (tx) =>
    ps.createDefinition(tx, engineer, {
      name: 'Basra cold store',
      typeCode: 'CUSTOMER',
      customerId: world.customerId,
      branchCode: BAGHDAD,
      managerUserId: engineer.principal.userId,
      contractValueIqd: '1000000',
      baselineBudgetIqd: '800000',
      baselineStartsOn: '2026-06-01',
      baselineEndsOn: '2026-12-31',
      retentionPercent: '10',
      advanceRecoveryPercent: '20',
    }),
  );
  await as(manager, (tx) => ps.release(tx, manager, projectCode));
  const root = `${projectCode}-1`;
  const doc = await as(engineer, (tx) => pb.createBudgetDocument(tx, engineer, projectCode, { kind: 'original', description: 'Tender', lines: [{ wbsCode: root, costCode: 'MAT', amountIqd: '800000' }] }));
  await as(engineer, (tx) => pb.submitBudgetDocument(tx, engineer, doc.documentNo));
  await as(manager, (tx) => pb.approveBudgetDocument(tx, manager, doc.documentNo));
  return { projectCode, root };
}

async function journalOf(entryId: string) {
  const { rows } = await ownerPool.query(
    `select l.line_role, l.debit_iqd::text as dr, l.credit_iqd::text as cr, e.posting_date::text as on, l.account_id
       from journal_line l join journal_entry e on e.id = l.journal_entry_id
      where l.journal_entry_id = $1 order by l.line_no`,
    [entryId],
  );
  return rows as { line_role: string | null; dr: string; cr: string; on: string; account_id: string }[];
}
const roleOf = (accountId: string) => Object.entries(accounts).find(([, id]) => id === accountId)?.[0];

describe('PM10 · pm05-billing-plan — due lines, certificates, approval and posting', () => {
  it('a line falls due on its milestone or its date; its certificate withholds retention, recovers the advance, and posts once approved by somebody else', async () => {
    const { projectCode, root } = await contract();
    const milestone = await as(engineer, (tx) => psch.addActivity(tx, engineer, projectCode, { wbsCode: root, name: 'Shell handed over', kind: 'milestone', milestoneUsage: 'billing' }));

    // Thirty per cent on the milestone; 200,000 on 15 July; a line above the contract refused.
    await as(engineer, (tx) => billing.addPlanLine(tx, engineer, projectCode, { wbsCode: root, description: 'Shell', dueTrigger: 'milestone', activityCode: milestone.code, basis: 'percent', percentOfContract: '30' }));
    await as(engineer, (tx) => billing.addPlanLine(tx, engineer, projectCode, { wbsCode: root, description: 'Mobilisation', dueTrigger: 'date', dueOn: '2026-07-15', basis: 'amount', amountIqd: '200000' }));
    expect(await rejection(as(engineer, (tx) => billing.addPlanLine(tx, engineer, projectCode, { wbsCode: root, description: 'Too much', dueTrigger: 'date', dueOn: '2026-12-15', basis: 'percent', percentOfContract: '51' })))).toMatch(/above the contract value of 1000000/);
    expect(await rejection(as(engineer, (tx) => billing.addPlanLine(tx, engineer, projectCode, { wbsCode: root, description: 'Twice', dueTrigger: 'milestone', activityCode: milestone.code, basis: 'amount', amountIqd: '1000' })))).toMatch(/one line per milestone/);

    let lines = await as(engineer, (tx) => billing.planLines(tx, projectCode));
    expect(lines.map((l) => [l.lineNo, l.state, l.grossIqd, l.dueSince])).toEqual([
      [1, 'planned', '300000.0000', null],
      [2, 'due', '200000.0000', '2026-07-15'],
    ]);
    expect(await rejection(as(engineer, (tx) => billing.raiseFromLine(tx, engineer, projectCode, 1, '2026-07-20')))).toMatch(/is planned; a certificate is raised from a due line/);

    // An advance of 100,000 is outstanding; the certificate recovers 20 % of its gross from it.
    await as(manager, (tx) => projects.receiveAdvance(tx, manager, projectCode, { amountIqd: price('100000'), receivedOn: '2026-06-10', description: 'Advance' }));
    expect(await rejection(as(engineer, (tx) => billing.raiseFromLine(tx, engineer, projectCode, 2, '2026-07-10')))).toMatch(/fell due on 2026-07-15/);
    const { certificateNo } = await as(engineer, (tx) => billing.raiseFromLine(tx, engineer, projectCode, 2, '2026-07-20'));
    const view = await as(engineer, (tx) => billing.certificate(tx, certificateNo));
    expect(view.certificate).toMatchObject({ status: 'draft', basis: 'billing_plan', grossIqd: '200000.0000', retentionIqd: '20000.0000', advanceRecoveredIqd: '40000.0000', netIqd: '140000.0000', percentComplete: '20.0000' });
    expect(view.planLine).toMatchObject({ lineNo: 2 });
    lines = await as(engineer, (tx) => billing.planLines(tx, projectCode));
    expect(lines[1]).toMatchObject({ state: 'billed', certificateNo });

    // Its raiser does not approve it; somebody else does, and it posts on its own date.
    expect(await rejection(as(engineer, (tx) => billing.approveCertificate(tx, engineer, certificateNo)))).toMatch(/somebody else approves it|not permitted|denied/i);
    const { journalEntryId } = await as(manager, (tx) => billing.approveCertificate(tx, manager, certificateNo));
    const journal = await journalOf(journalEntryId);
    expect(journal.map((l) => [roleOf(l.account_id), l.dr, l.cr, l.on])).toEqual([
      ['customer_receivable', '180000.0000', '0.0000', '2026-07-20'],
      ['project_retention_receivable', '20000.0000', '0.0000', '2026-07-20'],
      ['project_revenue', '0.0000', '200000.0000', '2026-07-20'],
    ]);
    const { rows: dims } = await ownerPool.query(`select distinct project_code as project, business_partner_code as partner from journal_line where journal_entry_id = $1`, [journalEntryId]);
    expect(dims).toEqual([{ project: projectCode, partner: 'CUST-ALNOOR' }]);
    // The customer's sub-ledger carries both receivables: the net due now and the retention due at the end.
    const { rows: sub } = await ownerPool.query(
      `select a.id, coalesce(sum(s.debit_iqd - s.credit_iqd), 0)::text as balance from subledger_entry s join chart_of_account a on a.id = s.control_account_id
        where s.subledger_type = 'customer' and s.party_code = 'CUST-ALNOOR' group by a.id`,
    );
    expect(Object.fromEntries(sub.map((r: { id: string; balance: string }) => [roleOf(r.id), r.balance]))).toEqual({ customer_receivable: '180000.0000', project_retention_receivable: '20000.0000' });
    expect(await rejection(as(manager, (tx) => billing.approveCertificate(tx, manager, certificateNo)))).toMatch(/is posted; only a draft certificate is approved/);
    expect(await as(manager, (tx) => billing.balances(tx, projectCode))).toMatchObject({ certifiedIqd: '200000.0000', billedIqd: '200000.0000', retentionHeldIqd: '20000.0000', advanceOutstandingIqd: '60000.0000' });

    // The milestone reached by one person and approved by another: line 1 falls due on the day it was reached.
    await as(engineer, (tx) => psch.reachMilestone(tx, engineer, projectCode, milestone.code, '2026-08-03'));
    lines = await as(engineer, (tx) => billing.planLines(tx, projectCode));
    expect(lines[0]).toMatchObject({ state: 'planned', dueSince: null });
    await as(manager, (tx) => psch.approveMilestone(tx, manager, projectCode, milestone.code));
    const { rows: stored } = await ownerPool.query(`select status, due_since::text as since from project_billing_plan_line where project_code = $1 and line_no = 1`, [projectCode]);
    expect(stored[0]).toEqual({ status: 'due', since: '2026-08-03' });

    // Raised, withdrawn with a reason (its balances given back, the line due again), raised again.
    const first = await as(engineer, (tx) => billing.raiseFromLine(tx, engineer, projectCode, 1, '2026-08-05'));
    expect((await as(engineer, (tx) => billing.certificate(tx, first.certificateNo))).certificate).toMatchObject({ grossIqd: '300000.0000', retentionIqd: '30000.0000', advanceRecoveredIqd: '60000.0000', netIqd: '210000.0000', percentComplete: '50.0000' });
    await as(engineer, (tx) => billing.cancelCertificate(tx, engineer, first.certificateNo, 'Wrong date on the cover sheet'));
    expect(await as(engineer, (tx) => billing.balances(tx, projectCode))).toMatchObject({ certifiedIqd: '200000.0000', retentionHeldIqd: '20000.0000', advanceOutstandingIqd: '60000.0000' });
    expect((await as(engineer, (tx) => billing.planLines(tx, projectCode)))[0]).toMatchObject({ state: 'due', certificateNo: null });
    const again = await as(engineer, (tx) => billing.raiseFromLine(tx, engineer, projectCode, 1, '2026-08-06'));
    expect(again.certificateNo).not.toBe(first.certificateNo);
    // The milestone a line waits on is not cancelled from under it — this one is done; a fresh one with a line is refused.
    const later = await as(engineer, (tx) => psch.addActivity(tx, engineer, projectCode, { wbsCode: root, name: 'Final handover', kind: 'milestone', milestoneUsage: 'billing' }));
    await as(engineer, (tx) => billing.addPlanLine(tx, engineer, projectCode, { wbsCode: root, description: 'Final', dueTrigger: 'milestone', activityCode: later.code, basis: 'percent', percentOfContract: '10' }));
    expect(await rejection(as(engineer, (tx) => psch.cancelActivity(tx, engineer, projectCode, later.code, 'not needed')))).toMatch(/falls due on .*; cancel the line first/);
    await as(engineer, (tx) => billing.cancelPlanLine(tx, engineer, projectCode, 3, 'Merged into the handover'));
    await as(engineer, (tx) => psch.cancelActivity(tx, engineer, projectCode, later.code, 'not needed'));

    // A progress certificate goes no further than the approved measurement.
    expect(await rejection(as(engineer, (tx) => billing.certifyProgress(tx, engineer, projectCode, { certifiedOn: '2026-08-10', percentComplete: '60' })))).toMatch(/measured|progress/i);
    const m = await as(engineer, (tx) => psch.measure(tx, engineer, projectCode, { wbsCode: root, measuredOn: '2026-08-09', percentComplete: '60' }));
    await as(manager, (tx) => projects.approveProgress(tx, manager, m.id));
    const progress = await as(engineer, (tx) => billing.certifyProgress(tx, engineer, projectCode, { certifiedOn: '2026-08-10', percentComplete: '60' }));
    // 60 % of the contract is 600,000; 500,000 is certified (posted 200,000 + draft 300,000).
    expect((await as(engineer, (tx) => billing.certificate(tx, progress.certificateNo))).certificate).toMatchObject({ basis: 'progress', grossIqd: '100000.0000' });
    expect(await rejection(as(engineer, (tx) => billing.certifyProgress(tx, engineer, projectCode, { certifiedOn: '2026-08-10', percentComplete: '55' })))).toMatch(/already certified/);
  });

  it('an internal project is not billed', async () => {
    const { projectCode } = await as(engineer, (tx) => ps.createDefinition(tx, engineer, { name: 'Fit-out', typeCode: 'INTERNAL', branchCode: BAGHDAD, managerUserId: engineer.principal.userId, baselineStartsOn: '2026-06-01', baselineEndsOn: '2026-12-31' }));
    expect(await rejection(as(engineer, (tx) => billing.addPlanLine(tx, engineer, projectCode, { wbsCode: `${projectCode}-1`, description: 'x', dueTrigger: 'date', dueOn: '2026-07-01', basis: 'amount', amountIqd: '1' })))).toMatch(/only a customer project is billed/);
  });
});

describe('PM11 · pm05-recognition — percentage of completion at period end', () => {
  it('posts nothing before ratification; then recognised less billed to WIP, reversed and re-posted next period to deferred revenue; refused in a closed period', async () => {
    const { projectCode, root } = await contract();
    // Billed 200,000 on 20 July.
    await as(engineer, (tx) => billing.addPlanLine(tx, engineer, projectCode, { wbsCode: root, description: 'Mobilisation', dueTrigger: 'date', dueOn: '2026-07-15', basis: 'amount', amountIqd: '200000' }));
    const cert = await as(engineer, (tx) => billing.raiseFromLine(tx, engineer, projectCode, 1, '2026-07-20'));
    await as(manager, (tx) => billing.approveCertificate(tx, manager, cert.certificateNo));
    // 300,000 spent by 31 August; half the work measured and approved: earned 400,000.
    await as(manager, (tx) => projects.recordCost(tx, manager, projectCode, { costCode: 'MAT', kind: 'invoice', description: 'Panels', incurredOn: '2026-08-12', amountIqd: price('300000'), wbsCode: root }));
    const m = await as(engineer, (tx) => psch.measure(tx, engineer, projectCode, { wbsCode: root, measuredOn: '2026-08-31', percentComplete: '50' }));
    await as(manager, (tx) => projects.approveProgress(tx, manager, m.id));

    // ETC = (800,000 − 400,000) ÷ CPI (400,000 ÷ 300,000) = 300,000; EAC 600,000; 50 % by cost; recognised 500,000.
    const august = await as(manager, (tx) => billing.recognitionFigures(tx, projectCode, '2026-08-31'));
    expect(august).toMatchObject({ contractIqd: price('1000000'), actualIqd: price('300000'), eacIqd: price('600000'), percent: 500_000n, recognisedIqd: price('500000'), billedIqd: price('200000'), adjustmentIqd: price('300000'), onerous: false });

    // Before Finance ratifies: refused, nothing written; the close warning says why.
    expect(await rejection(as(manager, (tx) => billing.runRecognition(tx, manager, projectCode, '2026-08-31')))).toMatch(/not ratified/);
    expect((await ownerPool.query(`select count(*)::int as n from project_recognition`)).rows[0].n).toBe(0);
    expect(await as(manager, (tx) => billing.missingRecognition(tx, '2026-08-31'))).toEqual({ ratified: false, projects: [] });

    // Ratified once, by somebody who may configure the project settings.
    expect(await rejection(as(engineer, (tx) => billing.ratifyPolicy(tx, engineer, 'ok')))).toMatch(/not permitted|denied|permission/i);
    await as(manager, (tx) => billing.ratifyPolicy(tx, manager, 'Finance committee, minute 14/2026'));
    expect(await rejection(as(manager, (tx) => billing.ratifyPolicy(tx, manager, 'again')))).toMatch(/was ratified on/);
    expect(await as(manager, (tx) => billing.missingRecognition(tx, '2026-08-31'))).toEqual({ ratified: true, projects: [projectCode] });
    const { rows: [sept] } = await ownerPool.query(`select id from fiscal_period where starts_on = '2026-08-01'`);
    const report = await as(manager, (tx) => periods.closeReport(tx, sept.id));
    expect(report.checks.find((c) => c.code === 'project_recognition')).toMatchObject({ severity: 'warning', state: 'warn', figure: '1', detail: [projectCode] });

    expect(await rejection(as(manager, (tx) => billing.runRecognition(tx, manager, projectCode, '2026-08-30')))).toMatch(/not the last day of a period/);
    const run = await as(manager, (tx) => billing.runRecognition(tx, manager, projectCode, '2026-08-31'));
    expect(run.reversed).toBe(0);
    expect((await journalOf(run.journalEntryId!)).map((l) => [roleOf(l.account_id), l.dr, l.cr, l.on])).toEqual([
      ['project_wip', '300000.0000', '0.0000', '2026-08-31'],
      ['project_revenue', '0.0000', '300000.0000', '2026-08-31'],
    ]);
    expect(await as(manager, (tx) => billing.missingRecognition(tx, '2026-08-31'))).toEqual({ ratified: true, projects: [] });
    expect(await rejection(as(manager, (tx) => billing.runRecognition(tx, manager, projectCode, '2026-08-31')))).toMatch(/already recognised to 2026-08-31/);
    expect(await rejection(as(manager, (tx) => billing.runRecognition(tx, manager, projectCode, '2026-07-31')))).toMatch(/an earlier period is not run after a later one/);

    // September: another 100,000 spent, 500,000 more billed, and the manager types an ETC of 700,000 —
    // EAC 1,100,000 (a loss contract, flagged), 36.3636 % by cost, recognised 363,636.3636 against 700,000 billed.
    await as(manager, (tx) => projects.recordCost(tx, manager, projectCode, { costCode: 'MAT', kind: 'invoice', description: 'Steel', incurredOn: '2026-09-10', amountIqd: price('100000'), wbsCode: root }));
    await as(engineer, (tx) => billing.addPlanLine(tx, engineer, projectCode, { wbsCode: root, description: 'Structure', dueTrigger: 'date', dueOn: '2026-09-15', basis: 'amount', amountIqd: '500000' }));
    const second = await as(engineer, (tx) => billing.raiseFromLine(tx, engineer, projectCode, 2, '2026-09-16'));
    await as(manager, (tx) => billing.approveCertificate(tx, manager, second.certificateNo));
    expect(await rejection(as(engineer, (tx) => billing.setEtc(tx, engineer, projectCode, { wbsCode: root, asOf: '2026-09-30', etcIqd: '700000', reason: ' ' })))).toMatch(/reason/);
    await as(engineer, (tx) => billing.setEtc(tx, engineer, projectCode, { wbsCode: root, asOf: '2026-09-30', etcIqd: '700000', reason: 'Steel price rise' }));
    const fc = await as(engineer, (tx) => billing.forecast(tx, projectCode, '2026-09-30'));
    expect(fc[0]).toMatchObject({ code: root, budgetIqd: '800000.0000', actualIqd: '400000.0000', etcIqd: '700000.0000', eacIqd: '1100000.0000', vacIqd: '-300000.0000', typedEtc: { asOf: '2026-09-30', etcIqd: '700000.0000', reason: 'Steel price rise' } });
    // The August forecast is not moved by an estimate typed later.
    expect((await as(engineer, (tx) => billing.forecast(tx, projectCode, '2026-08-31')))[0]).toMatchObject({ etcIqd: '300000.0000', eacIqd: '600000.0000' });

    const september = await as(manager, (tx) => billing.runRecognition(tx, manager, projectCode, '2026-09-30'));
    expect(september.reversed).toBe(1);
    expect(september.figures).toMatchObject({ percent: 363_636n, recognisedIqd: price('363636.3636'), billedIqd: price('700000'), adjustmentIqd: price('-336363.6364'), onerous: true });
    expect((await journalOf(september.journalEntryId!)).map((l) => [roleOf(l.account_id), l.dr, l.cr])).toEqual([
      ['project_revenue', '336363.6364', '0.0000'],
      ['project_deferred_revenue', '0.0000', '336363.6364'],
    ]);
    const history = await as(manager, (tx) => billing.recognitionHistory(tx, projectCode));
    expect(history.map((h) => [h.periodEnd, h.adjustmentIqd, h.reversedOn])).toEqual([
      ['2026-09-30', '-336363.6364', null],
      ['2026-08-31', '300000.0000', '2026-09-01'],
    ]);
    const { rows: rev } = await ownerPool.query(`select reversal_journal_entry_id as id from project_recognition where period_end = '2026-08-31'`);
    expect((await journalOf(rev[0].id)).map((l) => [roleOf(l.account_id), l.dr, l.cr, l.on])).toEqual([
      ['project_revenue', '300000.0000', '0.0000', '2026-09-01'],
      ['project_wip', '0.0000', '300000.0000', '2026-09-01'],
    ]);
    // WIP is clear, deferred revenue holds the excess billing; revenue to date is what was recognised.
    const balance = async (role: string) =>
      (await ownerPool.query(`select coalesce(sum(l.debit_iqd - l.credit_iqd), 0)::text as b from journal_line l join journal_entry e on e.id = l.journal_entry_id where e.status in ('posted','reversed') and l.account_id = $1`, [accounts[role]])).rows[0].b;
    expect(await balance('project_wip')).toBe('0.0000');
    expect(await balance('project_deferred_revenue')).toBe('-336363.6364');
    expect(await balance('project_revenue')).toBe('-363636.3636');

    // A closed period refuses the run.
    for (const month of ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10']) {
      await ownerPool.query(`update fiscal_period set status = 'closed' where starts_on = $1::date`, [`2026-${month}-01`]);
    }
    expect(await rejection(as(manager, (tx) => billing.runRecognition(tx, manager, projectCode, '2026-10-31')))).toMatch(/period_is_closed/);
  });
});
