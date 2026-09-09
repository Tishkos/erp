/**
 * The Income Statement is its layout — Phase 02, direction of 2026-09-09.
 *
 * Mr Issa, through the sponsor:
 *
 *   "For the income statement the calculations will determine if its profit or
 *    loss ... So the final line mapping line 'Net Income (Loss)' must calculate
 *    (Gross Profit - Total Expenses)"
 *
 * A statement line used to carry a *role* — revenue, cost of sales, operating
 * expenses — and the report worked its subtotals out from that. The role is
 * gone. What replaced it is the subject of this file:
 *
 *   * which way a figure goes is read from the account's type, so a revenue
 *     account adds and an expense account takes away without anyone saying so;
 *   * a subtotal is a line of the layout, carrying the running total of
 *     everything printed above it — so moving it moves the figure.
 *
 * These are guarantees about posted money, so they are proved against a real
 * ledger rather than a fixture.
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
import * as lines from '@/server/services/statement-lines';
import * as statements from '@/server/services/financial-statements';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BAGHDAD = 'BGW';
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

/** A line of the Income Statement layout. */
async function line(name: string, opts: { header?: boolean; total?: boolean; under?: string } = {}) {
  return withScope(scope(manager), (tx) =>
    lines.create(tx, manager, {
      statement: 'income_statement',
      name,
      isHeader: opts.header ?? false,
      isSubtotal: opts.total ?? false,
      parentId: opts.under ?? null,
    }),
  );
}

const report = (accountId: string, code: string) =>
  withScope(scope(manager), (tx) =>
    coa.setStatementLines(tx, manager, accountId, { income_statement: code }),
  );

/** Dr the named account / Cr cash, posted. */
async function spend(accountId: string, amount: string) {
  const entry = await withScope(scope(manager), (tx) =>
    journal.createDraft(tx, manager, {
      branchCode: BAGHDAD,
      documentDate: ON,
      postingDate: ON,
      description: 'Spending',
    }),
  );
  await withScope(scope(manager), (tx) =>
    journal.addLine(tx, manager, entry.id, {
      accountId,
      debit: amount,
      dimensions: { department: 'FIN' },
    }),
  );
  await withScope(scope(manager), (tx) =>
    journal.addLine(tx, manager, entry.id, { accountId: cashId, credit: amount }),
  );
  await withScope(scope(manager), (tx) => journal.submit(tx, manager, entry.id));
}

/** Dr cash / Cr the named account, posted. */
async function earn(accountId: string, amount: string) {
  const entry = await withScope(scope(manager), (tx) =>
    journal.createDraft(tx, manager, {
      branchCode: BAGHDAD,
      documentDate: ON,
      postingDate: ON,
      description: 'Earning',
    }),
  );
  await withScope(scope(manager), (tx) =>
    journal.addLine(tx, manager, entry.id, { accountId: cashId, debit: amount }),
  );
  await withScope(scope(manager), (tx) =>
    journal.addLine(tx, manager, entry.id, { accountId, credit: amount }),
  );
  await withScope(scope(manager), (tx) => journal.submit(tx, manager, entry.id));
}

const statement = () =>
  withScope(scope(manager), (tx) =>
    statements.incomeStatement(tx, { ...YEAR, branchCode: BAGHDAD }),
  );

const amountOf = (rows: readonly { name: string | null; amount: string }[], name: string) =>
  Number(rows.find((row) => row.name === name)?.amount ?? NaN);

/** Puts a line at a chosen position in the printed order. */
const order = (code: string, ordinal: number) =>
  ownerPool.query(`update financial_statement_line set ordinal = $2 where code = $1`, [
    code,
    ordinal,
  ]);

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  await ownerPool.query(
    `insert into department (code, name, is_finance) values ('FIN','Finance',true)`,
  );
  manager = await createManager();
  approver = await createManager();
  await withScope(scope(manager), (tx) =>
    periods.createFiscalYear(tx, manager, {
      code: 'FY2026',
      startsOn: '2026-01-01',
      endsOn: '2026-12-31',
    }),
  );
  // Every line is valued in both currencies, so even an all-IQD journal needs
  // the dollar rate to exist.
  await withScope(scope(manager), (tx) =>
    rates.publishRate(tx, manager, {
      currency: 'USD',
      iqdPerUnit: '1310.00000000',
      effectiveFrom: '2026-01-01',
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
describe('02 · the Income Statement computes its own result', () => {
  /**
   *   Sales                    5,000,000
   *   Cost of Sales           (2,000,000)
   *   Gross Profit             3,000,000
   *   Salaries                (1,200,000)
   *   Net Income (Loss)        1,800,000
   */
  async function trading() {
    const sales = await line('Sales');
    const cost = await line('Cost of Sales');
    const salaries = await line('Salaries');

    const salesAccount = await approvedAccount('R000001', 'Trading Revenue');
    const costAccount = await approvedAccount('X000001', 'Goods Bought');
    const salariesAccount = await approvedAccount('X000001', 'Staff Salaries');

    await report(salesAccount, sales.code);
    await report(costAccount, cost.code);
    await report(salariesAccount, salaries.code);

    await earn(salesAccount, '5000000.0000');
    await spend(costAccount, '2000000.0000');
    await spend(salariesAccount, '1200000.0000');

    // The seeded totals sit at 25 and 9000. These three were made afterwards,
    // so they are ordered into the places the statement above describes.
    await order(sales.code, 10);
    await order(cost.code, 20);
    await order(salaries.code, 30);
    return { sales, cost, salaries };
  }

  it('signs each figure from its account, with nothing said about the line', async () => {
    await trading();
    const { rows } = await statement();

    // Revenue is credit-normal and adds; an expense is debit-normal and takes
    // away. Neither line was told which it was.
    expect(amountOf(rows, 'Sales')).toBe(5_000_000);
    expect(amountOf(rows, 'Cost of Sales')).toBe(-2_000_000);
    expect(amountOf(rows, 'Salaries')).toBe(-1_200_000);
  });

  it('makes Net Income (Loss) equal Gross Profit less the expenses beneath it', async () => {
    await trading();
    const { rows, result } = await statement();

    const gross = amountOf(rows, 'Gross Profit');
    const net = amountOf(rows, 'Net Income (Loss)');

    expect(gross).toBe(3_000_000); // 5,000,000 − 2,000,000
    expect(net).toBe(gross + amountOf(rows, 'Salaries')); // the sponsor's rule
    expect(net).toBe(1_800_000);
    expect(Number(result)).toBe(net);
  });

  it('prints the result last and rules it twice', async () => {
    await trading();
    const { rows } = await statement();

    const printed = rows.filter((row) => row.kind !== 'account');
    expect(printed[printed.length - 1]?.name).toBe('Net Income (Loss)');
    expect(rows.find((row) => row.name === 'Net Income (Loss)')?.rule).toBe('double');
    expect(rows.find((row) => row.name === 'Gross Profit')?.rule).toBe('single');
  });

  it('changes the figure when the total is moved, because it is a line', async () => {
    const { salaries } = await trading();

    // Salaries above Gross Profit rather than below it.
    await order(salaries.code, 21);

    const { rows } = await statement();
    expect(amountOf(rows, 'Gross Profit')).toBe(1_800_000); // now includes salaries
    expect(amountOf(rows, 'Net Income (Loss)')).toBe(1_800_000); // the same money
  });

  it('reports a loss as a negative result, without being told it is one', async () => {
    const cost = await line('Cost of Sales');
    const costAccount = await approvedAccount('X000001', 'Goods Bought');
    await report(costAccount, cost.code);
    await spend(costAccount, '400000.0000');

    const { rows, result } = await statement();
    expect(Number(result)).toBe(-400_000);
    expect(amountOf(rows, 'Net Income (Loss)')).toBe(-400_000);
  });

  it('counts a header once, not twice with the lines inside it', async () => {
    const header = await line('Operating expenses', { header: true });
    const rent = await line('Rent', { under: header.id });
    const power = await line('Power', { under: header.id });

    const rentAccount = await approvedAccount('X000001', 'Office Rent');
    const powerAccount = await approvedAccount('X000001', 'Electricity');
    await report(rentAccount, rent.code);
    await report(powerAccount, power.code);
    await spend(rentAccount, '300000.0000');
    await spend(powerAccount, '100000.0000');

    const { rows, result } = await statement();

    // The header prints the sum of its lines...
    expect(amountOf(rows, 'Operating expenses')).toBe(-400_000);
    // ...and the result is that 400,000 once, not 800,000.
    expect(Number(result)).toBe(-400_000);
  });

  it('places a new line above the totals, so its money reaches the result', async () => {
    await trading();

    // Nothing said about where it goes — this is what Finance gets by
    // typing a name and pressing save.
    const other = await line('Other Revenue');
    const account = await approvedAccount('R000001', 'Scrap Sales');
    await report(account, other.code);
    await earn(account, '200000.0000');

    const { rows } = await statement();
    const printed = rows.filter((row) => row.kind !== 'account').map((row) => row.name);

    expect(printed[printed.length - 1]).toBe('Net Income (Loss)');
    expect(printed.indexOf('Other Revenue')).toBeLessThan(printed.indexOf('Net Income (Loss)'));
    // 1,800,000 + 200,000 — not 1,800,000 with the money stranded below.
    expect(amountOf(rows, 'Net Income (Loss)')).toBe(2_000_000);
  });

  it('still puts a new total last, which is where a total belongs', async () => {
    await trading();
    await line('Result after everything', { total: true });

    const { rows } = await statement();
    const printed = rows.filter((row) => row.kind !== 'account').map((row) => row.name);
    expect(printed[printed.length - 1]).toBe('Result after everything');
    expect(amountOf(rows, 'Result after everything')).toBe(1_800_000);
  });

  it('does not offer a line nothing can report on', async () => {
    const header = await line('Running the office', { header: true });
    await line('Rent', { under: header.id });

    const picker = await withScope(scope(manager), (tx) => lines.pickerLines(tx));
    const income = picker.filter((entry) => entry.statement === 'income_statement');
    const takes = (name: string) => income.find((entry) => entry.name === name)?.takesAccounts;

    // Offering a total and then refusing it on save is the same mistake
    // twice; the picker greys it out instead.
    expect(takes('Gross Profit')).toBe(false);
    expect(takes('Net Income (Loss)')).toBe(false);
    expect(takes('Running the office')).toBe(false);
    expect(takes('Rent')).toBe(true);
  });

  it('refuses to let an account report on a computed total', async () => {
    const total = await line('Subtotal', { total: true });
    const account = await approvedAccount('X000001', 'Office Rent');

    await expect(report(account, total.code)).rejects.toThrow();
  });
});
