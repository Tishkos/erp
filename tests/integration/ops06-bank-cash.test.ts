/**
 * Operations build, block 6 — Banks and Cash (2026-09-12).
 *
 *   Master     Bank/Cash Name; Bank Number (automatically generated);
 *              Type (Cash or Bank); Related Account.
 *   Statement  Incoming amounts are Debit. Outgoing amounts are Credit.
 *   Payments   allocated to the related supplier invoice, including partial.
 *              Accounts Payable Dr. / Bank or Cash Cr.
 *   Receipts   allocated to the related customer invoice, including partial.
 *              Bank or Cash Dr. / Accounts Receivable Cr.
 *
 * The master and both documents were already here. What this block adds is the
 * statement — and it is the same report the customer and supplier already use,
 * with a third side, because a bank account is a party of the ledger in
 * exactly the sense those two are: the posting engine writes a subledger entry
 * beside every journal line that touches one.
 *
 * A bank reads the same way round as a customer. Both are debit-normal, and
 * what is owed to you and what you hold are the same kind of number.
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
import * as banks from '@/server/services/bank-cash-accounts';
import * as statement from '@/server/services/partner-statement';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BAGHDAD = 'BGW';
const TO = '2026-12-31';

let manager: ActorContext;
let approver: ActorContext;
let bankGl: string;
let receivables: string;
let payables: string;
let revenue: string;

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
  controlAccount?: 'customer' | 'supplier' | 'bank',
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

/** One posted journal. A line that names a bank account says which. */
async function post(
  on: string,
  description: string,
  lines: Array<{
    account: string;
    debit?: string;
    credit?: string;
    bankAccountCode?: string;
    partner?: string;
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
        ...(line.bankAccountCode ? { bankAccountCode: line.bankAccountCode } : {}),
        dimensions: {
          department: 'FIN',
          ...(line.partner ? { business_partner: line.partner } : {}),
        },
      } as never),
    );
  }
  await withScope(scope(manager), (tx) => journal.submit(tx, manager, entry.id));
}

const read = (side: statement.PartySide, code: string, from?: string) =>
  withScope(scope(manager), (tx) =>
    statement.statementFor(tx, side, code, { to: TO, ...(from ? { from } : {}) }),
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

  for (const [code, name, kind] of [
    ['CUST-1', 'Al Noor Trading', 'customer'],
    ['CUST-2', 'Basra Retail', 'customer'],
    ['SUP-1', 'Jinko Solar', 'supplier'],
    ['SUP-2', 'Longi Green', 'supplier'],
  ] as const) {
    await ownerPool.query(
      `insert into business_partner (code, legal_name, is_customer, is_supplier, status, active)
       values ($1,$2,$3,$4,'active',true) on conflict do nothing`,
      [code, name, kind === 'customer', kind === 'supplier'],
    );
  }

  bankGl = await account('A000001', 'Bank — Al Rafidain', 'bank');
  receivables = await account('A000001', 'Trade Receivables', 'customer');
  payables = await account('L000001', 'Trade Payables', 'supplier');
  revenue = await account('R000001', 'Sales');
});

// ---------------------------------------------------------------------------
describe('ops 6 · the bank and cash master', () => {
  it('generates the number, and takes the name, the type and the account', async () => {
    const made = await withScope(scope(manager), (tx) =>
      banks.create(tx, manager, 'bank', {
        name: 'Al Rafidain — Current',
        glAccountId: bankGl,
        branchCode: BAGHDAD,
        currency: 'IQD',
        bankName: 'Al Rafidain',
        accountNumber: '0011-22334455',
      }),
    );

    // Not typed by anybody: derived from the name, and unique.
    expect(made.code).toMatch(/^BANK/);
    const row = await withScope(scope(manager), (tx) => banks.detail(tx, made.code));
    expect(row.name).toBe('Al Rafidain — Current');
    expect(row.accountType).toBe('bank');
  });

  it('keeps cash and bank apart, and names the account each one carries', async () => {
    const cashGl = await account('A000001', 'Petty Cash Float');
    const made = await withScope(scope(manager), (tx) =>
      banks.create(tx, manager, 'cash', {
        name: 'Head Office Petty Cash',
        glAccountId: cashGl,
        branchCode: BAGHDAD,
        currency: 'IQD',
        // §17 — a float without a custodian is nobody's responsibility.
        custodianUserId: manager.principal.userId,
      }),
    );
    const row = await withScope(scope(manager), (tx) => banks.detail(tx, made.code));
    expect(row.accountType).toBe('cash');
    expect(row.glAccountName).toBe('Petty Cash Float');
  });

  it('refuses to let two accounts carry the same ledger account', async () => {
    await withScope(scope(manager), (tx) =>
      banks.create(tx, manager, 'bank', {
        name: 'First',
        glAccountId: bankGl,
        branchCode: BAGHDAD,
        currency: 'IQD',
        bankName: 'Al Rafidain',
        accountNumber: '0011-1',
      }),
    );
    await expect(
      withScope(scope(manager), (tx) =>
        banks.create(tx, manager, 'bank', {
          name: 'Second',
          glAccountId: bankGl,
          branchCode: BAGHDAD,
          currency: 'IQD',
          bankName: 'Al Rafidain',
          accountNumber: '0011-2',
        }),
      ),
    ).rejects.toThrow(/already carried/);
  });
});

// ---------------------------------------------------------------------------
describe('ops 6 · the bank statement', () => {
  const BANK = 'BANK-RAFIDAIN-01';

  beforeEach(async () => {
    await ownerPool.query(
      `insert into bank_cash_account
         (code, name, account_type, gl_account_id, branch_code, currency, bank_name, account_number)
       values ($1,'Al Rafidain — Current','bank',$2,$3,'IQD','Al Rafidain','0011-22334455')
       on conflict do nothing`,
      [BANK, bankGl, BAGHDAD],
    );
  });

  it('shows money in as Debit and money out as Credit, with what is left', async () => {
    await post('2026-03-01', 'Receipt from a customer', [
      { account: bankGl, debit: '1500000.0000', bankAccountCode: BANK },
      { account: receivables, credit: '1500000.0000', partner: 'CUST-1' },
    ]);
    await post('2026-04-01', 'Payment to a supplier', [
      { account: payables, debit: '600000.0000', partner: 'SUP-1' },
      { account: bankGl, credit: '600000.0000', bankAccountCode: BANK },
    ]);

    const s = await read('bank', BANK);
    expect(s.lines.map((l) => [Number(l.debit), Number(l.credit), Number(l.balance)])).toEqual([
      [1_500_000, 0, 1_500_000],
      [0, 600_000, 900_000],
    ]);
    expect(Number(s.closing)).toBe(900_000); // what the account holds
  });

  it('folds what came before the window into the opening balance', async () => {
    await post('2026-02-01', 'Earlier receipt', [
      { account: bankGl, debit: '1000000.0000', bankAccountCode: BANK },
      { account: revenue, credit: '1000000.0000' },
    ]);
    await post('2026-08-01', 'Later receipt', [
      { account: bankGl, debit: '250000.0000', bankAccountCode: BANK },
      { account: revenue, credit: '250000.0000' },
    ]);

    const whole = await read('bank', BANK);
    const later = await read('bank', BANK, '2026-07-01');

    expect(later.lines).toHaveLength(1);
    expect(Number(later.opening)).toBe(1_000_000);
    expect(Number(later.closing)).toBe(Number(whole.closing));
    expect(Number(whole.closing)).toBe(1_250_000);
  });

  it('leaves one account out of another’s statement', async () => {
    const otherGl = await account('A000001', 'Bank — Second', 'bank');
    await ownerPool.query(
      `insert into bank_cash_account
         (code, name, account_type, gl_account_id, branch_code, currency, bank_name, account_number)
       values ('BANK-SECOND','Second','bank',$1,$2,'IQD','Al Rafidain','0011-99')`,
      [otherGl, BAGHDAD],
    );

    await post('2026-03-01', 'Into the first', [
      { account: bankGl, debit: '400000.0000', bankAccountCode: BANK },
      { account: revenue, credit: '400000.0000' },
    ]);
    await post('2026-03-02', 'Into the second', [
      { account: otherGl, debit: '700000.0000', bankAccountCode: 'BANK-SECOND' },
      { account: revenue, credit: '700000.0000' },
    ]);

    expect(Number((await read('bank', BANK)).closing)).toBe(400_000);
    expect(Number((await read('bank', 'BANK-SECOND')).closing)).toBe(700_000);
  });

  it('reads the same way round as a customer, and the opposite of a supplier', async () => {
    // One receipt and one payment, of the same size, through the same bank.
    await post('2026-03-01', 'Receipt', [
      { account: bankGl, debit: '500000.0000', bankAccountCode: BANK },
      { account: receivables, credit: '500000.0000', partner: 'CUST-2' },
    ]);
    await post('2026-03-02', 'Payment', [
      { account: payables, debit: '500000.0000', partner: 'SUP-2' },
      { account: bankGl, credit: '500000.0000', bankAccountCode: BANK },
    ]);

    // The bank is where it started: money in, money out.
    expect(Number((await read('bank', BANK)).closing)).toBe(0);
    // The customer paid, so they owe 500,000 less than they did.
    expect(Number((await read('customer', 'CUST-2')).closing)).toBe(-500_000);
    // The supplier was paid, so the company owes them 500,000 less.
    expect(Number((await read('supplier', 'SUP-2')).closing)).toBe(-500_000);
  });
});
