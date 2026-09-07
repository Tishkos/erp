/**
 * Phase 1 — the accounting core, against a real PostgreSQL instance.
 *
 * One describe per requirement of the phase definition:
 *
 *   1. Chart of Accounts        — hierarchy, header vs posting, activation
 *   2. Journal Entries          — number, dates, lines, the approval flow
 *   3. Posting and Reversal     — approved becomes posted; corrections mirror
 *   4. General Ledger and Trial Balance — debits equal credits
 *   5. Financial Reports        — Profit or Loss, Financial Position
 *
 * These are the numbers, not the screens. If the arithmetic here is wrong then
 * every report above it is wrong in the same way and no amount of testing the
 * user interface would show it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import * as journal from '@/server/services/journal';
import * as periods from '@/server/services/periods';
import * as rates from '@/server/services/exchange-rates';
import * as statements from '@/server/services/financial-statements';
import * as trialBalance from '@/server/services/trial-balance';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import type { AccountTreeNode } from '@domain/chart-of-accounts';

const BRANCH = 'BGW';
const YEAR = '2026';
const POSTING_DATE = `${YEAR}-08-16`;
const FROM = `${YEAR}-01-01`;
const TO = `${YEAR}-12-31`;

let officer: ActorContext;
let manager: ActorContext;
let cash: string;
let receivables: string;
let capital: string;
let salesRevenue: string;
let salaries: string;

async function createUser(roleCode: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    roleCode === 'accounting_manager' ? 'Finance Manager' : 'Accountant',
  ]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, roleCode]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
    id,
    BRANCH,
  ]);
  await ownerPool.query(
    `insert into user_department_scope (user_id, department_code) values ($1,'FIN')`,
    [id],
  );
  const principal = await withScope({ userId: id, branchCode: BRANCH }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  return { principal, branchCode: BRANCH };
}

const scopeOf = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BRANCH });

/** An account created, submitted and approved — the state a journal can use. */
async function account(
  parentCode: string,
  input: Omit<coa.CreateAccountInput, 'parentId'>,
): Promise<string> {
  const { rows } = await ownerPool.query(`select id from chart_of_account where code = $1`, [
    parentCode,
  ]);
  const created = await withScope(scopeOf(officer), (tx) =>
    coa.createAccount(tx, officer, {
      // A group summarises its children and holds no currency of its own (D7).
      ...(input.isGroup ? {} : { currencyRestriction: 'IQD' }),
      ...input,
      parentId: rows[0].id,
    }),
  );
  await withScope(scopeOf(officer), (tx) => coa.submitForApproval(tx, officer, created.id));
  await withScope(scopeOf(manager), (tx) => coa.approve(tx, manager, created.id));
  return created.id;
}

/** A balanced journal, posted, with the lines given. */
async function postJournal(
  lines: ReadonlyArray<{ accountId: string; debit?: string; credit?: string }>,
  overrides: { description?: string; postingDate?: string } = {},
): Promise<{ id: string; entryNo: string }> {
  const entry = await withScope(scopeOf(manager), (tx) =>
    journal.createDraft(tx, manager, {
      branchCode: BRANCH,
      documentDate: overrides.postingDate ?? POSTING_DATE,
      postingDate: overrides.postingDate ?? POSTING_DATE,
      description: overrides.description ?? 'Test entry',
    }),
  );
  for (const line of lines) {
    await withScope(scopeOf(manager), (tx) =>
      journal.addLine(tx, manager, entry.id, {
        accountId: line.accountId,
        ...(line.debit ? { debit: line.debit } : {}),
        ...(line.credit ? { credit: line.credit } : {}),
        dimensions: { department: 'FIN' },
      }),
    );
  }
  // A Finance Manager "creates and posts directly" — submission and posting
  // are one act for them (§14.4).
  await withScope(scopeOf(manager), (tx) => journal.submit(tx, manager, entry.id));
  return entry;
}

const statusOf = async (id: string): Promise<string> =>
  (await ownerPool.query<{ status: string }>(`select status from journal_entry where id = $1`, [id]))
    .rows[0]!.status;

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BRANCH, 'Head Office');
  await ownerPool.query(
    `insert into department (code, name, is_finance) values ('FIN','Finance',true), ('OPS','Operations',false)`,
  );

  officer = await createUser('accounting_officer');
  manager = await createUser('accounting_manager');

  await withScope(scopeOf(manager), (tx) =>
    periods.createFiscalYear(tx, manager, { code: `FY${YEAR}`, startsOn: FROM, endsOn: TO }),
  );
  await withScope(scopeOf(manager), (tx) =>
    rates.publishRate(tx, manager, {
      currency: 'USD',
      iqdPerUnit: '1310.00000000',
      effectiveFrom: FROM,
      source: 'Central Bank of Iraq',
    }),
  );

  cash = await account('A000001', {
    name: 'Cash on Hand',
    mapping: { balance_sheet: 'cash_and_equivalents', cash_flow: 'cash_flow_cash' },
  });
  receivables = await account('A000001', { name: 'Trade Receivables' });
  capital = await account('E000001', { name: 'Share Capital' });
  salesRevenue = await account('R000001', {
    name: 'Sales',
    mapping: { income_statement: 'revenue' },
  });
  salaries = await account('X000001', {
    name: 'Salaries',
    mapping: { income_statement: 'operating_expenses' },
  });
});

// ---------------------------------------------------------------------------
describe('1 · the Chart of Accounts', () => {
  it('carries the five types, under the roots the code letter names', async () => {
    const { rows } = await ownerPool.query<{ account_type: string; code: string }>(
      `select account_type, code from chart_of_account where is_group order by code`,
    );
    expect(new Set(rows.map((r) => r.account_type))).toEqual(
      new Set(['asset', 'liability', 'equity', 'revenue', 'expense']),
    );
  });

  it('stores an independent mapping per statement when revenue is created', async () => {
    await ownerPool.query(`
      insert into financial_statement_line
        (code, name, statement, ordinal, role, side, cash_flow_category)
      values
        ('product_revenue', 'Product Revenue', 'income_statement', 11, 'revenue', null, 'operating'),
        ('balance_sheet_revenue', 'Revenue', 'balance_sheet', 41, null, 'equity', 'financing')
    `);

    const accountId = await account('R000001', {
      name: 'Product sales',
      mapping: {
        income_statement: 'product_revenue',
        balance_sheet: 'balance_sheet_revenue',
      },
    });
    const created = await withScope(scopeOf(manager), (tx) => coa.loadAccount(tx, accountId));

    // One account, two reports, two answers — neither overwriting the other.
    expect(created.mapping.income_statement).toBe('product_revenue');
    expect(created.mapping.balance_sheet).toBe('balance_sheet_revenue');
  });

  it('distinguishes a header account from one that can be posted to', async () => {
    const header = await account('A000001', { name: 'Receivables', isGroup: true });
    const posting = await account('A000001', { name: 'Petty Cash' });

    const { rows } = await ownerPool.query<{ id: string; is_group: boolean }>(
      `select id, is_group from chart_of_account where id = any($1)`,
      [[header, posting]],
    );
    expect(rows.find((r) => r.id === header)!.is_group).toBe(true);
    expect(rows.find((r) => r.id === posting)!.is_group).toBe(false);

    // And the difference is enforced where it matters: you cannot post to a
    // header account, which is the whole reason for the distinction.
    const message = await rejection(
      postJournal([
        { accountId: header, debit: '100' },
        { accountId: posting, credit: '100' },
      ]),
    );
    expect(message).toBeTruthy();
  });

  it('deactivates an account without deleting it', async () => {
    await withScope(scopeOf(manager), (tx) =>
      coa.deactivate(tx, manager, receivables, 'opened in error'),
    );
    const { rows } = await ownerPool.query<{ is_active: boolean }>(
      `select is_active from chart_of_account where id = $1`,
      [receivables],
    );
    expect(rows[0]!.is_active).toBe(false);
    // Still there — §1.1, and the ledger references it.
    expect(rows).toHaveLength(1);
  });

  it('reports the chart as a hierarchy', async () => {
    const tree = await withScope(scopeOf(officer), (tx) => coa.tree(tx));
    expect(tree.length).toBeGreaterThan(0);

    // Nested, not flat: the roots are the five types and everything else hangs
    // beneath one of them, which is what "hierarchical" means in requirement 1.
    const find = (nodes: readonly AccountTreeNode[], id: string): AccountTreeNode | undefined => {
      for (const node of nodes) {
        if (node.id === id) return node;
        const found = find(node.children, id);
        if (found) return found;
      }
      return undefined;
    };

    const roots = tree.map((n) => n.accountType).sort();
    expect(roots).toEqual(['asset', 'equity', 'expense', 'liability', 'revenue']);

    const cashNode = find(tree, cash);
    expect(cashNode).toBeDefined();
    // Roots are level 0; an account under one is a level below it.
    expect(cashNode!.level).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('2 · Journal Entries', () => {
  it('numbers each entry automatically, and never reuses a number', async () => {
    const first = await postJournal([
      { accountId: cash, debit: '500' },
      { accountId: capital, credit: '500' },
    ]);
    const second = await postJournal([
      { accountId: cash, debit: '250' },
      { accountId: capital, credit: '250' },
    ]);

    expect(first.entryNo).toMatch(/^JE-\d{4}-\d+$/);
    expect(second.entryNo).not.toBe(first.entryNo);
  });

  it('carries a document date, a posting date and a description', async () => {
    const entry = await withScope(scopeOf(manager), (tx) =>
      journal.createDraft(tx, manager, {
        branchCode: BRANCH,
        documentDate: `${YEAR}-08-01`,
        postingDate: `${YEAR}-08-16`,
        description: 'August payroll',
      }),
    );
    const header = await withScope(scopeOf(manager), (tx) => journal.loadHeader(tx, entry.id));
    expect(header.documentDate).toBe(`${YEAR}-08-01`);
    expect(header.postingDate).toBe(`${YEAR}-08-16`);
    expect(header.description).toBe('August payroll');
  });

  it('refuses an entry whose debits and credits disagree', async () => {
    const message = await rejection(
      postJournal([
        { accountId: cash, debit: '500' },
        { accountId: capital, credit: '400' },
      ]),
    );
    expect(message).toBeTruthy();
  });

  it('follows the approval flow: an accountant submits, the manager approves', async () => {
    const entry = await withScope(scopeOf(officer), (tx) =>
      journal.createDraft(tx, officer, {
        branchCode: BRANCH,
        documentDate: POSTING_DATE,
        postingDate: POSTING_DATE,
        description: 'Petty cash',
      }),
    );
    for (const line of [
      { accountId: cash, debit: '100' },
      { accountId: capital, credit: '100' },
    ]) {
      await withScope(scopeOf(officer), (tx) =>
        journal.addLine(tx, officer, entry.id, { ...line, dimensions: { department: 'FIN' } }),
      );
    }

    await withScope(scopeOf(officer), (tx) => journal.submit(tx, officer, entry.id));
    expect(await statusOf(entry.id)).toBe('submitted');

    await withScope(scopeOf(manager), (tx) => journal.approve(tx, manager, entry.id));
    expect(await statusOf(entry.id)).toBe('posted');
  });

  it('refuses an entry from somebody outside Finance', async () => {
    const outsider = await createUser('accounting_officer');
    await ownerPool.query(`delete from user_department_scope where user_id = $1`, [
      outsider.principal.userId,
    ]);
    await ownerPool.query(
      `insert into user_department_scope (user_id, department_code) values ($1,'OPS')`,
      [outsider.principal.userId],
    );

    const message = await rejection(
      withScope(scopeOf(outsider), (tx) =>
        journal.createDraft(tx, outsider, {
          branchCode: BRANCH,
          documentDate: POSTING_DATE,
          postingDate: POSTING_DATE,
        }),
      ),
    );
    expect(message).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe('3 · posting and reversal', () => {
  it('will not let a posted entry be edited or deleted', async () => {
    const entry = await postJournal([
      { accountId: cash, debit: '500' },
      { accountId: capital, credit: '500' },
    ]);
    expect(await statusOf(entry.id)).toBe('posted');

    await expect(
      ownerPool.query(`update journal_entry set description = 'changed' where id = $1`, [entry.id]),
    ).rejects.toThrow();
    await expect(
      ownerPool.query(`delete from journal_entry where id = $1`, [entry.id]),
    ).rejects.toThrow();
    await expect(
      ownerPool.query(`delete from journal_line where journal_entry_id = $1`, [entry.id]),
    ).rejects.toThrow();
  });

  it('reverses a posted entry with a linked mirror, and leaves both standing', async () => {
    const original = await postJournal(
      [
        { accountId: salaries, debit: '900' },
        { accountId: cash, credit: '900' },
      ],
      { description: 'August salaries' },
    );

    const reversal = await withScope(scopeOf(manager), (tx) =>
      journal.reverse(tx, manager, original.id, { reason: 'posted to the wrong month' }),
    );

    expect(await statusOf(original.id)).toBe('reversed');
    expect(await statusOf(reversal.id)).toBe('posted');

    const { rows } = await ownerPool.query<{ reverses_id: string; reversed_by_id: string }>(
      `select reverses_id, reversed_by_id from journal_entry where id = any($1)`,
      [[original.id, reversal.id]],
    );
    expect(rows.some((r) => r.reverses_id === original.id)).toBe(true);
    expect(rows.some((r) => r.reversed_by_id === reversal.id)).toBe(true);

    // Every line came back the other way round, for the same money.
    const lines = await withScope(scopeOf(manager), (tx) => journal.loadLines(tx, reversal.id));
    const salaryLine = lines.find((l) => l.accountId === salaries)!;
    expect(salaryLine.creditIqd).toBeGreaterThan(0n);
    expect(salaryLine.debitIqd).toBe(0n);
  });

  it('leaves the ledger flat after a reversal', async () => {
    const original = await postJournal([
      { accountId: salaries, debit: '900' },
      { accountId: cash, credit: '900' },
    ]);
    await withScope(scopeOf(manager), (tx) =>
      journal.reverse(tx, manager, original.id, { reason: 'duplicate' }),
    );

    const rows = await withScope(scopeOf(manager), (tx) =>
      trialBalance.trialBalance(tx, { from: FROM, to: TO, branchCode: BRANCH }),
    );
    // Both halves are in the ledger and cancel; nothing is hidden from view.
    const salaryRow = rows.find((r) => r.accountName === 'Salaries');
    expect(salaryRow ? Number(salaryRow.balance) : 0).toBe(0);
  });

  it('refuses to reverse the same entry twice, or to reverse a reversal', async () => {
    const original = await postJournal([
      { accountId: cash, debit: '100' },
      { accountId: capital, credit: '100' },
    ]);
    const reversal = await withScope(scopeOf(manager), (tx) =>
      journal.reverse(tx, manager, original.id, { reason: 'first' }),
    );

    expect(
      await rejection(
        withScope(scopeOf(manager), (tx) =>
          journal.reverse(tx, manager, original.id, { reason: 'again' }),
        ),
      ),
    ).toBeTruthy();
    expect(
      await rejection(
        withScope(scopeOf(manager), (tx) =>
          journal.reverse(tx, manager, reversal.id, { reason: 'undo the undo' }),
        ),
      ),
    ).toBeTruthy();
  });

  it('refuses a reversal without a reason, and one dated before the original', async () => {
    const original = await postJournal([
      { accountId: cash, debit: '100' },
      { accountId: capital, credit: '100' },
    ]);

    expect(
      await rejection(
        withScope(scopeOf(manager), (tx) => journal.reverse(tx, manager, original.id, { reason: '  ' })),
      ),
    ).toBeTruthy();

    // Dated earlier: the service moves it forward rather than refusing, so the
    // reversal can never precede what it undoes.
    const reversal = await withScope(scopeOf(manager), (tx) =>
      journal.reverse(tx, manager, original.id, {
        reason: 'back-dated attempt',
        postingDate: `${YEAR}-01-05`,
      }),
    );
    const header = await withScope(scopeOf(manager), (tx) => journal.loadHeader(tx, reversal.id));
    expect(header.postingDate >= POSTING_DATE).toBe(true);
  });

  it('will not let an accountant without the permission reverse anything', async () => {
    const original = await postJournal([
      { accountId: cash, debit: '100' },
      { accountId: capital, credit: '100' },
    ]);
    await ownerPool.query(
      `delete from role_grant where role_code = 'accounting_officer' and object = 'journal_entry' and verb = 'reverse_cancel'`,
    );
    const refreshed = await withScope(scopeOf(officer), (tx) =>
      authz.loadPrincipal(tx, officer.principal.userId),
    );

    const message = await rejection(
      withScope(scopeOf(officer), (tx) =>
        journal.reverse(tx, { ...officer, principal: refreshed }, original.id, { reason: 'no' }),
      ),
    );
    expect(message).toBeTruthy();
    expect(await statusOf(original.id)).toBe('posted');
  });
});

// ---------------------------------------------------------------------------
describe('4 · the General Ledger and the Trial Balance', () => {
  beforeEach(async () => {
    await postJournal([
      { accountId: cash, debit: '10000' },
      { accountId: capital, credit: '10000' },
    ]);
    await postJournal([
      { accountId: receivables, debit: '4000' },
      { accountId: salesRevenue, credit: '4000' },
    ]);
    await postJournal([
      { accountId: salaries, debit: '1500' },
      { accountId: cash, credit: '1500' },
    ]);
  });

  it('shows every posted entry, and its debits equal its credits', async () => {
    const rows = await withScope(scopeOf(manager), (tx) =>
      trialBalance.trialBalance(tx, { from: FROM, to: TO, branchCode: BRANCH }),
    );
    const totals = trialBalance.totalsOf(rows);
    expect(Number(totals.debit)).toBe(15500);
    expect(Number(totals.credit)).toBe(15500);
    expect(totals.balances).toBe(true);
  });

  it('shows the activity on one account, entry by entry', async () => {
    const { rows } = await ownerPool.query<{ code: string }>(
      'select code from chart_of_account where id = $1',
      [cash],
    );
    const activity = await withScope(scopeOf(manager), (tx) =>
      trialBalance.accountActivity(tx, rows[0]!.code, { from: FROM, to: TO, branchCode: BRANCH }),
    );
    // In 10,000 and out 1,500 — two movements, and a running balance.
    expect(activity.length).toBeGreaterThanOrEqual(2);
  });

  it('answers for a chosen period, not for all time', async () => {
    const january = await withScope(scopeOf(manager), (tx) =>
      trialBalance.trialBalance(tx, { from: `${YEAR}-01-01`, to: `${YEAR}-01-31`, branchCode: BRANCH }),
    );
    expect(january).toHaveLength(0);
  });

  it('leaves a draft out of the ledger entirely', async () => {
    const draft = await withScope(scopeOf(manager), (tx) =>
      journal.createDraft(tx, manager, {
        branchCode: BRANCH,
        documentDate: POSTING_DATE,
        postingDate: POSTING_DATE,
        description: 'Not finished',
      }),
    );
    await withScope(scopeOf(manager), (tx) =>
      journal.addLine(tx, manager, draft.id, {
        accountId: cash,
        debit: '999999',
        dimensions: { department: 'FIN' },
      }),
    );

    const rows = await withScope(scopeOf(manager), (tx) =>
      trialBalance.trialBalance(tx, { from: FROM, to: TO, branchCode: BRANCH }),
    );
    expect(Number(trialBalance.totalsOf(rows).debit)).toBe(15500);
  });
});

// ---------------------------------------------------------------------------
describe('5 · the financial statements', () => {
  beforeEach(async () => {
    await postJournal([
      { accountId: cash, debit: '10000' },
      { accountId: capital, credit: '10000' },
    ]);
    await postJournal([
      { accountId: receivables, debit: '4000' },
      { accountId: salesRevenue, credit: '4000' },
    ]);
    await postJournal([
      { accountId: salaries, debit: '1500' },
      { accountId: cash, credit: '1500' },
    ]);
  });

  it('produces a Statement of Profit or Loss for the period', async () => {
    const pl = await withScope(scopeOf(manager), (tx) =>
      statements.profitOrLoss(tx, { from: FROM, to: TO, branchCode: BRANCH }),
    );

    const revenue = pl.lines.find((l) => l.line.code === 'revenue');
    const expenses = pl.lines.find((l) => l.line.code === 'operating_expenses');
    expect(Number(revenue!.amount)).toBe(4000);
    expect(Number(expenses!.amount)).toBe(1500);
    // 4,000 earned less 1,500 spent.
    expect(Number(pl.result)).toBe(2500);
  });

  it('produces a Statement of Financial Position that balances', async () => {
    const sfp = await withScope(scopeOf(manager), (tx) =>
      statements.financialPosition(tx, TO, { branchCode: BRANCH }),
    );

    // Cash 8,500 + receivables 4,000 = 12,500.
    expect(Number(sfp.totalAssets)).toBe(12500);
    // Capital 10,000 + the period's profit 2,500.
    expect(Number(sfp.totalEquityAndLiabilities)).toBe(12500);
    expect(Number(sfp.resultForThePeriod)).toBe(2500);
    expect(sfp.balances).toBe(true);
  });

  it('puts each account on the statement line it was assigned', async () => {
    const sfp = await withScope(scopeOf(manager), (tx) =>
      statements.financialPosition(tx, TO, { branchCode: BRANCH }),
    );
    const cashLine = sfp.assets.find((l) => l.line.code === 'cash_and_equivalents');
    expect(cashLine).toBeDefined();
    expect(cashLine!.accounts.map((a) => a.accountName)).toContain('Cash on Hand');

    // Trade Receivables was never assigned a line, so it falls to its type's
    // default rather than disappearing from the statement.
    const current = sfp.assets.find((l) => l.line.code === 'current_assets');
    expect(current!.accounts.map((a) => a.accountName)).toContain('Trade Receivables');
  });

  it('presents one revenue account on each report, on the line chosen for it', async () => {
    // The example that drove the direction: Sales explains the period on the
    // Income Statement *and* is presented inside Equity on the Balance Sheet,
    // and appears as its own row on Changes in Equity. Three lines, three
    // choices, one account — and no figure counted twice.
    await ownerPool.query(`
      insert into financial_statement_line
        (code, name, statement, ordinal, role, side, cash_flow_category)
      values
        ('balance_sheet_revenue', 'Revenue', 'balance_sheet', 41, null, 'equity', 'financing'),
        ('equity_trading', 'Trading result', 'changes_in_equity', 20, null, null, null)
    `);
    await withScope(scopeOf(manager), (tx) =>
      coa.setStatementLines(tx, manager, salesRevenue, {
        income_statement: 'revenue',
        balance_sheet: 'balance_sheet_revenue',
        changes_in_equity: 'equity_trading',
      }),
    );

    const sfp = await withScope(scopeOf(manager), (tx) =>
      statements.financialPosition(tx, TO, { branchCode: BRANCH }),
    );
    const revenue = sfp.equity.find((line) => line.line.code === 'balance_sheet_revenue');
    expect(Number(revenue!.amount)).toBe(4000);
    expect(revenue!.accounts.map((account) => account.accountName)).toContain('Sales');

    // Salaries was mapped nowhere on the Balance Sheet, so it is still carried
    // by the computed result — which is what keeps the two sides agreeing.
    expect(Number(sfp.unmappedResult)).toBe(-1500);
    expect(Number(sfp.resultForThePeriod)).toBe(2500);
    expect(Number(sfp.totalEquityAndLiabilities)).toBe(12500);
    expect(sfp.balances).toBe(true);

    const equity = await withScope(scopeOf(manager), (tx) =>
      statements.changesInEquity(tx, { from: FROM, to: TO, branchCode: BRANCH }),
    );
    const trading = equity.rows.find((row) => row.code === 'equity_trading');
    expect(Number(trading!.movement)).toBe(4000);
    expect(trading!.accounts.map((account) => account.accountName)).toContain('Sales');
    expect(Number(equity.resultForThePeriod)).toBe(2500);
    expect(Number(equity.closing)).toBe(12500);
  });

  it('does not argue with Finance about which line suits which account', async () => {
    // By direction (2026-09-03) mapping is a mapping, not an accounting
    // opinion: an unusual choice is the chart owner's to make.
    await expect(
      ownerPool.query(
        `update chart_of_account set balance_sheet_line = 'current_assets' where id = $1`,
        [salesRevenue],
      ),
    ).resolves.toBeDefined();
    // Put it back where the rest of this file expects to find it.
    await ownerPool.query(
      `update chart_of_account set balance_sheet_line = null where id = $1`,
      [salesRevenue],
    );
  });

  it('refuses a mapping that could not mean anything', async () => {
    // A line belonging to another report...
    await expect(
      ownerPool.query(
        `update chart_of_account set income_statement_line = 'current_assets' where id = $1`,
        [salesRevenue],
      ),
    ).rejects.toThrow();

    // ...a line that does not exist...
    await expect(
      ownerPool.query(
        `update chart_of_account set cash_flow_line = 'no_such_line' where id = $1`,
        [salesRevenue],
      ),
    ).rejects.toThrow();

    // ...and a header, which prints the sum of its lines and takes no accounts.
    await ownerPool.query(`
      insert into financial_statement_line (code, name, statement, ordinal, role, side, is_header)
      values ('is_header_only', 'A header', 'income_statement', 99, null, null, true)
      on conflict (code) do nothing
    `);
    await expect(
      ownerPool.query(
        `update chart_of_account set income_statement_line = 'is_header_only' where id = $1`,
        [salesRevenue],
      ),
    ).rejects.toThrow();
  });

  it('still balances after a reversal', async () => {
    const wrong = await postJournal([
      { accountId: salaries, debit: '750' },
      { accountId: cash, credit: '750' },
    ]);
    await withScope(scopeOf(manager), (tx) =>
      journal.reverse(tx, manager, wrong.id, { reason: 'charged to the wrong account' }),
    );

    const sfp = await withScope(scopeOf(manager), (tx) =>
      statements.financialPosition(tx, TO, { branchCode: BRANCH }),
    );
    expect(sfp.balances).toBe(true);
    expect(Number(sfp.totalAssets)).toBe(12500);

    const pl = await withScope(scopeOf(manager), (tx) =>
      statements.profitOrLoss(tx, { from: FROM, to: TO, branchCode: BRANCH }),
    );
    expect(Number(pl.result)).toBe(2500);
  });
});
