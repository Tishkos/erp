/**
 * Two things a person asked for after using the system for an afternoon.
 *
 *   1. A journal line is entered in a currency, and the currency follows the
 *      account. A dollar-only account refused every line, because the screen
 *      sent no currency at all and the service defaulted to dinars.
 *   2. A draft can be thrown away. §7 keeps *documents* for ever; a draft is
 *      unfinished typing that nobody has seen, and keeping every abandoned
 *      attempt buries the real entries.
 *
 * The second is the one to be careful about, so most of what follows is about
 * what deletion must *not* reach.
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
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BRANCH = 'HQ';
const YEAR = '2026';
const ON = `${YEAR}-08-16`;
const FROM = `${YEAR}-01-01`;
const TO = `${YEAR}-12-31`;

let manager: ActorContext;
let dinarAccount: string;
let dollarAccount: string;
let capital: string;

const scope = () => ({ userId: manager.principal.userId, branchCode: BRANCH });

/** An account opened, submitted and approved, tied to one currency or none. */
async function account(
  parentCode: string,
  name: string,
  currencyRestriction: string,
): Promise<string> {
  const { rows } = await ownerPool.query(`select id from chart_of_account where code = $1`, [
    parentCode,
  ]);
  const created = await withScope(scope(), (tx) =>
    coa.createAccount(tx, manager, { name, parentId: rows[0].id, currencyRestriction }),
  );
  await withScope(scope(), (tx) => coa.submitForApproval(tx, manager, created.id));
  await withScope(scope(), (tx) => coa.approve(tx, manager, created.id));
  return created.id;
}

async function draft(description = 'Working on it'): Promise<{ id: string; entryNo: string }> {
  return withScope(scope(), (tx) =>
    journal.createDraft(tx, manager, {
      branchCode: BRANCH,
      documentDate: ON,
      postingDate: ON,
      description,
    }),
  );
}

const countOf = async (sql: string, params: unknown[]): Promise<number> =>
  Number((await ownerPool.query<{ n: string }>(sql, params)).rows[0]!.n);

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BRANCH, 'Head Office');
  await ownerPool.query(
    `insert into department (code, name, is_finance) values ('FIN','Finance',true)`,
  );

  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,'Manager')`, [
    id,
    `${id}@example.com`,
  ]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,'accounting_manager')`, [id]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BRANCH]);
  await ownerPool.query(`insert into user_department_scope (user_id, department_code) values ($1,'FIN')`, [id]);
  const principal = await withScope({ userId: id, branchCode: BRANCH }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  manager = { principal, branchCode: BRANCH };

  await withScope(scope(), (tx) =>
    periods.createFiscalYear(tx, manager, { code: `FY${YEAR}`, startsOn: FROM, endsOn: TO }),
  );
  await withScope(scope(), (tx) =>
    rates.publishRate(tx, manager, {
      currency: 'USD',
      iqdPerUnit: '1320.00000000',
      effectiveFrom: FROM,
      source: 'Central Bank of Iraq',
    }),
  );

  dinarAccount = await account('A000001', 'Cash on Hand', 'IQD');
  dollarAccount = await account('A000001', 'Dollar Bank Account', 'USD');
  capital = await account('E000001', 'Share Capital', 'IQD');
});

// ---------------------------------------------------------------------------
describe('a line is entered in a currency', () => {
  it('refuses dinars on a dollar-only account, and says which is which', async () => {
    const entry = await draft();
    const message = await rejection(
      withScope(scope(), (tx) =>
        journal.addLine(tx, manager, entry.id, {
          accountId: dollarAccount,
          debit: '1000.00',
          currency: 'IQD',
          dimensions: { department: 'FIN' },
        }),
      ),
    );
    expect(message).toMatch(/USD/);
    expect(message).toMatch(/IQD/);
  });

  it('takes dollars on a dollar account and values them in both currencies', async () => {
    const entry = await draft();
    await withScope(scope(), (tx) =>
      journal.addLine(tx, manager, entry.id, {
        accountId: dollarAccount,
        debit: '1000.00',
        currency: 'USD',
        dimensions: { department: 'FIN' },
      }),
    );

    const { rows } = await ownerPool.query<{
      currency: string;
      debit_txn: string;
      debit_iqd: string;
      debit_usd: string;
    }>(
      `select currency, debit_txn, debit_iqd, debit_usd from journal_line where journal_entry_id = $1`,
      [entry.id],
    );
    // What was typed is kept as typed; the ledger figure is derived from it.
    expect(rows[0]!.currency).toBe('USD');
    expect(Number(rows[0]!.debit_txn)).toBe(1000);
    expect(Number(rows[0]!.debit_iqd)).toBe(1_320_000);
    expect(Number(rows[0]!.debit_usd)).toBe(1000);
  });

  it('lets one entry hold lines in different currencies, balanced in dinars', async () => {
    // The entry balances in the ledger currency, not line by line — which is
    // the whole reason each line carries its own IQD figure.
    const entry = await draft('Capital paid in dollars');
    await withScope(scope(), (tx) =>
      journal.addLine(tx, manager, entry.id, {
        accountId: dollarAccount,
        debit: '1000.00',
        currency: 'USD',
        dimensions: { department: 'FIN' },
      }),
    );
    await withScope(scope(), (tx) =>
      journal.addLine(tx, manager, entry.id, {
        accountId: capital,
        credit: '1320000.00',
        currency: 'IQD',
        dimensions: { department: 'FIN' },
      }),
    );

    await withScope(scope(), (tx) => journal.submit(tx, manager, entry.id));
    const { rows } = await ownerPool.query<{ status: string }>(
      `select status from journal_entry where id = $1`,
      [entry.id],
    );
    expect(rows[0]!.status).toBe('posted');
  });
});

// ---------------------------------------------------------------------------
describe('a draft can be thrown away', () => {
  it('removes the entry and its lines', async () => {
    const entry = await draft();
    await withScope(scope(), (tx) =>
      journal.addLine(tx, manager, entry.id, {
        accountId: dinarAccount,
        debit: '500.00',
        dimensions: { department: 'FIN' },
      }),
    );

    await withScope(scope(), (tx) => journal.discardDraft(tx, manager, entry.id));

    expect(await countOf(`select count(*) as n from journal_entry where id = $1`, [entry.id])).toBe(0);
    expect(
      await countOf(`select count(*) as n from journal_line where journal_entry_id = $1`, [entry.id]),
    ).toBe(0);
  });

  it('leaves the trail behind, naming the entry that went', async () => {
    // §7's point survives even though the rows do not: the system still knows
    // this entry existed, what it was numbered and who threw it away.
    const entry = await draft();
    await withScope(scope(), (tx) => journal.discardDraft(tx, manager, entry.id));

    const { rows } = await ownerPool.query<{
      before_value: { entryNo: string };
      actor_user_id: string;
    }>(
      `select before_value, actor_user_id from audit_event
        where action = 'journal_entry.discarded' and object_id = $1`,
      [entry.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.before_value.entryNo).toBe(entry.entryNo);
    expect(rows[0]!.actor_user_id).toBe(manager.principal.userId);
  });

  it('does not hand the number to the next entry', async () => {
    // §14.2 — a number is never reused. The gap is the honest record of a
    // draft that was abandoned.
    const first = await draft();
    await withScope(scope(), (tx) => journal.discardDraft(tx, manager, first.id));
    const second = await draft();
    expect(second.entryNo).not.toBe(first.entryNo);
  });

  it('refuses once the entry has been posted', async () => {
    const entry = await draft();
    for (const line of [
      { accountId: dinarAccount, debit: '500.00' },
      { accountId: capital, credit: '500.00' },
    ]) {
      await withScope(scope(), (tx) =>
        journal.addLine(tx, manager, entry.id, { ...line, dimensions: { department: 'FIN' } }),
      );
    }
    await withScope(scope(), (tx) => journal.submit(tx, manager, entry.id));

    const message = await rejection(
      withScope(scope(), (tx) => journal.discardDraft(tx, manager, entry.id)),
    );
    expect(message).toMatch(/not a draft/);
    // And it is still there, which is the part that matters.
    expect(await countOf(`select count(*) as n from journal_entry where id = $1`, [entry.id])).toBe(1);
  });

  it('refuses somebody who may not edit drafts at all', async () => {
    const entry = await draft();
    const strangerId = randomUUID();
    await ownerPool.query(
      `insert into app_user (id, email, display_name) values ($1,$2,'Nobody')`,
      [strangerId, `${strangerId}@example.com`],
    );
    await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
      strangerId,
      BRANCH,
    ]);
    const principal = await withScope({ userId: strangerId, branchCode: BRANCH }, (tx) =>
      authz.loadPrincipal(tx, strangerId),
    );
    const stranger: ActorContext = { principal, branchCode: BRANCH };

    await rejection(
      withScope({ userId: strangerId, branchCode: BRANCH }, (tx) =>
        journal.discardDraft(tx, stranger, entry.id),
      ),
    );
    expect(await countOf(`select count(*) as n from journal_entry where id = $1`, [entry.id])).toBe(1);
  });
});
