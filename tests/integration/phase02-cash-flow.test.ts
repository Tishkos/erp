/**
 * The Statement of Cash Flows — Phase 02, direction of 2026-09-10.
 *
 * Profit is not cash. The sponsor's example: a company earns a million and
 * collects none of it. So the statement starts at the result and adjusts it by
 * what happened to every other account.
 *
 * The sponsor set the adjustments out a case at a time — receivables up means
 * deduct, payables up means add, a loan drawn is positive, equipment bought is
 * negative — and every one of them is the same arithmetic: **credits less
 * debits over the period**. This file proves that against posted journals,
 * case by case, in the sponsor's own words.
 *
 * And it proves the thing those cases add up to: because every journal
 * balances, credits less debits across all accounts is zero, so Net Income
 * plus every adjustment *is* the movement in cash. The statement cannot drift
 * from the ledger. Most of what follows is that claim, attacked from a
 * different direction each time.
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
let bank: string;

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

async function account(parentCode: string, name: string, cashFlowLine?: string): Promise<string> {
  const { rows } = await ownerPool.query(`select id from chart_of_account where code = $1`, [
    parentCode,
  ]);
  const made = await withScope(scope(manager), (tx) =>
    coa.createAccount(tx, manager, { name, currencyRestriction: 'IQD', parentId: rows[0].id }),
  );
  await withScope(scope(manager), (tx) => coa.submitForApproval(tx, manager, made.id));
  await withScope(scope(approver), (tx) => coa.approve(tx, approver, made.id));
  if (cashFlowLine) {
    await withScope(scope(manager), (tx) =>
      coa.setStatementLines(tx, manager, made.id, { cash_flow: cashFlowLine }),
    );
  }
  return made.id;
}

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
  for (const [accountId, side] of [[debit, 'debit'], [credit, 'credit']] as const) {
    await withScope(scope(manager), (tx) =>
      journal.addLine(tx, manager, entry.id, {
        accountId,
        [side]: amount,
        dimensions: { department: 'FIN' },
      } as never),
    );
  }
  await withScope(scope(manager), (tx) => journal.submit(tx, manager, entry.id));
}

const flow = (window: { from: string; to: string } = YEAR) =>
  withScope(scope(manager), (tx) =>
    statements.cashFlow(tx, { ...window, branchCode: BAGHDAD }),
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

  // The cash this statement explains. Nothing is guessed: an account is on a
  // line marked as cash, or it is not cash.
  const { rows: cashLine } = await ownerPool.query(
    `select code from financial_statement_line where statement='cash_flow' and is_cash limit 1`,
  );
  bank = await account('A000001', 'Bank', cashLine[0].code);
});

// ---------------------------------------------------------------------------
describe('02 · every rule the sponsor gave is credits less debits', () => {
  it('deducts when an operating asset rises — sold, not yet paid', async () => {
    const receivables = await account('A000001', 'Accounts Receivable', 'cf_receivables');
    const sales = await account('R000001', 'Sales');

    // Invoiced 900,000; the customer has not paid.
    await post(receivables, sales, '900000.0000');

    const { rows, netMovement } = await flow();
    expect(amountOf(rows, 'cf_net_income')).toBe(900_000);
    expect(amountOf(rows, 'cf_receivables')).toBe(-900_000); // deducted
    // Earned 900,000, collected nothing.
    expect(Number(netMovement)).toBe(0);
  });

  it('adds when an operating asset falls — the customer paid', async () => {
    const receivables = await account('A000001', 'Accounts Receivable', 'cf_receivables');
    const sales = await account('R000001', 'Sales');

    await post(receivables, sales, '900000.0000', '2025-06-30'); // invoiced last year
    await post(bank, receivables, '900000.0000'); // collected this year

    const { rows, netMovement } = await flow();
    expect(amountOf(rows, 'cf_net_income')).toBe(0); // the sale was last year
    expect(amountOf(rows, 'cf_receivables')).toBe(900_000); // added
    expect(Number(netMovement)).toBe(900_000);
  });

  it('deducts when inventory rises — stock was bought', async () => {
    const inventory = await account('A000001', 'Inventory', 'cf_inventory');
    await post(inventory, bank, '250000.0000');

    const { rows, netMovement } = await flow();
    expect(amountOf(rows, 'cf_inventory')).toBe(-250_000);
    expect(Number(netMovement)).toBe(-250_000);
  });

  it('adds when an operating liability rises — bought, not yet paid', async () => {
    const inventory = await account('A000001', 'Inventory', 'cf_inventory');
    const payables = await account('L000001', 'Accounts Payable', 'cf_payables');

    // Stock on credit: no cash moved at all.
    await post(inventory, payables, '250000.0000');

    const { rows, netMovement } = await flow();
    expect(amountOf(rows, 'cf_inventory')).toBe(-250_000);
    expect(amountOf(rows, 'cf_payables')).toBe(250_000);
    expect(Number(netMovement)).toBe(0);
  });

  it('deducts when an operating liability falls — the supplier was paid', async () => {
    const inventory = await account('A000001', 'Inventory', 'cf_inventory');
    const payables = await account('L000001', 'Accounts Payable', 'cf_payables');

    await post(inventory, payables, '250000.0000', '2025-06-30');
    await post(payables, bank, '250000.0000'); // paid this year

    const { rows, netMovement } = await flow();
    expect(amountOf(rows, 'cf_payables')).toBe(-250_000);
    expect(Number(netMovement)).toBe(-250_000);
  });

  it('is positive when a loan is drawn and negative when it is repaid', async () => {
    const loan = await account('L000001', 'Bank Loan', 'cf_loan');

    await post(bank, loan, '5000000.0000', '2026-03-01'); // the bank lent
    await post(loan, bank, '1200000.0000', '2026-09-01'); // repaid part

    const { rows } = await flow();
    expect(amountOf(rows, 'cf_loan')).toBe(3_800_000); // 5,000,000 drawn less 1,200,000 repaid
    expect(amountOf(rows, 'cf_financing_net')).toBe(3_800_000);
  });

  it('is negative when equipment is bought and positive when it is sold', async () => {
    const equipment = await account('A000001', 'Equipment', 'cf_equipment');

    await post(equipment, bank, '1100000.0000', '2026-03-01'); // bought
    await post(bank, equipment, '900000.0000', '2026-09-01'); // sold

    const { rows } = await flow();
    expect(amountOf(rows, 'cf_equipment')).toBe(-200_000); // 900,000 in less 1,100,000 out
    expect(amountOf(rows, 'cf_investing_net')).toBe(-200_000);
  });

  it('adds back depreciation, which never was cash', async () => {
    const equipment = await account('A000001', 'Equipment', 'cf_equipment');
    const accumulated = await account('A000001', 'Accumulated Depreciation', 'cf_depreciation');
    const expense = await account('X000001', 'Depreciation Expense');

    await post(equipment, bank, '1200000.0000', '2026-01-15');
    await post(expense, accumulated, '200000.0000', '2026-12-01');

    const { rows, netMovement } = await flow();
    // The expense reduced the result...
    expect(amountOf(rows, 'cf_net_income')).toBe(-200_000);
    // ...and the add-back cancels it, because no cash left for it.
    expect(amountOf(rows, 'cf_depreciation')).toBe(200_000);
    expect(amountOf(rows, 'cf_operating_net')).toBe(0);
    // Only the equipment cost cash.
    expect(Number(netMovement)).toBe(-1_200_000);
  });
});

// ---------------------------------------------------------------------------
describe('02 · the statement cannot drift from the ledger', () => {
  /** The sponsor's example, end to end. */
  async function aYear() {
    const receivables = await account('A000001', 'Accounts Receivable', 'cf_receivables');
    const inventory = await account('A000001', 'Inventory', 'cf_inventory');
    const equipment = await account('A000001', 'Equipment', 'cf_equipment');
    const payables = await account('L000001', 'Accounts Payable', 'cf_payables');
    const loan = await account('L000001', 'Bank Loan', 'cf_loan');
    const capital = await account('E000001', 'Paid-In Capital', 'cf_capital');
    const sales = await account('R000001', 'Sales');
    const costs = await account('X000001', 'Running Costs');

    await post(bank, capital, '10000000.0000', '2025-12-31'); // opening cash

    await post(receivables, sales, '4000000.0000', '2026-02-01'); // invoiced
    await post(bank, receivables, '2500000.0000', '2026-03-01'); // part collected
    await post(inventory, payables, '1800000.0000', '2026-04-01'); // stock on credit
    await post(payables, bank, '1000000.0000', '2026-05-01'); // part paid
    await post(costs, bank, '600000.0000', '2026-06-01'); // costs in cash
    await post(equipment, bank, '3000000.0000', '2026-07-01'); // equipment bought
    await post(bank, loan, '5000000.0000', '2026-08-01'); // loan drawn
    await post(bank, capital, '2000000.0000', '2026-09-01'); // more capital

    return { receivables, inventory, equipment, payables, loan, capital, sales, costs };
  }

  it('closes at the cash the accounts actually hold', async () => {
    await aYear();
    const statement = await flow();

    // 10,000,000 + 2,500,000 − 1,000,000 − 600,000 − 3,000,000 + 5,000,000 + 2,000,000
    expect(Number(statement.closingCash)).toBe(14_900_000);
    expect(statement.reconciles).toBe(true);

    // Which is the balance on the bank account itself, read independently.
    const { rows } = await ownerPool.query(
      `select coalesce(sum(l.debit_iqd - l.credit_iqd), 0) as held
         from journal_line l
         join journal_entry e on e.id = l.journal_entry_id and e.status in ('posted','reversed')
        where l.account_id = $1`,
      [bank],
    );
    expect(Number(rows[0].held)).toBe(14_900_000);
  });

  it('opens where the period before it closed', async () => {
    await aYear();
    const statement = await flow();
    expect(Number(statement.openingCash)).toBe(10_000_000);
    expect(amountOf(statement.rows, 'cf_opening')).toBe(10_000_000);

    // And the next period opens where this one closed.
    const next = await flow({ from: '2027-01-01', to: '2027-12-31' });
    expect(Number(next.openingCash)).toBe(14_900_000);
  });

  it('adds up: beginning plus the change is the end', async () => {
    await aYear();
    const { rows, openingCash, netMovement, closingCash } = await flow();

    expect(Number(closingCash)).toBe(Number(openingCash) + Number(netMovement));
    expect(amountOf(rows, 'cf_closing')).toBe(Number(closingCash));
    expect(amountOf(rows, 'cf_net_change')).toBe(Number(netMovement));
  });

  it('makes the three sections add to the change in cash', async () => {
    await aYear();
    const { rows, netMovement } = await flow();

    const operating = amountOf(rows, 'cf_operating_net');
    const investing = amountOf(rows, 'cf_investing_net');
    const financing = amountOf(rows, 'cf_financing_net');
    // Plus whatever nobody has filed yet — nothing, here, but the money has to
    // be counted wherever it sits or the statement stops tying.
    const unfiled = amountOf(rows, 'cf_unclassified');
    expect(unfiled).toBe(0);
    expect(operating + investing + financing + unfiled).toBe(Number(netMovement));

    // Read one out in full, so a change of shape has to be deliberate.
    // 3,400,000 earned − 1,500,000 still owed − 1,800,000 into stock + 800,000 still owed
    expect(operating).toBe(900_000);
    expect(investing).toBe(-3_000_000);
    expect(financing).toBe(7_000_000);
  });

  it('ties even when nobody has classified anything', async () => {
    // Every account on its own with no cash-flow line at all.
    const receivables = await account('A000001', 'Accounts Receivable');
    const loan = await account('L000001', 'Bank Loan');
    const sales = await account('R000001', 'Sales');

    await post(receivables, sales, '900000.0000');
    await post(bank, loan, '5000000.0000');

    const statement = await flow();
    expect(statement.reconciles).toBe(true);
    expect(Number(statement.closingCash)).toBe(5_000_000);

    // The unclassified money is shown and named, not dropped.
    const unclassified = statement.rows.find((row) => row.code === 'cf_unclassified')!;
    expect(Number(unclassified.amount)).toBe(4_100_000); // −900,000 + 5,000,000

    // The sections hold nothing, so the unclassified line carries the whole
    // change on its own — which is the point of it.
    expect(amountOf(statement.rows, 'cf_operating_net')).toBe(900_000); // net income alone
    expect(Number(unclassified.amount) + 900_000).toBe(Number(statement.netMovement));
    expect(unclassified.accounts.map((a) => a.accountName).sort()).toEqual([
      'Accounts Receivable',
      'Bank Loan',
    ]);
  });

  it('ties when a journal touches no cash at all', async () => {
    const receivables = await account('A000001', 'Accounts Receivable', 'cf_receivables');
    const payables = await account('L000001', 'Accounts Payable', 'cf_payables');
    const sales = await account('R000001', 'Sales');
    const costs = await account('X000001', 'Running Costs');

    await post(receivables, sales, '900000.0000');
    await post(costs, payables, '400000.0000');

    const statement = await flow();
    expect(Number(statement.netMovement)).toBe(0);
    expect(Number(statement.closingCash)).toBe(0);
    expect(statement.reconciles).toBe(true);
  });

  it('ties across a journal with more than two lines', async () => {
    const receivables = await account('A000001', 'Accounts Receivable', 'cf_receivables');
    const inventory = await account('A000001', 'Inventory', 'cf_inventory');
    const payables = await account('L000001', 'Accounts Payable', 'cf_payables');

    // Dr Inventory 1,000,000 / Cr Bank 300,000, Cr Payables 700,000 — in two
    // balanced entries, which is what the journal accepts.
    await post(inventory, bank, '300000.0000');
    await post(inventory, payables, '700000.0000');
    await post(bank, receivables, '50000.0000');

    const statement = await flow();
    expect(statement.reconciles).toBe(true);
    expect(Number(statement.closingCash)).toBe(-250_000);
  });

  it('ties after a reversal, and the reversed movement leaves no trace', async () => {
    const equipment = await account('A000001', 'Equipment', 'cf_equipment');
    await post(equipment, bank, '1100000.0000', '2026-03-01');

    const { rows: entries } = await ownerPool.query(
      `select id from journal_entry where status = 'posted' order by entry_no desc limit 1`,
    );
    const reversal = await import('@/server/services/reversal');
    await withScope(scope(manager), (tx) =>
      reversal.reverse(tx, manager, entries[0].id, {
        reversalDate: '2026-04-01',
        reason: 'Bought in error',
      }),
    );

    const statement = await flow();
    expect(amountOf(statement.rows, 'cf_equipment')).toBe(0);
    expect(Number(statement.closingCash)).toBe(0);
    expect(statement.reconciles).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('02 · the layout is the statement', () => {
  it('prints the sections in the order of the sponsor’s example', async () => {
    const { rows } = await flow();
    expect(rows.map((row) => row.name)).toEqual([
      'Operating Activities',
      'Net Income',
      'Add back: Depreciation',
      'Accounts Receivable',
      'Inventory',
      'Accounts Payable',
      'Net cash provided (used) by operating activities',
      'Investing Activities',
      'Equipment',
      'Net cash used in investing activities',
      'Financing Activities',
      'Loan',
      'Paid-In Capital',
      'Net cash provided by financing activities',
      'Not yet classified',
      'Net increase in cash',
      'Cash at the beginning of the period',
      'Cash at the end of the period',
    ]);
  });

  it('sums a section total within its own section, not everything above it', async () => {
    const receivables = await account('A000001', 'Accounts Receivable', 'cf_receivables');
    const equipment = await account('A000001', 'Equipment', 'cf_equipment');
    const sales = await account('R000001', 'Sales');

    await post(receivables, sales, '900000.0000'); // operating
    await post(equipment, bank, '1100000.0000'); // investing

    const { rows } = await flow();
    // Operating: 900,000 earned less 900,000 still owed.
    expect(amountOf(rows, 'cf_operating_net')).toBe(0);
    // Investing is the equipment alone — not the operating section as well.
    expect(amountOf(rows, 'cf_investing_net')).toBe(-1_100_000);
  });

  it('rules the closing line twice and the section totals once', async () => {
    const { rows } = await flow();
    const ruleOf = (code: string) => rows.find((row) => row.code === code)?.rule;
    expect(ruleOf('cf_closing')).toBe('double');
    expect(ruleOf('cf_net_change')).toBe('single');
    expect(ruleOf('cf_operating_net')).toBe('single');
    expect(ruleOf('cf_investing_net')).toBe('single');
  });

  it('indents a section total inside its section', async () => {
    const { rows } = await flow();
    const depthOf = (code: string) => rows.find((row) => row.code === code)?.depth;
    expect(depthOf('cf_operating')).toBe(0);
    expect(depthOf('cf_operating_net')).toBe(1);
    expect(depthOf('cf_closing')).toBe(0);
  });

  it('never prints the cash line — the cash is the subject, not an explanation', async () => {
    const receivables = await account('A000001', 'Accounts Receivable', 'cf_receivables');
    const sales = await account('R000001', 'Sales');
    await post(receivables, sales, '900000.0000');
    await post(bank, receivables, '900000.0000');

    const { rows, reconciles } = await flow();
    const { rows: cashLine } = await ownerPool.query(
      `select code, name from financial_statement_line where statement='cash_flow' and is_cash`,
    );
    for (const line of cashLine) {
      expect(rows.map((row) => row.code)).not.toContain(line.code);
    }
    expect(reconciles).toBe(true);
  });

  it('counts revenue once, inside Net Income, even if it is mapped to a line', async () => {
    const sales = await account('R000001', 'Sales', 'cf_receivables');
    await post(bank, sales, '900000.0000');

    const { rows, reconciles, closingCash } = await flow();
    expect(amountOf(rows, 'cf_net_income')).toBe(900_000);
    // Obeying the mapping too would count the same 900,000 twice.
    expect(amountOf(rows, 'cf_receivables')).toBe(0);
    expect(Number(closingCash)).toBe(900_000);
    expect(reconciles).toBe(true);
  });

  it('names accounts only where they must be acted on', async () => {
    const receivables = await account('A000001', 'Accounts Receivable', 'cf_receivables');
    const loan = await account('L000001', 'Bank Loan'); // left unclassified
    const sales = await account('R000001', 'Sales');
    await post(receivables, sales, '900000.0000');
    await post(bank, loan, '5000000.0000');

    const { rows } = await flow();
    // One row, one number — except the line that needs a name to be filed.
    for (const row of rows) {
      if (row.code === 'cf_unclassified') expect(row.accounts.length).toBe(1);
      else expect(row.accounts).toEqual([]);
    }
    expect(
      rows.find((row) => row.code === 'cf_unclassified')!.accounts[0]!.accountName,
    ).toBe('Bank Loan');
  });

  it('adds back an expense that has not been paid, through the liability', async () => {
    // The sponsor's case (2026-09-12): "the income statement shows that we
    // have payroll expense, but in reality we did not pay those salaries yet
    // so there is no cash movement ... the cashflow statement must add the
    // amount of the payroll to the income."
    //
    // It does — and the figure comes from the liability the salaries are owed
    // on, not from the expense. The liability is the only thing that knows how
    // much is still unpaid: add the expense back and you would be right only
    // in the month nothing at all was paid.
    const payroll = await account('X000001', 'Payroll Expense');
    const payable = await account('L000001', 'Salaries Payable', 'cf_payables');

    await post(payroll, payable, '1000000.0000'); // earned, not yet paid

    const first = await flow();
    expect(amountOf(first.rows, 'cf_net_income')).toBe(-1_000_000);
    expect(amountOf(first.rows, 'cf_payables')).toBe(1_000_000); // added back
    expect(amountOf(first.rows, 'cf_operating_net')).toBe(0); // no cash moved
    expect(Number(first.netMovement)).toBe(0);

    // And when they are paid, the cash goes out and the add-back reverses.
    await post(payable, bank, '1000000.0000', '2026-12-01');

    const after = await flow();
    expect(amountOf(after.rows, 'cf_net_income')).toBe(-1_000_000); // same expense
    expect(amountOf(after.rows, 'cf_payables')).toBe(0); // owed, then settled
    expect(Number(after.netMovement)).toBe(-1_000_000); // the cash really left
    expect(after.reconciles).toBe(true);
  });

  it('would be wrong to add the expense back itself, so the mapping is ignored', async () => {
    // Half the payroll paid, half owed. Adding the expense back whole would
    // say no cash left at all, when 600,000 did.
    const payroll = await account('X000001', 'Payroll Expense', 'cf_payables');
    const payable = await account('L000001', 'Salaries Payable', 'cf_payables');

    await post(payroll, payable, '1000000.0000');
    await post(payable, bank, '600000.0000', '2026-12-01');

    const { rows, netMovement, reconciles } = await flow();
    expect(amountOf(rows, 'cf_net_income')).toBe(-1_000_000);
    // The payroll's own mapping is ignored; the payable carries the 400,000
    // still owed.
    expect(amountOf(rows, 'cf_payables')).toBe(400_000);
    expect(Number(netMovement)).toBe(-600_000); // what actually left
    expect(reconciles).toBe(true);
  });

  it('does not offer a computed line or a total in the account picker', async () => {
    const picker = await withScope(scope(manager), (tx) => lines.pickerLines(tx));
    const here = picker.filter((entry) => entry.statement === 'cash_flow');
    const takes = (code: string) => here.find((entry) => entry.code === code)?.takesAccounts;

    expect(takes('cf_net_income')).toBe(false);
    expect(takes('cf_opening')).toBe(false);
    expect(takes('cf_unclassified')).toBe(false);
    expect(takes('cf_closing')).toBe(false);
    expect(takes('cf_operating')).toBe(false);
    expect(takes('cf_receivables')).toBe(true);
  });

  it('says so when no account has been marked as cash', async () => {
    const { rows: was } = await ownerPool.query(
      `select code from financial_statement_line where statement='cash_flow' and is_cash`,
    );
    try {
      await ownerPool.query(
        `update chart_of_account set cash_flow_line = null
          where cash_flow_line in (select code from financial_statement_line where is_cash)`,
      );
      await ownerPool.query(`update financial_statement_line set is_cash = false where is_cash`);

      const statement = await flow();
      expect(statement.configured).toBe(false);
    } finally {
      // `resetTestData` keeps the seeded lines as they were left, so without
      // this every later test would run against books with no cash in them.
      await ownerPool.query(
        `update financial_statement_line set is_cash = true where code = any($1)`,
        [was.map((row: { code: string }) => row.code)],
      );
    }
  });
});
