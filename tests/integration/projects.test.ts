/**
 * Phase 11 test gates — projects and contracting. §10, §19.
 *
 * 11.1  A project created from an opportunity retains the customer · WBS
 *       supports hierarchy and rejects cycles · baseline preserved · the project
 *       dimension is available to every posting module
 * 11.2  Spending against an inactive project is rejected · the five amount types
 *       are separately visible · available = budget + revisions − commitments −
 *       actuals
 * 11.4  Approving a project PO reduces available budget immediately · cancelling
 *       releases it · receipt converts commitment to actual without double-count
 * 11.7  Progress is measured per WBS with an approver · a certificate cannot
 *       exceed approved measured progress
 * 11.8  A progress invoice recovers the advance and withholds retention · both
 *       sit in their own balances and neither is revenue
 * 11.9  Baseline and revised value are both visible · a variation needs both
 *       approvals · versions are retained
 * 11.11 Closure is blocked by each condition individually and reports all of
 *       them · a closed project rejects new transactions
 * 11.12 The project view shows everything related to it
 *
 * 11.10 (WIP and revenue recognition) is **blocked by D1** and is not built.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as projects from '@/server/services/projects';
import * as crm from '@/server/services/crm';
import * as inventory from '@/server/services/inventory';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseDecimal } from '@domain/money';
import { parseQuantity } from '@domain/uom';

const BAGHDAD = 'BGW';
const PRJ = 'PRJ-001';
const price = (iqd: string) => parseDecimal(iqd, 4n);
const pct = (whole: string) => parseDecimal(whole, 4n);

let engineer: ActorContext;
let manager: ActorContext;
let commercial: ActorContext;
let customerId: string;
let seq = 0;

async function createUser(role: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    `${role}-${(seq += 1)}`,
  ]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
    id,
    BAGHDAD,
  ]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  return { principal, branchCode: BAGHDAD };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');

  engineer = await createUser('accounting_officer');
  manager = await createUser('accounting_manager');
  commercial = await createUser('accounting_manager');

  const { rows } = await ownerPool.query(
    `insert into business_partner (code, legal_name, is_customer, status, active)
     values ('CUST-001','Al Rasheed Trading', true, 'active', true) returning id`,
  );
  customerId = rows[0].id;
});

/** An approved project with a budget line — the starting point for most gates. */
async function activeProject(
  overrides: Partial<projects.CreateProjectInput> = {},
  budget = '500000',
) {
  await withScope(scope(engineer), (tx) =>
    projects.create(tx, engineer, {
      projectCode: PRJ,
      name: 'Basra water treatment plant',
      customerId,
      branchCode: BAGHDAD,
      managerUserId: manager.principal.userId,
      contractValueIqd: price('1000000'),
      baselineBudgetIqd: price('800000'),
      baselineStartsOn: '2026-01-01',
      baselineEndsOn: '2026-12-31',
      retentionPercent: pct('5'),
      advanceRecoveryPercent: pct('20'),
      ...overrides,
    }),
  );
  await withScope(scope(manager), (tx) => projects.approve(tx, manager, PRJ));
  await withScope(scope(manager), (tx) =>
    projects.addBudgetLine(tx, manager, PRJ, {
      costCode: 'CIVIL',
      description: 'Civil works',
      baselineIqd: price(budget),
    }),
  );
  return PRJ;
}

// ---------------------------------------------------------------------------

describe('11.1 gate · the project, its origin and its WBS (§10)', () => {
  it('is the same row as the project dimension every posting is tagged with', async () => {
    await activeProject();

    const { rows } = await ownerPool.query(
      `select count(*)::int as n from information_schema.tables where table_name = 'project'`,
    );
    expect(rows[0].n).toBe(1);

    // journal_line carries `project_code`; the contract lives on that same row.
    const { rows: dimension } = await ownerPool.query(
      `select code, status, contract_value_iqd from project where code = $1`,
      [PRJ],
    );
    expect(dimension[0]).toMatchObject({ code: PRJ, status: 'active' });
    expect(Number(dimension[0].contract_value_iqd)).toBe(1000000);
  });

  it('takes the customer from the opportunity it came from (§6 criterion 1)', async () => {
    await ownerPool.query(
      `insert into lead_source (code, name) values ('REFERRAL','Referral') on conflict do nothing`,
    );
    const led = await withScope(scope(engineer), (tx) =>
      crm.createLead(tx, engineer, {
        companyName: 'Al Rasheed Trading',
        branchCode: BAGHDAD,
        ownerUserId: engineer.principal.userId,
        leadSourceCode: 'REFERRAL',
      }),
    );
    const opp = await withScope(scope(engineer), (tx) =>
      crm.qualifyLead(tx, engineer, {
        leadId: led.id,
        partnerId: customerId,
        businessLineCode: 'CONTRACTING',
        title: 'Water treatment plant',
        expectedValueIqd: price('1000000'),
      }),
    );
    await withScope(scope(engineer), (tx) => crm.changeStage(tx, engineer, opp.id, 'won'));

    // A different customer is offered and ignored: the opportunity's wins.
    const { rows: other } = await ownerPool.query(
      `insert into business_partner (code, legal_name, is_customer, status, active)
       values ('CUST-999','Somebody Else', true, 'active', true) returning id`,
    );

    await withScope(scope(engineer), (tx) =>
      projects.create(tx, engineer, {
        projectCode: 'PRJ-FROM-OPP',
        name: 'From the opportunity',
        customerId: other[0].id,
        branchCode: BAGHDAD,
        managerUserId: manager.principal.userId,
        contractValueIqd: price('1000000'),
        baselineBudgetIqd: price('800000'),
        opportunityId: opp.id,
      }),
    );

    const { rows } = await ownerPool.query(`select partner_id from project where code = $1`, [
      'PRJ-FROM-OPP',
    ]);
    expect(rows[0].partner_id).toBe(customerId);
  });

  it('refuses a project from an opportunity nobody won', async () => {
    await ownerPool.query(
      `insert into lead_source (code, name) values ('WEB','Web') on conflict do nothing`,
    );
    const led = await withScope(scope(engineer), (tx) =>
      crm.createLead(tx, engineer, {
        companyName: 'Not Yet Won LLC',
        branchCode: BAGHDAD,
        ownerUserId: engineer.principal.userId,
      }),
    );
    const opp = await withScope(scope(engineer), (tx) =>
      crm.qualifyLead(tx, engineer, {
        leadId: led.id,
        partnerId: customerId,
        businessLineCode: 'CONTRACTING',
        title: 'Pending',
        expectedValueIqd: price('1'),
      }),
    );

    expect(
      await rejection(
        withScope(scope(engineer), (tx) =>
          projects.create(tx, engineer, {
            projectCode: 'PRJ-PENDING',
            name: 'Pending',
            customerId,
            branchCode: BAGHDAD,
            managerUserId: manager.principal.userId,
            contractValueIqd: price('1'),
            baselineBudgetIqd: price('1'),
            opportunityId: opp.id,
          }),
        ),
      ),
    ).toMatch(/creates a project from an \*approved\* opportunity/);
  });

  it('will not let one opportunity become two projects', async () => {
    await ownerPool.query(
      `insert into lead_source (code, name) values ('REFERRAL','Referral') on conflict do nothing`,
    );
    const led = await withScope(scope(engineer), (tx) =>
      crm.createLead(tx, engineer, {
        companyName: 'Twice LLC',
        branchCode: BAGHDAD,
        ownerUserId: engineer.principal.userId,
      }),
    );
    const opp = await withScope(scope(engineer), (tx) =>
      crm.qualifyLead(tx, engineer, {
        leadId: led.id,
        partnerId: customerId,
        businessLineCode: 'CONTRACTING',
        title: 'Twice',
        expectedValueIqd: price('1'),
      }),
    );
    await withScope(scope(engineer), (tx) => crm.changeStage(tx, engineer, opp.id, 'won'));

    const make = (code: string) =>
      withScope(scope(engineer), (tx) =>
        projects.create(tx, engineer, {
          projectCode: code,
          name: code,
          customerId,
          branchCode: BAGHDAD,
          managerUserId: manager.principal.userId,
          contractValueIqd: price('1'),
          baselineBudgetIqd: price('1'),
          opportunityId: opp.id,
        }),
      );

    await make('PRJ-A');
    expect(await rejection(make('PRJ-B'))).toMatch(/project_opportunity_uniq/);
  });

  it('supports a WBS hierarchy', async () => {
    await activeProject();
    for (const [code, parent] of [
      ['1', null],
      ['1.1', '1'],
      ['1.1.1', '1.1'],
    ] as const) {
      await withScope(scope(manager), (tx) =>
        projects.addWbs(tx, manager, PRJ, { code, name: `Element ${code}`, parentCode: parent }),
      );
    }

    const { rows } = await ownerPool.query(
      `select count(*)::int as n from project_wbs where project_code = $1`,
      [PRJ],
    );
    expect(rows[0].n).toBe(3);
  });

  it('rejects a cycle, in the service and in the database', async () => {
    await activeProject();
    for (const [code, parent] of [
      ['1', null],
      ['1.1', '1'],
    ] as const) {
      await withScope(scope(manager), (tx) =>
        projects.addWbs(tx, manager, PRJ, { code, name: code, parentCode: parent }),
      );
    }

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          projects.addWbs(tx, manager, PRJ, { code: '1', name: '1', parentCode: '1.1' }),
        ),
      ),
    ).toMatch(/cycle/);

    await expect(
      ownerPool.query(`update project_wbs set parent_code = '1.1' where project_code = $1 and code = '1'`, [
        PRJ,
      ]),
    ).rejects.toThrow(/cycle/);
  });

  it('preserves the baseline once the contract is approved', async () => {
    await activeProject();

    await expect(
      ownerPool.query(`update project set contract_value_iqd = 2000000 where code = $1`, [PRJ]),
    ).rejects.toThrow(/baseline .* was approved and cannot be changed/);
  });

  it('needs somebody other than the raiser to approve the contract (§5.2)', async () => {
    await withScope(scope(manager), (tx) =>
      projects.create(tx, manager, {
        projectCode: 'PRJ-SELF',
        name: 'Self approved',
        customerId,
        branchCode: BAGHDAD,
        managerUserId: manager.principal.userId,
        contractValueIqd: price('1'),
        baselineBudgetIqd: price('1'),
      }),
    );

    expect(
      await rejection(withScope(scope(manager), (tx) => projects.approve(tx, manager, 'PRJ-SELF'))),
    ).toMatch(/somebody else approves the contract/);
  });
});

describe('11.2 and 11.4 gates · the five amounts, and availability (§10, §19)', () => {
  it('shows all five separately', async () => {
    await activeProject();
    const position = await projects_budget();

    expect(position).toMatchObject({
      budgetIqd: price('500000'),
      revisionsIqd: 0n,
      committedIqd: 0n,
      actualIqd: 0n,
      availableIqd: price('500000'),
    });
    expect(position.forecastIqd).toBe(price('500000'));
  });

  async function projects_budget() {
    return withScope(scope(manager), (tx) => projects.budgetFor(tx, PRJ, 'CIVIL'));
  }

  it('reduces availability the moment a commitment is approved', async () => {
    await activeProject();

    const committed = await withScope(scope(manager), (tx) =>
      projects.commit(tx, manager, PRJ, {
        costCode: 'CIVIL',
        amountIqd: price('120000'),
        committedOn: '2026-02-01',
      }),
    );

    expect(committed.availableAfterIqd).toBe(price('380000'));
    expect((await projects_budget()).committedIqd).toBe(price('120000'));
  });

  it('releases it the moment the order is cancelled', async () => {
    await activeProject();
    const committed = await withScope(scope(manager), (tx) =>
      projects.commit(tx, manager, PRJ, {
        costCode: 'CIVIL',
        amountIqd: price('120000'),
        committedOn: '2026-02-01',
      }),
    );

    await withScope(scope(manager), (tx) =>
      projects.releaseCommitment(tx, manager, committed.id, {
        releasedOn: '2026-02-10',
        reason: 'Order cancelled — supplier could not deliver.',
      }),
    );

    expect((await projects_budget()).availableIqd).toBe(price('500000'));
  });

  it('refuses a release with no reason', async () => {
    await activeProject();
    const committed = await withScope(scope(manager), (tx) =>
      projects.commit(tx, manager, PRJ, {
        costCode: 'CIVIL',
        amountIqd: price('1000'),
        committedOn: '2026-02-01',
      }),
    );

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          projects.releaseCommitment(tx, manager, committed.id, {
            releasedOn: '2026-02-10',
            reason: '  ',
          }),
        ),
      ),
    ).toMatch(/needs a reason/);
  });

  it('converts commitment to actual without double-counting', async () => {
    await activeProject();
    const committed = await withScope(scope(manager), (tx) =>
      projects.commit(tx, manager, PRJ, {
        costCode: 'CIVIL',
        amountIqd: price('120000'),
        committedOn: '2026-02-01',
      }),
    );

    await withScope(scope(manager), (tx) =>
      projects.recordCost(tx, manager, PRJ, {
        costCode: 'CIVIL',
        kind: 'goods_receipt',
        description: 'Concrete delivered',
        incurredOn: '2026-02-15',
        amountIqd: price('120000'),
        consumesCommitmentId: committed.id,
      }),
    );

    const position = await projects_budget();
    // The commitment is consumed, the actual is recorded, and availability is
    // where it was — the money was counted once, not twice.
    expect(position.committedIqd).toBe(0n);
    expect(position.actualIqd).toBe(price('120000'));
    expect(position.availableIqd).toBe(price('380000'));
  });

  it('refuses spending beyond the available budget', async () => {
    await activeProject();

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          projects.commit(tx, manager, PRJ, {
            costCode: 'CIVIL',
            amountIqd: price('500001'),
            committedOn: '2026-02-01',
          }),
        ),
      ),
    ).toMatch(/available and this needs/);
  });

  it('refuses spending against a project that is not active', async () => {
    await withScope(scope(engineer), (tx) =>
      projects.create(tx, engineer, {
        projectCode: 'PRJ-DRAFT',
        name: 'Not approved',
        customerId,
        branchCode: BAGHDAD,
        managerUserId: manager.principal.userId,
        contractValueIqd: price('1000'),
        baselineBudgetIqd: price('1000'),
      }),
    );
    await withScope(scope(manager), (tx) =>
      projects.addBudgetLine(tx, manager, 'PRJ-DRAFT', {
        costCode: 'CIVIL',
        description: 'Civil',
        baselineIqd: price('1000'),
      }),
    );

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          projects.commit(tx, manager, 'PRJ-DRAFT', {
            costCode: 'CIVIL',
            amountIqd: price('1'),
            committedOn: '2026-02-01',
          }),
        ),
      ),
    ).toMatch(/not active/);
  });

  it('refuses spending against a cost code that does not exist', async () => {
    await activeProject();

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          projects.commit(tx, manager, PRJ, {
            costCode: 'NOT-A-CODE',
            amountIqd: price('1'),
            committedOn: '2026-02-01',
          }),
        ),
      ),
    ).toMatch(/no budget line/);
  });
});

describe('11.3 gate · project stock (§10, §9.2)', () => {
  const CABLE = 'ITM-CABLE';

  async function stockedProject() {
    await activeProject();

    const client = await ownerPool.connect();
    try {
      await client.query('begin');
      const { rows: item } = await client.query(
        `insert into item (code, name, is_stock, base_uom_code, tracking)
         values ($1,'Network Cable 2m',true,'EA','batch') returning id`,
        [CABLE],
      );
      await client.query(
        `insert into item_uom (item_id, uom_code, conversion_numerator, conversion_denominator)
         values ($1,'EA',1,1)`,
        [item[0].id],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    // 100 units at 10 each, so the FIFO cost of an issue is knowable.
    await withScope(scope(manager), (tx) =>
      inventory.receive(tx, manager, {
        itemCode: CABLE,
        warehouseCode: `WH-${BAGHDAD}`,
        branchCode: BAGHDAD,
        quantity: parseQuantity('100'),
        unitCostIqd: price('10'),
        movementDate: '2026-02-01',
        kind: 'goods_receipt',
        batchNumber: 'B-1',
      }),
    );
  }

  it('reduces warehouse stock and raises project cost in one transaction', async () => {
    await stockedProject();

    const issued = await withScope(scope(manager), (tx) =>
      projects.issueToProject(tx, manager, PRJ, {
        itemCode: CABLE,
        warehouseCode: `WH-${BAGHDAD}`,
        quantity: parseQuantity('40'),
        movementDate: '2026-02-10',
        costCode: 'CIVIL',
        batchNumber: 'B-1',
      }),
    );

    // 40 × 10 = 400, at the FIFO cost the issue actually consumed.
    expect(issued.costIqd).toBe(price('400'));

    const onHand = await withScope(scope(manager), (tx) =>
      inventory.layerQuantityOf(tx, CABLE, `WH-${BAGHDAD}`),
    );
    expect(onHand).toBe(parseQuantity('60'));

    const position = await withScope(scope(manager), (tx) =>
      projects.budgetFor(tx, PRJ, 'CIVIL'),
    );
    expect(position.actualIqd).toBe(price('400'));
  });

  it('takes the cost from the FIFO layer, not from the caller', async () => {
    await stockedProject();
    // A second, dearer layer. The first issue must still cost 10 apiece.
    await withScope(scope(manager), (tx) =>
      inventory.receive(tx, manager, {
        itemCode: CABLE,
        warehouseCode: `WH-${BAGHDAD}`,
        branchCode: BAGHDAD,
        quantity: parseQuantity('100'),
        unitCostIqd: price('25'),
        movementDate: '2026-02-05',
        kind: 'goods_receipt',
        batchNumber: 'B-2',
      }),
    );

    const issued = await withScope(scope(manager), (tx) =>
      projects.issueToProject(tx, manager, PRJ, {
        itemCode: CABLE,
        warehouseCode: `WH-${BAGHDAD}`,
        quantity: parseQuantity('40'),
        movementDate: '2026-02-10',
        costCode: 'CIVIL',
        batchNumber: 'B-1',
      }),
    );
    expect(issued.costIqd).toBe(price('400'));
  });

  it('returns stock at the cost it went out at, reversing both effects', async () => {
    await stockedProject();
    await withScope(scope(manager), (tx) =>
      projects.issueToProject(tx, manager, PRJ, {
        itemCode: CABLE,
        warehouseCode: `WH-${BAGHDAD}`,
        quantity: parseQuantity('40'),
        movementDate: '2026-02-10',
        costCode: 'CIVIL',
        batchNumber: 'B-1',
      }),
    );

    await withScope(scope(manager), (tx) =>
      projects.returnFromProject(tx, manager, PRJ, {
        itemCode: CABLE,
        warehouseCode: `WH-${BAGHDAD}`,
        quantity: parseQuantity('40'),
        unitCostIqd: price('10'),
        movementDate: '2026-02-20',
        costCode: 'CIVIL',
        batchNumber: 'B-1R',
      }),
    );

    const onHand = await withScope(scope(manager), (tx) =>
      inventory.layerQuantityOf(tx, CABLE, `WH-${BAGHDAD}`),
    );
    expect(onHand).toBe(parseQuantity('100'));

    const position = await withScope(scope(manager), (tx) =>
      projects.budgetFor(tx, PRJ, 'CIVIL'),
    );
    expect(position.actualIqd).toBe(0n);
  });

  it('reports what went out and what came back, rather than deleting the issue', async () => {
    await stockedProject();
    await withScope(scope(manager), (tx) =>
      projects.issueToProject(tx, manager, PRJ, {
        itemCode: CABLE,
        warehouseCode: `WH-${BAGHDAD}`,
        quantity: parseQuantity('40'),
        movementDate: '2026-02-10',
        costCode: 'CIVIL',
        batchNumber: 'B-1',
      }),
    );
    await withScope(scope(manager), (tx) =>
      projects.returnFromProject(tx, manager, PRJ, {
        itemCode: CABLE,
        warehouseCode: `WH-${BAGHDAD}`,
        quantity: parseQuantity('10'),
        unitCostIqd: price('10'),
        movementDate: '2026-02-20',
        costCode: 'CIVIL',
        batchNumber: 'B-1R',
      }),
    );

    const movements = await withScope(scope(manager), (tx) =>
      projects.materialMovements(tx, manager, PRJ),
    );
    expect(movements.map((m) => m.kind)).toEqual(['material_issue', 'material_return']);
    expect(Number(movements[1]!.amountIqd)).toBe(-100);
  });

  it('records the issue under its own movement kind, not as a delivery', async () => {
    await stockedProject();
    await withScope(scope(manager), (tx) =>
      projects.issueToProject(tx, manager, PRJ, {
        itemCode: CABLE,
        warehouseCode: `WH-${BAGHDAD}`,
        quantity: parseQuantity('40'),
        movementDate: '2026-02-10',
        costCode: 'CIVIL',
        batchNumber: 'B-1',
      }),
    );

    const { rows } = await ownerPool.query(
      `select kind, source_document_type, source_document_id from inventory_movement
        where kind in ('project_issue','delivery')`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'project_issue',
      source_document_type: 'project',
      source_document_id: PRJ,
    });
  });

  it('refuses an issue to a project that is not active', async () => {
    await stockedProject();
    await withScope(scope(manager), (tx) => projects.close(tx, manager, PRJ, 'Done'));

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          projects.issueToProject(tx, manager, PRJ, {
            itemCode: CABLE,
            warehouseCode: `WH-${BAGHDAD}`,
            quantity: parseQuantity('1'),
            movementDate: '2026-02-10',
            costCode: 'CIVIL',
            batchNumber: 'B-1',
          }),
        ),
      ),
    ).toMatch(/not active/);
  });
});

describe('11.7 gate · progress is measured, then approved by somebody else (§10)', () => {
  async function measured(percent: string) {
    await activeProject();
    await withScope(scope(manager), (tx) =>
      projects.addWbs(tx, manager, PRJ, { code: '1', name: 'Whole works' }),
    );
    const progress = await withScope(scope(engineer), (tx) =>
      projects.measureProgress(tx, engineer, PRJ, {
        wbsCode: '1',
        measuredOn: '2026-03-01',
        percentComplete: pct(percent),
      }),
    );
    return progress;
  }

  it('records progress per WBS element', async () => {
    const progress = await measured('40');
    const { rows } = await ownerPool.query(
      `select wbs_code, percent_complete, measured_by, approved_by from project_progress where id = $1`,
      [progress.id],
    );
    expect(rows[0]).toMatchObject({ wbs_code: '1', measured_by: engineer.principal.userId });
    expect(rows[0].approved_by).toBeNull();
  });

  it('refuses the measurer as their own approver (§5.2)', async () => {
    await activeProject();
    await withScope(scope(manager), (tx) =>
      projects.addWbs(tx, manager, PRJ, { code: '1', name: 'Whole works' }),
    );
    // Measured by a manager, so the refusal is §5.2's and not the permission's.
    const progress = await withScope(scope(manager), (tx) =>
      projects.measureProgress(tx, manager, PRJ, {
        wbsCode: '1',
        measuredOn: '2026-03-01',
        percentComplete: pct('40'),
      }),
    );

    expect(
      await rejection(
        withScope(scope(manager), (tx) => projects.approveProgress(tx, manager, progress.id)),
      ),
    ).toMatch(/somebody else approves it/);
  });

  it('refuses a certificate beyond approved measured progress', async () => {
    const progress = await measured('40');
    await withScope(scope(manager), (tx) => projects.approveProgress(tx, manager, progress.id));

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          projects.certify(tx, manager, PRJ, {
            certifiedOn: '2026-03-05',
            percentComplete: pct('60'),
            grossIqd: price('100000'),
          }),
        ),
      ),
    ).toMatch(/approved measured progress/);
  });

  it('counts only approved measurements', async () => {
    await measured('40'); // measured, never approved

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          projects.certify(tx, manager, PRJ, {
            certifiedOn: '2026-03-05',
            percentComplete: pct('10'),
            grossIqd: price('1000'),
          }),
        ),
      ),
    ).toMatch(/approved measured progress/);
  });
});

describe('11.8 gate · retention and advances are their own balances (§10)', () => {
  async function certifiable() {
    await activeProject();
    await withScope(scope(manager), (tx) =>
      projects.addWbs(tx, manager, PRJ, { code: '1', name: 'Whole works' }),
    );
    const progress = await withScope(scope(engineer), (tx) =>
      projects.measureProgress(tx, engineer, PRJ, {
        wbsCode: '1',
        measuredOn: '2026-03-01',
        percentComplete: pct('50'),
      }),
    );
    await withScope(scope(manager), (tx) => projects.approveProgress(tx, manager, progress.id));
  }

  it('withholds retention and recovers the advance', async () => {
    await certifiable();
    await withScope(scope(manager), (tx) =>
      projects.receiveAdvance(tx, manager, PRJ, {
        amountIqd: price('200000'),
        receivedOn: '2026-01-15',
        description: 'Mobilisation advance',
      }),
    );

    const certificate = await withScope(scope(manager), (tx) =>
      projects.certify(tx, manager, PRJ, {
        certifiedOn: '2026-03-05',
        percentComplete: pct('50'),
        grossIqd: price('100000'),
      }),
    );

    // 5% retention, 20% advance recovery.
    expect(certificate.retentionIqd).toBe(price('5000'));
    expect(certificate.netIqd).toBe(price('75000'));

    expect(await withScope(scope(manager), (tx) => projects.balanceOf(tx, PRJ, 'retention'))).toBe(
      price('5000'),
    );
    expect(await withScope(scope(manager), (tx) => projects.balanceOf(tx, PRJ, 'advance'))).toBe(
      price('180000'),
    );
  });

  it('never recovers more advance than is left', async () => {
    await certifiable();
    await withScope(scope(manager), (tx) =>
      projects.receiveAdvance(tx, manager, PRJ, {
        amountIqd: price('3000'),
        receivedOn: '2026-01-15',
        description: 'Small advance',
      }),
    );

    const certificate = await withScope(scope(manager), (tx) =>
      projects.certify(tx, manager, PRJ, {
        certifiedOn: '2026-03-05',
        percentComplete: pct('50'),
        grossIqd: price('100000'),
      }),
    );

    expect(certificate.netIqd).toBe(price('92000')); // 100,000 − 5,000 − 3,000
    expect(await withScope(scope(manager), (tx) => projects.balanceOf(tx, PRJ, 'advance'))).toBe(0n);
  });

  it('releases retention only through the release, and never more than is held', async () => {
    await certifiable();
    await withScope(scope(manager), (tx) =>
      projects.certify(tx, manager, PRJ, {
        certifiedOn: '2026-03-05',
        percentComplete: pct('50'),
        grossIqd: price('100000'),
      }),
    );

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          projects.releaseRetention(tx, manager, PRJ, {
            amountIqd: price('6000'),
            releasedOn: '2026-06-01',
            description: 'Too much',
          }),
        ),
      ),
    ).toMatch(/Releasing more than was withheld/);

    await withScope(scope(manager), (tx) =>
      projects.releaseRetention(tx, manager, PRJ, {
        amountIqd: price('5000'),
        releasedOn: '2026-06-01',
        description: 'Defects period expired',
      }),
    );
    expect(await withScope(scope(manager), (tx) => projects.balanceOf(tx, PRJ, 'retention'))).toBe(0n);
  });

  it('will not let the database hold a negative balance', async () => {
    await certifiable();

    await expect(
      ownerPool.query(
        `insert into project_balance_movement (project_code, kind, amount_iqd, moved_on, description, created_by)
         values ($1,'retention',-1,'2026-06-01','Impossible',$2)`,
        [PRJ, manager.principal.userId],
      ),
    ).rejects.toThrow(/would leave/);
  });

  it('keeps the certificate arithmetic true in the table', async () => {
    await certifiable();
    const certificate = await withScope(scope(manager), (tx) =>
      projects.certify(tx, manager, PRJ, {
        certifiedOn: '2026-03-05',
        percentComplete: pct('50'),
        grossIqd: price('100000'),
      }),
    );

    await expect(
      ownerPool.query(`update project_certificate set net_iqd = 999 where id = $1`, [
        certificate.id,
      ]),
    ).rejects.toThrow(/project_certificate_net_is_the_remainder/);
  });

  it('has no journal on a certificate until somebody else approves it (REQ-PM-001 D-PM-11)', async () => {
    await certifiable();
    const certificate = await withScope(scope(manager), (tx) =>
      projects.certify(tx, manager, PRJ, { certifiedOn: '2026-03-05', percentComplete: pct('50'), grossIqd: price('100000') }),
    );
    const { rows } = await ownerPool.query(`select status, journal_entry_id from project_certificate where id = $1`, [certificate.id]);
    expect(rows[0]).toEqual({ status: 'draft', journal_entry_id: null });
    // The table refuses a posted certificate without its journal, and its raiser as its approver.
    await expect(ownerPool.query(`update project_certificate set status = 'posted', approved_by = created_by, approved_at = now() where id = $1`, [certificate.id])).rejects.toThrow(
      /project_certificate_four_eyes|project_certificate_posted_has_journal/,
    );
  });
});

describe('11.9 gate · variations preserve the baseline (§10 criterion 3)', () => {
  async function variation(no: string, contract: string, budget: string) {
    return withScope(scope(engineer), (tx) =>
      projects.raiseVariation(tx, engineer, PRJ, {
        variationNo: no,
        raisedOn: '2026-04-01',
        description: 'Additional pumping station',
        contractDeltaIqd: price(contract),
        budgetDeltaIqd: price(budget),
        revisedEndsOn: '2027-03-31',
      }),
    );
  }

  it('needs both commercial and budget approval', async () => {
    await activeProject();
    const v = await variation('VAR-1', '150000', '120000');

    const first = await withScope(scope(commercial), (tx) =>
      projects.approveVariation(tx, commercial, v.id, 'commercial'),
    );
    expect(first.approved).toBe(false);

    const second = await withScope(scope(manager), (tx) =>
      projects.approveVariation(tx, manager, v.id, 'budget'),
    );
    expect(second.approved).toBe(true);
  });

  it('will not let the database call it approved on one signature', async () => {
    await activeProject();
    const v = await variation('VAR-1', '150000', '120000');
    await withScope(scope(commercial), (tx) =>
      projects.approveVariation(tx, commercial, v.id, 'commercial'),
    );

    await expect(
      ownerPool.query(`update project_variation set status = 'approved' where id = $1`, [v.id]),
    ).rejects.toThrow(/project_variation_approved_needs_both/);
  });

  it('shows the baseline and the revised value side by side', async () => {
    await activeProject();
    const v = await variation('VAR-1', '150000', '120000');
    await withScope(scope(commercial), (tx) =>
      projects.approveVariation(tx, commercial, v.id, 'commercial'),
    );
    await withScope(scope(manager), (tx) => projects.approveVariation(tx, manager, v.id, 'budget'));

    const position = await withScope(scope(manager), (tx) => projects.position(tx, PRJ));

    expect(position.contractValueIqd).toBe(price('1000000'));
    expect(position.revisedContractValueIqd).toBe(price('1150000'));
    expect(position.endsOn).toBe('2026-12-31');
    expect(position.revisedEndsOn).toBe('2027-03-31');
  });

  it('moves availability by the revised figure, leaving the baseline alone', async () => {
    await activeProject();
    const before = await withScope(scope(manager), (tx) => projects.budgetFor(tx, PRJ, 'CIVIL'));

    const v = await variation('VAR-1', '150000', '120000');
    await withScope(scope(commercial), (tx) =>
      projects.approveVariation(tx, commercial, v.id, 'commercial'),
    );
    await withScope(scope(manager), (tx) => projects.approveVariation(tx, manager, v.id, 'budget'));

    const after = await withScope(scope(manager), (tx) => projects.budgetFor(tx, PRJ, 'CIVIL'));

    expect(before.availableIqd).toBe(price('500000'));
    expect(after.budgetIqd).toBe(price('500000')); // baseline untouched
    expect(after.revisionsIqd).toBe(price('120000'));
    expect(after.availableIqd).toBe(price('620000'));
  });

  it('retains superseded versions', async () => {
    await activeProject();
    const first = await variation('VAR-1', '150000', '120000');
    const second = await withScope(scope(engineer), (tx) =>
      projects.raiseVariation(tx, engineer, PRJ, {
        variationNo: 'VAR-1-R2',
        raisedOn: '2026-04-10',
        description: 'Revised pumping station',
        contractDeltaIqd: price('180000'),
        budgetDeltaIqd: price('140000'),
        supersedesId: first.id,
      }),
    );

    expect(second.version).toBe(2);

    const { rows } = await ownerPool.query(
      `select variation_no, version from project_variation where project_code = $1 order by version`,
      [PRJ],
    );
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
  });

  it('counts an unapproved variation towards nothing', async () => {
    await activeProject();
    await variation('VAR-1', '150000', '120000');

    const position = await withScope(scope(manager), (tx) => projects.budgetFor(tx, PRJ, 'CIVIL'));
    expect(position.revisionsIqd).toBe(0n);
  });
});

describe('11.11 gate · closeout blocks on unresolved items (§10 criterion 5)', () => {
  it('closes a clean project', async () => {
    await activeProject();
    await withScope(scope(manager), (tx) => projects.close(tx, manager, PRJ, 'Final account agreed'));

    const { rows } = await ownerPool.query(`select status, closed_by from project where code = $1`, [
      PRJ,
    ]);
    expect(rows[0].status).toBe('closed');
    expect(rows[0].closed_by).toBe(manager.principal.userId);
  });

  it('is blocked by an open commitment', async () => {
    await activeProject();
    await withScope(scope(manager), (tx) =>
      projects.commit(tx, manager, PRJ, {
        costCode: 'CIVIL',
        amountIqd: price('1000'),
        committedOn: '2026-02-01',
      }),
    );

    expect(
      await rejection(withScope(scope(manager), (tx) => projects.close(tx, manager, PRJ, 'x'))),
    ).toMatch(/purchase order\(s\) are still open/);
  });

  it('is blocked by unbilled cost', async () => {
    await activeProject();
    await withScope(scope(manager), (tx) =>
      projects.recordCost(tx, manager, PRJ, {
        costCode: 'CIVIL',
        kind: 'labour',
        description: 'Site labour',
        incurredOn: '2026-02-15',
        amountIqd: price('5000'),
      }),
    );

    expect(
      await rejection(withScope(scope(manager), (tx) => projects.close(tx, manager, PRJ, 'x'))),
    ).toMatch(/of cost has not been billed/);
  });

  it('is blocked by an unapproved variation', async () => {
    await activeProject();
    await withScope(scope(engineer), (tx) =>
      projects.raiseVariation(tx, engineer, PRJ, {
        variationNo: 'VAR-9',
        raisedOn: '2026-04-01',
        description: 'Pending',
        contractDeltaIqd: price('1'),
        budgetDeltaIqd: price('1'),
      }),
    );

    expect(
      await rejection(withScope(scope(manager), (tx) => projects.close(tx, manager, PRJ, 'x'))),
    ).toMatch(/variation\(s\) are waiting for approval/);
  });

  it('is blocked by unresolved retention or advance', async () => {
    await activeProject();
    await withScope(scope(manager), (tx) =>
      projects.receiveAdvance(tx, manager, PRJ, {
        amountIqd: price('1000'),
        receivedOn: '2026-01-15',
        description: 'Advance',
      }),
    );

    expect(
      await rejection(withScope(scope(manager), (tx) => projects.close(tx, manager, PRJ, 'x'))),
    ).toMatch(/of advance and .* of retention are unresolved/);
  });

  it('reports every blocker at once', async () => {
    await activeProject();
    await withScope(scope(manager), (tx) =>
      projects.commit(tx, manager, PRJ, {
        costCode: 'CIVIL',
        amountIqd: price('1000'),
        committedOn: '2026-02-01',
      }),
    );
    await withScope(scope(engineer), (tx) =>
      projects.raiseVariation(tx, engineer, PRJ, {
        variationNo: 'VAR-9',
        raisedOn: '2026-04-01',
        description: 'Pending',
        contractDeltaIqd: price('1'),
        budgetDeltaIqd: price('1'),
      }),
    );
    await withScope(scope(manager), (tx) =>
      projects.receiveAdvance(tx, manager, PRJ, {
        amountIqd: price('1000'),
        receivedOn: '2026-01-15',
        description: 'Advance',
      }),
    );

    const message = await rejection(
      withScope(scope(manager), (tx) => projects.close(tx, manager, PRJ, 'x')),
    );
    expect(message).toMatch(/3 thing\(s\) are unresolved/);
  });

  it('rejects new spending on a closed project', async () => {
    await activeProject();
    await withScope(scope(manager), (tx) => projects.close(tx, manager, PRJ, 'Final account agreed'));

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          projects.commit(tx, manager, PRJ, {
            costCode: 'CIVIL',
            amountIqd: price('1'),
            committedOn: '2026-06-01',
          }),
        ),
      ),
    ).toMatch(/not active/);
  });
});

describe('11.12 gate · the project shows everything related to it (§10 criterion 1)', () => {
  it('gathers the contract, WBS, budget, commitments, costs, certificates and variations', async () => {
    await activeProject();
    await withScope(scope(manager), (tx) =>
      projects.addWbs(tx, manager, PRJ, { code: '1', name: 'Whole works' }),
    );
    await withScope(scope(manager), (tx) =>
      projects.commit(tx, manager, PRJ, {
        costCode: 'CIVIL',
        amountIqd: price('10000'),
        committedOn: '2026-02-01',
      }),
    );
    await withScope(scope(manager), (tx) =>
      projects.recordCost(tx, manager, PRJ, {
        costCode: 'CIVIL',
        kind: 'labour',
        description: 'Site labour',
        incurredOn: '2026-02-15',
        amountIqd: price('5000'),
      }),
    );

    const view = await withScope(scope(manager), (tx) => projects.projectView(tx, manager, PRJ));

    expect(view.project.code).toBe(PRJ);
    expect(view.wbs).toHaveLength(1);
    expect(view.budget).toHaveLength(1);
    expect(view.commitments).toHaveLength(1);
    expect(view.costs).toHaveLength(1);
    expect(view.position.contractValueIqd).toBe(price('1000000'));
  });

  it('reports budget vs committed vs actual vs forecast by cost code', async () => {
    await activeProject();
    await withScope(scope(manager), (tx) =>
      projects.commit(tx, manager, PRJ, {
        costCode: 'CIVIL',
        amountIqd: price('10000'),
        committedOn: '2026-02-01',
      }),
    );

    const report = await withScope(scope(manager), (tx) => projects.budgetReport(tx, manager, PRJ));
    expect(report[0]).toMatchObject({
      costCode: 'CIVIL',
      budgetIqd: '500000.0000',
      committedIqd: '10000.0000',
      actualIqd: '0.0000',
      availableIqd: '490000.0000',
    });
  });
});

describe('11.10 · revenue recognition waits for Finance (D1, now REQ-PM-001 D-PM-1)', () => {
  it('has a configuration slot and no default', async () => {
    await activeProject();
    const { rows } = await ownerPool.query(
      `select recognition_method from project where code = $1`,
      [PRJ],
    );
    // §10 forbids IT from inventing the treatment, and D1 is open. The column
    // exists to be filled in; nothing fills it and nothing reads it.
    expect(rows[0].recognition_method).toBeNull();
  });

  it('posts nothing to WIP until Finance ratifies the method', async () => {
    // PM-5 built the method §10 asked Finance to choose, and seeded it unratified:
    // until somebody with the settings' configure grant ratifies it, no run posts.
    const { rows: policy } = await ownerPool.query(`select method, ratified_at from project_recognition_policy where code = 'DEFAULT'`);
    expect(policy).toEqual([{ method: 'poc_cost_to_cost', ratified_at: null }]);
    const { rows } = await ownerPool.query(`select count(*)::int as n from project_recognition`);
    expect(rows[0].n).toBe(0);
  });
});
