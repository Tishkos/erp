/**
 * Bank Execution Batch — Phase 09.6, §12.5.
 *
 * > *"One bank debit can combine several internally separate transactions, such
 * > as a client transfer and a company import payment. Bank Execution Batch shall
 * > contain separate source lines that retain their own document, client/vendor,
 * > branch, cost centre, accounting and margin. The batch total shall reconcile
 * > to the single bank-statement amount."*
 *
 * ── The batch posts nothing ─────────────────────────────────────────────────
 * The verb in §12.5 is *retain*, not *create*. Each source document has already
 * posted its own journal, by its own line roles, against its own client or
 * vendor — the client transfer at Initiate Transfer (§12.4), the client import
 * payment when it was paid. A batch that posted would have to merge those into
 * one entry, which is precisely the separation §12.5 exists to protect.
 *
 * So execution stamps each line with the journal its document already produced
 * and with that document's margin, and the batch becomes the one place where the
 * bank's single debit is explained. Two consequences worth naming:
 *
 *   · *"Reversing one line does not corrupt the others"* is true by
 *     construction, because there is no shared journal to corrupt. Reversing a
 *     line means reversing its own document, through that document's own path.
 *   · The 09.6 gate's *"both lines' accounting fully separate"* is not something
 *     this service has to maintain; it is something it never had the chance to
 *     break.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  bankExecutionBatch,
  bankExecutionBatchLine,
  businessPartner,
  clientImportPayment,
  moneyTransfer,
  moneyTransferClientAccount,
} from '../db/schema';
import {
  batchLinesSumTo,
  BatchOutOfBalanceError,
  sumOf,
} from '../domain/money-transfer';
import { parseDecimal, toDecimalString } from '../domain/money';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';
import * as moneyTransferService from './money-transfer';
import * as statuses from './statuses';
import { allocateDocumentNumber } from './numbering';

export const DOCUMENT_TYPE = 'bank_execution_batch';
export const PERMISSION_OBJECT = 'bank_execution_batch';
const SEQUENCE_KEY = 'BANK_EXECUTION_BATCH';

export class BankExecutionBatchStateError extends Error {
  readonly code = 'BANK_EXECUTION_BATCH_STATE_INVALID';
  constructor(batchNo: string, status: string, detail: string) {
    super(`Bank execution batch ${batchNo} is '${status}': ${detail}`);
    this.name = 'BankExecutionBatchStateError';
  }
}

async function load(tx: Tx, id: string) {
  const [row] = await tx
    .select()
    .from(bankExecutionBatch)
    .where(eq(bankExecutionBatch.id, id))
    .limit(1);
  if (!row) throw new Error(`No bank execution batch '${id}'.`);
  return row;
}

export interface OpenBatchInput {
  readonly branchCode: string;
  readonly bankCashAccountId: string;
  readonly executionDate: string;
  /** The single amount the bank debited, from the bank advice. */
  readonly totalIqd: bigint;
  readonly bankReference?: string | null;
  readonly note?: string | null;
}

/**
 * Opens a batch against a bank debit that is about to happen, or has.
 *
 * The total comes from the bank, not from the lines. That is the whole design:
 * if this service summed the lines to produce it, §12.7's *"lines sum exactly to
 * the bank execution total"* would be an identity rather than a control, and the
 * one error it exists to catch — the company's explanation not accounting for
 * the whole of what left the bank — would be uncatchable.
 */
export async function openBatch(
  tx: Tx,
  ctx: ActorContext,
  input: OpenBatchInput,
): Promise<{ id: string; batchNo: string }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
    requestId: ctx.requestId ?? null,
  });

  if (input.totalIqd <= 0n) {
    throw new Error('A bank debit of nothing is not a bank debit. State the amount the bank took.');
  }

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: input.branchCode, year: Number(input.executionDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(bankExecutionBatch)
    .values({
      batchNo: allocated.documentNo,
      branchCode: input.branchCode,
      bankCashAccountId: input.bankCashAccountId,
      executionDate: input.executionDate,
      totalIqd: toDecimalString(input.totalIqd, 4n),
      bankReference: input.bankReference ?? null,
      note: input.note ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: bankExecutionBatch.id });

  return { id: created!.id, batchNo: allocated.documentNo };
}

/**
 * Adds one source document's share of the bank debit.
 *
 * Branch, counterparty and amount are read from the document rather than
 * supplied: §12.5 says each line *retains* its document's own values, and a line
 * that could be given different ones would be a line that could disagree with
 * what it claims to describe. The database checks the same thing again, so no
 * path can bypass it.
 */
export async function addLine(
  tx: Tx,
  ctx: ActorContext,
  input: {
    batchId: string;
    source:
      | { kind: 'money_transfer'; id: string }
      | { kind: 'client_import_payment'; id: string };
    costCentreCode?: string | null;
    note?: string | null;
  },
): Promise<{ id: string; lineNo: number }> {
  const batch = await load(tx, input.batchId);

  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, {
    branchCode: batch.branchCode,
    objectId: input.batchId,
    requestId: ctx.requestId ?? null,
  });

  if (batch.status !== 'draft' && batch.status !== 'approved') {
    throw new BankExecutionBatchStateError(
      batch.batchNo,
      batch.status,
      'the bank has already debited it, so nothing more can be added (§12.5).',
    );
  }

  let branchCode: string;
  let counterpartyPartnerId: string | null;
  let amountIqd: string;

  if (input.source.kind === 'money_transfer') {
    const [row] = await tx
      .select({
        branchCode: moneyTransfer.branchCode,
        partnerId: moneyTransferClientAccount.partnerId,
        amountIqd: moneyTransfer.transferAmountIqd,
      })
      .from(moneyTransfer)
      .innerJoin(
        moneyTransferClientAccount,
        eq(moneyTransferClientAccount.id, moneyTransfer.clientAccountId),
      )
      .where(eq(moneyTransfer.id, input.source.id))
      .limit(1);

    if (!row) throw new Error(`No money transfer '${input.source.id}'.`);
    branchCode = row.branchCode;
    counterpartyPartnerId = row.partnerId;
    amountIqd = row.amountIqd;
  } else {
    const [row] = await tx
      .select({
        branchCode: clientImportPayment.branchCode,
        partnerId: clientImportPayment.supplierPartnerId,
        amountIqd: clientImportPayment.amountIqd,
      })
      .from(clientImportPayment)
      .where(eq(clientImportPayment.id, input.source.id))
      .limit(1);

    if (!row) throw new Error(`No client import payment '${input.source.id}'.`);
    branchCode = row.branchCode;
    counterpartyPartnerId = row.partnerId;
    amountIqd = row.amountIqd;
  }

  const [numbering] = await tx
    .select({ next: sql<number>`coalesce(max(${bankExecutionBatchLine.lineNo}), 0) + 1` })
    .from(bankExecutionBatchLine)
    .where(eq(bankExecutionBatchLine.batchId, input.batchId));

  const next = Number(numbering?.next ?? 1);

  const [created] = await tx
    .insert(bankExecutionBatchLine)
    .values({
      batchId: input.batchId,
      lineNo: next,
      sourceDocumentType: input.source.kind,
      moneyTransferId: input.source.kind === 'money_transfer' ? input.source.id : null,
      clientImportPaymentId:
        input.source.kind === 'client_import_payment' ? input.source.id : null,
      counterpartyPartnerId,
      branchCode,
      costCentreCode: input.costCentreCode ?? null,
      amountIqd,
      note: input.note ?? null,
    })
    .returning({ id: bankExecutionBatchLine.id });

  return { id: created!.id, lineNo: next };
}

export async function approveBatch(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const batch = await load(tx, id);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: batch.branchCode,
    objectId: id,
    requestId: ctx.requestId ?? null,
  });

  if (batch.createdBy === ctx.principal.userId) {
    throw new BankExecutionBatchStateError(
      batch.batchNo,
      batch.status,
      'the person who composed a bank debit cannot approve it — approving it releases company money (§5.2).',
    );
  }

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, batch.status, 'approved');

  await tx
    .update(bankExecutionBatch)
    .set({
      status: 'approved',
      approvedBy: ctx.principal.userId,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(bankExecutionBatch.id, id));
}

/**
 * §12.7 acceptance 3 — *"Bank Execution Batch lines sum exactly to the bank
 * execution total."*
 *
 * Checked here so the caller gets a sentence with both figures and the
 * difference; checked again by a trigger, which is the one that matters, because
 * it holds on every path.
 *
 * Each line is then stamped with the journal its own document produced and with
 * that document's margin — §12.5's *"their own ... accounting and margin"*.
 */
export async function executeBatch(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ lineCount: number; totalIqd: bigint }> {
  const batch = await load(tx, id);

  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
    branchCode: batch.branchCode,
    objectId: id,
    requestId: ctx.requestId ?? null,
  });

  if (batch.status !== 'approved') {
    throw new BankExecutionBatchStateError(
      batch.batchNo,
      batch.status,
      'a batch is executed once it has been approved (§5.2).',
    );
  }

  const lines = await liveLines(tx, id);
  const total = parseDecimal(batch.totalIqd, 4n);
  const amounts = lines.map((line) => parseDecimal(line.amountIqd, 4n));

  if (lines.length === 0) {
    throw new BatchOutOfBalanceError(batch.batchNo, total, 0n);
  }

  if (!batchLinesSumTo(total, amounts)) {
    throw new BatchOutOfBalanceError(batch.batchNo, total, sumOf(amounts));
  }

  for (const line of lines) {
    let journalEntryId: string | null = null;
    let marginIqd: string | null = null;

    if (line.moneyTransferId) {
      const transfer = await moneyTransferService.loadTransfer(tx, line.moneyTransferId);
      journalEntryId = transfer.journalEntryId;
      const computed = await moneyTransferService.margin(tx, line.moneyTransferId);
      marginIqd = toDecimalString(computed.netServiceMarginIqd, 4n);
    } else if (line.clientImportPaymentId) {
      const [payment] = await tx
        .select({ journalEntryId: clientImportPayment.journalEntryId })
        .from(clientImportPayment)
        .where(eq(clientImportPayment.id, line.clientImportPaymentId))
        .limit(1);
      journalEntryId = payment?.journalEntryId ?? null;
      // A client-funded import payment earns no margin of its own: §12.4 sends
      // it to Client Inventory, and the logistics service that moved the goods
      // records its result separately in Phase 10 (§11.3). Zero here would be a
      // claim; null is the truth.
      marginIqd = null;
    }

    await tx
      .update(bankExecutionBatchLine)
      .set({ journalEntryId, marginIqd })
      .where(eq(bankExecutionBatchLine.id, line.id));
  }

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, batch.status, 'executed');

  await tx
    .update(bankExecutionBatch)
    .set({
      status: 'executed',
      executedBy: ctx.principal.userId,
      executedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(bankExecutionBatch.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'bank_execution_batch.executed',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: batch.branchCode,
    before: { status: 'approved' },
    after: { status: 'executed', totalIqd: batch.totalIqd, lineCount: lines.length },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return { lineCount: lines.length, totalIqd: total };
}

/**
 * §12.5 — *"The batch total shall reconcile to the single bank-statement
 * amount."*
 *
 * The statement line is a reference rather than a link: Phase 07.7 owns bank
 * statements and does not exist yet. When it does, this column becomes a foreign
 * key and this function gains a lookup; nothing else about the reconciliation
 * changes, which is why it is worth building now rather than waiting.
 */
export async function reconcileToStatement(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  statementLineRef: string,
): Promise<void> {
  const batch = await load(tx, id);

  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, {
    branchCode: batch.branchCode,
    objectId: id,
    requestId: ctx.requestId ?? null,
  });

  if (batch.status !== 'executed') {
    throw new BankExecutionBatchStateError(
      batch.batchNo,
      batch.status,
      'only an executed batch appears on a bank statement.',
    );
  }

  if (statementLineRef.trim().length === 0) {
    throw new Error(
      'Reconciling a batch means naming the statement line it matched (§12.5). ' +
        'A reconciliation with nothing on the other side is a tick, not a match.',
    );
  }

  await statuses.assertTransitionAllowed(tx, DOCUMENT_TYPE, batch.status, 'settled');

  await tx
    .update(bankExecutionBatch)
    .set({
      status: 'settled',
      statementLineRef: statementLineRef.trim(),
      reconciledBy: ctx.principal.userId,
      reconciledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(bankExecutionBatch.id, id));
}

/**
 * 09.6 gate — *"Reversing one line does not corrupt the others."*
 *
 * The line is marked reversed and carries the journal that reversed its source
 * document. The other lines are not read, not written and not recomputed — there
 * is nothing shared between them to disturb. The batch total stays as the bank
 * recorded it, because the bank did debit that amount; what changed is what one
 * of the lines turned out to be for.
 */
export async function reverseLine(
  tx: Tx,
  ctx: ActorContext,
  lineId: string,
  input: { reason: string; reversalJournalEntryId?: string | null },
): Promise<void> {
  const [line] = await tx
    .select()
    .from(bankExecutionBatchLine)
    .where(eq(bankExecutionBatchLine.id, lineId))
    .limit(1);

  if (!line) throw new Error(`No bank execution batch line '${lineId}'.`);

  await authz.authorize(ctx.principal, 'reverse_cancel', PERMISSION_OBJECT, {
    branchCode: line.branchCode,
    objectId: lineId,
    requestId: ctx.requestId ?? null,
  });

  if (input.reason.trim().length === 0) {
    throw new Error('A reversed batch line needs a reason (§5.4).');
  }

  if (line.reversedAt !== null) {
    throw new Error('That batch line has already been reversed; a reversal happens once.');
  }

  await tx
    .update(bankExecutionBatchLine)
    .set({
      reversedBy: ctx.principal.userId,
      reversedAt: new Date(),
      reversalReason: input.reason.trim(),
      reversalJournalEntryId: input.reversalJournalEntryId ?? null,
    })
    .where(eq(bankExecutionBatchLine.id, lineId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'bank_execution_batch_line.reversed',
    objectType: PERMISSION_OBJECT,
    objectId: lineId,
    branchCode: line.branchCode,
    reason: input.reason.trim(),
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

async function liveLines(tx: Tx, batchId: string) {
  return tx
    .select()
    .from(bankExecutionBatchLine)
    .where(
      and(
        eq(bankExecutionBatchLine.batchId, batchId),
        isNull(bankExecutionBatchLine.reversedAt),
      ),
    )
    .orderBy(asc(bankExecutionBatchLine.lineNo));
}

/**
 * §12.7 — Bank Execution Batch Reconciliation.
 *
 * Every line of a batch with the counterparty, branch, cost centre, journal and
 * margin that belong to it, beside the single bank figure they explain. Reading
 * it is how §12.5's "internally separate" becomes something a person can check
 * rather than a promise.
 */
export async function reconciliationFor(tx: Tx, batchId: string) {
  const batch = await load(tx, batchId);

  const lines = await tx
    .select({
      lineNo: bankExecutionBatchLine.lineNo,
      sourceDocumentType: bankExecutionBatchLine.sourceDocumentType,
      transferNo: moneyTransfer.transferNo,
      paymentNo: clientImportPayment.paymentNo,
      counterpartyCode: businessPartner.code,
      branchCode: bankExecutionBatchLine.branchCode,
      costCentreCode: bankExecutionBatchLine.costCentreCode,
      amountIqd: bankExecutionBatchLine.amountIqd,
      journalEntryId: bankExecutionBatchLine.journalEntryId,
      marginIqd: bankExecutionBatchLine.marginIqd,
      reversedAt: bankExecutionBatchLine.reversedAt,
      reversalReason: bankExecutionBatchLine.reversalReason,
    })
    .from(bankExecutionBatchLine)
    .leftJoin(moneyTransfer, eq(moneyTransfer.id, bankExecutionBatchLine.moneyTransferId))
    .leftJoin(
      clientImportPayment,
      eq(clientImportPayment.id, bankExecutionBatchLine.clientImportPaymentId),
    )
    .leftJoin(
      businessPartner,
      eq(businessPartner.id, bankExecutionBatchLine.counterpartyPartnerId),
    )
    .where(eq(bankExecutionBatchLine.batchId, batchId))
    .orderBy(asc(bankExecutionBatchLine.lineNo));

  const live = lines.filter((line) => line.reversedAt === null);
  const lineSum = sumOf(live.map((line) => parseDecimal(line.amountIqd, 4n)));

  return {
    batchNo: batch.batchNo,
    status: batch.status,
    executionDate: batch.executionDate,
    bankReference: batch.bankReference,
    statementLineRef: batch.statementLineRef,
    totalIqd: batch.totalIqd,
    lineSumIqd: toDecimalString(lineSum, 4n),
    differenceIqd: toDecimalString(parseDecimal(batch.totalIqd, 4n) - lineSum, 4n),
    lines,
  };
}
