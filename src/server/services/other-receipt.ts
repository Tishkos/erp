/**
 * Other Receipt — Phase 07.4, §17.
 *
 * > §17 scope: *"Customer Receipt and Other Receipt."*
 *
 * Money in that is not a customer settling an invoice. It credits an account
 * somebody names, carries the §4.2 dimensions that account requires, and — the
 * point of it being its own document — **cannot touch a subledger control
 * account**. A receipt that could be either a customer settlement or an income
 * entry, depending on how it was filled in, is a receipt that will eventually be
 * filled in the other way.
 */
import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { bankCashAccount, chartOfAccount, otherReceipt } from '../db/schema';
import { parseDecimal, toDecimalString } from '../domain/money';
import { assertWithinCashLimit } from '../domain/treasury';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as posting from './posting';
import * as statuses from './statuses';
import * as treasury from './treasury';
import { allocateDocumentNumber } from './numbering';

export const DOCUMENT_TYPE = 'other_receipt';
export const PERMISSION_OBJECT = 'other_receipt';
const SEQUENCE_KEY = 'OTHER_RECEIPT';

export class OtherReceiptStateError extends Error {
  readonly code = 'OTHER_RECEIPT_STATE_INVALID';
  constructor(receiptNo: string, status: string, detail: string) {
    super(`Other receipt ${receiptNo} is '${status}': ${detail}`);
    this.name = 'OtherReceiptStateError';
  }
}

export interface CreateOtherReceiptInput {
  readonly bankCashAccountId: string;
  readonly branchCode: string;
  readonly receiptDate: string;
  readonly amountIqd: bigint;
  readonly creditAccountId: string;
  readonly payer: string;
  readonly departmentCode?: string | null;
  readonly businessLineCode?: string | null;
  readonly reference?: string | null;
  readonly note?: string | null;
}

async function load(tx: Tx, id: string) {
  const [row] = await tx.select().from(otherReceipt).where(eq(otherReceipt.id, id)).limit(1);
  if (!row) throw new Error(`No other receipt with id '${id}'.`);
  return row;
}

export async function create(
  tx: Tx,
  ctx: ActorContext,
  input: CreateOtherReceiptInput,
): Promise<{ id: string; receiptNo: string }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  if (input.amountIqd <= 0n) {
    throw new Error('A receipt of nothing receives nothing. State the amount that arrived.');
  }
  if (!input.payer.trim()) {
    throw new Error(
      'A receipt needs to say who paid it in (§17). Money arriving from nobody is money nobody ' +
        'can trace when it turns out to have been sent by mistake.',
    );
  }

  const [account] = await tx
    .select()
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, input.bankCashAccountId))
    .limit(1);

  if (!account) throw new Error(`No bank or cash account with id '${input.bankCashAccountId}'.`);
  if (!account.active) {
    throw new Error(`${account.code} is closed, so nothing can be received into it.`);
  }

  const [credit] = await tx
    .select()
    .from(chartOfAccount)
    .where(eq(chartOfAccount.id, input.creditAccountId))
    .limit(1);

  if (!credit) throw new Error(`No account with id '${input.creditAccountId}'.`);

  // The rule that makes this a different document, not a variant of the
  // customer receipt: a control account belongs to its subledger, and a
  // receipt that credited one would break the tie between them.
  if (credit.controlAccount) {
    throw new Error(
      `${credit.code} is the control account for the ${credit.controlAccount} subledger, and an ` +
        'Other Receipt cannot credit one (§16). Money from a customer is a Customer Receipt, ' +
        'which allocates to their invoices; money from a supplier refund belongs on their account ' +
        'through a credit memo. Otherwise the control account stops tying to the subledger.',
    );
  }

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: input.branchCode, year: Number(input.receiptDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(otherReceipt)
    .values({
      receiptNo: allocated.documentNo,
      bankCashAccountId: input.bankCashAccountId,
      branchCode: input.branchCode,
      receiptDate: input.receiptDate,
      currency: account.currency,
      amountIqd: toDecimalString(input.amountIqd, 4n),
      creditAccountId: input.creditAccountId,
      departmentCode: input.departmentCode ?? null,
      businessLineCode: input.businessLineCode ?? null,
      payer: input.payer.trim(),
      reference: input.reference ?? null,
      note: input.note ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: otherReceipt.id });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'other_receipt.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: input.branchCode,
    after: {
      receiptNo: allocated.documentNo,
      account: account.code,
      creditAccount: credit.code,
      amountIqd: toDecimalString(input.amountIqd, 4n),
      payer: input.payer.trim(),
    },
    outcome: 'success',
  });

  return { id: created!.id, receiptNo: allocated.documentNo };
}

export async function approve(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const receipt = await load(tx, id);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: receipt.branchCode,
  });

  if (receipt.status !== 'draft') {
    throw new OtherReceiptStateError(receipt.receiptNo, receipt.status, 'it is not a draft.');
  }

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, receipt.status, 'approved');

  await tx
    .update(otherReceipt)
    .set({
      status: 'approved',
      approvedBy: ctx.principal.userId,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(otherReceipt.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'other_receipt.approved',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: receipt.branchCode,
    before: { status: receipt.status },
    after: { status: 'approved' },
    outcome: 'success',
  });
}

/**
 * §17 — Dr the account the money arrived in, Cr what it was for.
 *
 * The debit names the bank account rather than resolving a mapping, for the
 * reason 07.1 states: with two bank accounts a mapping would put every receipt
 * in the same one and the account's balance would stop being its G/L balance.
 */
export async function post(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ journalEntryId: string }> {
  const receipt = await load(tx, id);

  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, {
    branchCode: receipt.branchCode,
  });

  if (receipt.status !== 'approved') {
    throw new OtherReceiptStateError(
      receipt.receiptNo,
      receipt.status,
      'a receipt posts once it has been approved.',
    );
  }

  const [account] = await tx
    .select()
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, receipt.bankCashAccountId))
    .limit(1);

  const amount = parseDecimal(receipt.amountIqd, 4n);

  // §17 — cash coming in must not push a float over its limit.
  if (account!.accountType === 'cash') {
    const [position] = await treasury.balances(tx, ctx, receipt.receiptDate, {
      accountCode: account!.code,
    });
    assertWithinCashLimit(
      account!.code,
      account!.cashLimitIqd === null ? null : parseDecimal(account!.cashLimitIqd, 4n),
      parseDecimal(position?.balanceIqd ?? '0', 4n) + amount,
    );
  }

  const criteria = { branchCode: receipt.branchCode };

  const result = await posting.post(tx, ctx, {
    eventType: 'treasury.other_receipt',
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'treasury', documentId: id, event: 'posted' },
    branchCode: receipt.branchCode,
    documentDate: receipt.receiptDate,
    postingDate: receipt.receiptDate,
    description: `Other receipt ${receipt.receiptNo} — ${receipt.payer}`,
    lines: [
      {
        role: 'bank',
        accountId: account!.glAccountId,
        debit: receipt.amountIqd,
        criteria,
        dimensions: { branch: receipt.branchCode },
      },
      {
        role: 'other_income',
        accountId: receipt.creditAccountId,
        credit: receipt.amountIqd,
        criteria,
        dimensions: {
          branch: receipt.branchCode,
          department: receipt.departmentCode,
          business_line: receipt.businessLineCode,
        },
      },
    ],
  });

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, receipt.status, 'posted');

  await tx
    .update(otherReceipt)
    .set({
      status: 'posted',
      journalEntryId: result.journalEntryId,
      postedBy: ctx.principal.userId,
      postedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(otherReceipt.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'other_receipt.posted',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: receipt.branchCode,
    before: { status: receipt.status },
    after: { status: 'posted', journalEntryId: result.journalEntryId },
    outcome: 'success',
  });

  return { journalEntryId: result.journalEntryId };
}

export async function view(tx: Tx, id: string) {
  return load(tx, id);
}
