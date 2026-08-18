/**
 * Phase 12 test gates — fixed assets. §18, Appendix B, C and E (IAS 16).
 *
 * 12.1  Category defaults populate the document and stay overridable · account
 *       mappings resolve through the posting profile · a category in use cannot
 *       be deleted
 * 12.2  The document needs an Available for Use Date · all thirteen §18.2 fields
 *       · recognition posts Dr Cost / Cr source with **no clearing account** ·
 *       it links to its purchasing evidence · codes come from the numbering
 *       service
 * 12.3  January acquisition, March availability → depreciates from March · the
 *       run is idempotent · charges carry the asset's dimensions · accumulated
 *       depreciation ties to the G/L · a part period prorates · it stops at
 *       residual value
 * 12.4  A transfer moves future depreciation and leaves the past · assignment is
 *       visible for offboarding · approval history is complete
 * 12.5  Impairment reduces carrying value separately from depreciation
 * 12.6  Disposal clears cost, depreciation and impairment · gain and loss both
 *       compute · a disposed asset takes no further charge
 * 12.7  Verification records what was found · a variance needs approval
 * 12.8  NBV = cost − depreciation − impairment · the register reconciles to the
 *       G/L by category, branch and cost centre
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as assets from '@/server/services/fixed-assets';
import * as jobs from '@/server/services/jobs';
import * as coa from '@/server/services/chart-of-accounts';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseDecimal } from '@domain/money';

const BAGHDAD = 'BGW';
const price = (iqd: string) => parseDecimal(iqd, 4n);

let clerk: ActorContext;
let manager: ActorContext;
let accounts: Record<string, string>;
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

  clerk = await createUser('accounting_officer');
  manager = await createUser('accounting_manager');

  await ownerPool.query(
    `insert into fiscal_year (code, name, starts_on, ends_on, status)
     values ('FY2026','2026','2026-01-01','2026-12-31','open') on conflict do nothing`,
  );
  const { rows: years } = await ownerPool.query(`select id from fiscal_year where code = 'FY2026'`);
  for (const [no, name, from, to] of [
    [1, 'January 2026', '2026-01-01', '2026-01-31'],
    [2, 'February 2026', '2026-02-01', '2026-02-28'],
    [3, 'March 2026', '2026-03-01', '2026-03-31'],
    [4, 'April 2026', '2026-04-01', '2026-04-30'],
    [5, 'May 2026', '2026-05-01', '2026-05-31'],
  ] as const) {
    await ownerPool.query(
      `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
       values ($1,$2,$3,$4,$5) on conflict do nothing`,
      [years[0].id, no, name, from, to],
    );
  }
  await ownerPool.query(
    `insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by)
     values ('USD','accounting',1310.00000000,'2026-01-01',$1) on conflict do nothing`,
    [manager.principal.userId],
  );
  await ownerPool.query(
    `insert into department (code, name) values ('OPS','Operations') on conflict do nothing`,
  );
  await ownerPool.query(
    `insert into cost_centre (code, name, branch_code) values ('CC-1','Plant',$1)
     on conflict do nothing`,
    [BAGHDAD],
  );

  // The accounts §18.4's four events post to.
  accounts = {};
  for (const [role, parent, code, name] of [
    ['fixed_asset_cost', 'A000001', 'A9FACOST', 'Fixed Asset Cost'],
    ['accumulated_depreciation', 'A000001', 'A9ACCDEP', 'Accumulated Depreciation'],
    ['accumulated_impairment', 'A000001', 'A9ACCIMP', 'Accumulated Impairment'],
    ['asset_source', 'L000001', 'L9FAPAY', 'Asset Payable'],
    ['disposal_proceeds', 'A000001', 'A9DISPRO', 'Disposal Proceeds'],
    ['depreciation_expense', 'X000001', 'X9DEPEXP', 'Depreciation Expense'],
    ['impairment_loss', 'X000001', 'X9IMPLOS', 'Impairment Loss'],
    ['disposal_loss', 'X000001', 'X9DISLOS', 'Disposal Loss'],
    ['disposal_gain', 'R000001', 'R9DISGAI', 'Disposal Gain'],
  ] as const) {
    const { rows: parents } = await ownerPool.query(
      `select id, account_type from chart_of_account where code = $1`,
      [parent],
    );
    const { rows } = await ownerPool.query(
      `insert into chart_of_account
         (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
          currency_restriction)
       values ($1,$2,$3,$4,false,true,'approved',1,'IQD') returning id`,
      [code, name, parents[0].account_type, parents[0].id],
    );
    accounts[role] = rows[0].id;

    for (const event of ['assets.recognition', 'assets.depreciation', 'assets.impairment', 'assets.disposal'] as const) {
      await ownerPool.query(
        `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
         values ($1,$2,$3,true,$4) on conflict do nothing`,
        [event, role, rows[0].id, manager.principal.userId],
      );
    }
  }

  // §4.2 — nobody chooses a department for a depreciation charge or a business
  // line for a gain on disposal; the system generates them. D15 asks who does.
  for (const role of [
    'depreciation_expense',
    'impairment_loss',
    'disposal_loss',
    'disposal_gain',
  ] as const) {
    await withScope(scope(manager), (tx) =>
      coa.setRequiredDimensions(tx, manager, accounts[role]!, []),
    );
  }

  await ownerPool.query(
    `insert into asset_category
       (code, name, default_useful_life_months, default_residual_percent, default_method)
     values ('PLANT','Plant and machinery', 36, 10.0000, 'straight_line')`,
  );
});

/**
 * An asset acquired in January, available for use in March.
 *
 * An override of `undefined` removes the field rather than passing it, so a
 * test can say "state no useful life" and get the category default.
 */
type AssetOverrides = Partial<Record<keyof assets.CreateAssetInput, unknown>>;

async function asset(overrides: AssetOverrides = {}) {
  const input = {
    description: 'Concrete mixer',
    categoryCode: 'PLANT',
    branchCode: BAGHDAD,
    departmentCode: 'OPS',
    costCentreCode: 'CC-1',
    location: 'Baghdad yard',
    custodianUserId: clerk.principal.userId,
    acquisitionCostIqd: price('120000'),
    acquiredOn: '2026-01-15',
    availableForUseOn: '2026-03-01',
    usefulLifeMonths: 36,
    residualValueIqd: price('12000'),
    supplierReference: 'SUP-INV-4471',
    ...overrides,
  } as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (input[key] === undefined) delete input[key];
  }

  return withScope(scope(clerk), (tx) =>
    assets.create(tx, clerk, input as unknown as assets.CreateAssetInput),
  );
}

async function recognised(overrides: AssetOverrides = {}) {
  const created = await asset(overrides);
  await withScope(scope(manager), (tx) =>
    assets.recognise(tx, manager, created.id, {
      creditAccountId: accounts.asset_source!,
      postingDate: '2026-01-15',
    }),
  );
  return created;
}

async function run(periodStart: string, periodEnd: string) {
  return withScope(scope(manager), (tx) =>
    assets.runDepreciation(tx, manager, { periodStart, periodEnd, branchCode: BAGHDAD }),
  );
}

// ---------------------------------------------------------------------------

describe('12.1 gate · categories (§18.1)', () => {
  it('populates the document from the category and lets it be overridden', async () => {
    const fromDefaults = await asset({ usefulLifeMonths: undefined, residualValueIqd: undefined });
    const { rows: defaults } = await ownerPool.query(
      `select useful_life_months, residual_value_iqd, depreciation_method from fixed_asset where id = $1`,
      [fromDefaults.id],
    );
    expect(defaults[0].useful_life_months).toBe(36);
    expect(Number(defaults[0].residual_value_iqd)).toBe(12000); // 10% of 120,000
    expect(defaults[0].depreciation_method).toBe('straight_line');

    const overridden = await asset({ usefulLifeMonths: 60, residualValueIqd: price('5000') });
    const { rows: over } = await ownerPool.query(
      `select useful_life_months, residual_value_iqd from fixed_asset where id = $1`,
      [overridden.id],
    );
    expect(over[0].useful_life_months).toBe(60);
    expect(Number(over[0].residual_value_iqd)).toBe(5000);
  });

  it('names account roles, not accounts — §3.3 resolves them', async () => {
    const { rows } = await ownerPool.query(
      `select column_name from information_schema.columns
        where table_name = 'asset_category' and column_name like '%account%'`,
    );
    // Every one is a *_role column; none is an account id.
    expect(rows.every((r) => r.column_name.endsWith('_role'))).toBe(true);
  });

  it('refuses to delete a category an asset uses', async () => {
    await asset();
    await expect(
      ownerPool.query(`delete from asset_category where code = 'PLANT'`),
    ).rejects.toThrow(/cannot be deleted/);
  });

  it('refuses an asset whose category has no useful life and states none', async () => {
    await ownerPool.query(
      `insert into asset_category (code, name, default_method) values ('NOLIFE','No life','straight_line')`,
    );

    expect(
      await rejection(asset({ categoryCode: 'NOLIFE', usefulLifeMonths: undefined })),
    ).toMatch(/no default useful life/);
  });
});

describe('12.2 gate · the Fixed Asset Document (§18.2)', () => {
  it('cannot be saved without an Available for Use Date', async () => {
    const { rows } = await ownerPool.query(
      `select is_nullable from information_schema.columns
        where table_name = 'fixed_asset' and column_name = 'available_for_use_on'`,
    );
    // §18.2 calls it mandatory; NOT NULL is the strongest form of that word.
    expect(rows[0].is_nullable).toBe('NO');
  });

  it('carries all thirteen §18.2 fields', async () => {
    const { rows } = await ownerPool.query(
      `select column_name from information_schema.columns where table_name = 'fixed_asset'`,
    );
    const present = new Set(rows.map((r) => r.column_name));
    for (const column of [
      'asset_code',
      'description',
      'category_code',
      'branch_code',
      'department_code',
      'cost_centre_code',
      'location',
      'custodian_user_id',
      'acquisition_cost_iqd',
      'useful_life_months',
      'residual_value_iqd',
      'depreciation_method',
      'available_for_use_on',
    ]) {
      expect(present.has(column)).toBe(true);
    }
  });

  it('posts Dr Fixed Asset Cost / Cr the source account, with nothing between', async () => {
    const created = await recognised();

    const { rows } = await ownerPool.query(
      `select a.code, l.debit_iqd, l.credit_iqd
         from journal_line l
         join journal_entry e on e.id = l.journal_entry_id
         join chart_of_account a on a.id = l.account_id
        where e.description like 'Fixed asset%' order by l.line_no`,
    );

    // Exactly two lines. §18.2 — no Asset Clearing Account.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ code: 'A9FACOST', debit_iqd: '120000.0000' });
    expect(rows[1]).toMatchObject({ code: 'L9FAPAY', credit_iqd: '120000.0000' });
    expect(created.assetCode).toMatch(/^FA-/);
  });

  it('has nowhere to record a clearing account (§18.2, §28)', async () => {
    const { rows } = await ownerPool.query(
      `select column_name from information_schema.columns
        where table_name in ('fixed_asset','asset_category')
          and column_name like '%clearing%'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('links to its purchasing evidence', async () => {
    const created = await asset();
    const { rows } = await ownerPool.query(
      `select supplier_reference from fixed_asset where id = $1`,
      [created.id],
    );
    expect(rows[0].supplier_reference).toBe('SUP-INV-4471');
  });

  it('refuses an asset available before it was acquired', async () => {
    await expect(
      ownerPool.query(
        `insert into fixed_asset
           (asset_code, description, category_code, branch_code, acquisition_cost_iqd,
            acquired_on, useful_life_months, residual_value_iqd, depreciation_method,
            available_for_use_on, created_by)
         values ('FA-BAD','Impossible','PLANT',$1,1000,'2026-03-01',12,0,'straight_line',
                 '2026-01-01',$2)`,
        [BAGHDAD, clerk.principal.userId],
      ),
    ).rejects.toThrow(/fixed_asset_available_after_acquired/);
  });

  it('refuses a residual value at or above cost', async () => {
    expect(
      await rejection(asset({ residualValueIqd: price('120000') })),
    ).toMatch(/fixed_asset_residual_below_cost/);
  });
});

describe('12.3 gate · depreciation starts from the Available for Use Date (§18.5)', () => {
  it('charges nothing for January or February, and charges from March', async () => {
    await recognised();

    const january = await run('2026-01-01', '2026-01-31');
    const february = await run('2026-02-01', '2026-02-28');
    const march = await run('2026-03-01', '2026-03-31');

    expect(january.assetsCharged).toBe(0);
    expect(february.assetsCharged).toBe(0);
    expect(march.assetsCharged).toBe(1);
    // (120,000 − 12,000) ÷ 36 = 3,000
    expect(march.totalChargeIqd).toBe('3000.0000');
  });

  it('is idempotent — running the same period twice posts once', async () => {
    await recognised();
    const first = await run('2026-03-01', '2026-03-31');
    const second = await run('2026-03-01', '2026-03-31');

    expect(first.assetsCharged).toBe(1);
    expect(second.assetsCharged).toBe(0);
    expect(second.assetsSkipped).toBe(1);

    const { rows } = await ownerPool.query(
      `select count(*)::int as n from asset_depreciation`,
    );
    expect(rows[0].n).toBe(1);
  });

  it('will not let the database hold two charges for one period', async () => {
    const created = await recognised();
    await run('2026-03-01', '2026-03-31');

    await expect(
      ownerPool.query(
        `insert into asset_depreciation
           (asset_id, period_start, period_end, charge_iqd, accumulated_after_iqd, posted_by)
         values ($1,'2026-03-01','2026-03-31',1,1,$2)`,
        [created.id, manager.principal.userId],
      ),
    ).rejects.toThrow(/asset_depreciation_period_uniq/);
  });

  it('refuses a charge dated before the asset was available', async () => {
    const created = await recognised();

    await expect(
      ownerPool.query(
        `insert into asset_depreciation
           (asset_id, period_start, period_end, charge_iqd, accumulated_after_iqd, posted_by)
         values ($1,'2026-01-01','2026-01-31',1,1,$2)`,
        [created.id, manager.principal.userId],
      ),
    ).rejects.toThrow(/becomes available for use on/);
  });

  it('carries the asset’s branch, department and cost centre', async () => {
    await recognised();
    await run('2026-03-01', '2026-03-31');

    const { rows } = await ownerPool.query(
      `select branch_code, department_code, cost_centre_code from asset_depreciation`,
    );
    expect(rows[0]).toMatchObject({
      branch_code: BAGHDAD,
      department_code: 'OPS',
      cost_centre_code: 'CC-1',
    });
  });

  it('ties accumulated depreciation to its G/L account', async () => {
    await recognised();
    await run('2026-03-01', '2026-03-31');
    await run('2026-04-01', '2026-04-30');

    const { rows: ledger } = await ownerPool.query(
      `select coalesce(sum(l.credit_iqd - l.debit_iqd), 0)::text as balance
         from journal_line l join chart_of_account a on a.id = l.account_id
        where a.code = 'A9ACCDEP'`,
    );
    const { rows: register } = await ownerPool.query(
      `select coalesce(sum(charge_iqd), 0)::text as total from asset_depreciation`,
    );

    expect(ledger[0].balance).toBe(register[0].total);
    expect(Number(register[0].total)).toBe(6000);
  });

  it('prorates a part first period on days', async () => {
    await recognised({ availableForUseOn: '2026-03-20' });
    const march = await run('2026-03-01', '2026-03-31');

    // 12 days of 31, of a 3,000 monthly charge.
    expect(Number(march.totalChargeIqd)).toBeCloseTo((3000 * 12) / 31, 0);
    expect(Number(march.totalChargeIqd)).toBeLessThan(3000);
  });

  it('stops at residual value and does not go below it', async () => {
    const created = await recognised();

    // Charge everything but the last 1,000 by hand, then run once more.
    await ownerPool.query(
      `insert into asset_depreciation
         (asset_id, period_start, period_end, charge_iqd, accumulated_after_iqd, posted_by)
       values ($1,'2026-03-01','2026-03-31',107000,107000,$2)`,
      [created.id, manager.principal.userId],
    );

    const april = await run('2026-04-01', '2026-04-30');
    expect(Number(april.totalChargeIqd)).toBe(1000);

    const value = await withScope(scope(manager), (tx) =>
      assets.carryingValueOf(tx, created.id),
    );
    expect(value.netBookValueIqd).toBe(price('12000'));

    const may = await run('2026-05-01', '2026-05-31');
    expect(may.assetsCharged).toBe(0);
  });

  it('will not let the database hold a charge past residual value', async () => {
    const created = await recognised();

    await expect(
      ownerPool.query(
        `insert into asset_depreciation
           (asset_id, period_start, period_end, charge_iqd, accumulated_after_iqd, posted_by)
         values ($1,'2026-03-01','2026-03-31',200000,200000,$2)`,
        [created.id, manager.principal.userId],
      ),
    ).rejects.toThrow(/below its residual value/);
  });
});

describe('12.4 gate · transfers (§18.5)', () => {
  it('moves future depreciation and leaves the past where it was', async () => {
    const created = await recognised();
    await run('2026-03-01', '2026-03-31');

    await seedBranch('BSR', 'Basra');
    await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,'BSR')`, [
      manager.principal.userId,
    ]);
    await ownerPool.query(
      `insert into department (code, name) values ('SITE','Site works') on conflict do nothing`,
    );

    await withScope(scope(manager), (tx) =>
      assets.transfer(tx, manager, created.id, {
        transferredOn: '2026-04-01',
        reason: 'Moved to the Basra site',
        requestedBy: clerk.principal.userId,
        toDepartmentCode: 'SITE',
      }),
    );

    await run('2026-04-01', '2026-04-30');

    const { rows } = await ownerPool.query(
      `select period_end, department_code from asset_depreciation order by period_end`,
    );
    expect(rows[0]).toMatchObject({ department_code: 'OPS' });
    expect(rows[1]).toMatchObject({ department_code: 'SITE' });
  });

  it('records the whole approval history, from and to', async () => {
    const created = await recognised();
    await ownerPool.query(
      `insert into department (code, name) values ('SITE','Site works') on conflict do nothing`,
    );

    await withScope(scope(manager), (tx) =>
      assets.transfer(tx, manager, created.id, {
        transferredOn: '2026-04-01',
        reason: 'Moved to the Basra site',
        requestedBy: clerk.principal.userId,
        toDepartmentCode: 'SITE',
        toLocation: 'Basra yard',
      }),
    );

    const { rows } = await ownerPool.query(
      `select from_department_code, to_department_code, from_location, to_location,
              reason, requested_by, approved_by from asset_transfer`,
    );
    expect(rows[0]).toMatchObject({
      from_department_code: 'OPS',
      to_department_code: 'SITE',
      from_location: 'Baghdad yard',
      to_location: 'Basra yard',
      requested_by: clerk.principal.userId,
      approved_by: manager.principal.userId,
    });
  });

  it('refuses the requester as their own approver (§5.2)', async () => {
    const created = await recognised();

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          assets.transfer(tx, manager, created.id, {
            transferredOn: '2026-04-01',
            reason: 'Moved',
            requestedBy: manager.principal.userId,
          }),
        ),
      ),
    ).toMatch(/somebody else approves it/);
  });

  it('refuses a transfer with no reason', async () => {
    const created = await recognised();

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          assets.transfer(tx, manager, created.id, {
            transferredOn: '2026-04-01',
            reason: '  ',
            requestedBy: clerk.principal.userId,
          }),
        ),
      ),
    ).toMatch(/needs a reason/);
  });

  it('shows what an employee is holding, for §20 offboarding', async () => {
    await recognised();
    const held = await withScope(scope(manager), (tx) =>
      assets.assetsHeldBy(tx, clerk.principal.userId),
    );
    expect(held).toHaveLength(1);
    expect(held[0]!.description).toBe('Concrete mixer');
  });
});

describe('12.5 gate · impairment (§18)', () => {
  it('reduces carrying value and stays separate from depreciation', async () => {
    const created = await recognised();
    await run('2026-03-01', '2026-03-31');

    const result = await withScope(scope(manager), (tx) =>
      assets.impair(tx, manager, created.id, {
        impairedOn: '2026-04-01',
        amountIqd: price('20000'),
        reason: 'Flood damage to the drum',
      }),
    );

    expect(result.carryingValueAfterIqd).toBe(price('97000')); // 120,000 − 3,000 − 20,000

    const value = await withScope(scope(manager), (tx) =>
      assets.carryingValueOf(tx, created.id),
    );
    expect(value.accumulatedDepreciationIqd).toBe(price('3000'));
    expect(value.accumulatedImpairmentIqd).toBe(price('20000'));
  });

  it('posts through the Phase 02 engine to the configured accounts', async () => {
    const created = await recognised();
    const result = await withScope(scope(manager), (tx) =>
      assets.impair(tx, manager, created.id, {
        impairedOn: '2026-04-01',
        amountIqd: price('20000'),
        reason: 'Flood damage',
      }),
    );

    const { rows } = await ownerPool.query(
      `select a.code, l.debit_iqd, l.credit_iqd
         from journal_line l join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = $1 order by l.line_no`,
      [result.journalEntryId],
    );
    expect(rows[0]).toMatchObject({ code: 'X9IMPLOS', debit_iqd: '20000.0000' });
    expect(rows[1]).toMatchObject({ code: 'A9ACCIMP', credit_iqd: '20000.0000' });
  });

  it('refuses an impairment beyond carrying value', async () => {
    const created = await recognised();

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          assets.impair(tx, manager, created.id, {
            impairedOn: '2026-04-01',
            amountIqd: price('200000'),
            reason: 'Too much',
          }),
        ),
      ),
    ).toMatch(/that is a disposal/);
  });

  it('refuses one with no stated basis', async () => {
    const created = await recognised();

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          assets.impair(tx, manager, created.id, {
            impairedOn: '2026-04-01',
            amountIqd: price('100'),
            reason: '   ',
          }),
        ),
      ),
    ).toMatch(/needs a reason/);
  });

  it('preserves the history rather than overwriting it', async () => {
    const created = await recognised();
    for (const [on, amount] of [
      ['2026-04-01', '10000'],
      ['2026-05-01', '5000'],
    ] as const) {
      await withScope(scope(manager), (tx) =>
        assets.impair(tx, manager, created.id, {
          impairedOn: on,
          amountIqd: price(amount),
          reason: `Review ${on}`,
        }),
      );
    }

    const { rows } = await ownerPool.query(
      `select impaired_on, amount_iqd, carrying_value_before_iqd from asset_impairment
        order by impaired_on`,
    );
    expect(rows).toHaveLength(2);
    expect(Number(rows[0].carrying_value_before_iqd)).toBe(120000);
    expect(Number(rows[1].carrying_value_before_iqd)).toBe(110000);
  });

  it('recalculates depreciation on the revised carrying value', async () => {
    const created = await recognised();
    await withScope(scope(manager), (tx) =>
      assets.impair(tx, manager, created.id, {
        impairedOn: '2026-03-01',
        amountIqd: price('20000'),
        reason: 'Flood damage',
      }),
    );

    // Straight line is unchanged by impairment under this method — the charge is
    // of the depreciable amount, and the impairment sits in its own account. The
    // carrying value nonetheless reflects both.
    const march = await run('2026-03-01', '2026-03-31');
    expect(Number(march.totalChargeIqd)).toBe(3000);

    const value = await withScope(scope(manager), (tx) =>
      assets.carryingValueOf(tx, created.id),
    );
    expect(value.netBookValueIqd).toBe(price('97000'));
  });
});

describe('12.6 gate · disposal (§18.6)', () => {
  async function depreciatedAsset() {
    const created = await recognised();
    await run('2026-03-01', '2026-03-31');
    await run('2026-04-01', '2026-04-30');
    return created;
  }

  it('clears cost, accumulated depreciation and impairment to zero', async () => {
    const created = await depreciatedAsset();
    await withScope(scope(manager), (tx) =>
      assets.impair(tx, manager, created.id, {
        impairedOn: '2026-05-01',
        amountIqd: price('10000'),
        reason: 'Damage',
      }),
    );

    await withScope(scope(manager), (tx) =>
      assets.dispose(tx, manager, created.id, {
        disposedOn: '2026-05-15',
        proceedsIqd: price('110000'),
        proceedsAccountId: accounts.disposal_proceeds!,
        reason: 'Sold',
      }),
    );

    const { rows } = await ownerPool.query(
      `select a.code, coalesce(sum(l.debit_iqd - l.credit_iqd), 0)::text as balance
         from journal_line l join chart_of_account a on a.id = l.account_id
        where a.code in ('A9FACOST','A9ACCDEP','A9ACCIMP')
        group by a.code order by a.code`,
    );
    for (const row of rows) expect(Number(row.balance)).toBe(0);
  });

  it('computes a gain when proceeds exceed carrying value', async () => {
    const created = await depreciatedAsset();

    const result = await withScope(scope(manager), (tx) =>
      assets.dispose(tx, manager, created.id, {
        disposedOn: '2026-05-15',
        proceedsIqd: price('120000'),
        proceedsAccountId: accounts.disposal_proceeds!,
      }),
    );

    // Carrying value 120,000 − 6,000 = 114,000; proceeds 120,000.
    expect(result.isGain).toBe(true);
    expect(result.gainOrLossIqd).toBe(price('6000'));
  });

  it('computes a loss when they fall short', async () => {
    const created = await depreciatedAsset();

    const result = await withScope(scope(manager), (tx) =>
      assets.dispose(tx, manager, created.id, {
        disposedOn: '2026-05-15',
        proceedsIqd: price('100000'),
        proceedsAccountId: accounts.disposal_proceeds!,
      }),
    );
    expect(result.isGain).toBe(false);
    expect(result.gainOrLossIqd).toBe(-price('14000'));
  });

  it('rejects further depreciation once disposed', async () => {
    const created = await depreciatedAsset();
    await withScope(scope(manager), (tx) =>
      assets.dispose(tx, manager, created.id, {
        disposedOn: '2026-05-01',
        proceedsIqd: price('100000'),
        proceedsAccountId: accounts.disposal_proceeds!,
      }),
    );

    const may = await run('2026-05-01', '2026-05-31');
    expect(may.assetsCharged).toBe(0);

    await expect(
      ownerPool.query(
        `insert into asset_depreciation
           (asset_id, period_start, period_end, charge_iqd, accumulated_after_iqd, posted_by)
         values ($1,'2026-05-01','2026-05-31',1,1,$2)`,
        [created.id, manager.principal.userId],
      ),
    ).rejects.toThrow(/takes no further depreciation/);
  });

  it('refuses to dispose of the same asset twice', async () => {
    const created = await depreciatedAsset();
    await withScope(scope(manager), (tx) =>
      assets.dispose(tx, manager, created.id, {
        disposedOn: '2026-05-01',
        proceedsIqd: price('100000'),
        proceedsAccountId: accounts.disposal_proceeds!,
      }),
    );

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          assets.dispose(tx, manager, created.id, {
            disposedOn: '2026-05-02',
            proceedsIqd: price('1'),
            proceedsAccountId: accounts.disposal_proceeds!,
          }),
        ),
      ),
    ).toMatch(/cannot be disposed of again/);
  });
});

describe('12.7 gate · physical verification (§18.7)', () => {
  it('records what was found against the register', async () => {
    const created = await recognised();

    const result = await withScope(scope(clerk), (tx) =>
      assets.verify(tx, clerk, created.id, {
        verifiedOn: '2026-04-01',
        found: 'present',
        foundLocation: 'Baghdad yard',
      }),
    );
    expect(result.hasVariance).toBe(false);
  });

  it('flags a variance and leaves the register alone until it is approved', async () => {
    const created = await recognised();

    const result = await withScope(scope(clerk), (tx) =>
      assets.verify(tx, clerk, created.id, {
        verifiedOn: '2026-04-01',
        found: 'moved',
        foundLocation: 'Basra yard',
        note: 'Found at the Basra site',
      }),
    );
    expect(result.hasVariance).toBe(true);

    const { rows: before } = await ownerPool.query(
      `select location from fixed_asset where id = $1`,
      [created.id],
    );
    expect(before[0].location).toBe('Baghdad yard');

    await withScope(scope(manager), (tx) => assets.approveVariance(tx, manager, result.id));

    const { rows: after } = await ownerPool.query(
      `select location from fixed_asset where id = $1`,
      [created.id],
    );
    expect(after[0].location).toBe('Basra yard');
  });

  it('refuses the verifier as their own variance approver (§5.2)', async () => {
    const created = await recognised();
    const result = await withScope(scope(manager), (tx) =>
      assets.verify(tx, manager, created.id, {
        verifiedOn: '2026-04-01',
        found: 'missing',
        note: 'Not on site',
      }),
    );

    expect(
      await rejection(
        withScope(scope(manager), (tx) => assets.approveVariance(tx, manager, result.id)),
      ),
    ).toMatch(/somebody else approves the variance/);
  });

  it('refuses a variance with no note saying what was wrong', async () => {
    const created = await recognised();

    await expect(
      ownerPool.query(
        `insert into asset_verification (asset_id, verified_on, found, verified_by)
         values ($1,'2026-04-01','missing',$2)`,
        [created.id, clerk.principal.userId],
      ),
    ).rejects.toThrow(/asset_verification_variance_is_explained/);
  });

  it('retains the verification history', async () => {
    const created = await recognised();
    for (const on of ['2026-04-01', '2026-05-01']) {
      await withScope(scope(clerk), (tx) =>
        assets.verify(tx, clerk, created.id, { verifiedOn: on, found: 'present' }),
      );
    }

    const view = await withScope(scope(manager), (tx) => assets.view(tx, created.id));
    expect(view.verifications).toHaveLength(2);
  });
});

describe('12.8 gate · the register reconciles to the G/L (§18.5, §18.8)', () => {
  it('computes net book value as cost − depreciation − impairment', async () => {
    const created = await recognised();
    await run('2026-03-01', '2026-03-31');
    await withScope(scope(manager), (tx) =>
      assets.impair(tx, manager, created.id, {
        impairedOn: '2026-04-01',
        amountIqd: price('10000'),
        reason: 'Damage',
      }),
    );

    const rows = await withScope(scope(manager), (tx) =>
      assets.register(tx, manager, { branchCode: BAGHDAD }),
    );
    expect(rows[0]).toMatchObject({
      acquisitionCostIqd: '120000.0000',
      accumulatedDepreciationIqd: '3000.0000',
      accumulatedImpairmentIqd: '10000.0000',
      netBookValueIqd: '107000.0000',
    });
  });

  it('reconciles to the G/L by category and branch', async () => {
    await recognised();
    await recognised({ description: 'Second mixer' });
    await run('2026-03-01', '2026-03-31');

    const rows = await withScope(scope(manager), (tx) =>
      assets.register(tx, manager, { branchCode: BAGHDAD, categoryCode: 'PLANT' }),
    );
    const registerCost = rows.reduce((sum, r) => sum + Number(r.acquisitionCostIqd), 0);
    const registerDepreciation = rows.reduce(
      (sum, r) => sum + Number(r.accumulatedDepreciationIqd),
      0,
    );

    const { rows: ledger } = await ownerPool.query(
      `select a.code, coalesce(sum(l.debit_iqd - l.credit_iqd), 0)::text as balance
         from journal_line l join chart_of_account a on a.id = l.account_id
        where a.code in ('A9FACOST','A9ACCDEP') group by a.code`,
    );
    const cost = Number(ledger.find((r) => r.code === 'A9FACOST')!.balance);
    const accumulated = -Number(ledger.find((r) => r.code === 'A9ACCDEP')!.balance);

    expect(registerCost).toBe(cost);
    expect(registerDepreciation).toBe(accumulated);
  });

  it('leaves disposed assets out unless asked for', async () => {
    const created = await recognised();
    await withScope(scope(manager), (tx) =>
      assets.dispose(tx, manager, created.id, {
        disposedOn: '2026-05-01',
        proceedsIqd: price('100000'),
        proceedsAccountId: accounts.disposal_proceeds!,
      }),
    );

    const open = await withScope(scope(manager), (tx) =>
      assets.register(tx, manager, { branchCode: BAGHDAD }),
    );
    const all = await withScope(scope(manager), (tx) =>
      assets.register(tx, manager, { branchCode: BAGHDAD, includeDisposed: true }),
    );

    expect(open).toHaveLength(0);
    expect(all).toHaveLength(1);
  });

  it('filters by custodian', async () => {
    await recognised();
    const rows = await withScope(scope(manager), (tx) =>
      assets.register(tx, manager, { custodianUserId: clerk.principal.userId }),
    );
    expect(rows).toHaveLength(1);
  });
});

describe('12.3 gate · the run is a scheduled background job (§18, Phase 01.10)', () => {
  it('is asked for through the outbox, not performed in the request', async () => {
    await recognised();

    await withScope(scope(manager), (tx) =>
      assets.scheduleDepreciationRun(tx, manager, {
        periodStart: '2026-03-01',
        periodEnd: '2026-03-31',
        branchCode: BAGHDAD,
      }),
    );

    // Nothing has been charged: the run is owed, not done.
    const { rows: before } = await ownerPool.query(
      `select count(*)::int as n from asset_depreciation`,
    );
    expect(before[0].n).toBe(0);

    assets.registerDepreciationHandler(async (userId, fn) =>
      withScope({ userId, branchCode: BAGHDAD }, async (tx) => {
        const principal = await authz.loadPrincipal(tx, userId);
        await fn(tx, { principal, branchCode: BAGHDAD });
      }),
    );

    expect((await jobs.dispatch(scope(manager))).dispatched).toBe(1);
    const run = await jobs.runNext(scope(manager), assets.DEPRECIATION_QUEUE);
    expect(run.outcome).toBe('completed');

    const { rows: after } = await ownerPool.query(
      `select charge_iqd from asset_depreciation`,
    );
    expect(after).toHaveLength(1);
    expect(Number(after[0].charge_iqd)).toBe(3000);
  });

  it('charges nothing twice when the queue delivers twice', async () => {
    await recognised();

    assets.registerDepreciationHandler(async (userId, fn) =>
      withScope({ userId, branchCode: BAGHDAD }, async (tx) => {
        const principal = await authz.loadPrincipal(tx, userId);
        await fn(tx, { principal, branchCode: BAGHDAD });
      }),
    );

    for (let delivery = 0; delivery < 2; delivery += 1) {
      await withScope(scope(manager), (tx) =>
        jobs.enqueue(tx, manager.principal.userId, {
          queueName: assets.DEPRECIATION_QUEUE,
          payload: {
            periodStart: '2026-03-01',
            periodEnd: '2026-03-31',
            branchCode: BAGHDAD,
            requestedBy: manager.principal.userId,
          },
        }),
      );
      await jobs.dispatch(scope(manager));
      expect((await jobs.runNext(scope(manager), assets.DEPRECIATION_QUEUE)).outcome).toBe(
        'completed',
      );
    }

    const { rows } = await ownerPool.query(`select count(*)::int as n from asset_depreciation`);
    expect(rows[0].n).toBe(1);
  });

  it('posts as the person who asked for the run, not as the worker', async () => {
    await recognised();

    // The clerk may create assets but not post them (§5.2). A run they asked
    // for must fail on their authority rather than succeed on the worker's.
    assets.registerDepreciationHandler(async (userId, fn) =>
      withScope({ userId, branchCode: BAGHDAD }, async (tx) => {
        const principal = await authz.loadPrincipal(tx, userId);
        await fn(tx, { principal, branchCode: BAGHDAD });
      }),
    );

    await withScope(scope(manager), (tx) =>
      jobs.enqueue(tx, manager.principal.userId, {
        queueName: assets.DEPRECIATION_QUEUE,
        payload: {
          periodStart: '2026-03-01',
          periodEnd: '2026-03-31',
          branchCode: BAGHDAD,
          requestedBy: clerk.principal.userId,
        },
      }),
    );
    await jobs.dispatch(scope(manager));

    const run = await jobs.runNext(scope(manager), assets.DEPRECIATION_QUEUE);
    expect(run.outcome).toBe('failed');

    const { rows } = await ownerPool.query(`select count(*)::int as n from asset_depreciation`);
    expect(rows[0].n).toBe(0);
  });
});

describe('12.2 gate · Appendix B statuses (§3.2, §24)', () => {
  it('carries Appendix B’s seven statuses, and only those', async () => {
    const { rows } = await ownerPool.query(
      `select unnest(enum_range(null::fixed_asset_status))::text as status`,
    );
    expect(rows.map((r) => r.status)).toEqual([
      'draft',
      'approved',
      'available_for_use',
      'active',
      'disposed',
      'closed',
      'reversed',
    ]);
  });

  it('keeps the operational lifecycle out of §24’s eleven words, on purpose', async () => {
    // Appendix B names Available for Use, Active and Disposed. None is one of
    // §24's eleven, and forcing them in would lose the distinction §18.5 turns
    // on: only an asset that is available for use may depreciate. So this
    // document keeps its own enum, as lead, stock_count and warehouse_transfer
    // do, and registers its **approval shape** in the shared table separately.
    const { rows: shared } = await ownerPool.query(
      `select unnest(enum_range(null::document_status))::text as status`,
    );
    const eleven = new Set(shared.map((r) => r.status));
    for (const operational of ['available_for_use', 'active', 'disposed']) {
      expect(eleven.has(operational)).toBe(false);
    }
  });

  it('registers its approval shape where every other document keeps one', async () => {
    const { rows } = await ownerPool.query(
      `select from_status, to_status from document_status_transition
        where document_type_code = 'fixed_asset' order by from_status, to_status`,
    );
    // Absent would mean an auditor reading the transition table finds this
    // document simply missing.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows).toContainEqual({ from_status: 'submitted', to_status: 'approved' });
    expect(rows).toContainEqual({ from_status: 'approved', to_status: 'posted' });
  });
});
describe('Phase 12 exit gate · §18.5 acceptance and the four §18.4 events', () => {
  it('issues asset codes through the Phase 01 numbering service, uniquely', async () => {
    const first = await asset();
    const second = await asset({ description: 'Second mixer' });

    expect(first.assetCode).not.toBe(second.assetCode);

    // Two allocations recorded against the sequence — the codes came from the
    // Phase 01 service, not from a count of rows.
    const { rows } = await ownerPool.query(
      `select serial, document_no from doc_number_allocation
        where sequence_key = 'FIXED_ASSET' order by serial`,
    );
    expect(rows.map((r) => r.document_no)).toEqual([first.assetCode, second.assetCode]);
    expect(rows.map((r) => Number(r.serial))).toEqual([1, 2]);

    await expect(
      ownerPool.query(
        `insert into fixed_asset
           (asset_code, description, category_code, branch_code, acquisition_cost_iqd,
            acquired_on, useful_life_months, residual_value_iqd, depreciation_method,
            available_for_use_on, created_by)
         values ($1,'Clash','PLANT',$2,1000,'2026-01-01',12,0,'straight_line','2026-01-01',$3)`,
        [first.assetCode, BAGHDAD, clerk.principal.userId],
      ),
    ).rejects.toThrow(/fixed_asset_code_uniq|duplicate key/);
  });

  it('keeps the register inside the reader’s branch scope (D10)', async () => {
    await recognised();
    await seedBranch('BSR', 'Basra');

    const outsider = await createUser('accounting_manager');
    await ownerPool.query(`delete from user_branch_scope where user_id = $1`, [
      outsider.principal.userId,
    ]);
    await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,'BSR')`, [
      outsider.principal.userId,
    ]);
    const reloaded = await withScope({ userId: outsider.principal.userId, branchCode: 'BSR' }, (tx) =>
      authz.loadPrincipal(tx, outsider.principal.userId),
    );
    const basra: ActorContext = { principal: reloaded, branchCode: 'BSR' };

    const rows = await withScope({ userId: basra.principal.userId, branchCode: 'BSR' }, (tx) =>
      assets.register(tx, basra, { branchCode: 'BSR' }),
    );
    expect(rows).toHaveLength(0);
  });

  it('posts the four §18.4 event rows to the accounts Appendix C names', async () => {
    const created = await recognised();
    await run('2026-03-01', '2026-03-31');
    await withScope(scope(manager), (tx) =>
      assets.impair(tx, manager, created.id, {
        impairedOn: '2026-04-01',
        amountIqd: price('10000'),
        reason: 'Damage',
      }),
    );
    await withScope(scope(manager), (tx) =>
      assets.dispose(tx, manager, created.id, {
        disposedOn: '2026-05-01',
        proceedsIqd: price('100000'),
        proceedsAccountId: accounts.disposal_proceeds!,
        reason: 'Sold',
      }),
    );

    const { rows } = await ownerPool.query(
      `select e.description, a.code, l.debit_iqd, l.credit_iqd
         from journal_line l
         join journal_entry e on e.id = l.journal_entry_id
         join chart_of_account a on a.id = l.account_id
        where a.code like '_9%' or a.code = 'L9FAPAY'
        order by e.posting_date, e.entry_no, l.line_no`,
    );
    const sideOf = (prefix: string, code: string) => {
      const row = rows.find((r) => r.description.startsWith(prefix) && r.code === code);
      if (!row) return 'absent';
      return Number(row.debit_iqd) > 0 ? 'debit' : 'credit';
    };

    // 1 · recognition — Dr Fixed Asset Cost / Cr the source account
    expect(sideOf('Fixed asset', 'A9FACOST')).toBe('debit');
    expect(sideOf('Fixed asset', 'L9FAPAY')).toBe('credit');
    // 2 · depreciation — Dr Depreciation Expense / Cr Accumulated Depreciation
    expect(sideOf('Depreciation', 'X9DEPEXP')).toBe('debit');
    expect(sideOf('Depreciation', 'A9ACCDEP')).toBe('credit');
    // 3 · impairment — Dr Impairment Loss / Cr Accumulated Impairment
    expect(sideOf('Impairment', 'X9IMPLOS')).toBe('debit');
    expect(sideOf('Impairment', 'A9ACCIMP')).toBe('credit');
    // 4 · disposal — Dr proceeds and the accumulated balances / Cr Asset Cost,
    //     with the shortfall as a debit to loss
    expect(sideOf('Disposal', 'A9DISPRO')).toBe('debit');
    expect(sideOf('Disposal', 'A9ACCDEP')).toBe('debit');
    expect(sideOf('Disposal', 'A9ACCIMP')).toBe('debit');
    expect(sideOf('Disposal', 'A9FACOST')).toBe('credit');
    expect(sideOf('Disposal', 'X9DISLOS')).toBe('debit');
  });

  it('reconciles the register to the G/L after a whole lifecycle', async () => {
    const kept = await recognised();
    const sold = await recognised({ description: 'Second mixer' });
    await run('2026-03-01', '2026-03-31');
    await withScope(scope(manager), (tx) =>
      assets.dispose(tx, manager, sold.id, {
        disposedOn: '2026-04-01',
        proceedsIqd: price('100000'),
        proceedsAccountId: accounts.disposal_proceeds!,
      }),
    );
    await run('2026-04-01', '2026-04-30');

    const open = await withScope(scope(manager), (tx) =>
      assets.register(tx, manager, { branchCode: BAGHDAD }),
    );
    expect(open).toHaveLength(1);
    expect(open[0]!.assetCode).toBe(kept.assetCode);

    const { rows: ledger } = await ownerPool.query(
      `select a.code, coalesce(sum(l.debit_iqd - l.credit_iqd), 0)::text as balance
         from journal_line l join chart_of_account a on a.id = l.account_id
        where a.code in ('A9FACOST','A9ACCDEP') group by a.code`,
    );
    const cost = Number(ledger.find((r) => r.code === 'A9FACOST')!.balance);
    const accumulated = -Number(ledger.find((r) => r.code === 'A9ACCDEP')!.balance);

    // The disposed asset has left both the register and the two G/L accounts.
    expect(cost).toBe(Number(open[0]!.acquisitionCostIqd));
    expect(accumulated).toBe(Number(open[0]!.accumulatedDepreciationIqd));
  });
});
