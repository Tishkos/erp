/**
 * Phase 07.5 test gate — petty cash and cash advances. §17, Appendix D.
 *
 *   - Petty cash balance per custodian is tracked and reconciles to its G/L
 *     account
 *   - Cash count variance requires approval and posts an adjustment
 *   - Petty cash advances age and are reported
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as advances from '@/server/services/cash-advance';
import * as treasury from '@/server/services/treasury';
import * as coa from '@/server/services/chart-of-accounts';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseDecimal } from '@domain/money';

const BAGHDAD = 'BGW';
const price = (iqd: string) => parseDecimal(iqd, 4n);

let clerk: ActorContext;
let manager: ActorContext;
let holder: ActorContext;
let floatAccountId: string;
let floatGlCode: string;
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

/** Money in the float's G/L account, so an advance has something to draw on. */
async function fund(amount: string, on = '2026-02-01') {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows: gl } = await client.query(`select id from chart_of_account where code = $1`, [
      floatGlCode,
    ]);
    const { rows: suspense } = await client.query(
      `select id from chart_of_account where code = 'L9SUSPEN'`,
    );
    const { rows: periods } = await client.query(
      `select id from fiscal_period where starts_on <= $1::date and ends_on >= $1::date limit 1`,
      [on],
    );
    const { rows: entry } = await client.query(
      `insert into journal_entry
         (entry_no, document_date, posting_date, fiscal_period_id, branch_code, description,
          status, total_debit_iqd, total_credit_iqd, created_by)
       values ($1,$2,$2,$3,$4,'Float top-up','draft',$5,$5,$6) returning id`,
      [`FUND-${(seq += 1)}`, on, periods[0].id, BAGHDAD, amount, manager.principal.userId],
    );
    await client.query(
      `insert into journal_line
         (journal_entry_id, line_no, account_id, debit_txn, credit_txn,
          debit_iqd, credit_iqd, debit_usd, credit_usd, currency, branch_code)
       values ($1, 1, $2, $3, 0, $3, 0, 0, 0, 'IQD', $5),
              ($1, 2, $4, 0, $3, 0, $3, 0, 0, 'IQD', $5)`,
      [entry[0].id, gl[0].id, amount, suspense[0].id, BAGHDAD],
    );
    await client.query(
      `update journal_entry set status = 'posted', approved_by = $2, posted_at = now() where id = $1`,
      [entry[0].id, manager.principal.userId],
    );
    await client.query('commit');
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

  clerk = await createUser('accounting_officer');
  manager = await createUser('accounting_manager');
  holder = await createUser('accounting_officer');

  await ownerPool.query(
    `insert into fiscal_year (code, name, starts_on, ends_on, status)
     values ('FY2026','2026','2026-01-01','2026-12-31','open') on conflict do nothing`,
  );
  const { rows: years } = await ownerPool.query(`select id from fiscal_year where code = 'FY2026'`);
  await ownerPool.query(
    `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
     values ($1,1,'January 2026','2026-01-01','2026-01-31'),
            ($1,2,'February 2026','2026-02-01','2026-02-28'),
            ($1,3,'March 2026','2026-03-01','2026-03-31')
     on conflict do nothing`,
    [years[0].id],
  );

  await ownerPool.query(
    `insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by)
     values ('USD','accounting',1310.00000000,'2026-01-01',$1) on conflict do nothing`,
    [manager.principal.userId],
  );

  // §17 — a float with a custodian and a limit.
  const { rows: parents } = await ownerPool.query(
    `select id from chart_of_account where code = 'A000001'`,
  );
  const { rows: gl } = await ownerPool.query(
    `insert into chart_of_account
       (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
        currency_restriction)
     values ('A9FLOAT','Baghdad Petty Cash Float','asset',$1,false,true,'approved',1,'IQD')
     returning id`,
    [parents[0].id],
  );
  floatGlCode = 'A9FLOAT';

  const { rows: float } = await ownerPool.query(
    `insert into bank_cash_account
       (code, name, account_type, currency, gl_account_id, custodian_user_id,
        cash_limit_iqd, approval_limit_iqd)
     values ('PC-BGW','Baghdad Petty Cash','cash','IQD',$1,$2,100000.0000,1000000.0000)
     returning id`,
    [gl[0].id, manager.principal.userId],
  );
  floatAccountId = float[0].id;

  // The accounts the advance and its receipts post to.
  accounts = {};
  for (const [role, parent, code, name] of [
    ['cash_advance', 'A000001', 'A9CADV', 'Cash Advances'],
    ['suspense', 'L000001', 'L9SUSPEN', 'Funding Suspense'],
    ['fuel', 'X000001', 'X9FUEL', 'Vehicle Fuel'],
    ['stationery', 'X000001', 'X9STAT', 'Office Stationery'],
    ['cash_variance', 'X000001', 'X9CASHVA', 'Cash Count Variance'],
  ] as const) {
    const { rows: parentRows } = await ownerPool.query(
      `select id, account_type from chart_of_account where code = $1`,
      [parent],
    );
    const { rows } = await ownerPool.query(
      `insert into chart_of_account
         (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
          currency_restriction)
       values ($1,$2,$3,$4,false,true,'approved',1,'IQD') returning id`,
      [code, name, parentRows[0].account_type, parentRows[0].id],
    );
    accounts[role] = rows[0].id;
  }

  // §4.2 — expense accounts need department and business line. The test states
  // them on each receipt; the dimensions themselves have to exist.
  await ownerPool.query(
    `insert into department (code, name) values ('OPS','Operations') on conflict do nothing`,
  );
  // One of the six §2.2 lines the migrations seed — not a new one. Business
  // lines are not reset between tests (they are configuration, not fixture
  // data), so a test that invented one would leave it behind for every test
  // that counts them.

  // §4.2 makes department and business line mandatory on every expense
  // account (migration 0005). A cash-count variance is an expense that no
  // document carries a department for — see D15 — so the requirement is
  // relaxed on that one account here rather than inventing a value.
  await withScope(scope(manager), (tx) =>
    coa.setRequiredDimensions(tx, manager, accounts.cash_variance!, []),
  );

  for (const [event, role, accountId] of [
    ['treasury.cash_advance_issue', 'cash_advance', accounts.cash_advance],
    ['treasury.cash_advance_issue', 'cash', accounts.cash_advance],
    ['treasury.cash_advance_settlement', 'cash_advance', accounts.cash_advance],
    ['treasury.cash_advance_settlement', 'cash', accounts.cash_advance],
    ['treasury.cash_advance_settlement', 'cash_advance_expense', accounts.fuel],
    ['treasury.cash_count', 'cash', accounts.cash_advance],
    ['treasury.cash_count', 'cash_variance', accounts.cash_variance],
  ] as const) {
    await ownerPool.query(
      `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
       values ($1,$2,$3,true,$4) on conflict do nothing`,
      [event, role, accountId, manager.principal.userId],
    );
  }
});

/** An approved, issued advance with money behind it. */
async function issuedAdvance(
  amount = '500',
  overrides: { dueDate?: string; issueDate?: string } = {},
) {
  const advance = await withScope(scope(clerk), (tx) =>
    advances.request(tx, clerk, {
      bankCashAccountId: floatAccountId,
      branchCode: BAGHDAD,
      holderUserId: holder.principal.userId,
      issueDate: overrides.issueDate ?? '2026-02-05',
      dueDate: overrides.dueDate ?? '2026-02-20',
      purpose: 'Fuel and tolls for the Basra delivery',
      amountIqd: price(amount),
    }),
  );
  await withScope(scope(manager), (tx) => advances.approve(tx, manager, advance.id));
  await withScope(scope(manager), (tx) => advances.issue(tx, manager, advance.id));
  return advance;
}

// ---------------------------------------------------------------------------

describe('07.5 · an advance is a receivable, not an expense (§17)', () => {
  it('posts Dr Cash Advance / Cr the float it came out of', async () => {
    await fund('10000');
    const advance = await issuedAdvance('500');

    const { rows } = await ownerPool.query(
      `select a.code, l.debit_iqd, l.credit_iqd
         from journal_line l
         join journal_entry e on e.id = l.journal_entry_id
         join chart_of_account a on a.id = l.account_id
        where e.description like 'Cash advance%' order by l.line_no`,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ code: 'A9CADV', debit_iqd: '500.0000' });
    expect(rows[1]).toMatchObject({ code: floatGlCode, credit_iqd: '500.0000' });
    expect(advance.advanceNo).toMatch(/^CAD-/);
  });

  it('refuses an advance the float cannot cover (§17)', async () => {
    await fund('100');

    const advance = await withScope(scope(clerk), (tx) =>
      advances.request(tx, clerk, {
        bankCashAccountId: floatAccountId,
        branchCode: BAGHDAD,
        holderUserId: holder.principal.userId,
        issueDate: '2026-02-05',
        dueDate: '2026-02-20',
        purpose: 'Fuel',
        amountIqd: price('500'),
      }),
    );
    await withScope(scope(manager), (tx) => advances.approve(tx, manager, advance.id));

    expect(
      await rejection(withScope(scope(manager), (tx) => advances.issue(tx, manager, advance.id))),
    ).toMatch(/holds .* and this needs/);
  });

  it('refuses an advance out of a bank account — that would be a payment', async () => {
    const { rows: bank } = await ownerPool.query(
      `select id from bank_cash_account where account_type = 'bank' limit 1`,
    );

    expect(
      await rejection(
        withScope(scope(clerk), (tx) =>
          advances.request(tx, clerk, {
            bankCashAccountId: bank[0].id,
            branchCode: BAGHDAD,
            holderUserId: holder.principal.userId,
            issueDate: '2026-02-05',
            dueDate: '2026-02-20',
            purpose: 'Fuel',
            amountIqd: price('100'),
          }),
        ),
      ),
    ).toMatch(/comes out of a float/);
  });

  it('refuses an advance with no stated purpose', async () => {
    expect(
      await rejection(
        withScope(scope(clerk), (tx) =>
          advances.request(tx, clerk, {
            bankCashAccountId: floatAccountId,
            branchCode: BAGHDAD,
            holderUserId: holder.principal.userId,
            issueDate: '2026-02-05',
            dueDate: '2026-02-20',
            purpose: '   ',
            amountIqd: price('100'),
          }),
        ),
      ),
    ).toMatch(/stated purpose/);
  });

  it('will not let one person raise and approve the same advance (§5.2)', async () => {
    await fund('10000');
    const advance = await withScope(scope(manager), (tx) =>
      advances.request(tx, manager, {
        bankCashAccountId: floatAccountId,
        branchCode: BAGHDAD,
        holderUserId: holder.principal.userId,
        issueDate: '2026-02-05',
        dueDate: '2026-02-20',
        purpose: 'Fuel',
        amountIqd: price('100'),
      }),
    );

    expect(
      await rejection(withScope(scope(manager), (tx) => advances.approve(tx, manager, advance.id))),
    ).toMatch(/somebody else approves it/);
  });
});

describe('07.5 · the receipts come back, and so does the change (§17)', () => {
  it('posts each receipt to the account it names, and clears the receivable', async () => {
    await fund('10000');
    const advance = await issuedAdvance('500');

    const result = await withScope(scope(manager), (tx) =>
      advances.settle(tx, manager, advance.id, {
        settlementDate: '2026-02-18',
        lines: [
          {
            accountId: accounts.fuel!,
            amountIqd: price('300'),
            spentOn: '2026-02-12',
            description: 'Diesel, Basra road',
            receiptReference: 'R-4471',
            departmentCode: 'OPS',
            businessLineCode: 'PRODUCT_SALES',
          },
          {
            accountId: accounts.stationery!,
            amountIqd: price('120'),
            spentOn: '2026-02-13',
            description: 'Delivery notebooks',
            departmentCode: 'OPS',
            businessLineCode: 'PRODUCT_SALES',
          },
        ],
        returnedIqd: price('80'),
      }),
    );

    expect(result.outstandingIqd).toBe(0n);

    const { rows } = await ownerPool.query(
      `select a.code, l.debit_iqd, l.credit_iqd
         from journal_line l join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = $1 order by l.line_no`,
      [result.journalEntryId],
    );

    expect(rows.map((r) => [r.code, r.debit_iqd, r.credit_iqd])).toEqual([
      ['X9FUEL', '300.0000', '0.0000'],
      ['X9STAT', '120.0000', '0.0000'],
      [floatGlCode, '80.0000', '0.0000'],
      ['A9CADV', '0.0000', '500.0000'],
    ]);
  });

  it('leaves it partly open when only some of it is accounted for', async () => {
    await fund('10000');
    const advance = await issuedAdvance('500');

    const result = await withScope(scope(manager), (tx) =>
      advances.settle(tx, manager, advance.id, {
        settlementDate: '2026-02-18',
        lines: [
          {
            accountId: accounts.fuel!,
            amountIqd: price('300'),
            spentOn: '2026-02-12',
            description: 'Diesel',
            departmentCode: 'OPS',
            businessLineCode: 'PRODUCT_SALES',
          },
        ],
      }),
    );

    expect(result.outstandingIqd).toBe(price('200'));

    const view = await withScope(scope(manager), (tx) => advances.view(tx, advance.id));
    expect(view.advance.status).toBe('partially_executed');
  });

  it('refuses receipts for more than was advanced', async () => {
    await fund('10000');
    const advance = await issuedAdvance('500');

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          advances.settle(tx, manager, advance.id, {
            settlementDate: '2026-02-18',
            lines: [
              {
                accountId: accounts.fuel!,
                amountIqd: price('600'),
                spentOn: '2026-02-12',
                description: 'Diesel',
                departmentCode: 'OPS',
                businessLineCode: 'PRODUCT_SALES',
              },
            ],
          }),
        ),
      ),
    ).toMatch(/that is an expense claim/);
  });

  it('refuses an accounting of nothing at all', async () => {
    await fund('10000');
    const advance = await issuedAdvance('500');

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          advances.settle(tx, manager, advance.id, {
            settlementDate: '2026-02-18',
            lines: [],
          }),
        ),
      ),
    ).toMatch(/accounted for with nothing/);
  });

  it('will not let an advance be filed while money is still out', async () => {
    await fund('10000');
    const advance = await issuedAdvance('500');

    await expect(
      ownerPool.query(
        `update cash_advance set status = 'settled', closed_at = now() where id = $1`,
        [advance.id],
      ),
    ).rejects.toThrow(/cash_advance_settled_means_settled/);
  });

  it('will not let the receipts disagree with the total they are said to add to', async () => {
    await fund('10000');
    const advance = await issuedAdvance('500');
    await withScope(scope(manager), (tx) =>
      advances.settle(tx, manager, advance.id, {
        settlementDate: '2026-02-18',
        lines: [
          {
            accountId: accounts.fuel!,
            amountIqd: price('300'),
            spentOn: '2026-02-12',
            description: 'Diesel',
            departmentCode: 'OPS',
            businessLineCode: 'PRODUCT_SALES',
          },
        ],
      }),
    );

    await expect(
      ownerPool.query(
        `update cash_advance_settlement set amount_iqd = 350 where cash_advance_id = $1`,
        [advance.id],
      ),
    ).rejects.toThrow(/its receipts total/);
  });

  it('records the department and business line on each receipt (§4.2)', async () => {
    await fund('10000');
    const advance = await issuedAdvance('500');
    await withScope(scope(manager), (tx) =>
      advances.settle(tx, manager, advance.id, {
        settlementDate: '2026-02-18',
        lines: [
          {
            accountId: accounts.fuel!,
            amountIqd: price('500'),
            spentOn: '2026-02-12',
            description: 'Diesel',
            receiptReference: 'R-1',
            departmentCode: 'OPS',
            businessLineCode: 'PRODUCT_SALES',
          },
        ],
      }),
    );

    const { rows } = await ownerPool.query(
      `select department_code, business_line_code, receipt_reference
         from cash_advance_settlement where cash_advance_id = $1`,
      [advance.id],
    );
    expect(rows[0]).toMatchObject({
      department_code: 'OPS',
      business_line_code: 'PRODUCT_SALES',
      receipt_reference: 'R-1',
    });
  });
});

describe('07.5 gate · advances age and are reported (Appendix D)', () => {
  it('lists what is still out, aged from the date it was due', async () => {
    await fund('10000');
    await issuedAdvance('500', { dueDate: '2026-02-10' });
    await issuedAdvance('300', { dueDate: '2026-03-31' });

    const aged = await withScope(scope(manager), (tx) =>
      advances.ageing(tx, '2026-02-25', { branchCode: BAGHDAD }),
    );

    expect(aged).toHaveLength(2);
    expect(aged[0]).toMatchObject({ outstandingIqd: '500.0000', bucket: '1-30' });
    expect(aged[1]).toMatchObject({ outstandingIqd: '300.0000', bucket: 'current' });
  });

  it('drops out of the ageing once it is fully accounted for', async () => {
    await fund('10000');
    const advance = await issuedAdvance('500', { dueDate: '2026-02-10' });

    await withScope(scope(manager), (tx) =>
      advances.settle(tx, manager, advance.id, {
        settlementDate: '2026-02-18',
        lines: [
          {
            accountId: accounts.fuel!,
            amountIqd: price('500'),
            spentOn: '2026-02-12',
            description: 'Diesel',
            departmentCode: 'OPS',
            businessLineCode: 'PRODUCT_SALES',
          },
        ],
      }),
    );

    const aged = await withScope(scope(manager), (tx) =>
      advances.ageing(tx, '2026-02-25', { branchCode: BAGHDAD }),
    );
    expect(aged).toHaveLength(0);
  });

  it('shows only what is still out on a partly settled advance', async () => {
    await fund('10000');
    const advance = await issuedAdvance('500', { dueDate: '2026-02-10' });

    await withScope(scope(manager), (tx) =>
      advances.settle(tx, manager, advance.id, {
        settlementDate: '2026-02-18',
        lines: [
          {
            accountId: accounts.fuel!,
            amountIqd: price('200'),
            spentOn: '2026-02-12',
            description: 'Diesel',
            departmentCode: 'OPS',
            businessLineCode: 'PRODUCT_SALES',
          },
        ],
      }),
    );

    const aged = await withScope(scope(manager), (tx) =>
      advances.ageing(tx, '2026-02-25', { branchCode: BAGHDAD }),
    );
    expect(aged[0]!.outstandingIqd).toBe('300.0000');
  });

  it('can be asked for one holder', async () => {
    await fund('10000');
    await issuedAdvance('500');

    const other = await createUser('accounting_officer');
    const mine = await withScope(scope(manager), (tx) =>
      advances.ageing(tx, '2026-02-25', { holderUserId: holder.principal.userId }),
    );
    const theirs = await withScope(scope(manager), (tx) =>
      advances.ageing(tx, '2026-02-25', { holderUserId: other.principal.userId }),
    );

    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(0);
  });
});

describe('07.5 gate · the balance per custodian reconciles to its G/L account (§17)', () => {
  it('is the G/L balance — there is no second figure to reconcile', async () => {
    await fund('10000');
    await issuedAdvance('500');

    const positions = await withScope(scope(manager), (tx) =>
      advances.custodianPositions(tx, manager, '2026-12-31', BAGHDAD),
    );

    const float = positions.find((row) => row.accountCode === 'PC-BGW');
    expect(float).toBeDefined();

    const { rows } = await ownerPool.query(
      `select coalesce(sum(l.debit_iqd - l.credit_iqd), 0)::text as balance
         from journal_line l
         join journal_entry e on e.id = l.journal_entry_id
         join chart_of_account a on a.id = l.account_id
        where a.code = $1 and e.status in ('posted','reversed')`,
      [floatGlCode],
    );

    expect(float!.balanceIqd).toBe(rows[0].balance);
    expect(Number(float!.balanceIqd)).toBe(9500);
  });

  it('names the custodian from the account master, where §17 puts it', async () => {
    await fund('10000');

    const positions = await withScope(scope(manager), (tx) =>
      advances.custodianPositions(tx, manager, '2026-12-31', BAGHDAD),
    );
    const float = positions.find((row) => row.accountCode === 'PC-BGW');

    const { rows } = await ownerPool.query(`select display_name from app_user where id = $1`, [
      manager.principal.userId,
    ]);
    expect(float!.custodian).toBe(rows[0].display_name);
  });

  it('shows advances outstanding beside the balance, never netted into it', async () => {
    await fund('10000');
    await issuedAdvance('500');

    const positions = await withScope(scope(manager), (tx) =>
      advances.custodianPositions(tx, manager, '2026-12-31', BAGHDAD),
    );
    const float = positions.find((row) => row.accountCode === 'PC-BGW');

    // Cash in the drawer and cash somebody is carrying are different things.
    // Netting them would hide exactly the one that goes missing.
    expect(Number(float!.balanceIqd)).toBe(9500);
    expect(Number(float!.advancesOutIqd)).toBe(500);
  });
});

describe('07.5 gate · a cash count variance is approved and posts an adjustment (§17)', () => {
  it('records, approves and posts the difference', async () => {
    await fund('10000');

    const count = await withScope(scope(manager), (tx) =>
      treasury.countCash(tx, manager, {
        bankCashAccountId: floatAccountId,
        countDate: '2026-02-20',
        countedIqd: price('9900'),
      }),
    );

    expect(count.varianceIqd).toBe(price('-100'));

    await withScope(scope(manager), (tx) =>
      treasury.approveCount(tx, manager, count.id, 'Cash short — receipt mislaid.'),
    );
    const posted = await withScope(scope(manager), (tx) =>
      treasury.postCount(tx, manager, count.id),
    );

    const { rows } = await ownerPool.query(
      `select a.code, l.debit_iqd, l.credit_iqd
         from journal_line l join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = $1 order by l.line_no`,
      [posted.journalEntryId],
    );

    // The float's own G/L account, not whichever account a `cash` mapping
    // names — the drawer that was counted is the drawer that moves (§17).
    expect(rows.map((r) => r.code).sort()).toEqual([floatGlCode, 'X9CASHVA'].sort());
  });

  it('will not approve a variance with no explanation', async () => {
    await fund('10000');
    const count = await withScope(scope(manager), (tx) =>
      treasury.countCash(tx, manager, {
        bankCashAccountId: floatAccountId,
        countDate: '2026-02-20',
        countedIqd: price('9900'),
      }),
    );

    expect(
      await rejection(
        withScope(scope(manager), (tx) => treasury.approveCount(tx, manager, count.id, '  ')),
      ),
    ).toBeTruthy();
  });
});
