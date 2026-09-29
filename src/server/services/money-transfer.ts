/**
 * Money Transfer — Phase 09.2 to 09.9, §12.
 *
 * ── The §12.4 accounting model, in one place ────────────────────────────────
 *
 * | Act | Posting | Blueprint |
 * |---|---|---|
 * | Client deposit | Dr Company Bank Account / Cr Client Clearing | §12.4 verbatim |
 * | Initiate and send transfer | Dr Client Clearing / Cr Company Bank Account | §12.4 verbatim |
 * | Bank fees and direct expenses | Dr Bank Fees / MT Direct Expense, Cr Company Bank Account | §12.4 verbatim |
 * | Returned transfer | the mirror of the second row | §12.6 — *"reverses the transfer"* |
 * | Client refund | Dr Client Clearing / Cr Company Bank Account | §12.6 — *"full refund"* |
 * | Recognised service result | Dr Client Clearing / Cr Service Revenue | §12.6 refers to it; §12.4 makes the account a mapping |
 *
 * Every one of them goes through the accounting posting engine **by line role**.
 * No account code appears anywhere in this file, which is §12.4's own
 * requirement — *"Account names are configured through Accounting Mapping; they
 * are not hard-coded"* — and §3.3's. Changing the mapping changes the posting,
 * with no code change, which is the 09.8 gate.
 *
 * ── What is deliberately *not* automatic ────────────────────────────────────
 * The recognised service result. §22 defines transfer margin *"according to
 * finance policy"*, and the policy — whether a residual client balance is the
 * company's margin or the client's money — has not been decided. So
 * `recogniseServiceResult` takes the
 * amount from Finance and refuses more than the computed Net Service Margin. The
 * mechanism is built, the number is theirs. Choosing it here would be the
 * implementation team settling an accounting outcome, which §28.1 forbids.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  bankCashAccount,
  businessPartner,
  journalEntry,
  moneyTransfer,
  moneyTransferClientAccount,
  moneyTransferDeposit,
  moneyTransferDepositUsage,
  moneyTransferExpense,
} from '../db/schema';
import {
  allocateAcrossDeposits,
  calculateMargin,
  isTransferEditable,
  TransferLockedError,
  type TransferMargin,
  type TransferRates,
} from '../domain/money-transfer';
import { parseDecimal, RATE_SCALE, toDecimalString } from '../domain/money';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';
import * as clientService from './money-transfer-client';
import * as posting from './posting';
import * as statuses from './statuses';
import { allocateDocumentNumber } from './numbering';

export const DEPOSIT_DOCUMENT_TYPE = 'money_transfer_deposit';
export const TRANSFER_DOCUMENT_TYPE = 'money_transfer';
export const EXPENSE_DOCUMENT_TYPE = 'money_transfer_expense';

export const DEPOSIT_PERMISSION_OBJECT = 'money_transfer_deposit';
export const TRANSFER_PERMISSION_OBJECT = 'money_transfer';
export const EXPENSE_PERMISSION_OBJECT = 'money_transfer_expense';

const DEPOSIT_SEQUENCE_KEY = 'MT_CLIENT_DEPOSIT';
const TRANSFER_SEQUENCE_KEY = 'MONEY_TRANSFER';
const EXPENSE_SEQUENCE_KEY = 'MT_EXPENSE';

const MODULE = 'money_transfer';

/**
 * The line roles this module posts by. Names, not accounts — Accounting Mapping
 * decides what each one resolves to (§12.4, §3.3).
 *
 * `client_account` and `client_clearing` are separate roles because §12.4's two
 * tables name them separately: the standard model credits "Client Clearing /
 * Client A/P-Type Account", and the client-funded import model debits "Client
 * Account" on delivery settlement. Whether Finance maps them to one account or
 * two is theirs to decide; collapsing them here would decide it for them.
 */
export const LINE_ROLES = {
  bank: 'bank',
  clientClearing: 'client_clearing',
  transferExpense: 'transfer_expense',
  serviceRevenue: 'service_revenue',
} as const;

export class MoneyTransferNotFoundError extends Error {
  readonly code = 'MONEY_TRANSFER_NOT_FOUND';
  constructor(id: string) {
    super(`No money transfer '${id}'.`);
    this.name = 'MoneyTransferNotFoundError';
  }
}

export class MoneyTransferStateError extends Error {
  readonly code = 'MONEY_TRANSFER_STATE_INVALID';
  constructor(transferNo: string, status: string, detail: string) {
    super(`Money transfer ${transferNo} is '${status}': ${detail}`);
    this.name = 'MoneyTransferStateError';
  }
}

// ---------------------------------------------------------------------------
// 09.2 — client deposits
// ---------------------------------------------------------------------------

export interface RecordDepositInput {
  readonly clientAccountId: string;
  readonly branchCode: string;
  readonly depositDate: string;
  /** §12.3 — cash into the company account, or a bank transfer. */
  readonly method: 'cash' | 'bank_transfer';
  readonly companyBankAccountId: string;
  readonly amountIqd: bigint;
  readonly bankReference?: string | null;
  readonly note?: string | null;
}

async function loadDeposit(tx: Tx, id: string) {
  const [row] = await tx
    .select()
    .from(moneyTransferDeposit)
    .where(eq(moneyTransferDeposit.id, id))
    .limit(1);
  if (!row) throw new Error(`No client deposit '${id}'.`);
  return row;
}

/**
 * §12.3 — *"A client can make one or several partial deposits."*
 *
 * Each is its own document with its own number, date and bank reference, because
 * Appendix B gives a deposit its own statuses and the client statement has to
 * say which payment was which. A running total on the account would answer "how
 * much" and nothing else.
 */
export async function recordDeposit(
  tx: Tx,
  ctx: ActorContext,
  input: RecordDepositInput,
): Promise<{ id: string; depositNo: string }> {
  await authz.authorize(ctx.principal, 'create', DEPOSIT_PERMISSION_OBJECT, {
    branchCode: input.branchCode,
    requestId: ctx.requestId ?? null,
  });

  if (input.amountIqd <= 0n) {
    throw new Error('A deposit of nothing is not a deposit. State the amount received.');
  }

  const allocated = await allocateDocumentNumber(
    tx,
    DEPOSIT_SEQUENCE_KEY,
    { branchCode: input.branchCode, year: Number(input.depositDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(moneyTransferDeposit)
    .values({
      depositNo: allocated.documentNo,
      clientAccountId: input.clientAccountId,
      branchCode: input.branchCode,
      depositDate: input.depositDate,
      method: input.method,
      companyBankAccountId: input.companyBankAccountId,
      amountIqd: toDecimalString(input.amountIqd, 4n),
      bankReference: input.bankReference ?? null,
      note: input.note ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: moneyTransferDeposit.id });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'money_transfer_deposit.recorded',
    objectType: DEPOSIT_PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: input.branchCode,
    after: {
      depositNo: allocated.documentNo,
      amountIqd: toDecimalString(input.amountIqd, 4n),
      method: input.method,
    },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return { id: created!.id, depositNo: allocated.documentNo };
}

/**
 * §12.4 — *"Client deposit: Dr Company Bank Account / Cr Client Clearing."*
 *
 * The client's money is in the company's bank and the company owes it to the
 * client. Both halves in one transaction, which is the 09.2 gate's "atomically":
 * the posting engine runs inside this transaction by design, so the deposit row
 * and the journal commit together or neither does (§24).
 */
export async function postDeposit(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ journalEntryId: string }> {
  const deposit = await loadDeposit(tx, id);

  await authz.authorize(ctx.principal, 'post', DEPOSIT_PERMISSION_OBJECT, {
    branchCode: deposit.branchCode,
    objectId: id,
    requestId: ctx.requestId ?? null,
  });

  if (deposit.status !== 'draft') {
    throw new Error(
      `Deposit ${deposit.depositNo} is '${deposit.status}'; only a draft deposit posts (§3.2).`,
    );
  }

  const partner = await partnerFor(tx, deposit.clientAccountId);
  const criteria = { branchCode: deposit.branchCode };
  const dimensions = { branch: deposit.branchCode, business_partner: partner.code };

  const result = await posting.post(tx, ctx, {
    eventType: 'money_transfer.client_deposit',
    documentTypeCode: DEPOSIT_DOCUMENT_TYPE,
    source: { module: MODULE, documentId: id, event: 'posted' },
    branchCode: deposit.branchCode,
    documentDate: deposit.depositDate,
    postingDate: deposit.depositDate,
    description: `Client deposit ${deposit.depositNo} — ${partner.code}`,
    lines: [
      { role: LINE_ROLES.bank, debit: deposit.amountIqd, criteria, dimensions },
      { role: LINE_ROLES.clientClearing, credit: deposit.amountIqd, criteria, dimensions },
    ],
  });

  await statuses.assertTransitionAllowed(tx, DEPOSIT_DOCUMENT_TYPE, deposit.status, 'posted');

  await tx
    .update(moneyTransferDeposit)
    .set({
      status: 'posted',
      journalEntryId: result.journalEntryId,
      postedBy: ctx.principal.userId,
      postedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(moneyTransferDeposit.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'money_transfer_deposit.posted',
    objectType: DEPOSIT_PERMISSION_OBJECT,
    objectId: id,
    branchCode: deposit.branchCode,
    before: { status: 'draft' },
    after: { status: 'posted', journalEntryId: result.journalEntryId },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return { journalEntryId: result.journalEntryId };
}

// ---------------------------------------------------------------------------
// 09.4 — the transfer instruction
// ---------------------------------------------------------------------------

export interface CreateTransferInput {
  readonly clientAccountId: string;
  readonly branchCode: string;
  readonly transferDate: string;
  /** §12.2 — priced and referenced in USD; never the ledger amount. */
  readonly requestedUsd: bigint;
  /** Both are `exchange_rate` ids. §14.3 — rates are Finance's, not this document's. */
  readonly officialRateId: string;
  readonly clientRateId: string;
  /** §1.1 — the ledger amount. */
  readonly transferAmountIqd: bigint;
  readonly companyBankAccountId: string;
  readonly beneficiaryName: string;
  readonly beneficiaryBank?: string | null;
  readonly beneficiaryAccount?: string | null;
  readonly beneficiaryCountry?: string | null;
  /** §12.2 — *"where the approved process requires it."* */
  readonly clientImportFileId?: string | null;
  readonly logisticsJobId?: string | null;
  readonly note?: string | null;
}

export async function loadTransfer(tx: Tx, id: string) {
  const [row] = await tx.select().from(moneyTransfer).where(eq(moneyTransfer.id, id)).limit(1);
  if (!row) throw new MoneyTransferNotFoundError(id);
  return row;
}

async function partnerFor(tx: Tx, clientAccountId: string) {
  const [row] = await tx
    .select({ id: businessPartner.id, code: businessPartner.code })
    .from(moneyTransferClientAccount)
    .innerJoin(businessPartner, eq(businessPartner.id, moneyTransferClientAccount.partnerId))
    .where(eq(moneyTransferClientAccount.id, clientAccountId))
    .limit(1);
  if (!row) throw new Error(`No client account '${clientAccountId}'.`);
  return row;
}

/**
 * Creates the §12.2 instruction. Every one of its required data elements is a
 * column, and the ones the process cannot proceed without are NOT NULL.
 *
 * The rates are supplied as **references** to published rows. Their values are
 * written by a database trigger from those rows, so nothing a caller passes for
 * the rate itself would survive — which is how 09.3's *"rates cannot be edited
 * on the transfer document itself"* is made true rather than promised.
 */
export async function createTransfer(
  tx: Tx,
  ctx: ActorContext,
  input: CreateTransferInput,
): Promise<{ id: string; transferNo: string }> {
  await authz.authorize(ctx.principal, 'create', TRANSFER_PERMISSION_OBJECT, {
    branchCode: input.branchCode,
    requestId: ctx.requestId ?? null,
  });

  if (input.requestedUsd <= 0n) {
    throw new Error('§12.2 requires a requested USD equivalent; a transfer of nothing has no price.');
  }
  if (input.transferAmountIqd <= 0n) {
    throw new Error('§12.2 requires the IQD transfer amount — it is the ledger amount (§1.1).');
  }
  if (input.beneficiaryName.trim().length === 0) {
    throw new Error('§12.2 requires the beneficiary. It is the single most consequential field here.');
  }

  const allocated = await allocateDocumentNumber(
    tx,
    TRANSFER_SEQUENCE_KEY,
    { branchCode: input.branchCode, year: Number(input.transferDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(moneyTransfer)
    .values({
      transferNo: allocated.documentNo,
      clientAccountId: input.clientAccountId,
      branchCode: input.branchCode,
      transferDate: input.transferDate,
      requestedUsd: toDecimalString(input.requestedUsd, 4n),
      officialRateId: input.officialRateId,
      clientRateId: input.clientRateId,
      transferAmountIqd: toDecimalString(input.transferAmountIqd, 4n),
      companyBankAccountId: input.companyBankAccountId,
      beneficiaryName: input.beneficiaryName.trim(),
      beneficiaryBank: input.beneficiaryBank ?? null,
      beneficiaryAccount: input.beneficiaryAccount ?? null,
      beneficiaryCountry: input.beneficiaryCountry ?? null,
      clientImportFileId: input.clientImportFileId ?? null,
      logisticsJobId: input.logisticsJobId ?? null,
      note: input.note ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: moneyTransfer.id });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'money_transfer.created',
    objectType: TRANSFER_PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: input.branchCode,
    after: {
      transferNo: allocated.documentNo,
      requestedUsd: toDecimalString(input.requestedUsd, 4n),
      transferAmountIqd: toDecimalString(input.transferAmountIqd, 4n),
      beneficiaryName: input.beneficiaryName.trim(),
    },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return { id: created!.id, transferNo: allocated.documentNo };
}

/**
 * §12.3 — *"Rates and service details remain editable while only deposit entries
 * exist."*
 *
 * The one editing path, and it refuses as soon as the transfer entry exists. The
 * trigger refuses it too, on every path including import and the API — which is
 * what the 09.5 gate asks to be shown.
 */
export async function amendTransfer(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  changes: Partial<
    Pick<
      CreateTransferInput,
      | 'requestedUsd'
      | 'officialRateId'
      | 'clientRateId'
      | 'transferAmountIqd'
      | 'companyBankAccountId'
      | 'beneficiaryName'
      | 'beneficiaryBank'
      | 'beneficiaryAccount'
      | 'beneficiaryCountry'
      | 'clientImportFileId'
      | 'logisticsJobId'
      | 'note'
    >
  >,
): Promise<void> {
  const transfer = await loadTransfer(tx, id);

  await authz.authorize(ctx.principal, 'edit_draft', TRANSFER_PERMISSION_OBJECT, {
    branchCode: transfer.branchCode,
    objectId: id,
    requestId: ctx.requestId ?? null,
  });

  if (!isTransferEditable(transfer.status)) {
    throw new TransferLockedError(transfer.transferNo, transfer.status);
  }

  await tx
    .update(moneyTransfer)
    .set({
      ...(changes.requestedUsd !== undefined
        ? { requestedUsd: toDecimalString(changes.requestedUsd, 4n) }
        : {}),
      ...(changes.officialRateId !== undefined ? { officialRateId: changes.officialRateId } : {}),
      ...(changes.clientRateId !== undefined ? { clientRateId: changes.clientRateId } : {}),
      ...(changes.transferAmountIqd !== undefined
        ? { transferAmountIqd: toDecimalString(changes.transferAmountIqd, 4n) }
        : {}),
      ...(changes.companyBankAccountId !== undefined
        ? { companyBankAccountId: changes.companyBankAccountId }
        : {}),
      ...(changes.beneficiaryName !== undefined
        ? { beneficiaryName: changes.beneficiaryName.trim() }
        : {}),
      ...(changes.beneficiaryBank !== undefined ? { beneficiaryBank: changes.beneficiaryBank } : {}),
      ...(changes.beneficiaryAccount !== undefined
        ? { beneficiaryAccount: changes.beneficiaryAccount }
        : {}),
      ...(changes.beneficiaryCountry !== undefined
        ? { beneficiaryCountry: changes.beneficiaryCountry }
        : {}),
      ...(changes.clientImportFileId !== undefined
        ? { clientImportFileId: changes.clientImportFileId }
        : {}),
      ...(changes.logisticsJobId !== undefined ? { logisticsJobId: changes.logisticsJobId } : {}),
      ...(changes.note !== undefined ? { note: changes.note } : {}),
      updatedAt: new Date(),
    })
    .where(eq(moneyTransfer.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'money_transfer.amended',
    objectType: TRANSFER_PERMISSION_OBJECT,
    objectId: id,
    branchCode: transfer.branchCode,
    // Amounts arrive as scaled BigInts and the audit payload is JSON, which has
    // no bigint. Rendered as decimal strings — the same form the columns hold —
    // so the trail reads as the document does.
    after: Object.fromEntries(
      Object.entries(changes).map(([key, value]) => [
        key,
        typeof value === 'bigint' ? toDecimalString(value, 4n) : value,
      ]),
    ),
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/** Appendix B's Funded: the client has confirmed and the instruction is agreed. */
export async function markFunded(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const transfer = await loadTransfer(tx, id);

  await authz.authorize(ctx.principal, 'submit', TRANSFER_PERMISSION_OBJECT, {
    branchCode: transfer.branchCode,
    objectId: id,
    requestId: ctx.requestId ?? null,
  });

  await statuses.assertTransitionAllowed(tx, TRANSFER_DOCUMENT_TYPE, transfer.status, 'approved');

  await tx
    .update(moneyTransfer)
    .set({ status: 'approved', updatedAt: new Date() })
    .where(eq(moneyTransfer.id, id));
}

// ---------------------------------------------------------------------------
// 09.5 — Initiate Transfer
// ---------------------------------------------------------------------------

/**
 * §12.3 — Initiate Transfer creates the transfer entry, and the transaction
 * locks. §12.4 — *"Dr Client Clearing / Cr Company Bank Account."*
 *
 * Three things happen together, in one transaction, or none of them do:
 *   1. the client's deposits are allocated to the transfer (which deposit funded
 *      which transfer is the §22 drill-down, and Appendix B's Partially Used);
 *   2. the journal posts by line role through the Phase 02 engine;
 *   3. the document moves to Initiated, at which point the trigger locks it.
 *
 * KYC is asserted first so the caller gets a sentence naming what is missing.
 * The trigger checks it again at the moment of the status change, which is what
 * covers the paths this function is not on.
 */
export async function initiateTransfer(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ journalEntryId: string; fundedByDepositIds: string[] }> {
  const transfer = await loadTransfer(tx, id);

  await authz.authorize(ctx.principal, 'post', TRANSFER_PERMISSION_OBJECT, {
    branchCode: transfer.branchCode,
    objectId: id,
    requestId: ctx.requestId ?? null,
  });

  if (transfer.status !== 'approved') {
    throw new MoneyTransferStateError(
      transfer.transferNo,
      transfer.status,
      'a transfer is initiated once its funding has been confirmed (§12.3).',
    );
  }

  const partner = await partnerFor(tx, transfer.clientAccountId);
  await clientService.assertKycComplete(tx, partner.id, transfer.transferDate);

  const amount = parseDecimal(transfer.transferAmountIqd, 4n);

  // §12.3 — oldest deposit first. The client's own deposits, and only those:
  // the trigger on the usage row refuses one belonging to another account.
  const deposits = await tx
    .select()
    .from(moneyTransferDeposit)
    .where(
      and(
        eq(moneyTransferDeposit.clientAccountId, transfer.clientAccountId),
        sql`${moneyTransferDeposit.status} in ('posted', 'partially_executed')`,
      ),
    )
    .orderBy(asc(moneyTransferDeposit.depositDate), asc(moneyTransferDeposit.depositNo));

  const allocations = allocateAcrossDeposits(
    deposits.map((d) => ({
      id: d.id,
      amountIqd: parseDecimal(d.amountIqd, 4n),
      usedIqd: parseDecimal(d.usedAmountIqd, 4n),
      refundedIqd: parseDecimal(d.refundedAmountIqd, 4n),
    })),
    amount,
  );

  for (const allocation of allocations) {
    await tx.insert(moneyTransferDepositUsage).values({
      depositId: allocation.deposit.id,
      moneyTransferId: id,
      amountIqd: toDecimalString(allocation.appliedIqd, 4n),
      appliedOn: transfer.transferDate,
      createdBy: ctx.principal.userId,
    });
  }

  // Appendix B — Available / Partially Used / Used. Read back rather than
  // computed here, because a trigger has just retotalled them from the usage
  // rows and that total is the one that counts.
  await refreshDepositStatuses(tx, allocations.map((a) => a.deposit.id));

  const criteria = { branchCode: transfer.branchCode };
  const dimensions = { branch: transfer.branchCode, business_partner: partner.code };

  const result = await posting.post(tx, ctx, {
    eventType: 'money_transfer.initiated',
    documentTypeCode: TRANSFER_DOCUMENT_TYPE,
    source: { module: MODULE, documentId: id, event: 'initiated' },
    branchCode: transfer.branchCode,
    documentDate: transfer.transferDate,
    postingDate: transfer.transferDate,
    description: `Money transfer ${transfer.transferNo} — ${partner.code} to ${transfer.beneficiaryName}`,
    lines: [
      { role: LINE_ROLES.clientClearing, debit: transfer.transferAmountIqd, criteria, dimensions },
      { role: LINE_ROLES.bank, credit: transfer.transferAmountIqd, criteria, dimensions },
    ],
  });

  await statuses.assertTransitionAllowed(tx, TRANSFER_DOCUMENT_TYPE, transfer.status, 'posted');

  await tx
    .update(moneyTransfer)
    .set({
      status: 'posted',
      journalEntryId: result.journalEntryId,
      initiatedBy: ctx.principal.userId,
      initiatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(moneyTransfer.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'money_transfer.initiated',
    objectType: TRANSFER_PERMISSION_OBJECT,
    objectId: id,
    branchCode: transfer.branchCode,
    before: { status: 'approved' },
    after: {
      status: 'posted',
      journalEntryId: result.journalEntryId,
      transferAmountIqd: transfer.transferAmountIqd,
      fundedByDepositIds: allocations.map((a) => a.deposit.id),
    },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return {
    journalEntryId: result.journalEntryId,
    fundedByDepositIds: allocations.map((a) => a.deposit.id),
  };
}

/**
 * Appendix B's Available / Partially Used / Used, from the retotalled figures.
 *
 * Derived rather than decided — nobody *chooses* to move a deposit to Partially
 * Used; it becomes that because a transfer consumed part of it. The move still
 * goes through the shared status machine (§3.2), so `document_status_transition`
 * stays the authority on what this document may do, and a derivation that
 * produced an impossible state would be caught rather than written.
 *
 * A return runs the journey backwards: reversing the usage rows takes a Used
 * deposit back to Available, which is why those transitions exist in both
 * directions (§12.6).
 */
async function refreshDepositStatuses(tx: Tx, depositIds: readonly string[]): Promise<void> {
  for (const depositId of depositIds) {
    const deposit = await loadDeposit(tx, depositId);
    if (deposit.status === 'reversed') continue;

    const amount = parseDecimal(deposit.amountIqd, 4n);
    const used = parseDecimal(deposit.usedAmountIqd, 4n);
    const refunded = parseDecimal(deposit.refundedAmountIqd, 4n);
    const consumed = used + refunded;

    const next = consumed === 0n ? 'posted' : consumed >= amount ? 'settled' : 'partially_executed';
    if (next === deposit.status) continue;

    await statuses.assertTransitionAllowed(tx, DEPOSIT_DOCUMENT_TYPE, deposit.status, next);

    await tx
      .update(moneyTransferDeposit)
      .set({ status: next, updatedAt: new Date() })
      .where(eq(moneyTransferDeposit.id, depositId));
  }
}

/** Appendix B's Sent. §12.2 requires the bank reference, and here it exists. */
export async function markSent(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  bankReference: string,
): Promise<void> {
  const transfer = await loadTransfer(tx, id);

  await authz.authorize(ctx.principal, 'execute', TRANSFER_PERMISSION_OBJECT, {
    branchCode: transfer.branchCode,
    objectId: id,
    requestId: ctx.requestId ?? null,
  });

  if (bankReference.trim().length === 0) {
    throw new Error(
      `Transfer ${transfer.transferNo} cannot be marked Sent without the bank reference (§12.2) — ` +
        'it is the only thing tying the instruction to the bank movement.',
    );
  }

  await statuses.assertTransitionAllowed(tx, TRANSFER_DOCUMENT_TYPE, transfer.status, 'executed');

  await tx
    .update(moneyTransfer)
    .set({
      status: 'executed',
      bankReference: bankReference.trim(),
      sentBy: ctx.principal.userId,
      sentAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(moneyTransfer.id, id));
}

/** Appendix B's Completed — the beneficiary has it. */
export async function markCompleted(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const transfer = await loadTransfer(tx, id);

  await authz.authorize(ctx.principal, 'execute', TRANSFER_PERMISSION_OBJECT, {
    branchCode: transfer.branchCode,
    objectId: id,
    requestId: ctx.requestId ?? null,
  });

  await statuses.assertTransitionAllowed(tx, TRANSFER_DOCUMENT_TYPE, transfer.status, 'settled');

  await tx
    .update(moneyTransfer)
    .set({
      status: 'settled',
      completedBy: ctx.principal.userId,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(moneyTransfer.id, id));
}

// ---------------------------------------------------------------------------
// 09.7 — bank fees and direct expenses
// ---------------------------------------------------------------------------

export interface RecordExpenseInput {
  readonly moneyTransferId: string;
  readonly expenseDate: string;
  readonly expenseType: 'bank_charge' | 'other';
  readonly amountIqd: bigint;
  /** §12.6 makes this load-bearing, so it is never defaulted. */
  readonly chargedToClient: boolean;
  readonly companyBankAccountId: string;
  readonly description?: string | null;
}

/**
 * §12.4 — *"Bank fees and direct expenses: Dr Bank Fees / Money Transfer Direct
 * Expense, Cr Company Bank Account."*
 *
 * 09.7 gate: *"Every fee links to a specific transfer"* and *"an unlinked fee
 * cannot be posted to the Money Transfer expense account."* There is no way to
 * create one without a transfer — the column is NOT NULL — so the rule needs no
 * enforcement beyond the shape of the table.
 */
export async function recordExpense(
  tx: Tx,
  ctx: ActorContext,
  input: RecordExpenseInput,
): Promise<{ id: string; expenseNo: string }> {
  const transfer = await loadTransfer(tx, input.moneyTransferId);

  await authz.authorize(ctx.principal, 'create', EXPENSE_PERMISSION_OBJECT, {
    branchCode: transfer.branchCode,
    requestId: ctx.requestId ?? null,
  });

  if (input.amountIqd <= 0n) {
    throw new Error('A charge of nothing is not a charge. State the amount the bank took.');
  }

  const allocated = await allocateDocumentNumber(
    tx,
    EXPENSE_SEQUENCE_KEY,
    { branchCode: transfer.branchCode, year: Number(input.expenseDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(moneyTransferExpense)
    .values({
      expenseNo: allocated.documentNo,
      moneyTransferId: input.moneyTransferId,
      branchCode: transfer.branchCode,
      expenseDate: input.expenseDate,
      expenseType: input.expenseType,
      description: input.description ?? null,
      amountIqd: toDecimalString(input.amountIqd, 4n),
      chargedToClient: input.chargedToClient,
      companyBankAccountId: input.companyBankAccountId,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: moneyTransferExpense.id });

  return { id: created!.id, expenseNo: allocated.documentNo };
}

export async function postExpense(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ journalEntryId: string }> {
  const [expense] = await tx
    .select()
    .from(moneyTransferExpense)
    .where(eq(moneyTransferExpense.id, id))
    .limit(1);

  if (!expense) throw new Error(`No money transfer expense '${id}'.`);

  await authz.authorize(ctx.principal, 'post', EXPENSE_PERMISSION_OBJECT, {
    branchCode: expense.branchCode,
    objectId: id,
    requestId: ctx.requestId ?? null,
  });

  if (expense.status !== 'draft') {
    throw new Error(`Expense ${expense.expenseNo} is '${expense.status}'; only a draft posts.`);
  }

  const transfer = await loadTransfer(tx, expense.moneyTransferId);
  const partner = await partnerFor(tx, transfer.clientAccountId);

  const criteria = { branchCode: expense.branchCode };
  const dimensions = { branch: expense.branchCode, business_partner: partner.code };

  const result = await posting.post(tx, ctx, {
    eventType: 'money_transfer.direct_expense',
    documentTypeCode: EXPENSE_DOCUMENT_TYPE,
    source: { module: MODULE, documentId: id, event: 'posted' },
    branchCode: expense.branchCode,
    documentDate: expense.expenseDate,
    postingDate: expense.expenseDate,
    description: `${expense.expenseType === 'bank_charge' ? 'Bank charge' : 'Direct expense'} ${expense.expenseNo} on transfer ${transfer.transferNo}`,
    lines: [
      { role: LINE_ROLES.transferExpense, debit: expense.amountIqd, criteria, dimensions },
      { role: LINE_ROLES.bank, credit: expense.amountIqd, criteria, dimensions },
    ],
  });

  await statuses.assertTransitionAllowed(tx, EXPENSE_DOCUMENT_TYPE, expense.status, 'posted');

  await tx
    .update(moneyTransferExpense)
    .set({
      status: 'posted',
      journalEntryId: result.journalEntryId,
      postedBy: ctx.principal.userId,
      postedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(moneyTransferExpense.id, id));

  return { journalEntryId: result.journalEntryId };
}

// ---------------------------------------------------------------------------
// 09.8 — the margin
// ---------------------------------------------------------------------------

/**
 * §12.4's six figures for one transfer.
 *
 * Every input is read from posted documents; the arithmetic is the pure domain
 * function, so the number on a report, on a screen and in a test is produced by
 * one piece of code (§24).
 */
export async function margin(tx: Tx, id: string): Promise<TransferMargin> {
  const transfer = await loadTransfer(tx, id);

  const [deposits] = await tx
    .select({
      total: sql<string>`coalesce(sum(${moneyTransferDeposit.amountIqd}), 0)`,
    })
    .from(moneyTransferDeposit)
    .where(
      and(
        eq(moneyTransferDeposit.clientAccountId, transfer.clientAccountId),
        sql`${moneyTransferDeposit.status} in ('posted', 'partially_executed', 'settled', 'closed')`,
      ),
    );

  const [expenses] = await tx
    .select({
      total: sql<string>`coalesce(sum(${moneyTransferExpense.amountIqd}), 0)`,
      chargedToClient: sql<string>`coalesce(sum(${moneyTransferExpense.amountIqd})
        filter (where ${moneyTransferExpense.chargedToClient}), 0)`,
    })
    .from(moneyTransferExpense)
    .where(
      and(
        eq(moneyTransferExpense.moneyTransferId, id),
        eq(moneyTransferExpense.status, 'posted'),
      ),
    );

  return calculateMargin({
    totalClientDepositsIqd: parseDecimal(deposits?.total ?? '0', 4n),
    transferPrincipalIqd: parseDecimal(transfer.transferAmountIqd, 4n),
    requestedUsd: parseDecimal(transfer.requestedUsd, 4n),
    rates: ratesOf(transfer),
    directExpensesIqd: parseDecimal(expenses?.total ?? '0', 4n),
    expensesChargedToClientIqd: parseDecimal(expenses?.chargedToClient ?? '0', 4n),
  });
}

export function ratesOf(transfer: typeof moneyTransfer.$inferSelect): TransferRates {
  return {
    officialIqdPerUsd: parseDecimal(transfer.officialRateIqdPerUsd, RATE_SCALE),
    clientIqdPerUsd: parseDecimal(transfer.clientRateIqdPerUsd, RATE_SCALE),
  };
}

/**
 * §12.6 refers to *"the recognised service result"*, so there is one to
 * recognise. §12.4 makes the account a mapping, and §22 makes the amount a
 * matter of finance policy — *"according to finance policy"*.
 *
 * Finance supplies the amount; this refuses more than the computed Net Service
 * Margin, because recognising more than the service earned would take the
 * client's money into revenue. Recognising *less* is allowed — that is a
 * prudence judgement, and it is theirs.
 */
export async function recogniseServiceResult(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: { amountIqd: bigint; postingDate: string },
): Promise<{ journalEntryId: string }> {
  const transfer = await loadTransfer(tx, id);

  await authz.authorize(ctx.principal, 'post', TRANSFER_PERMISSION_OBJECT, {
    branchCode: transfer.branchCode,
    objectId: id,
    requestId: ctx.requestId ?? null,
  });

  if (transfer.status !== 'executed' && transfer.status !== 'settled') {
    throw new MoneyTransferStateError(
      transfer.transferNo,
      transfer.status,
      'a service result is recognised once the transfer has actually been sent.',
    );
  }

  if (transfer.recognisedAt !== null) {
    throw new MoneyTransferStateError(
      transfer.transferNo,
      transfer.status,
      'its service result has already been recognised; recognising it twice would double the revenue.',
    );
  }

  const computed = await margin(tx, id);
  if (input.amountIqd <= 0n || input.amountIqd > computed.netServiceMarginIqd) {
    throw new Error(
      `Transfer ${transfer.transferNo} earned a Net Service Margin of ` +
        `${toDecimalString(computed.netServiceMarginIqd, 4n)}; ${toDecimalString(input.amountIqd, 4n)} ` +
        'cannot be recognised (§12.4, §22). Recognising more than the service earned would take the ' +
        "client's money into revenue.",
    );
  }

  const partner = await partnerFor(tx, transfer.clientAccountId);
  const criteria = { branchCode: transfer.branchCode };
  const dimensions = { branch: transfer.branchCode, business_partner: partner.code };
  const amount = toDecimalString(input.amountIqd, 4n);

  const result = await posting.post(tx, ctx, {
    eventType: 'money_transfer.result_recognised',
    documentTypeCode: TRANSFER_DOCUMENT_TYPE,
    source: { module: MODULE, documentId: id, event: 'result_recognised' },
    branchCode: transfer.branchCode,
    documentDate: input.postingDate,
    postingDate: input.postingDate,
    description: `Service result recognised on transfer ${transfer.transferNo}`,
    lines: [
      { role: LINE_ROLES.clientClearing, debit: amount, criteria, dimensions },
      { role: LINE_ROLES.serviceRevenue, credit: amount, criteria, dimensions },
    ],
  });

  await tx
    .update(moneyTransfer)
    .set({
      recognisedResultIqd: amount,
      recognitionJournalEntryId: result.journalEntryId,
      recognisedBy: ctx.principal.userId,
      recognisedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(moneyTransfer.id, id));

  return { journalEntryId: result.journalEntryId };
}

// ---------------------------------------------------------------------------
// 09.9 — returned transfers and refunds
// ---------------------------------------------------------------------------

/**
 * §12.6 — *"Initiated -> Sent -> Returned."*
 *
 * *"The system reverses the transfer and recognised service result."* Both are
 * mirrored here through the posting engine, and each mirror is linked to what it
 * reverses using the Phase 02 link (`journal_entry.reverses_id`), which migration
 * 0023 makes permanent in both directions.
 *
 * ── Why not the reversal service ────────────────────────────────────────────
 * `reversal.reverse` refuses an automatically posted journal on purpose: §3.2
 * says such a journal *"belongs to its source document, and is corrected by that
 * document's own return"*. This is that return. Posting the mirror by line role
 * keeps §3.3 intact — the correction resolves its accounts the same way the
 * original did, so a re-mapped account cannot leave the pair unbalanced.
 *
 * *"The company absorbs all bank charges"*: the expense postings are untouched
 * here, deliberately. They stay in the profit and loss, which is what absorbing
 * them means.
 */
export async function markReturned(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: { returnDate: string; reason: string },
): Promise<{ returnJournalEntryId: string }> {
  const transfer = await loadTransfer(tx, id);

  await authz.authorize(ctx.principal, 'reverse_cancel', TRANSFER_PERMISSION_OBJECT, {
    branchCode: transfer.branchCode,
    objectId: id,
    requestId: ctx.requestId ?? null,
  });

  if (transfer.status !== 'executed') {
    throw new MoneyTransferStateError(
      transfer.transferNo,
      transfer.status,
      'only a transfer that was actually sent can come back (§12.6).',
    );
  }

  if (input.reason.trim().length === 0) {
    throw new Error('A returned transfer needs a reason (§5.4) — the client will ask what happened.');
  }

  const partner = await partnerFor(tx, transfer.clientAccountId);
  const criteria = { branchCode: transfer.branchCode };
  const dimensions = { branch: transfer.branchCode, business_partner: partner.code };

  // The mirror of §12.4's second row: the money is back in the bank and the
  // company owes the client again.
  const mirror = await posting.post(tx, ctx, {
    eventType: 'money_transfer.returned',
    documentTypeCode: TRANSFER_DOCUMENT_TYPE,
    source: { module: MODULE, documentId: id, event: 'returned' },
    branchCode: transfer.branchCode,
    documentDate: input.returnDate,
    postingDate: input.returnDate,
    description: `Transfer ${transfer.transferNo} returned: ${input.reason.trim()}`,
    lines: [
      { role: LINE_ROLES.bank, debit: transfer.transferAmountIqd, criteria, dimensions },
      { role: LINE_ROLES.clientClearing, credit: transfer.transferAmountIqd, criteria, dimensions },
    ],
  });

  await linkAsReversal(tx, transfer.journalEntryId, mirror.journalEntryId);

  // §12.6 — "and recognised service result". If Finance recognised one, it is
  // reversed too: a service that did not happen did not earn anything.
  if (transfer.recognitionJournalEntryId && transfer.recognisedResultIqd) {
    const recognitionMirror = await posting.post(tx, ctx, {
      eventType: 'money_transfer.result_recognition_reversed',
      documentTypeCode: TRANSFER_DOCUMENT_TYPE,
      source: { module: MODULE, documentId: id, event: 'result_recognition_reversed' },
      branchCode: transfer.branchCode,
      documentDate: input.returnDate,
      postingDate: input.returnDate,
      description: `Service result reversed on returned transfer ${transfer.transferNo}`,
      lines: [
        {
          role: LINE_ROLES.serviceRevenue,
          debit: transfer.recognisedResultIqd,
          criteria,
          dimensions,
        },
        {
          role: LINE_ROLES.clientClearing,
          credit: transfer.recognisedResultIqd,
          criteria,
          dimensions,
        },
      ],
    });

    await linkAsReversal(tx, transfer.recognitionJournalEntryId, recognitionMirror.journalEntryId);
  }

  // The client's deposits are theirs again. Reversing the usage rows restores
  // the clearing balance to its pre-transfer position exactly — the 09.9 gate —
  // because the totals are recomputed from the live rows by trigger.
  const usages = await tx
    .select()
    .from(moneyTransferDepositUsage)
    .where(
      and(
        eq(moneyTransferDepositUsage.moneyTransferId, id),
        isNull(moneyTransferDepositUsage.reversedAt),
      ),
    );

  for (const usage of usages) {
    await tx
      .update(moneyTransferDepositUsage)
      .set({
        reversedBy: ctx.principal.userId,
        reversedAt: new Date(),
        reversalReason: `Transfer ${transfer.transferNo} returned: ${input.reason.trim()}`,
      })
      .where(eq(moneyTransferDepositUsage.id, usage.id));
  }

  await refreshDepositStatuses(tx, usages.map((u) => u.depositId));

  await statuses.assertTransitionAllowed(
    tx,
    TRANSFER_DOCUMENT_TYPE,
    transfer.status,
    'rejected',
    input.reason,
  );

  await tx
    .update(moneyTransfer)
    .set({
      status: 'rejected',
      returnedBy: ctx.principal.userId,
      returnedAt: new Date(),
      returnReason: input.reason.trim(),
      returnJournalEntryId: mirror.journalEntryId,
      updatedAt: new Date(),
    })
    .where(eq(moneyTransfer.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'money_transfer.returned',
    objectType: TRANSFER_PERMISSION_OBJECT,
    objectId: id,
    branchCode: transfer.branchCode,
    before: { status: 'executed' },
    after: { status: 'rejected', returnJournalEntryId: mirror.journalEntryId },
    reason: input.reason.trim(),
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return { returnJournalEntryId: mirror.journalEntryId };
}

/**
 * Appendix C — *"Original and reversal linked permanently"*, in both directions.
 *
 * Written once and never rewritten; migration 0023's trigger refuses any later
 * change, so an auditor holding either document always reaches the other.
 */
async function linkAsReversal(
  tx: Tx,
  originalId: string | null,
  mirrorId: string,
): Promise<void> {
  if (!originalId) return;

  await tx
    .update(journalEntry)
    .set({ reversesId: originalId })
    .where(eq(journalEntry.id, mirrorId));

  await tx
    .update(journalEntry)
    .set({ status: 'reversed', reversedById: mirrorId })
    .where(eq(journalEntry.id, originalId));
}

/**
 * §12.6 — *"The client receives a full refund. The company absorbs all bank
 * charges."*
 *
 * The amount is not a parameter. It is the client's whole remaining clearing
 * balance, computed here and checked again by a trigger, because the one thing
 * §12.6 forbids is a refund that has had the charges taken out of it. Offering
 * the caller a number to type would make the rule optional.
 */
export async function refundClient(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: { refundDate: string },
): Promise<{ journalEntryId: string; refundedIqd: bigint }> {
  const transfer = await loadTransfer(tx, id);

  await authz.authorize(ctx.principal, 'post', TRANSFER_PERMISSION_OBJECT, {
    branchCode: transfer.branchCode,
    objectId: id,
    requestId: ctx.requestId ?? null,
  });

  if (transfer.status !== 'rejected') {
    throw new MoneyTransferStateError(
      transfer.transferNo,
      transfer.status,
      'a refund follows a returned transfer (§12.6: Initiated -> Sent -> Returned -> Refunded).',
    );
  }

  const balance = await clientService.clearingBalance(tx, transfer.clientAccountId);
  if (balance <= 0n) {
    throw new Error(
      `Transfer ${transfer.transferNo} has no client balance left to refund. The return should have ` +
        'restored it; check that the transfer posting was actually reversed.',
    );
  }

  const partner = await partnerFor(tx, transfer.clientAccountId);
  const criteria = { branchCode: transfer.branchCode };
  const dimensions = { branch: transfer.branchCode, business_partner: partner.code };
  const amount = toDecimalString(balance, 4n);

  const result = await posting.post(tx, ctx, {
    eventType: 'money_transfer.client_refund',
    documentTypeCode: TRANSFER_DOCUMENT_TYPE,
    source: { module: MODULE, documentId: id, event: 'refunded' },
    branchCode: transfer.branchCode,
    documentDate: input.refundDate,
    postingDate: input.refundDate,
    description: `Full refund to ${partner.code} for returned transfer ${transfer.transferNo}`,
    lines: [
      { role: LINE_ROLES.clientClearing, debit: amount, criteria, dimensions },
      { role: LINE_ROLES.bank, credit: amount, criteria, dimensions },
    ],
  });

  await statuses.assertTransitionAllowed(tx, TRANSFER_DOCUMENT_TYPE, transfer.status, 'closed');

  // Before the deposits are marked refunded: the trigger recomputes the balance
  // from them and compares it with this figure, which is what proves the refund
  // was the whole of it.
  await tx
    .update(moneyTransfer)
    .set({
      status: 'closed',
      refundAmountIqd: amount,
      refundJournalEntryId: result.journalEntryId,
      refundedBy: ctx.principal.userId,
      refundedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(moneyTransfer.id, id));

  const deposits = await tx
    .select()
    .from(moneyTransferDeposit)
    .where(
      and(
        eq(moneyTransferDeposit.clientAccountId, transfer.clientAccountId),
        sql`${moneyTransferDeposit.status} in ('posted', 'partially_executed', 'settled')`,
      ),
    );

  for (const deposit of deposits) {
    const available =
      parseDecimal(deposit.amountIqd, 4n) -
      parseDecimal(deposit.usedAmountIqd, 4n) -
      parseDecimal(deposit.refundedAmountIqd, 4n);
    if (available <= 0n) continue;

    await tx
      .update(moneyTransferDeposit)
      .set({
        refundedAmountIqd: toDecimalString(
          parseDecimal(deposit.refundedAmountIqd, 4n) + available,
          4n,
        ),
        status: 'closed',
        updatedAt: new Date(),
      })
      .where(eq(moneyTransferDeposit.id, deposit.id));
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'money_transfer.refunded',
    objectType: TRANSFER_PERMISSION_OBJECT,
    objectId: id,
    branchCode: transfer.branchCode,
    before: { status: 'rejected' },
    after: { status: 'closed', refundAmountIqd: amount, journalEntryId: result.journalEntryId },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return { journalEntryId: result.journalEntryId, refundedIqd: balance };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * §22's drill-down — *"client → case → deposit → settlement → journal"*.
 *
 * One query, returning the whole chain for a transfer, because a margin figure
 * nobody can trace back to a bank movement is a number rather than a fact.
 */
export async function drillDown(tx: Tx, id: string) {
  return tx
    .select({
      clientCode: businessPartner.code,
      clientName: businessPartner.legalName,
      accountNo: moneyTransferClientAccount.accountNo,
      depositNo: moneyTransferDeposit.depositNo,
      depositDate: moneyTransferDeposit.depositDate,
      depositAmountIqd: moneyTransferDeposit.amountIqd,
      depositJournalEntryId: moneyTransferDeposit.journalEntryId,
      settlementAmountIqd: moneyTransferDepositUsage.amountIqd,
      settlementDate: moneyTransferDepositUsage.appliedOn,
      settlementReversedAt: moneyTransferDepositUsage.reversedAt,
      transferNo: moneyTransfer.transferNo,
      transferJournalEntryId: moneyTransfer.journalEntryId,
    })
    .from(moneyTransferDepositUsage)
    .innerJoin(moneyTransfer, eq(moneyTransfer.id, moneyTransferDepositUsage.moneyTransferId))
    .innerJoin(
      moneyTransferDeposit,
      eq(moneyTransferDeposit.id, moneyTransferDepositUsage.depositId),
    )
    .innerJoin(
      moneyTransferClientAccount,
      eq(moneyTransferClientAccount.id, moneyTransfer.clientAccountId),
    )
    .innerJoin(businessPartner, eq(businessPartner.id, moneyTransferClientAccount.partnerId))
    .where(eq(moneyTransfer.id, id))
    .orderBy(asc(moneyTransferDeposit.depositDate));
}

export async function view(tx: Tx, id: string) {
  const transfer = await loadTransfer(tx, id);
  const [bank] = await tx
    .select({ code: bankCashAccount.code, name: bankCashAccount.name })
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, transfer.companyBankAccountId))
    .limit(1);

  return { transfer, bankAccount: bank ?? null, margin: await margin(tx, id) };
}
