/**
 * REQ-PM-001 Stage PM-1 — PM1 `pm01-structure`, PM2 `pm01-indicators`,
 * PM3 `pm01-status-profile`.
 *
 * The definition with its type and mask-coded structure; the operative
 * indicators refusing a cost where nothing may post; the status profile on
 * the existing enum — release by another person, hold, technical
 * completion, one reopen, close — against a real PostgreSQL instance and
 * beside Phase 11's own tests, which stay green.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as projects from '@/server/services/projects';
import * as ps from '@/server/services/project-system';
import * as closing from '@/server/services/project-close';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseDecimal } from '@domain/money';

const BAGHDAD = 'BGW';
const price = (iqd: string) => parseDecimal(iqd, 4n);

let engineer: ActorContext;
let manager: ActorContext;
let other: ActorContext;
let customerId: string;
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

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  engineer = await createUser('accounting_officer');
  manager = await createUser('accounting_manager');
  other = await createUser('accounting_manager');
  const { rows } = await ownerPool.query(
    `insert into business_partner (code, legal_name, is_customer, status, active) values ('CUST-001','Al Rasheed Trading', true, 'active', true) returning id`,
  );
  customerId = rows[0].id;
});

const definition = (overrides: Partial<ps.DefinitionInput> = {}) =>
  withScope(scope(engineer), (tx) =>
    ps.createDefinition(tx, engineer, {
      name: 'Basra water treatment plant',
      typeCode: 'CUSTOMER',
      customerId,
      branchCode: BAGHDAD,
      managerUserId: manager.principal.userId,
      contractValueIqd: '1000000',
      baselineBudgetIqd: '800000',
      baselineStartsOn: '2026-01-01',
      baselineEndsOn: '2026-12-31',
      ...overrides,
    }),
  );

describe('PM1 · pm01-structure — the definition, its type and its mask-coded structure', () => {
  it('allocates PRJ-{BRANCH}-{YYYY}-{SERIAL}, writes the type, and creates the level-1 element', async () => {
    const { projectCode } = await definition();
    expect(projectCode).toBe('PRJ-BGW-2026-000001');
    const { rows } = await ownerPool.query(`select type_code, status, forecast_ends_on::text as f from project where code = $1`, [projectCode]);
    expect(rows[0]).toMatchObject({ type_code: 'CUSTOMER', status: 'draft', f: '2026-12-31' });
    const tree = await withScope(scope(engineer), (tx) => ps.tree(tx, projectCode));
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ code: `${projectCode}-1`, level: 1, isPlanning: true, isAccountAssignment: true, isBilling: true, parentCode: null });
    // Until budget lines exist, the baseline stands on the root (the five amounts are not "0").
    expect(tree[0]!.budgetIqd).toBe('800000.0000');
  });

  it('an internal project has no customer and bills nobody; a typed code is kept', async () => {
    const { projectCode } = await definition({ typeCode: 'INTERNAL', customerId: null, code: 'FITOUT-26', contractValueIqd: null });
    expect(projectCode).toBe('FITOUT-26');
    const tree = await withScope(scope(engineer), (tx) => ps.tree(tx, projectCode));
    expect(tree[0]!.isBilling).toBe(false);
    expect(await rejection(definition({ typeCode: 'INTERNAL', code: 'X-1' }))).toMatch(/has no customer/);
    expect(await rejection(definition({ typeCode: 'CUSTOMER', customerId: null }))).toMatch(/names its customer/);
    expect(await rejection(definition({ typeCode: 'NOPE' }))).toMatch(/names no project type/);
    expect(await rejection(definition({ code: 'FITOUT-26', typeCode: 'INTERNAL', customerId: null }))).toMatch(/already a project/);
  });

  it('elements follow the mask under their parent, five levels at most, and a typed code is checked', async () => {
    const { projectCode } = await definition();
    const root = `${projectCode}-1`;
    const civil = await withScope(scope(engineer), (tx) => ps.addElement(tx, engineer, projectCode, { parentCode: root, name: 'Civil works' }));
    expect(civil).toMatchObject({ code: `${root}.1`, level: 2 });
    const mech = await withScope(scope(engineer), (tx) => ps.addElement(tx, engineer, projectCode, { parentCode: root, name: 'Mechanical' }));
    expect(mech.code).toBe(`${root}.2`);
    const found = await withScope(scope(engineer), (tx) => ps.addElement(tx, engineer, projectCode, { parentCode: civil.code, name: 'Foundations', code: `${civil.code}.1` }));
    expect(found).toMatchObject({ code: `${root}.1.1`, level: 3 });
    expect(await rejection(withScope(scope(engineer), (tx) => ps.addElement(tx, engineer, projectCode, { parentCode: civil.code, name: 'x', code: `${root}.9.1` })))).toMatch(/must begin with/);
    expect(await rejection(withScope(scope(engineer), (tx) => ps.addElement(tx, engineer, projectCode, { parentCode: 'NOPE', name: 'x' })))).toMatch(/names no element/);
    // Deeper than five: the fourth and fifth levels are allowed, the sixth is not.
    let parent = found.code;
    for (let i = 4; i <= 5; i += 1) parent = (await withScope(scope(engineer), (tx) => ps.addElement(tx, engineer, projectCode, { parentCode: parent, name: `L${i}` }))).code;
    expect(await rejection(withScope(scope(engineer), (tx) => ps.addElement(tx, engineer, projectCode, { parentCode: parent, name: 'too deep' })))).toMatch(/levels deep/);
    const tree = await withScope(scope(engineer), (tx) => ps.tree(tx, projectCode));
    expect(tree.map((e) => e.code)).toEqual([root, `${root}.1`, `${root}.1.1`, `${root}.1.1.1`, `${root}.1.1.1.1`, `${root}.2`]);
    // The level is the parent's plus one, held by the trigger whatever is typed.
    const { rows } = await ownerPool.query(`select code, level from project_wbs where project_code = $1 order by level, code`, [projectCode]);
    expect(rows.map((r) => r.level)).toEqual([1, 2, 2, 3, 4, 5]);
  });

});

describe('PM2 · pm01-indicators — only an account-assignment element receives a cost', () => {
  it('refuses a cost and an issue on an element that may not receive them, and accepts one that may, rolled up the tree', async () => {
    const { projectCode } = await definition();
    const root = `${projectCode}-1`;
    await withScope(scope(engineer), (tx) => ps.addElement(tx, engineer, projectCode, { parentCode: root, name: 'Design (plan only)', isAccountAssignment: false }));
    const civil = await withScope(scope(engineer), (tx) => ps.addElement(tx, engineer, projectCode, { parentCode: root, name: 'Civil works' }));
    await withScope(scope(manager), (tx) => ps.release(tx, manager, projectCode));
    await withScope(scope(manager), (tx) => projects.addBudgetLine(tx, manager, projectCode, { costCode: 'CIVIL', description: 'Civil works', wbsCode: civil.code, baselineIqd: price('500000') }));

    const cost = (wbsCode: string) =>
      withScope(scope(manager), (tx) =>
        projects.recordCost(tx, manager, projectCode, { costCode: 'CIVIL', kind: 'invoice', description: 'Concrete', incurredOn: '2026-03-01', amountIqd: price('120000'), wbsCode }),
      );
    expect(await rejection(cost(`${root}.1`))).toMatch(/not an account-assignment element/);
    expect(await rejection(cost(`${root}.9`))).toMatch(/no such element/);
    await cost(civil.code);

    const tree = await withScope(scope(manager), (tx) => ps.tree(tx, projectCode));
    const byCode = Object.fromEntries(tree.map((e) => [e.code, e]));
    expect(byCode[civil.code]).toMatchObject({ budgetIqd: '500000.0000', actualIqd: '120000.0000', availableIqd: '380000.0000', availability: 'ok' });
    expect(byCode[root]).toMatchObject({ budgetIqd: '500000.0000', actualIqd: '120000.0000' });
    expect(byCode[`${root}.1`]).toMatchObject({ actualIqd: '0.0000' });

    // The indicator cannot be taken away from an element that already carries a cost.
    expect(await rejection(withScope(scope(manager), (tx) => ps.updateElement(tx, manager, projectCode, civil.code, { isAccountAssignment: false })))).toMatch(/already carries 1 cost row/);
    // A plan-only element can be deactivated with a reason; the one with costs cannot.
    await withScope(scope(manager), (tx) => ps.setElementActive(tx, manager, projectCode, `${root}.1`, false, 'design folded into civil'));
    expect(await rejection(withScope(scope(manager), (tx) => ps.setElementActive(tx, manager, projectCode, civil.code, false, 'x')))).toMatch(/carries costs/);
    expect(await rejection(cost(`${root}.1`))).toMatch(/deactivated/);
  });

  it('availability control reads the project\'s profile: warn at 90 %, stop at 100 %', async () => {
    const { projectCode } = await definition();
    const root = `${projectCode}-1`;
    await withScope(scope(manager), (tx) => ps.release(tx, manager, projectCode));
    await withScope(scope(manager), (tx) => projects.addBudgetLine(tx, manager, projectCode, { costCode: 'CIVIL', description: 'Civil works', wbsCode: root, baselineIqd: price('100000') }));
    await withScope(scope(manager), (tx) => projects.recordCost(tx, manager, projectCode, { costCode: 'CIVIL', kind: 'invoice', description: 'x', incurredOn: '2026-03-01', amountIqd: price('95000'), wbsCode: root }));
    const tree = await withScope(scope(manager), (tx) => ps.tree(tx, projectCode));
    expect(tree[0]).toMatchObject({ availability: 'warn', availableIqd: '5000.0000' });
    // Phase 11's refusal at the stop line is unchanged.
    expect(await rejection(withScope(scope(manager), (tx) => projects.recordCost(tx, manager, projectCode, { costCode: 'CIVIL', kind: 'invoice', description: 'y', incurredOn: '2026-03-02', amountIqd: price('6000'), wbsCode: root })))).toMatch(/budget|available/i);
  });
});

describe('PM3 · pm01-status-profile — CRTD → REL → (hold ⇄) → TECO → CLSD, one reopen', () => {
  it('release refuses the creator and needs the baseline dates; then the baseline is fixed', async () => {
    const { projectCode } = await definition();
    // The officer may not approve at all; a manager who raised it may not release it either.
    expect(await rejection(withScope(scope(engineer), (tx) => ps.release(tx, engineer, projectCode)))).toMatch(/denied/i);
    const { projectCode: own } = await withScope(scope(manager), (tx) =>
      ps.createDefinition(tx, manager, { name: 'Own', typeCode: 'INTERNAL', code: 'OWN-1', branchCode: BAGHDAD, managerUserId: manager.principal.userId, baselineStartsOn: '2026-01-01', baselineEndsOn: '2026-06-30' }),
    );
    expect(await rejection(withScope(scope(manager), (tx) => ps.release(tx, manager, own)))).toMatch(/raised by you/);
    await withScope(scope(manager), (tx) => ps.release(tx, manager, projectCode));
    const { rows } = await ownerPool.query(`select status, approved_by from project where code = $1`, [projectCode]);
    expect(rows[0]).toMatchObject({ status: 'active', approved_by: manager.principal.userId });
    expect(await rejection(withScope(scope(manager), (tx) => ps.updateDefinition(tx, manager, projectCode, { baselineBudgetIqd: '900000' })))).toMatch(/written once/);
    await withScope(scope(manager), (tx) => ps.updateDefinition(tx, manager, projectCode, { forecastEndsOn: '2027-02-28', description: 'running late' }));
    const { rows: after } = await ownerPool.query(`select forecast_ends_on::text as f, baseline_ends_on::text as b, description from project where code = $1`, [projectCode]);
    expect(after[0]).toEqual({ f: '2027-02-28', b: '2026-12-31', description: 'running late' });
    // A draft without baseline dates cannot be released.
    const { projectCode: undated } = await definition({ code: 'UNDATED', baselineStartsOn: null, baselineEndsOn: null });
    expect(await rejection(withScope(scope(manager), (tx) => ps.release(tx, manager, undated)))).toMatch(/baseline dates/);
  });

  it('hold refuses new spending and resumes with a reason; technical completion, one reopen, then close', async () => {
    const { projectCode } = await definition();
    const root = `${projectCode}-1`;
    await withScope(scope(manager), (tx) => ps.release(tx, manager, projectCode));
    await withScope(scope(manager), (tx) => projects.addBudgetLine(tx, manager, projectCode, { costCode: 'CIVIL', description: 'Civil works', wbsCode: root, baselineIqd: price('500000') }));

    expect(await rejection(withScope(scope(manager), (tx) => ps.hold(tx, manager, projectCode, '')))).toMatch(/reason/);
    await withScope(scope(manager), (tx) => ps.hold(tx, manager, projectCode, 'customer funding delayed'));
    expect((await ownerPool.query(`select status, held_reason from project where code = $1`, [projectCode])).rows[0]).toEqual({ status: 'on_hold', held_reason: 'customer funding delayed' });
    expect(
      await rejection(withScope(scope(manager), (tx) => projects.commit(tx, manager, projectCode, { costCode: 'CIVIL', amountIqd: price('1000'), committedOn: '2026-03-01' }))),
    ).toMatch(/not active/);
    expect(await rejection(withScope(scope(manager), (tx) => ps.technicalComplete(tx, manager, projectCode)))).toMatch(/allowed from active only/);
    await withScope(scope(manager), (tx) => ps.resume(tx, manager, projectCode, 'funds received'));
    expect((await ownerPool.query(`select status, held_reason from project where code = $1`, [projectCode])).rows[0]).toEqual({ status: 'active', held_reason: null });

    await withScope(scope(manager), (tx) => ps.technicalComplete(tx, manager, projectCode, 'handed over'));
    expect((await ownerPool.query(`select status from project where code = $1`, [projectCode])).rows[0].status).toBe('closing');
    expect(await rejection(withScope(scope(manager), (tx) => ps.addElement(tx, manager, projectCode, { parentCode: root, name: 'late' })))).toMatch(/structure is fixed/);
    expect(await rejection(withScope(scope(manager), (tx) => ps.reopen(tx, manager, projectCode, '')))).toMatch(/reason/);
    await withScope(scope(manager), (tx) => ps.reopen(tx, manager, projectCode, 'snag list'));
    expect((await ownerPool.query(`select status, reopened_reason from project where code = $1`, [projectCode])).rows[0]).toEqual({ status: 'active', reopened_reason: 'snag list' });
    await withScope(scope(manager), (tx) => ps.technicalComplete(tx, manager, projectCode));
    expect(await rejection(withScope(scope(manager), (tx) => ps.reopen(tx, manager, projectCode, 'again')))).toMatch(/already reopened once/);

    // Close from technical completion only, through Phase 11's blockers and PM-6's: the settlement first.
    expect(await rejection(withScope(scope(other), (tx) => ps.close(tx, other, projectCode, 'done')))).toMatch(/settlement is not posted/);
    const { settlementNo } = await withScope(scope(engineer), (tx) => closing.createSettlement(tx, engineer, projectCode, { settledOn: '2026-10-01' }));
    await withScope(scope(other), (tx) => closing.postSettlement(tx, other, settlementNo));
    await withScope(scope(other), (tx) => ps.close(tx, other, projectCode, 'done'));
    expect((await ownerPool.query(`select status from project where code = $1`, [projectCode])).rows[0].status).toBe('closed');
    expect(await rejection(withScope(scope(manager), (tx) => ps.hold(tx, manager, projectCode, 'x')))).toMatch(/allowed from active only/);

    const { rows: trail } = await ownerPool.query(`select action from audit_event where object_id = $1 and object_type = 'project' order by id`, [projectCode]);
    expect(trail.map((r) => r.action)).toEqual([
      'project.created',
      'project.approved',
      'project.held',
      'project.resumed',
      'project.technically_completed',
      'project.reopened',
      'project.technically_completed',
      'project.closed',
    ]);
  });

  it('the register lists the five amounts and filters by status and type; the record gathers the people', async () => {
    const { projectCode } = await definition();
    await definition({ typeCode: 'INTERNAL', customerId: null, code: 'INT-1', contractValueIqd: null, baselineBudgetIqd: '250000' });
    await withScope(scope(manager), (tx) => ps.release(tx, manager, projectCode));
    const all = await withScope(scope(manager), (tx) => ps.list(tx));
    expect(all.total).toBe(2);
    const internal = all.rows.find((r) => r.code === 'INT-1')!;
    expect(internal).toMatchObject({ kind: 'internal', customerName: null, budgetIqd: '250000.0000', availableIqd: '250000.0000' });
    expect((await withScope(scope(manager), (tx) => ps.list(tx, { status: 'active' }))).rows.map((r) => r.code)).toEqual([projectCode]);
    expect((await withScope(scope(manager), (tx) => ps.list(tx, { typeCode: 'INTERNAL' }))).rows.map((r) => r.code)).toEqual(['INT-1']);
    expect((await withScope(scope(manager), (tx) => ps.list(tx, { search: 'rasheed' }))).rows.map((r) => r.code)).toEqual([projectCode]);
    const record = await withScope(scope(manager), (tx) => ps.record(tx, manager, projectCode));
    expect(record.people.releasedBy).toMatch(/^accounting_manager-\d+$/);
    expect(record.type?.kind).toBe('customer');
    expect(record.customer?.code).toBe('CUST-001');
    expect(record.tree[0]!.budgetIqd).toBe('800000.0000');
  });
});

describe('R4 · the settings are master data: deactivated with a reason, never deleted', () => {
  it('a type, a profile and a cost code are created, changed, deactivated and refused for use', async () => {
    const admin = await createUser('system_administrator');
    await withScope(scope(admin), (tx) => ps.saveType(tx, admin, { code: 'RND', nameEn: 'Research', kind: 'internal', existing: false }));
    expect(await rejection(withScope(scope(admin), (tx) => ps.saveType(tx, admin, { code: 'RND', nameEn: 'Research', kind: 'internal', existing: false })))).toMatch(/already a project type/);
    await withScope(scope(admin), (tx) => ps.saveToleranceProfile(tx, admin, { code: 'TIGHT', nameEn: 'Tight', warnPercent: '80', stopPercent: '95', existing: false }));
    expect(await rejection(withScope(scope(admin), (tx) => ps.saveToleranceProfile(tx, admin, { code: 'BAD', nameEn: 'Bad', warnPercent: '120', stopPercent: '100', existing: false })))).toMatch(/at most the stop line/);
    await withScope(scope(admin), (tx) => ps.saveCostCode(tx, admin, { code: 'SITE', nameEn: 'Site works', existing: false }));
    expect(await rejection(withScope(scope(admin), (tx) => ps.setTypeActive(tx, admin, 'RND', false)))).toMatch(/say why/);
    await withScope(scope(admin), (tx) => ps.setTypeActive(tx, admin, 'RND', false, 'not used'));
    expect(await rejection(definition({ typeCode: 'RND', customerId: null, code: 'R-1' }))).toMatch(/deactivated/);
    const { rows } = await ownerPool.query(`select action, reason from audit_event where object_type = 'project_setting' order by id`);
    expect(rows.map((r) => r.action)).toEqual(['project_type.created', 'project_tolerance_profile.created', 'project_cost_code.created', 'project_type.deactivated']);
    expect(rows[3].reason).toBe('not used');
    // The engineer may not configure.
    expect(await rejection(withScope(scope(engineer), (tx) => ps.saveCostCode(tx, engineer, { code: 'X', nameEn: 'X', existing: false })))).toMatch(/denied|permission|not permitted/i);
  });
});
