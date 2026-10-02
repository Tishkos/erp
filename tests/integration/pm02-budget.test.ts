/**
 * REQ-PM-001 Stage PM-2 — planning, budget documents and availability
 * control.
 *
 *   PM4 `pm02-budget-documents`     — the budget by element is the sum of the
 *                                     approved documents; the original writes
 *                                     the baseline once; a supplement, a
 *                                     return and a transfer move the current
 *                                     figure and leave the baseline; a
 *                                     document is not approved by its raiser.
 *   PM5 `pm02-availability-control` — warn at the profile's first line (a
 *                                     notification to the responsible person
 *                                     and the manager), stop at the second
 *                                     (the commitment refused); a raised line
 *                                     with a reason admits it and is audited.
 *   §7 change orders                — lines per element; two approvals, neither
 *                                     the raiser's; the supplement raised and
 *                                     approved; the forecast finish moved;
 *                                     the baseline untouched (R2).
 *   §7 the cost plan                — versions, the spread by month, the roll-up.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as projects from '@/server/services/projects';
import * as ps from '@/server/services/project-system';
import * as pb from '@/server/services/project-budget';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseDecimal } from '@domain/money';

const BAGHDAD = 'BGW';
const price = (v: string) => parseDecimal(v, 4n);

let engineer: ActorContext;
let manager: ActorContext;
let other: ActorContext;
let seq = 0;

async function createUser(role: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [id, `${id}@example.com`, `${role}-${(seq += 1)}`]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BAGHDAD]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BAGHDAD };
}
const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });
const as = <T>(ctx: ActorContext, fn: (tx: Parameters<Parameters<typeof withScope>[1]>[0]) => Promise<T>) => withScope(scope(ctx), fn);

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  engineer = await createUser('project_manager');
  manager = await createUser('accounting_manager');
  other = await createUser('accounting_manager');
});

/** An internal project, released, with two children under the root. */
async function released(code = 'FIT-26') {
  const { projectCode } = await as(engineer, (tx) =>
    ps.createDefinition(tx, engineer, { name: 'Warehouse fit-out', typeCode: 'INTERNAL', code, branchCode: BAGHDAD, managerUserId: manager.principal.userId, baselineBudgetIqd: '0', baselineStartsOn: '2026-10-01', baselineEndsOn: '2027-03-31' }),
  );
  const root = `${projectCode}-1`;
  const civil = (await as(engineer, (tx) => ps.addElement(tx, engineer, projectCode, { parentCode: root, name: 'Civil works', responsibleUserId: engineer.principal.userId }))).code;
  const mech = (await as(engineer, (tx) => ps.addElement(tx, engineer, projectCode, { parentCode: root, name: 'Mechanical' }))).code;
  await as(manager, (tx) => ps.release(tx, manager, projectCode));
  return { projectCode, root, civil, mech };
}

/** Civil 1,000,000 (materials and labour, or materials alone) and mechanical 500,000. */
const original = (projectCode: string, civil: string, mech: string, split = true) =>
  as(engineer, (tx) =>
    pb.createBudgetDocument(tx, engineer, projectCode, {
      kind: 'original',
      description: 'Original budget',
      lines: [
        ...(split
          ? [
              { wbsCode: civil, costCode: 'MAT', amountIqd: '600000' },
              { wbsCode: civil, costCode: 'LAB', amountIqd: '400000' },
            ]
          : [{ wbsCode: civil, costCode: 'MAT', amountIqd: '1000000' }]),
        { wbsCode: mech, costCode: 'EQP', amountIqd: '500000' },
      ],
    }),
  );

const approve = async (documentNo: string) => {
  await as(engineer, (tx) => pb.submitBudgetDocument(tx, engineer, documentNo));
  await as(manager, (tx) => pb.approveBudgetDocument(tx, manager, documentNo));
};

describe('PM4 · pm02-budget-documents — the budget is the sum of approved documents', () => {
  it('the original writes the baseline once, by somebody other than its raiser; a second original is refused', async () => {
    const { projectCode, root, civil, mech } = await released();
    const doc = await original(projectCode, civil, mech);
    expect(doc.documentNo).toBe('PBD-BGW-2026-000001');
    // A draft counts for nothing yet.
    expect((await as(engineer, (tx) => ps.tree(tx, projectCode))).find((e) => e.code === civil)!.budgetIqd).toBe('0.0000');
    expect(await rejection(as(manager, (tx) => pb.approveBudgetDocument(tx, manager, doc.documentNo)))).toMatch(/submitted document is approved/);
    await as(engineer, (tx) => pb.submitBudgetDocument(tx, engineer, doc.documentNo));
    expect(await rejection(as(engineer, (tx) => pb.approveBudgetDocument(tx, engineer, doc.documentNo)))).toMatch(/denied|raised by you/i);
    await as(manager, (tx) => pb.approveBudgetDocument(tx, manager, doc.documentNo));

    const tree = await as(engineer, (tx) => ps.tree(tx, projectCode));
    const byCode = Object.fromEntries(tree.map((e) => [e.code, e]));
    expect(byCode[civil]!.budgetIqd).toBe('1000000.0000');
    expect(byCode[mech]!.budgetIqd).toBe('500000.0000');
    expect(byCode[root]!.budgetIqd).toBe('1500000.0000');
    // Phase 11's baseline lines, per cost code, written by this approval and nothing else.
    const { rows } = await ownerPool.query(`select cost_code, baseline_iqd::text as b, wbs_code from project_budget_line where project_code = $1 order by cost_code`, [projectCode]);
    expect(rows).toEqual([
      { cost_code: 'EQP', b: '500000.0000', wbs_code: mech },
      { cost_code: 'LAB', b: '400000.0000', wbs_code: civil },
      { cost_code: 'MAT', b: '600000.0000', wbs_code: civil },
    ]);
    expect(await rejection(original(projectCode, civil, mech))).toMatch(/already has its original budget/);
    const list = await as(engineer, (tx) => ps.list(tx));
    expect(list.rows[0]).toMatchObject({ code: projectCode, budgetIqd: '1500000.0000' });
  });

  it('a supplement, a return and a transfer move the current figure and leave the baseline; a document is checked line by line', async () => {
    const { projectCode, root, civil, mech } = await released();
    await approve((await original(projectCode, civil, mech)).documentNo);

    const supplement = await as(engineer, (tx) => pb.createBudgetDocument(tx, engineer, projectCode, { kind: 'supplement', description: 'Extra steel', lines: [{ wbsCode: civil, costCode: 'MAT', amountIqd: '200000' }] }));
    await approve(supplement.documentNo);
    const back = await as(engineer, (tx) => pb.createBudgetDocument(tx, engineer, projectCode, { kind: 'return', description: 'Pumps bought cheaper', lines: [{ wbsCode: mech, costCode: 'EQP', amountIqd: '-100000' }] }));
    await approve(back.documentNo);
    const move = await as(engineer, (tx) =>
      pb.createBudgetDocument(tx, engineer, projectCode, { kind: 'transfer', description: 'Labour to mechanical', lines: [{ wbsCode: civil, costCode: 'LAB', amountIqd: '-50000' }, { wbsCode: mech, costCode: 'LAB', amountIqd: '50000' }] }),
    );
    await approve(move.documentNo);

    const summary = await as(engineer, (tx) => pb.budgetSummary(tx, projectCode));
    const civilRow = summary.find((r) => r.wbsCode === civil)!;
    const mechRow = summary.find((r) => r.wbsCode === mech)!;
    expect(civilRow).toMatchObject({ originalIqd: '1000000.0000', supplementsIqd: '200000.0000', returnsIqd: '0.0000', transfersIqd: '-50000.0000', currentIqd: '1150000.0000' });
    expect(mechRow).toMatchObject({ originalIqd: '500000.0000', returnsIqd: '-100000.0000', transfersIqd: '50000.0000', currentIqd: '450000.0000' });
    expect(summary.find((r) => r.wbsCode === root)!.rolledUpIqd).toBe('1600000.0000');
    // The baseline did not move (R2); the cost code's revisions are the documents.
    const { rows } = await ownerPool.query(`select cost_code, baseline_iqd::text as b from project_budget_line where project_code = $1 order by cost_code`, [projectCode]);
    expect(rows.map((r) => r.b)).toEqual(['500000.0000', '400000.0000', '600000.0000']);
    const mat = await as(engineer, (tx) => projects.budgetFor(tx, projectCode, 'MAT'));
    expect(mat).toMatchObject({ budgetIqd: price('600000'), revisionsIqd: price('200000'), revisedIqd: price('800000') });
    const lab = await as(engineer, (tx) => projects.budgetFor(tx, projectCode, 'LAB'));
    expect(lab.revisedIqd).toBe(price('400000')); // −50,000 and +50,000 on the same code

    // The kinds hold their sign; a transfer nets to zero; an unknown element, a deactivated code and a non-planning element are refused.
    const create = (kind: string, lines: pb.BudgetDocumentInput['lines']) => as(engineer, (tx) => pb.createBudgetDocument(tx, engineer, projectCode, { kind, description: 'x', lines }));
    expect(await rejection(create('supplement', [{ wbsCode: civil, costCode: 'MAT', amountIqd: '-1' }]))).toMatch(/a supplement adds budget/);
    expect(await rejection(create('return', [{ wbsCode: civil, costCode: 'MAT', amountIqd: '1' }]))).toMatch(/a return takes budget/);
    expect(await rejection(create('transfer', [{ wbsCode: civil, costCode: 'MAT', amountIqd: '-1' }, { wbsCode: mech, costCode: 'MAT', amountIqd: '2' }]))).toMatch(/sum to zero/);
    expect(await rejection(create('supplement', [{ wbsCode: `${root}.9`, costCode: 'MAT', amountIqd: '1' }]))).toMatch(/has no element/);
    expect(await rejection(create('supplement', [{ wbsCode: civil, costCode: 'NOPE', amountIqd: '1' }]))).toMatch(/no cost code/);
    await as(engineer, (tx) => ps.addElement(tx, engineer, projectCode, { parentCode: root, name: 'Account only', isPlanning: false }));
    expect(await rejection(create('supplement', [{ wbsCode: `${root}.3`, costCode: 'MAT', amountIqd: '1' }]))).toMatch(/not a planning element/);
    expect(await rejection(create('supplement', [{ wbsCode: civil, costCode: 'MAT', amountIqd: '1' }, { wbsCode: civil, costCode: 'MAT', amountIqd: '2' }]))).toMatch(/appears twice/);

    // A rejection carries its reason; a rejected document is not approved later.
    const late = await create('supplement', [{ wbsCode: civil, costCode: 'MAT', amountIqd: '1' }]);
    await as(engineer, (tx) => pb.submitBudgetDocument(tx, engineer, late.documentNo));
    expect(await rejection(as(manager, (tx) => pb.rejectBudgetDocument(tx, manager, late.documentNo, '')))).toMatch(/reason/);
    await as(manager, (tx) => pb.rejectBudgetDocument(tx, manager, late.documentNo, 'not this year'));
    expect(await rejection(as(manager, (tx) => pb.approveBudgetDocument(tx, manager, late.documentNo)))).toMatch(/is rejected/);
    const docs = await as(engineer, (tx) => pb.budgetDocuments(tx, { projectCode }));
    expect(docs.total).toBe(5);
    expect(docs.rows.map((d) => d.status).sort()).toEqual(['approved', 'approved', 'approved', 'approved', 'rejected']);
    const { rows: audit } = await ownerPool.query(`select action from audit_event where object_type = 'project_budget' and object_id = $1 order by occurred_at`, [late.documentNo]);
    expect(audit.map((a) => a.action)).toEqual(['project_budget.created', 'project_budget.submitted', 'project_budget.rejected']);
  });

  it('a return cannot take what an element has already assigned', async () => {
    const { projectCode, civil, mech } = await released();
    await approve((await original(projectCode, civil, mech)).documentNo);
    await as(manager, (tx) => projects.commit(tx, manager, projectCode, { costCode: 'EQP', amountIqd: price('450000'), committedOn: '2026-10-05', wbsCode: mech }));
    const back = await as(engineer, (tx) => pb.createBudgetDocument(tx, engineer, projectCode, { kind: 'return', description: 'too much', lines: [{ wbsCode: mech, costCode: 'EQP', amountIqd: '-100000' }] }));
    await as(engineer, (tx) => pb.submitBudgetDocument(tx, engineer, back.documentNo));
    expect(await rejection(as(manager, (tx) => pb.approveBudgetDocument(tx, manager, back.documentNo)))).toMatch(/leaves it over its stop line/);
  });
});

describe('PM5 · pm02-availability-control — warn, stop, and the raised line', () => {
  it('warns the responsible person and the manager once at 90 %, refuses above 100 %, admits after the line is raised with a reason', async () => {
    const { projectCode, civil, mech } = await released();
    // Phase 11's check per cost code stands beside the element's; one code on civil keeps the two in step.
    await approve((await original(projectCode, civil, mech, false)).documentNo);
    const commit = (wbsCode: string, amount: string, costCode = 'MAT') => as(manager, (tx) => projects.commit(tx, manager, projectCode, { costCode, amountIqd: price(amount), committedOn: '2026-10-05', wbsCode }));

    await commit(civil, '850000'); // 85 % — nothing said
    let notes = await ownerPool.query(`select recipient_user_id, subject from notification where event_type = 'project.availability_warning' and object_id = $1`, [projectCode]);
    expect(notes.rowCount).toBe(0);
    await commit(civil, '60000'); // 91 % — crossed
    notes = await ownerPool.query(`select recipient_user_id, subject from notification where event_type = 'project.availability_warning' and object_id = $1 order by recipient_user_id`, [projectCode]);
    expect(notes.rows.map((r) => r.recipient_user_id).sort()).toEqual([engineer.principal.userId, manager.principal.userId].sort());
    expect(notes.rows[0]!.subject).toMatch(/91\.00 % of the budget/);
    await commit(civil, '40000'); // 95 % — still warn, nothing new
    notes = await ownerPool.query(`select count(*)::int as n from notification where event_type = 'project.availability_warning' and object_id = $1`, [projectCode]);
    expect(notes.rows[0]!.n).toBe(2);
    const { rows: warned } = await ownerPool.query(`select count(*)::int as n from audit_event where action = 'project.availability_warned' and object_id = $1`, [projectCode]);
    expect(warned[0]!.n).toBe(1);

    // 100 % is the stop line: 50,000 more is exactly it (allowed), 1 more is refused.
    await commit(civil, '50000');
    expect(await rejection(commit(civil, '1'))).toMatch(/stop line of 100 % is reached/);
    const state = await as(engineer, (tx) => pb.availabilityOf(tx, projectCode, civil));
    expect(state).toMatchObject({ carrier: civil, state: 'warn', percentAfter: 100, availableBeforeIqd: 0n });

    // The project manager raises the line to 110 % with a reason; 120 % is the accounting manager's to raise.
    expect(await rejection(as(engineer, (tx) => pb.raiseStopLine(tx, engineer, projectCode, civil, '110', '')))).toMatch(/reason/);
    expect(await rejection(as(engineer, (tx) => pb.raiseStopLine(tx, engineer, projectCode, civil, '120', 'steel price')))).toMatch(/accounting manager raises/);
    expect(await rejection(as(engineer, (tx) => pb.raiseStopLine(tx, engineer, projectCode, civil, '100', 'steel price')))).toMatch(/above the profile/);
    await as(engineer, (tx) => pb.raiseStopLine(tx, engineer, projectCode, civil, '110', 'steel price rose after tender'));
    await commit(civil, '100000'); // 110 % — admitted
    expect(await rejection(commit(civil, '1'))).toMatch(/stop line of 110 %/);
    await as(manager, (tx) => pb.raiseStopLine(tx, manager, projectCode, civil, '120', 'approved overrun'));
    await commit(civil, '100000');
    const { rows: raised } = await ownerPool.query(`select action, reason from audit_event where object_type = 'project_wbs' and object_id = $1 and action like 'project_wbs.stop_line%' order by occurred_at`, [`${projectCode}:${civil}`]);
    expect(raised.map((r) => [r.action, r.reason])).toEqual([
      ['project_wbs.stop_line_raised', 'steel price rose after tender'],
      ['project_wbs.stop_line_raised', 'approved overrun'],
    ]);
    const tree = await as(engineer, (tx) => ps.tree(tx, projectCode));
    expect(tree.find((e) => e.code === civil)).toMatchObject({ availability: 'warn', stopPercentRaised: 120, committedIqd: '1200000.0000' });

    // An element without its own budget is checked against the nearest ancestor that has one — Mechanical, here.
    await as(engineer, (tx) => ps.addElement(tx, engineer, projectCode, { parentCode: mech, name: 'Pumps' }));
    expect(await rejection(commit(`${mech}.1`, '500001', 'EQP'))).toContain(`${mech}: 500000.0000 is available`);
    await commit(`${mech}.1`, '400000', 'EQP');
  });

  it('a cost that consumes a commitment is not counted twice; a cost on an element without any budget is refused', async () => {
    const { projectCode, civil, mech } = await released();
    await approve((await original(projectCode, civil, mech)).documentNo);
    const c = await as(manager, (tx) => projects.commit(tx, manager, projectCode, { costCode: 'EQP', amountIqd: price('500000'), committedOn: '2026-10-05', wbsCode: mech }));
    // The whole budget is promised; the invoice against the promise still posts.
    await as(manager, (tx) => projects.recordCost(tx, manager, projectCode, { costCode: 'EQP', kind: 'invoice', description: 'pumps', incurredOn: '2026-11-01', amountIqd: price('500000'), wbsCode: mech, consumesCommitmentId: c.id }));
    const tree = await as(engineer, (tx) => ps.tree(tx, projectCode));
    expect(tree.find((e) => e.code === mech)).toMatchObject({ committedIqd: '0.0000', actualIqd: '500000.0000', availableIqd: '0.0000' });
    expect(await rejection(as(manager, (tx) => projects.recordCost(tx, manager, projectCode, { costCode: 'EQP', kind: 'invoice', description: 'more', incurredOn: '2026-11-02', amountIqd: price('1'), wbsCode: mech })))).toMatch(/available|budget/i);
  });
});

describe('§7 · change orders raise their supplement and move the forecast; the baseline stays', () => {
  it('two approvals by people other than the raiser; the supplement document is approved in the same breath', async () => {
    const { projectCode, root, civil, mech } = await released();
    await approve((await original(projectCode, civil, mech)).documentNo);
    const co = await as(engineer, (tx) =>
      pb.raiseChangeOrder(tx, engineer, projectCode, {
        description: 'Second mezzanine',
        scopeNote: 'The client wants a second mezzanine floor over bay C.',
        scheduleDeltaDays: 30,
        lines: [{ wbsCode: civil, costCode: 'MAT', amountIqd: '300000' }, { wbsCode: civil, costCode: 'LAB', amountIqd: '100000' }],
      }),
    );
    expect(co.variationNo).toBe('PVR-BGW-2026-000001');
    expect(await rejection(as(engineer, (tx) => pb.approveChangeOrder(tx, engineer, co.variationNo, 'commercial')))).toMatch(/denied|raised by you/i);
    const first = await as(manager, (tx) => pb.approveChangeOrder(tx, manager, co.variationNo, 'commercial'));
    expect(first).toEqual({ approved: false, budgetDocumentNo: null });
    expect(await rejection(as(other, (tx) => pb.approveChangeOrder(tx, other, co.variationNo, 'commercial')))).toMatch(/already carries its commercial approval/);
    const second = await as(other, (tx) => pb.approveChangeOrder(tx, other, co.variationNo, 'budget'));
    expect(second.approved).toBe(true);
    expect(second.budgetDocumentNo).toBe('PBD-BGW-2026-000002');

    const doc = await as(engineer, (tx) => pb.budgetDocument(tx, engineer, second.budgetDocumentNo!));
    expect(doc.document).toMatchObject({ kind: 'supplement', status: 'approved', totalIqd: '400000.0000', createdBy: engineer.principal.userId, approvedBy: other.principal.userId });
    expect(doc.variationNo).toBe(co.variationNo);
    const summary = await as(engineer, (tx) => pb.budgetSummary(tx, projectCode));
    expect(summary.find((r) => r.wbsCode === civil)).toMatchObject({ originalIqd: '1000000.0000', supplementsIqd: '400000.0000', currentIqd: '1400000.0000' });
    expect(summary.find((r) => r.wbsCode === root)!.rolledUpIqd).toBe('1900000.0000');
    const { rows } = await ownerPool.query(`select baseline_ends_on::text as b, forecast_ends_on::text as f, baseline_budget_iqd::text as bb from project where code = $1`, [projectCode]);
    expect(rows[0]).toEqual({ b: '2027-03-31', f: '2027-04-30', bb: '0.0000' });
    const record = await as(engineer, (tx) => pb.changeOrder(tx, engineer, co.variationNo));
    expect(record.variation.status).toBe('approved');
    expect(record.budgetDocumentNo).toBe(second.budgetDocumentNo);
    expect(record.people.commercialBy).toMatch(/accounting_manager/);
    expect(record.lines.map((l) => l.amountIqd)).toEqual(['300000.0000', '100000.0000']);

    // A contract change is a customer project's; an internal project refuses it. A rejection carries its reason.
    expect(await rejection(as(engineer, (tx) => pb.raiseChangeOrder(tx, engineer, projectCode, { description: 'x', contractDeltaIqd: '1', lines: [] })))).toMatch(/no customer contract/);
    const second2 = await as(engineer, (tx) => pb.raiseChangeOrder(tx, engineer, projectCode, { description: 'Drop the canopy', lines: [{ wbsCode: mech, costCode: 'EQP', amountIqd: '-50000' }] }));
    await as(manager, (tx) => pb.rejectChangeOrder(tx, manager, second2.variationNo, 'canopy stays'));
    const list = await as(engineer, (tx) => pb.changeOrders(tx, { projectCode }));
    expect(list.rows.map((r) => [r.variationNo, r.status])).toEqual([
      [second2.variationNo, 'rejected'],
      [co.variationNo, 'approved'],
    ]);
  });
});

describe('§7 · the cost plan in versions, spread over months', () => {
  it('version 0 then a re-plan copying it; a spread is exact to the dinar; the roll-up reads the current version', async () => {
    const { projectCode, root, civil, mech } = await released();
    expect(await rejection(as(engineer, (tx) => pb.setPlanLine(tx, engineer, projectCode, { wbsCode: civil, costCode: 'MAT', period: '2026-10-15', amountIqd: '1' })))).toMatch(/no plan version/);
    const v0 = await as(engineer, (tx) => pb.createPlanVersion(tx, engineer, projectCode, { name: 'Tender plan' }));
    expect(v0.version).toBe(0);
    const months = await as(engineer, (tx) => pb.spreadPlan(tx, engineer, projectCode, { wbsCode: civil, costCode: 'MAT', from: '2026-10-01', to: '2027-03-31', totalIqd: '1000000' }));
    expect(months).toBe(6);
    await as(engineer, (tx) => pb.setPlanLine(tx, engineer, projectCode, { wbsCode: mech, costCode: 'EQP', period: '2026-12-20', amountIqd: '500000' }));
    const plan = await as(engineer, (tx) => pb.planLines(tx, projectCode));
    expect(plan.version?.version).toBe(0);
    expect(plan.lines.filter((l) => l.wbsCode === civil).map((l) => l.amountIqd)).toEqual(['166666.6666', '166666.6666', '166666.6666', '166666.6666', '166666.6666', '166666.6670']);
    expect(plan.lines.find((l) => l.wbsCode === mech)).toMatchObject({ period: '2026-12-01', amountIqd: '500000.0000' });
    expect(plan.months).toEqual(['2026-10-01', '2026-11-01', '2026-12-01', '2027-01-01', '2027-02-01', '2027-03-01']);
    const rolled = await as(engineer, (tx) => pb.planByElement(tx, projectCode));
    expect(rolled.planned.get(root)).toBe(price('1500000'));

    const v1 = await as(engineer, (tx) => pb.createPlanVersion(tx, engineer, projectCode, { name: 'Re-plan after CO-1', copyCurrent: true }));
    expect(v1.version).toBe(1);
    await as(engineer, (tx) => pb.setPlanLine(tx, engineer, projectCode, { wbsCode: mech, costCode: 'EQP', period: '2026-12-01', amountIqd: '600000' }));
    const current = await as(engineer, (tx) => pb.planLines(tx, projectCode));
    expect(current.version?.version).toBe(1);
    expect(current.lines).toHaveLength(7);
    const old = await as(engineer, (tx) => pb.planLines(tx, projectCode, v0.id));
    expect(old.lines.find((l) => l.wbsCode === mech)!.amountIqd).toBe('500000.0000');
    const versions = await as(engineer, (tx) => pb.planVersions(tx, projectCode));
    expect(versions.map((v) => [v.version.version, v.version.isCurrent])).toEqual([[1, true], [0, false]]);
    expect(await rejection(as(engineer, (tx) => pb.setPlanLine(tx, engineer, projectCode, { wbsCode: civil, costCode: 'MAT', period: '2026-10-01', amountIqd: '-1' })))).toMatch(/not negative/);
  });
});
