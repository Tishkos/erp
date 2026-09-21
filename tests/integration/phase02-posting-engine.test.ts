/**
 * Phase 02.7 — the posting engine, against a real PostgreSQL instance.
 *
 * §24 names three acceptance criteria and this file is built around them:
 *
 *   1. "Repeated delivery of the same idempotent request creates only one ERP
 *      transaction."
 *   2. "Forced technical failure during posting leaves no partial journal,
 *      subledger or stock movement."
 *   3. every journal line resolves to source document, source line, posting
 *      rule and actor.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import * as periods from '@/server/services/periods';
import * as posting from '@/server/services/posting';
import * as rates from '@/server/services/exchange-rates';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import type { PostingRequest } from '@domain/posting';
import { AmbiguousPostingRuleError, NoPostingRuleError } from '@domain/posting';
import { PeriodClosedError } from '@domain/periods';
import { MissingDimensionsError } from '@domain/dimensions';
import { JournalUnbalancedError } from '@domain/journal';
import { PermissionDeniedError } from '@domain/permissions';

const BAGHDAD = 'BGW';
const EVENT = 'sales_invoice.posted';
const POSTING_DATE = '2026-08-16';

let manager: ActorContext;
let receivableAccountId: string;
let revenueAccountId: string;
let fuelRevenueAccountId: string;

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

const scope = () => ({ userId: manager.principal.userId, branchCode: BAGHDAD });

async function approvedAccount(
  parentCode: string,
  name: string,
  currencyRestriction = 'IQD',
): Promise<string> {
  const { rows } = await ownerPool.query(`select id from chart_of_account where code = $1`, [
    parentCode,
  ]);
  const account = await withScope(scope(), (tx) =>
    coa.createAccount(tx, manager, { name, parentId: rows[0].id, currencyRestriction }),
  );
  await withScope(scope(), (tx) => coa.submitForApproval(tx, manager, account.id));
  // A manager cannot approve their own chart change, so approval goes to a
  // second manager — the same rule the 02.1 tests prove.
  const other = await createManager();
  await withScope({ userId: other.principal.userId, branchCode: BAGHDAD }, (tx) =>
    coa.approve(tx, other, account.id),
  );
  return account.id;
}

const request = (overrides: Partial<PostingRequest> = {}): PostingRequest => ({
  eventType: EVENT,
  source: { module: 'sales', documentId: 'INV-000001', event: 'posted' },
  branchCode: BAGHDAD,
  documentDate: POSTING_DATE,
  postingDate: POSTING_DATE,
  description: 'Sales invoice INV-000001',
  lines: [
    { role: 'receivable', debit: '1000.0000', sourceLineId: null },
    { role: 'revenue', credit: '1000.0000', sourceLineId: 'INV-000001-L1' },
  ],
  ...overrides,
});

beforeEach(async () => {
  await resetTestData();
  posting.clearSubscribers();

  await seedBranch(BAGHDAD, 'Baghdad');
  await ownerPool.query(
    `insert into department (code, name, is_finance) values ('FIN','Finance',true)`,
  );

  manager = await createManager();

  await withScope(scope(), (tx) =>
    periods.createFiscalYear(tx, manager, {
      code: 'FY2026',
      startsOn: '2026-01-01',
      endsOn: '2026-12-31',
    }),
  );
  await withScope(scope(), (tx) =>
    rates.publishRate(tx, manager, {
      currency: 'USD',
      iqdPerUnit: '1310.00000000',
      effectiveFrom: '2026-01-01',
    }),
  );

  receivableAccountId = await approvedAccount('A000001', 'Trade Receivables');
  revenueAccountId = await approvedAccount('R000001', 'Trading Revenue');
  fuelRevenueAccountId = await approvedAccount('R000001', 'Fuel Revenue');

  // §4.2 makes Business Line mandatory for revenue accounts and its master
  // arrives in Phase 03 — relaxed for this event through the 02.4 override.
  await ownerPool.query(
    `insert into document_type (code, name, module) values ($1, 'Sales Invoice Posting', 'sales')
     on conflict do nothing`,
    [EVENT],
  );
  await ownerPool.query(
    `insert into document_type_dimension (document_type_code, dimension, requirement)
     values ($1, 'business_line', 'optional') on conflict (document_type_code, dimension)
     do update set requirement = 'optional'`,
    [EVENT],
  );

  // The accounting mappings. Nothing below this line names an account again.
  await withScope(scope(), (tx) =>
    posting.defineRule(tx, manager, {
      eventType: EVENT,
      lineRole: 'receivable',
      accountId: receivableAccountId,
    }),
  );
  await withScope(scope(), (tx) =>
    posting.defineRule(tx, manager, {
      eventType: EVENT,
      lineRole: 'revenue',
      accountId: revenueAccountId,
    }),
  );
});

afterEach(() => {
  posting.clearSubscribers();
});

// ---------------------------------------------------------------------------
describe('§3.3 · accounts come from the mapping, never from code', () => {
  it('posts to the mapped accounts', async () => {
    const result = await withScope(scope(), (tx) => posting.post(tx, manager, request()));

    const { rows } = await ownerPool.query(
      `select a.code, l.debit_iqd, l.credit_iqd, l.line_role
         from journal_line l join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = $1 order by l.line_no`,
      [result.journalEntryId],
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ code: 'A000002', debit_iqd: '1000.0000', line_role: 'receivable' });
    expect(rows[1]).toMatchObject({ code: 'R000002', credit_iqd: '1000.0000', line_role: 'revenue' });
  });

  it('changes the account when the mapping changes, with no code change', async () => {
    // The 02.7 gate, stated exactly. The request below is byte-identical to the
    // one above; only the configuration differs.
    await withScope(scope(), (tx) =>
      posting.defineRule(tx, manager, {
        eventType: EVENT,
        lineRole: 'revenue',
        itemGroup: 'FUEL',
        accountId: fuelRevenueAccountId,
      }),
    );

    const result = await withScope(scope(), (tx) =>
      posting.post(
        tx,
        manager,
        request({
          lines: [
            { role: 'receivable', debit: '1000.0000' },
            { role: 'revenue', credit: '1000.0000', criteria: { itemGroup: 'FUEL' } },
          ],
        }),
      ),
    );

    const { rows } = await ownerPool.query(
      `select a.code from journal_line l join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = $1 and l.line_role = 'revenue'`,
      [result.journalEntryId],
    );
    expect(rows[0].code).toBe('R000003');
  });

  it('refuses to post when a line has no mapping', async () => {
    await expect(
      withScope(scope(), (tx) =>
        posting.post(
          tx,
          manager,
          request({
            lines: [
              { role: 'receivable', debit: '1000.0000' },
              { role: 'tax', credit: '1000.0000' },
            ],
          }),
        ),
      ),
    ).rejects.toThrow(NoPostingRuleError);
  });

  it('refuses two mappings that match equally well', async () => {
    await withScope(scope(), (tx) =>
      posting.defineRule(tx, manager, {
        eventType: EVENT,
        lineRole: 'revenue',
        itemGroup: 'FUEL',
        accountId: fuelRevenueAccountId,
      }),
    );
    await withScope(scope(), (tx) =>
      posting.defineRule(tx, manager, {
        eventType: EVENT,
        lineRole: 'revenue',
        partnerGroup: 'WHOLESALE',
        accountId: revenueAccountId,
      }),
    );

    await expect(
      withScope(scope(), (tx) =>
        posting.post(
          tx,
          manager,
          request({
            lines: [
              { role: 'receivable', debit: '1000.0000' },
              {
                role: 'revenue',
                credit: '1000.0000',
                criteria: { itemGroup: 'FUEL', partnerGroup: 'WHOLESALE' },
              },
            ],
          }),
        ),
      ),
    ).rejects.toThrow(AmbiguousPostingRuleError);
  });

  it('refuses to map a group account, at the database', async () => {
    const { rows } = await ownerPool.query(
      `select id from chart_of_account where code = 'R000001'`,
    );
    const message = await rejection(
      ownerPool.query(
        `insert into posting_rule (event_type, line_role, account_id) values ($1,'revenue',$2)`,
        [EVENT, rows[0].id],
      ),
    );
    expect(message).toMatch(/is a group and cannot be mapped/);
  });
});

// ---------------------------------------------------------------------------
describe('§24 criterion 1 · idempotency', () => {
  it('produces exactly one journal for the same source event posted twice', async () => {
    const first = await withScope(scope(), (tx) => posting.post(tx, manager, request()));
    const second = await withScope(scope(), (tx) => posting.post(tx, manager, request()));

    expect(second.wasDuplicate).toBe(true);
    expect(second.journalEntryId).toBe(first.journalEntryId);
    expect(second.entryNo).toBe(first.entryNo);

    const { rows } = await ownerPool.query(
      `select count(*)::int as journals from journal_entry where source_doc_id = 'INV-000001'`,
    );
    expect(rows[0].journals).toBe(1);

    const lines = await ownerPool.query(`select count(*)::int as n from journal_line`);
    expect(lines.rows[0].n).toBe(2);
  });

  it('records the replay in the posting log without posting again', async () => {
    await withScope(scope(), (tx) => posting.post(tx, manager, request()));
    await withScope(scope(), (tx) => posting.post(tx, manager, request()));

    const { rows } = await ownerPool.query(
      `select was_duplicate from posting_log order by id`,
    );
    expect(rows.map((r) => r.was_duplicate)).toEqual([false, true]);
  });

  it('treats a different event on the same document as a different posting', async () => {
    await withScope(scope(), (tx) => posting.post(tx, manager, request()));

    const reversal = await withScope(scope(), (tx) =>
      posting.post(
        tx,
        manager,
        request({
          source: { module: 'sales', documentId: 'INV-000001', event: 'returned' },
          lines: [
            { role: 'revenue', debit: '1000.0000' },
            { role: 'receivable', credit: '1000.0000' },
          ],
        }),
      ),
    );

    expect(reversal.wasDuplicate).toBe(false);
  });

  it('refuses a duplicate source reference at the database, bypassing the engine', async () => {
    const first = await withScope(scope(), (tx) => posting.post(tx, manager, request()));

    const message = await rejection(
      ownerPool.query(
        `insert into journal_entry
           (entry_no, document_date, posting_date, fiscal_period_id, branch_code, source,
            source_module, source_doc_id, source_event, created_by, status)
         select 'JE-FORGED', document_date, posting_date, fiscal_period_id, branch_code, 'system',
                source_module, source_doc_id, source_event, created_by, 'draft'
           from journal_entry where id = $1`,
        [first.journalEntryId],
      ),
    );
    expect(message).toMatch(/journal_entry_source_uniq/);
  });
});

// ---------------------------------------------------------------------------
describe('§24 criterion 2 · atomicity', () => {
  it('leaves nothing behind when the posting fails partway', async () => {
    // The receivable line maps; the second line does not. The failure happens
    // after the first line has been planned and the number allocated.
    await expect(
      withScope(scope(), (tx) =>
        posting.post(
          tx,
          manager,
          request({
            lines: [
              { role: 'receivable', debit: '1000.0000' },
              { role: 'unmapped_role', credit: '1000.0000' },
            ],
          }),
        ),
      ),
    ).rejects.toThrow(NoPostingRuleError);

    for (const table of ['journal_entry', 'journal_line', 'posting_log']) {
      const { rows } = await ownerPool.query(`select count(*)::int as n from ${table}`);
      expect(rows[0].n, table).toBe(0);
    }
  });

  it('leaves nothing behind when the caller fails after the posting', async () => {
    // §24: the module's own writes and the journal commit together or not at
    // all. Here the module throws after posting; the journal must vanish too.
    await expect(
      withScope(scope(), async (tx) => {
        await posting.post(tx, manager, request());
        throw new Error('the source document failed to save');
      }),
    ).rejects.toThrow('the source document failed to save');

    const { rows } = await ownerPool.query(`select count(*)::int as n from journal_entry`);
    expect(rows[0].n).toBe(0);
  });

  it('leaves nothing behind when an unbalanced event is posted', async () => {
    await expect(
      withScope(scope(), (tx) =>
        posting.post(
          tx,
          manager,
          request({
            lines: [
              { role: 'receivable', debit: '1000.0000' },
              { role: 'revenue', credit: '900.0000' },
            ],
          }),
        ),
      ),
    ).rejects.toThrow(JournalUnbalancedError);

    const { rows } = await ownerPool.query(`select count(*)::int as n from journal_entry`);
    expect(rows[0].n).toBe(0);
  });

  it('fails cleanly on a dimension violation, leaving nothing partial', async () => {
    // D7 — a rule lives on an account that declares its own; the group above
    // this one declares nothing, so the account has to.
    await ownerPool.query(`update chart_of_account set declares_dimensions = true where id = $1`, [
      revenueAccountId,
    ]);
    await ownerPool.query(
      `insert into account_required_dimension (account_id, dimension) values ($1,'department')`,
      [revenueAccountId],
    );

    await expect(
      withScope(scope(), (tx) => posting.post(tx, manager, request())),
    ).rejects.toThrow(MissingDimensionsError);

    const { rows } = await ownerPool.query(`select count(*)::int as n from journal_entry`);
    expect(rows[0].n).toBe(0);
  });

  it('refuses a system posting into a soft-closed period, with no override', async () => {
    // An operational document cannot decide to breach a closed period; only a
    // Finance Manager posting a stated adjustment can (§14.6).
    const { rows } = await ownerPool.query(
      `select id from fiscal_period where name = 'August 2026'`,
    );
    await withScope(scope(), (tx) =>
      periods.setPeriodStatus(tx, manager, rows[0].id, 'soft_closed', 'Month-end close'),
    );

    await expect(
      withScope(scope(), (tx) => posting.post(tx, manager, request())),
    ).rejects.toThrow(PeriodClosedError);
  });
});

// ---------------------------------------------------------------------------
describe('§24 criterion 3 · traceability', () => {
  it('keeps the source document, source line, rule and actor on every line', async () => {
    const result = await withScope(scope(), (tx) => posting.post(tx, manager, request()));

    const { rows } = await ownerPool.query(
      `select e.source_module, e.source_doc_id, e.source_event, e.created_by,
              l.source_line_id, l.posting_rule_id, l.line_role,
              r.line_role as rule_role, a.code as rule_account
         from journal_entry e
         join journal_line l  on l.journal_entry_id = e.id
         join posting_rule r  on r.id = l.posting_rule_id
         join chart_of_account a on a.id = r.account_id
        where e.id = $1 order by l.line_no`,
      [result.journalEntryId],
    );

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.source_module).toBe('sales');
      expect(row.source_doc_id).toBe('INV-000001');
      expect(row.source_event).toBe('posted');
      expect(row.created_by).toBe(manager.principal.userId);
      expect(row.posting_rule_id).not.toBeNull();
      expect(row.rule_role).toBe(row.line_role);
    }
    expect(rows[1].source_line_id).toBe('INV-000001-L1');
  });

  it('records the posting in the log, drillable from the source document', async () => {
    const result = await withScope(scope(), (tx) => posting.post(tx, manager, request()));

    const log = await withScope(scope(), (tx) => posting.logFor(tx, 'sales', 'INV-000001'));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      eventType: EVENT,
      journalEntryId: result.journalEntryId,
      wasDuplicate: false,
    });
  });

  it('audits the posting with its source and total', async () => {
    const result = await withScope(scope(), (tx) => posting.post(tx, manager, request()));

    const { rows } = await ownerPool.query(
      `select action, after_value from audit_event where object_id = $1 and action = 'posting.posted'`,
      [result.journalEntryId],
    );
    expect(rows[0].after_value).toMatchObject({
      eventType: EVENT,
      totalIqd: '1000.0000',
    });
  });

  it('holds the posting log immutable', async () => {
    await withScope(scope(), (tx) => posting.post(tx, manager, request()));
    expect(await rejection(ownerPool.query(`update posting_log set was_duplicate = true`))).toMatch(
      /append-only/i,
    );
  });
});

// ---------------------------------------------------------------------------
describe('the posting preview', () => {
  it('shows exactly the journal that is then produced', async () => {
    const preview = await withScope(scope(), (tx) => posting.plan(tx, manager, request()));
    const result = await withScope(scope(), (tx) => posting.post(tx, manager, request()));

    expect(result.plan.lines.map((l) => [l.accountCode, l.debitIqd, l.creditIqd])).toEqual(
      preview.lines.map((l) => [l.accountCode, l.debitIqd, l.creditIqd]),
    );

    const { rows } = await ownerPool.query(
      `select a.code, l.debit_iqd, l.credit_iqd from journal_line l
         join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = $1 order by l.line_no`,
      [result.journalEntryId],
    );
    expect(rows.map((r) => [r.code, r.debit_iqd, r.credit_iqd])).toEqual(
      preview.lines.map((l) => [l.accountCode, l.debitIqd, l.creditIqd]),
    );
  });

  it('writes nothing', async () => {
    await withScope(scope(), (tx) => posting.plan(tx, manager, request()));

    const { rows } = await ownerPool.query(`select count(*)::int as n from journal_entry`);
    expect(rows[0].n).toBe(0);
  });

  it('converts a foreign-currency event at the posting date’s rate', async () => {
    // D7 (2026-08-17) — an account holds one currency, so a dollar invoice maps
    // to the dollar receivable and the dollar revenue account, not to the dinar
    // ones. Repointing the mapping is exactly what §3.3 says configuration is
    // for: the engine does not change, the accounts it selects do.
    const usdReceivable = await approvedAccount('A000001', 'Trade Receivables — USD', 'USD');
    const usdRevenue = await approvedAccount('R000001', 'Trading Revenue — USD', 'USD');
    for (const [role, accountId] of [
      ['receivable', usdReceivable],
      ['revenue', usdRevenue],
    ] as const) {
      await ownerPool.query(
        `update posting_rule set account_id = $1 where event_type = $2 and line_role = $3`,
        [accountId, EVENT, role],
      );
    }

    const preview = await withScope(scope(), (tx) =>
      posting.plan(tx, manager, request({ currency: 'USD' })),
    );

    expect(preview.lines[0]!.debit).toBe('1000.0000');
    expect(preview.lines[0]!.debitIqd).toBe('1310000.0000');
    expect(preview.totalDebitIqd).toBe('1310000.0000');
  });
});

// ---------------------------------------------------------------------------
describe('§24 · events fire after commit', () => {
  it('emits once the posting has committed', async () => {
    const seen: string[] = [];
    posting.onPosted((event) => {
      seen.push(event.entryNo);
    });

    const result = await posting.postAndCommit(scope(), manager, request());

    expect(seen).toEqual([result.entryNo]);

    // Committed, and visible from another connection.
    const { rows } = await ownerPool.query(
      `select status from journal_entry where id = $1`,
      [result.journalEntryId],
    );
    expect(rows[0].status).toBe('posted');
  });

  it('does not roll back the posting when a subscriber throws', async () => {
    // 02.7 gate. A failing notification is a notification problem; the money
    // has already moved.
    posting.onPosted(() => {
      throw new Error('the notification service is down');
    });

    const result = await posting.postAndCommit(scope(), manager, request());

    const { rows } = await ownerPool.query(
      `select status from journal_entry where id = $1`,
      [result.journalEntryId],
    );
    expect(rows[0].status).toBe('posted');
  });

  it('runs the remaining subscribers after one fails', async () => {
    const seen: string[] = [];
    posting.onPosted(() => {
      throw new Error('first subscriber is down');
    });
    posting.onPosted(() => {
      seen.push('second ran');
    });

    await posting.postAndCommit(scope(), manager, request());
    expect(seen).toEqual(['second ran']);
  });
});

// ---------------------------------------------------------------------------
describe('§24 · the failed-posting queue', () => {
  it('records a failure with its root cause, surviving the rollback', async () => {
    const broken = request({
      lines: [
        { role: 'receivable', debit: '1000.0000' },
        { role: 'unmapped_role', credit: '1000.0000' },
      ],
    });

    await expect(posting.postAndCommit(scope(), manager, broken)).rejects.toThrow(
      NoPostingRuleError,
    );

    const { rows } = await ownerPool.query(
      `select event_type, source_doc_id, error_code, error_message, resolved_at
         from posting_failure`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_type: EVENT,
      source_doc_id: 'INV-000001',
      error_code: 'NO_POSTING_RULE',
      resolved_at: null,
    });
    expect(rows[0].error_message).toMatch(/No accounting mapping is configured/);
  });

  it('replays a failure once the mapping is fixed, and closes it out', async () => {
    const broken = request({
      lines: [
        { role: 'receivable', debit: '1000.0000' },
        { role: 'tax', credit: '1000.0000' },
      ],
    });

    await expect(posting.postAndCommit(scope(), manager, broken)).rejects.toThrow(
      NoPostingRuleError,
    );

    // The fix is a mapping, not an edited payload.
    const taxAccountId = await approvedAccount('L000001', 'Sales Tax Payable');
    await withScope(scope(), (tx) =>
      posting.defineRule(tx, manager, {
        eventType: EVENT,
        lineRole: 'tax',
        accountId: taxAccountId,
      }),
    );

    const [failure] = await withScope(scope(), (tx) => posting.openFailures(tx));
    const result = await posting.retryFailure(scope(), manager, failure!.id);

    expect(result.wasDuplicate).toBe(false);

    const { rows } = await ownerPool.query(
      `select resolved_at, resolved_journal_id, retry_count from posting_failure`,
    );
    expect(rows[0].resolved_at).not.toBeNull();
    expect(rows[0].resolved_journal_id).toBe(result.journalEntryId);
    expect(rows[0].retry_count).toBe(1);
  });

  it('refuses to edit a recorded failure', async () => {
    await expect(
      posting.postAndCommit(
        scope(),
        manager,
        request({
          lines: [
            { role: 'receivable', debit: '1000.0000' },
            { role: 'unmapped_role', credit: '1000.0000' },
          ],
        }),
      ),
    ).rejects.toThrow();

    expect(
      await rejection(ownerPool.query(`update posting_failure set error_message = 'nothing wrong'`)),
    ).toMatch(/cannot be edited/);
    expect(await rejection(ownerPool.query(`delete from posting_failure`))).toMatch(/append-only/i);
  });
});

// ---------------------------------------------------------------------------
describe('§3.3 · the mapping is set from the Posting Mappings screen', () => {
  /*
   * The screen sets one account for one line of one document, and sets it
   * again when it is wrong. Both acts go through `setMapping`, which is
   * `defineRule` with the one property the screen needs: setting a mapping
   * twice leaves one rule.
   *
   * Without that, the second choice would be a second rule matching exactly as
   * well as the first, and every posting through it would fail as ambiguous —
   * a worse state than the unmapped one the person was trying to fix.
   */
  /*
   * An expense account with no §4.2 dimensions to satisfy. Department and Cost
   * Centre are required of expense accounts by the chart's own rules, and this
   * block is about the mapping rather than about dimensions — which the 02.4
   * tests above already cover.
   */
  const discountAccount = async (name: string) => {
    const id = await approvedAccount('X000001', name);
    await withScope(scope(), (tx) => coa.setRequiredDimensions(tx, manager, id, []));
    return id;
  };

  const withDiscount = () =>
    request({
      // A thousand of revenue, settled for nine hundred: the hundred is the
      // discount, and it is a line of its own so the mapping has something to
      // answer for.
      lines: [
        { role: 'receivable', debit: '900.0000', sourceLineId: null },
        { role: 'settlement_discount', debit: '100.0000', sourceLineId: 'INV-000001-L2' },
        { role: 'revenue', credit: '1000.0000', sourceLineId: 'INV-000001-L1' },
      ],
    });

  it.each([
    {
      eventType: 'purchasing.ap_invoice',
      lineRole: 'supplier_payable',
      required: 'supplier',
    },
    {
      eventType: 'sales.ar_invoice',
      lineRole: 'customer_receivable',
      required: 'customer',
    },
  ] as const)(
    'requires $eventType / $lineRole to point at a $required control account',
    async ({ eventType, lineRole, required }) => {
      const chosenAccountId = await approvedAccount(
        'A000001',
        `${required === 'supplier' ? 'Supplier' : 'Customer'} Control ${eventType}`,
      );
      await expect(
        withScope(scope(), (tx) =>
          posting.setMapping(tx, manager, {
            eventType,
            lineRole,
            accountId: chosenAccountId,
          }),
        ),
      ).rejects.toThrow(/control account/);
      await expect(
        withScope(scope(), (tx) =>
          posting.defineRule(tx, manager, {
            eventType,
            lineRole,
            accountId: chosenAccountId,
          }),
        ),
      ).rejects.toThrow(/control account/);

      let { rows } = await ownerPool.query(
        `select count(*)::int as rules from posting_rule where event_type = $1 and line_role = $2`,
        [eventType, lineRole],
      );
      expect(rows[0].rules).toBe(0);

      await withScope(scope(), (tx) =>
        coa.setControlAccount(tx, manager, chosenAccountId, required),
      );
      await withScope(scope(), (tx) =>
        posting.setMapping(tx, manager, {
          eventType,
          lineRole,
          accountId: chosenAccountId,
        }),
      );

      await expect(
        withScope(scope(), (tx) =>
          posting.setMapping(tx, manager, {
            eventType,
            lineRole,
            accountId: revenueAccountId,
          }),
        ),
      ).rejects.toThrow(/control account/);

      ({ rows } = await ownerPool.query(
        `select account_id from posting_rule where event_type = $1 and line_role = $2`,
        [eventType, lineRole],
      ));
      expect(rows).toEqual([{ account_id: chosenAccountId }]);
    },
  );

  it.each([
    {
      eventType: 'purchasing.ap_invoice',
      lineRole: 'supplier_payable',
      otherRole: 'expense',
      debitRole: 'expense',
      creditRole: 'supplier_payable',
    },
    {
      eventType: 'sales.ar_invoice',
      lineRole: 'customer_receivable',
      otherRole: 'sales_revenue',
      debitRole: 'customer_receivable',
      creditRole: 'sales_revenue',
    },
  ] as const)(
    'refuses a stale or overridden $eventType / $lineRole account at posting',
    async ({ eventType, lineRole, otherRole, debitRole, creditRole }) => {
      await ownerPool.query(
        `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
         values ($1, $2, $3, true, $4)`,
        [eventType, lineRole, receivableAccountId, manager.principal.userId],
      );

      const invalid = request({
        eventType,
        documentTypeCode: EVENT,
        source: { module: eventType.split('.')[0]!, documentId: `STALE-${eventType}`, event: 'posted' },
        lines:
          debitRole === lineRole
            ? [
                { role: lineRole, debit: '1000.0000' },
                { role: otherRole, credit: '1000.0000', accountId: revenueAccountId },
              ]
            : [
                { role: otherRole, debit: '1000.0000', accountId: revenueAccountId },
                { role: lineRole, credit: '1000.0000' },
              ],
      });
      await expect(
        withScope(scope(), (tx) => posting.post(tx, manager, invalid)),
      ).rejects.toThrow(/control account/);

      const overridden = request({
        eventType,
        documentTypeCode: EVENT,
        source: { module: eventType.split('.')[0]!, documentId: `OVERRIDE-${eventType}`, event: 'posted' },
        lines: [
          { role: debitRole, debit: '1000.0000', accountId: receivableAccountId },
          { role: creditRole, credit: '1000.0000', accountId: revenueAccountId },
        ],
      });
      await expect(
        withScope(scope(), (tx) => posting.post(tx, manager, overridden)),
      ).rejects.toThrow(/control account/);

      const { rows } = await ownerPool.query(
        `select count(*)::int as journals from journal_entry`,
      );
      expect(rows[0].journals).toBe(0);
    },
  );

  it('refuses the posting while the line has no account', async () => {
    await expect(withScope(scope(), (tx) => posting.post(tx, manager, withDiscount()))).rejects.toThrow(
      NoPostingRuleError,
    );
  });

  it('posts to the account the mapping names', async () => {
    const discountAccountId = await discountAccount('Settlement Discount');
    await withScope(scope(), (tx) =>
      posting.setMapping(tx, manager, {
        eventType: EVENT,
        lineRole: 'settlement_discount',
        accountId: discountAccountId,
      }),
    );

    const result = await withScope(scope(), (tx) => posting.post(tx, manager, withDiscount()));
    const { rows } = await ownerPool.query(
      `select a.name, l.debit_iqd from journal_line l
         join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = $1 and l.line_role = 'settlement_discount'`,
      [result.journalEntryId],
    );
    expect(rows[0]).toMatchObject({ name: 'Settlement Discount', debit_iqd: '100.0000' });
  });

  it('replaces the account rather than adding a second rule', async () => {
    const first = await discountAccount('Settlement Discount');
    const second = await discountAccount('Discount Allowed');

    for (const accountId of [first, second]) {
      await withScope(scope(), (tx) =>
        posting.setMapping(tx, manager, {
          eventType: EVENT,
          lineRole: 'settlement_discount',
          accountId,
        }),
      );
    }

    const { rows } = await ownerPool.query(
      `select count(*)::int as rules from posting_rule
        where event_type = $1 and line_role = 'settlement_discount'`,
      [EVENT],
    );
    expect(rows[0].rules).toBe(1);

    // And the posting goes to the second, which is the point of changing it.
    const result = await withScope(scope(), (tx) => posting.post(tx, manager, withDiscount()));
    const { rows: posted } = await ownerPool.query(
      `select a.name from journal_line l join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = $1 and l.line_role = 'settlement_discount'`,
      [result.journalEntryId],
    );
    expect(posted[0].name).toBe('Discount Allowed');
  });

  it('leaves a narrowed mapping alone', async () => {
    // The screen writes the plain rule. A mapping narrowed to an item group is
    // an exception somebody configured deliberately, and it sits over the
    // plain one — changing the plain one must not disturb it.
    const plain = await approvedAccount('R000001', 'Trading Revenue Two');
    await withScope(scope(), (tx) =>
      posting.defineRule(tx, manager, {
        eventType: EVENT,
        lineRole: 'revenue',
        itemGroup: 'FUEL',
        accountId: fuelRevenueAccountId,
      }),
    );
    await withScope(scope(), (tx) =>
      posting.setMapping(tx, manager, {
        eventType: EVENT,
        lineRole: 'revenue',
        accountId: plain,
      }),
    );

    const { rows } = await ownerPool.query(
      `select item_group, account_id from posting_rule
        where event_type = $1 and line_role = 'revenue' order by item_group nulls first`,
      [EVENT],
    );
    expect(rows.map((r) => r.item_group)).toEqual([null, 'FUEL']);
    expect(rows[1].account_id).toBe(fuelRevenueAccountId);

    const result = await withScope(scope(), (tx) => posting.post(tx, manager, request()));
    const { rows: posted } = await ownerPool.query(
      `select a.name from journal_line l join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = $1 and l.line_role = 'revenue'`,
      [result.journalEntryId],
    );
    expect(posted[0].name).toBe('Trading Revenue Two');

    const fuelResult = await withScope(scope(), (tx) =>
      posting.post(
        tx,
        manager,
        request({
          source: { module: 'sales', documentId: 'INV-FUEL', event: 'posted' },
          lines: [
            { role: 'receivable', debit: '1000.0000' },
            { role: 'revenue', credit: '1000.0000', criteria: { itemGroup: 'FUEL' } },
          ],
        }),
      ),
    );
    const { rows: fuelPosted } = await ownerPool.query(
      `select account_id from journal_line
        where journal_entry_id = $1 and line_role = 'revenue'`,
      [fuelResult.journalEntryId],
    );
    expect(fuelPosted[0].account_id).toBe(fuelRevenueAccountId);
  });

  it('audits a newly created mapping against the rule it created', async () => {
    const accountId = await discountAccount('Settlement Discount');
    await withScope(scope(), (tx) =>
      posting.setMapping(tx, manager, {
        eventType: EVENT,
        lineRole: 'settlement_discount',
        accountId,
      }),
    );

    const { rows: rules } = await ownerPool.query(
      `select id from posting_rule where event_type = $1 and line_role = 'settlement_discount'`,
      [EVENT],
    );
    const { rows: events } = await ownerPool.query(
      `select object_id, after_value from audit_event
        where action = 'posting_rule.configured' and object_id = $1`,
      [rules[0].id],
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ object_id: rules[0].id });
    expect(events[0].after_value).toMatchObject({ accountId });
  });

  it('reactivates a cleared mapping with the same id and an updated account', async () => {
    const first = await discountAccount('Settlement Discount');
    const second = await discountAccount('Discount Allowed');
    await withScope(scope(), (tx) =>
      posting.setMapping(tx, manager, {
        eventType: EVENT,
        lineRole: 'settlement_discount',
        accountId: first,
      }),
    );
    const { rows: created } = await ownerPool.query(
      `select id from posting_rule where event_type = $1 and line_role = 'settlement_discount'`,
      [EVENT],
    );
    await withScope(scope(), (tx) =>
      posting.clearMapping(tx, manager, { eventType: EVENT, lineRole: 'settlement_discount' }),
    );
    await withScope(scope(), (tx) =>
      posting.setMapping(tx, manager, {
        eventType: EVENT,
        lineRole: 'settlement_discount',
        accountId: second,
      }),
    );

    const { rows } = await ownerPool.query(
      `select id, account_id, is_active from posting_rule
        where event_type = $1 and line_role = 'settlement_discount'`,
      [EVENT],
    );
    expect(rows).toEqual([{ id: created[0].id, account_id: second, is_active: true }]);
  });

  it('refuses mapping changes without configure permission and leaves the mapping unchanged', async () => {
    const first = await discountAccount('Settlement Discount');
    const second = await discountAccount('Discount Allowed');
    await withScope(scope(), (tx) =>
      posting.setMapping(tx, manager, {
        eventType: EVENT,
        lineRole: 'settlement_discount',
        accountId: first,
      }),
    );
    const denied: ActorContext = {
      ...manager,
      principal: {
        ...manager.principal,
        grants: manager.principal.grants.filter(
          (grant) => !(grant.object === posting.PERMISSION_OBJECT && grant.verb === 'configure'),
        ),
      },
    };

    await expect(
      withScope(scope(), (tx) =>
        posting.setMapping(tx, denied, {
          eventType: EVENT,
          lineRole: 'settlement_discount',
          accountId: second,
        }),
      ),
    ).rejects.toThrow(PermissionDeniedError);
    await expect(
      withScope(scope(), (tx) =>
        posting.clearMapping(tx, denied, { eventType: EVENT, lineRole: 'settlement_discount' }),
      ),
    ).rejects.toThrow(PermissionDeniedError);

    const { rows } = await ownerPool.query(
      `select account_id, is_active from posting_rule
        where event_type = $1 and line_role = 'settlement_discount'`,
      [EVENT],
    );
    expect(rows).toEqual([{ account_id: first, is_active: true }]);
  });

  it('refuses group, draft and inactive accounts through the database mapping guard', async () => {
    const { rows: groups } = await ownerPool.query(
      `select id from chart_of_account where code = 'R000001'`,
    );
    const { rows: parents } = await ownerPool.query(
      `select id from chart_of_account where code = 'R000001'`,
    );
    const draft = await withScope(scope(), (tx) =>
      coa.createAccount(tx, manager, {
        name: 'Draft Revenue',
        parentId: parents[0].id,
        currencyRestriction: 'IQD',
      }),
    );
    const inactive = await approvedAccount('R000001', 'Inactive Revenue');
    await withScope(scope(), (tx) =>
      coa.deactivate(tx, manager, inactive, 'No longer used'),
    );

    const groupMessage = await rejection(
      withScope(scope(), (tx) =>
        posting.setMapping(tx, manager, {
          eventType: EVENT,
          lineRole: 'group_account',
          accountId: groups[0].id,
        }),
      ),
    );
    const draftMessage = await rejection(
      withScope(scope(), (tx) =>
        posting.setMapping(tx, manager, {
          eventType: EVENT,
          lineRole: 'draft_account',
          accountId: draft.id,
        }),
      ),
    );
    const inactiveMessage = await rejection(
      withScope(scope(), (tx) =>
        posting.setMapping(tx, manager, {
          eventType: EVENT,
          lineRole: 'inactive_account',
          accountId: inactive,
        }),
      ),
    );

    expect(groupMessage).toMatch(/is a group and cannot be mapped/);
    expect(draftMessage).toMatch(/is not approved and active, so it cannot be mapped/);
    expect(inactiveMessage).toMatch(/is not approved and active, so it cannot be mapped/);
  });

  it('unmaps a line without losing the rule the journals point at', async () => {
    const discountAccountId = await discountAccount('Settlement Discount');
    await withScope(scope(), (tx) =>
      posting.setMapping(tx, manager, {
        eventType: EVENT,
        lineRole: 'settlement_discount',
        accountId: discountAccountId,
      }),
    );
    await withScope(scope(), (tx) => posting.post(tx, manager, withDiscount()));

    await withScope(scope(), (tx) =>
      posting.clearMapping(tx, manager, { eventType: EVENT, lineRole: 'settlement_discount' }),
    );

    // Unmapped from here on. A second document number, because the engine
    // answers a repeat of the first from what it already posted.
    const next = {
      ...withDiscount(),
      source: { module: 'sales', documentId: 'INV-000002', event: 'posted' },
    };
    await expect(withScope(scope(), (tx) => posting.post(tx, manager, next))).rejects.toThrow(
      NoPostingRuleError,
    );

    // ...but the rule is still there, because a journal line records the rule
    // it posted through and a deleted rule would take that trail with it.
    const { rows } = await ownerPool.query(
      `select is_active from posting_rule where event_type = $1 and line_role = 'settlement_discount'`,
      [EVENT],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].is_active).toBe(false);
  });
});
