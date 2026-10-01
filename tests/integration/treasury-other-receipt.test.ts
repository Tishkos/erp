/**
 * Phase 07.4 test gate — Other Receipts. §17.
 *
 *   - Other Receipts post to the configured account and carry required
 *     dimensions
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as receipts from '@/server/services/other-receipt';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseDecimal } from '@domain/money';

const BAGHDAD = 'BGW';
const price = (iqd: string) => parseDecimal(iqd, 4n);

let clerk: ActorContext;
let manager: ActorContext;
let bankAccountId: string;
let bankGlCode: string;
let incomeId: string;
let receivableId: string;
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
  await ownerPool.query(
    `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
     values ($1,2,'February 2026','2026-02-01','2026-02-28') on conflict do nothing`,
    [years[0].id],
  );
  await ownerPool.query(
    `insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by)
     values ('USD','accounting',1310.00000000,'2026-01-01',$1) on conflict do nothing`,
    [manager.principal.userId],
  );

  const { rows: bank } = await ownerPool.query(
    `select b.id, a.code from bank_cash_account b join chart_of_account a on a.id = b.gl_account_id
      where b.account_type = 'bank' limit 1`,
  );
  bankAccountId = bank[0].id;
  bankGlCode = bank[0].code;

  // Somewhere for the money to be *for*, and a control account to prove it
  // cannot go there.
  const { rows: revenue } = await ownerPool.query(
    `select id from chart_of_account where code = 'R000001'`,
  );
  const { rows: income } = await ownerPool.query(
    `insert into chart_of_account
       (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
        currency_restriction)
     values ('R9OTHER','Other Income',
             (select account_type from chart_of_account where code = 'R000001'),
             $1,false,true,'approved',1,'IQD') returning id`,
    [revenue[0].id],
  );
  incomeId = income[0].id;

  const { rows: assets } = await ownerPool.query(
    `select id from chart_of_account where code = 'A000001'`,
  );
  const { rows: receivable } = await ownerPool.query(
    `insert into chart_of_account
       (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
        currency_restriction, control_account)
     values ('A9TRADE','Trade Receivables',
             (select account_type from chart_of_account where code = 'A000001'),
             $1,false,true,'approved',1,'IQD','customer') returning id`,
    [assets[0].id],
  );
  receivableId = receivable[0].id;

  await ownerPool.query(
    `insert into department (code, name) values ('OPS','Operations') on conflict do nothing`,
  );

  for (const [event, role, accountId] of [
    ['treasury.other_receipt', 'bank', incomeId],
    ['treasury.other_receipt', 'other_income', incomeId],
  ] as const) {
    await ownerPool.query(
      `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
       values ($1,$2,$3,true,$4) on conflict do nothing`,
      [event, role, accountId, manager.principal.userId],
    );
  }
});

async function receipt(overrides: Partial<receipts.CreateOtherReceiptInput> = {}) {
  return withScope(scope(clerk), (tx) =>
    receipts.create(tx, clerk, {
      bankCashAccountId: bankAccountId,
      branchCode: BAGHDAD,
      receiptDate: '2026-02-10',
      amountIqd: price('750'),
      creditAccountId: incomeId,
      payer: 'Al Wataniya Insurance',
      departmentCode: 'OPS',
      businessLineCode: 'PRODUCT_SALES',
      reference: 'CLAIM-8812',
      ...overrides,
    }),
  );
}

// ---------------------------------------------------------------------------

describe('07.4 gate · Other Receipts post to the configured account (§17)', () => {
  it('debits the account the money arrived in and credits what it was for', async () => {
    const created = await receipt();
    await withScope(scope(manager), (tx) => receipts.approve(tx, manager, created.id));
    const posted = await withScope(scope(manager), (tx) => receipts.post(tx, manager, created.id));

    const { rows } = await ownerPool.query(
      `select a.code, l.debit_iqd, l.credit_iqd
         from journal_line l join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = $1 order by l.line_no`,
      [posted.journalEntryId],
    );

    expect(rows).toHaveLength(2);
    // The account the receipt named, not whichever account a `bank` mapping
    // points at — with two bank accounts those are different answers (§17).
    expect(rows[0]).toMatchObject({ code: bankGlCode, debit_iqd: '750.0000' });
    expect(rows[1]).toMatchObject({ code: 'R9OTHER', credit_iqd: '750.0000' });
  });

  it('carries the dimensions onto the income line (§4.2)', async () => {
    const created = await receipt();
    await withScope(scope(manager), (tx) => receipts.approve(tx, manager, created.id));
    const posted = await withScope(scope(manager), (tx) => receipts.post(tx, manager, created.id));

    const { rows } = await ownerPool.query(
      `select a.code, l.department_code, l.business_line_code, l.branch_code
         from journal_line l join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = $1 and a.code = 'R9OTHER'`,
      [posted.journalEntryId],
    );

    expect(rows[0]).toMatchObject({
      department_code: 'OPS',
      business_line_code: 'PRODUCT_SALES',
      branch_code: BAGHDAD,
    });
  });

  it('numbers itself and records who paid', async () => {
    const created = await receipt();
    const view = await withScope(scope(clerk), (tx) => receipts.view(tx, created.id));

    expect(created.receiptNo).toMatch(/^ORC-/);
    expect(view.payer).toBe('Al Wataniya Insurance');
    expect(view.reference).toBe('CLAIM-8812');
  });

  it('refuses a receipt from nobody', async () => {
    expect(await rejection(receipt({ payer: '   ' }))).toMatch(/who paid it in/);
  });

  it('refuses a receipt of nothing', async () => {
    expect(await rejection(receipt({ amountIqd: 0n }))).toMatch(/receives nothing/);
  });

  it('posts only after approval', async () => {
    const created = await receipt();

    expect(
      await rejection(withScope(scope(manager), (tx) => receipts.post(tx, manager, created.id))),
    ).toMatch(/posts once it has been approved/);
  });
});

describe('§16 · an Other Receipt cannot touch a subledger', () => {
  it('refuses to credit a control account', async () => {
    expect(await rejection(receipt({ creditAccountId: receivableId }))).toMatch(
      /control account for the customer subledger/,
    );
  });

  it('names what to use instead', async () => {
    expect(await rejection(receipt({ creditAccountId: receivableId }))).toMatch(
      /Customer Receipt/,
    );
  });

  it('is refused by the database as well as by the service', async () => {
    const created = await receipt();

    await expect(
      ownerPool.query(`update other_receipt set credit_account_id = $2 where id = $1`, [
        created.id,
        receivableId,
      ]),
    ).rejects.toThrow(/cannot credit one/);
  });

  it('has nowhere to record a customer even if somebody wanted to', async () => {
    const { rows } = await ownerPool.query(
      `select column_name from information_schema.columns
        where table_name = 'other_receipt' and column_name in ('customer_id','business_partner_id')`,
    );
    // The refusal is structural: there is no column, so an Other Receipt cannot
    // be quietly turned into a customer settlement.
    expect(rows).toHaveLength(0);
  });
});

describe('§17 · company-wide bank accounts', () => {
  it('allows the account to be used from another branch', async () => {
    await seedBranch('BSR', 'Basra');
    await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,'BSR')`, [
      clerk.principal.userId,
    ]);
    // D10 — permitted branches are data, so the principal has to be read again
    // for the new scope to exist. Without this the refusal would come from the
    // branch boundary rather than from the rule under test.
    clerk = {
      principal: await withScope(scope(clerk), (tx) =>
        authz.loadPrincipal(tx, clerk.principal.userId),
      ),
      branchCode: BAGHDAD,
    };

    await expect(receipt({ branchCode: 'BSR' })).resolves.toBeDefined();
  });

  it('records the account’s own currency rather than one typed in', async () => {
    const created = await receipt();
    const view = await withScope(scope(clerk), (tx) => receipts.view(tx, created.id));
    expect(view.currency).toBe('IQD');
  });
});
