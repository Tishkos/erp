/**
 * Phase 07.1 and 07.4 test gates — bank and cash operations, and inter-account
 * transfers. §17.
 *
 * 07.1
 *   - A payment in a currency other than the account currency is rejected unless
 *     routed through an approved FX conversion
 *   - A payment exceeding the account's approval limit routes to the higher approver
 *   - Cash count variances are recorded, approved and posted
 *   - Each bank/cash account's ledger balance equals its mapped G/L account balance
 *
 * 07.4
 *   - An inter-account transfer debits one account and credits the other in a
 *     single balanced journal
 *   - A transfer between accounts of different currencies uses an approved FX
 *     conversion and records both legs
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as treasury from '@/server/services/treasury';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseDecimal } from '@domain/money';

const BAGHDAD = 'BGW';

const price = (iqd: string) => parseDecimal(iqd, 4n);

let manager: ActorContext;
let officer: ActorContext;
/** The seeded IQD bank account, plus the three this file adds. */
let bankIqd: string;
let bankUsd: string;
let cashFloat: string;
let secondBank: string;

async function createUser(role: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    role,
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

/** A bank or cash account with its own G/L account, as §17 requires. */
async function makeAccount(input: {
  code: string;
  name: string;
  type: 'bank' | 'cash';
  currency: string;
  glCode: string;
  approvalLimit?: string | null;
  cashLimit?: string | null;
  custodian?: string | null;
}): Promise<string> {
  const { rows: parents } = await ownerPool.query(
    `select id from chart_of_account where code = 'A000001'`,
  );
  const { rows: gl } = await ownerPool.query(
    `insert into chart_of_account
       (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
        currency_restriction)
     values ($1, $2, 'asset', $3, false, true, 'approved', 1, 'IQD') returning id`,
    [input.glCode, `${input.name} G/L`, parents[0].id],
  );

  const { rows } = await ownerPool.query(
    `insert into bank_cash_account
       (code, name, account_type, bank_name, account_number, currency, gl_account_id,
        custodian_user_id, cash_limit_iqd, approval_limit_iqd)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [
      input.code,
      input.name,
      input.type,
      input.type === 'bank' ? 'Seed Bank' : null,
      input.type === 'bank' ? `ACC-${input.code}` : null,
      input.currency,
      gl[0].id,
      input.custodian ?? null,
      input.cashLimit ?? null,
      input.approvalLimit ?? null,
    ],
  );
  return rows[0].id;
}

/**
 * Puts money into an account's G/L account, so it has something to move.
 *
 * One transaction, because §02's balance check is a DEFERRED constraint judged
 * at COMMIT: a header committed on its own is a journal with no lines, which is
 * exactly what that constraint exists to refuse.
 */
async function fund(glCode: string, amount: string, on = '2026-02-01') {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');

    const { rows: gl } = await client.query(
      `select id from chart_of_account where code = $1`,
      [glCode],
    );
    const { rows: suspense } = await client.query(
      `select id from chart_of_account where code = 'L9SUSPEN'`,
    );
    const { rows: periods } = await client.query(
      `select id from fiscal_period where starts_on <= $1::date and ends_on >= $1::date limit 1`,
      [on],
    );
    // Draft first, then lines, then posted — the order the application uses,
    // because §14.4's immutability trigger refuses lines added to a posted
    // journal, and it is right to: a fixture that could add them is a fixture
    // that has disabled the control it is testing around.
    const { rows: entry } = await client.query(
      `insert into journal_entry
         (entry_no, document_date, posting_date, fiscal_period_id, branch_code, description,
          status, total_debit_iqd, total_credit_iqd, created_by)
       values ($1, $2, $2, $3, $4, 'Opening funds', 'draft', $5, $5, $6) returning id`,
      [`FUND-${glCode}-${on}`, on, periods[0].id, BAGHDAD, amount, manager.principal.userId],
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
      `update journal_entry
          set status = 'posted', approved_by = $2, posted_at = now()
        where id = $1`,
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

  manager = await createUser('accounting_manager');
  officer = await createUser('accounting_officer');

  const { rows: years } = await ownerPool.query(
    `insert into fiscal_year (code, name, starts_on, ends_on)
     values ('FY2026','Financial Year 2026','2026-01-01','2026-12-31') returning id`,
  );
  for (const [no, name, from, to] of [
    [2, 'February 2026', '2026-02-01', '2026-02-28'],
    [3, 'March 2026', '2026-03-01', '2026-03-31'],
  ] as const) {
    await ownerPool.query(
      `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
       values ($1,$2,$3,$4,$5)`,
      [years[0].id, no, name, from, to],
    );
  }

  await ownerPool.query(
    `insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by)
     values ('USD','accounting',1000.00000000,'2026-01-01',$1) on conflict do nothing`,
    [manager.principal.userId],
  );

  // A suspense account for the funding entries, and the cash-variance account
  // the count posts against.
  const { rows: liabilities } = await ownerPool.query(
    `select id from chart_of_account where code = 'L000001'`,
  );
  for (const [code, name] of [
    ['L9SUSPEN', 'Funding Suspense'],
    ['X9CASHVA', 'Cash Count Variance'],
  ] as const) {
    await ownerPool.query(
      `insert into chart_of_account
         (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
          currency_restriction)
       values ($1, $2,
               (select account_type from chart_of_account where code = 'L000001'),
               $3, false, true, 'approved', 1, 'IQD')`,
      [code, name, liabilities[0].id],
    );
  }
  const { rows: variance } = await ownerPool.query(
    `select id from chart_of_account where code = 'X9CASHVA'`,
  );
  await ownerPool.query(
    `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
     values ('treasury.cash_count', 'cash_variance', $1, true, $2) on conflict do nothing`,
    [variance[0].id, manager.principal.userId],
  );

  bankIqd = await makeAccount({
    code: 'BANK-IQD',
    name: 'Baghdad Operating Account',
    type: 'bank',
    currency: 'IQD',
    glCode: 'A9BNKIQD',
    approvalLimit: '5000.0000',
  });
  bankUsd = await makeAccount({
    code: 'BANK-USD',
    name: 'Baghdad USD Account',
    type: 'bank',
    currency: 'USD',
    glCode: 'A9BNKUSD',
    approvalLimit: '5000.0000',
  });
  secondBank = await makeAccount({
    code: 'BANK-TWO',
    name: 'Baghdad Second Account',
    type: 'bank',
    currency: 'IQD',
    glCode: 'A9BNKTWO',
    approvalLimit: '5000.0000',
  });
  cashFloat = await makeAccount({
    code: 'CASH-FLOAT',
    name: 'Baghdad Petty Cash',
    type: 'cash',
    currency: 'IQD',
    glCode: 'A9CASHFL',
    cashLimit: '2000.0000',
    custodian: manager.principal.userId,
  });
});

// ---------------------------------------------------------------------------

describe('07.1 gate · the account balance is the G/L balance (§17)', () => {
  it('reads the ledger rather than a cached column', async () => {
    await fund('A9BNKIQD', '10000');

    const rows = await withScope(scope(manager), (tx) =>
      treasury.balances(tx, manager, '2026-02-28', { accountCode: 'BANK-IQD' }),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.balanceIqd).toBe('10000.0000');
    expect(rows[0]!.glAccountCode).toBe('A9BNKIQD');

    // The gate is an identity, not a reconciliation: the figure *is* the G/L
    // balance of the mapped account, so there is nothing that could drift.
    const { rows: gl } = await ownerPool.query(
      `select coalesce(sum(l.debit_iqd - l.credit_iqd), 0)::text as balance
         from journal_line l
         join journal_entry e on e.id = l.journal_entry_id
         join chart_of_account a on a.id = l.account_id
        where a.code = 'A9BNKIQD' and e.status = 'posted'`,
    );
    expect(rows[0]!.balanceIqd).toBe(gl[0].balance);
  });

  it('reports each account separately — no shared bucket', async () => {
    await fund('A9BNKIQD', '10000');
    await fund('A9BNKTWO', '2500');

    const rows = await withScope(scope(manager), (tx) =>
      treasury.balances(tx, manager, '2026-02-28'),
    );

    const byCode = new Map(rows.map((r) => [r.accountCode, r.balanceIqd]));
    expect(byCode.get('BANK-IQD')).toBe('10000.0000');
    expect(byCode.get('BANK-TWO')).toBe('2500.0000');
    expect(byCode.get('CASH-FLOAT')).toBe('0.0000');
  });

  it('deducts approved-but-unexecuted transfers from what is available (§17)', async () => {
    await fund('A9BNKIQD', '10000');

    const transfer = await withScope(scope(manager), (tx) =>
      treasury.createTransfer(tx, manager, {
        fromAccountId: bankIqd,
        toAccountId: secondBank,
        transferDate: '2026-02-10',
        amountIqd: price('4000'),
      }),
    );
    await withScope(scope(manager), (tx) => treasury.approveTransfer(tx, manager, transfer.id));

    const [position] = await withScope(scope(manager), (tx) =>
      treasury.balances(tx, manager, '2026-02-28', { accountCode: 'BANK-IQD' }),
    );

    // Cleared 10,000; 4,000 promised and not yet moved; 6,000 free. §17's
    // "cleared and book balances", and the reason paying twice from the same
    // money is not possible.
    expect(position!.balanceIqd).toBe('10000.0000');
    expect(position!.committedIqd).toBe('4000.0000');
    expect(position!.availableIqd).toBe('6000.0000');
  });
});

describe('07.1 gate · currency and approval limits (§17)', () => {
  it('refuses a payment in a currency the account does not hold', async () => {
    await fund('A9BNKIQD', '10000');

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          treasury.checkPayment(tx, manager, {
            bankCashAccountId: bankIqd,
            amountIqd: price('100'),
            currency: 'USD',
          }),
        ),
      ),
    ).toMatch(/held in IQD and this payment is in USD/);
  });

  it('allows it through an approved FX conversion', async () => {
    await fund('A9BNKIQD', '10000');

    const check = await withScope(scope(manager), (tx) =>
      treasury.checkPayment(tx, manager, {
        bankCashAccountId: bankIqd,
        amountIqd: price('100'),
        currency: 'USD',
        approvedFxConversion: true,
      }),
    );
    expect(check.accountCode).toBe('BANK-IQD');
  });

  it('routes a payment above the account limit to the higher approver', async () => {
    await fund('A9BNKIQD', '10000');

    const within = await withScope(scope(manager), (tx) =>
      treasury.checkPayment(tx, manager, {
        bankCashAccountId: bankIqd,
        amountIqd: price('5000'),
        currency: 'IQD',
      }),
    );
    expect(within.requiresHigherApproval).toBe(false);

    const above = await withScope(scope(manager), (tx) =>
      treasury.checkPayment(tx, manager, {
        bankCashAccountId: bankIqd,
        amountIqd: price('5000.0001'),
        currency: 'IQD',
      }),
    );
    expect(above.requiresHigherApproval).toBe(true);
  });

  it('refuses a payment the account cannot fund', async () => {
    await fund('A9BNKIQD', '1000');

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          treasury.checkPayment(tx, manager, {
            bankCashAccountId: bankIqd,
            amountIqd: price('2000'),
            currency: 'IQD',
          }),
        ),
      ),
    ).toMatch(/holds 1000.0000 and this needs 2000.0000/);
  });
});

// ---------------------------------------------------------------------------

describe('07.1 gate · cash counts are recorded, approved and posted (§17)', () => {
  it('records a shortfall against the book figure at that moment', async () => {
    await fund('A9CASHFL', '1000');

    const count = await withScope(scope(manager), (tx) =>
      treasury.countCash(tx, manager, {
        bankCashAccountId: cashFloat,
        countDate: '2026-02-15',
        countedIqd: price('900'),
        varianceReason: 'Unrecorded taxi fare',
      }),
    );

    expect(count.varianceIqd).toBe(price('-100'));
    expect(count.direction).toBe('short');

    const view = await withScope(scope(manager), (tx) => treasury.viewCount(tx, count.id));
    // Both figures are kept: the variance alone would lose the two numbers a
    // later reader wants to compare.
    expect(view.countedIqd).toBe('900.0000');
    expect(view.bookIqd).toBe('1000.0000');
  });

  it('treats a surplus as a variance too', async () => {
    await fund('A9CASHFL', '1000');

    const count = await withScope(scope(manager), (tx) =>
      treasury.countCash(tx, manager, {
        bankCashAccountId: cashFloat,
        countDate: '2026-02-15',
        countedIqd: price('1100'),
      }),
    );

    // Cash found in a drawer is money the books cannot explain.
    expect(count.direction).toBe('over');
  });

  it('refuses to approve a variance nobody has explained (§17)', async () => {
    await fund('A9CASHFL', '1000');

    const count = await withScope(scope(manager), (tx) =>
      treasury.countCash(tx, manager, {
        bankCashAccountId: cashFloat,
        countDate: '2026-02-15',
        countedIqd: price('900'),
      }),
    );

    expect(
      await rejection(
        withScope(scope(manager), (tx) => treasury.approveCount(tx, manager, count.id)),
      ),
    ).toMatch(/no explanation/);
  });

  it('refuses to approve a count that agreed — there is nothing to decide', async () => {
    await fund('A9CASHFL', '1000');

    const count = await withScope(scope(manager), (tx) =>
      treasury.countCash(tx, manager, {
        bankCashAccountId: cashFloat,
        countDate: '2026-02-15',
        countedIqd: price('1000'),
      }),
    );

    expect(count.varianceIqd).toBe(0n);
    expect(
      await rejection(
        withScope(scope(manager), (tx) => treasury.approveCount(tx, manager, count.id)),
      ),
    ).toMatch(/nothing to approve/);
  });

  it('posts the variance and moves the cash account to the counted figure', async () => {
    await fund('A9CASHFL', '1000');

    const count = await withScope(scope(manager), (tx) =>
      treasury.countCash(tx, manager, {
        bankCashAccountId: cashFloat,
        countDate: '2026-02-15',
        countedIqd: price('900'),
        varianceReason: 'Unrecorded taxi fare',
      }),
    );
    await withScope(scope(manager), (tx) => treasury.approveCount(tx, manager, count.id));
    const posted = await withScope(scope(manager), (tx) =>
      treasury.postCount(tx, manager, count.id),
    );

    const { rows } = await ownerPool.query(
      `select a.code, l.debit_iqd, l.credit_iqd
         from journal_line l
         join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = $1
        order by l.line_no`,
      [posted.journalEntryId],
    );

    // A shortfall debits the variance account and credits the cash.
    expect(rows[0].code).toBe('X9CASHVA');
    expect(Number(rows[0].debit_iqd)).toBe(100);
    expect(rows[1].code).toBe('A9CASHFL');
    expect(Number(rows[1].credit_iqd)).toBe(100);

    // …and the account now says what the drawer said.
    const [position] = await withScope(scope(manager), (tx) =>
      treasury.balances(tx, manager, '2026-02-28', { accountCode: 'CASH-FLOAT' }),
    );
    expect(position!.balanceIqd).toBe('900.0000');
  });

  it('refuses a count of a bank account — that is a reconciliation (§17)', async () => {
    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          treasury.countCash(tx, manager, {
            bankCashAccountId: bankIqd,
            countDate: '2026-02-15',
            countedIqd: price('900'),
          }),
        ),
      ),
    ).toMatch(/A physical count is of cash in a drawer/);
  });
});

// ---------------------------------------------------------------------------

describe('07.4 gate · an inter-account transfer is one balanced journal (§17)', () => {
  it('debits one account and credits the other, in one entry', async () => {
    await fund('A9BNKIQD', '10000');

    const transfer = await withScope(scope(manager), (tx) =>
      treasury.createTransfer(tx, manager, {
        fromAccountId: bankIqd,
        toAccountId: secondBank,
        transferDate: '2026-02-10',
        amountIqd: price('4000'),
        bankReference: 'TRF-0001',
      }),
    );
    await withScope(scope(manager), (tx) => treasury.approveTransfer(tx, manager, transfer.id));
    const posted = await withScope(scope(manager), (tx) =>
      treasury.postTransfer(tx, manager, transfer.id),
    );

    const { rows } = await ownerPool.query(
      `select a.code, l.debit_iqd, l.credit_iqd
         from journal_line l
         join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = $1
        order by l.line_no`,
      [posted.journalEntryId],
    );

    // Two lines, one journal — and each leg lands in **its own** account, which
    // a mapped `bank_cash` role could not do with two accounts in play.
    expect(rows).toHaveLength(2);
    expect(rows[0].code).toBe('A9BNKTWO');
    expect(Number(rows[0].debit_iqd)).toBe(4000);
    expect(rows[1].code).toBe('A9BNKIQD');
    expect(Number(rows[1].credit_iqd)).toBe(4000);

    const balances = await withScope(scope(manager), (tx) =>
      treasury.balances(tx, manager, '2026-02-28'),
    );
    const byCode = new Map(balances.map((r) => [r.accountCode, r.balanceIqd]));
    expect(byCode.get('BANK-IQD')).toBe('6000.0000');
    expect(byCode.get('BANK-TWO')).toBe('4000.0000');
  });

  it('refuses a transfer to the same account', async () => {
    await fund('A9BNKIQD', '10000');

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          treasury.createTransfer(tx, manager, {
            fromAccountId: bankIqd,
            toAccountId: bankIqd,
            transferDate: '2026-02-10',
            amountIqd: price('1000'),
          }),
        ),
      ),
    ).toMatch(/accounts_differ/);
  });

  it('refuses a transfer the source cannot fund', async () => {
    await fund('A9BNKIQD', '1000');

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          treasury.createTransfer(tx, manager, {
            fromAccountId: bankIqd,
            toAccountId: secondBank,
            transferDate: '2026-02-10',
            amountIqd: price('4000'),
          }),
        ),
      ),
    ).toMatch(/holds 1000.0000 and this needs 4000.0000/);
  });

  it('refuses to overfill a cash float beyond its limit (§17)', async () => {
    await fund('A9BNKIQD', '10000');

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          treasury.createTransfer(tx, manager, {
            fromAccountId: bankIqd,
            toAccountId: cashFloat,
            transferDate: '2026-02-10',
            amountIqd: price('2500'),
          }),
        ),
      ),
    ).toMatch(/above its cash limit/);
  });
});

describe('07.4 gate · a cross-currency transfer records both legs (§17)', () => {
  it('insists on a rate, and records what left and what arrived', async () => {
    await fund('A9BNKIQD', '10000');

    // Without a rate there is no approved conversion to speak of.
    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          treasury.createTransfer(tx, manager, {
            fromAccountId: bankIqd,
            toAccountId: bankUsd,
            transferDate: '2026-02-10',
            amountIqd: price('1000'),
          }),
        ),
      ),
    ).toMatch(/state it, rather than having the system pick one/);

    const transfer = await withScope(scope(manager), (tx) =>
      treasury.createTransfer(tx, manager, {
        fromAccountId: bankIqd,
        toAccountId: bankUsd,
        transferDate: '2026-02-10',
        amountIqd: price('1000'),
        receivedAmount: price('1'),
        fxRate: '1000.00000000',
      }),
    );

    const view = await withScope(scope(manager), (tx) =>
      treasury.viewTransfer(tx, transfer.id),
    );

    // Both legs, in their own currencies, with the rate that was approved —
    // not one figure and an inference.
    expect(view.amount).toBe('1000.0000');
    expect(view.fromCurrency).toBe('IQD');
    expect(view.receivedAmount).toBe('1.0000');
    expect(view.toCurrency).toBe('USD');
    expect(view.fxRate).toBe('1000.00000000');
  });

  it('refuses a rate where there is no conversion', async () => {
    await fund('A9BNKIQD', '10000');

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          treasury.createTransfer(tx, manager, {
            fromAccountId: bankIqd,
            toAccountId: secondBank,
            transferDate: '2026-02-10',
            amountIqd: price('1000'),
            fxRate: '1.5',
          }),
        ),
      ),
    ).toMatch(/no conversion to rate/);
  });

  it('refuses a currency written straight to the table that the account does not hold', async () => {
    await fund('A9BNKIQD', '10000');

    const transfer = await withScope(scope(manager), (tx) =>
      treasury.createTransfer(tx, manager, {
        fromAccountId: bankIqd,
        toAccountId: secondBank,
        transferDate: '2026-02-10',
        amountIqd: price('1000'),
      }),
    );

    expect(
      await rejection(
        ownerPool.query(`update bank_transfer set from_currency = 'USD' where id = $1`, [
          transfer.id,
        ]),
      ),
    ).toMatch(/that account is held in IQD|rate_matches_currencies/);
  });
});
