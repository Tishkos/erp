/**
 * C-20 — a bank or cash account can never hold less than nothing.
 *
 * By direction (2026-10-03), after an account was found at -10,000 IQD. The
 * payment application has checked funds since §15.3 and the supplier payment
 * was made to check them too, but twenty services name a bank or cash account
 * and a rule kept in each of them holds only until somebody writes the
 * twenty-first. So it is the database's rule, and these are the cases that
 * matter:
 *
 *   * a posting that would overdraw an account is refused, whatever raised it
 *     — here a journal entered by hand, which answers to no service check;
 *   * a transfer between two accounts is weighed whole, because the credit on
 *     one side and the debit on the other are lines of one journal and an
 *     eager check would refuse the credit before seeing what paid for it;
 *   * an ordinary asset account is not a bank account and may go where the
 *     books take it.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as banks from '@/server/services/bank-cash-accounts';
import * as coa from '@/server/services/chart-of-accounts';
import * as journal from '@/server/services/journal';
import * as periods from '@/server/services/periods';
import * as rates from '@/server/services/exchange-rates';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BRANCH = 'HQ';
const ON = '2026-05-10';

let manager: ActorContext;
let approver: ActorContext;
let bankGl = '';
let bankCode = '';
let otherBankGl = '';
let otherBankCode = '';
let equityGl = '';
let plainAssetGl = '';

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

async function account(rootCode: string, name: string, controlAccount?: 'bank'): Promise<string> {
  const { rows } = await ownerPool.query(`select id from chart_of_account where code = $1`, [rootCode]);
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

/**
 * One journal, raised and posted as somebody entering it by hand would.
 *
 * A line on a bank control account carries the bank account's code: without
 * it the posting is refused for a different reason entirely (§1.2), and the
 * test would prove nothing about this one.
 */
async function post(lines: { accountId: string; debit?: string; credit?: string; bankCode?: string }[], memo: string) {
  const entry = await withScope(scope(manager), (tx) =>
    journal.createDraft(tx, manager, { branchCode: BRANCH, documentDate: ON, postingDate: ON, description: memo }),
  );
  for (const line of lines) {
    await withScope(scope(manager), (tx) =>
      journal.addLine(tx, manager, entry.id, {
        accountId: line.accountId,
        ...(line.debit ? { debit: line.debit } : {}),
        ...(line.credit ? { credit: line.credit } : {}),
        ...(line.bankCode ? { bankAccountCode: line.bankCode } : {}),
        dimensions: { department: 'FIN' },
      } as never),
    );
  }
  const outcome = await withScope(scope(manager), (tx) => journal.submit(tx, manager, entry.id));
  if (outcome.status !== 'posted') {
    await withScope(scope(approver), (tx) => journal.approve(tx, approver, entry.id));
  }
  return entry;
}

beforeAll(async () => {
  await resetTestData();
  await seedBranch(BRANCH, 'Head Office');
  await ownerPool.query(`insert into department (code, name, is_finance) values ('FIN','Finance',true) on conflict do nothing`);
  manager = await userWith('accounting_manager');
  approver = await userWith('accounting_manager');
  await withScope(scope(manager), (tx) =>
    periods.createFiscalYear(tx, manager, { code: 'FY2026', startsOn: '2026-01-01', endsOn: '2026-12-31' }),
  );
  // A journal is valued against the day's rate, so one has to exist before
  // anything can post at all.
  await withScope(scope(manager), (tx) =>
    rates.publishRate(tx, manager, { currency: 'USD', iqdPerUnit: '1310.00000000', effectiveFrom: '2026-01-01' }),
  );

  bankGl = await account('A000001', 'Balance test — bank', 'bank');
  otherBankGl = await account('A000001', 'Balance test — second bank', 'bank');
  equityGl = await account('E000001', 'Balance test — funding');
  plainAssetGl = await account('A000001', 'Balance test — a plain asset');

  const made = await withScope(scope(manager), async (tx) => ({
    first: await banks.create(tx, manager, 'bank', {
      name: 'Current account',
      glAccountId: bankGl,
      currency: 'IQD',
      bankName: 'Rafidain',
      accountNumber: '0011223344',
    }),
    second: await banks.create(tx, manager, 'bank', {
      name: 'Second account',
      glAccountId: otherBankGl,
      currency: 'IQD',
      bankName: 'Rafidain',
      accountNumber: '5566778899',
    }),
  }));
  bankCode = made.first.code;
  otherBankCode = made.second.code;
});

describe('C-20 · a bank account cannot hold less than nothing', () => {
  it('refuses money out of an account that holds none', async () => {
    // A journal entered by hand answers to no service check, which is the
    // whole reason this rule is the database's.
    const why = await rejection(
      post([{ accountId: bankGl, credit: '10000.0000', bankCode }, { accountId: equityGl, debit: '10000.0000' }], 'overdraw'),
    );
    expect(why).toMatch(/cannot hold less than nothing/);
    expect(why).toMatch(/Deposit or draw the money first/);
  });

  it('allows money out once the money is in, down to the last dinar', async () => {
    await post([{ accountId: bankGl, debit: '10000.0000', bankCode }, { accountId: equityGl, credit: '10000.0000' }], 'funding');
    await post([{ accountId: bankGl, credit: '10000.0000', bankCode }, { accountId: equityGl, debit: '10000.0000' }], 'spend it all');

    const { rows } = await ownerPool.query(
      `select coalesce(sum(l.debit_iqd - l.credit_iqd), 0)::text as balance
         from journal_line l join journal_entry e on e.id = l.journal_entry_id
        where l.account_id = $1 and e.status = 'posted'`,
      [bankGl],
    );
    expect(Number(rows[0].balance)).toBe(0);
  });

  it('refuses the dinar after the last one', async () => {
    const why = await rejection(
      post([{ accountId: bankGl, credit: '0.0001', bankCode }, { accountId: equityGl, debit: '0.0001' }], 'one too many'),
    );
    expect(why).toMatch(/cannot hold less than nothing/);
  });

  it('weighs a transfer whole, not line by line', async () => {
    // The credit on the account the money leaves and the debit on the one it
    // reaches are two lines of one journal. Checked eagerly, the credit would
    // be refused before the debit that pays for it is seen.
    await post([{ accountId: bankGl, debit: '5000.0000', bankCode }, { accountId: equityGl, credit: '5000.0000' }], 'fund the first');
    await post(
      [
        { accountId: bankGl, credit: '5000.0000', bankCode },
        { accountId: otherBankGl, debit: '5000.0000', bankCode: otherBankCode },
      ],
      'transfer between our own accounts',
    );

    const { rows } = await ownerPool.query(
      `select coalesce(sum(l.debit_iqd - l.credit_iqd), 0)::text as balance
         from journal_line l join journal_entry e on e.id = l.journal_entry_id
        where l.account_id = $1 and e.status = 'posted'`,
      [otherBankGl],
    );
    expect(Number(rows[0].balance)).toBeGreaterThan(0);
  });

  it('leaves an ordinary asset account alone', async () => {
    // Only a G/L account that a bank or cash account names is subject to
    // this. Receivables, stock and the rest go where the books take them.
    await post(
      [{ accountId: plainAssetGl, credit: '99000.0000' }, { accountId: equityGl, debit: '99000.0000' }],
      'a plain asset may go negative',
    );
    const { rows } = await ownerPool.query(
      `select coalesce(sum(l.debit_iqd - l.credit_iqd), 0)::text as balance
         from journal_line l join journal_entry e on e.id = l.journal_entry_id
        where l.account_id = $1 and e.status = 'posted'`,
      [plainAssetGl],
    );
    expect(Number(rows[0].balance)).toBeLessThan(0);
  });
});
