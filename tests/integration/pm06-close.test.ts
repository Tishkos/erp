/**
 * REQ-PM-001 Stage PM-6 — close, settlement, labour, reports.
 *
 *   PM12 `pm06-settlement-close` — settlement moves an investment project's
 *                                  cost to its asset under construction and
 *                                  clears WIP for the rest; close needs it; a
 *                                  settled project refuses every further cost.
 *   PM13 `pm06-reports`          — the four reports print and export through
 *                                  the ERP's renderers with the screens'
 *                                  figures; the hierarchy's roll-up equals
 *                                  the line items' sum.
 *   (D-PM-8, D-PM-13)            — hours booked by one person and approved by
 *                                  another post monthly at the base salary ÷
 *                                  the calendar's working days ÷ 8; a Material
 *                                  Issue document posts its cost.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import * as inventory from '@/server/services/inventory';
import * as projects from '@/server/services/projects';
import * as pb from '@/server/services/project-budget';
import * as billing from '@/server/services/project-billing';
import * as closing from '@/server/services/project-close';
import * as pe from '@/server/services/project-execution';
import * as psch from '@/server/services/project-schedule';
import * as ps from '@/server/services/project-system';
import { runExport } from '@/server/print/export';
import { readWorkbook } from '@/server/xlsx-read';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseDecimal } from '@domain/money';
import { parseQuantity } from '@domain/uom';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

const price = (v: string) => parseDecimal(v, 4n);
let world: TradingWorld;
let engineer: ActorContext;
let manager: ActorContext;
let employeeId: string;
const accounts: Record<string, string> = {};

async function createUser(role: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [id, `${id}@example.com`, `${role}-pm06`]);
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
  let serial = 0;
  for (const [role, parent, name, control] of [
    ['project_material_cost', 'X000001', 'Project Materials', null],
    ['project_labour', 'X000001', 'Project Labour', null],
    ['labour_absorption', 'X000001', 'Labour Absorbed', null],
    ['project_auc', 'A000001', 'Assets Under Construction', null],
    ['project_revenue', 'R000001', 'Contract Revenue', null],
    ['project_retention_receivable', 'A000001', 'Retention Receivable', 'customer'],
    ['project_wip', 'A000001', 'Unbilled Contract Work (WIP)', null],
    ['project_deferred_revenue', 'L000001', 'Billings in Excess of Work', null],
  ] as const) {
    const { rows: parents } = await ownerPool.query(`select id, account_type from chart_of_account where code = $1`, [parent]);
    const { rows } = await ownerPool.query(
      `insert into chart_of_account (code, name, account_type, parent_id, is_group, is_active, approval_status, level, currency_restriction, control_account)
       values ($1,$2,$3,$4,false,true,'approved',1,'IQD',$5) returning id`,
      [`${parent.slice(0, 1)}6${String((serial += 1)).padStart(5, '0')}`, name, parents[0].account_type, parents[0].id, control],
    );
    accounts[role] = rows[0].id;
    await withScope(scope(manager), (tx) => coa.setRequiredDimensions(tx, manager, rows[0].id, []));
  }
  accounts.customer_receivable = world.accounts.customer_receivable!;
  accounts.inventory = world.accounts.inventory!;
  for (const [event, role] of [
    ['projects.material_issue', 'project_material_cost'],
    ['projects.timesheet', 'project_labour'],
    ['projects.timesheet', 'labour_absorption'],
    ['projects.settlement', 'project_auc'],
    ['projects.certificate', 'customer_receivable'],
    ['projects.certificate', 'project_retention_receivable'],
    ['projects.certificate', 'project_revenue'],
    ['projects.recognition', 'project_wip'],
    ['projects.recognition', 'project_deferred_revenue'],
    ['projects.recognition', 'project_revenue'],
  ] as const) {
    await ownerPool.query(`insert into posting_rule (event_type, line_role, account_id, is_active, created_by) values ($1,$2,$3,true,$4)`, [event, role, accounts[role], manager.principal.userId]);
  }
  // Karim, on 2,200,000 a month from January.
  const { rows: person } = await ownerPool.query(
    `insert into employee (employee_no, full_name_en, branch_code, department_code, hire_date, created_by) values ('E-0001','Karim Saleh',$1,'FIN','2025-01-01',$2) returning id`,
    [BAGHDAD, manager.principal.userId],
  );
  employeeId = person[0].id;
  await ownerPool.query(`insert into employee_compensation (employee_id, branch_code, effective_from, base_salary_iqd, recorded_by) values ($1,$2,'2026-01-01',2200000,$3)`, [employeeId, BAGHDAD, manager.principal.userId]);
});

async function released(typeCode: 'INVESTMENT' | 'CUSTOMER', extra: Partial<ps.DefinitionInput> = {}) {
  const { projectCode } = await as(engineer, (tx) =>
    ps.createDefinition(tx, engineer, {
      name: typeCode === 'INVESTMENT' ? 'Warehouse B' : 'Basra pumping station',
      typeCode,
      branchCode: BAGHDAD,
      managerUserId: engineer.principal.userId,
      baselineStartsOn: '2026-08-01',
      baselineEndsOn: '2026-12-31',
      baselineBudgetIqd: '0',
      ...extra,
    }),
  );
  await as(manager, (tx) => ps.release(tx, manager, projectCode));
  const root = `${projectCode}-1`;
  const doc = await as(engineer, (tx) =>
    pb.createBudgetDocument(tx, engineer, projectCode, { kind: 'original', description: 'Approved budget', lines: [{ wbsCode: root, costCode: 'MAT', amountIqd: '3000000' }, { wbsCode: root, costCode: 'LAB', amountIqd: '1000000' }] }),
  );
  await as(engineer, (tx) => pb.submitBudgetDocument(tx, engineer, doc.documentNo));
  await as(manager, (tx) => pb.approveBudgetDocument(tx, manager, doc.documentNo));
  return { projectCode, root };
}

async function journalOf(entryId: string) {
  const { rows } = await ownerPool.query(
    `select l.account_id, l.debit_iqd::text as dr, l.credit_iqd::text as cr, l.project_code, l.line_description, e.posting_date::text as on
       from journal_line l join journal_entry e on e.id = l.journal_entry_id where l.journal_entry_id = $1 order by l.line_no`,
    [entryId],
  );
  return rows as { account_id: string; dr: string; cr: string; project_code: string | null; line_description: string | null; on: string }[];
}
const roleOf = (id: string) => Object.entries(accounts).find(([, a]) => a === id)?.[0] ?? id;
const balance = async (role: string, projectCode?: string) =>
  (
    await ownerPool.query(
      `select coalesce(sum(l.debit_iqd - l.credit_iqd), 0)::text as b from journal_line l join journal_entry e on e.id = l.journal_entry_id
        where e.status in ('posted','reversed') and l.account_id = $1 ${projectCode ? 'and l.project_code = $2' : ''}`,
      projectCode ? [accounts[role], projectCode] : [accounts[role]],
    )
  ).rows[0].b as string;

/** 30 panels issued (300,000 at FIFO) and 16 hours of September labour (2,200,000 ÷ 22 days ÷ 8 = 12,500 an hour → 200,000). */
async function spend(projectCode: string, root: string) {
  await as(manager, (tx) =>
    inventory.receive(tx, manager, { itemCode: PANEL, warehouseCode: WAREHOUSE, branchCode: BAGHDAD, quantity: parseQuantity('100'), unitCostIqd: price('10000'), movementDate: '2026-09-01', kind: 'goods_receipt', batchNumber: 'B-1' }),
  );
  const issue = await as(world.clerk, (tx) =>
    pe.createIssue(tx, world.clerk, { projectCode, wbsCode: root, costCode: 'MAT', warehouseCode: WAREHOUSE, movementDate: '2026-09-10', lines: [{ itemCode: PANEL, quantity: '30', batchNumber: 'B-1' }] }),
  );
  await as(manager, (tx) => pe.postIssue(tx, manager, issue.documentNo));
  const a = await as(engineer, (tx) => closing.bookHours(tx, engineer, projectCode, { wbsCode: root, employeeId, workDate: '2026-09-14', hours: '8' }));
  const b = await as(engineer, (tx) => closing.bookHours(tx, engineer, projectCode, { wbsCode: root, employeeId, workDate: '2026-09-15', hours: '8' }));
  await as(manager, (tx) => closing.approveHours(tx, manager, a.id));
  await as(manager, (tx) => closing.approveHours(tx, manager, b.id));
  return { issueNo: issue.documentNo };
}

describe('D-PM-8 · labour from timesheets, D-PM-13 · the Material Issue posts', () => {
  it('hours are approved by somebody else and posted monthly at the base salary ÷ working days ÷ 8', async () => {
    const { projectCode, root } = await released('INVESTMENT');
    const sheet = await as(engineer, (tx) => closing.bookHours(tx, engineer, projectCode, { wbsCode: root, employeeId, workDate: '2026-09-14', hours: '7.5', note: 'Racking' }));
    expect(await rejection(as(engineer, (tx) => closing.bookHours(tx, engineer, projectCode, { wbsCode: root, employeeId, workDate: '2026-09-14', hours: '17' })))).toMatch(/holds 24 hours/);
    expect(await rejection(as(engineer, (tx) => closing.bookHours(tx, engineer, projectCode, { wbsCode: root, employeeId, workDate: '2026-09-14', hours: '0' })))).toMatch(/more than 0/);
    expect(await rejection(as(engineer, (tx) => closing.approveHours(tx, engineer, sheet.id)))).toMatch(/somebody else|not permitted|denied/i);
    expect(await rejection(as(manager, (tx) => closing.postLabour(tx, manager, projectCode, '2026-09')))).toMatch(/no approved hours in 2026-09/);
    await as(manager, (tx) => closing.approveHours(tx, manager, sheet.id));
    // The rate is read by somebody who may see pay — the project manager may not.
    expect(await rejection(as(engineer, (tx) => closing.postLabour(tx, engineer, projectCode, '2026-09')))).toMatch(/not permitted|denied|employee_compensation/i);
    expect(await rejection(as(manager, (tx) => closing.postLabour(tx, manager, projectCode, '2026-10')))).toMatch(/has not ended/);
    // September 2026: 30 days, 8 Fridays and Saturdays → 22 working days; 2,200,000 ÷ 176 = 12,500 an hour; 7.5 h → 93,750.
    const run = await as(manager, (tx) => closing.postLabour(tx, manager, projectCode, '2026-09'));
    expect(run).toMatchObject({ hours: '7.50', amountIqd: '93750.0000' });
    expect((await journalOf(run.journalEntryId)).map((l) => [roleOf(l.account_id), l.dr, l.cr, l.project_code, l.line_description, l.on])).toEqual([
      ['project_labour', '93750.0000', '0.0000', projectCode, 'Labour 2026-09 — E-0001', '2026-09-30'],
      ['labour_absorption', '0.0000', '93750.0000', null, 'Labour 2026-09 — E-0001', '2026-09-30'],
    ]);
    const lines = await as(manager, (tx) => closing.timesheets(tx, projectCode));
    expect(lines[0]).toMatchObject({ status: 'posted', amountIqd: '93750.0000' });
    const { rows: cost } = await ownerPool.query(`select kind, amount_iqd::text as a, cost_code, journal_entry_id is not null as j from project_cost where project_code = $1`, [projectCode]);
    expect(cost).toEqual([{ kind: 'labour', a: '93750.0000', cost_code: 'LAB', j: true }]);
    expect(await rejection(as(manager, (tx) => closing.postLabour(tx, manager, projectCode, '2026-09')))).toMatch(/no approved hours/);
    expect(await rejection(as(engineer, (tx) => closing.cancelHours(tx, engineer, sheet.id, 'wrong')))).toMatch(/is posted/);
    // An approved line not yet posted is withdrawn with a reason, its approval kept on the row.
    const late = await as(engineer, (tx) => closing.bookHours(tx, engineer, projectCode, { wbsCode: root, employeeId, workDate: '2026-09-16', hours: '2' }));
    await as(manager, (tx) => closing.approveHours(tx, manager, late.id));
    await as(engineer, (tx) => closing.cancelHours(tx, engineer, late.id, 'Booked to the wrong project'));
    const { rows: withdrawn } = await ownerPool.query(`select status, approved_at is not null as approved, cancel_reason from project_timesheet where id = $1`, [late.id]);
    expect(withdrawn[0]).toEqual({ status: 'cancelled', approved: true, cancel_reason: 'Booked to the wrong project' });
  });
});

describe('PM12 · pm06-settlement-close — to the asset, to the result, and the close', () => {
  it("an investment project's cost moves to the asset under construction; close needs the settlement; a settled project refuses every cost", async () => {
    const { projectCode, root } = await released('INVESTMENT');
    const { issueNo } = await spend(projectCode, root);
    // D-PM-13 — the issue's journal: the project's materials against the item's inventory account.
    const { rows: issueJe } = await ownerPool.query(`select journal_entry_id from project_material_issue where document_no = $1`, [issueNo]);
    expect((await journalOf(issueJe[0].journal_entry_id)).map((l) => [roleOf(l.account_id), l.dr, l.cr])).toEqual([
      ['project_material_cost', '300000.0000', '0.0000'],
      ['inventory', '0.0000', '300000.0000'],
    ]);
    await as(manager, (tx) => closing.postLabour(tx, manager, projectCode, '2026-09'));

    expect(await rejection(as(engineer, (tx) => closing.createSettlement(tx, engineer, projectCode, { settledOn: '2026-09-30' })))).toMatch(/technically complete/);
    await as(manager, (tx) => ps.technicalComplete(tx, manager, projectCode));
    const checks = await as(manager, (tx) => closing.closeChecks(tx, projectCode));
    expect(checks.filter((c) => !c.passed).map((c) => c.code)).toEqual(['unreturned_stock', 'unbilled_costs', 'settlement_not_posted']);
    expect(await rejection(as(manager, (tx) => ps.close(tx, manager, projectCode, 'done')))).toMatch(/settlement is not posted/);

    const { settlementNo } = await as(engineer, (tx) => closing.createSettlement(tx, engineer, projectCode, { settledOn: '2026-09-30', note: 'Handed to facilities' }));
    expect(await rejection(as(engineer, (tx) => closing.createSettlement(tx, engineer, projectCode, { settledOn: '2026-09-30' })))).toMatch(/one per project/);
    const draft = (await as(manager, (tx) => closing.settlements(tx, projectCode)))[0]!;
    expect(draft).toMatchObject({ kind: 'asset', status: 'draft', costIqd: '500000.0000', glCostIqd: '500000.0000' });
    expect(await rejection(as(engineer, (tx) => closing.postSettlement(tx, engineer, settlementNo)))).toMatch(/somebody else posts it|not permitted|denied/i);
    const posted = await as(manager, (tx) => closing.postSettlement(tx, manager, settlementNo));
    expect((await journalOf(posted.journalEntryId!)).map((l) => [roleOf(l.account_id), l.dr, l.cr, l.project_code])).toEqual([
      ['project_auc', '500000.0000', '0.0000', projectCode],
      ['project_material_cost', '0.0000', '300000.0000', projectCode],
      ['project_labour', '0.0000', '200000.0000', projectCode],
    ]);
    // The project's expense is gone from the P&L; the asset holds it.
    expect(await balance('project_material_cost', projectCode)).toBe('0.0000');
    expect(await balance('project_labour', projectCode)).toBe('0.0000');
    expect(await balance('project_auc')).toBe('500000.0000');
    const { rows: unsettled } = await ownerPool.query(`select count(*)::int as n from project_cost where project_code = $1 and settlement_id is null`, [projectCode]);
    expect(unsettled[0].n).toBe(0);

    // Settled: no further cost, no reopen; then every check passes and the project closes.
    expect(await rejection(as(manager, (tx) => projects.recordCost(tx, manager, projectCode, { costCode: 'MAT', kind: 'invoice', description: 'Late', incurredOn: '2026-10-01', amountIqd: price('1000'), wbsCode: root })))).toMatch(/is settled/);
    expect(await rejection(as(manager, (tx) => ps.reopen(tx, manager, projectCode, 'snags')))).toMatch(/is settled/);
    expect((await as(manager, (tx) => closing.closeChecks(tx, projectCode))).every((c) => c.passed)).toBe(true);
    await as(manager, (tx) => ps.close(tx, manager, projectCode, 'capitalised'));
    expect((await ownerPool.query(`select status from project where code = $1`, [projectCode])).rows[0].status).toBe('closed');
    expect(await rejection(as(engineer, (tx) => closing.bookHours(tx, engineer, projectCode, { wbsCode: root, employeeId, workDate: '2026-09-16', hours: '1' })))).toMatch(/is closed/);
  });

  it("a customer project's settlement clears WIP and leaves the result; a draft is cancelled with a reason", async () => {
    const { projectCode, root } = await released('CUSTOMER', { customerId: world.customerId, contractValueIqd: '1000000' });
    // Billed 200,000 in August; 300,000 spent; half measured; recognised to 31 August: 500,000 → 300,000 to WIP.
    await as(engineer, (tx) => billing.addPlanLine(tx, engineer, projectCode, { wbsCode: root, description: 'Mobilisation', dueTrigger: 'date', dueOn: '2026-08-05', basis: 'amount', amountIqd: '200000' }));
    const cert = await as(engineer, (tx) => billing.raiseFromLine(tx, engineer, projectCode, 1, '2026-08-06'));
    await as(manager, (tx) => billing.approveCertificate(tx, manager, cert.certificateNo));
    await as(manager, (tx) => projects.recordCost(tx, manager, projectCode, { costCode: 'MAT', kind: 'invoice', description: 'Pumps', incurredOn: '2026-08-12', amountIqd: price('300000'), wbsCode: root }));
    const m = await as(engineer, (tx) => psch.measure(tx, engineer, projectCode, { wbsCode: root, measuredOn: '2026-08-31', percentComplete: '50' }));
    await as(manager, (tx) => projects.approveProgress(tx, manager, m.id));
    await as(manager, (tx) => billing.ratifyPolicy(tx, manager, 'Finance committee'));
    // Budget 4,000,000, earned 2,000,000 for 300,000: ETC 2,000,000 ÷ CPI 6.67 = 300,000, EAC 600,000, half by cost — recognised 500,000.
    const run = await as(manager, (tx) => billing.runRecognition(tx, manager, projectCode, '2026-08-31'));
    expect(run.figures.adjustmentIqd).toBe(price('300000'));
    expect(await balance('project_wip')).toBe('300000.0000');

    await as(manager, (tx) => ps.technicalComplete(tx, manager, projectCode));
    const first = await as(engineer, (tx) => closing.createSettlement(tx, engineer, projectCode, { settledOn: '2026-09-30' }));
    expect(await rejection(as(engineer, (tx) => closing.cancelSettlement(tx, engineer, first.settlementNo, ' ')))).toMatch(/reason/);
    await as(engineer, (tx) => closing.cancelSettlement(tx, engineer, first.settlementNo, 'Wrong date'));
    const { settlementNo } = await as(engineer, (tx) => closing.createSettlement(tx, engineer, projectCode, { settledOn: '2026-09-29' }));
    const posted = await as(manager, (tx) => closing.postSettlement(tx, manager, settlementNo));
    expect(posted.journalEntryId).toBeNull();
    expect((await journalOf(posted.recognitionReversalEntryId!)).map((l) => [roleOf(l.account_id), l.dr, l.cr, l.on])).toEqual([
      ['project_revenue', '300000.0000', '0.0000', '2026-09-29'],
      ['project_wip', '0.0000', '300000.0000', '2026-09-29'],
    ]);
    expect(await balance('project_wip')).toBe('0.0000');
    // The result: the revenue billed against the cost incurred.
    expect(await balance('project_revenue')).toBe('-200000.0000');
    const [doc] = await as(manager, (tx) => closing.settlements(tx, projectCode));
    expect(doc).toMatchObject({ kind: 'result', status: 'posted', billedIqd: '200000.0000', costIqd: '300000.0000' });
    expect(await rejection(as(manager, (tx) => billing.runRecognition(tx, manager, projectCode, '2026-09-30')))).toMatch(/is settled/);
    expect(await as(manager, (tx) => billing.missingRecognition(tx, '2026-09-30'))).toEqual({ ratified: true, projects: [] });
    await as(manager, (tx) => ps.close(tx, manager, projectCode, 'handed over'));
  });
});

describe('PM13 · pm06-reports — the four reports, printed and exported with the screens’ figures', () => {
  it('prints and exports each report; the hierarchy roll-up equals the line items; earned value matches the Progress workspace', async () => {
    const { projectCode, root } = await released('INVESTMENT');
    const child = (await as(engineer, (tx) => ps.addElement(tx, engineer, projectCode, { parentCode: root, name: 'Racking' }))).code;
    await spend(projectCode, root);
    await as(manager, (tx) => closing.postLabour(tx, manager, projectCode, '2026-09'));
    await as(manager, (tx) => projects.recordCost(tx, manager, projectCode, { costCode: 'MAT', kind: 'invoice', description: 'Bolts', incurredOn: '2026-09-20', amountIqd: price('50000'), wbsCode: child }));
    const milestone = await as(engineer, (tx) => psch.addActivity(tx, engineer, projectCode, { wbsCode: child, name: 'Racking up', kind: 'milestone', milestoneUsage: 'date' }));
    await as(engineer, (tx) => psch.scheduleProject(tx, engineer, projectCode, 'first plan'));
    await as(engineer, (tx) => psch.scheduleProject(tx, engineer, projectCode, 'second plan'));
    const reader = { principal: manager.principal, branchCode: BAGHDAD };
    const query = new URLSearchParams({ project: projectCode, as_of: '2026-09-30' });

    const cost = await withScope(scope(manager), (tx) => runExport(tx, reader, { key: 'project_cost_report', format: 'xlsx', locale: 'en', input: { id: null, query } }));
    expect(cost.status).toBe(200);
    if (cost.status !== 200) return;
    const items = await as(manager, (tx) => pe.lineItems(tx, { projectCode, pageSize: 1000 }));
    expect(items.totalIqd).toBe('550000.0000');
    const table = cost.model.tables[0]!;
    expect(table.rows.map((r) => [r.cells.element, r.cells.actual])).toEqual([
      [root, '550000.0000'],
      [child, '50000.0000'],
    ]);
    expect(table.totals!.cells.actual).toBe(items.totalIqd);
    const sheet = [...readWorkbook(cost.body).values()].flat().flat().map((c) => (c === null || c === undefined ? '' : String(c)));
    expect(sheet).toContain(child);

    const lines = await withScope(scope(manager), (tx) => runExport(tx, reader, { key: 'project_line_items', format: 'pdf', locale: 'ar', input: { id: null, query } }));
    expect(lines.status).toBe(200);
    if (lines.status !== 200) return;
    expect(lines.body.subarray(0, 4).toString()).toBe('%PDF');
    expect(lines.model.tables[0]!.rows).toHaveLength(items.rows.length);
    expect(lines.model.tables[0]!.totals!.cells.amount).toBe('550000.0000');

    const trend = await withScope(scope(manager), (tx) => runExport(tx, reader, { key: 'project_milestone_trend', format: 'xlsx', locale: 'en', input: { id: null, query } }));
    expect(trend.status).toBe(200);
    if (trend.status !== 200) return;
    expect(trend.model.tables[0]!.columns.map((c) => c.key)).toEqual(['code', 'name', 'status', 'run_1', 'run_2', 'reached', 'slip']);
    expect(trend.model.tables[0]!.rows[0]!.cells.code).toBe(milestone.code);

    const ev = await withScope(scope(manager), (tx) => runExport(tx, reader, { key: 'project_earned_value', format: 'pdf', locale: 'en', input: { id: null, query } }));
    expect(ev.status).toBe(200);
    if (ev.status !== 200) return;
    const tree = await as(manager, (tx) => psch.earnedValueTree(tx, projectCode, '2026-09-30'));
    expect(ev.model.tables[0]!.rows.map((r) => [r.cells.element, r.cells.acwp, r.cells.eac])).toEqual(tree.map((t) => [t.code, t.actualIqd, t.eacIqd]));

    // Who may not see projects gets no copy; the export is on the audit trail.
    const { rows: trail } = await ownerPool.query(`select action from audit_event where action like 'project.exported' or (object_type = 'project' and action like '%exported%')`);
    expect(trail.length).toBeGreaterThanOrEqual(4);
    const outsider = await createUser('hr_officer');
    const refused = await withScope(scope(outsider), (tx) => runExport(tx, { principal: outsider.principal, branchCode: BAGHDAD }, { key: 'project_cost_report', format: 'pdf', locale: 'en', input: { id: null, query } }));
    expect(refused.status).toBe(404);
  });
});
