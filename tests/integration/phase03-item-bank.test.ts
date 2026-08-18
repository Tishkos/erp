/**
 * Phase 03.3 and 03.5 — Item/Service and Bank/Cash masters, against a real
 * PostgreSQL instance.
 *
 * The two §9 prohibitions are the point of this file. Both are expressed so
 * that the prohibited state cannot be stored, not so that it is validated
 * against — a rule enforced only in application code is a rule an import can
 * walk past.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BAGHDAD = 'BGW';

let manager: ActorContext;
let secondManager: ActorContext;
let cashGlAccountId: string;
let bankGlAccountId: string;

async function createManager(): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    'Accounting Manager',
  ]);
  await ownerPool.query(
    `insert into user_role (user_id, role_code) values ($1,'accounting_manager')`,
    [id],
  );
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

async function approvedAccount(name: string): Promise<string> {
  const { rows } = await ownerPool.query(
    `select id from chart_of_account where code = 'A000001'`,
  );
  const account = await withScope(scope(manager), (tx) =>
    coa.createAccount(tx, manager, { name, parentId: rows[0].id, currencyRestriction: 'IQD' }),
  );
  await withScope(scope(manager), (tx) => coa.submitForApproval(tx, manager, account.id));
  await withScope(scope(secondManager), (tx) => coa.approve(tx, secondManager, account.id));
  return account.id;
}

/** An item with its base unit, created together so the deferred check passes. */
async function createItem(
  code: string,
  options: {
    isStock?: boolean;
    tracking?: string | null;
    baseUom?: string;
    barcode?: string | null;
  } = {},
): Promise<string> {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(
      `insert into item (code, name, is_stock, base_uom_code, tracking)
       values ($1, $1, $2, $3, $4) returning id`,
      [
        code,
        options.isStock ?? true,
        options.baseUom ?? 'EA',
        // `in` rather than `??`: an explicit null means "a service, tracking
        // nothing", which `??` would quietly turn back into batch tracking.
        'tracking' in options ? options.tracking : 'batch',
      ],
    );
    await client.query(
      `insert into item_uom (item_id, uom_code, conversion_numerator, conversion_denominator, barcode)
       values ($1, $2, 1, 1, $3)`,
      [rows[0].id, options.baseUom ?? 'EA', options.barcode ?? null],
    );
    await client.query('commit');
    return rows[0].id;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  manager = await createManager();
  secondManager = await createManager();
  cashGlAccountId = await approvedAccount('Petty Cash Float');
  bankGlAccountId = await approvedAccount('Bank — Al Rafidain');
});

// ---------------------------------------------------------------------------
describe('03.3 · every stock item is tracked (§9.3)', () => {
  it('accepts serial, batch or both', async () => {
    for (const tracking of ['serial', 'batch', 'serial_and_batch']) {
      await expect(createItem(`ITEM-${tracking}`, { tracking })).resolves.toBeDefined();
    }
  });

  it('refuses a stock item with no tracking, at the database', async () => {
    // "No-tracking is not allowed." An import or a script cannot walk past this.
    const message = await rejection(
      ownerPool.query(
        `insert into item (code, name, is_stock, base_uom_code, tracking)
         values ('ITEM-BAD','Untracked',true,'EA',null)`,
      ),
    );
    expect(message).toMatch(/item_stock_requires_tracking/);
  });

  it('refuses tracking on a service', async () => {
    const message = await rejection(
      ownerPool.query(
        `insert into item (code, name, is_stock, base_uom_code, tracking)
         values ('SVC-BAD','Consultancy',false,'HR','serial')`,
      ),
    );
    expect(message).toMatch(/item_service_has_no_tracking/);
  });

  it('accepts a service with no tracking', async () => {
    await expect(
      createItem('SVC-001', { isStock: false, tracking: null, baseUom: 'HR' }),
    ).resolves.toBeDefined();
  });
});

describe('03.3 · FIFO is the only valuation method (§9.2)', () => {
  it('defaults to FIFO', async () => {
    const id = await createItem('ITEM-001');
    const { rows } = await ownerPool.query(`select costing_method from item where id = $1`, [id]);
    expect(rows[0].costing_method).toBe('fifo');
  });

  it('cannot be set to anything else — no other value exists', async () => {
    // The enum has one member. This is not a validation that could be relaxed;
    // there is no other value to relax to.
    const message = await rejection(
      ownerPool.query(`update item set costing_method = 'weighted_average'`),
    );
    expect(message).toMatch(/invalid input value for enum costing_method/);

    const { rows } = await ownerPool.query(
      `select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
        where t.typname = 'costing_method'`,
    );
    expect(rows.map((r) => r.enumlabel)).toEqual(['fifo']);
  });
});

describe('03.3 · units of measure (§9.3)', () => {
  it('holds a conversion as a fraction, so it round-trips exactly', async () => {
    const id = await createItem('ITEM-BOX');
    await ownerPool.query(
      `insert into item_uom (item_id, uom_code, conversion_numerator, conversion_denominator)
       values ($1,'BOX',3,1)`,
      [id],
    );

    const { rows } = await ownerPool.query(
      `select conversion_numerator, conversion_denominator from item_uom
        where item_id = $1 and uom_code = 'BOX'`,
      [id],
    );
    // Stored as 3/1, never as 0.333333 — the value a decimal factor would hold
    // for the reverse direction, and the reason it drifts.
    expect(String(rows[0].conversion_numerator)).toBe('3');
    expect(String(rows[0].conversion_denominator)).toBe('1');
  });

  it('insists the base unit converts to itself at one', async () => {
    const id = await createItem('ITEM-002');

    const message = await rejection(
      ownerPool.query(
        `update item_uom set conversion_numerator = 12 where item_id = $1 and uom_code = 'EA'`,
        [id],
      ),
    );
    expect(message).toMatch(/converts to itself at one/);
  });

  it('insists an item’s base unit is among its units', async () => {
    // Otherwise the conversions have nothing to convert through.
    const message = await rejection(
      ownerPool.query(
        `insert into item (code, name, base_uom_code, tracking) values ('ITEM-ORPHAN','Orphan','KG','batch')`,
      ),
    );
    expect(message).toMatch(/is not among its units/);
  });

  it('refuses a non-positive conversion', async () => {
    const id = await createItem('ITEM-003');
    const message = await rejection(
      ownerPool.query(
        `insert into item_uom (item_id, uom_code, conversion_numerator) values ($1,'BOX',0)`,
        [id],
      ),
    );
    expect(message).toMatch(/item_uom_conversion_positive/);
  });

  it('resolves a barcode to one item and one unit (§9.3)', async () => {
    const id = await createItem('ITEM-004', { barcode: '5012345678900' });
    await ownerPool.query(
      `insert into item_uom (item_id, uom_code, conversion_numerator, barcode)
       values ($1,'BOX',12,'5012345678917')`,
      [id],
    );

    const { rows } = await ownerPool.query(
      `select i.code, u.uom_code from item_uom u join item i on i.id = u.item_id
        where u.barcode = '5012345678917'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code: 'ITEM-004', uom_code: 'BOX' });
  });

  it('refuses the same barcode on two units', async () => {
    // Scanning a box must not be able to resolve to a piece.
    const id = await createItem('ITEM-005', { barcode: '9990001' });
    const message = await rejection(
      ownerPool.query(
        `insert into item_uom (item_id, uom_code, conversion_numerator, barcode)
         values ($1,'BOX',12,'9990001')`,
        [id],
      ),
    );
    expect(message).toMatch(/item_uom_barcode_uniq/);
  });
});

describe('03.3 · item identity and lifecycle', () => {
  it('refuses a duplicate item code', async () => {
    await createItem('ITEM-DUP');
    await expect(createItem('ITEM-DUP')).rejects.toThrow();
  });

  it('is deactivated, never deleted (§4.4)', async () => {
    const id = await createItem('ITEM-006');
    expect(await rejection(ownerPool.query(`delete from item where id = $1`, [id]))).toMatch(
      /deactivated, never deleted/,
    );
  });

  it('carries an inactive date for Appendix B enforcement', async () => {
    const id = await createItem('ITEM-007');
    await ownerPool.query(`update item set inactive_from = '2026-09-01' where id = $1`, [id]);

    const { rows } = await ownerPool.query(`select inactive_from from item where id = $1`, [id]);
    expect(rows[0].inactive_from).toBe('2026-09-01');
  });
});

// ---------------------------------------------------------------------------
describe('03.5 · bank and cash accounts (§4.3, §17)', () => {
  async function createBankAccount(overrides: Record<string, unknown> = {}) {
    const values = {
      code: 'BANK-001',
      name: 'Al Rafidain Current Account',
      account_type: 'bank',
      bank_name: 'Al Rafidain Bank',
      account_number: '1234567890',
      currency: 'IQD',
      gl_account_id: bankGlAccountId,
      branch_code: BAGHDAD,
      ...overrides,
    };

    return ownerPool.query(
      `insert into bank_cash_account
         (code, name, account_type, bank_name, account_number, currency, gl_account_id,
          branch_code, custodian_user_id, cash_limit_iqd, approval_limit_iqd)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
      [
        values.code,
        values.name,
        values.account_type,
        values.bank_name,
        values.account_number,
        values.currency,
        values.gl_account_id,
        values.branch_code,
        (values as Record<string, unknown>).custodian_user_id ?? null,
        (values as Record<string, unknown>).cash_limit_iqd ?? null,
        (values as Record<string, unknown>).approval_limit_iqd ?? null,
      ],
    );
  }

  it('maps to exactly one G/L account, and no two share one', async () => {
    // A bank statement reconciles against a G/L balance, and that is only a
    // reconciliation if the balance belongs to one account.
    await createBankAccount();

    const message = await rejection(
      createBankAccount({ code: 'BANK-002', account_number: '9999999999' }),
    );
    expect(message).toMatch(/bank_cash_account_gl_uniq/);
  });

  it('detects a duplicate account number before saving (§4.4)', async () => {
    await createBankAccount();

    const message = await rejection(
      createBankAccount({ code: 'BANK-002', gl_account_id: cashGlAccountId }),
    );
    expect(message).toMatch(/bank_cash_account_number_uniq/);
  });

  it('refuses a cash account with no custodian (§17)', async () => {
    // A cash float that is nobody's responsibility cannot be counted.
    const message = await rejection(
      createBankAccount({
        code: 'CASH-001',
        account_type: 'cash',
        account_number: null,
        gl_account_id: cashGlAccountId,
      }),
    );
    expect(message).toMatch(/bank_cash_cash_needs_custodian/);
  });

  it('accepts a cash account with a custodian and a limit', async () => {
    await expect(
      createBankAccount({
        code: 'CASH-001',
        account_type: 'cash',
        account_number: null,
        gl_account_id: cashGlAccountId,
        custodian_user_id: manager.principal.userId,
        cash_limit_iqd: '5000000.0000',
        approval_limit_iqd: '1000000.0000',
      }),
    ).resolves.toBeDefined();

    const { rows } = await ownerPool.query(
      `select custodian_user_id, cash_limit_iqd, approval_limit_iqd from bank_cash_account
        where code = 'CASH-001'`,
    );
    expect(rows[0].custodian_user_id).toBe(manager.principal.userId);
    expect(rows[0].cash_limit_iqd).toBe('5000000.0000');
    expect(rows[0].approval_limit_iqd).toBe('1000000.0000');
  });

  it('refuses a bank account with no number — it could not be reconciled', async () => {
    const message = await rejection(createBankAccount({ account_number: null }));
    expect(message).toMatch(/bank_cash_bank_needs_number/);
  });

  it('refuses a G/L account that cannot hold a cash position', async () => {
    const { rows } = await ownerPool.query(
      `select id from chart_of_account where code = 'A000001'`,
    );
    const message = await rejection(createBankAccount({ gl_account_id: rows[0].id }));
    expect(message).toMatch(/is a group; a cash position cannot be carried in one/);
  });

  it('refuses an unapproved G/L account', async () => {
    const { rows } = await ownerPool.query(
      `select id from chart_of_account where code = 'A000001'`,
    );
    const draft = await withScope(scope(manager), (tx) =>
      coa.createAccount(tx, manager, { name: 'Unapproved Bank', parentId: rows[0].id, currencyRestriction: 'IQD' }),
    );

    const message = await rejection(createBankAccount({ gl_account_id: draft.id }));
    expect(message).toMatch(/not approved and active/);
  });

  it('is deactivated, never deleted', async () => {
    await createBankAccount();
    expect(
      await rejection(ownerPool.query(`delete from bank_cash_account where code = 'BANK-001'`)),
    ).toMatch(/deactivated, never deleted/);
  });

  it('can be set as a branch’s default cash account (§4.1)', async () => {
    const { rows } = await createBankAccount();
    await ownerPool.query(`update branch set default_cash_account_id = $1 where code = $2`, [
      rows[0].id,
      BAGHDAD,
    ]);

    const branch = await ownerPool.query(
      `select default_cash_account_id from branch where code = $1`,
      [BAGHDAD],
    );
    expect(branch.rows[0].default_cash_account_id).toBe(rows[0].id);
  });
});
