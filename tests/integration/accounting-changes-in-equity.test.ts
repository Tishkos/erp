/**
 * The Statement of Changes in Equity — Phase 02, direction of 2026-09-09.
 *
 * Mr Issa set the shape out line by line:
 *
 *   Equity at the beginning of the period
 *   Add:
 *     Total Income
 *     Additional Paid-In Capital
 *   Subtract:
 *     Dividends
 *     Retained Earnings
 *   Equity at the End of the Period
 *
 * One column, read top to bottom. "Add:" and "Subtract:" are headings, not
 * instructions: the sign comes from the ledger, the same way it now does on
 * the Income Statement. Income credits equity and prints plainly; a dividend
 * debits it and prints in brackets.
 *
 * The guarantee worth never breaking — and the one this file exists for — is
 * that the closing figure equals the Equity section of a Balance Sheet drawn
 * on the same day. Both are read from the same posted lines, so they cannot
 * drift apart unless the arithmetic here is wrong.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import * as journal from '@/server/services/journal';
import * as periods from '@/server/services/periods';
import * as rates from '@/server/services/exchange-rates';
import * as statements from '@/server/services/financial-statements';
import * as lines from '@/server/services/statement-lines';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BAGHDAD = 'BGW';
const LAST_YEAR = '2025-06-30';
const ON = '2026-08-16';
const YEAR = { from: '2026-01-01', to: '2026-12-31' } as const;

let manager: ActorContext;
let approver: ActorContext;
let cashId: string;

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
  await ownerPool.query(
    `insert into user_department_scope (user_id, department_code) values ($1,'FIN')`,
    [id],
  );
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  return { principal, branchCode: BAGHDAD };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });

async function approvedAccount(parentCode: string, name: string): Promise<string> {
  const { rows } = await ownerPool.query(`select id from chart_of_account where code = $1`, [
    parentCode,
  ]);
  const account = await withScope(scope(manager), (tx) =>
    coa.createAccount(tx, manager, { name, currencyRestriction: 'IQD', parentId: rows[0].id }),
  );
  await withScope(scope(manager), (tx) => coa.submitForApproval(tx, manager, account.id));
  await withScope(scope(approver), (tx) => coa.approve(tx, approver, account.id));
  return account.id;
}

const report = (accountId: string, code: string) =>
  withScope(scope(manager), (tx) =>
    coa.setStatementLines(tx, manager, accountId, { changes_in_equity: code }),
  );

/** One posted journal: debit one account, credit another. */
async function post(debit: string, credit: string, amount: string, on = ON) {
  const entry = await withScope(scope(manager), (tx) =>
    journal.createDraft(tx, manager, {
      branchCode: BAGHDAD,
      documentDate: on,
      postingDate: on,
      description: 'Movement',
    }),
  );
  const line = (accountId: string, side: 'debit' | 'credit') =>
    withScope(scope(manager), (tx) =>
      journal.addLine(tx, manager, entry.id, {
        accountId,
        [side]: amount,
        dimensions: { department: 'FIN' },
      } as never),
    );
  await line(debit, 'debit');
  await line(credit, 'credit');
  await withScope(scope(manager), (tx) => journal.submit(tx, manager, entry.id));
}

const equity = () =>
  withScope(scope(manager), (tx) =>
    statements.changesInEquity(tx, { ...YEAR, branchCode: BAGHDAD }),
  );

const amountOf = (rows: readonly { code: string; amount: string }[], code: string) =>
  Number(rows.find((row) => row.code === code)?.amount ?? NaN);

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  await ownerPool.query(
    `insert into department (code, name, is_finance) values ('FIN','Finance',true)`,
  );
  manager = await createManager();
  approver = await createManager();
  for (const [code, startsOn, endsOn] of [
    ['FY2025', '2025-01-01', '2025-12-31'],
    ['FY2026', '2026-01-01', '2026-12-31'],
  ] as const) {
    await withScope(scope(manager), (tx) =>
      periods.createFiscalYear(tx, manager, { code, startsOn, endsOn }),
    );
  }
  await withScope(scope(manager), (tx) =>
    rates.publishRate(tx, manager, {
      currency: 'USD',
      iqdPerUnit: '1310.00000000',
      effectiveFrom: '2025-01-01',
    }),
  );
  await ownerPool.query(
    `insert into document_type_dimension (document_type_code, dimension, requirement)
     values ('journal_entry','business_line','optional')
     on conflict (document_type_code, dimension) do update set requirement = 'optional'`,
  );
  cashId = await approvedAccount('A000001', 'Cash on Hand');
});

// ---------------------------------------------------------------------------
describe('02 · the Statement of Changes in Equity rolls forward', () => {
  /**
   *   Equity at the beginning of the period   3,000,000   (capital paid in 2025)
   *   Add:
   *     Total Income                          1,800,000   (5,000,000 − 3,200,000)
   *     Additional Paid-In Capital            1,000,000
   *   Subtract:
   *     Dividends                              (400,000)
   *   Equity at the End of the Period         5,400,000
   */
  async function aYearOfTrading() {
    const capital = await approvedAccount('E000001', 'Share Capital');
    const dividends = await approvedAccount('E000001', 'Dividends Paid');
    const sales = await approvedAccount('R000001', 'Trading Revenue');
    const costs = await approvedAccount('X000001', 'Running Costs');

    await report(capital, 'equity_paid_in');
    await report(dividends, 'equity_dividends');

    // Last year: capital paid in. This is the equity the period begins with.
    await post(cashId, capital, '3000000.0000', LAST_YEAR);

    // This year.
    await post(cashId, capital, '1000000.0000'); // more capital
    await post(cashId, sales, '5000000.0000'); // income
    await post(costs, cashId, '3200000.0000'); // costs
    await post(dividends, cashId, '400000.0000'); // a distribution

    return { capital, dividends, sales, costs };
  }

  it('opens with the equity the period began with, not with nothing', async () => {
    await aYearOfTrading();
    const { rows, opening } = await equity();

    expect(amountOf(rows, 'equity_opening')).toBe(3_000_000);
    expect(Number(opening)).toBe(3_000_000);
    expect(rows[0]?.code).toBe('equity_opening');
  });

  it('signs each figure from the ledger, so a heading never has to', async () => {
    await aYearOfTrading();
    const { rows } = await equity();

    // "Add:" and "Subtract:" are headings. Income credits equity, so it is
    // positive; a dividend debits it, so it is negative — and neither line
    // was told which section it sits in.
    expect(amountOf(rows, 'equity_total_income')).toBe(1_800_000);
    expect(amountOf(rows, 'equity_paid_in')).toBe(1_000_000);
    expect(amountOf(rows, 'equity_dividends')).toBe(-400_000);
  });

  it('closes at the equity a Balance Sheet would show on the same day', async () => {
    await aYearOfTrading();
    const { rows, closing } = await equity();

    expect(amountOf(rows, 'equity_closing')).toBe(5_400_000);
    expect(Number(closing)).toBe(5_400_000);

    // The check any reader of this statement will make.
    const sheet = await withScope(scope(manager), (tx) =>
      statements.financialPosition(tx, YEAR.to, { branchCode: BAGHDAD }),
    );
    const sheetEquity =
      Number(sheet.equity.reduce((total, line) => total + Number(line.amount), 0)) +
      Number(sheet.unmappedResult);
    expect(sheetEquity).toBe(Number(closing));
    expect(sheet.balances).toBe(true);
  });

  it('adds up: beginning plus everything between equals the end', async () => {
    await aYearOfTrading();
    const { rows } = await equity();

    const between = rows
      .filter((row) => row.kind === 'line' || row.kind === 'result')
      .reduce((total, row) => total + Number(row.amount), 0);
    expect(amountOf(rows, 'equity_closing')).toBe(amountOf(rows, 'equity_opening') + between);
  });

  it('gives each line one row and one number, with no accounts beneath it', async () => {
    await aYearOfTrading();
    const { rows } = await equity();

    // "Total Income" is the figure the Income Statement reached — 1,800,000 —
    // not the revenue and cost accounts that made it. Those are read there.
    expect(amountOf(rows, 'equity_total_income')).toBe(1_800_000);
    expect(rows.every((row) => !('accounts' in row))).toBe(true);
    // Eight rows for eight lines: nothing is expanded into anything.
    expect(rows).toHaveLength(8);
  });

  it('prints the sections in the order Mr Issa set out', async () => {
    await aYearOfTrading();
    const { rows } = await equity();

    expect(rows.map((row) => row.name)).toEqual([
      'Equity at the beginning of the period',
      'Add:',
      'Total Income',
      'Additional Paid-In Capital',
      'Subtract:',
      'Dividends',
      'Retained Earnings',
      'Equity at the End of the Period',
    ]);
    expect(rows[rows.length - 1]?.rule).toBe('double');
  });

  it('prints the whole layout on empty books, so no section goes missing', async () => {
    // Nothing posted, nothing mapped. The eight lines are still the statement,
    // and "Subtract:" with nothing under it says nothing was taken out — which
    // is an answer. A reader who cannot find the line concludes the report is
    // broken instead.
    const { rows } = await equity();

    expect(rows.map((row) => row.name)).toEqual([
      'Equity at the beginning of the period',
      'Add:',
      'Total Income',
      'Additional Paid-In Capital',
      'Subtract:',
      'Dividends',
      'Retained Earnings',
      'Equity at the End of the Period',
    ]);
    expect(rows.every((row) => Number(row.amount) === 0)).toBe(true);
  });

  it('shows a header carrying the sum of the lines beneath it, counted once', async () => {
    await aYearOfTrading();
    const { rows } = await equity();

    expect(amountOf(rows, 'equity_add')).toBe(2_800_000); // 1,800,000 + 1,000,000
    expect(amountOf(rows, 'equity_subtract')).toBe(-400_000);
    // Counted once: 3,000,000 + 2,800,000 − 400,000.
    expect(amountOf(rows, 'equity_closing')).toBe(5_400_000);
  });

  it('moves revenue out of Total Income when Finance maps it to a line', async () => {
    const { sales } = await aYearOfTrading();
    await report(sales, 'equity_paid_in');

    const { rows, closing } = await equity();

    // Sales now reports on its own line, so it is no longer inside the result…
    expect(amountOf(rows, 'equity_total_income')).toBe(-3_200_000); // costs alone
    expect(amountOf(rows, 'equity_paid_in')).toBe(6_000_000); // capital + sales
    // …and the money is still counted exactly once.
    expect(Number(closing)).toBe(5_400_000);
  });

  it('reports a loss as a negative figure, without being told it is one', async () => {
    const capital = await approvedAccount('E000001', 'Share Capital');
    const costs = await approvedAccount('X000001', 'Running Costs');
    await report(capital, 'equity_paid_in');
    await post(cashId, capital, '1000000.0000');
    await post(costs, cashId, '250000.0000');

    const { rows, closing } = await equity();
    expect(amountOf(rows, 'equity_total_income')).toBe(-250_000);
    expect(Number(closing)).toBe(750_000);
  });

  it('refuses to remove a line the statement needs to reach the right equity', async () => {
    const idOf = async (code: string) => {
      const { rows } = await ownerPool.query(
        `select id from financial_statement_line where code = $1`,
        [code],
      );
      return rows[0].id as string;
    };
    const remove = (id: string) =>
      withScope(scope(manager), (tx) => lines.remove(tx, manager, id));

    // Deleting "Total Income" takes the period's profit out of the statement
    // and the closing figure quietly stops agreeing with the Balance Sheet —
    // every line still shows something and the total still adds up, which is
    // what makes it worth refusing rather than warning about. It happened.
    await expect(remove(await idOf('equity_total_income'))).rejects.toThrow(/renamed and moved/);
    await expect(remove(await idOf('equity_opening'))).rejects.toThrow(/renamed and moved/);

    // Renaming and moving them is untouched — it is only removal that takes a
    // figure out of the statement with nothing to put in its place.
    const totalIncome = await idOf('equity_total_income');
    await withScope(scope(manager), (tx) =>
      lines.update(tx, manager, totalIncome, { name: 'Profit for the year', isHeader: false }),
    );
    const { rows: renamed } = await ownerPool.query(
      `select name, computes from financial_statement_line where id = $1`,
      [totalIncome],
    );
    expect(renamed[0].name).toBe('Profit for the year');
    expect(renamed[0].computes).toBe('result');
    // Put it back: resetTestData keeps the seeded lines, so a rename here
    // would follow the suite into every test after this one.
    await ownerPool.query(`update financial_statement_line set name = $2 where id = $1`, [
      totalIncome,
      'Total Income',
    ]);

    // And an ordinary line Finance made is still theirs to remove.
    const mine = await withScope(scope(manager), (tx) =>
      lines.create(tx, manager, {
        statement: 'changes_in_equity',
        name: 'Something of my own',
        isHeader: false,
      }),
    );
    await expect(remove(mine.id)).resolves.toBeUndefined();
  });

  it('does not offer the computed lines in the account picker', async () => {
    const picker = await withScope(scope(manager), (tx) => lines.pickerLines(tx));
    const here = picker.filter((entry) => entry.statement === 'changes_in_equity');
    const takes = (code: string) => here.find((entry) => entry.code === code)?.takesAccounts;

    expect(takes('equity_opening')).toBe(false);
    expect(takes('equity_total_income')).toBe(false);
    expect(takes('equity_closing')).toBe(false);
    expect(takes('equity_add')).toBe(false);
    expect(takes('equity_paid_in')).toBe(true);
    expect(takes('equity_dividends')).toBe(true);
    expect(takes('equity_retained')).toBe(true);
  });

  it('refuses to let an account report on a figure the ledger works out', async () => {
    const account = await approvedAccount('E000001', 'Share Capital');

    await expect(report(account, 'equity_opening')).rejects.toThrow();
    await expect(report(account, 'equity_total_income')).rejects.toThrow();
    await expect(report(account, 'equity_closing')).rejects.toThrow();
    await expect(report(account, 'equity_add')).rejects.toThrow();
  });
});
