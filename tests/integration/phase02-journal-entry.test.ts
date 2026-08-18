/**
 * Phase 02.5 and 02.6 — Journal Entry, against a real PostgreSQL instance.
 *
 * The first document in the system that posts. Everything built so far meets
 * here, so these tests are as much about the seams as about the journal: a
 * number from 01.5, a date checked against 02.2, a rate from 02.3, dimensions
 * from 02.4, an account from 02.1, an approval route from 01.7.
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
import * as workflow from '@/server/services/workflow';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { JournalUnbalancedError, NotFinanceDepartmentError } from '@domain/journal';
import { PeriodClosedError } from '@domain/periods';
import { PermissionDeniedError } from '@domain/permissions';
import { AccountPostingError } from '@domain/chart-of-accounts';
import { MissingDimensionsError } from '@domain/dimensions';
import { RateNotEditableError } from '@domain/exchange-rates';

const BAGHDAD = 'BGW';
const BASRA = 'BSR';
const POSTING_DATE = '2026-08-16';

let officer: ActorContext;
let manager: ActorContext;
let cashAccountId: string;
let salariesAccountId: string;
let salariesUsdAccountId: string;
let payablesAccountId: string;

async function createUser(roleCode: string, opts: { finance?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    'Test User',
  ]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [
    id,
    roleCode,
  ]);
  await ownerPool.query(
    `insert into user_branch_scope (user_id, branch_code) values ($1,$2), ($1,$3)`,
    [id, BAGHDAD, BASRA],
  );
  await ownerPool.query(
    `insert into user_department_scope (user_id, department_code) values ($1,$2)`,
    [id, opts.finance === false ? 'SLS' : 'FIN'],
  );
  return id;
}

async function contextFor(userId: string): Promise<ActorContext> {
  const principal = await withScope({ userId, branchCode: BAGHDAD }, (tx) =>
    authz.loadPrincipal(tx, userId),
  );
  return { principal, branchCode: BAGHDAD };
}

const scopeOf = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });

async function approvedAccount(
  parentCode: string,
  input: Omit<coa.CreateAccountInput, 'parentId'>,
): Promise<string> {
  const { rows } = await ownerPool.query(`select id from chart_of_account where code = $1`, [
    parentCode,
  ]);
  const account = await withScope(scopeOf(officer), (tx) =>
    coa.createAccount(tx, officer, { currencyRestriction: 'IQD', ...input, parentId: rows[0].id }),
  );
  await withScope(scopeOf(officer), (tx) => coa.submitForApproval(tx, officer, account.id));
  await withScope(scopeOf(manager), (tx) => coa.approve(tx, manager, account.id));
  return account.id;
}

beforeEach(async () => {
  await resetTestData();

  await seedBranch(BAGHDAD, 'Baghdad');
  await seedBranch(BASRA, 'Basra');
  await ownerPool.query(
    `insert into department (code, name, is_finance) values ('FIN','Finance',true), ('SLS','Sales',false)`,
  );

  officer = await contextFor(await createUser('accounting_officer'));
  manager = await contextFor(await createUser('accounting_manager'));

  await withScope(scopeOf(manager), (tx) =>
    periods.createFiscalYear(tx, manager, {
      code: 'FY2026',
      startsOn: '2026-01-01',
      endsOn: '2026-12-31',
    }),
  );

  await withScope(scopeOf(manager), (tx) =>
    rates.publishRate(tx, manager, {
      currency: 'USD',
      iqdPerUnit: '1310.00000000',
      effectiveFrom: '2026-01-01',
      source: 'Central Bank of Iraq',
    }),
  );

  cashAccountId = await approvedAccount('A000001', { name: 'Cash on Hand' });
  payablesAccountId = await approvedAccount('L000001', {
    name: 'Trade Payables',
    controlAccount: 'supplier',
  });
  salariesAccountId = await approvedAccount('X000001', { name: 'Salaries' });
  // D7 (2026-08-17) — an account holds one currency, so the dollar salaries are
  // a second account rather than a second currency on the first. This is the
  // consequence the decision accepts: the chart grows sideways.
  salariesUsdAccountId = await approvedAccount('X000001', {
    name: 'Salaries — USD',
    currencyRestriction: 'USD',
  });

  // §4.2 makes Business Line mandatory for expense accounts, and its master
  // does not exist until Phase 03 — so a journal touching an expense account
  // could not be posted at all yet. Relaxed for this document type using the
  // 02.4 override, which is exactly the mechanism it exists for. The
  // requirement itself is proved in the 02.4 tests.
  await ownerPool.query(
    `insert into document_type_dimension (document_type_code, dimension, requirement)
     values ('journal_entry', 'business_line', 'optional')
     on conflict (document_type_code, dimension) do update set requirement = 'optional'`,
  );
});

/** A balanced two-line journal in IQD, left as a draft. */
async function draftJournal(
  ctx: ActorContext,
  overrides: Partial<journal.CreateJournalInput> = {},
): Promise<{ id: string; entryNo: string }> {
  const entry = await withScope(scopeOf(ctx), (tx) =>
    journal.createDraft(tx, ctx, {
      branchCode: BAGHDAD,
      documentDate: POSTING_DATE,
      postingDate: POSTING_DATE,
      description: 'Petty cash top-up',
      ...overrides,
    }),
  );

  await withScope(scopeOf(ctx), (tx) =>
    journal.addLine(tx, ctx, entry.id, {
      accountId: salariesAccountId,
      debit: '1000.0000',
      dimensions: { department: 'FIN' },
    }),
  );
  await withScope(scopeOf(ctx), (tx) =>
    journal.addLine(tx, ctx, entry.id, { accountId: cashAccountId, credit: '1000.0000' }),
  );

  return entry;
}

// ---------------------------------------------------------------------------
describe('02.5 · raising a journal', () => {
  it('numbers it automatically, by the posting date’s year', async () => {
    const entry = await draftJournal(officer);
    expect(entry.entryNo).toBe('JE-2026-000001');

    const second = await draftJournal(officer);
    expect(second.entryNo).toBe('JE-2026-000002');
  });

  it('resolves the fiscal period at creation', async () => {
    const entry = await draftJournal(officer);
    const { rows } = await ownerPool.query(
      `select p.name from journal_entry e join fiscal_period p on p.id = e.fiscal_period_id
        where e.id = $1`,
      [entry.id],
    );
    expect(rows[0].name).toBe('August 2026');
  });

  it('keeps the running totals on the header', async () => {
    const entry = await draftJournal(officer);
    const { rows } = await ownerPool.query(
      `select total_debit_iqd, total_credit_iqd from journal_entry where id = $1`,
      [entry.id],
    );
    expect(rows[0].total_debit_iqd).toBe('1000.0000');
    expect(rows[0].total_credit_iqd).toBe('1000.0000');
  });

  it('refuses a user outside the Finance Department (§14)', async () => {
    const salesperson = await contextFor(
      await createUser('accounting_officer', { finance: false }),
    );

    await expect(
      withScope(scopeOf(salesperson), (tx) =>
        journal.createDraft(tx, salesperson, {
          branchCode: BAGHDAD,
          documentDate: POSTING_DATE,
          postingDate: POSTING_DATE,
        }),
      ),
    ).rejects.toThrow(NotFinanceDepartmentError);
  });

  it('refuses a posting date the calendar does not cover', async () => {
    await expect(
      withScope(scopeOf(officer), (tx) =>
        journal.createDraft(tx, officer, {
          branchCode: BAGHDAD,
          documentDate: '2027-03-01',
          postingDate: '2027-03-01',
        }),
      ),
    ).rejects.toThrow(/No fiscal period covers 2027-03-01/);
  });
});

describe('02.5 · lines', () => {
  it('derives the IQD and USD figures from the posting date’s rate', async () => {
    const entry = await withScope(scopeOf(officer), (tx) =>
      journal.createDraft(tx, officer, {
        branchCode: BAGHDAD,
        documentDate: POSTING_DATE,
        postingDate: POSTING_DATE,
      }),
    );

    await withScope(scopeOf(officer), (tx) =>
      journal.addLine(tx, officer, entry.id, {
        accountId: salariesUsdAccountId,
        debit: '100.0000',
        currency: 'USD',
        dimensions: { department: 'FIN' },
      }),
    );

    const { rows } = await ownerPool.query(
      `select debit_txn, currency, debit_iqd, debit_usd, txn_rate_id, usd_rate_id
         from journal_line where journal_entry_id = $1`,
      [entry.id],
    );

    expect(rows[0].debit_txn).toBe('100.0000');
    expect(rows[0].currency).toBe('USD');
    expect(rows[0].debit_iqd).toBe('131000.0000');
    expect(rows[0].debit_usd).toBe('100.0000');
    // §22 — the rate rows are kept, so a reprint reproduces.
    expect(rows[0].txn_rate_id).not.toBeNull();
    expect(rows[0].usd_rate_id).not.toBeNull();
  });

  it('refuses a rate supplied on the line (§14.3)', async () => {
    const entry = await draftJournal(officer);

    await expect(
      withScope(scopeOf(officer), (tx) =>
        journal.addLine(tx, officer, entry.id, {
          accountId: cashAccountId,
          debit: '100.0000',
          // A caller trying to set the rate by hand.
          exchangeRate: '1500',
        } as never),
      ),
    ).rejects.toThrow(RateNotEditableError);
  });

  it('refuses an account that is not approved and active', async () => {
    const { rows: roots } = await ownerPool.query(
      `select id from chart_of_account where code = 'A000001'`,
    );
    const draftAccount = await withScope(scopeOf(officer), (tx) =>
      coa.createAccount(tx, officer, { name: 'Unapproved', parentId: roots[0].id, currencyRestriction: 'IQD' }),
    );
    const entry = await draftJournal(officer);

    await expect(
      withScope(scopeOf(officer), (tx) =>
        journal.addLine(tx, officer, entry.id, {
          accountId: draftAccount.id,
          debit: '100.0000',
        }),
      ),
    ).rejects.toThrow(AccountPostingError);
  });

  it('refuses a group account', async () => {
    const { rows } = await ownerPool.query(
      `select id from chart_of_account where code = 'A000001'`,
    );
    const entry = await draftJournal(officer);

    await expect(
      withScope(scopeOf(officer), (tx) =>
        journal.addLine(tx, officer, entry.id, { accountId: rows[0].id, debit: '100.0000' }),
      ),
    ).rejects.toThrow(/it is a group account/);
  });

  it('refuses an Officer posting manually to a control account (§14.3)', async () => {
    const entry = await draftJournal(officer);

    await expect(
      withScope(scopeOf(officer), (tx) =>
        journal.addLine(tx, officer, entry.id, {
          accountId: payablesAccountId,
          credit: '100.0000',
        }),
      ),
    ).rejects.toThrow(/requires Finance Manager approval/);
  });

  it('allows the Accounting Manager to post manually to a control account', async () => {
    const entry = await draftJournal(manager);

    await expect(
      withScope(scopeOf(manager), (tx) =>
        journal.addLine(tx, manager, entry.id, {
          accountId: payablesAccountId,
          credit: '100.0000',
        }),
      ),
    ).resolves.toMatchObject({ lineNo: 3 });
  });

  it('refuses a line missing a required dimension (§4.2)', async () => {
    // D7 — a rule lives on an account that declares its own; the group above
    // this one declares nothing, so the account has to.
    await ownerPool.query(`update chart_of_account set declares_dimensions = true where id = $1`, [
      cashAccountId,
    ]);
    await ownerPool.query(
      `insert into account_required_dimension (account_id, dimension) values ($1,'department')`,
      [cashAccountId],
    );
    const entry = await withScope(scopeOf(officer), (tx) =>
      journal.createDraft(tx, officer, {
        branchCode: BAGHDAD,
        documentDate: POSTING_DATE,
        postingDate: POSTING_DATE,
      }),
    );

    await expect(
      withScope(scopeOf(officer), (tx) =>
        journal.addLine(tx, officer, entry.id, { accountId: cashAccountId, debit: '100.0000' }),
      ),
    ).rejects.toThrow(MissingDimensionsError);
  });

  it('holds a large money value at four decimal places without loss (A4)', async () => {
    // Carried over from the Phase 00 stack spike, now asserted against the
    // table that actually holds money. numeric(19,4) via the money_amount
    // domain: thirteen integer digits and four decimals, exact.
    const big = '1234567890123.4567';
    const entry = await withScope(scopeOf(officer), (tx) =>
      journal.createDraft(tx, officer, {
        branchCode: BAGHDAD,
        documentDate: POSTING_DATE,
        postingDate: POSTING_DATE,
      }),
    );
    await withScope(scopeOf(officer), (tx) =>
      journal.addLine(tx, officer, entry.id, {
        accountId: salariesAccountId,
        debit: big,
        dimensions: { department: 'FIN' },
      }),
    );
    await withScope(scopeOf(officer), (tx) =>
      journal.addLine(tx, officer, entry.id, { accountId: cashAccountId, credit: big }),
    );

    const { rows } = await ownerPool.query(
      `select debit_iqd, credit_iqd, total_debit_iqd from journal_line
         join journal_entry on journal_entry.id = journal_line.journal_entry_id
        where journal_entry_id = $1 order by line_no`,
      [entry.id],
    );
    expect(rows[0].debit_iqd).toBe(big);
    expect(rows[1].credit_iqd).toBe(big);
    expect(rows[0].total_debit_iqd).toBe(big);
  });

  it('stores money on the named domain, so no column can invent its own precision', async () => {
    const { rows } = await ownerPool.query(
      `select column_name, domain_name from information_schema.columns
        where table_name = 'journal_line' and column_name like '%_iqd'`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.domain_name, row.column_name).toBe('money_amount');
    }
  });

  it('inherits the header branch onto every line (§14.3)', async () => {
    const entry = await draftJournal(officer);
    const { rows } = await ownerPool.query(
      `select distinct branch_code from journal_line where journal_entry_id = $1`,
      [entry.id],
    );
    expect(rows).toEqual([{ branch_code: BAGHDAD }]);
  });

  it('refuses a line in a second branch, at the database (§14.3)', async () => {
    const entry = await draftJournal(officer);

    const message = await rejection(
      ownerPool.query(
        `insert into journal_line
           (journal_entry_id, line_no, account_id, debit_txn, currency, debit_iqd, branch_code)
         values ($1, 9, $2, 100, 'IQD', 100, $3)`,
        [entry.id, cashAccountId, BASRA],
      ),
    );
    expect(message).toMatch(/One Journal Entry can contain one branch only/);
  });
});

// ---------------------------------------------------------------------------
describe('02.5 · balancing is a database guarantee', () => {
  it('refuses to submit an unbalanced journal, in the application', async () => {
    const entry = await withScope(scopeOf(officer), (tx) =>
      journal.createDraft(tx, officer, {
        branchCode: BAGHDAD,
        documentDate: POSTING_DATE,
        postingDate: POSTING_DATE,
      }),
    );
    await withScope(scopeOf(officer), (tx) =>
      journal.addLine(tx, officer, entry.id, {
        accountId: salariesAccountId,
        debit: '1000.0000',
        dimensions: { department: 'FIN' },
      }),
    );
    await withScope(scopeOf(officer), (tx) =>
      journal.addLine(tx, officer, entry.id, { accountId: cashAccountId, credit: '999.0000' }),
    );

    await expect(
      withScope(scopeOf(officer), (tx) => journal.submit(tx, officer, entry.id)),
    ).rejects.toThrow(JournalUnbalancedError);
  });

  it('refuses an unbalanced journal at the database, bypassing the service entirely', async () => {
    // 02.5 gate: "enforced as a database constraint, not only in application
    // code." Straight SQL, no service, no validation — the deferred constraint
    // fires at COMMIT.
    const entry = await draftJournal(officer);

    const message = await rejection(
      ownerPool.query(`
        begin;
        delete from journal_line where journal_entry_id = '${entry.id}' and line_no = 2;
        update journal_entry set status = 'submitted' where id = '${entry.id}';
        commit;
      `),
    );
    expect(message).toMatch(/does not balance in IQD|needs at least two/);
  });

  it('lets a draft be unbalanced while it is being typed', async () => {
    // Refusing to save a half-typed journal would be a worse system. The rule
    // bites at submission, which is when the entry claims to be finished.
    const entry = await withScope(scopeOf(officer), (tx) =>
      journal.createDraft(tx, officer, {
        branchCode: BAGHDAD,
        documentDate: POSTING_DATE,
        postingDate: POSTING_DATE,
      }),
    );

    await expect(
      withScope(scopeOf(officer), (tx) =>
        journal.addLine(tx, officer, entry.id, { accountId: cashAccountId, debit: '1000.0000' }),
      ),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
describe('02.6 · approval posts, and posting locks (§14.4)', () => {
  it('routes an Officer’s journal to the Manager rather than posting it', async () => {
    const entry = await draftJournal(officer);

    const result = await withScope(scopeOf(officer), (tx) =>
      journal.submit(tx, officer, entry.id),
    );

    expect(result.status).toBe('submitted');
    const header = await withScope(scopeOf(officer), (tx) => journal.loadHeader(tx, entry.id));
    expect(header.status).toBe('submitted');
    expect(header.postedAt).toBeNull();
  });

  it('posts a Manager’s own journal directly (§14.4)', async () => {
    const entry = await draftJournal(manager);

    const result = await withScope(scopeOf(manager), (tx) =>
      journal.submit(tx, manager, entry.id),
    );

    expect(result.status).toBe('posted');
    const header = await withScope(scopeOf(manager), (tx) => journal.loadHeader(tx, entry.id));
    expect(header.postedAt).not.toBeNull();
    expect(header.approvedBy).toBe(manager.principal.userId);
  });

  it('posts on approval, in the same act — no approved-but-unposted state', async () => {
    const entry = await draftJournal(officer);
    await withScope(scopeOf(officer), (tx) => journal.submit(tx, officer, entry.id));

    await withScope(scopeOf(manager), (tx) => journal.approve(tx, manager, entry.id));

    const header = await withScope(scopeOf(manager), (tx) => journal.loadHeader(tx, entry.id));
    expect(header.status).toBe('posted');
    expect(header.postedAt).not.toBeNull();
  });

  it('refuses an Officer approving a journal', async () => {
    const entry = await draftJournal(officer);
    await withScope(scopeOf(officer), (tx) => journal.submit(tx, officer, entry.id));

    await expect(
      withScope(scopeOf(officer), (tx) => journal.approve(tx, officer, entry.id)),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it('records the rejection with its reason and returns the journal', async () => {
    const entry = await draftJournal(officer);
    await withScope(scopeOf(officer), (tx) => journal.submit(tx, officer, entry.id));

    await withScope(scopeOf(manager), (tx) =>
      journal.reject(tx, manager, entry.id, 'Wrong cost centre on line 1'),
    );

    const header = await withScope(scopeOf(officer), (tx) => journal.loadHeader(tx, entry.id));
    expect(header.status).toBe('rejected');

    const history = await withScope(scopeOf(officer), (tx) =>
      workflow.historyFor(tx, journal.DOCUMENT_TYPE, entry.id),
    );
    expect(history[0]).toMatchObject({
      decision: 'rejected',
      reason: 'Wrong cost centre on line 1',
    });
  });

  it('refuses to edit a posted journal (§14.4)', async () => {
    const entry = await draftJournal(manager);
    await withScope(scopeOf(manager), (tx) => journal.submit(tx, manager, entry.id));

    const headerMessage = await rejection(
      ownerPool.query(`update journal_entry set description = 'changed' where id = $1`, [entry.id]),
    );
    expect(headerMessage).toMatch(/is posted and cannot be edited/);

    const lineMessage = await rejection(
      ownerPool.query(`update journal_line set debit_iqd = 5 where journal_entry_id = $1`, [
        entry.id,
      ]),
    );
    expect(lineMessage).toMatch(/is posted; its lines cannot be update/);
  });

  it('refuses to delete a posted journal, header or line (§14.4, §1.1)', async () => {
    const entry = await draftJournal(manager);
    await withScope(scopeOf(manager), (tx) => journal.submit(tx, manager, entry.id));

    expect(
      await rejection(ownerPool.query(`delete from journal_entry where id = $1`, [entry.id])),
    ).toMatch(/is posted and cannot be deleted/);

    expect(
      await rejection(
        ownerPool.query(`delete from journal_line where journal_entry_id = $1`, [entry.id]),
      ),
    ).toMatch(/its lines cannot be delete/);
  });

  it('refuses to add a line to a posted journal', async () => {
    const entry = await draftJournal(manager);
    await withScope(scopeOf(manager), (tx) => journal.submit(tx, manager, entry.id));

    await expect(
      withScope(scopeOf(manager), (tx) =>
        journal.addLine(tx, manager, entry.id, { accountId: cashAccountId, debit: '5.0000' }),
      ),
    ).rejects.toThrow(/can no longer be changed/);
  });

  it('audits creation, submission and posting', async () => {
    const entry = await draftJournal(officer);
    await withScope(scopeOf(officer), (tx) => journal.submit(tx, officer, entry.id));
    await withScope(scopeOf(manager), (tx) => journal.approve(tx, manager, entry.id));

    const { rows } = await ownerPool.query(
      `select action, actor_user_id from audit_event where object_id = $1 order by id`,
      [entry.id],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'journal_entry.created',
      'journal_entry.submitted',
      'journal_entry.posted',
    ]);
    expect(rows[2].actor_user_id).toBe(manager.principal.userId);
  });
});

// ---------------------------------------------------------------------------
describe('02.6 · the period gate applies at posting', () => {
  it('refuses an Officer submitting into a soft-closed period', async () => {
    const { rows } = await ownerPool.query(
      `select id from fiscal_period where name = 'August 2026'`,
    );
    const entry = await draftJournal(officer);

    await withScope(scopeOf(manager), (tx) =>
      periods.setPeriodStatus(tx, manager, rows[0].id, 'soft_closed', 'Month-end close'),
    );

    await expect(
      withScope(scopeOf(officer), (tx) => journal.submit(tx, officer, entry.id)),
    ).rejects.toThrow(PeriodClosedError);
  });

  it('lets the Manager post an approved adjustment, and logs the override', async () => {
    const { rows } = await ownerPool.query(
      `select id from fiscal_period where name = 'August 2026'`,
    );
    const entry = await draftJournal(manager);

    await withScope(scopeOf(manager), (tx) =>
      periods.setPeriodStatus(tx, manager, rows[0].id, 'soft_closed', 'Month-end close'),
    );

    await withScope(scopeOf(manager), (tx) =>
      journal.submit(tx, manager, entry.id, {
        overrideReason: 'Audit adjustment AJ-12, approved by Finance',
      }),
    );

    const overrides = await ownerPool.query(
      `select document_id, reason from period_override`,
    );
    expect(overrides.rows).toHaveLength(1);
    expect(overrides.rows[0].document_id).toBe(entry.entryNo);

    const header = await withScope(scopeOf(manager), (tx) => journal.loadHeader(tx, entry.id));
    expect(header.status).toBe('posted');
  });
});

// ---------------------------------------------------------------------------
describe('02.5 · numbering never reuses a number (§14.2)', () => {
  it('leaves a gap when a draft is abandoned, and does not reissue it', async () => {
    const first = await draftJournal(officer);
    expect(first.entryNo).toBe('JE-2026-000001');

    // A journal abandoned mid-creation: the number is spent.
    await expect(
      withScope(scopeOf(officer), async (tx) => {
        await journal.createDraft(tx, officer, {
          branchCode: BAGHDAD,
          documentDate: POSTING_DATE,
          postingDate: POSTING_DATE,
        });
        throw new Error('abandoned');
      }),
    ).rejects.toThrow('abandoned');

    const third = await draftJournal(officer);
    expect(third.entryNo).toBe('JE-2026-000003');

    const { rows } = await ownerPool.query(
      `select missing_serial from document_number_gaps('JOURNAL_ENTRY', '2026')`,
    );
    expect(rows.map((r) => Number(r.missing_serial))).toEqual([2]);
  });
});
