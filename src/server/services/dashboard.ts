import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { apInvoice, arInvoice, customerReceipt } from '../db/schema';
import { AGEING_BUCKETS, bucketFor, type AgeingBucket } from '../domain/ageing';
import { parseDecimal, toDecimalString } from '../domain/money';
import { can, type Principal } from '../domain/permissions';
import * as approvals from './approvals';
import * as banks from './bank-cash-accounts';
import * as statements from './financial-statements';
import * as integrity from './inventory-integrity';
import { rows as listRows } from './list';
import * as notifications from './notifications';
import * as statement from './partner-statement';

/**
 * What the dashboard shows — REQ-DASH-001.
 *
 * Three rules hold this module together, and all three are about trust in the
 * figures rather than about the screen:
 *
 * 1. **Every band asks the object its own screen asks.** There is no
 *    `dashboard` permission object. A person sees the receivable band because
 *    they may view `ar_invoice`, which is the same reason they may open the
 *    invoice it links to. The dashboard therefore cannot become a way to read
 *    something a role was refused, and it does not need its own grants kept in
 *    step with everybody else's.
 *
 * 2. **Nothing is computed that a service already computes.** The outstanding
 *    on an invoice is `total − settled`, the same expression the payment
 *    allocation uses; the bank balance is where the Bank Statement closes; the
 *    result for the year is `profitOrLoss`. A dashboard that re-derived any of
 *    these would eventually disagree with the report it summarises, and the
 *    disagreement would be discovered by somebody in a meeting.
 *
 * 3. **One band failing must not blank the page.** `band()` runs each read on
 *    its own and answers `null` if it throws, so a slow query or a broken
 *    foreign key costs one band rather than the landing screen. What it must
 *    not do is fail silently — the page renders a line saying that band could
 *    not be read.
 *
 * A band with no rows answers with an empty shape; the page then does not draw
 * it at all. That is deliberate and specified: a heading over an empty box is a
 * promise the screen does not keep.
 */

/** Ran, and what it found — or `null`, meaning it could not be read. */
export type Band<T> = T | null;

const OPEN_INVOICE_STATUSES = ['posted', 'partially_executed', 'settled'] as const;

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Runs one band's read, and swallows nothing.
 *
 * A thrown read answers `null`, which the page renders as "could not be read".
 * The error is re-raised into the server log rather than discarded: a band that
 * disappears with no trace is a bug nobody can find.
 */
async function band<T>(name: string, read: () => Promise<T>): Promise<Band<T>> {
  try {
    return await read();
  } catch (cause) {
    console.error(`[dashboard] the ${name} band could not be read`, cause);
    return null;
  }
}

// ---------------------------------------------------------------- waiting

export interface WaitingItem {
  readonly documentTypeCode: string;
  readonly documentId: string;
  readonly submittedByName: string | null;
  readonly submittedAt: Date;
}

export interface Waiting {
  readonly approvals: readonly WaitingItem[];
  readonly unreadNotifications: number;
}

/**
 * What is waiting on this person.
 *
 * Oldest first, which is `approvals.inbox`'s own order: an approval that has
 * waited nine days is the one that matters, and newest-first buries it under
 * whatever was submitted this morning.
 */
async function waitingFor(tx: Tx, principal: Principal): Promise<Waiting> {
  const [inbox, unread] = await Promise.all([
    can(principal, 'view', approvals.PERMISSION_OBJECT)
      ? approvals.inbox(tx, principal)
      : Promise.resolve([]),
    notifications.inboxFor(tx, principal.userId, { unreadOnly: true }),
  ]);

  return {
    approvals: inbox.map((item) => ({
      documentTypeCode: item.documentTypeCode,
      documentId: item.documentId,
      submittedByName: item.submittedByName,
      submittedAt: item.submittedAt,
    })),
    unreadNotifications: unread.length,
  };
}

// ------------------------------------------------------------------ money

export interface AgeingRow {
  readonly bucket: AgeingBucket;
  /** A decimal string at the money scale, as the services hold it. */
  readonly amountIqd: string;
  readonly invoices: number;
}

export interface Ageing {
  readonly buckets: readonly AgeingRow[];
  readonly totalIqd: string;
  readonly invoices: number;
  /** Everything not in `current` — what is actually late. */
  readonly overdueIqd: string;
}

const MONEY = 4n;

/**
 * Open invoices bucketed by how late they are.
 *
 * Bucketed in TypeScript rather than in SQL on purpose: `bucketFor` is the
 * tested boundary between 30 and 31 days, and a `CASE WHEN` in a query here
 * would be a second copy of those boundaries that nothing checks. The set is
 * small — only invoices with something still owed on them — so reading them to
 * bucket them costs nothing worth the duplication.
 */
function bucketed(
  invoices: readonly { readonly dueDate: string; readonly outstanding: bigint }[],
  asOf: string,
): Ageing {
  const totals = new Map<AgeingBucket, { amount: bigint; count: number }>();
  let total = 0n;
  let overdue = 0n;

  for (const invoice of invoices) {
    const bucket = bucketFor(invoice.dueDate, asOf);
    const held = totals.get(bucket) ?? { amount: 0n, count: 0 };
    totals.set(bucket, { amount: held.amount + invoice.outstanding, count: held.count + 1 });
    total += invoice.outstanding;
    if (bucket !== 'current') overdue += invoice.outstanding;
  }

  return {
    // Every bucket that holds something, in the order the ageing report reads
    // them — current first, then further and further past due.
    buckets: AGEING_BUCKETS.filter((bucket) => totals.has(bucket)).map((bucket) => ({
      bucket,
      amountIqd: toDecimalString(totals.get(bucket)!.amount, MONEY),
      invoices: totals.get(bucket)!.count,
    })),
    totalIqd: toDecimalString(total, MONEY),
    invoices: invoices.length,
    overdueIqd: toDecimalString(overdue, MONEY),
  };
}

/** What customers still owe — `net − allocated`, the invoice's own arithmetic. */
async function receivableAgeing(tx: Tx, branchCode: string, asOf: string): Promise<Ageing> {
  const open = await tx
    .select({ dueDate: arInvoice.dueDate, net: arInvoice.netIqd, allocated: arInvoice.allocatedIqd })
    .from(arInvoice)
    .where(
      and(
        eq(arInvoice.branchCode, branchCode),
        inArray(arInvoice.status, [...OPEN_INVOICE_STATUSES]),
      ),
    );

  return bucketed(
    open
      .map((row) => ({
        dueDate: row.dueDate,
        outstanding: parseDecimal(row.net, MONEY) - parseDecimal(row.allocated, MONEY),
      }))
      .filter((row) => row.outstanding > 0n),
    asOf,
  );
}

/** What the company still owes — `total − settled`. */
async function payableAgeing(tx: Tx, branchCode: string, asOf: string): Promise<Ageing> {
  const open = await tx
    .select({
      dueDate: apInvoice.dueDate,
      total: apInvoice.totalIqd,
      settled: apInvoice.settledAmountIqd,
    })
    .from(apInvoice)
    .where(
      and(
        eq(apInvoice.branchCode, branchCode),
        inArray(apInvoice.status, [...OPEN_INVOICE_STATUSES]),
      ),
    );

  return bucketed(
    open
      .map((row) => ({
        dueDate: row.dueDate,
        outstanding: parseDecimal(row.total, MONEY) - parseDecimal(row.settled, MONEY),
      }))
      .filter((row) => row.outstanding > 0n),
    asOf,
  );
}

export interface AccountBalance {
  readonly code: string;
  readonly name: string;
  readonly kind: 'bank' | 'cash';
  /** Where the Bank/Cash Statement closes today. */
  readonly balanceIqd: string;
}

/**
 * Bank and cash balances, read where the statement reads them.
 *
 * An account whose G/L account is missing is skipped rather than shown at
 * zero — a zero is a figure, and "we do not know" is not zero. It surfaces in
 * the attention band instead, which is where somebody can fix it.
 */
async function balances(tx: Tx, asOf: string): Promise<readonly AccountBalance[]> {
  const accounts = [
    ...(await banks.listOfKind(tx, 'bank')).map((row) => ({ ...row, kind: 'bank' as const })),
    ...(await banks.listOfKind(tx, 'cash')).map((row) => ({ ...row, kind: 'cash' as const })),
  ].filter((account) => account.active && account.glAccountCode);

  return Promise.all(
    accounts.map(async (account) => {
      const ledger = await statement.ledgerStatementFor(
        tx,
        { code: account.code, glAccountCode: account.glAccountCode },
        { to: asOf, currency: 'IQD' },
      );
      return {
        code: account.code,
        name: account.name,
        kind: account.kind,
        balanceIqd: ledger.closing,
      };
    }),
  );
}

// ------------------------------------------------------------- attention

export interface Attention {
  readonly integrityFindings: readonly string[];
  readonly unidentifiedReceipts: number;
  readonly accountsWithoutLedger: readonly string[];
}

/**
 * The things that are wrong. Each is a line somebody can act on, or it does not
 * belong here.
 */
async function attentionFor(tx: Tx, principal: Principal, branchCode: string): Promise<Attention> {
  const mayReadStock = can(principal, 'view', 'inventory_movement');
  const mayReadReceipts = can(principal, 'view', 'customer_receipt');
  const mayReadAccounts = can(principal, 'view', 'bank_account');

  // The same check the 02:15 cron runs. Reading it here puts the finding in
  // front of somebody who has not opened the notification bell.
  const report = mayReadStock ? await integrity.check(tx) : null;

  // §16 — money in the bank whose payer is unknown, sitting in the clearing
  // account until a human says whose it is.
  const unidentified = mayReadReceipts
    ? await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(customerReceipt)
        .where(
          and(
            isNull(customerReceipt.customerId),
            eq(customerReceipt.branchCode, branchCode),
            eq(customerReceipt.status, 'posted'),
          ),
        )
    : [];

  // An account that cannot post, because the G/L account behind it is gone.
  // Read through `listOfKind`, which joins the chart the way the Bank/Cash
  // screen does: `glAccountCode` is null both when nothing was chosen and when
  // what was chosen has since been deleted, and either way the account cannot
  // post. Asking the table for `gl_account_id` would only find the first.
  const stranded = mayReadAccounts
    ? [...(await banks.listOfKind(tx, 'bank')), ...(await banks.listOfKind(tx, 'cash'))]
        .filter((account) => account.active && !account.glAccountCode)
        .map((account) => account.code)
    : [];

  return {
    integrityFindings: report && integrity.findingCount(report) > 0 ? integrity.describe(report) : [],
    unidentifiedReceipts: unidentified[0]?.n ?? 0,
    accountsWithoutLedger: stranded,
  };
}

// ---------------------------------------------------------------- the lot

export interface Activity {
  readonly occurredAt: string;
  readonly action: string;
  readonly objectType: string;
  readonly actor: string;
  readonly outcome: string;
}

export interface Dashboard {
  readonly branchCode: string;
  readonly asOf: string;
  readonly waiting: Band<Waiting>;
  readonly balances: Band<readonly AccountBalance[]>;
  readonly receivable: Band<Ageing>;
  readonly payable: Band<Ageing>;
  readonly result: Band<{ readonly income: string; readonly expenses: string; readonly result: string; readonly from: string; readonly to: string }>;
  readonly activity: Band<readonly Activity[]>;
  readonly attention: Band<Attention>;
}

/**
 * Everything the signed-in person may see, for their active branch, as at
 * today.
 *
 * A band they hold no grant for is `null` — indistinguishable, here, from one
 * that failed. The page treats them differently only in that it never mentions
 * a band the person may not have: saying "you cannot see this" names what is
 * behind the wall, and the absence of a band is not a disclosure while a
 * refusal is.
 */
export async function forPrincipal(
  tx: Tx,
  principal: Principal,
  branchCode: string,
): Promise<Dashboard> {
  const asOf = today();
  const yearStart = `${asOf.slice(0, 4)}-01-01`;

  const [waiting, accountBalances, receivable, payable, result, activity, attention] =
    await Promise.all([
      band('waiting', () => waitingFor(tx, principal)),

      can(principal, 'view', 'bank_account')
        ? band('balances', () => balances(tx, asOf))
        : Promise.resolve(null),

      can(principal, 'view', 'ar_invoice')
        ? band('receivable', () => receivableAgeing(tx, branchCode, asOf))
        : Promise.resolve(null),

      can(principal, 'view', 'ap_invoice')
        ? band('payable', () => payableAgeing(tx, branchCode, asOf))
        : Promise.resolve(null),

      // Income and what it cost, for the year so far. `profitOrLoss` is the
      // Income Statement's own figure, so the dashboard and the statement
      // cannot disagree.
      can(principal, 'view', 'financial_statement')
        ? band('result', async () => {
            const pl = await statements.profitOrLoss(tx, {
              from: yearStart,
              to: asOf,
              branchCode,
              currency: 'IQD',
            });
            return {
              income: pl.totalIncome,
              expenses: pl.totalExpenses,
              result: pl.result,
              from: pl.from,
              to: pl.to,
            };
          })
        : Promise.resolve(null),

      // Who did what. `audit_event` is held by the CEO and the system
      // administrator and by nobody else, so this band is the clearest thing
      // that distinguishes one person's dashboard from another's.
      can(principal, 'view', 'audit_event')
        ? band('activity', async () => {
            const page = await listRows(
              tx,
              principal,
              'audit_event',
              { page: 1, pageSize: 8 },
              { withTotal: false },
            );
            return page.rows.map((row): Activity => ({
              occurredAt: String(row.occurred_at ?? ''),
              action: String(row.action ?? ''),
              objectType: String(row.object_type ?? ''),
              actor: String(row.actor ?? '—'),
              outcome: String(row.outcome ?? ''),
            }));
          })
        : Promise.resolve(null),

      band('attention', () => attentionFor(tx, principal, branchCode)),
    ]);

  return {
    branchCode,
    asOf,
    waiting,
    balances: accountBalances,
    receivable,
    payable,
    result,
    activity,
    attention,
  };
}

/** Whether an attention band holds anything at all. */
export function hasAttention(attention: Attention): boolean {
  return (
    attention.integrityFindings.length > 0 ||
    attention.unidentifiedReceipts > 0 ||
    attention.accountsWithoutLedger.length > 0
  );
}
