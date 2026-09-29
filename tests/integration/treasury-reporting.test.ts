/**
 * Bank and Cash Reporting — §17.
 *
 * The claim worth testing is not that the numbers add up on screen. It is that
 * there is only one set of numbers: the report reads the general ledger, so its
 * closing balance *is* the mapped G/L account's balance rather than a second
 * figure that happens to agree with it today. A report keeping its own store of
 * balances passes every test it writes for itself and is wrong the first week
 * somebody posts a journal it did not expect.
 *
 * The second claim is about transfers. Money moved between two of the company's
 * own accounts must not read as income to one and expense to the other, or a
 * treasury that shuffles its own money looks like a business earning it.
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
import * as treasury from '@/server/services/treasury';
import * as reports from '@/server/services/treasury-reports';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BRANCH = 'HQ';
const FUNDED_ON = '2026-04-10';
const MOVED_ON = '2026-04-20';
const WINDOW = { from: '2026-01-01', to: '2026-12-31' } as const;

let manager: ActorContext;
let approver: ActorContext;
let cashA = '';
let cashB = '';
let equityAccountId = '';

async function userWith(...roles: string[]): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    roles.join('+'),
  ]);
  for (const role of roles) {
    await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  }
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BRANCH]);
  await ownerPool.query(
    `insert into user_department_scope (user_id, department_code) values ($1,'FIN') on conflict do nothing`,
    [id],
  );
  const principal = await withScope({ userId: id, branchCode: BRANCH }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BRANCH };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BRANCH });

/** An approved posting account under a root. Approved by somebody else (§14.4). */
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

/** One posted journal — the only way money legitimately appears in an account. */
async function postJournal(
  on: string,
  description: string,
  lines: readonly { accountId: string; debit?: string; credit?: string; bankAccountCode?: string }[],
): Promise<void> {
  const entry = await withScope(scope(manager), (tx) =>
    journal.createDraft(tx, manager, {
      branchCode: BRANCH,
      documentDate: on,
      postingDate: on,
      description,
    }),
  );
  for (const line of lines) {
    await withScope(scope(manager), (tx) =>
      journal.addLine(tx, manager, entry.id, {
        accountId: line.accountId,
        ...(line.debit ? { debit: line.debit } : {}),
        ...(line.credit ? { credit: line.credit } : {}),
        // A line on a bank control account must say which bank it is against,
        // or the subledger cannot reconcile to it (§1.2).
        ...(line.bankAccountCode ? { bankAccountCode: line.bankAccountCode } : {}),
        dimensions: { department: 'FIN' },
      } as never),
    );
  }
  const outcome = await withScope(scope(manager), (tx) => journal.submit(tx, manager, entry.id));
  // `approve` is what sets `posted`; submitting alone posts only where the
  // workflow asks for no second pair of eyes.
  if (outcome.status !== 'posted') {
    await withScope(scope(approver), (tx) => journal.approve(tx, approver, entry.id));
  }
}

beforeAll(async () => {
  await resetTestData();
  await seedBranch(BRANCH, 'Head Office');
  await ownerPool.query(
    `insert into department (code, name, is_finance) values ('FIN','Finance',true) on conflict do nothing`,
  );
  manager = await userWith('accounting_manager');
  approver = await userWith('accounting_manager');

  // Nothing posts into a year that is not open, and every line is measured in
  // IQD and in USD — so a date with no rate in force refuses the entry.
  await withScope(scope(manager), (tx) =>
    periods.createFiscalYear(tx, manager, { code: 'FY2026', startsOn: '2026-01-01', endsOn: '2026-12-31' }),
  );
  await withScope(scope(manager), (tx) =>
    rates.publishRate(tx, manager, { currency: 'USD', iqdPerUnit: '1310.00000000', effectiveFrom: '2026-01-01' }),
  );

  // Deliberately NOT flagged `control_account = 'bank'`, which is how every
  // cash account on the live books is set up. A flagged account cannot be
  // posted through at all: the subledger asks each line which bank it is
  // against, and `PostingLineRequest` has no field to answer with — so a
  // receipt, a payment or a transfer through such an account refuses. That is
  // a defect in the posting engine, recorded here rather than worked around,
  // and this suite tests the report rather than that.
  const glA = await account('A000001', 'Treasury test — cash A');
  const glB = await account('A000001', 'Treasury test — cash B');
  equityAccountId = await account('E000001', 'Treasury test — funding');

  const made = await withScope(scope(manager), async (tx) => ({
    // §17 — a cash float without a custodian is nobody's responsibility.
    a: await banks.create(tx, manager, 'cash', {
      name: 'Cash A',
      glAccountId: glA,
      currency: 'IQD',
      custodianUserId: manager.principal.userId,
    }),
    b: await banks.create(tx, manager, 'cash', {
      name: 'Cash B',
      glAccountId: glB,
      currency: 'IQD',
      custodianUserId: approver.principal.userId,
    }),
  }));
  cashA = made.a.code;
  cashB = made.b.code;
});

describe('the report reads the ledger rather than keeping its own balances', () => {
  it('lists an account that has never moved, at zero, rather than hiding it', async () => {
    const positions = await withScope(scope(manager), (tx) => reports.positions(tx, manager, WINDOW));
    const a = positions.find((row) => row.accountCode === cashA)!;
    expect(a).toBeDefined();
    expect(Number(a.openingIqd)).toBe(0);
    expect(Number(a.closingIqd)).toBe(0);
    expect(a.lastMovementDate).toBeNull();
    expect(a.currency).toBe('IQD');
  });

  it('closes where treasury.balances says the account stands — the 07.1 identity', async () => {
    const [positions, balances] = await withScope(scope(manager), async (tx) => [
      await reports.positions(tx, manager, WINDOW),
      await treasury.balances(tx, manager, WINDOW.to),
    ]);
    const byCode = new Map(balances.map((row) => [row.accountCode, row.balanceIqd]));

    expect(positions.length).toBeGreaterThan(0);
    for (const position of positions) {
      const ledgerBalance = byCode.get(position.accountCode);
      if (ledgerBalance === undefined) continue;
      expect(Number(position.closingIqd), `${position.accountCode} closing`).toBe(Number(ledgerBalance));
    }
  });
});

describe('a transfer between our own accounts is not income and not expense', () => {
  it('counts it in the transfer columns and leaves money in and out alone', async () => {
    const glA = (await withScope(scope(manager), (tx) => banks.detail(tx, cashA))).glAccountId;
    await postJournal(FUNDED_ON, 'Treasury test — funding', [
      { accountId: glA, debit: '1000.0000' },
      { accountId: equityAccountId, credit: '1000.0000' },
    ]);

    const funded = await withScope(scope(manager), (tx) => reports.positions(tx, manager, WINDOW));
    const beforeA = funded.find((row) => row.accountCode === cashA)!;
    expect(Number(beforeA.moneyInIqd), 'funding is real money in').toBe(1000);
    expect(Number(beforeA.transfersInIqd)).toBe(0);

    await withScope(scope(manager), async (tx) => {
      const from = await banks.get(tx, cashA);
      const to = await banks.get(tx, cashB);
      const transfer = await treasury.createTransfer(tx, manager, {
        fromAccountId: from.id,
        toAccountId: to.id,
        amountIqd: 400n * 10_000n,
        transferDate: MOVED_ON,
      });
      await treasury.approveTransfer(tx, manager, transfer.id);
      await treasury.postTransfer(tx, manager, transfer.id);
    });

    const after = await withScope(scope(manager), (tx) => reports.positions(tx, manager, WINDOW));
    const a = after.find((row) => row.accountCode === cashA)!;
    const b = after.find((row) => row.accountCode === cashB)!;

    // The money moved…
    expect(Number(a.closingIqd)).toBe(600);
    expect(Number(b.closingIqd)).toBe(400);

    // …and it moved as a transfer, on both sides.
    expect(Number(a.transfersOutIqd), 'left A as a transfer').toBe(400);
    expect(Number(b.transfersInIqd), 'arrived in B as a transfer').toBe(400);

    // The whole point: neither side calls it income or expense.
    expect(Number(a.moneyOutIqd), 'A did not spend 400').toBe(0);
    expect(Number(b.moneyInIqd), 'B did not earn 400').toBe(0);
    expect(Number(a.moneyInIqd), 'A keeps only its real funding').toBe(1000);
  });

  it('names the transfer as a transfer on the ledger, and traces every row to its journal', async () => {
    const ledger = await withScope(scope(manager), (tx) => reports.ledger(tx, manager, cashA, WINDOW));
    expect(ledger).not.toBeNull();
    expect(ledger!.lines.map((line) => line.kind)).toContain('transfer_out');

    expect(Number(ledger!.closingIqd)).toBe(600);
    expect(Number(ledger!.lines.at(-1)!.balanceIqd)).toBe(600);
    for (const line of ledger!.lines) {
      expect(line.entryNo, 'every movement names its journal entry').toMatch(/^JE-/);
      expect(line.journalEntryId).toBeTruthy();
    }
  });

  it('opens a window at the balance the period before it closed at', async () => {
    // A window starting after the funding must open at 1,000, not at zero —
    // otherwise choosing a date range would silently restate the account.
    const later = await withScope(scope(manager), (tx) =>
      reports.ledger(tx, manager, cashA, { from: MOVED_ON, to: WINDOW.to }),
    );
    expect(Number(later!.openingIqd)).toBe(1000);
    expect(Number(later!.closingIqd)).toBe(600);
  });
});
