/**
 * Reversal service — Phase 02.8.
 *
 * One operation: reverse a posted manual journal, in full, on a date at or
 * after the original's. The two documents are linked permanently and both
 * become read-only, which the database enforces independently of this code.
 */
import { eq } from 'drizzle-orm';
import {
  assertReversalDate,
  assertReversalReason,
  assertReversible,
  mirrorLines,
} from '../domain/reversal';
import { journalEntry, journalLine } from '../db/schema';
import type { Tx } from '../db/client';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';
import * as journal from './journal';
import * as periodService from './periods';
import * as statuses from './statuses';
import * as subledgerService from './subledger';
import { allocateDocumentNumber } from './numbering';

const SEQUENCE_KEY = 'JOURNAL_ENTRY';

export interface ReverseInput {
  /** §14.3 — equal to or later than the original posting date. */
  readonly reversalDate: string;
  readonly reason: string;
  /** Required when the reversal date falls in a soft-closed period. */
  readonly overrideReason?: string | null;
}

export interface ReversalResult {
  readonly reversalId: string;
  readonly reversalEntryNo: string;
  readonly originalId: string;
  readonly originalEntryNo: string;
}

/**
 * Reverses a posted journal in full.
 *
 * The reversal copies the original's IQD and USD figures rather than
 * reconverting at the reversal date's rate. Reconverting would leave a residue
 * on every account the journal touched, so the reversal would not actually
 * reverse it — see the note in `@domain/reversal`.
 */
export async function reverse(
  tx: Tx,
  ctx: ActorContext,
  journalEntryId: string,
  input: ReverseInput,
): Promise<ReversalResult> {
  const original = await journal.loadHeader(tx, journalEntryId);

  await authz.authorize(ctx.principal, 'reverse_cancel', journal.PERMISSION_OBJECT, {
    branchCode: original.branchCode,
    objectId: journalEntryId,
    requestId: ctx.requestId ?? null,
  });

  assertReversible({
    id: original.id,
    entryNo: original.entryNo,
    status: original.status,
    postingDate: original.postingDate,
    source: original.source,
    reversesId: original.reversesId,
    reversedById: original.reversedById,
  });
  assertReversalDate(
    { ...original, reversesId: original.reversesId, reversedById: original.reversedById },
    input.reversalDate,
  );
  assertReversalReason(original.entryNo, input.reason);

  await statuses.assertTransitionAllowed(
    tx,
    journal.DOCUMENT_TYPE,
    original.status,
    'reversed',
    input.reason,
  );

  // The reversal is a posting in its own right, so the period must accept it.
  await periodService.authorisePosting(tx, ctx, {
    postingDate: input.reversalDate,
    documentType: journal.DOCUMENT_TYPE,
    documentId: `reversal-of-${original.entryNo}`,
    overrideReason: input.overrideReason ?? null,
  });

  const period = await periodService.periodFor(tx, input.reversalDate);
  const lines = await journal.loadLines(tx, journalEntryId);
  const mirrored = mirrorLines(lines);

  const year = Number(input.reversalDate.slice(0, 4));
  const { documentNo: reversalEntryNo } = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { year },
    ctx.principal.userId,
  );

  const [reversal] = await tx
    .insert(journalEntry)
    .values({
      entryNo: reversalEntryNo,
      documentDate: input.reversalDate,
      postingDate: input.reversalDate,
      fiscalPeriodId: period.id,
      branchCode: original.branchCode,
      description: `Reversal of ${original.entryNo}: ${input.reason.trim()}`,
      journalType: 'standard',
      source: 'manual',
      status: 'draft',
      reversesId: original.id,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: journalEntry.id, entryNo: journalEntry.entryNo });

  // The original's own line rows carry the rate references; they are copied so
  // both documents point at the same historical rate.
  const originalLineRows = await tx
    .select()
    .from(journalLine)
    .where(eq(journalLine.journalEntryId, journalEntryId));

  const byLineNo = new Map(originalLineRows.map((row) => [row.lineNo, row]));

  for (const line of mirrored) {
    const source = byLineNo.get(line.lineNo)!;
    await tx.insert(journalLine).values({
      journalEntryId: reversal!.id,
      lineNo: line.lineNo,
      accountId: line.accountId,
      debitTxn: source.creditTxn,
      creditTxn: source.debitTxn,
      currency: source.currency,
      debitIqd: source.creditIqd,
      creditIqd: source.debitIqd,
      debitUsd: source.creditUsd,
      creditUsd: source.debitUsd,
      txnRateId: source.txnRateId,
      usdRateId: source.usdRateId,
      branchCode: source.branchCode,
      departmentCode: source.departmentCode,
      businessLineCode: source.businessLineCode,
      projectCode: source.projectCode,
      warehouseCode: source.warehouseCode,
      businessPartnerCode: source.businessPartnerCode,
      employeeCode: source.employeeCode,
      bankAccountCode: source.bankAccountCode,
      loanNo: source.loanNo,
      lineDescription: `Reversal of line ${line.lineNo}`,
      sourceLineId: source.sourceLineId,
      postingRuleId: source.postingRuleId,
      lineRole: source.lineRole,
    });
  }

  await tx
    .update(journalEntry)
    .set({
      status: 'posted',
      approvedBy: ctx.principal.userId,
      approvedAt: new Date(),
      postedAt: new Date(),
    })
    .where(eq(journalEntry.id, reversal!.id));

  // The mirrored subledger movements, so a customer or supplier balance is
  // undone by the reversal exactly as the G/L account is (§1.2).
  await subledgerService.writeForJournal(tx, reversal!.id);

  // Appendix C — "Original and reversal linked permanently", in both
  // directions, so either document leads to the other.
  await tx
    .update(journalEntry)
    .set({ status: 'reversed', reversedById: reversal!.id })
    .where(eq(journalEntry.id, original.id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'journal_entry.reversed',
    objectType: journal.PERMISSION_OBJECT,
    objectId: original.id,
    branchCode: original.branchCode,
    before: { status: 'posted' },
    after: { status: 'reversed', reversedBy: reversal!.entryNo },
    reason: input.reason,
    relatedObjectId: reversal!.id,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return {
    reversalId: reversal!.id,
    reversalEntryNo: reversal!.entryNo,
    originalId: original.id,
    originalEntryNo: original.entryNo,
  };
}
