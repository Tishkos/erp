/**
 * Treasury operations — Phase 07.1 and 07.4, §17.
 *
 * The account master is Phase 03's; this is what happens to it. Three things
 * live here, and they share one property worth naming: **every figure is
 * derived from the ledger, never from a running total kept beside it.**
 *
 * A cached balance on `bank_cash_account` would be faster and would eventually
 * be wrong, and the 07.1 gate is precisely *"each bank/cash account's ledger
 * balance equals its mapped G/L account balance"* — a gate a cached column
 * turns into a reconciliation exercise rather than an identity.
 */
import { and, eq, ne, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { bankCashAccount, bankTransfer, cashCount } from '../db/schema';
import { divideHalfUp, LEDGER_CURRENCY as LEDGER, parseDecimal, toDecimalString } from '../domain/money';
import {
  assertCurrencyMatches,
  assertSufficientFunds,
  assertWithinCashLimit,
  cashCountVariance,
  requiresHigherApproval,
} from '../domain/treasury';
import type { PostingLineRequest } from '../domain/posting';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as posting from './posting';
import * as statuses from './statuses';
import * as journal from './journal';
import * as periods from './periods';
import * as rateService from './exchange-rates';
import { allocateDocumentNumber } from './numbering';
import { countOf, registerPage, searchOf, whereOf, type RegisterPaging } from './register-page';

export const PERMISSION_OBJECT = 'bank_cash_account';
const CASH_COUNT_TYPE = 'cash_count';
const TRANSFER_TYPE = 'bank_transfer';

// ---------------------------------------------------------------------------
// Balances — the 07.1 gate
// ---------------------------------------------------------------------------

export interface AccountBalance {
  readonly accountCode: string;
  readonly accountName: string;
  readonly currency: string;
  readonly glAccountCode: string;
  /** The G/L balance of the mapped account — the one true figure. */
  readonly balanceIqd: string;
  /** Payments approved but not yet executed. Not in the ledger yet. */
  readonly committedIqd: string;
  readonly availableIqd: string;
}

/**
 * §17's daily position, and the 07.1 gate: *"each bank/cash account's ledger
 * balance equals its mapped G/L account balance."*
 *
 * It equals it because it **is** it — this reads the G/L. The gate is therefore
 * not a reconciliation that might fail but an identity that cannot, and the only
 * way to break it would be to map two accounts to one G/L account, which
 * `bank_cash_account_gl_uniq` already forbids.
 *
 * The *committed* figure is the exception and is deliberately not in the ledger:
 * a payment approved this morning and executed tomorrow is money the company has
 * promised and not yet moved. §17 calls the pair *"cleared and book balances"*.
 *
 * Branch filters scope journal and document activity. Bank/cash accounts are
 * company-wide masters.
 *
 * Three things commit money — an approved transfer out, an approved payment
 * batch's unsent lines, and (REQ-AP-001 §15.1) a payment application approved
 * or sent to the bank and not yet confirmed. Both have to count, and the second is why: without it,
 * two payment runs approved on the same morning would each see the whole balance
 * and between them promise it twice (§15, *"available cash"*).
 */
export async function balances(
  tx: Tx,
  ctx: ActorContext,
  asOf: string,
  filter: { branchCode?: string | null; accountCode?: string | null } = {},
): Promise<AccountBalance[]> {
  await authz.authorize(ctx.principal, 'view', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
  });
  return balancesQuery(tx, asOf, filter);
}

/**
 * REQ-AP-001 §15.1 — one account's Booked / Reserved / Available, for a
 * document that has already authorised its own action (the payment
 * application's funds check). The figures are the same query as `balances`.
 */
export async function accountPosition(
  tx: Tx,
  bankCashAccountId: string,
): Promise<{ accountCode: string; currency: string; balanceIqd: bigint; committedIqd: bigint; availableIqd: bigint }> {
  const [account] = await tx
    .select({ code: bankCashAccount.code })
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, bankCashAccountId))
    .limit(1);
  if (!account) throw new Error(`No bank or cash account with id '${bankCashAccountId}'.`);
  const [row] = await balancesQuery(tx, '9999-12-31', { accountCode: account.code });
  const balanceIqd = parseDecimal(row?.balanceIqd ?? '0', 4n);
  const committedIqd = parseDecimal(row?.committedIqd ?? '0', 4n);
  return {
    accountCode: account.code,
    currency: row?.currency ?? 'IQD',
    balanceIqd,
    committedIqd,
    availableIqd: balanceIqd - committedIqd,
  };
}

async function balancesQuery(
  tx: Tx,
  asOf: string,
  filter: { branchCode?: string | null; accountCode?: string | null },
): Promise<AccountBalance[]> {
  const result = await tx.execute(sql`
    select b.code                                  as "accountCode",
           b.name                                  as "accountName",
           b.currency                              as "currency",
           a.code                                  as "glAccountCode",
           coalesce((
             select sum(l.debit_iqd - l.credit_iqd)
               from journal_line l
               join journal_entry e on e.id = l.journal_entry_id
              where l.account_id = b.gl_account_id
                and e.posting_date <= ${asOf}::date
                and e.status in ('posted', 'reversed')
                and (${filter.branchCode ?? null}::text is null or e.branch_code = ${filter.branchCode ?? null})
           ), 0::numeric(19,4))::text              as "balanceIqd",
           -- An approved transfer holds what will leave, in dinars: a dollar
           -- account's transfer is its dollars at the ledger rate of the
           -- transfer date (Currencies & Rates, as valueTransfer posts it),
           -- not its dollar figure read as dinars (REQ-ACC-001 E-4).
           (coalesce((
             select sum(case when t.from_currency = 'IQD' then t.amount
                             else round(t.amount * coalesce(r.iqd_per_unit, 1), 4) end)
               from bank_transfer t
               left join lateral (
                 select x.iqd_per_unit
                   from exchange_rate x
                  where x.currency_code = t.from_currency
                    and x.rate_type = 'accounting'
                    and x.superseded_at is null
                  order by (x.effective_from <= t.transfer_date) desc,
                           case when x.effective_from <= t.transfer_date then x.effective_from end desc nulls last,
                           x.effective_from asc
                  limit 1
               ) r on t.from_currency <> 'IQD'
              where t.from_account_id = b.id
                and t.status = 'approved'
                and (${filter.branchCode ?? null}::text is null or t.branch_code = ${filter.branchCode ?? null})
           ), 0::numeric(19,4))
            + coalesce((
             select sum(l.amount_iqd)
               from payment_batch_line l
               join payment_batch p on p.id = l.batch_id
              where p.bank_cash_account_id = b.id
                and p.status = 'approved'
                and l.status = 'pending'
                and (${filter.branchCode ?? null}::text is null or p.branch_code = ${filter.branchCode ?? null})
           ), 0::numeric(19,4))
            -- REQ-AP-001 §15.1 — money held for payment applications approved
            -- or sent to the bank and not yet confirmed.
            -- (company-wide, like the account: see migration 0232).
            + payment_application_reserved_iqd(b.id))::text as "committedIqd"
      from bank_cash_account b
      join chart_of_account a on a.id = b.gl_account_id
     where b.active
       and (${filter.accountCode ?? null}::text is null or b.code = ${filter.accountCode ?? null})
     order by b.code
  `);

  const rows = (result as unknown as { rows: Omit<AccountBalance, 'availableIqd'>[] }).rows;

  return rows.map((row) => ({
    ...row,
    availableIqd: toDecimalString(
      parseDecimal(row.balanceIqd, 4n) - parseDecimal(row.committedIqd, 4n),
      4n,
    ),
  }));
}

/** One account's position, for the checks below. */
async function positionOf(tx: Tx, ctx: ActorContext, accountId: string) {
  const [account] = await tx
    .select()
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, accountId))
    .limit(1);

  if (!account) throw new Error(`No bank or cash account with id '${accountId}'.`);

  const [position] = await balances(tx, ctx, todayIsoOf(tx), { accountCode: account.code });

  return {
    account,
    balanceIqd: parseDecimal(position?.balanceIqd ?? '0', 4n),
    committedIqd: parseDecimal(position?.committedIqd ?? '0', 4n),
  };
}

/**
 * The business date the caller is working in.
 *
 * Treasury has no clock of its own: every figure is `as of` a date the caller
 * states, because a balance "now" is a balance in somebody's timezone and
 * TECHSTACK A10 keeps business dates out of that argument. This exists so the
 * internal helpers have one obvious thing to pass, and it deliberately reads the
 * database's own date rather than the process's.
 */
function todayIsoOf(_tx: Tx): string {
  // A far-future ceiling: these checks want the *whole* ledger, not a cut-off.
  // A real "as of today" is always supplied by the caller through `balances`.
  return '9999-12-31';
}

// ---------------------------------------------------------------------------
// Payment validation — §17, used by 07.2 and by Phase 05's supplier payments
// ---------------------------------------------------------------------------

export interface PaymentCheck {
  readonly accountCode: string;
  readonly requiresHigherApproval: boolean;
  readonly availableIqd: bigint;
}

/**
 * The three §17 checks a payment out of an account must pass, in one place.
 *
 * Together rather than scattered, because they fail for different reasons and a
 * caller that remembered two of the three would be a caller whose payments are
 * *nearly* controlled. The currency and funds checks throw; the approval
 * question is returned, because "who signs" is a routing decision rather than a
 * refusal.
 */
export async function checkPayment(
  tx: Tx,
  ctx: ActorContext,
  input: {
    readonly bankCashAccountId: string;
    readonly amountIqd: bigint;
    readonly currency: string;
    readonly approvedFxConversion?: boolean;
  },
): Promise<PaymentCheck> {
  const { account, balanceIqd, committedIqd } = await positionOf(
    tx,
    ctx,
    input.bankCashAccountId,
  );

  // §17 — the account's currency and the payment's must agree.
  assertCurrencyMatches(account.code, account.currency, input.currency, {
    approvedFxConversion: input.approvedFxConversion ?? false,
  });

  // …and the money must actually be there.
  assertSufficientFunds(account.code, { balanceIqd, committedIqd }, input.amountIqd);

  return {
    accountCode: account.code,
    requiresHigherApproval: requiresHigherApproval(
      input.amountIqd,
      account.approvalLimitIqd === null ? null : parseDecimal(account.approvalLimitIqd, 4n),
    ),
    availableIqd: balanceIqd - committedIqd,
  };
}

// ---------------------------------------------------------------------------
// Cash count — §17
// ---------------------------------------------------------------------------

export async function countCash(
  tx: Tx,
  ctx: ActorContext,
  input: {
    readonly bankCashAccountId: string;
    readonly countDate: string;
    readonly countedIqd: bigint;
    readonly varianceReason?: string | null;
    readonly note?: string | null;
  },
): Promise<{ id: string; countNo: string; varianceIqd: bigint; direction: string }> {
  const [account] = await tx
    .select()
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, input.bankCashAccountId))
    .limit(1);

  if (!account) throw new Error(`No bank or cash account with id '${input.bankCashAccountId}'.`);

  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
  });

  // The book figure is read at the moment of the count and stored with it. Read
  // again later it would have moved, and the count would be comparing a drawer
  // on Tuesday with a ledger on Friday.
  const [position] = await balances(tx, ctx, input.countDate, {
    accountCode: account.code,
    branchCode: ctx.branchCode,
  });
  const bookIqd = parseDecimal(position?.balanceIqd ?? '0', 4n);

  const variance = cashCountVariance({ countedIqd: input.countedIqd, bookIqd });

  const allocated = await allocateDocumentNumber(
    tx,
    'CASH_COUNT',
    { branchCode: ctx.branchCode, year: Number(input.countDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(cashCount)
    .values({
      countNo: allocated.documentNo,
      bankCashAccountId: input.bankCashAccountId,
      branchCode: ctx.branchCode,
      countDate: input.countDate,
      countedIqd: toDecimalString(input.countedIqd, 4n),
      bookIqd: toDecimalString(bookIqd, 4n),
      varianceIqd: toDecimalString(variance.varianceIqd, 4n),
      custodianUserId: account.custodianUserId,
      varianceReason: input.varianceReason ?? null,
      note: input.note ?? null,
      countedBy: ctx.principal.userId,
    })
    .returning({ id: cashCount.id });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'cash_count.counted',
    objectType: CASH_COUNT_TYPE,
    objectId: created!.id,
    branchCode: ctx.branchCode,
    outcome: 'success',
    after: {
      countNo: allocated.documentNo,
      accountCode: account.code,
      countedIqd: toDecimalString(input.countedIqd, 4n),
      bookIqd: toDecimalString(bookIqd, 4n),
      varianceIqd: toDecimalString(variance.varianceIqd, 4n),
      direction: variance.direction,
    },
  });

  return {
    id: created!.id,
    countNo: allocated.documentNo,
    varianceIqd: variance.varianceIqd,
    direction: variance.direction,
  };
}

/**
 * §17 — a variance is approved by somebody, with a reason.
 *
 * A count that agreed needs no approval and posts nothing: there is nothing to
 * decide and nothing to record. Approving an exact count would be ceremony.
 */
export async function approveCount(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  varianceReason?: string | null,
): Promise<void> {
  const count = await loadCount(tx, id);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: count.branchCode,
    objectId: id,
  });

  const variance = parseDecimal(count.varianceIqd, 4n);

  if (variance === 0n) {
    throw new Error(
      `Cash count ${count.countNo} found exactly what the books said. There is nothing to approve — ` +
        'an approval on an agreeing count would be a signature on nothing.',
    );
  }

  const reason = varianceReason?.trim() || count.varianceReason?.trim();
  if (!reason) {
    throw new Error(
      `Cash count ${count.countNo} has a variance of ${count.varianceIqd} and no explanation. ` +
        '§17 wants the reason recorded: a variance nobody accounts for is the one that repeats.',
    );
  }

  await statuses.assertTransitionAllowed(tx, CASH_COUNT_TYPE, count.status, 'approved');

  await tx
    .update(cashCount)
    .set({
      status: 'approved',
      varianceReason: reason,
      approvedBy: ctx.principal.userId,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(cashCount.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'cash_count.approved',
    objectType: CASH_COUNT_TYPE,
    objectId: id,
    branchCode: count.branchCode,
    outcome: 'success',
    reason,
    before: { status: count.status },
    after: { status: 'approved', varianceIqd: count.varianceIqd },
  });
}

/** Posts the variance: Dr or Cr the cash account against a variance account. */
export async function postCount(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ journalEntryId: string }> {
  const count = await loadCount(tx, id);

  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, {
    branchCode: count.branchCode,
    objectId: id,
  });

  await statuses.assertTransitionAllowed(tx, CASH_COUNT_TYPE, count.status, 'posted');

  const variance = parseDecimal(count.varianceIqd, 4n);
  const magnitude = variance < 0n ? -variance : variance;

  const [account] = await tx
    .select()
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, count.bankCashAccountId))
    .limit(1);

  const criteria = { branchCode: count.branchCode };
  const dimensions = { branch: count.branchCode };

  // A surplus debits the cash account and credits the variance account; a
  // shortfall does the reverse. Written as one pair with the sides chosen,
  // rather than two branches, so the two cases cannot drift apart.
  const glAccountId = account!.glAccountId;

  const lines: PostingLineRequest[] =
    variance > 0n
      ? [
          { role: 'bank_cash', accountId: glAccountId, debit: toDecimalString(magnitude, 4n), criteria, dimensions },
          { role: 'cash_variance', credit: toDecimalString(magnitude, 4n), criteria, dimensions },
        ]
      : [
          { role: 'cash_variance', debit: toDecimalString(magnitude, 4n), criteria, dimensions },
          { role: 'bank_cash', accountId: glAccountId, credit: toDecimalString(magnitude, 4n), criteria, dimensions },
        ];

  const result = await posting.post(tx, ctx, {
    eventType: 'treasury.cash_count',
    documentTypeCode: CASH_COUNT_TYPE,
    source: { module: 'treasury', documentId: id, event: 'posted' },
    branchCode: count.branchCode,
    documentDate: count.countDate,
    postingDate: count.countDate,
    description: `Cash count ${count.countNo} — ${account?.code ?? 'account'} ${count.varianceIqd}`,
    lines,
  });

  await tx
    .update(cashCount)
    .set({
      status: 'posted',
      journalEntryId: result.journalEntryId,
      postedBy: ctx.principal.userId,
      postedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(cashCount.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'cash_count.posted',
    objectType: CASH_COUNT_TYPE,
    objectId: id,
    branchCode: count.branchCode,
    outcome: 'success',
    before: { status: count.status },
    after: { status: 'posted', journalEntryId: result.journalEntryId },
  });

  return { journalEntryId: result.journalEntryId };
}

async function loadCount(tx: Tx, id: string) {
  const [count] = await tx.select().from(cashCount).where(eq(cashCount.id, id)).limit(1);
  if (!count) throw new Error(`No cash count with id '${id}'.`);
  return count;
}

// ---------------------------------------------------------------------------
// Inter-account transfer — §17, Phase 07.4
// ---------------------------------------------------------------------------

export interface CreateTransferInput {
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly transferDate: string;
  /**
   * What leaves the source account, **in the source account's currency** —
   * the name predates cross-currency transfers, when every account was IQD.
   */
  readonly amountIqd: bigint;
  /** What arrives, in the destination's currency. Required (or implied by the rate) across currencies. */
  readonly receivedAmount?: bigint;
  /**
   * The approved rate (§17, §14.3). With one side in dinars it is dinars per
   * unit of the other currency — Currencies & Rates' own convention; between
   * two foreign currencies it is destination units per source unit. Left out
   * when both amounts are given, it is read off them.
   */
  readonly fxRate?: string | null;
  readonly bankReference?: string | null;
  readonly note?: string | null;
  /**
   * The one-time id the Internal Transfers form mints: a second submit of the
   * same form answers with the transfer the first one made, rather than
   * moving the money twice.
   */
  readonly documentId?: string | null;
}

const RATE = 8n;
const RATE_UNIT = 10n ** RATE;
/** A converted figure may differ from the typed one by rounding, never by more than one unit. */
const CONVERSION_TOLERANCE = 10n ** 4n;

/** What arrives, from what left and the rate — in the rate's convention above. */
function convertWithRate(amount: bigint, rate: bigint, fromCurrency: string, toCurrency: string): bigint {
  if (fromCurrency === LEDGER && toCurrency !== LEDGER) return divideHalfUp(amount * RATE_UNIT, rate);
  return divideHalfUp(amount * rate, RATE_UNIT);
}

/** The rate two amounts imply — the same convention, to eight places. */
function rateOf(amount: bigint, received: bigint, fromCurrency: string, toCurrency: string): bigint {
  if (fromCurrency === LEDGER && toCurrency !== LEDGER) return divideHalfUp(amount * RATE_UNIT, received);
  return divideHalfUp(received * RATE_UNIT, amount);
}

export class TransferNotFoundError extends Error {
  readonly code = 'BANK_TRANSFER_NOT_FOUND';
  constructor(readonly transferNo: string) {
    super(`No internal transfer numbered ${transferNo}.`);
  }
}

export async function createTransfer(
  tx: Tx,
  ctx: ActorContext,
  input: CreateTransferInput,
): Promise<{ id: string; transferNo: string }> {
  // A repeated submit of the same form: the transfer it already made.
  if (input.documentId) {
    const [existing] = await tx
      .select({ id: bankTransfer.id, transferNo: bankTransfer.transferNo })
      .from(bankTransfer)
      .where(eq(bankTransfer.id, input.documentId))
      .limit(1);
    if (existing) return existing;
  }

  if (input.fromAccountId === input.toAccountId) {
    throw new Error('The money is already in that account. Choose a different destination.');
  }

  const [from] = await tx
    .select()
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, input.fromAccountId))
    .limit(1);
  const [to] = await tx
    .select()
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, input.toAccountId))
    .limit(1);

  if (!from || !to) throw new Error('Both accounts must exist to transfer between them.');
  // Only the accounts Master Data keeps open: a closed account is a place
  // money used to be, and a transfer into it would be money nobody looks for.
  for (const account of [from, to]) {
    if (!account.active) {
      throw new Error(`${account.code} is inactive. Reactivate it under Master Data, or choose another account.`);
    }
  }

  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
  });

  if (input.amountIqd <= 0n) {
    throw new Error('State the amount that leaves the source account; it must be more than nothing.');
  }

  // A closed period takes nothing new. Caught here, when the form is filled
  // in, rather than at posting, after somebody else has approved it.
  const period = await periods.periodFor(tx, input.transferDate);
  if (period.status === 'closed') {
    throw new Error(`${period.name} is closed; a transfer cannot be dated in it.`);
  }

  const crossCurrency = from.currency !== to.currency;

  if (crossCurrency && !input.fxRate && !(input.receivedAmount && input.receivedAmount > 0n)) {
    throw new Error(
      `${from.code} is held in ${from.currency} and ${to.code} in ${to.currency}. §17 allows the ` +
        'transfer through an approved FX conversion, and the rate is part of the approval — ' +
        'state it, rather than having the system pick one (§14.3).',
    );
  }

  if (!crossCurrency && input.fxRate) {
    throw new Error(
      `${from.code} and ${to.code} are both held in ${from.currency}, so there is no conversion to rate.`,
    );
  }

  let receivedAmount = input.amountIqd;
  let fxRate: string | null = null;
  if (crossCurrency) {
    const typedRate = input.fxRate ? parseDecimal(input.fxRate, RATE) : null;
    if (typedRate !== null && typedRate <= 0n) throw new Error('A rate is more than nothing.');
    const typedReceived = input.receivedAmount && input.receivedAmount > 0n ? input.receivedAmount : null;

    if (typedRate !== null && typedReceived !== null) {
      // Both stated: they must say the same thing. Otherwise one of them is a
      // typing mistake and the journal would book whichever was believed.
      const implied = convertWithRate(input.amountIqd, typedRate, from.currency, to.currency);
      const gap = implied > typedReceived ? implied - typedReceived : typedReceived - implied;
      if (gap > CONVERSION_TOLERANCE) {
        throw new Error(
          `At ${input.fxRate}, ${from.currency} ${toDecimalString(input.amountIqd, 4n)} is ` +
            `${to.currency} ${toDecimalString(implied, 4n)}, not ${toDecimalString(typedReceived, 4n)}. ` +
            'Correct the rate or the amount received.',
        );
      }
      receivedAmount = typedReceived;
      fxRate = toDecimalString(typedRate, RATE);
    } else if (typedRate !== null) {
      receivedAmount = convertWithRate(input.amountIqd, typedRate, from.currency, to.currency);
      fxRate = toDecimalString(typedRate, RATE);
    } else {
      receivedAmount = typedReceived!;
      fxRate = toDecimalString(rateOf(input.amountIqd, receivedAmount, from.currency, to.currency), RATE);
    }

    if (receivedAmount <= 0n) {
      throw new Error(
        'A cross-currency transfer records what arrived as well as what left — the two are different ' +
          'numbers, and only recording one leaves the other to be inferred.',
      );
    }
  }

  // §17 — the money has to be there before it can go anywhere. The balance is
  // the ledger's, in dinars, so what leaves is valued in dinars too — through
  // Currencies & Rates, never a rate of this module's own.
  const sourceIqd = (await rateService.convertOn(tx, input.amountIqd, from.currency, input.transferDate)).amountIqd;
  const { balanceIqd, committedIqd } = await positionOf(tx, ctx, input.fromAccountId);
  assertSufficientFunds(from.code, { balanceIqd, committedIqd }, sourceIqd);

  // §17 — a float has a ceiling, and receiving is how it is breached.
  if (to.accountType === 'cash') {
    const receivedIqd = (await rateService.convertOn(tx, receivedAmount, to.currency, input.transferDate)).amountIqd;
    const [toPosition] = await balances(tx, ctx, input.transferDate, { accountCode: to.code });
    assertWithinCashLimit(
      to.code,
      to.cashLimitIqd === null ? null : parseDecimal(to.cashLimitIqd, 4n),
      parseDecimal(toPosition?.balanceIqd ?? '0', 4n) + receivedIqd,
    );
  }

  const allocated = await allocateDocumentNumber(
    tx,
    'BANK_TRANSFER',
    { branchCode: ctx.branchCode, year: Number(input.transferDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(bankTransfer)
    .values({
      ...(input.documentId ? { id: input.documentId } : {}),
      transferNo: allocated.documentNo,
      fromAccountId: input.fromAccountId,
      toAccountId: input.toAccountId,
      branchCode: ctx.branchCode,
      transferDate: input.transferDate,
      amount: toDecimalString(input.amountIqd, 4n),
      fromCurrency: from.currency,
      receivedAmount: toDecimalString(receivedAmount, 4n),
      toCurrency: to.currency,
      fxRate,
      bankReference: input.bankReference ?? null,
      note: input.note ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: bankTransfer.id });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'bank_transfer.created',
    objectType: TRANSFER_TYPE,
    objectId: created!.id,
    branchCode: ctx.branchCode,
    outcome: 'success',
    after: {
      transferNo: allocated.documentNo,
      from: from.code,
      to: to.code,
      amount: toDecimalString(input.amountIqd, 4n),
      receivedAmount: toDecimalString(receivedAmount, 4n),
      fxRate,
    },
  });

  return { id: created!.id, transferNo: allocated.documentNo };
}

export async function approveTransfer(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const transfer = await loadTransfer(tx, id, { lock: true });

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: transfer.branchCode,
    objectId: id,
  });

  await statuses.assertTransitionAllowed(tx, TRANSFER_TYPE, transfer.status, 'approved');

  await tx
    .update(bankTransfer)
    .set({
      status: 'approved',
      approvedBy: ctx.principal.userId,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(bankTransfer.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'bank_transfer.approved',
    objectType: TRANSFER_TYPE,
    objectId: id,
    branchCode: transfer.branchCode,
    outcome: 'success',
    before: { status: transfer.status },
    after: { status: 'approved' },
  });
}

/**
 * Approval from the Internal Transfers screen: by somebody other than whoever
 * raised it — one person moves the money, another agrees to it. The Super
 * User approves alone, as everywhere (by direction, 2026-10-03).
 */
export async function approveTransferAsChecker(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const transfer = await loadTransfer(tx, id);
  if (transfer.createdBy === ctx.principal.userId && !ctx.principal.isSuperUser) {
    throw new Error(`${transfer.transferNo} was raised by you; somebody else approves it.`);
  }
  await approveTransfer(tx, ctx, id);
}

export interface TransferValuation {
  /** What left, in dinars at the ledger rate of the day (Currencies & Rates). */
  readonly sourceIqd: bigint;
  /** What arrived, in dinars at the ledger rate of the day. */
  readonly destinationIqd: bigint;
  /** Destination less source: a gain when positive, a loss when negative, nothing between one currency. */
  readonly differenceIqd: bigint;
}

/**
 * The dinar value of each leg — the figures the journal will carry.
 *
 * The ledger is kept in dinars, so a leg in another currency is converted at
 * the ledger rate of the transfer date by `exchange-rates.convertOn`, the one
 * conversion every module uses. A dinar leg is its own value. Between one
 * currency the two legs are the same number and there is no difference.
 */
export async function valueTransfer(
  tx: Tx,
  transfer: {
    readonly amount: string;
    readonly fromCurrency: string;
    readonly receivedAmount: string;
    readonly toCurrency: string;
    readonly transferDate: string;
  },
): Promise<TransferValuation> {
  const amount = parseDecimal(transfer.amount, 4n);
  const received = parseDecimal(transfer.receivedAmount, 4n);
  const sourceIqd = (await rateService.convertOn(tx, amount, transfer.fromCurrency, transfer.transferDate)).amountIqd;
  const destinationIqd =
    transfer.fromCurrency === transfer.toCurrency
      ? sourceIqd
      : (await rateService.convertOn(tx, received, transfer.toCurrency, transfer.transferDate)).amountIqd;
  return { sourceIqd, destinationIqd, differenceIqd: destinationIqd - sourceIqd };
}

/**
 * §17 — *"debits one account and credits the other in a single balanced
 * journal."*
 *
 * One journal, both legs, in dinars. Between one currency the two legs are the
 * same figure: destination up by exactly what the source went down, and
 * nothing for revenue or expense. Across currencies each leg is valued at the
 * ledger rate of the day (`valueTransfer`), and what the bank's rate gave
 * beyond or short of that is an exchange gain or loss — through the same two
 * roles a loan repayment and an import's exchange difference use, mapped on
 * Posting Mappings under `treasury.bank_transfer`. (It used to put both legs'
 * own-currency figures straight into a dinar journal, so a dollar transfer
 * could never balance — 2026-10-04.)
 */
export async function postTransfer(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ journalEntryId: string }> {
  const transfer = await loadTransfer(tx, id, { lock: true });

  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, {
    branchCode: transfer.branchCode,
    objectId: id,
  });

  await statuses.assertTransitionAllowed(tx, TRANSFER_TYPE, transfer.status, 'posted');

  const [from] = await tx
    .select({ code: bankCashAccount.code, glAccountId: bankCashAccount.glAccountId })
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, transfer.fromAccountId))
    .limit(1);
  const [to] = await tx
    .select({ code: bankCashAccount.code, glAccountId: bankCashAccount.glAccountId })
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, transfer.toAccountId))
    .limit(1);

  const criteria = { branchCode: transfer.branchCode };
  const dimensions = { branch: transfer.branchCode };
  const value = await valueTransfer(tx, transfer);

  // The accounts are named directly rather than through a §3.3 mapping: which
  // G/L account a bank account sits in is already configured on the account
  // itself, and a mapping would be a second answer to a question that has one.
  const lines: PostingLineRequest[] = [
    {
      role: 'bank_cash',
      accountId: to!.glAccountId,
      debit: toDecimalString(value.destinationIqd, 4n),
      criteria,
      dimensions,
      bankAccountCode: to!.code,
      description: `Into ${to!.code}`,
    },
    {
      role: 'bank_cash',
      accountId: from!.glAccountId,
      credit: toDecimalString(value.sourceIqd, 4n),
      criteria,
      dimensions,
      bankAccountCode: from!.code,
      description: `Out of ${from!.code}`,
    },
    ...(value.differenceIqd > 0n
      ? [{ role: 'exchange_gain', credit: toDecimalString(value.differenceIqd, 4n), criteria, dimensions }]
      : []),
    ...(value.differenceIqd < 0n
      ? [{ role: 'exchange_loss', debit: toDecimalString(-value.differenceIqd, 4n), criteria, dimensions }]
      : []),
  ];

  const result = await posting.post(tx, ctx, {
    eventType: 'treasury.bank_transfer',
    documentTypeCode: TRANSFER_TYPE,
    source: { module: 'treasury', documentId: id, event: 'posted' },
    branchCode: transfer.branchCode,
    documentDate: transfer.transferDate,
    postingDate: transfer.transferDate,
    description: `Transfer ${transfer.transferNo} — ${from!.code} to ${to!.code}`,
    lines,
  });

  await tx
    .update(bankTransfer)
    .set({
      status: 'posted',
      journalEntryId: result.journalEntryId,
      postedBy: ctx.principal.userId,
      postedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(bankTransfer.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'bank_transfer.posted',
    objectType: TRANSFER_TYPE,
    objectId: id,
    branchCode: transfer.branchCode,
    outcome: 'success',
    before: { status: transfer.status },
    after: {
      status: 'posted',
      journalEntryId: result.journalEntryId,
      sourceIqd: toDecimalString(value.sourceIqd, 4n),
      destinationIqd: toDecimalString(value.destinationIqd, 4n),
    },
  });

  return { journalEntryId: result.journalEntryId };
}

/**
 * Correcting a posted transfer — never by editing it.
 *
 * The journal is mirrored by `journal.reverse`, the one reversal the ledger
 * has (its own grant, `reverse_cancel` on journal entries, and its own rule:
 * dated today, so today's period must be open). The transfer keeps every
 * figure it had and says it was reversed, by whom and why; a corrected one is
 * raised afresh. Both journals stay, linked.
 */
export async function reverseTransfer(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: { readonly reason: string },
): Promise<{ reversalEntryNo: string }> {
  const transfer = await loadTransfer(tx, id, { lock: true });

  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, {
    branchCode: transfer.branchCode,
    objectId: id,
  });

  const reason = input.reason?.trim() ?? '';
  if (!reason) throw new Error('A reversal says why the transfer was wrong; give a reason.');

  await statuses.assertTransitionAllowed(tx, TRANSFER_TYPE, transfer.status, 'reversed', reason);
  if (!transfer.journalEntryId) {
    throw new Error(`${transfer.transferNo} has no journal to reverse.`);
  }

  const reversal = await journal.reverse(tx, ctx, transfer.journalEntryId, { reason });

  const now = new Date();
  await tx
    .update(bankTransfer)
    .set({
      status: 'reversed',
      reversedBy: ctx.principal.userId,
      reversedAt: now,
      reversalReason: reason,
      updatedAt: now,
    })
    .where(eq(bankTransfer.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'bank_transfer.reversed',
    objectType: TRANSFER_TYPE,
    objectId: id,
    branchCode: transfer.branchCode,
    outcome: 'success',
    before: { status: transfer.status, journalEntryId: transfer.journalEntryId },
    after: { status: 'reversed', reversalEntryNo: reversal.entryNo },
    reason,
    relatedObjectId: reversal.id,
  });

  return { reversalEntryNo: reversal.entryNo };
}

// ---------------------------------------------------------------------------
// Internal Transfers — the register and the record (2026-10-04)
// ---------------------------------------------------------------------------

export const TRANSFER_VIEWS = ['open', 'posted', 'reversed'] as const;
export type TransferView = (typeof TRANSFER_VIEWS)[number];

export interface TransferRow {
  readonly id: string;
  readonly transferNo: string;
  readonly transferDate: string;
  readonly status: string;
  readonly branchCode: string;
  readonly fromCode: string;
  readonly fromName: string;
  readonly fromKind: 'bank' | 'cash';
  readonly fromCurrency: string;
  readonly toCode: string;
  readonly toName: string;
  readonly toKind: 'bank' | 'cash';
  readonly toCurrency: string;
  readonly amount: string;
  readonly receivedAmount: string;
  readonly fxRate: string | null;
  readonly bankReference: string | null;
  readonly note: string | null;
  readonly createdBy: string;
  readonly createdByName: string | null;
  readonly approvedByName: string | null;
  readonly postedByName: string | null;
  readonly reversedByName: string | null;
  readonly reversalReason: string | null;
  readonly journalEntryNo: string | null;
  readonly reversalEntryNo: string | null;
}

/** Every transfer, with its two accounts, its people and its journals — one relation the screens read. */
const TRANSFERS = sql`(
  select t.id::text as id, t.transfer_no, t.transfer_date::text as transfer_date, t.status::text as status,
         t.branch_code, fa.code as from_code, fa.name as from_name, fa.account_type::text as from_kind,
         t.from_currency, ta.code as to_code, ta.name as to_name, ta.account_type::text as to_kind,
         t.to_currency, t.amount::text as amount, t.received_amount::text as received_amount,
         t.fx_rate::text as fx_rate, t.bank_reference, t.note, t.created_by::text as created_by,
         cu.display_name as created_by_name, au.display_name as approved_by_name,
         pu.display_name as posted_by_name, ru.display_name as reversed_by_name, t.reversal_reason,
         je.entry_no as journal_entry_no, rje.entry_no as reversal_entry_no, t.created_at
    from bank_transfer t
    join bank_cash_account fa on fa.id = t.from_account_id
    join bank_cash_account ta on ta.id = t.to_account_id
    left join app_user cu on cu.id = t.created_by
    left join app_user au on au.id = t.approved_by
    left join app_user pu on pu.id = t.posted_by
    left join app_user ru on ru.id = t.reversed_by
    left join journal_entry je on je.id = t.journal_entry_id
    left join journal_entry rje on rje.id = je.reversed_by_id
) x`;

const transferRow = (row: Record<string, unknown>): TransferRow => ({
  id: String(row.id),
  transferNo: String(row.transfer_no),
  transferDate: String(row.transfer_date),
  status: String(row.status),
  branchCode: String(row.branch_code),
  fromCode: String(row.from_code),
  fromName: String(row.from_name),
  fromKind: row.from_kind === 'cash' ? 'cash' : 'bank',
  fromCurrency: String(row.from_currency),
  toCode: String(row.to_code),
  toName: String(row.to_name),
  toKind: row.to_kind === 'cash' ? 'cash' : 'bank',
  toCurrency: String(row.to_currency),
  amount: String(row.amount),
  receivedAmount: String(row.received_amount),
  fxRate: (row.fx_rate as string | null) ?? null,
  bankReference: (row.bank_reference as string | null) ?? null,
  note: (row.note as string | null) ?? null,
  createdBy: String(row.created_by),
  createdByName: (row.created_by_name as string | null) ?? null,
  approvedByName: (row.approved_by_name as string | null) ?? null,
  postedByName: (row.posted_by_name as string | null) ?? null,
  reversedByName: (row.reversed_by_name as string | null) ?? null,
  reversalReason: (row.reversal_reason as string | null) ?? null,
  journalEntryNo: (row.journal_entry_no as string | null) ?? null,
  reversalEntryNo: (row.reversal_entry_no as string | null) ?? null,
});

export interface TransferFilter extends RegisterPaging {
  readonly view?: TransferView | null;
  readonly accountCode?: string | null;
  readonly search?: string | null;
}

/** The register: fifty to a page, a true count, the filters in the SQL. Rows the reader's branches cannot see are not here (row security). */
export async function listTransfers(tx: Tx, ctx: ActorContext, filter: TransferFilter = {}) {
  await authz.authorize(ctx.principal, 'view', PERMISSION_OBJECT, { branchCode: ctx.branchCode });
  const account = filter.accountCode?.trim() || null;
  const where = whereOf([
    filter.view === 'open' ? sql`x.status in ('draft', 'approved')` : null,
    filter.view === 'posted' ? sql`x.status = 'posted'` : null,
    filter.view === 'reversed' ? sql`x.status = 'reversed'` : null,
    account ? sql`(x.from_code = ${account} or x.to_code = ${account})` : null,
    searchOf([sql`x.transfer_no`, sql`x.from_code`, sql`x.from_name`, sql`x.to_code`, sql`x.to_name`, sql`x.bank_reference`, sql`x.note`], filter.search),
  ]);
  return registerPage<TransferRow>({
    paging: filter,
    count: () => countOf(tx, sql`from ${TRANSFERS} ${where}`),
    rows: async ({ limit, offset }) => {
      const result = await tx.execute(
        sql`select * from ${TRANSFERS} ${where} order by x.transfer_date desc, x.created_at desc, x.transfer_no desc limit ${limit} offset ${offset}`,
      );
      return (result as unknown as { rows: Record<string, unknown>[] }).rows.map(transferRow);
    },
  });
}

/** One transfer by its number, for its record page and its printed copy. */
export async function transferByNo(tx: Tx, ctx: ActorContext, transferNo: string): Promise<TransferRow> {
  await authz.authorize(ctx.principal, 'view', PERMISSION_OBJECT, { branchCode: ctx.branchCode });
  const result = await tx.execute(sql`select * from ${TRANSFERS} where x.transfer_no = ${transferNo} limit 1`);
  const [row] = (result as unknown as { rows: Record<string, unknown>[] }).rows;
  if (!row) throw new TransferNotFoundError(transferNo);
  return transferRow(row);
}

async function loadTransfer(tx: Tx, id: string, options: { readonly lock?: boolean } = {}) {
  // A transition reads its row FOR UPDATE before it checks the status, so a
  // double submit approves, posts or reverses once (HARDEN-2).
  const query = tx.select().from(bankTransfer).where(eq(bankTransfer.id, id)).limit(1);
  const [transfer] = options.lock ? await query.for('update') : await query;
  if (!transfer) throw new Error(`No bank transfer with id '${id}'.`);
  return transfer;
}

export async function viewTransfer(tx: Tx, id: string) {
  return loadTransfer(tx, id);
}

export async function viewCount(tx: Tx, id: string) {
  return loadCount(tx, id);
}

/** Cash counts with an unapproved variance — Appendix D's exception report. */
export async function openVariances(tx: Tx, ctx: ActorContext, branchCode?: string) {
  await authz.authorize(ctx.principal, 'view', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
  });

  return tx
    .select()
    .from(cashCount)
    .where(
      and(
        ne(cashCount.varianceIqd, '0'),
        eq(cashCount.status, 'draft'),
        branchCode ? eq(cashCount.branchCode, branchCode) : sql`true`,
      ),
    )
    .orderBy(cashCount.countDate);
}
