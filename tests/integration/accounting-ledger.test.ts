/**
 * Phase 02.8, 02.9 and 02.10 — reversal, subledgers and Trial Balance,
 * against a real PostgreSQL instance.
 *
 * This is where the accounting kernel is judged as a whole: a journal posts, a
 * subledger moves with it, the Trial Balance balances, a reversal undoes all
 * three exactly, and the integrity report stays at zero throughout.
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
import { NotReversibleError, ReversalDateError } from '@domain/reversal';

const BAGHDAD = 'BGW';
const POSTING_DATE = '2026-08-16';
const BANK_ACCOUNT = 'BANK-RAFIDAIN-01';

let manager: ActorContext;
let secondManager: ActorContext;
let cashId: string;
let salariesId: string;
let salariesUsdId: string;
let bankId: string;
let revenueId: string;

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
  await ownerPool.query(
    `insert into department (code, name, is_finance) values ('FIN','Finance',true)`,
  );

  manager = await createManager();
  secondManager = await createManager();

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

  // A **bank** control account, not a customer one. The subledger framework is
  // the same for all seven (§1.2), but a customer party is the Business Partner
  // dimension, whose master arrives in Phase 03 — and 02.4 rightly refuses a
  // dimension value it cannot validate. The bank account is a §14.2 *line
  // field*, not a dimension, so the framework can be proved today and the
  // customer and supplier subledgers activate when Phase 03 lands.
  bankId = await approvedAccount('A000001', {
    name: 'Bank — Al Rafidain',
    controlAccount: 'bank',
  });
  salariesId = await approvedAccount('X000001', { name: 'Salaries' });
  // D7 (2026-08-17) — an account holds one currency, so dollar salaries are a
  // second account rather than a second currency on the first.
  salariesUsdId = await approvedAccount('X000001', {
    name: 'Salaries — USD',
    currencyRestriction: 'USD',
  });
  revenueId = await approvedAccount('R000001', { name: 'Trading Revenue' });

  // Business Line has no master until Phase 03; relaxed for this document type
  // through the 02.4 override so the ledger tests are about the ledger.
  await ownerPool.query(
    `insert into document_type_dimension (document_type_code, dimension, requirement)
     values ('journal_entry','business_line','optional')
     on conflict (document_type_code, dimension) do update set requirement = 'optional'`,
  );
});

/** Dr salaries / Cr cash, posted. */
async function postedJournal(amount = '1000.0000', postingDate = POSTING_DATE) {
  const entry = await withScope(scope(manager), (tx) =>
    journal.createDraft(tx, manager, {
      branchCode: BAGHDAD,
      documentDate: postingDate,
      postingDate,
      description: 'August salaries',
    }),
  );
  await withScope(scope(manager), (tx) =>
    journal.addLine(tx, manager, entry.id, {
      accountId: salariesId,
      debit: amount,
      dimensions: { department: 'FIN' },
    }),
  );
  await withScope(scope(manager), (tx) =>
    journal.addLine(tx, manager, entry.id, { accountId: cashId, credit: amount }),
  );
  await withScope(scope(manager), (tx) => journal.submit(tx, manager, entry.id));
  return entry;
}

/** Dr bank (control account) / Cr revenue, posted. */
async function postedSale(amount = '5000.0000') {
  const entry = await withScope(scope(manager), (tx) =>
    journal.createDraft(tx, manager, {
      branchCode: BAGHDAD,
      documentDate: POSTING_DATE,
      postingDate: POSTING_DATE,
      description: 'Receipt into the bank',
    }),
  );
  await withScope(scope(manager), (tx) =>
    journal.addLine(tx, manager, entry.id, {
      accountId: bankId,
      debit: amount,
      bankAccountCode: BANK_ACCOUNT,
    }),
  );
  await withScope(scope(manager), (tx) =>
    journal.addLine(tx, manager, entry.id, { accountId: revenueId, credit: amount }),
  );
  await withScope(scope(manager), (tx) => journal.submit(tx, manager, entry.id));
  return entry;
}

// ---------------------------------------------------------------------------
describe('02.8 · full reversal (§14.3)', () => {
  it('mirrors every line and links both documents permanently', async () => {
    const original = await postedJournal();

    const result = await withScope(scope(manager), (tx) =>
      reversal.reverse(tx, manager, original.id, {
        reversalDate: '2026-08-20',
        reason: 'Posted to the wrong cost centre',
      }),
    );

    const { rows } = await ownerPool.query(
      `select entry_no, status, reverses_id, reversed_by_id from journal_entry order by entry_no`,
    );
    const [first, second] = rows;

    expect(first.status).toBe('reversed');
    expect(first.reversed_by_id).toBe(result.reversalId);
    expect(second.status).toBe('posted');
    expect(second.reverses_id).toBe(result.originalId);
  });

  it('nets every account and dimension to exactly zero', async () => {
    // The 02.8 gate. Not "close to zero" — exactly.
    const original = await postedJournal();
    await withScope(scope(manager), (tx) =>
      reversal.reverse(tx, manager, original.id, {
        reversalDate: '2026-08-20',
        reason: 'Duplicate entry',
      }),
    );

    const { rows } = await ownerPool.query(`
      select a.code,
             (sum(l.debit_iqd) - sum(l.credit_iqd))::text as net_iqd,
             (sum(l.debit_usd) - sum(l.credit_usd))::text as net_usd,
             l.department_code
        from journal_line l
        join chart_of_account a on a.id = l.account_id
       group by a.code, l.department_code
    `);

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Number(row.net_iqd), row.code).toBe(0);
      expect(Number(row.net_usd), row.code).toBe(0);
    }
  });

  it('uses the original’s rates, not the reversal date’s', async () => {
    // Reconverting at a later rate would leave a residue on every account —
    // the reversal would not actually reverse it.
    const original = await withScope(scope(manager), (tx) =>
      journal.createDraft(tx, manager, {
        branchCode: BAGHDAD,
        documentDate: POSTING_DATE,
        postingDate: POSTING_DATE,
      }),
    );
    await withScope(scope(manager), (tx) =>
      journal.addLine(tx, manager, original.id, {
        accountId: salariesUsdId,
        debit: '100.0000',
        currency: 'USD',
        dimensions: { department: 'FIN' },
      }),
    );
    await withScope(scope(manager), (tx) =>
      journal.addLine(tx, manager, original.id, {
        accountId: cashId,
        credit: '131000.0000',
      }),
    );
    await withScope(scope(manager), (tx) => journal.submit(tx, manager, original.id));

    // The rate moves before the reversal is raised.
    await withScope(scope(manager), (tx) =>
      rates.publishRate(tx, manager, {
        currency: 'USD',
        iqdPerUnit: '1500.00000000',
        effectiveFrom: '2026-08-18',
      }),
    );

    await withScope(scope(manager), (tx) =>
      reversal.reverse(tx, manager, original.id, {
        reversalDate: '2026-08-20',
        reason: 'Rate moved, entry withdrawn',
      }),
    );

    const { rows } = await ownerPool.query(`
      select (sum(debit_iqd) - sum(credit_iqd))::text as net from journal_line
    `);
    expect(Number(rows[0].net)).toBe(0);
  });

  it('refuses a reversal dated before the original', async () => {
    const original = await postedJournal();

    await expect(
      withScope(scope(manager), (tx) =>
        reversal.reverse(tx, manager, original.id, {
          reversalDate: '2026-08-01',
          reason: 'Too early',
        }),
      ),
    ).rejects.toThrow(ReversalDateError);
  });

  it('refuses it at the database too, bypassing the service', async () => {
    const original = await postedJournal();
    const { rows } = await ownerPool.query(
      `select fiscal_period_id, created_by from journal_entry limit 1`,
    );

    const message = await rejection(
      ownerPool.query(
        `insert into journal_entry
           (entry_no, document_date, posting_date, fiscal_period_id, branch_code,
            source, status, reverses_id, created_by)
         values ('JE-FORGED', '2026-08-01', '2026-08-01', $1, $2, 'manual', 'draft', $3, $4)`,
        [rows[0].fiscal_period_id, BAGHDAD, original.id, rows[0].created_by],
      ),
    );
    expect(message).toMatch(/is earlier than journal/);
  });

  it('refuses to reverse a reversal', async () => {
    const original = await postedJournal();
    const result = await withScope(scope(manager), (tx) =>
      reversal.reverse(tx, manager, original.id, {
        reversalDate: '2026-08-20',
        reason: 'Wrong account',
      }),
    );

    await expect(
      withScope(scope(manager), (tx) =>
        reversal.reverse(tx, manager, result.reversalId, {
          reversalDate: '2026-08-21',
          reason: 'Changed my mind again',
        }),
      ),
    ).rejects.toThrow(NotReversibleError);
  });

  it('refuses to reverse the same journal twice', async () => {
    const original = await postedJournal();
    await withScope(scope(manager), (tx) =>
      reversal.reverse(tx, manager, original.id, {
        reversalDate: '2026-08-20',
        reason: 'First reversal',
      }),
    );

    await expect(
      withScope(scope(manager), (tx) =>
        reversal.reverse(tx, manager, original.id, {
          reversalDate: '2026-08-21',
          reason: 'Second reversal',
        }),
      ),
    ).rejects.toThrow(/already been reversed/);
  });

  it('leaves both documents read-only', async () => {
    const original = await postedJournal();
    const result = await withScope(scope(manager), (tx) =>
      reversal.reverse(tx, manager, original.id, {
        reversalDate: '2026-08-20',
        reason: 'Withdrawn',
      }),
    );

    expect(
      await rejection(
        ownerPool.query(`update journal_entry set description = 'x' where id = $1`, [
          result.originalId,
        ]),
      ),
    ).toMatch(/cannot be edited/);
    expect(
      await rejection(
        ownerPool.query(`update journal_line set debit_iqd = 1 where journal_entry_id = $1`, [
          result.reversalId,
        ]),
      ),
    ).toMatch(/lines cannot be update/);
  });

  it('records the reversal in the audit trail with its reason and link', async () => {
    const original = await postedJournal();
    const result = await withScope(scope(manager), (tx) =>
      reversal.reverse(tx, manager, original.id, {
        reversalDate: '2026-08-20',
        reason: 'Posted in error',
      }),
    );

    const { rows } = await ownerPool.query(
      `select reason, related_object_id from audit_event
        where action = 'journal_entry.reversed'`,
    );
    expect(rows[0].reason).toBe('Posted in error');
    expect(rows[0].related_object_id).toBe(result.reversalId);
  });
});

// ---------------------------------------------------------------------------
describe('02.9 · subledgers reconcile to their control accounts (§1.2)', () => {
  it('writes a subledger entry in the same transaction as the journal', async () => {
    const entry = await postedSale();

    const { rows } = await ownerPool.query(
      `select subledger_type, party_code, debit_iqd, journal_entry_id from subledger_entry`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subledger_type: 'bank',
      party_code: BANK_ACCOUNT,
      debit_iqd: '5000.0000',
      journal_entry_id: entry.id,
    });
  });

  it('writes nothing for a journal that touches no control account', async () => {
    await postedJournal();
    const { rows } = await ownerPool.query(`select count(*)::int as n from subledger_entry`);
    expect(rows[0].n).toBe(0);
  });

  it('leaves no subledger entry when the journal rolls back', async () => {
    await expect(
      withScope(scope(manager), async (tx) => {
        const entry = await journal.createDraft(tx, manager, {
          branchCode: BAGHDAD,
          documentDate: POSTING_DATE,
          postingDate: POSTING_DATE,
        });
        await journal.addLine(tx, manager, entry.id, {
          accountId: bankId,
          debit: '100.0000',
          bankAccountCode: BANK_ACCOUNT,
        });
        await journal.addLine(tx, manager, entry.id, { accountId: revenueId, credit: '100.0000' });
        await journal.submit(tx, manager, entry.id);
        throw new Error('the source document failed');
      }),
    ).rejects.toThrow('the source document failed');

    const { rows } = await ownerPool.query(`select count(*)::int as n from subledger_entry`);
    expect(rows[0].n).toBe(0);
  });

  it('totals to the control account’s G/L balance', async () => {
    await postedSale('5000.0000');
    await postedSale('3000.0000');

    const report = await withScope(scope(manager), (tx) => subledger.reconciliation(tx));
    const receivables = report.find((r) => r.subledgerType === 'bank')!;

    expect(receivables.subledgerBalance).toBe('8000.0000');
    expect(receivables.generalLedgerBalance).toBe('8000.0000');
    expect(Number(receivables.difference)).toBe(0);
  });

  it('still reconciles after a reversal', async () => {
    const sale = await postedSale('5000.0000');
    await withScope(scope(manager), (tx) =>
      reversal.reverse(tx, manager, sale.id, {
        reversalDate: '2026-08-20',
        reason: 'Order cancelled',
      }),
    );

    const report = await withScope(scope(manager), (tx) => subledger.reconciliation(tx));
    const receivables = report.find((r) => r.subledgerType === 'bank')!;

    expect(Number(receivables.subledgerBalance)).toBe(0);
    expect(Number(receivables.generalLedgerBalance)).toBe(0);
    expect(Number(receivables.difference)).toBe(0);
  });

  it('gives a party its statement, oldest first', async () => {
    await postedSale('5000.0000');
    await postedSale('3000.0000');

    const statement = await withScope(scope(manager), (tx) =>
      subledger.statementFor(tx, 'bank', BANK_ACCOUNT),
    );
    expect(statement).toHaveLength(2);
    expect(statement.map((r) => r.debitIqd)).toEqual(['5000.0000', '3000.0000']);
  });

  it('refuses a posting to a control account with no party', async () => {
    // Without a customer the entry could not reconcile to anything.
    const entry = await withScope(scope(manager), (tx) =>
      journal.createDraft(tx, manager, {
        branchCode: BAGHDAD,
        documentDate: POSTING_DATE,
        postingDate: POSTING_DATE,
      }),
    );
    await withScope(scope(manager), (tx) =>
      journal.addLine(tx, manager, entry.id, { accountId: bankId, debit: '100.0000' }),
    );
    await withScope(scope(manager), (tx) =>
      journal.addLine(tx, manager, entry.id, { accountId: revenueId, credit: '100.0000' }),
    );

    await expect(
      withScope(scope(manager), (tx) => journal.submit(tx, manager, entry.id)),
    ).rejects.toThrow(/must say which bank it is against/);
  });

  it('holds subledger entries append-only, and denies the app role UPDATE and DELETE', async () => {
    await postedSale();

    expect(
      await rejection(ownerPool.query(`update subledger_entry set debit_iqd = 1`)),
    ).toMatch(/append-only/i);
    expect(await rejection(ownerPool.query(`delete from subledger_entry`))).toMatch(
      /append-only/i,
    );

    const { rows } = await ownerPool.query(
      `select privilege_type from information_schema.table_privileges
        where grantee = 'erp_app' and table_name = 'subledger_entry'`,
    );
    const granted = rows.map((r) => r.privilege_type);
    expect(granted).toContain('SELECT');
    expect(granted).toContain('INSERT');
    expect(granted).not.toContain('UPDATE');
    expect(granted).not.toContain('DELETE');
  });

  it('refuses a subledger entry against an account that is not a control account', async () => {
    const { rows } = await ownerPool.query(
      `select id, journal_entry_id from journal_line limit 1`,
    );
    const entry = await postedSale();
    const line = await ownerPool.query(`select id from journal_line limit 1`);

    const message = await rejection(
      ownerPool.query(
        `insert into subledger_entry
           (subledger_type, party_code, control_account_id, journal_entry_id, journal_line_id,
            posting_date, branch_code, currency, debit_iqd)
         values ('customer','X',$1,$2,$3,'2026-08-16',$4,'IQD',1)`,
        [cashId, entry.id, line.rows[0].id, BAGHDAD],
      ),
    );
    expect(message).toMatch(/is not a control account/);
    void rows;
  });
});

// ---------------------------------------------------------------------------
describe('02.10 · Trial Balance and G/L inquiry', () => {
  const period = { from: '2026-01-01', to: '2026-12-31' };

  it('balances in IQD', async () => {
    await postedJournal('1000.0000');
    await postedSale('5000.0000');

    const rows = await withScope(scope(manager), (tx) => tb.trialBalance(tx, period));
    const totals = tb.totalsOf(rows);

    expect(totals.balances).toBe(true);
    expect(totals.debit).toBe('6000.0000');
    expect(totals.credit).toBe('6000.0000');
    expect(Number(totals.difference)).toBe(0);
  });

  it('lists each posting account with its movements', async () => {
    await postedSale('5000.0000');

    const rows = await withScope(scope(manager), (tx) => tb.trialBalance(tx, period));
    const bank = rows.find((r) => r.accountName === 'Bank — Al Rafidain')!;
    const revenue = rows.find((r) => r.accountName === 'Trading Revenue')!;

    expect(bank).toMatchObject({ debit: '5000.0000', credit: '0.0000', accountType: 'asset' });
    expect(revenue).toMatchObject({ credit: '5000.0000', accountType: 'revenue' });
  });

  it('reports in USD without touching the ledger amounts (§2.3)', async () => {
    const entry = await withScope(scope(manager), (tx) =>
      journal.createDraft(tx, manager, {
        branchCode: BAGHDAD,
        documentDate: POSTING_DATE,
        postingDate: POSTING_DATE,
      }),
    );
    await withScope(scope(manager), (tx) =>
      journal.addLine(tx, manager, entry.id, {
        accountId: salariesId,
        debit: '131000.0000',
        dimensions: { department: 'FIN' },
      }),
    );
    await withScope(scope(manager), (tx) =>
      journal.addLine(tx, manager, entry.id, { accountId: cashId, credit: '131000.0000' }),
    );
    await withScope(scope(manager), (tx) => journal.submit(tx, manager, entry.id));

    const iqd = await withScope(scope(manager), (tx) => tb.trialBalance(tx, period));
    const usd = await withScope(scope(manager), (tx) =>
      tb.trialBalance(tx, { ...period, currency: 'USD' }),
    );

    expect(tb.totalsOf(iqd).debit).toBe('131000.0000');
    expect(tb.totalsOf(usd).debit).toBe('100.0000');
    expect(tb.totalsOf(usd).balances).toBe(true);
  });

  it('reproduces a past period after a later rate is published (§14.8)', async () => {
    await postedJournal('1000.0000', '2026-03-15');
    const before = await withScope(scope(manager), (tx) =>
      tb.trialBalance(tx, { from: '2026-03-01', to: '2026-03-31', currency: 'USD' }),
    );

    await withScope(scope(manager), (tx) =>
      rates.publishRate(tx, manager, {
        currency: 'USD',
        iqdPerUnit: '1500.00000000',
        effectiveFrom: '2026-06-01',
      }),
    );

    const after = await withScope(scope(manager), (tx) =>
      tb.trialBalance(tx, { from: '2026-03-01', to: '2026-03-31', currency: 'USD' }),
    );

    expect(after).toEqual(before);
  });

  it('filters by period, branch and dimension', async () => {
    await postedJournal('1000.0000', '2026-03-15');
    await postedJournal('2000.0000', '2026-08-16');

    const march = await withScope(scope(manager), (tx) =>
      tb.trialBalance(tx, { from: '2026-03-01', to: '2026-03-31' }),
    );
    expect(tb.totalsOf(march).debit).toBe('1000.0000');

    const byDepartment = await withScope(scope(manager), (tx) =>
      tb.trialBalance(tx, { ...period, departmentCode: 'FIN' }),
    );
    expect(tb.totalsOf(byDepartment).debit).toBe('3000.0000');

    const otherBranch = await withScope(scope(manager), (tx) =>
      tb.trialBalance(tx, { ...period, branchCode: 'NOWHERE' }),
    );
    expect(otherBranch).toHaveLength(0);
  });

  it('nets to zero after a reversal', async () => {
    const entry = await postedJournal('1000.0000');
    await withScope(scope(manager), (tx) =>
      reversal.reverse(tx, manager, entry.id, {
        reversalDate: '2026-08-20',
        reason: 'Withdrawn',
      }),
    );

    const rows = await withScope(scope(manager), (tx) => tb.trialBalance(tx, period));

    // The accounts still appear — a Trial Balance shows gross movements, and
    // both the original and its reversal are real postings. What nets to zero
    // is the balance, which is the figure that matters.
    for (const row of rows) {
      expect(Number(row.balance), row.accountCode).toBe(0);
    }
    expect(tb.totalsOf(rows).balances).toBe(true);
  });

  it('drills from a Trial Balance figure to the journal and the source', async () => {
    // §14.8 — "Source-document journals drill back to the originating
    // operational document."
    const entry = await postedSale('5000.0000');

    const activity = await withScope(scope(manager), (tx) =>
      tb.accountActivity(tx, 'A000003', period),
    );

    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      journalEntryId: entry.id,
      debitIqd: '5000.0000',
      status: 'posted',
    });
  });

  it('excludes drafts — a draft has no accounting effect', async () => {
    const draft = await withScope(scope(manager), (tx) =>
      journal.createDraft(tx, manager, {
        branchCode: BAGHDAD,
        documentDate: POSTING_DATE,
        postingDate: POSTING_DATE,
      }),
    );
    await withScope(scope(manager), (tx) =>
      journal.addLine(tx, manager, draft.id, {
        accountId: salariesId,
        debit: '999.0000',
        dimensions: { department: 'FIN' },
      }),
    );

    const rows = await withScope(scope(manager), (tx) => tb.trialBalance(tx, period));
    expect(rows).toHaveLength(0);
  });

  it('reports zero integrity issues (§24)', async () => {
    await postedJournal();
    await postedSale();
    const entry = await postedJournal('250.0000');
    await withScope(scope(manager), (tx) =>
      reversal.reverse(tx, manager, entry.id, {
        reversalDate: '2026-08-20',
        reason: 'Withdrawn',
      }),
    );

    const issues = await withScope(scope(manager), (tx) => tb.integrityReport(tx));
    expect(issues).toEqual([]);

    const duplicates = await withScope(scope(manager), (tx) => tb.duplicateSourceReferences(tx));
    expect(duplicates).toEqual([]);
  });

  it('detects an unbalanced journal if one ever appeared', async () => {
    // The report must actually find something, or "zero issues" proves nothing.
    // The header totals are forced out of step behind the triggers' backs.
    await postedJournal();

    // Three statements, each committing on its own: the deferred balance
    // constraint queues events during the UPDATE, and PostgreSQL refuses to
    // ALTER a table with pending trigger events. Both triggers come off,
    // because between them they make this corruption impossible — which is the
    // point of the report finding nothing in every other test.
    await ownerPool.query(`
      alter table journal_entry disable trigger journal_entry_posted_immutable;
      alter table journal_entry disable trigger journal_entry_balanced;
    `);
    await ownerPool.query(`update journal_entry set total_debit_iqd = total_debit_iqd + 1`);
    await ownerPool.query(`
      alter table journal_entry enable trigger journal_entry_balanced;
      alter table journal_entry enable trigger journal_entry_posted_immutable;
    `);

    const issues = await withScope(scope(manager), (tx) => tb.integrityReport(tx));
    expect(issues.map((i) => i.issue)).toContain('unbalanced_journal');
  });
});
