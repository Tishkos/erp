/**
 * Operations build, blocks 2 and 3 — the customer and supplier Account
 * Statement (2026-09-12).
 *
 * The sponsor described them as mirrors:
 *
 *   Customer   sales are Debit; payments or discounts are Credit.
 *   Supplier   purchases are Credit; payments or discounts are Debit.
 *
 * They read the subledger the posting engine already writes beside every
 * journal, so nothing is classified twice. What differs is which way the
 * running balance is read, and this file holds both to it — including the one
 * thing a statement must never get wrong: that opening plus the movement
 * equals the closing, whichever window you ask for.
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
import * as statement from '@/server/services/partner-statement';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BAGHDAD = 'BGW';
const YEAR = { to: '2026-12-31' } as const;

let manager: ActorContext;
let approver: ActorContext;
let bank: string;
let receivables: string;
let payables: string;
let revenue: string;
let expense: string;

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

async function account(
  rootCode: string,
  name: string,
  controlAccount?: 'customer' | 'supplier',
): Promise<string> {
  const { rows } = await ownerPool.query(`select id from chart_of_account where code = $1`, [
    rootCode,
  ]);
  const made = await withScope(scope(manager), (tx) =>
    coa.createAccount(tx, manager, {
      name,
      currencyRestriction: 'IQD',
      parentId: rows[0].id,
      ...(controlAccount ? { controlAccount } : {}),
    }),
  );
  await withScope(scope(manager), (tx) => coa.submitForApproval(tx, manager, made.id));
  await withScope(scope(approver), (tx) => coa.approve(tx, approver, made.id));
  return made.id;
}

async function partner(code: string, name: string, side: 'customer' | 'supplier') {
  await ownerPool.query(
    `insert into business_partner (code, legal_name, is_customer, is_supplier, status)
     values ($1, $2, $3, $4, 'active')`,
    [code, name, side === 'customer', side === 'supplier'],
  );
  return code;
}

/** One posted journal, with the party named on whichever line needs it. */
async function post(
  on: string,
  description: string,
  lines: Array<{
    account: string;
    debit?: string;
    credit?: string;
    customer?: string;
    supplier?: string;
  }>,
) {
  const entry = await withScope(scope(manager), (tx) =>
    journal.createDraft(tx, manager, {
      branchCode: BAGHDAD,
      documentDate: on,
      postingDate: on,
      description,
    }),
  );
  for (const line of lines) {
    await withScope(scope(manager), (tx) =>
      journal.addLine(tx, manager, entry.id, {
        accountId: line.account,
        ...(line.debit ? { debit: line.debit } : {}),
        ...(line.credit ? { credit: line.credit } : {}),
        dimensions: {
          department: 'FIN',
          ...(line.customer ? { business_partner: line.customer } : {}),
          ...(line.supplier ? { business_partner: line.supplier } : {}),
        },
      } as never),
    );
  }
  await withScope(scope(manager), (tx) => journal.submit(tx, manager, entry.id));
  return entry;
}

const read = (side: 'customer' | 'supplier', code: string, from?: string) =>
  withScope(scope(manager), (tx) =>
    statement.statementFor(tx, side, code, { ...YEAR, ...(from ? { from } : {}) }),
  );

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

  bank = await account('A000001', 'Bank');
  receivables = await account('A000001', 'Accounts Receivable', 'customer');
  payables = await account('L000001', 'Accounts Payable', 'supplier');
  revenue = await account('R000001', 'Sales');
  expense = await account('X000001', 'Purchases');
});

// ---------------------------------------------------------------------------
describe('ops 2 · the customer statement', () => {
  it('shows a sale as Debit and a receipt as Credit, and what is still owed', async () => {
    const code = await partner('CUST-1', 'Al Noor Trading', 'customer');

    await post('2026-03-01', 'Invoice 1', [
      { account: receivables, debit: '1200000.0000', customer: code },
      { account: revenue, credit: '1200000.0000' },
    ]);
    await post('2026-04-01', 'Receipt', [
      { account: bank, debit: '500000.0000' },
      { account: receivables, credit: '500000.0000', customer: code },
    ]);

    const s = await read('customer', code);
    expect(s.lines.map((l) => [l.description, Number(l.debit), Number(l.credit), Number(l.balance)]))
      .toEqual([
        ['Invoice 1', 1_200_000, 0, 1_200_000],
        ['Receipt', 0, 500_000, 700_000],
      ]);
    expect(Number(s.closing)).toBe(700_000); // still owed by the customer
    expect(Number(s.totalDebit)).toBe(1_200_000);
    expect(Number(s.totalCredit)).toBe(500_000);
  });

  it('shows a discount as Credit, the same as a payment', async () => {
    const code = await partner('CUST-2', 'Basra Retail', 'customer');
    await post('2026-03-01', 'Invoice', [
      { account: receivables, debit: '1000000.0000', customer: code },
      { account: revenue, credit: '1000000.0000' },
    ]);
    await post('2026-03-20', 'Settlement discount', [
      { account: revenue, debit: '50000.0000' },
      { account: receivables, credit: '50000.0000', customer: code },
    ]);

    const s = await read('customer', code);
    expect(Number(s.lines[1]!.credit)).toBe(50_000);
    expect(Number(s.closing)).toBe(950_000);
  });

  it('leaves one customer out of another’s statement', async () => {
    const mine = await partner('CUST-3', 'Erbil Supply', 'customer');
    const other = await partner('CUST-4', 'Mosul Stores', 'customer');
    await post('2026-03-01', 'Mine', [
      { account: receivables, debit: '300000.0000', customer: mine },
      { account: revenue, credit: '300000.0000' },
    ]);
    await post('2026-03-02', 'Theirs', [
      { account: receivables, debit: '900000.0000', customer: other },
      { account: revenue, credit: '900000.0000' },
    ]);

    expect(Number((await read('customer', mine)).closing)).toBe(300_000);
    expect(Number((await read('customer', other)).closing)).toBe(900_000);
  });
});

// ---------------------------------------------------------------------------
describe('ops 3 · the supplier statement', () => {
  it('shows a purchase as Credit and a payment as Debit, and what is still owed', async () => {
    const code = await partner('SUP-1', 'Jinko Solar', 'supplier');

    await post('2026-03-01', 'Purchase invoice', [
      { account: expense, debit: '2000000.0000' },
      { account: payables, credit: '2000000.0000', supplier: code },
    ]);
    await post('2026-05-01', 'Payment', [
      { account: payables, debit: '800000.0000', supplier: code },
      { account: bank, credit: '800000.0000' },
    ]);

    const s = await read('supplier', code);
    expect(s.lines.map((l) => [l.description, Number(l.debit), Number(l.credit), Number(l.balance)]))
      .toEqual([
        ['Purchase invoice', 0, 2_000_000, 2_000_000],
        ['Payment', 800_000, 0, 1_200_000],
      ]);
    // Positive means money is still owed — to the supplier, this way round.
    expect(Number(s.closing)).toBe(1_200_000);
  });

  it('shows a discount taken as Debit, the same as a payment', async () => {
    const code = await partner('SUP-2', 'Longi Green', 'supplier');
    await post('2026-03-01', 'Purchase invoice', [
      { account: expense, debit: '1000000.0000' },
      { account: payables, credit: '1000000.0000', supplier: code },
    ]);
    await post('2026-03-20', 'Discount received', [
      { account: payables, debit: '70000.0000', supplier: code },
      { account: expense, credit: '70000.0000' },
    ]);

    const s = await read('supplier', code);
    expect(Number(s.lines[1]!.debit)).toBe(70_000);
    expect(Number(s.closing)).toBe(930_000);
  });
});

// ---------------------------------------------------------------------------
describe('ops 2 and 3 · a window does not lose anything', () => {
  it('folds everything before the window into the opening balance', async () => {
    const code = await partner('CUST-5', 'Kirkuk Power', 'customer');
    await post('2026-02-01', 'Old invoice', [
      { account: receivables, debit: '600000.0000', customer: code },
      { account: revenue, credit: '600000.0000' },
    ]);
    await post('2026-08-01', 'New invoice', [
      { account: receivables, debit: '400000.0000', customer: code },
      { account: revenue, credit: '400000.0000' },
    ]);

    const whole = await read('customer', code);
    const later = await read('customer', code, '2026-07-01');

    expect(Number(whole.opening)).toBe(0);
    expect(whole.lines).toHaveLength(2);

    // The window shows one line, opens where the other left off, and closes
    // at the same place the whole year does.
    expect(later.lines).toHaveLength(1);
    expect(Number(later.opening)).toBe(600_000);
    expect(Number(later.closing)).toBe(1_000_000);
    expect(Number(later.closing)).toBe(Number(whole.closing));
  });

  it('opens and closes at nothing for a partner who has never traded', async () => {
    const code = await partner('CUST-6', 'Dohuk Electrics', 'customer');
    const s = await read('customer', code);
    expect(s.lines).toEqual([]);
    expect(Number(s.opening)).toBe(0);
    expect(Number(s.closing)).toBe(0);
  });
});
