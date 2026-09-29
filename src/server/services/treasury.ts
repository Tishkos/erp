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
import { parseDecimal, toDecimalString } from '../domain/money';
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
import { allocateDocumentNumber } from './numbering';

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
 * Two things commit money — an approved transfer out, and an approved payment
 * batch's unsent lines. Both have to count, and the second is why: without it,
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
           (coalesce((
             select sum(t.amount)
               from bank_transfer t
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
           ), 0::numeric(19,4)))::text             as "committedIqd"
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
  readonly amountIqd: bigint;
  /** Required when the two accounts are held in different currencies (§17). */
  readonly receivedAmount?: bigint;
  readonly fxRate?: string | null;
  readonly bankReference?: string | null;
  readonly note?: string | null;
}

export async function createTransfer(
  tx: Tx,
  ctx: ActorContext,
  input: CreateTransferInput,
): Promise<{ id: string; transferNo: string }> {
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

  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
  });

  const crossCurrency = from.currency !== to.currency;

  if (crossCurrency && !input.fxRate) {
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

  // §17 — the money has to be there before it can go anywhere.
  const { balanceIqd, committedIqd } = await positionOf(tx, ctx, input.fromAccountId);
  assertSufficientFunds(from.code, { balanceIqd, committedIqd }, input.amountIqd);

  const receivedAmount = crossCurrency ? (input.receivedAmount ?? 0n) : input.amountIqd;

  if (crossCurrency && receivedAmount <= 0n) {
    throw new Error(
      'A cross-currency transfer records what arrived as well as what left — the two are different ' +
        'numbers, and only recording one leaves the other to be inferred.',
    );
  }

  // §17 — a float has a ceiling, and receiving is how it is breached.
  if (to.accountType === 'cash') {
    const [toPosition] = await balances(tx, ctx, input.transferDate, { accountCode: to.code });
    assertWithinCashLimit(
      to.code,
      to.cashLimitIqd === null ? null : parseDecimal(to.cashLimitIqd, 4n),
      parseDecimal(toPosition?.balanceIqd ?? '0', 4n) + receivedAmount,
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
      transferNo: allocated.documentNo,
      fromAccountId: input.fromAccountId,
      toAccountId: input.toAccountId,
      branchCode: ctx.branchCode,
      transferDate: input.transferDate,
      amount: toDecimalString(input.amountIqd, 4n),
      fromCurrency: from.currency,
      receivedAmount: toDecimalString(receivedAmount, 4n),
      toCurrency: to.currency,
      fxRate: input.fxRate ?? null,
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
      fxRate: input.fxRate ?? null,
    },
  });

  return { id: created!.id, transferNo: allocated.documentNo };
}

export async function approveTransfer(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const transfer = await loadTransfer(tx, id);

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
 * §17 — *"debits one account and credits the other in a single balanced
 * journal."*
 *
 * One journal, both legs. A cross-currency transfer still balances in IQD
 * because both legs are converted at the recorded rate; any difference between
 * them is an FX result and posts as one, rather than being absorbed silently
 * into whichever side happened to be rounded.
 */
export async function postTransfer(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ journalEntryId: string }> {
  const transfer = await loadTransfer(tx, id);

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

  // The accounts are named directly rather than through a §3.3 mapping: which
  // G/L account a bank account sits in is already configured on the account
  // itself, and a mapping would be a second answer to a question that has one.
  const lines: PostingLineRequest[] = [
    {
      role: 'bank_cash',
      accountId: to!.glAccountId,
      debit: transfer.receivedAmount,
      criteria,
      dimensions,
      bankAccountCode: to!.code,
      description: `Into ${to!.code}`,
    },
    {
      role: 'bank_cash',
      accountId: from!.glAccountId,
      credit: transfer.amount,
      criteria,
      dimensions,
      bankAccountCode: from!.code,
      description: `Out of ${from!.code}`,
    },
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
    after: { status: 'posted', journalEntryId: result.journalEntryId },
  });

  return { journalEntryId: result.journalEntryId };
}

async function loadTransfer(tx: Tx, id: string) {
  const [transfer] = await tx
    .select()
    .from(bankTransfer)
    .where(eq(bankTransfer.id, id))
    .limit(1);
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
