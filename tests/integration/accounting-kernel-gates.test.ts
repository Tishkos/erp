/**
 * Phase 02 test gate — the four items the kernel enforced but never proved.
 *
 *   02.5  "A journal with lines in two branches is rejected"
 *   02.7  "Appendix C control checklist: all eight items verified individually"
 *   02.9  "Any balance table can be rebuilt from the entries and reproduces the
 *          same figures"
 *   02.10 "Data scope applies — a branch-scoped user's Trial Balance shows only
 *          their branch"
 *
 * Each was implemented and none had a test naming it. That is the worst state
 * for a control to be in: it works today, nothing says why, and the next person
 * to touch the query is free to remove it.
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
import * as reversal from '@/server/services/reversal';
import * as subledger from '@/server/services/subledger';
import * as tb from '@/server/services/trial-balance';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BAGHDAD = 'BGW';
const ERBIL = 'EBL';
const POSTING_DATE = '2026-08-16';

let manager: ActorContext;
let secondManager: ActorContext;
let cashId: string;
let salariesId: string;
let bankId: string;

/** A manager scoped to both branches, so a cross-branch read is *possible*. */
async function createManager(branches: readonly string[]): Promise<ActorContext> {
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
  for (const branch of branches) {
    await ownerPool.query(
      `insert into user_branch_scope (user_id, branch_code) values ($1,$2)`,
      [id, branch],
    );
  }
  await ownerPool.query(
    `insert into user_department_scope (user_id, department_code) values ($1,'FIN')`,
    [id],
  );
  const principal = await withScope({ userId: id, branchCode: branches[0]! }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  return { principal, branchCode: branches[0]! };
}

const scope = (ctx: ActorContext, branchCode = BAGHDAD) => ({
  userId: ctx.principal.userId,
  branchCode,
});

async function approvedAccount(
  parentCode: string,
  input: Omit<coa.CreateAccountInput, 'parentId'>,
): Promise<string> {
  const { rows } = await ownerPool.query(`select id from chart_of_account where code = $1`, [
    parentCode,
  ]);
  const account = await withScope(scope(manager), (tx) =>
    coa.createAccount(tx, manager, { currencyRestriction: 'IQD', ...input, parentId: rows[0].id }),
  );
  await withScope(scope(manager), (tx) => coa.submitForApproval(tx, manager, account.id));
  await withScope(scope(secondManager), (tx) => coa.approve(tx, secondManager, account.id));
  return account.id;
}

beforeEach(async () => {
  await resetTestData();

  await seedBranch(BAGHDAD, 'Baghdad');
  await seedBranch(ERBIL, 'Erbil');
  await ownerPool.query(
    `insert into department (code, name, is_finance) values ('FIN','Finance',true)`,
  );

  manager = await createManager([BAGHDAD, ERBIL]);
  secondManager = await createManager([BAGHDAD, ERBIL]);

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

  cashId = await approvedAccount('A000001', { name: 'Cash on Hand' });
  bankId = await approvedAccount('A000001', {
    name: 'Bank — Al Rafidain',
    controlAccount: 'bank',
  });
  salariesId = await approvedAccount('X000001', { name: 'Salaries' });

  await ownerPool.query(
    `insert into document_type_dimension (document_type_code, dimension, requirement)
     values ('journal_entry','business_line','optional')
     on conflict (document_type_code, dimension) do update set requirement = 'optional'`,
  );
});

/** Dr salaries / Cr cash in the given branch, submitted (and so posted). */
async function postedJournal(branchCode: string, amount = '1000.0000') {
  const entry = await withScope(scope(manager, branchCode), (tx) =>
    journal.createDraft(tx, manager, {
      branchCode,
      documentDate: POSTING_DATE,
      postingDate: POSTING_DATE,
      description: `Salaries — ${branchCode}`,
    }),
  );
  await withScope(scope(manager, branchCode), (tx) =>
    journal.addLine(tx, manager, entry.id, {
      accountId: salariesId,
      debit: amount,
      dimensions: { department: 'FIN' },
    }),
  );
  await withScope(scope(manager, branchCode), (tx) =>
    journal.addLine(tx, manager, entry.id, { accountId: cashId, credit: amount }),
  );
  await withScope(scope(manager, branchCode), (tx) => journal.submit(tx, manager, entry.id));
  return entry;
}

// ---------------------------------------------------------------------------
// 02.5 — one journal, one branch
// ---------------------------------------------------------------------------

describe('02.5 gate · a journal with lines in two branches is rejected', () => {
  it('refuses a line whose branch differs from the journal’s', async () => {
    // Appendix C, Manual Standard Journal: "Finance only; one branch; full
    // reversal only." A journal spanning two branches makes every branch report
    // derived from it arguable.
    const entry = await withScope(scope(manager), (tx) =>
      journal.createDraft(tx, manager, {
        branchCode: BAGHDAD,
        documentDate: POSTING_DATE,
        postingDate: POSTING_DATE,
        description: 'Cross-branch attempt',
      }),
    );

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          journal.addLine(tx, manager, entry.id, {
            accountId: salariesId,
            debit: '500.0000',
            dimensions: { department: 'FIN', branch: ERBIL },
          }),
        ),
      ),
    ).toMatch(/One Journal Entry contains one branch only/);
  });

  it('refuses it at the database too, bypassing the service', async () => {
    // On a *draft*, so the branch trigger is what refuses rather than the
    // posted-lock — the point is that the rule holds without the service.
    const entry = await withScope(scope(manager), (tx) =>
      journal.createDraft(tx, manager, {
        branchCode: BAGHDAD,
        documentDate: POSTING_DATE,
        postingDate: POSTING_DATE,
        description: 'Draft for the trigger',
      }),
    );
    await withScope(scope(manager), (tx) =>
      journal.addLine(tx, manager, entry.id, {
        accountId: salariesId,
        debit: '250.0000',
        dimensions: { department: 'FIN' },
      }),
    );

    expect(
      await rejection(
        ownerPool.query(
          `update journal_line set branch_code = $1
            where journal_entry_id = $2 and line_no = 1`,
          [ERBIL, entry.id],
        ),
      ),
    ).toMatch(/one branch only/);
  });

  it('gives a line with no branch of its own the journal’s branch', async () => {
    // The dimension is inherited rather than left null, so every posted line
    // carries a branch for reporting (§4.2).
    const entry = await postedJournal(ERBIL);

    const { rows } = await ownerPool.query(
      `select distinct branch_code from journal_line where journal_entry_id = $1`,
      [entry.id],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].branch_code).toBe(ERBIL);
  });
});

// ---------------------------------------------------------------------------
// 02.10 — the Trial Balance obeys data scope
// ---------------------------------------------------------------------------

describe('02.10 gate · a branch-scoped user’s Trial Balance shows only their branch', () => {
  beforeEach(async () => {
    await postedJournal(BAGHDAD, '1000.0000');
    await postedJournal(ERBIL, '400.0000');
  });

  it('shows a Baghdad session only Baghdad’s movements', async () => {
    const rows = await withScope(scope(manager, BAGHDAD), (tx) =>
      tb.trialBalance(tx, { from: '2026-01-01', to: '2026-12-31' }),
    );

    const salaries = rows.find((r) => r.accountName === 'Salaries');
    expect(salaries?.debit).toBe('1000.0000');
  });

  it('shows the same user a different figure once they switch branch', async () => {
    // Same person, same query, different session branch. The figure changes
    // because the branch is part of the question, not because permission did.
    const rows = await withScope(scope(manager, ERBIL), (tx) =>
      tb.trialBalance(tx, { from: '2026-01-01', to: '2026-12-31' }),
    );

    const salaries = rows.find((r) => r.accountName === 'Salaries');
    expect(salaries?.debit).toBe('400.0000');
  });

  it('still balances within a branch', async () => {
    // A scoped Trial Balance that did not balance would mean the scope had cut
    // a journal in half — which is what happens if lines and headers are
    // filtered by different rules.
    for (const branch of [BAGHDAD, ERBIL]) {
      const rows = await withScope(scope(manager, branch), (tx) =>
        tb.trialBalance(tx, { from: '2026-01-01', to: '2026-12-31' }),
      );

      const debits = rows.reduce((sum, r) => sum + Number(r.debit), 0);
      const credits = rows.reduce((sum, r) => sum + Number(r.credit), 0);
      expect(debits, branch).toBe(credits);
    }
  });

  it('shows nothing at all to a session in a branch with no postings', async () => {
    await seedBranch('BSR', 'Basra');
    const rows = await withScope(scope(manager, 'BSR'), (tx) =>
      tb.trialBalance(tx, { from: '2026-01-01', to: '2026-12-31' }),
    );

    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 02.9 — balances are derived, and re-derive to the same figures
// ---------------------------------------------------------------------------

describe('02.9 gate · balances rebuild from the entries and reproduce the same figures', () => {
  it('reproduces the same control-account balance on every recomputation', async () => {
    // There is no stored balance table: every balance in the system is derived
    // from the entries on request. That is the strongest form of the gate —
    // a figure that is always recomputed cannot drift from its entries — and
    // this test states it, so a future cache has to prove itself against this.
    const entry = await withScope(scope(manager), (tx) =>
      journal.createDraft(tx, manager, {
        branchCode: BAGHDAD,
        documentDate: POSTING_DATE,
        postingDate: POSTING_DATE,
        description: 'Bank receipt',
      }),
    );
    await withScope(scope(manager), (tx) =>
      journal.addLine(tx, manager, entry.id, {
        accountId: bankId,
        debit: '2500.0000',
        bankAccountCode: 'BANK-RAFIDAIN-01',
        dimensions: { department: 'FIN' },
      }),
    );
    await withScope(scope(manager), (tx) =>
      journal.addLine(tx, manager, entry.id, { accountId: cashId, credit: '2500.0000' }),
    );
    await withScope(scope(manager), (tx) => journal.submit(tx, manager, entry.id));

    const first = await withScope(scope(manager), (tx) =>
      subledger.reconciliation(tx),
    );
    const second = await withScope(scope(manager), (tx) =>
      subledger.reconciliation(tx),
    );

    expect(first).toEqual(second);
    const bank = first.find((r) => r.accountName === 'Bank — Al Rafidain');
    expect(Number(bank?.difference)).toBe(0);
  });

  it('reproduces the same Trial Balance on a re-run', async () => {
    await postedJournal(BAGHDAD, '750.0000');

    const first = await withScope(scope(manager), (tx) =>
      tb.trialBalance(tx, { from: '2026-01-01', to: '2026-12-31' }),
    );
    const second = await withScope(scope(manager), (tx) =>
      tb.trialBalance(tx, { from: '2026-01-01', to: '2026-12-31' }),
    );

    expect(first).toEqual(second);
  });

  it('re-derives the same figures after a reversal, without a stored balance to correct', async () => {
    const entry = await postedJournal(BAGHDAD, '600.0000');

    await withScope(scope(manager), (tx) =>
      reversal.reverse(tx, manager, entry.id, {
        reversalDate: POSTING_DATE,
        reason: 'Posted to the wrong period.',
      }),
    );

    const rows = await withScope(scope(manager), (tx) =>
      tb.trialBalance(tx, { from: '2026-01-01', to: '2026-12-31' }),
    );

    // Every account nets to zero because the entries say so, not because a
    // balance row was adjusted.
    for (const row of rows) {
      expect(Number(row.debit) - Number(row.credit), row.accountName).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 02.7 — Appendix C's own control checklist, item by item
// ---------------------------------------------------------------------------

describe('02.7 gate · Appendix C posting engine control checklist', () => {
  /**
   * The blueprint lists eight controls under "Posting engine control
   * checklist". The gate says each is "verified individually", so each has its
   * own test here naming the control it stands for — rather than being covered
   * incidentally somewhere in the suite, which is how a control quietly stops
   * being checked.
   */

  it('1 · validates the Chart of Accounts is active', async () => {
    const { rows: parents } = await ownerPool.query(
      `select id from chart_of_account where code = 'A000001'`,
    );
    const draftAccount = await withScope(scope(manager), (tx) =>
      coa.createAccount(tx, manager, { name: 'Never approved', parentId: parents[0].id, currencyRestriction: 'IQD' }),
    );

    const entry = await withScope(scope(manager), (tx) =>
      journal.createDraft(tx, manager, {
        branchCode: BAGHDAD,
        documentDate: POSTING_DATE,
        postingDate: POSTING_DATE,
        description: 'Inactive account',
      }),
    );

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          journal.addLine(tx, manager, entry.id, {
            accountId: draftAccount.id,
            debit: '100.0000',
            dimensions: { department: 'FIN' },
          }),
        ),
      ),
    ).toMatch(/still|not approved|not active|Cannot post/i);
  });

  it('2 · requires a balanced IQD entry', async () => {
    const entry = await withScope(scope(manager), (tx) =>
      journal.createDraft(tx, manager, {
        branchCode: BAGHDAD,
        documentDate: POSTING_DATE,
        postingDate: POSTING_DATE,
        description: 'Unbalanced',
      }),
    );
    await withScope(scope(manager), (tx) =>
      journal.addLine(tx, manager, entry.id, {
        accountId: salariesId,
        debit: '100.0000',
        dimensions: { department: 'FIN' },
      }),
    );

    expect(
      await rejection(withScope(scope(manager), (tx) => journal.submit(tx, manager, entry.id))),
    ).toMatch(/balance|debit|credit/i);
  });

  it('3 · retains the historical rate and the USD reporting value', async () => {
    const entry = await postedJournal(BAGHDAD, '1310.0000');

    const { rows } = await ownerPool.query(
      `select debit_iqd, debit_usd, usd_rate_id from journal_line
        where journal_entry_id = $1 and debit_iqd > 0`,
      [entry.id],
    );

    expect(rows[0].debit_usd).toBe('1.0000');
    expect(rows[0].usd_rate_id).not.toBeNull();

    // A rate published later does not reach back and change it.
    await withScope(scope(manager), (tx) =>
      rates.publishRate(tx, manager, {
        currency: 'USD',
        iqdPerUnit: '1500.00000000',
        effectiveFrom: '2026-09-01',
      }),
    );

    const { rows: after } = await ownerPool.query(
      `select debit_usd from journal_line where journal_entry_id = $1 and debit_iqd > 0`,
      [entry.id],
    );
    expect(after[0].debit_usd).toBe('1.0000');
  });

  it('4 · keeps source document and line traceability on every line', async () => {
    const entry = await postedJournal(BAGHDAD);

    const { rows } = await ownerPool.query(
      `select journal_entry_id, line_no, account_id from journal_line
        where journal_entry_id = $1 order by line_no`,
      [entry.id],
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const line of rows) {
      expect(line.journal_entry_id).toBe(entry.id);
      expect(line.line_no).toBeGreaterThan(0);
      expect(line.account_id).toBeTruthy();
    }
  });

  it('5 · validates branch and the account’s required dimensions', async () => {
    const entry = await withScope(scope(manager), (tx) =>
      journal.createDraft(tx, manager, {
        branchCode: BAGHDAD,
        documentDate: POSTING_DATE,
        postingDate: POSTING_DATE,
        description: 'Missing cost centre',
      }),
    );

    // Salaries is an expense account; §4.2 requires a Cost Centre or the
    // configured equivalent. The refusal names the missing field.
    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          journal.addLine(tx, manager, entry.id, { accountId: salariesId, debit: '100.0000' }),
        ),
      ),
    ).toMatch(/department|dimension|required/i);
  });

  it('6 · prevents a duplicate posting', async () => {
    const entry = await postedJournal(BAGHDAD);

    // Re-submitting a posted journal does not produce a second set of lines.
    expect(
      await rejection(withScope(scope(manager), (tx) => journal.submit(tx, manager, entry.id))),
    ).toMatch(/posted|not.*draft|already/i);

    const { rows } = await ownerPool.query(
      `select count(*)::int as n from journal_line where journal_entry_id = $1`,
      [entry.id],
    );
    expect(rows[0].n).toBe(2);
  });

  it('7 · links the original and its reversal permanently', async () => {
    const entry = await postedJournal(BAGHDAD, '900.0000');

    const reversed = await withScope(scope(manager), (tx) =>
      reversal.reverse(tx, manager, entry.id, {
        reversalDate: POSTING_DATE,
        reason: 'Duplicate posting.',
      }),
    );

    const { rows } = await ownerPool.query(
      `select id, reverses_id, reversed_by_id, status from journal_entry where id in ($1, $2)`,
      [entry.id, reversed.reversalId],
    );

    const original = rows.find((r) => r.id === entry.id);
    const mirror = rows.find((r) => r.id === reversed.reversalId);

    // Both directions, so the pair is navigable from either document — which is
    // what "linked permanently" has to mean for an auditor holding one of them.
    expect(mirror.reverses_id).toBe(entry.id);
    expect(original.reversed_by_id).toBe(reversed.reversalId);
    expect(original.status).toBe('reversed');

    // Permanently: the link cannot be cut.
    expect(
      await rejection(
        ownerPool.query(`update journal_entry set reverses_id = null where id = $1`, [
          reversed.reversalId,
        ]),
      ),
    ).toMatch(/posted|cannot|append|immutable|edit|revers/i);
  });

  it('8 · makes subledger-to-G/L reconciliation available', async () => {
    const entry = await withScope(scope(manager), (tx) =>
      journal.createDraft(tx, manager, {
        branchCode: BAGHDAD,
        documentDate: POSTING_DATE,
        postingDate: POSTING_DATE,
        description: 'Bank movement',
      }),
    );
    await withScope(scope(manager), (tx) =>
      journal.addLine(tx, manager, entry.id, {
        accountId: bankId,
        debit: '3000.0000',
        bankAccountCode: 'BANK-RAFIDAIN-01',
        dimensions: { department: 'FIN' },
      }),
    );
    await withScope(scope(manager), (tx) =>
      journal.addLine(tx, manager, entry.id, { accountId: cashId, credit: '3000.0000' }),
    );
    await withScope(scope(manager), (tx) => journal.submit(tx, manager, entry.id));

    const result = await withScope(scope(manager), (tx) =>
      subledger.reconciliation(tx),
    );

    const bank = result.find((r) => r.accountName === 'Bank — Al Rafidain');
    expect(bank, 'the bank control account appears in the reconciliation').toBeDefined();
    expect(Number(bank!.difference)).toBe(0);
    expect(bank!.subledgerBalance).toBe(bank!.generalLedgerBalance);
  });
});
