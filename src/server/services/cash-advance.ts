/**
 * Petty cash advances and the custodian position — Phase 07.5, §17.
 *
 * > §17 scope: *"Petty Cash, Cash Advance and Cash Count."*
 * > Appendix D: *"Petty cash advances, ageing and cash count variances."*
 *
 * Three movements and no more: the cash goes out, the receipts come back, and
 * whatever is left is handed in. Each is a posting; between them the balance
 * sits in a receivable account with somebody's name against it.
 *
 * Cash counts are 07.1's `treasury.countCash` and are not repeated here. A
 * float is counted the same way whether or not somebody has an advance out of
 * it, and two implementations of "what is in the drawer" would eventually
 * disagree.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  appUser,
  bankCashAccount,
  cashAdvance,
  cashAdvanceSettlement,
  chartOfAccount,
} from '../db/schema';
import { parseDecimal, toDecimalString } from '../domain/money';
import {
  assertIssuable,
  assertWithinAdvance,
  bucketFor,
  outstandingOn,
  type AdvanceBucket,
} from '../domain/cash-advance';
import { assertWithinCashLimit } from '../domain/treasury';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as posting from './posting';
import * as statuses from './statuses';
import * as treasury from './treasury';
import { allocateDocumentNumber } from './numbering';

export const DOCUMENT_TYPE = 'cash_advance';
export const PERMISSION_OBJECT = 'cash_advance';
const SEQUENCE_KEY = 'CASH_ADVANCE';

export { ADVANCE_BUCKETS, bucketFor, outstandingOn, type AdvanceBucket } from '../domain/cash-advance';

export class CashAdvanceStateError extends Error {
  readonly code = 'CASH_ADVANCE_STATE_INVALID';
  constructor(advanceNo: string, status: string, detail: string) {
    super(`Cash advance ${advanceNo} is '${status}': ${detail}`);
    this.name = 'CashAdvanceStateError';
  }
}

export interface RequestAdvanceInput {
  readonly bankCashAccountId: string;
  readonly branchCode: string;
  readonly holderUserId: string;
  readonly issueDate: string;
  readonly dueDate: string;
  readonly purpose: string;
  readonly amountIqd: bigint;
}

async function load(tx: Tx, id: string) {
  const [advance] = await tx.select().from(cashAdvance).where(eq(cashAdvance.id, id)).limit(1);
  if (!advance) throw new Error(`No cash advance with id '${id}'.`);
  return advance;
}

/** §17 — the request. No money moves until it is approved and issued. */
export async function request(
  tx: Tx,
  ctx: ActorContext,
  input: RequestAdvanceInput,
): Promise<{ id: string; advanceNo: string }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  assertIssuable(input);

  const [account] = await tx
    .select()
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, input.bankCashAccountId))
    .limit(1);

  if (!account) throw new Error(`No bank or cash account with id '${input.bankCashAccountId}'.`);
  if (account.accountType !== 'cash') {
    throw new Error(
      `${account.code} is a ${account.accountType} account. A petty cash advance comes out of a ` +
        'float (§17); money sent from a bank account is a payment, with its own approval and its ' +
        'own beneficiary checks.',
    );
  }
  if (!account.active) {
    throw new Error(`${account.code} is closed, so nothing can be advanced from it.`);
  }
  if (account.currency !== 'IQD') {
    throw new Error(
      `${account.code} holds ${account.currency}. Advances are recorded in the float's own ` +
        'currency, and this build settles them in IQD (§17, §14.3).',
    );
  }

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: input.branchCode, year: Number(input.issueDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(cashAdvance)
    .values({
      advanceNo: allocated.documentNo,
      bankCashAccountId: input.bankCashAccountId,
      branchCode: input.branchCode,
      holderUserId: input.holderUserId,
      issueDate: input.issueDate,
      dueDate: input.dueDate,
      purpose: input.purpose.trim(),
      amountIqd: toDecimalString(input.amountIqd, 4n),
      createdBy: ctx.principal.userId,
    })
    .returning({ id: cashAdvance.id });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'cash_advance.requested',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: input.branchCode,
    after: {
      advanceNo: allocated.documentNo,
      account: account.code,
      holder: input.holderUserId,
      amountIqd: toDecimalString(input.amountIqd, 4n),
      dueDate: input.dueDate,
      purpose: input.purpose.trim(),
    },
    outcome: 'success',
  });

  return { id: created!.id, advanceNo: allocated.documentNo };
}

/**
 * §5.2 — somebody other than the requester agrees to it.
 *
 * The holder cannot approve their own advance, which is the same rule §17
 * applies to payments and for the same reason: one person able to take money out
 * of a drawer on their own say-so is the control that petty cash exists to have.
 */
export async function approve(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const advance = await load(tx, id);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: advance.branchCode,
  });

  if (advance.status !== 'draft') {
    throw new CashAdvanceStateError(advance.advanceNo, advance.status, 'it is not a draft.');
  }
  if (advance.createdBy === ctx.principal.userId) {
    throw new Error(
      `${advance.advanceNo} was raised by you, so somebody else approves it (§5.2). ` +
        'An advance one person raises and approves is money leaving on one person’s say-so.',
    );
  }
  if (advance.holderUserId === ctx.principal.userId) {
    throw new Error(
      `${advance.advanceNo} is to be held by you, so somebody else approves it (§5.2).`,
    );
  }

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, advance.status, 'approved');

  await tx
    .update(cashAdvance)
    .set({
      status: 'approved',
      approvedBy: ctx.principal.userId,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(cashAdvance.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'cash_advance.approved',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: advance.branchCode,
    before: { status: advance.status },
    after: { status: 'approved' },
    outcome: 'success',
  });
}

/**
 * §17 — the cash leaves the drawer: Dr Cash Advance / Cr Cash.
 *
 * A receivable, not an expense. Nothing has been spent yet; the company has
 * handed money to somebody who owes an account of it, and until the receipts
 * arrive that is exactly what the balance sheet should say.
 */
export async function issue(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ journalEntryId: string }> {
  const advance = await load(tx, id);

  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, {
    branchCode: advance.branchCode,
  });

  if (advance.status !== 'approved') {
    throw new CashAdvanceStateError(
      advance.advanceNo,
      advance.status,
      'cash leaves the drawer once the advance has been approved.',
    );
  }

  const [account] = await tx
    .select()
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, advance.bankCashAccountId))
    .limit(1);

  const amount = parseDecimal(advance.amountIqd, 4n);

  // §17 — the float has to hold it.
  await treasury.checkPayment(tx, ctx, {
    bankCashAccountId: advance.bankCashAccountId,
    amountIqd: amount,
    currency: advance.currency,
  });

  const criteria = { branchCode: advance.branchCode };
  const dimensions = { branch: advance.branchCode };

  const result = await posting.post(tx, ctx, {
    eventType: 'treasury.cash_advance_issue',
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'treasury', documentId: id, event: 'issued' },
    branchCode: advance.branchCode,
    documentDate: advance.issueDate,
    postingDate: advance.issueDate,
    description: `Cash advance ${advance.advanceNo} — ${advance.purpose}`,
    lines: [
      { role: 'cash_advance', debit: advance.amountIqd, criteria, dimensions },
      {
        role: 'cash',
        accountId: account!.glAccountId,
        credit: advance.amountIqd,
        criteria,
        dimensions,
      },
    ],
  });

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, advance.status, 'posted');

  await tx
    .update(cashAdvance)
    .set({
      status: 'posted',
      journalEntryId: result.journalEntryId,
      issuedBy: ctx.principal.userId,
      issuedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(cashAdvance.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'cash_advance.issued',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: advance.branchCode,
    before: { status: advance.status },
    after: { status: 'posted', journalEntryId: result.journalEntryId },
    outcome: 'success',
  });

  return { journalEntryId: result.journalEntryId };
}

export interface SettlementLineInput {
  readonly accountId: string;
  readonly amountIqd: bigint;
  readonly spentOn: string;
  readonly description: string;
  readonly receiptReference?: string | null;
  readonly departmentCode?: string | null;
  readonly businessLineCode?: string | null;
}

export interface SettleInput {
  readonly settlementDate: string;
  readonly lines: readonly SettlementLineInput[];
  /** Unspent cash handed back into the float. */
  readonly returnedIqd?: bigint;
}

/**
 * §17 — the receipts come back, and so does whatever was not spent.
 *
 * One posting for both halves, because they are one event: the holder empties
 * their pockets. Dr each expense account for what the receipts say, Dr Cash for
 * what came back, and Cr Cash Advance for the whole of it — which is what
 * clears the receivable.
 *
 * Each line names its own account and its own §4.2 dimensions. One advance buys
 * several unrelated things, and posting them all to one "petty cash" account
 * would answer no question anybody asks.
 */
export async function settle(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: SettleInput,
): Promise<{ journalEntryId: string; outstandingIqd: bigint }> {
  const advance = await load(tx, id);

  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, {
    branchCode: advance.branchCode,
  });

  if (advance.status !== 'posted' && advance.status !== 'partially_executed') {
    throw new CashAdvanceStateError(
      advance.advanceNo,
      advance.status,
      'only an issued advance can be accounted for.',
    );
  }

  const returned = input.returnedIqd ?? 0n;
  const spent = input.lines.reduce((total, line) => total + line.amountIqd, 0n);
  const claimed = spent + returned;

  if (claimed <= 0n) {
    throw new Error(
      `${advance.advanceNo} was accounted for with nothing. Give the receipts, the cash returned, ` +
        'or both.',
    );
  }

  assertWithinAdvance(
    advance.advanceNo,
    {
      amountIqd: parseDecimal(advance.amountIqd, 4n),
      settledIqd: parseDecimal(advance.settledAmountIqd, 4n),
      returnedIqd: parseDecimal(advance.returnedAmountIqd, 4n),
    },
    claimed,
  );

  const [account] = await tx
    .select()
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, advance.bankCashAccountId))
    .limit(1);

  // §17 — cash coming back must not push the float over its limit.
  if (returned > 0n) {
    const [position] = await treasury.balances(tx, ctx, input.settlementDate, {
      accountCode: account!.code,
    });
    assertWithinCashLimit(
      account!.code,
      account!.cashLimitIqd === null ? null : parseDecimal(account!.cashLimitIqd, 4n),
      parseDecimal(position?.balanceIqd ?? '0', 4n) + returned,
    );
  }

  const criteria = { branchCode: advance.branchCode };

  const postingLines = [
    ...input.lines.map((line) => ({
      role: 'cash_advance_expense',
      accountId: line.accountId,
      debit: toDecimalString(line.amountIqd, 4n),
      criteria,
      dimensions: {
        branch: advance.branchCode,
        department: line.departmentCode ?? null,
        business_line: line.businessLineCode ?? null,
      },
    })),
    ...(returned > 0n
      ? [
          {
            role: 'cash',
            accountId: account!.glAccountId,
            debit: toDecimalString(returned, 4n),
            criteria,
            dimensions: { branch: advance.branchCode },
          },
        ]
      : []),
    {
      role: 'cash_advance',
      credit: toDecimalString(claimed, 4n),
      criteria,
      dimensions: { branch: advance.branchCode },
    },
  ];

  const result = await posting.post(tx, ctx, {
    eventType: 'treasury.cash_advance_settlement',
    documentTypeCode: DOCUMENT_TYPE,
    source: {
      module: 'treasury',
      documentId: id,
      event: `settled-${advance.settledAmountIqd}-${advance.returnedAmountIqd}`,
    },
    branchCode: advance.branchCode,
    documentDate: input.settlementDate,
    postingDate: input.settlementDate,
    description: `Cash advance ${advance.advanceNo} accounted for`,
    lines: postingLines,
  });

  const counted = (await tx.execute(sql`
    select coalesce(max(line_no), 0) + 1 as "nextLine"
      from cash_advance_settlement where cash_advance_id = ${id}
  `)) as unknown as { rows: { nextLine: number }[] };

  let lineNo = Number(counted.rows[0]?.nextLine ?? 1);
  for (const line of input.lines) {
    await tx.insert(cashAdvanceSettlement).values({
      cashAdvanceId: id,
      lineNo,
      accountId: line.accountId,
      departmentCode: line.departmentCode ?? null,
      businessLineCode: line.businessLineCode ?? null,
      spentOn: line.spentOn,
      amountIqd: toDecimalString(line.amountIqd, 4n),
      description: line.description,
      receiptReference: line.receiptReference ?? null,
      journalEntryId: result.journalEntryId,
      recordedBy: ctx.principal.userId,
    });
    lineNo += 1;
  }

  await tx
    .update(cashAdvance)
    .set({
      settledAmountIqd: sql`${cashAdvance.settledAmountIqd} + ${toDecimalString(spent, 4n)}`,
      returnedAmountIqd: sql`${cashAdvance.returnedAmountIqd} + ${toDecimalString(returned, 4n)}`,
      updatedAt: new Date(),
    })
    .where(eq(cashAdvance.id, id));

  const after = await load(tx, id);
  const outstanding = outstandingOn({
    amountIqd: parseDecimal(after.amountIqd, 4n),
    settledIqd: parseDecimal(after.settledAmountIqd, 4n),
    returnedIqd: parseDecimal(after.returnedAmountIqd, 4n),
  });

  const nextStatus = outstanding === 0n ? 'settled' : 'partially_executed';
  // A second partial settlement leaves the status where it was, and a status
  // machine has no rule for standing still — §3.2's transitions describe moves.
  if (nextStatus !== after.status) {
    await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, after.status, nextStatus);
  }

  await tx
    .update(cashAdvance)
    .set({
      status: nextStatus,
      closedAt: outstanding === 0n ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(cashAdvance.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'cash_advance.settled',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: advance.branchCode,
    before: { status: advance.status, outstandingIqd: advance.amountIqd },
    after: {
      status: nextStatus,
      spentIqd: toDecimalString(spent, 4n),
      returnedIqd: toDecimalString(returned, 4n),
      outstandingIqd: toDecimalString(outstanding, 4n),
      journalEntryId: result.journalEntryId,
    },
    outcome: 'success',
  });

  return { journalEntryId: result.journalEntryId, outstandingIqd: outstanding };
}

// ---------------------------------------------------------------------------
// Reporting — Appendix D
// ---------------------------------------------------------------------------

export interface AgedAdvance {
  readonly advanceNo: string;
  readonly holder: string;
  readonly accountCode: string;
  readonly issueDate: string;
  readonly dueDate: string;
  readonly purpose: string;
  readonly amountIqd: string;
  readonly outstandingIqd: string;
  readonly bucket: AdvanceBucket;
}

/**
 * Appendix D — *"petty cash advances, ageing."*
 *
 * Read from the advances themselves rather than from a maintained summary, so it
 * cannot drift from them — the same reason the A/P ageing is built that way.
 */
export async function ageing(
  tx: Tx,
  asOf: string,
  filter: { branchCode?: string | null; holderUserId?: string | null } = {},
): Promise<AgedAdvance[]> {
  const rows = await tx
    .select({
      advanceNo: cashAdvance.advanceNo,
      holder: appUser.displayName,
      accountCode: bankCashAccount.code,
      issueDate: cashAdvance.issueDate,
      dueDate: cashAdvance.dueDate,
      purpose: cashAdvance.purpose,
      amountIqd: cashAdvance.amountIqd,
      outstandingIqd: sql<string>`(${cashAdvance.amountIqd}
        - ${cashAdvance.settledAmountIqd} - ${cashAdvance.returnedAmountIqd})`,
    })
    .from(cashAdvance)
    .innerJoin(appUser, eq(appUser.id, cashAdvance.holderUserId))
    .innerJoin(bankCashAccount, eq(bankCashAccount.id, cashAdvance.bankCashAccountId))
    .where(
      and(
        sql`${cashAdvance.status} in ('posted', 'partially_executed')`,
        sql`${cashAdvance.amountIqd} - ${cashAdvance.settledAmountIqd} - ${cashAdvance.returnedAmountIqd} > 0`,
        filter.branchCode ? eq(cashAdvance.branchCode, filter.branchCode) : sql`true`,
        filter.holderUserId ? eq(cashAdvance.holderUserId, filter.holderUserId) : sql`true`,
      ),
    )
    .orderBy(cashAdvance.dueDate, cashAdvance.advanceNo);

  return rows.map((row) => ({ ...row, bucket: bucketFor(row.dueDate, asOf) }));
}

export interface CustodianPosition {
  readonly custodian: string | null;
  readonly accountCode: string;
  readonly accountName: string;
  /** §17's gate — the float's G/L balance, which is the float's balance. */
  readonly balanceIqd: string;
  /** What is out on advances and not yet accounted for. */
  readonly advancesOutIqd: string;
}

/**
 * The 07.5 gate: *"petty cash balance per custodian is tracked and reconciles to
 * its G/L account."*
 *
 * It reconciles because it **is** the G/L account balance — there is no second
 * figure to reconcile it against. The custodian comes from the account master,
 * where §17 already puts it, and the advances outstanding sit beside the balance
 * rather than inside it: cash in a drawer and cash somebody is carrying are two
 * different things, and netting them would hide exactly the one that goes
 * missing.
 */
export async function custodianPositions(
  tx: Tx,
  ctx: ActorContext,
  asOf: string,
  branchCode?: string | null,
): Promise<CustodianPosition[]> {
  const balances = await treasury.balances(tx, ctx, asOf, { branchCode: branchCode ?? null });

  const rows = await tx
    .select({
      accountCode: bankCashAccount.code,
      accountName: bankCashAccount.name,
      accountType: bankCashAccount.accountType,
      custodian: appUser.displayName,
      advancesOutIqd: sql<string>`coalesce((
        select sum(a.amount_iqd - a.settled_amount_iqd - a.returned_amount_iqd)
          from cash_advance a
         where a.bank_cash_account_id = ${bankCashAccount.id}
           and a.status in ('posted', 'partially_executed')
      ), 0::numeric(19,4))`,
    })
    .from(bankCashAccount)
    .leftJoin(appUser, eq(appUser.id, bankCashAccount.custodianUserId))
    .where(
      and(
        eq(bankCashAccount.accountType, 'cash'),
        branchCode ? eq(bankCashAccount.branchCode, branchCode) : sql`true`,
      ),
    )
    .orderBy(bankCashAccount.code);

  const balanceByCode = new Map(balances.map((row) => [row.accountCode, row.balanceIqd]));

  return rows.map((row) => ({
    custodian: row.custodian,
    accountCode: row.accountCode,
    accountName: row.accountName,
    balanceIqd: balanceByCode.get(row.accountCode) ?? '0.0000',
    advancesOutIqd: row.advancesOutIqd,
  }));
}

export async function view(tx: Tx, id: string) {
  const advance = await load(tx, id);
  const settlements = await tx
    .select({
      lineNo: cashAdvanceSettlement.lineNo,
      accountCode: chartOfAccount.code,
      accountName: chartOfAccount.name,
      spentOn: cashAdvanceSettlement.spentOn,
      amountIqd: cashAdvanceSettlement.amountIqd,
      description: cashAdvanceSettlement.description,
      receiptReference: cashAdvanceSettlement.receiptReference,
    })
    .from(cashAdvanceSettlement)
    .innerJoin(chartOfAccount, eq(chartOfAccount.id, cashAdvanceSettlement.accountId))
    .where(eq(cashAdvanceSettlement.cashAdvanceId, id))
    .orderBy(cashAdvanceSettlement.lineNo);

  return {
    advance,
    settlements,
    outstandingIqd: outstandingOn({
      amountIqd: parseDecimal(advance.amountIqd, 4n),
      settledIqd: parseDecimal(advance.settledAmountIqd, 4n),
      returnedIqd: parseDecimal(advance.returnedAmountIqd, 4n),
    }),
  };
}
