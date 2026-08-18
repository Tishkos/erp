/**
 * Daily cash position, cash forecast and currency exposure — Phase 07.8, §17.
 *
 * > §17: *"Daily cash and bank balance by currency and account."* ·
 * > *"Cash forecast combines due A/P, expected A/R, project commitments,
 * > payroll and transfer funding."* · *"Foreign-currency position and funding
 * > requirements."*
 * > §17 acceptance criterion 5: *"Treasury dashboard provides current and
 * > forecast liquidity by currency."*
 *
 * **Nothing here has a table.** Every figure is read from the ledger and from
 * documents that already exist, because a stored forecast is a forecast that
 * goes stale in a way nobody notices. The position is the G/L; the forecast is
 * what the open documents say about the future.
 *
 * **The forecast is a list of named sources, not one query.** §17 names five,
 * and three belong to phases that do not exist yet. Modelling them as sources
 * means those three arrive by filling in a function — and, more importantly,
 * means the report can say *which* sources it drew on. A forecast that silently
 * omitted payroll would be indistinguishable from one where payroll was nil.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { parseDecimal, toDecimalString } from '../domain/money';
import { startOfBucket, type ForecastBucket } from '../domain/cash-forecast';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as treasury from './treasury';

export const PERMISSION_OBJECT = 'bank_cash_account';

export { FORECAST_BUCKETS, startOfBucket, type ForecastBucket } from '../domain/cash-forecast';

// ---------------------------------------------------------------------------
// The daily position — §17
// ---------------------------------------------------------------------------

export interface CurrencyPosition {
  readonly currency: string;
  readonly accounts: number;
  readonly balanceIqd: string;
  readonly availableIqd: string;
}

export interface DailyPosition {
  readonly asOf: string;
  readonly accounts: treasury.AccountBalance[];
  /** §17 — *"by currency and account"*, and by currency means **not** summed. */
  readonly byCurrency: CurrencyPosition[];
  readonly totalIqd: string;
}

/**
 * §17 — *"daily cash and bank balance by currency and account."*
 *
 * The account figures are `treasury.balances`, unchanged: there is one place
 * that answers *"what is in this account"*, and a dashboard computing its own
 * would be a second answer waiting to disagree.
 *
 * The currency grouping is **not** a conversion. Two million dinars and fifteen
 * hundred dollars are two facts; adding them gives a number true of neither, and
 * §17 asks for liquidity *by currency* precisely because a treasurer who can only
 * see the total cannot tell whether they can pay a dollar invoice.
 */
export async function dailyPosition(
  tx: Tx,
  ctx: ActorContext,
  asOf: string,
  filter: { branchCode?: string | null } = {},
): Promise<DailyPosition> {
  const accounts = await treasury.balances(tx, ctx, asOf, {
    branchCode: filter.branchCode ?? null,
  });

  const byCurrency = new Map<string, { accounts: number; balance: bigint; available: bigint }>();

  for (const account of accounts) {
    const current = byCurrency.get(account.currency) ?? { accounts: 0, balance: 0n, available: 0n };
    byCurrency.set(account.currency, {
      accounts: current.accounts + 1,
      balance: current.balance + parseDecimal(account.balanceIqd, 4n),
      available: current.available + parseDecimal(account.availableIqd, 4n),
    });
  }

  return {
    asOf,
    accounts,
    byCurrency: [...byCurrency.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([currency, totals]) => ({
        currency,
        accounts: totals.accounts,
        balanceIqd: toDecimalString(totals.balance, 4n),
        availableIqd: toDecimalString(totals.available, 4n),
      })),
    totalIqd: toDecimalString(
      accounts.reduce((total, account) => total + parseDecimal(account.balanceIqd, 4n), 0n),
      4n,
    ),
  };
}

// ---------------------------------------------------------------------------
// The forecast — §17's five sources
// ---------------------------------------------------------------------------

/** §17's five, in §17's own order. */
export const FORECAST_SOURCES = [
  'ap_due',
  'ar_expected',
  'project_commitments',
  'payroll',
  'transfer_funding',
] as const;

export type ForecastSource = (typeof FORECAST_SOURCES)[number];

export interface SourceStatus {
  readonly source: ForecastSource;
  /** False while the phase that produces this data has not been built. */
  readonly available: boolean;
  readonly note: string;
}

/**
 * What each source can contribute today.
 *
 * Three of §17's five come from phases that do not exist yet, and this says so
 * rather than reporting zero. A treasurer reading a forecast needs to know the
 * difference between *"payroll is nil this month"* and *"payroll is not in
 * here"*, and only one of those is a reason to keep reading.
 */
export const SOURCE_STATUS: readonly SourceStatus[] = [
  { source: 'ap_due', available: true, note: 'Open supplier invoices, by due date (Phase 05).' },
  {
    source: 'ar_expected',
    available: true,
    note: 'Open customer invoices, by due date (Phase 06).',
  },
  {
    source: 'project_commitments',
    available: false,
    note: 'Awaits Phase 11 — project commitments have no document to read until then.',
  },
  {
    source: 'payroll',
    available: false,
    note: 'Awaits Phase 15, itself blocked on D3: payroll shall not be programmed from assumptions (§20).',
  },
  {
    source: 'transfer_funding',
    available: false,
    note: 'Awaits Phase 09 — funding requirements arrive with the transfer register (§12).',
  },
];

export interface ForecastLine {
  readonly periodStart: string;
  readonly source: ForecastSource;
  readonly inflowIqd: string;
  readonly outflowIqd: string;
  readonly netIqd: string;
}

export interface ForecastPeriod {
  readonly periodStart: string;
  readonly openingIqd: string;
  readonly inflowIqd: string;
  readonly outflowIqd: string;
  readonly netIqd: string;
  readonly closingIqd: string;
}

export interface Forecast {
  readonly from: string;
  readonly to: string;
  readonly bucket: ForecastBucket;
  readonly openingIqd: string;
  readonly lines: ForecastLine[];
  readonly periods: ForecastPeriod[];
  readonly closingIqd: string;
  readonly sources: readonly SourceStatus[];
  /** Sources the caller deliberately left out — §17's scenario view. */
  readonly excluded: readonly ForecastSource[];
}

export interface ForecastInput {
  readonly from: string;
  readonly to: string;
  readonly bucket?: ForecastBucket;
  readonly branchCode?: string | null;
  readonly exclude?: readonly ForecastSource[];
}

/**
 * §17 — *"cash forecast combines due A/P, expected A/R, project commitments,
 * payroll and transfer funding."*
 *
 * The opening balance is the real position on the day before the range starts,
 * so the closing figure is a **balance** rather than a movement. Each period
 * opens where the last one closed, which is what makes the day, week and month
 * views agree: the same movements in different-sized boxes, and the same closing
 * balance at the end of the range in all three.
 */
export async function forecast(
  tx: Tx,
  ctx: ActorContext,
  input: ForecastInput,
): Promise<Forecast> {
  await authz.authorize(ctx.principal, 'view', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
  });

  const bucket = input.bucket ?? 'day';
  const excluded = input.exclude ?? [];
  const branchCode = input.branchCode ?? null;

  const opening = await dailyPosition(tx, ctx, dayBefore(input.from), { branchCode });
  const openingIqd = parseDecimal(opening.totalIqd, 4n);

  const movements: { date: string; source: ForecastSource; amountIqd: bigint }[] = [];

  if (!excluded.includes('ap_due')) {
    movements.push(...(await apDue(tx, input.from, input.to, branchCode)));
  }
  if (!excluded.includes('ar_expected')) {
    movements.push(...(await arExpected(tx, input.from, input.to, branchCode)));
  }
  // project_commitments, payroll and transfer_funding contribute nothing until
  // their phases exist. They appear in `sources` either way, so the report says
  // what it drew on rather than leaving the reader to assume.

  const byPeriodSource = new Map<string, { in: bigint; out: bigint }>();
  const byPeriod = new Map<string, { in: bigint; out: bigint }>();

  for (const movement of movements) {
    const periodStart = startOfBucket(movement.date, bucket);
    const key = `${periodStart}|${movement.source}`;

    const line = byPeriodSource.get(key) ?? { in: 0n, out: 0n };
    const period = byPeriod.get(periodStart) ?? { in: 0n, out: 0n };

    if (movement.amountIqd >= 0n) {
      line.in += movement.amountIqd;
      period.in += movement.amountIqd;
    } else {
      line.out -= movement.amountIqd;
      period.out -= movement.amountIqd;
    }

    byPeriodSource.set(key, line);
    byPeriod.set(periodStart, period);
  }

  const lines: ForecastLine[] = [...byPeriodSource.entries()]
    .map(([key, totals]) => {
      const [periodStart, source] = key.split('|') as [string, ForecastSource];
      return {
        periodStart,
        source,
        inflowIqd: toDecimalString(totals.in, 4n),
        outflowIqd: toDecimalString(totals.out, 4n),
        netIqd: toDecimalString(totals.in - totals.out, 4n),
      };
    })
    .sort((a, b) =>
      a.periodStart === b.periodStart
        ? a.source < b.source
          ? -1
          : 1
        : a.periodStart < b.periodStart
          ? -1
          : 1,
    );

  let running = openingIqd;
  const periods: ForecastPeriod[] = [...byPeriod.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([periodStart, totals]) => {
      const periodOpening = running;
      running = running + totals.in - totals.out;
      return {
        periodStart,
        openingIqd: toDecimalString(periodOpening, 4n),
        inflowIqd: toDecimalString(totals.in, 4n),
        outflowIqd: toDecimalString(totals.out, 4n),
        netIqd: toDecimalString(totals.in - totals.out, 4n),
        closingIqd: toDecimalString(running, 4n),
      };
    });

  return {
    from: input.from,
    to: input.to,
    bucket,
    openingIqd: toDecimalString(openingIqd, 4n),
    lines,
    periods,
    closingIqd: toDecimalString(running, 4n),
    sources: SOURCE_STATUS,
    excluded,
  };
}

/** §15 — what has to be paid, and when, from the due dates already recorded. */
async function apDue(
  tx: Tx,
  from: string,
  to: string,
  branchCode: string | null,
): Promise<{ date: string; source: ForecastSource; amountIqd: bigint }[]> {
  const result = (await tx.execute(sql`
    select i.due_date::text                          as "date",
           (i.total_iqd - i.settled_amount_iqd)::text as "amountIqd"
      from ap_invoice i
     where i.status in ('posted', 'partially_executed')
       and i.total_iqd - i.settled_amount_iqd > 0
       and i.due_date between ${from}::date and ${to}::date
       and (${branchCode}::text is null or i.branch_code = ${branchCode})
  `)) as unknown as { rows: { date: string; amountIqd: string }[] };

  // Money going out is negative, so the forecast adds movements rather than
  // remembering which way each source points.
  return result.rows.map((row) => ({
    date: row.date,
    source: 'ap_due' as const,
    amountIqd: -parseDecimal(row.amountIqd, 4n),
  }));
}

/** §16 — what is expected in, from the customer invoices already raised. */
async function arExpected(
  tx: Tx,
  from: string,
  to: string,
  branchCode: string | null,
): Promise<{ date: string; source: ForecastSource; amountIqd: bigint }[]> {
  const result = (await tx.execute(sql`
    select i.due_date::text                   as "date",
           (i.net_iqd - i.allocated_iqd)::text as "amountIqd"
      from ar_invoice i
     where i.status in ('posted', 'partially_executed')
       and i.net_iqd - i.allocated_iqd > 0
       and i.due_date between ${from}::date and ${to}::date
       and (${branchCode}::text is null or i.branch_code = ${branchCode})
  `)) as unknown as { rows: { date: string; amountIqd: string }[] };

  return result.rows.map((row) => ({
    date: row.date,
    source: 'ar_expected' as const,
    amountIqd: parseDecimal(row.amountIqd, 4n),
  }));
}

/** TECHSTACK A10 — plain ISO arithmetic; business dates never touch a clock. */
function dayBefore(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! - 1)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Foreign-currency exposure — §17
// ---------------------------------------------------------------------------

export interface CurrencyExposure {
  readonly currency: string;
  readonly accounts: number;
  readonly balanceIqd: string;
  /** The same money in USD, as the ledger recorded it. */
  readonly balanceUsd: string;
}

/**
 * §17 — *"foreign-currency position and funding requirements."*
 *
 * Reported by currency and **never collapsed to base**. The G/L keeps both an
 * IQD and a USD figure for every line (§14.3), so the exposure is *read* rather
 * than converted: converting at today's rate would answer a question about
 * today's rate, and the exposure is precisely the thing that changes when the
 * rate moves.
 */
export async function currencyExposure(
  tx: Tx,
  ctx: ActorContext,
  asOf: string,
  branchCode?: string | null,
): Promise<CurrencyExposure[]> {
  await authz.authorize(ctx.principal, 'view', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
  });

  const scoped = branchCode ?? null;

  const result = (await tx.execute(sql`
    select b.currency                                  as "currency",
           count(*)::int                               as "accounts",
           coalesce(sum(coalesce((
             select sum(l.debit_iqd - l.credit_iqd)
               from journal_line l
               join journal_entry e on e.id = l.journal_entry_id
              where l.account_id = b.gl_account_id
                and e.posting_date <= ${asOf}::date
                and e.status in ('posted', 'reversed')
           ), 0)), 0)::text                             as "balanceIqd",
           coalesce(sum(coalesce((
             select sum(l.debit_usd - l.credit_usd)
               from journal_line l
               join journal_entry e on e.id = l.journal_entry_id
              where l.account_id = b.gl_account_id
                and e.posting_date <= ${asOf}::date
                and e.status in ('posted', 'reversed')
           ), 0)), 0)::text                             as "balanceUsd"
      from bank_cash_account b
     where b.active
       and (${scoped}::text is null or b.branch_code = ${scoped})
     group by b.currency
     order by b.currency
  `)) as unknown as { rows: CurrencyExposure[] };

  return result.rows;
}
