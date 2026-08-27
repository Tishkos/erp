/**
 * Phase 02.2 and 02.3 — fiscal periods and exchange rates, against a real
 * PostgreSQL instance.
 *
 * These two decide *whether* a posting may exist and *at what rate*. Both
 * answers are held outside the document being posted, which is the point of
 * §14.3 and §14.6 — and only a real database can prove that a determined
 * caller cannot get round them.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as periods from '@/server/services/periods';
import * as rates from '@/server/services/exchange-rates';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { NoPeriodForDateError, PeriodClosedError } from '@domain/periods';
import { NoRateForDateError } from '@domain/exchange-rates';
import { PermissionDeniedError } from '@domain/permissions';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '@domain/money';

const BAGHDAD = 'BGW';

let officer: ActorContext;
let manager: ActorContext;

async function createUser(roleCode: string | null): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    'Test User',
  ]);
  if (roleCode) {
    await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [
      id,
      roleCode,
    ]);
  }
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
    id,
    BAGHDAD,
  ]);
  return id;
}

async function contextFor(userId: string): Promise<ActorContext> {
  const principal = await withScope({ userId, branchCode: BAGHDAD }, (tx) =>
    authz.loadPrincipal(tx, userId),
  );
  return { principal, branchCode: BAGHDAD };
}

const scopeOf = (ctx: ActorContext) => ({
  userId: ctx.principal.userId,
  branchCode: BAGHDAD,
});

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  officer = await contextFor(await createUser('accounting_officer'));
  manager = await contextFor(await createUser('accounting_manager'));
});

/** Opens FY2026 as twelve monthly periods. */
async function openFiscalYear() {
  return withScope(scopeOf(manager), (tx) =>
    periods.createFiscalYear(tx, manager, {
      code: 'FY2026',
      startsOn: '2026-01-01',
      endsOn: '2026-12-31',
    }),
  );
}

async function periodNamed(name: string): Promise<string> {
  const { rows } = await ownerPool.query(`select id from fiscal_period where name = $1`, [name]);
  return rows[0].id;
}

// ---------------------------------------------------------------------------
describe('02.2 · the fiscal calendar', () => {
  it('lays out twelve contiguous monthly periods', async () => {
    const { periodCount } = await openFiscalYear();
    expect(periodCount).toBe(12);

    const { rows } = await ownerPool.query(
      `select name, starts_on, ends_on, status from fiscal_period order by starts_on`,
    );
    expect(rows).toHaveLength(12);
    expect(rows[0].name).toBe('January 2026');
    expect(rows[1].starts_on).toBe('2026-02-01');
    expect(rows[1].ends_on).toBe('2026-02-28');
    expect(rows[11].ends_on).toBe('2026-12-31');
    expect(rows.every((r) => r.status === 'open')).toBe(true);
  });

  it('refuses an Accounting Officer opening a fiscal year', async () => {
    // §5.3 — the calendar is configuration, and the Officer holds no
    // `configure` grant on it.
    await expect(
      withScope(scopeOf(officer), (tx) =>
        periods.createFiscalYear(tx, officer, {
          code: 'FY2027',
          startsOn: '2027-01-01',
          endsOn: '2027-12-31',
        }),
      ),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it('refuses two fiscal years that overlap', async () => {
    await openFiscalYear();

    await expect(
      ownerPool.query(
        `insert into fiscal_year (code, name, starts_on, ends_on)
         values ('FY2026B', 'Overlapping', '2026-06-01', '2027-05-31')`,
      ),
    ).rejects.toThrow(/fiscal_year_no_overlap/);
  });

  it('refuses two periods that overlap, so a date resolves to exactly one', async () => {
    await openFiscalYear();
    const { rows } = await ownerPool.query(`select id from fiscal_year limit 1`);

    await expect(
      ownerPool.query(
        `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
         values ($1, 13, 'Overlapping', '2026-03-15', '2026-04-15')`,
        [rows[0].id],
      ),
    ).rejects.toThrow(/fiscal_period_no_overlap/);
  });

  it('refuses a period that falls outside its own fiscal year', async () => {
    await openFiscalYear();
    const { rows } = await ownerPool.query(`select id from fiscal_year limit 1`);

    await expect(
      ownerPool.query(
        `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
         values ($1, 13, 'January 2027', '2027-01-01', '2027-01-31')`,
        [rows[0].id],
      ),
    ).rejects.toThrow(/does not lie within fiscal year FY2026/);
  });

  it('refuses to move a period’s dates once it exists', async () => {
    // Postings already resolve against them; moving them would move postings
    // between periods without anyone posting anything.
    await openFiscalYear();
    const august = await periodNamed('August 2026');

    await expect(
      ownerPool.query(`update fiscal_period set ends_on = '2026-09-15' where id = $1`, [august]),
    ).rejects.toThrow(/dates of period August 2026 cannot be changed/);
  });

  it('refuses a posting date the calendar does not cover', async () => {
    await openFiscalYear();

    await expect(
      withScope(scopeOf(officer), (tx) =>
        periods.authorisePosting(tx, officer, {
          postingDate: '2027-03-01',
          documentType: 'journal_entry',
        }),
      ),
    ).rejects.toThrow(NoPeriodForDateError);
  });
});

// ---------------------------------------------------------------------------
describe('02.2 · soft close (§14.6)', () => {
  beforeEach(openFiscalYear);

  it('lets an ordinary user post into an open period', async () => {
    const permission = await withScope(scopeOf(officer), (tx) =>
      periods.authorisePosting(tx, officer, {
        postingDate: '2026-08-16',
        documentType: 'journal_entry',
      }),
    );

    expect(permission.period.name).toBe('August 2026');
    expect(permission.isOverride).toBe(false);
  });

  it('lets an ordinary user back-date into an earlier open period', async () => {
    // Back-dating is not the exception — a closed period is.
    const permission = await withScope(scopeOf(officer), (tx) =>
      periods.authorisePosting(tx, officer, {
        postingDate: '2026-03-04',
        documentType: 'journal_entry',
      }),
    );

    expect(permission.period.name).toBe('March 2026');
    expect(permission.isOverride).toBe(false);
  });

  it('refuses an ordinary user posting into a soft-closed period', async () => {
    const july = await periodNamed('July 2026');
    await withScope(scopeOf(manager), (tx) =>
      periods.setPeriodStatus(tx, manager, july, 'soft_closed', 'Month-end close'),
    );

    await expect(
      withScope(scopeOf(officer), (tx) =>
        periods.authorisePosting(tx, officer, {
          postingDate: '2026-07-15',
          documentType: 'journal_entry',
        }),
      ),
    ).rejects.toThrow(PeriodClosedError);
  });

  it('lets the Finance Manager post an approved adjustment, and records the override', async () => {
    const july = await periodNamed('July 2026');
    await withScope(scopeOf(manager), (tx) =>
      periods.setPeriodStatus(tx, manager, july, 'soft_closed', 'Month-end close'),
    );

    const permission = await withScope(scopeOf(manager), (tx) =>
      periods.authorisePosting(tx, manager, {
        postingDate: '2026-07-15',
        documentType: 'journal_entry',
        documentId: 'JE-000042',
        overrideReason: 'Audit adjustment AJ-12, approved by Finance',
      }),
    );

    expect(permission.isOverride).toBe(true);

    const { rows } = await ownerPool.query(
      `select posting_date, document_id, reason, actor_user_id from period_override`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      posting_date: '2026-07-15',
      document_id: 'JE-000042',
      reason: 'Audit adjustment AJ-12, approved by Finance',
      actor_user_id: manager.principal.userId,
    });
  });

  it('refuses even the Finance Manager without a reason', async () => {
    const july = await periodNamed('July 2026');
    await withScope(scopeOf(manager), (tx) =>
      periods.setPeriodStatus(tx, manager, july, 'soft_closed', 'Month-end close'),
    );

    await expect(
      withScope(scopeOf(manager), (tx) =>
        periods.authorisePosting(tx, manager, {
          postingDate: '2026-07-15',
          documentType: 'journal_entry',
        }),
      ),
    ).rejects.toThrow(/requires a stated reason/);

    const { rows } = await ownerPool.query(`select count(*)::int as n from period_override`);
    expect(rows[0].n).toBe(0);
  });

  it('holds the override log immutable', async () => {
    const july = await periodNamed('July 2026');
    await withScope(scopeOf(manager), (tx) =>
      periods.setPeriodStatus(tx, manager, july, 'soft_closed', 'Month-end close'),
    );
    await withScope(scopeOf(manager), (tx) =>
      periods.authorisePosting(tx, manager, {
        postingDate: '2026-07-15',
        documentType: 'journal_entry',
        overrideReason: 'Audit adjustment',
      }),
    );

    await expect(
      ownerPool.query(`update period_override set reason = 'routine'`),
    ).rejects.toThrow(/append-only/i);
    await expect(ownerPool.query(`delete from period_override`)).rejects.toThrow(/append-only/i);
  });

  it('reports overrides for a date range — the §24 report', async () => {
    const july = await periodNamed('July 2026');
    await withScope(scopeOf(manager), (tx) =>
      periods.setPeriodStatus(tx, manager, july, 'soft_closed', 'Month-end close'),
    );
    for (const [date, ref] of [
      ['2026-07-10', 'JE-1'],
      ['2026-07-20', 'JE-2'],
    ] as const) {
      await withScope(scopeOf(manager), (tx) =>
        periods.authorisePosting(tx, manager, {
          postingDate: date,
          documentType: 'journal_entry',
          documentId: ref,
          overrideReason: `Adjustment ${ref}`,
        }),
      );
    }

    const report = await withScope(scopeOf(manager), (tx) =>
      periods.overrideReport(tx, '2026-07-01', '2026-07-31'),
    );

    expect(report).toHaveLength(2);
    expect(report.every((r) => r.periodName === 'July 2026')).toBe(true);
    expect(report.map((r) => r.documentId).sort()).toEqual(['JE-1', 'JE-2']);

    const outsideRange = await withScope(scopeOf(manager), (tx) =>
      periods.overrideReport(tx, '2026-08-01', '2026-08-31'),
    );
    expect(outsideRange).toHaveLength(0);
  });

  it('refuses everyone once a period is closed', async () => {
    const july = await periodNamed('July 2026');
    await withScope(scopeOf(manager), (tx) =>
      periods.setPeriodStatus(tx, manager, july, 'closed', 'Year-end'),
    );

    await expect(
      withScope(scopeOf(manager), (tx) =>
        periods.authorisePosting(tx, manager, {
          postingDate: '2026-07-15',
          documentType: 'journal_entry',
          overrideReason: 'Please',
        }),
      ),
    ).rejects.toThrow(/the period is closed/);
  });

  it('does not reopen a closed period from here', async () => {
    const july = await periodNamed('July 2026');
    await withScope(scopeOf(manager), (tx) =>
      periods.setPeriodStatus(tx, manager, july, 'closed', 'Year-end'),
    );

    await expect(
      withScope(scopeOf(manager), (tx) =>
        periods.setPeriodStatus(tx, manager, july, 'open', 'Changed my mind'),
      ),
    ).rejects.toThrow(/year-end action and is not available here/);
  });

  it('audits every status change with its reason', async () => {
    const july = await periodNamed('July 2026');
    await withScope(scopeOf(manager), (tx) =>
      periods.setPeriodStatus(tx, manager, july, 'soft_closed', 'Month-end close for July'),
    );

    const { rows } = await ownerPool.query(
      `select action, reason, before_value, after_value from audit_event
        where object_id = $1 order by id desc limit 1`,
      [july],
    );
    expect(rows[0].action).toBe('fiscal_period.closed');
    expect(rows[0].reason).toBe('Month-end close for July');
    expect(rows[0].before_value).toEqual({ status: 'open' });
    expect(rows[0].after_value).toEqual({ status: 'soft_closed' });
  });
});

// ---------------------------------------------------------------------------
describe('02.3 · currency and exchange rates', () => {
  it('has exactly one ledger currency, and it is IQD (§1.1)', async () => {
    const { rows } = await ownerPool.query(
      `select code, decimals from currency where is_ledger`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe('IQD');

    await expect(
      ownerPool.query(`update currency set is_ledger = true where code = 'USD'`),
    ).rejects.toThrow(/currency_single_ledger_uniq/);
  });

  it('lets the Finance Manager publish a rate and refuses the Officer', async () => {
    await expect(
      withScope(scopeOf(officer), (tx) =>
        rates.publishRate(tx, officer, {
          currency: 'USD',
          iqdPerUnit: '1310.00000000',
          effectiveFrom: '2026-01-01',
        }),
      ),
    ).rejects.toThrow(PermissionDeniedError);

    const published = await withScope(scopeOf(manager), (tx) =>
      rates.publishRate(tx, manager, {
        currency: 'USD',
        iqdPerUnit: '1310.00000000',
        effectiveFrom: '2026-01-01',
        source: 'Central Bank of Iraq',
      }),
    );
    expect(published.id).toBeDefined();
  });

  it('selects the rate in force on the posting date', async () => {
    for (const [from, value] of [
      ['2026-01-01', '1310.00000000'],
      ['2026-03-01', '1320.00000000'],
      ['2026-06-01', '1330.00000000'],
    ] as const) {
      await withScope(scopeOf(manager), (tx) =>
        rates.publishRate(tx, manager, {
          currency: 'USD',
          iqdPerUnit: value,
          effectiveFrom: from,
        }),
      );
    }

    const inApril = await withScope(scopeOf(manager), (tx) =>
      rates.rateOn(tx, 'USD', '2026-04-15'),
    );
    expect(inApril.effectiveFrom).toBe('2026-03-01');
    expect(inApril.iqdPerUnit).toBe(132000000000n);
  });

  it('reproduces a past figure after a later rate is published', async () => {
    // 02.3 gate: "Re-running a report for a past period reproduces the same USD
    // figures it produced originally."
    await withScope(scopeOf(manager), (tx) =>
      rates.publishRate(tx, manager, {
        currency: 'USD',
        iqdPerUnit: '1310.00000000',
        effectiveFrom: '2026-01-01',
      }),
    );

    const before = await withScope(scopeOf(manager), (tx) =>
      rates.convertOn(tx, parseDecimal('1310000.0000', MONEY_SCALE), 'IQD', '2026-02-15'),
    );

    await withScope(scopeOf(manager), (tx) =>
      rates.publishRate(tx, manager, {
        currency: 'USD',
        iqdPerUnit: '1500.00000000',
        effectiveFrom: '2026-06-01',
      }),
    );

    const after = await withScope(scopeOf(manager), (tx) =>
      rates.convertOn(tx, parseDecimal('1310000.0000', MONEY_SCALE), 'IQD', '2026-02-15'),
    );

    expect(toDecimalString(before.amountUsd)).toBe('1000.0000');
    expect(after.amountUsd).toBe(before.amountUsd);
    expect(after.usdRateId).toBe(before.usdRateId);
  });

  it('refuses to edit a published rate — corrections supersede it', async () => {
    const { id } = await withScope(scopeOf(manager), (tx) =>
      rates.publishRate(tx, manager, {
        currency: 'USD',
        iqdPerUnit: '1310.00000000',
        effectiveFrom: '2026-01-01',
      }),
    );

    await expect(
      ownerPool.query(`update exchange_rate set iqd_per_unit = 9999 where id = $1`, [id]),
    ).rejects.toThrow(/cannot be edited/);
    await expect(
      ownerPool.query(`delete from exchange_rate where id = $1`, [id]),
    ).rejects.toThrow(/append-only/i);
  });

  it('supersedes a mistyped rate, keeping the original readable', async () => {
    const wrong = await withScope(scopeOf(manager), (tx) =>
      rates.publishRate(tx, manager, {
        currency: 'USD',
        iqdPerUnit: '13100.00000000', // a zero too many
        effectiveFrom: '2026-01-01',
      }),
    );

    await withScope(scopeOf(manager), (tx) =>
      rates.publishRate(tx, manager, {
        currency: 'USD',
        iqdPerUnit: '1310.00000000',
        effectiveFrom: '2026-01-01',
        source: 'Correction of a typing error',
        supersedes: wrong.id,
      }),
    );

    // Resolution now finds the corrected rate …
    const resolved = await withScope(scopeOf(manager), (tx) =>
      rates.rateOn(tx, 'USD', '2026-05-01'),
    );
    expect(resolved.iqdPerUnit).toBe(131000000000n);

    // … and the original row is still there, saying what it said.
    const { rows } = await ownerPool.query(
      `select iqd_per_unit, superseded_at is not null as superseded from exchange_rate
        where id = $1`,
      [wrong.id],
    );
    expect(rows[0].superseded).toBe(true);
    expect(Number(rows[0].iqd_per_unit)).toBe(13100);
  });

  it('refuses two live rates for the same currency, type and date', async () => {
    await withScope(scopeOf(manager), (tx) =>
      rates.publishRate(tx, manager, {
        currency: 'USD',
        iqdPerUnit: '1310.00000000',
        effectiveFrom: '2026-01-01',
      }),
    );

    const message = await rejection(
      withScope(scopeOf(manager), (tx) =>
        rates.publishRate(tx, manager, {
          currency: 'USD',
          iqdPerUnit: '1320.00000000',
          effectiveFrom: '2026-01-01',
        }),
      ),
    );
    expect(message).toMatch(/exchange_rate_live_uniq/);
  });

  it('falls back to the earliest rate for a date before any of them', async () => {
    await withScope(scopeOf(manager), (tx) =>
      rates.publishRate(tx, manager, {
        currency: 'USD',
        iqdPerUnit: '1310.00000000',
        effectiveFrom: '2026-06-01',
      }),
    );

    const resolved = await withScope(scopeOf(manager), (tx) =>
      rates.rateOn(tx, 'USD', '2026-01-15'),
    );
    expect(resolved.effectiveFrom).toBe('2026-06-01');
    expect(resolved.id).not.toBeNull();
  });

  it('refuses only when the currency has no published rate at all', async () => {
    await expect(
      withScope(scopeOf(manager), (tx) => rates.rateOn(tx, 'USD', '2026-01-15')),
    ).rejects.toThrow(NoRateForDateError);
  });

  it('values the ledger currency at one without a published rate', async () => {
    // No IQD row is inserted by this test, and none is needed: IQD per one IQD
    // is one. Requiring the row made a plain dinar journal unpostable.
    const resolved = await withScope(scopeOf(manager), (tx) => rates.rateOn(tx, 'IQD', '2026-08-27'));
    expect(resolved.iqdPerUnit).toBe(100000000n);
    expect(resolved.id).toBeNull();
  });

  it('keeps eight decimal places on a published rate (A4)', async () => {
    // Carried over from the Phase 00 stack spike. Storing the inverse at four
    // places would round 0.000763 to 0.0008 — a ~5% error on every USD
    // reporting figure §1.1 requires.
    const { id } = await withScope(scopeOf(manager), (tx) =>
      rates.publishRate(tx, manager, {
        currency: 'USD',
        iqdPerUnit: '1310.12345678',
        effectiveFrom: '2026-01-01',
      }),
    );

    const { rows } = await ownerPool.query(
      `select iqd_per_unit::text as rate from exchange_rate where id = $1`,
      [id],
    );
    expect(rows[0].rate).toBe('1310.12345678');

    const resolved = await withScope(scopeOf(manager), (tx) =>
      rates.rateOn(tx, 'USD', '2026-06-01'),
    );
    expect(resolved.iqdPerUnit).toBe(131012345678n);
  });

  it('refuses a non-positive rate at the database as well as in the code', async () => {
    await expect(
      ownerPool.query(
        `insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from)
         values ('USD', 'accounting', 0, '2026-01-01')`,
      ),
    ).rejects.toThrow(/exchange_rate_positive/);
  });

  it('converts a foreign amount into IQD and USD from the date alone', async () => {
    await withScope(scopeOf(manager), (tx) =>
      rates.publishRate(tx, manager, {
        currency: 'USD',
        iqdPerUnit: '1310.00000000',
        effectiveFrom: '2026-01-01',
      }),
    );

    const converted = await withScope(scopeOf(manager), (tx) =>
      rates.convertOn(tx, parseDecimal('100.0000', MONEY_SCALE), 'USD', '2026-08-16'),
    );

    expect(converted.currency).toBe('USD');
    expect(toDecimalString(converted.amountTxn)).toBe('100.0000');
    expect(toDecimalString(converted.amountIqd)).toBe('131000.0000');
    expect(toDecimalString(converted.amountUsd)).toBe('100.0000');
  });

  it('converts IQD at a rate of one, from the seeded rate', async () => {
    await withScope(scopeOf(manager), (tx) =>
      rates.publishRate(tx, manager, {
        currency: 'USD',
        iqdPerUnit: '1310.00000000',
        effectiveFrom: '2026-01-01',
      }),
    );

    const converted = await withScope(scopeOf(manager), (tx) =>
      rates.convertOn(tx, parseDecimal('131000.0000', MONEY_SCALE), 'IQD', '2026-08-16'),
    );

    expect(toDecimalString(converted.amountIqd)).toBe('131000.0000');
    expect(toDecimalString(converted.amountUsd)).toBe('100.0000');
  });

  it('records who entered a rate and where it came from (§4.3)', async () => {
    const { id } = await withScope(scopeOf(manager), (tx) =>
      rates.publishRate(tx, manager, {
        currency: 'USD',
        iqdPerUnit: '1310.00000000',
        effectiveFrom: '2026-01-01',
        source: 'Central Bank of Iraq daily bulletin',
      }),
    );

    const { rows } = await ownerPool.query(
      `select entered_by, source from exchange_rate where id = $1`,
      [id],
    );
    expect(rows[0].entered_by).toBe(manager.principal.userId);
    expect(rows[0].source).toBe('Central Bank of Iraq daily bulletin');

    const audited = await ownerPool.query(
      `select action from audit_event where object_id = $1`,
      [id],
    );
    expect(audited.rows[0].action).toBe('exchange_rate.published');
  });
});
