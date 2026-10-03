/**
 * REQ-FIX-001 FX3 — a bank deposit, from cash and from another source.
 *
 * The register is over two existing documents (D-FX-2): cash taken to the
 * bank is a bank transfer, money from anywhere else is an other receipt.
 * Each is raised, approved by somebody else and posted from the Bank
 * Deposits screen, and lands on Bank and Cash Reporting the way it should —
 * the cash deposit as a transfer on both sides (not income), the other
 * deposit as money in.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import * as banks from '@/server/services/bank-cash-accounts';
import * as journal from '@/server/services/journal';
import * as periods from '@/server/services/periods';
import * as rates from '@/server/services/exchange-rates';
import * as reports from '@/server/services/treasury-reports';
import * as deposits from '@/server/services/bank-deposits';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BRANCH = 'HQ';
const ON = '2026-05-10';
const WINDOW = { from: '2026-01-01', to: '2026-12-31' } as const;
const iqd = (whole: number) => BigInt(whole) * 10_000n;

let manager: ActorContext;
let approver: ActorContext;
let cashId = '';
let cashCode = '';
let bankId = '';
let bankCode = '';
let incomeId = '';
let receivableId = '';

async function userWith(...roles: string[]): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [id, `${id}@example.com`, roles.join('+')]);
  for (const role of roles) await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BRANCH]);
  await ownerPool.query(`insert into user_department_scope (user_id, department_code) values ($1,'FIN') on conflict do nothing`, [id]);
  const principal = await withScope({ userId: id, branchCode: BRANCH }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BRANCH };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BRANCH });

async function account(rootCode: string, name: string, controlAccount?: 'bank' | 'customer'): Promise<string> {
  const { rows } = await ownerPool.query(`select id from chart_of_account where code = $1`, [rootCode]);
  const made = await withScope(scope(manager), (tx) => coa.createAccount(tx, manager, { name, currencyRestriction: 'IQD', parentId: rows[0].id, ...(controlAccount ? { controlAccount } : {}) }));
  await withScope(scope(manager), (tx) => coa.submitForApproval(tx, manager, made.id));
  await withScope(scope(approver), (tx) => coa.approve(tx, approver, made.id));
  return made.id;
}

beforeAll(async () => {
  await resetTestData();
  await seedBranch(BRANCH, 'Head Office');
  await ownerPool.query(`insert into department (code, name, is_finance) values ('FIN','Finance',true) on conflict do nothing`);
  manager = await userWith('accounting_manager');
  approver = await userWith('accounting_manager');
  await withScope(scope(manager), (tx) => periods.createFiscalYear(tx, manager, { code: 'FY2026', startsOn: '2026-01-01', endsOn: '2026-12-31' }));
  await withScope(scope(manager), (tx) => rates.publishRate(tx, manager, { currency: 'USD', iqdPerUnit: '1310.00000000', effectiveFrom: '2026-01-01' }));

  const cashGl = await account('A000001', 'Deposit test — cash', 'bank');
  const bankGl = await account('A000001', 'Deposit test — bank', 'bank');
  const equity = await account('E000001', 'Deposit test — funding');
  incomeId = await account('R000001', 'Deposit test — other income');
  receivableId = await account('A000001', 'Deposit test — receivables', 'customer');

  const made = await withScope(scope(manager), async (tx) => ({
    cash: await banks.create(tx, manager, 'cash', { name: 'Till', glAccountId: cashGl, currency: 'IQD', custodianUserId: manager.principal.userId }),
    bank: await banks.create(tx, manager, 'bank', { name: 'Current account', glAccountId: bankGl, currency: 'IQD', bankName: 'Rafidain', accountNumber: '0011223344' }),
  }));
  cashId = made.cash.id;
  cashCode = made.cash.code;
  bankId = made.bank.id;
  bankCode = made.bank.code;

  for (const [event, role, accountId] of [
    ['treasury.other_receipt', 'bank', incomeId],
    ['treasury.other_receipt', 'other_income', incomeId],
  ] as const) {
    await ownerPool.query(`insert into posting_rule (event_type, line_role, account_id, is_active, created_by) values ($1,$2,$3,true,$4) on conflict do nothing`, [
      event,
      role,
      accountId,
      manager.principal.userId,
    ]);
  }

  // The till holds 1,000 before anything is taken to the bank.
  const entry = await withScope(scope(manager), (tx) =>
    journal.createDraft(tx, manager, { branchCode: BRANCH, documentDate: '2026-05-01', postingDate: '2026-05-01', description: 'Deposit test — float' }),
  );
  await withScope(scope(manager), (tx) => journal.addLine(tx, manager, entry.id, { accountId: cashGl, debit: '1000.0000', bankAccountCode: cashCode, dimensions: { department: 'FIN' } } as never));
  await withScope(scope(manager), (tx) => journal.addLine(tx, manager, entry.id, { accountId: equity, credit: '1000.0000', dimensions: { department: 'FIN' } } as never));
  const outcome = await withScope(scope(manager), (tx) => journal.submit(tx, manager, entry.id));
  if (outcome.status !== 'posted') await withScope(scope(approver), (tx) => journal.approve(tx, approver, entry.id));
});

describe('FX3 · bank deposits', () => {
  it('money counted into the cash: raised, approved by somebody else, posted', async () => {
    const made = await withScope(scope(manager), (tx) =>
      deposits.depositCash(tx, manager, {
        intoAccountId: cashId,
        creditAccountId: incomeId,
        payer: 'The owner',
        depositDate: ON,
        amount: iqd(400),
        reference: 'SLIP-1',
      }),
    );
    // The one who raised it does not approve it.
    await expect(withScope(scope(manager), (tx) => deposits.approve(tx, manager, made.no))).rejects.toThrow(/somebody else/);
    await withScope(scope(approver), (tx) => deposits.approve(tx, approver, made.no));
    await withScope(scope(manager), (tx) => deposits.post(tx, manager, made.no));

    const row = await withScope(scope(manager), (tx) => deposits.byNo(tx, made.no));
    // Into the cash account, and the register says which kind it was.
    expect(row).toMatchObject({ source: 'cash', status: 'posted', intoCode: cashCode, reference: 'SLIP-1' });
    expect(row.journalEntryNo).toMatch(/^JE-/);

    // The cash account is 400 better off; the bank is untouched, because no
    // bank was involved (2026-10-04).
    const positions = await withScope(scope(manager), (tx) => reports.positions(tx, manager, WINDOW));
    const bank = positions.find((p) => p.accountCode === bankCode)!;
    const cash = positions.find((p) => p.accountCode === cashCode)!;
    // The till opened with 1,000 and 400 was counted in: 1,400, and money in
    // rather than a transfer, because it came from outside (2026-10-04).
    expect(Number(cash.closingIqd)).toBe(1400);
    // All of it is money in: the 1,000 the till opened with came from equity
    // and the 400 from outside — neither is a transfer between own accounts.
    expect(Number(cash.moneyInIqd), 'money from outside is money in').toBe(1400);
    expect(Number(bank.closingIqd), 'no bank was involved').toBe(0);
    expect(Number(bank.transfersInIqd)).toBe(0);
  });

  it('money from another source: an other receipt into the bank, credited where it belongs, never to a control account', async () => {
    await expect(
      withScope(scope(manager), (tx) => deposits.depositOther(tx, manager, { intoAccountId: bankId, creditAccountId: receivableId, payer: 'A customer', depositDate: ON, amount: iqd(50) })),
    ).rejects.toThrow(/control account/);

    const made = await withScope(scope(manager), (tx) =>
      deposits.depositOther(tx, manager, { intoAccountId: bankId, creditAccountId: incomeId, payer: 'Insurance claim', depositDate: ON, amount: iqd(250) }),
    );
    await withScope(scope(approver), (tx) => deposits.approve(tx, approver, made.no));
    await withScope(scope(manager), (tx) => deposits.post(tx, manager, made.no));

    const positions = await withScope(scope(manager), (tx) => reports.positions(tx, manager, WINDOW));
    const bank = positions.find((p) => p.accountCode === bankCode)!;
    // Only what was deposited into the bank: the cash deposit went to the till.
    expect(Number(bank.closingIqd)).toBe(250);
    expect(Number(bank.moneyInIqd), 'money from outside is money in').toBe(250);
  });

  it('each kind takes only its own accounts', async () => {
    // A bank account is not a cash account, whichever way round it is asked.
    await expect(withScope(scope(manager), (tx) => deposits.depositCash(tx, manager, { intoAccountId: bankId, creditAccountId: incomeId, payer: 'x', depositDate: ON, amount: iqd(1) }))).rejects.toThrow(
      /into a cash account/,
    );
    await expect(withScope(scope(manager), (tx) => deposits.depositOther(tx, manager, { intoAccountId: cashId, creditAccountId: incomeId, payer: 'x', depositDate: ON, amount: iqd(1) }))).rejects.toThrow(
      /into a bank account/,
    );
  });

  it('the register reads both, pages with a true count, and filters in the query', async () => {
    const all = await withScope(scope(manager), (tx) => deposits.listForScreen(tx, {}));
    expect(all.total).toBe(2);
    expect(all.rows.map((row) => row.source).sort()).toEqual(['bank', 'cash']);
    const posted = await withScope(scope(manager), (tx) => deposits.listForScreen(tx, { view: 'open' }));
    expect(posted.total).toBe(0);
    const found = await withScope(scope(manager), (tx) => deposits.listForScreen(tx, { search: 'insurance' }));
    expect(found.rows.map((row) => row.payer)).toEqual(['Insurance claim']);
  });
});
