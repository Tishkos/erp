/**
 * Payments & Receipts, Cash Forecast and Account Reconciliation — the three
 * read screens of REQ-ACC-001 Part D-4.
 *
 *   - Payments & Receipts lists every posted line on a bank or cash account,
 *     with the document that moved it (found by its journal, a reversal by
 *     the journal it mirrors), and its totals equal Bank and Cash Reporting's.
 *   - Cash Forecast opens at the real position and its printed copy is the
 *     screen's figures.
 *   - Account Reconciliation reads the same rows and inventory figure as the
 *     close checklist (check 7), so the two cannot disagree.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as treasury from '@/server/services/treasury';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseDecimal } from '@domain/money';
import * as reports from '@/server/services/treasury-reports';
import * as forecasts from '@/server/services/cash-forecast';
import * as subledger from '@/server/services/account-reconciliation';
import * as periods from '@/server/services/periods';
import { runExport } from '@/server/print/export';

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


describe('Payments & Receipts · the money that moved, with what moved it', () => {
  it('lists each movement with its document, tells transfers apart, and agrees with Bank and Cash Reporting', async () => {
    await fund('A9BNKIQD', '10000');
    const transfer = await postedTransfer({
      fromAccountId: bankIqd,
      toAccountId: cashFloat,
      transferDate: '2026-02-10',
      amountIqd: price('1500'),
    });
    const window = { from: '2026-01-01', to: '2026-12-31' };
    const all = await withScope(scope(manager), (tx) => reports.moneyRegister(tx, manager, window));
    // The funding journal (a receipt with no document) and the transfer's two legs.
    expect(all.total).toBe(3);
    const legs = all.rows.filter((row) => row.documentType === 'bank_transfer');
    expect(legs.map((row) => [row.accountCode, row.kind, row.amountIqd, row.documentNo]).sort()).toEqual(
      [
        ['BANK-IQD', 'transfer_out', '1500.0000', transfer.transferNo],
        ['CASH-FLOAT', 'transfer_in', '1500.0000', transfer.transferNo],
      ].sort(),
    );
    expect(all.totalInIqd).toBe('11500.0000');
    expect(all.totalOutIqd).toBe('1500.0000');

    const receipts = await withScope(scope(manager), (tx) => reports.moneyRegister(tx, manager, { ...window, view: 'receipts' }));
    expect(receipts.rows.map((row) => row.entryNo)).toEqual(['FUND-A9BNKIQD-2026-02-01']);
    const transfers = await withScope(scope(manager), (tx) => reports.moneyRegister(tx, manager, { ...window, view: 'transfers' }));
    expect(transfers.total).toBe(2);
    const oneAccount = await withScope(scope(manager), (tx) => reports.moneyRegister(tx, manager, { ...window, accountCode: 'CASH-FLOAT' }));
    expect(oneAccount.total).toBe(1);
    const searched = await withScope(scope(manager), (tx) => reports.moneyRegister(tx, manager, { ...window, search: transfer.transferNo }));
    expect(searched.total).toBe(2);

    // Bank and Cash Reporting's columns, from the same lines.
    const positions = await withScope(scope(manager), (tx) => reports.positions(tx, manager, window));
    const sum = (pick: (row: reports.AccountPosition) => string) => positions.reduce((total, row) => total + parseDecimal(pick(row), 4n), 0n);
    expect(sum((row) => row.moneyInIqd) + sum((row) => row.transfersInIqd)).toBe(parseDecimal(all.totalInIqd, 4n));
    expect(sum((row) => row.moneyOutIqd) + sum((row) => row.transfersOutIqd)).toBe(parseDecimal(all.totalOutIqd, 4n));

    // The reversal's mirror lines name the same transfer.
    await withScope(scope(manager), (tx) => treasury.reverseTransfer(tx, manager, transfer.id, { reason: 'Wrong till' }));
    const after = await withScope(scope(manager), (tx) => reports.moneyRegister(tx, manager, { ...window, view: 'transfers' }));
    expect(after.total).toBe(4);
    expect(after.rows.filter((row) => row.isReversal).every((row) => row.documentNo === transfer.transferNo)).toBe(true);

    const copy = await withScope(scope(manager), (tx) =>
      runExport(tx, manager, {
        key: 'payments_receipts',
        format: 'xlsx',
        locale: 'en',
        at: '2026-03-01T09:00:00.000Z',
        input: { id: null, query: new URLSearchParams({ from: window.from, to: window.to }) },
      }),
    );
    expect(copy.status).toBe(200);
    if (copy.status === 200) expect(copy.model.tables[0]!.rows).toHaveLength(5);
  });
});

describe('Cash Forecast · the screen and its copy', () => {
  it('opens at the real position and prints the same periods', async () => {
    await fund('A9BNKIQD', '10000');
    const input = { from: '2026-03-01', to: '2026-03-31', bucket: 'week' as const };
    const forecast = await withScope(scope(manager), (tx) => forecasts.forecast(tx, manager, input));
    expect(forecast.openingIqd).toBe('10000.0000');
    const copy = await withScope(scope(manager), (tx) =>
      runExport(tx, manager, {
        key: 'cash_forecast',
        format: 'pdf',
        locale: 'ar',
        at: '2026-03-01T09:00:00.000Z',
        input: { id: null, query: new URLSearchParams({ from: input.from, to: input.to, bucket: 'week' }) },
      }),
    );
    expect(copy.status).toBe(200);
    if (copy.status === 200) expect(copy.model.tables[0]!.rows).toHaveLength(forecast.periods.length);
  });
});

describe('Account Reconciliation · the close checklist’s own figures', () => {
  it('reads the same control-account rows and inventory figure as the close checklist', async () => {
    const asOf = '2026-02-28';
    const screen = await withScope(scope(manager), (tx) => subledger.accountReconciliation(tx, manager, asOf));
    const { rows: feb } = await ownerPool.query(`select id from fiscal_period where name = 'February 2026'`);
    const checklist = await withScope(scope(manager), (tx) => periods.closeReport(tx, feb[0].id));
    const check7 = checklist.checks.find((check) => check.code === 'inventory_value_equals_gl')!;
    expect(check7.figure).toBe(screen.inventory.differenceIqd);
    expect(check7.detail[0]).toContain(`layers ${screen.inventory.layersIqd} · accounts ${screen.inventory.accountsIqd}`);
    const differing = screen.rows.filter((row) => !/^-?0(\.0+)?$/.test(row.difference)).length;
    expect(checklist.checks.find((check) => check.code === 'subledger_equals_gl')!.figure).toBe(String(differing));

    // Read under the Trial Balance's grant, which an officer holds.
    await expect(withScope(scope(officer), (tx) => subledger.accountReconciliation(tx, officer, asOf))).resolves.toBeTruthy();
    const copy = await withScope(scope(manager), (tx) =>
      runExport(tx, manager, {
        key: 'account_reconciliation',
        format: 'docx',
        locale: 'en',
        at: '2026-03-01T09:00:00.000Z',
        input: { id: null, query: new URLSearchParams({ to: asOf }) },
      }),
    );
    expect(copy.status).toBe(200);
  });
});
