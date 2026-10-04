/**
 * Internal Transfers — the Accounting navbar (2026-10-04).
 *
 * The transfer engine is Phase 07.4's (`treasury.createTransfer`,
 * `approveTransfer`, `postTransfer`); this holds what the Internal Transfers
 * screen added to it and the defect it corrected:
 *
 *   - Same currency: the destination goes up by exactly what the source went
 *     down, in one balanced journal, and the company's total does not move.
 *   - Across currencies: each leg in dinars at the ledger rate of the day
 *     (Currencies & Rates), the bank's difference to an exchange gain or loss.
 *     Before, both legs' own-currency figures went into a dinar journal and a
 *     dollar transfer could never balance.
 *   - The funds check values what leaves in dinars, not in its own currency.
 *   - Refused: one account to itself, an inactive account, a closed period,
 *     a rate and an amount that disagree.
 *   - A posted transfer is corrected by reversal through `journal.reverse`,
 *     never edited; a repeated form submit makes one transfer.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as treasury from '@/server/services/treasury';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseDecimal } from '@domain/money';
import { runExport } from '@/server/print/export';
import { mayExport } from '@/server/print/access';
import { registerAttachmentRuntime } from '@/server/attachments-runtime';
import * as attachments from '@/server/services/attachments';

const BAGHDAD = 'BGW';

const price = (iqd: string) => parseDecimal(iqd, 4n);

let manager: ActorContext;
let officer: ActorContext;
/** A second Accounting Manager: the one who approves what the first raised. */
let checker: ActorContext;
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
  checker = await createUser('accounting_manager');

  const { rows: years } = await ownerPool.query(
    `insert into fiscal_year (code, name, starts_on, ends_on)
     values ('FY2026','Financial Year 2026','2026-01-01','2026-12-31') returning id`,
  );
  for (const [no, name, from, to] of [
    [2, 'February 2026', '2026-02-01', '2026-02-28'],
    [3, 'March 2026', '2026-03-01', '2026-03-31'],
    // A reversal is dated today (business date); the year carries every
    // later month so whatever today is has a period.
    [4, 'April 2026', '2026-04-01', '2026-04-30'],
    [5, 'May 2026', '2026-05-01', '2026-05-31'],
    [6, 'June 2026', '2026-06-01', '2026-06-30'],
    [7, 'July 2026', '2026-07-01', '2026-07-31'],
    [8, 'August 2026', '2026-08-01', '2026-08-31'],
    [9, 'September 2026', '2026-09-01', '2026-09-30'],
    [10, 'October 2026', '2026-10-01', '2026-10-31'],
    [11, 'November 2026', '2026-11-01', '2026-11-30'],
    [12, 'December 2026', '2026-12-01', '2026-12-31'],
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

async function journalLines(journalEntryId: string) {
  const { rows } = await ownerPool.query(
    `select a.code, l.debit_iqd::text as debit, l.credit_iqd::text as credit
       from journal_line l join chart_of_account a on a.id = l.account_id
      where l.journal_entry_id = $1 order by l.line_no`,
    [journalEntryId],
  );
  return rows as { code: string; debit: string; credit: string }[];
}

async function companyTotal(asOf = '2026-12-31') {
  const rows = await withScope(scope(manager), (tx) => treasury.balances(tx, manager, asOf));
  return rows.reduce((sum, row) => sum + parseDecimal(row.balanceIqd, 4n), 0n);
}

async function postedTransfer(input: Parameters<typeof treasury.createTransfer>[2]) {
  const made = await withScope(scope(manager), (tx) => treasury.createTransfer(tx, manager, input));
  await withScope(scope(checker), (tx) => treasury.approveTransferAsChecker(tx, checker, made.id));
  const posted = await withScope(scope(manager), (tx) => treasury.postTransfer(tx, manager, made.id));
  return { ...made, ...posted };
}

/** Maps the exchange gain and loss for transfers, as Finance would on Posting Mappings. */
async function mapExchange() {
  const { rows: income } = await ownerPool.query(`select id, account_type from chart_of_account where code = 'L000001'`);
  for (const [code, role] of [
    ['X9FXGAIN', 'exchange_gain'],
    ['X9FXLOSS', 'exchange_loss'],
  ] as const) {
    const { rows } = await ownerPool.query(
      `insert into chart_of_account
         (code, name, account_type, parent_id, is_group, is_active, approval_status, level, currency_restriction)
       values ($1, $1, $2, $3, false, true, 'approved', 1, 'IQD') returning id`,
      [code, income[0].account_type, income[0].id],
    );
    await ownerPool.query(
      `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
       values ('treasury.bank_transfer', $1, $2, true, $3)`,
      [role, rows[0].id, manager.principal.userId],
    );
  }
}

describe('Internal Transfers · one currency', () => {
  it('moves the money from one account to the other and the company total does not move', async () => {
    await fund('A9BNKIQD', '10000');
    const before = await companyTotal();

    const transfer = await postedTransfer({
      fromAccountId: bankIqd,
      toAccountId: cashFloat,
      transferDate: '2026-02-10',
      amountIqd: price('1500'),
      bankReference: 'CHQ-77',
    });

    expect(await journalLines(transfer.journalEntryId)).toEqual([
      { code: 'A9CASHFL', debit: '1500.0000', credit: '0.0000' },
      { code: 'A9BNKIQD', debit: '0.0000', credit: '1500.0000' },
    ]);
    expect(await companyTotal()).toBe(before);

    const row = await withScope(scope(manager), (tx) => treasury.transferByNo(tx, manager, transfer.transferNo));
    expect(row).toMatchObject({ status: 'posted', fromCode: 'BANK-IQD', toCode: 'CASH-FLOAT', fromKind: 'bank', toKind: 'cash' });
    expect(row.journalEntryNo).toBeTruthy();
  });

  it('refuses the same account at both ends, an inactive account and a closed period', async () => {
    await fund('A9BNKIQD', '10000');
    const base = { fromAccountId: bankIqd, toAccountId: secondBank, transferDate: '2026-02-10', amountIqd: price('100') };

    expect(
      await rejection(withScope(scope(manager), (tx) => treasury.createTransfer(tx, manager, { ...base, toAccountId: bankIqd }))),
    ).toMatch(/already in that account/);

    await ownerPool.query(`update bank_cash_account set active = false where id = $1`, [secondBank]);
    expect(await rejection(withScope(scope(manager), (tx) => treasury.createTransfer(tx, manager, base)))).toMatch(/BANK-TWO is inactive/);
    await ownerPool.query(`update bank_cash_account set active = true where id = $1`, [secondBank]);

    expect(
      await rejection(withScope(scope(manager), (tx) => treasury.createTransfer(tx, manager, { ...base, amountIqd: 0n }))),
    ).toMatch(/more than nothing/);

    await ownerPool.query(`update fiscal_period set status = 'closed' where name = 'February 2026'`);
    expect(await rejection(withScope(scope(manager), (tx) => treasury.createTransfer(tx, manager, base)))).toMatch(
      /February 2026 is closed/,
    );
  });

  it('makes one transfer from a form submitted twice', async () => {
    await fund('A9BNKIQD', '10000');
    const documentId = randomUUID();
    const input = { fromAccountId: bankIqd, toAccountId: secondBank, transferDate: '2026-02-10', amountIqd: price('100'), documentId };
    const first = await withScope(scope(manager), (tx) => treasury.createTransfer(tx, manager, input));
    const second = await withScope(scope(manager), (tx) => treasury.createTransfer(tx, manager, input));
    expect(second).toEqual(first);
    const { rows } = await ownerPool.query(`select count(*)::int as n from bank_transfer`);
    expect(rows[0].n).toBe(1);
  });

  it('is approved by somebody other than whoever raised it', async () => {
    await fund('A9BNKIQD', '10000');
    const made = await withScope(scope(manager), (tx) =>
      treasury.createTransfer(tx, manager, { fromAccountId: bankIqd, toAccountId: secondBank, transferDate: '2026-02-10', amountIqd: price('100') }),
    );
    expect(await rejection(withScope(scope(manager), (tx) => treasury.approveTransferAsChecker(tx, manager, made.id)))).toMatch(
      /raised by you; somebody else approves it/,
    );
  });
});

describe('Internal Transfers · across currencies, through Currencies & Rates', () => {
  it('values each leg in dinars and books the bank’s difference as an exchange gain', async () => {
    // 1,000,000 dinars in the dollar account is 1,000 dollars at the ledger's 1,000.
    await fund('A9BNKUSD', '1000000');
    await mapExchange();

    // 100 dollars sold to the bank at 1,310: 131,000 dinars arrive, while the
    // dollars were carried at 1,000 — 31,000 of gain, not revenue.
    const transfer = await postedTransfer({
      fromAccountId: bankUsd,
      toAccountId: bankIqd,
      transferDate: '2026-02-10',
      amountIqd: price('100'),
      receivedAmount: price('131000'),
    });

    expect(await journalLines(transfer.journalEntryId)).toEqual([
      { code: 'A9BNKIQD', debit: '131000.0000', credit: '0.0000' },
      { code: 'A9BNKUSD', debit: '0.0000', credit: '100000.0000' },
      { code: 'X9FXGAIN', debit: '0.0000', credit: '31000.0000' },
    ]);
    // The rate was read off the two amounts, in Currencies & Rates' convention.
    const row = await withScope(scope(manager), (tx) => treasury.transferByNo(tx, manager, transfer.transferNo));
    expect(row.fxRate).toBe('1310.00000000');
  });

  it('books a loss when the bank gave less than the ledger rate', async () => {
    await fund('A9BNKIQD', '1000000');
    await mapExchange();
    // 99,000 dinars buy only 90 dollars (1,100 a dollar) — 9,000 dinars lost on the way.
    const transfer = await postedTransfer({
      fromAccountId: bankIqd,
      toAccountId: bankUsd,
      transferDate: '2026-02-10',
      amountIqd: price('99000'),
      fxRate: '1100',
    });
    expect(await journalLines(transfer.journalEntryId)).toEqual([
      { code: 'A9BNKUSD', debit: '90000.0000', credit: '0.0000' },
      { code: 'A9BNKIQD', debit: '0.0000', credit: '99000.0000' },
      { code: 'X9FXLOSS', debit: '9000.0000', credit: '0.0000' },
    ]);
  });

  it('refuses a rate and an amount received that disagree', async () => {
    await fund('A9BNKUSD', '1000000');
    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          treasury.createTransfer(tx, manager, {
            fromAccountId: bankUsd,
            toAccountId: bankIqd,
            transferDate: '2026-02-10',
            amountIqd: price('100'),
            receivedAmount: price('131000'),
            fxRate: '1200',
          }),
        ),
      ),
    ).toMatch(/Correct the rate or the amount received/);
  });

  it('checks the funds in dinars, not in the account’s own currency', async () => {
    // 1,000 dollars in the account (1,000,000 dinars at 1,000).
    await fund('A9BNKUSD', '1000000');
    const out = (amount: string) =>
      withScope(scope(manager), (tx) =>
        treasury.createTransfer(tx, manager, {
          fromAccountId: bankUsd,
          toAccountId: bankIqd,
          transferDate: '2026-02-10',
          amountIqd: price(amount),
          fxRate: '1000',
        }),
      );
    await expect(out('900')).resolves.toBeTruthy();
    // 2,000 dollars is 2,000,000 dinars — more than is there, which a check in
    // dollars against a dinar balance would have let through.
    expect(await rejection(out('2000'))).toMatch(/BANK-USD/);
  });

  it('holds an approved dollar transfer in dinars at the ledger rate, not as its dollar figure', async () => {
    // 1,000 dollars in the account (1,000,000 dinars at 1,000).
    await fund('A9BNKUSD', '1000000');
    const made = await withScope(scope(manager), (tx) =>
      treasury.createTransfer(tx, manager, {
        fromAccountId: bankUsd,
        toAccountId: bankIqd,
        transferDate: '2026-02-10',
        amountIqd: price('300'),
        fxRate: '1000',
      }),
    );
    await withScope(scope(checker), (tx) => treasury.approveTransferAsChecker(tx, checker, made.id));

    const usd = (await withScope(scope(manager), (tx) => treasury.balances(tx, manager, '2026-12-31'))).find(
      (r) => r.accountCode === 'BANK-USD',
    )!;
    // 300 dollars waiting to leave are 300,000 dinars, not 300.
    expect(usd.committedIqd).toBe('300000.0000');
    expect(usd.availableIqd).toBe('700000.0000');

    // So a second transfer of 800 dollars no longer fits beside it.
    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          treasury.createTransfer(tx, manager, {
            fromAccountId: bankUsd,
            toAccountId: bankIqd,
            transferDate: '2026-02-10',
            amountIqd: price('800'),
            fxRate: '1000',
          }),
        ),
      ),
    ).toMatch(/BANK-USD/);
  });

  it('names the role Finance has still to map, rather than posting a difference somewhere', async () => {
    await fund('A9BNKUSD', '1000000');
    const made = await withScope(scope(manager), (tx) =>
      treasury.createTransfer(tx, manager, {
        fromAccountId: bankUsd,
        toAccountId: bankIqd,
        transferDate: '2026-02-10',
        amountIqd: price('100'),
        receivedAmount: price('131000'),
      }),
    );
    await withScope(scope(checker), (tx) => treasury.approveTransferAsChecker(tx, checker, made.id));
    expect(await rejection(withScope(scope(manager), (tx) => treasury.postTransfer(tx, manager, made.id)))).toMatch(/exchange_gain/);
  });
});

describe('Internal Transfers · correction by reversal', () => {
  // C-20's guard (0290, REQ-ACC-001 E-3) counts the reversed original beside
  // its mirror, as the ledger does; before, it saw the mirror alone and
  // refused a reversal that emptied the account the transfer had filled.
  it('mirrors the journal, keeps the original and refuses a second reversal', async () => {
    await fund('A9BNKIQD', '10000');
    const transfer = await postedTransfer({
      fromAccountId: bankIqd,
      toAccountId: secondBank,
      transferDate: '2026-02-10',
      amountIqd: price('4000'),
    });

    expect(
      await rejection(withScope(scope(manager), (tx) => treasury.reverseTransfer(tx, manager, transfer.id, { reason: ' ' }))),
    ).toMatch(/give a reason/);

    const reversed = await withScope(scope(manager), (tx) =>
      treasury.reverseTransfer(tx, manager, transfer.id, { reason: 'Sent to the wrong account' }),
    );
    expect(reversed.reversalEntryNo).toBeTruthy();

    const row = await withScope(scope(manager), (tx) => treasury.transferByNo(tx, manager, transfer.transferNo));
    expect(row).toMatchObject({ status: 'reversed', reversalReason: 'Sent to the wrong account', reversalEntryNo: reversed.reversalEntryNo });
    // The original figures are untouched; both journals stand.
    expect(row.amount).toBe('4000.0000');
    const byCode = new Map(
      (await withScope(scope(manager), (tx) => treasury.balances(tx, manager, '2026-12-31'))).map((r) => [r.accountCode, r.balanceIqd]),
    );
    expect(byCode.get('BANK-IQD')).toBe('10000.0000');
    expect(byCode.get('BANK-TWO')).toBe('0.0000');

    expect(
      await rejection(withScope(scope(manager), (tx) => treasury.reverseTransfer(tx, manager, transfer.id, { reason: 'again' }))),
    ).toMatch(/reversed/);
  });

  it('lists the register with its filters', async () => {
    await fund('A9BNKIQD', '10000');
    await postedTransfer({ fromAccountId: bankIqd, toAccountId: secondBank, transferDate: '2026-02-10', amountIqd: price('100') });
    await withScope(scope(manager), (tx) =>
      treasury.createTransfer(tx, manager, { fromAccountId: bankIqd, toAccountId: cashFloat, transferDate: '2026-02-11', amountIqd: price('50') }),
    );
    const list = (filter: Parameters<typeof treasury.listTransfers>[2]) =>
      withScope(scope(manager), (tx) => treasury.listTransfers(tx, manager, filter));

    expect((await list({})).total).toBe(2);
    expect((await list({ view: 'open' })).rows.map((r) => r.toCode)).toEqual(['CASH-FLOAT']);
    expect((await list({ view: 'posted' })).rows.map((r) => r.toCode)).toEqual(['BANK-TWO']);
    expect((await list({ accountCode: 'BANK-TWO' })).total).toBe(1);
    expect((await list({ search: 'petty' })).total).toBe(1);
  });
});

describe('Internal Transfers · the record’s doors', () => {
  it('prints the transfer with its journal, for whoever reads transfers', async () => {
    await fund('A9BNKIQD', '10000');
    const transfer = await postedTransfer({
      fromAccountId: bankIqd,
      toAccountId: cashFloat,
      transferDate: '2026-02-10',
      amountIqd: price('1500'),
      bankReference: 'CHQ-77',
    });
    expect(mayExport(officer.principal, 'internal_transfer', 'pdf')).toBe(true);

    const result = await withScope(scope(manager), (tx) =>
      runExport(tx, manager, {
        key: 'internal_transfer',
        format: 'xlsx',
        locale: 'en',
        at: '2026-02-11T09:00:00.000Z',
        input: { id: transfer.transferNo, query: new URLSearchParams() },
      }),
    );
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    expect(result.fileName).toBe(`${transfer.transferNo}.xlsx`);
    const facts = new Map(result.model.fields.map((f) => [f.label, f.value]));
    expect(facts.get('Transfer no.')).toBe(transfer.transferNo);
    expect(facts.get('Bank reference')).toBe('CHQ-77');
    const rows = result.model.tables[0]!.rows.map((r) => [r.cells.gl, r.cells.debit, r.cells.credit]);
    expect(rows).toEqual([
      ['A9CASHFL', '1500.0000', null],
      ['A9BNKIQD', null, '1500.0000'],
    ]);

    // A transfer that is not there is not printed.
    const missing = await withScope(scope(manager), (tx) =>
      runExport(tx, manager, {
        key: 'internal_transfer',
        format: 'pdf',
        locale: 'en',
        at: '2026-02-11T09:00:00.000Z',
        input: { id: 'BTR-NOWHERE', query: new URLSearchParams() },
      }),
    );
    expect(missing.status).toBe(404);
  });

  it('takes paperwork from whoever may read transfers, from the draft on', async () => {
    registerAttachmentRuntime();
    await fund('A9BNKIQD', '10000');
    const made = await withScope(scope(manager), (tx) =>
      treasury.createTransfer(tx, manager, { fromAccountId: bankIqd, toAccountId: secondBank, transferDate: '2026-02-10', amountIqd: price('100') }),
    );
    // The parent check asks for the grant transfers are read under —
    // `bank_cash_account` — which an accounting officer holds.
    const uploaded = await withScope(scope(officer), (tx) =>
      attachments.upload(tx, officer, {
        objectType: treasury.TRANSFER_OBJECT_TYPE,
        objectId: made.id,
        fileName: 'advice.pdf',
        content: Buffer.from('%PDF-1.4\n%%EOF\n'),
      }),
    );
    expect(uploaded.quarantined).toBe(false);
    const files = await withScope(scope(officer), (tx) => attachments.currentFor(tx, treasury.TRANSFER_OBJECT_TYPE, made.id));
    expect(files.map((f) => f.fileName)).toEqual(['advice.pdf']);
  });
});
