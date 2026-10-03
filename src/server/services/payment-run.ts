/**
 * Payment proposal, payment batch and maker-checker — Phase 07.2 and 07.3.
 *
 * > §15: *"Include due items in payment proposal based on due date, priority,
 * > discount and available cash."* · *"Payment proposal includes only eligible
 * > approved items."*
 * > §17: *"Generate payment batch and bank instruction/reference."* ·
 * > *"Creator, approver and executor shall be different users for high-risk
 * > payments."* · *"Payments cannot use inactive/unverified beneficiary bank
 * > details."*
 *
 * Three documents and four hands. The proposal says what *could* be paid, the
 * batch says what *will* be, and the execution says what *was* — and §17 puts a
 * different person behind each of the last three transitions.
 *
 * **The batch does not invent a ledger entry.** Each executed line becomes a
 * Phase 05 `supplier_payment`, which posts through the Phase 02 engine and
 * allocates to the invoice exactly as a hand-raised payment does. A batch that
 * posted its own journal would be a second way for money to leave the company,
 * and the first thing that would go wrong is that the two disagreed.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  apInvoice,
  bankCashAccount,
  businessPartner,
  partnerBankAccount,
  paymentBatch,
  paymentBatchLine,
  paymentProposal,
  paymentProposalItem,
  paymentRiskPolicy,
  paymentTerms,
  supplierAdvance,
} from '../db/schema';
import { parseDecimal, toDecimalString } from '../domain/money';
import {
  assertBeneficiaryPayable,
  classify,
  discountOpportunity,
  isHighRisk,
  selectWithinFunds,
  type Candidate,
  type Classified,
} from '../domain/payment-run';
import { assertSegregation } from '../domain/treasury';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as posting from './posting';
import * as statuses from './statuses';
import * as supplierPayments from './supplier-payment';
import * as advances from './supplier-advance';
import * as treasury from './treasury';
import { allocateDocumentNumber } from './numbering';

export const PROPOSAL_DOCUMENT_TYPE = 'payment_proposal';
export const BATCH_DOCUMENT_TYPE = 'payment_batch';
export const PERMISSION_OBJECT = 'payment_batch';
const PROPOSAL_SEQUENCE = 'PAYMENT_PROPOSAL';
const BATCH_SEQUENCE = 'PAYMENT_BATCH';

export class PaymentRunStateError extends Error {
  readonly code = 'PAYMENT_RUN_STATE_INVALID';
  constructor(documentNo: string, status: string, detail: string) {
    super(`${documentNo} is '${status}': ${detail}`);
    this.name = 'PaymentRunStateError';
  }
}

export class EmptyProposalError extends Error {
  readonly code = 'PROPOSAL_SELECTED_NOTHING';
  constructor(readonly proposalNo: string) {
    super(
      `${proposalNo} selected nothing, so there is no batch to raise. ` +
        'The proposal itself still records every item it considered and why each was left out — ' +
        'which is usually the answer somebody is looking for.',
    );
    this.name = 'EmptyProposalError';
  }
}

// ---------------------------------------------------------------------------
// The threshold that decides whether §17's segregation applies
// ---------------------------------------------------------------------------

/**
 * §17 — the high-risk threshold in force for a branch.
 *
 * The branch's own row wins; the company-wide row is the fallback; **no row at
 * all means every payment is high-risk**. Three states, and the least-configured
 * one is the most cautious, which is the only safe direction for a control that
 * decides whether a second signature is needed (D13).
 */
export async function highRiskThreshold(
  tx: Tx,
  branchCode: string,
): Promise<bigint | null> {
  const rows = await tx
    .select({
      branchCode: paymentRiskPolicy.branchCode,
      thresholdIqd: paymentRiskPolicy.highRiskThresholdIqd,
    })
    .from(paymentRiskPolicy)
    .where(
      sql`${paymentRiskPolicy.branchCode} = ${branchCode} or ${paymentRiskPolicy.branchCode} is null`,
    );

  const forBranch = rows.find((row) => row.branchCode === branchCode) ?? rows[0];
  return forBranch ? parseDecimal(forBranch.thresholdIqd, 4n) : null;
}

// ---------------------------------------------------------------------------
// 07.2 — building the proposal
// ---------------------------------------------------------------------------

export interface BuildProposalInput {
  readonly branchCode: string;
  readonly bankCashAccountId: string;
  readonly proposalDate: string;
  readonly payDate: string;
  readonly note?: string | null;
  /**
   * Caps the run below the account's real balance — a Treasury decision to hold
   * something back. Never raises it: `availableFunds` is the ceiling.
   */
  readonly cashCeilingIqd?: bigint | null;
}

/**
 * §15 — the payment proposal.
 *
 * Everything the query can see is classified; nothing is filtered out in SQL.
 * That is the difference between a proposal and a list: the SQL selects
 * *candidates*, and the reasons an item is not being paid are recorded rather
 * than expressed as an absence. Finance's first question about a payment run is
 * always about something that is missing from it.
 */
export async function buildProposal(
  tx: Tx,
  ctx: ActorContext,
  input: BuildProposalInput,
): Promise<{ id: string; proposalNo: string; selection: ReturnType<typeof selectWithinFunds> }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  const [account] = await tx
    .select()
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, input.bankCashAccountId))
    .limit(1);

  if (!account) throw new Error(`No bank or cash account with id '${input.bankCashAccountId}'.`);
  if (!account.active) {
    throw new Error(`${account.code} is closed, so no payment run can be built against it.`);
  }

  const [position] = await treasury.balances(tx, ctx, input.payDate, {
    accountCode: account.code,
  });

  const live = position ? parseDecimal(position.availableIqd, 4n) : 0n;
  const availableIqd =
    input.cashCeilingIqd !== null && input.cashCeilingIqd !== undefined
      ? (input.cashCeilingIqd < live ? input.cashCeilingIqd : live)
      : live;

  const candidates = await loadCandidates(tx, input);
  const classified = candidates.map((candidate) =>
    classify(candidate.item, input.payDate, account.currency),
  );
  const selection = selectWithinFunds(classified, availableIqd < 0n ? 0n : availableIqd);

  const allocated = await allocateDocumentNumber(
    tx,
    PROPOSAL_SEQUENCE,
    { branchCode: input.branchCode, year: Number(input.proposalDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(paymentProposal)
    .values({
      proposalNo: allocated.documentNo,
      branchCode: input.branchCode,
      bankCashAccountId: input.bankCashAccountId,
      proposalDate: input.proposalDate,
      payDate: input.payDate,
      currency: account.currency,
      availableFundsIqd: toDecimalString(availableIqd < 0n ? 0n : availableIqd, 4n),
      selectedTotalIqd: toDecimalString(selection.selectedTotalIqd, 4n),
      deferredTotalIqd: toDecimalString(selection.deferredTotalIqd, 4n),
      note: input.note ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: paymentProposal.id });

  const byReference = new Map(candidates.map((row) => [row.item.reference, row]));

  for (const item of [...selection.selected, ...selection.deferred, ...selection.excluded]) {
    const source = byReference.get(item.reference)!;
    await tx.insert(paymentProposalItem).values({
      proposalId: created!.id,
      supplierId: source.supplierId,
      apInvoiceId: source.apInvoiceId,
      supplierAdvanceId: source.supplierAdvanceId,
      partnerBankAccountId: source.partnerBankAccountId,
      beneficiaryRevision: source.beneficiaryRevision,
      reference: item.reference,
      dueDate: item.dueDate,
      currency: item.currency,
      outstandingIqd: toDecimalString(item.outstandingIqd, 4n),
      priority: item.priority,
      discountIqd: toDecimalString(item.discountIqd ?? 0n, 4n),
      discountDeadline: item.discountDeadline ?? null,
      inclusion: item.inclusion,
      reason: item.reason,
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'payment_proposal.built',
    objectType: PROPOSAL_DOCUMENT_TYPE,
    objectId: created!.id,
    branchCode: input.branchCode,
    after: {
      proposalNo: allocated.documentNo,
      account: account.code,
      availableIqd: toDecimalString(availableIqd, 4n),
      selected: selection.selected.length,
      selectedTotalIqd: toDecimalString(selection.selectedTotalIqd, 4n),
      deferred: selection.deferred.length,
      excluded: selection.excluded.length,
    },
    outcome: 'success',
  });

  return { id: created!.id, proposalNo: allocated.documentNo, selection };
}

interface CandidateRow {
  readonly item: Candidate;
  readonly supplierId: string;
  readonly apInvoiceId: string | null;
  readonly supplierAdvanceId: string | null;
  readonly partnerBankAccountId: string | null;
  readonly beneficiaryRevision: number | null;
}

/**
 * Everything that could conceivably be paid, with the facts each classification
 * needs — including the ones that will disqualify it.
 *
 * Advances sit alongside invoices because §15 pays both, and because the 07.2
 * gate asks that execution *"updates every source invoice **and advance**"*. An
 * approved advance that has not been paid is a real obligation with a date; it
 * is only invisible in most systems because nobody modelled it.
 */
async function loadCandidates(tx: Tx, input: BuildProposalInput): Promise<CandidateRow[]> {
  // IMPROVEMENT-002 — a partner may hold several verified accounts; the run
  // pays the default (else the most recently verified), and takes that
  // account's own revision with it.
  const beneficiary = tx
    .selectDistinctOn([partnerBankAccount.partnerId], {
      partnerId: partnerBankAccount.partnerId,
      id: sql<string>`${partnerBankAccount.id}::text`.as('bank_id'),
      revision: sql<number>`${partnerBankAccount.revision}`.as('bank_revision'),
    })
    .from(partnerBankAccount)
    .where(and(eq(partnerBankAccount.approvalStatus, 'approved'), eq(partnerBankAccount.isActive, true)))
    .orderBy(partnerBankAccount.partnerId, desc(partnerBankAccount.isDefault), sql`${partnerBankAccount.approvedAt} desc nulls last`)
    .as('beneficiary');

  const invoices = await tx
    .select({
      id: apInvoice.id,
      reference: apInvoice.invoiceNo,
      supplierId: apInvoice.supplierId,
      supplierCode: businessPartner.code,
      supplierStatus: businessPartner.status,
      priority: businessPartner.paymentPriority,
      termsCode: businessPartner.paymentTermsCode,
      dueDate: apInvoice.dueDate,
      invoiceDate: apInvoice.invoiceDate,
      currency: apInvoice.currency,
      documentStatus: apInvoice.status,
      outstandingIqd: sql<string>`(${apInvoice.totalIqd} - ${apInvoice.settledAmountIqd})`,
      bankAccountId: beneficiary.id,
      bankRevision: beneficiary.revision,
    })
    .from(apInvoice)
    .innerJoin(businessPartner, eq(businessPartner.id, apInvoice.supplierId))
    .leftJoin(beneficiary, eq(beneficiary.partnerId, apInvoice.supplierId))
    .where(
      and(
        eq(apInvoice.branchCode, input.branchCode),
        // Open debts, and things somebody would expect to see and will ask
        // about — an invoice they entered that is still waiting for approval.
        // Not the whole history: nobody asks why a settled invoice was not paid
        // again, and a candidate set that grew forever would make the run
        // slower every month for no reader's benefit.
        sql`(
              (${apInvoice.status} in ('posted', 'partially_executed')
                 and ${apInvoice.totalIqd} - ${apInvoice.settledAmountIqd} > 0)
              or ${apInvoice.status} in ('draft', 'submitted', 'approved')
            )`,
        // Not already committed to a live batch. The unique index would refuse
        // it later; excluding it here means the proposal's totals are honest.
        sql`not exists (
          select 1 from payment_batch_line l
           where l.ap_invoice_id = ${apInvoice.id}
             and l.status in ('pending', 'executed'))`,
      ),
    );

  const advances = await tx
    .select({
      id: supplierAdvance.id,
      reference: supplierAdvance.advanceNo,
      supplierId: supplierAdvance.supplierId,
      supplierCode: businessPartner.code,
      supplierStatus: businessPartner.status,
      priority: businessPartner.paymentPriority,
      dueDate: supplierAdvance.requestDate,
      currency: supplierAdvance.currency,
      documentStatus: supplierAdvance.status,
      outstandingIqd: supplierAdvance.amountIqd,
      bankAccountId: beneficiary.id,
      bankRevision: beneficiary.revision,
    })
    .from(supplierAdvance)
    .innerJoin(businessPartner, eq(businessPartner.id, supplierAdvance.supplierId))
    .leftJoin(beneficiary, eq(beneficiary.partnerId, supplierAdvance.supplierId))
    .where(
      and(
        eq(supplierAdvance.branchCode, input.branchCode),
        isNull(supplierAdvance.paidDate),
        sql`${supplierAdvance.status} not in ('cancelled', 'rejected', 'reversed')`,
        sql`not exists (
          select 1 from payment_batch_line l
           where l.supplier_advance_id = ${supplierAdvance.id}
             and l.status in ('pending', 'executed'))`,
      ),
    );

  const terms = new Map(
    (
      await tx
        .select({
          code: paymentTerms.code,
          discountPercent: paymentTerms.discountPercent,
          discountDays: paymentTerms.discountDays,
        })
        .from(paymentTerms)
    ).map((row) => [row.code, row]),
  );

  const rows: CandidateRow[] = [];

  for (const row of invoices) {
    const term = row.termsCode ? terms.get(row.termsCode) : undefined;
    const deadline =
      term?.discountDays !== undefined && term?.discountDays !== null
        ? addDaysIso(row.invoiceDate, term.discountDays)
        : null;
    const discount = discountOpportunity({
      outstandingIqd: parseDecimal(row.outstandingIqd, 4n),
      discountPercent: term?.discountPercent ? parseDecimal(term.discountPercent, 4n) : null,
      discountDeadline: deadline,
      payOn: input.payDate,
    });

    rows.push({
      item: {
        reference: row.reference,
        supplierCode: row.supplierCode,
        outstandingIqd: parseDecimal(row.outstandingIqd, 4n),
        dueDate: row.dueDate,
        currency: row.currency,
        priority: row.priority,
        documentStatus: row.documentStatus,
        supplierStatus: row.supplierStatus,
        hasPayableBankDetails: row.bankAccountId !== null,
        discountIqd: discount.amountIqd,
        discountDeadline: discount.open ? deadline : null,
      },
      supplierId: row.supplierId,
      apInvoiceId: row.id,
      supplierAdvanceId: null,
      partnerBankAccountId: row.bankAccountId,
      beneficiaryRevision: row.bankRevision,
    });
  }

  for (const row of advances) {
    rows.push({
      item: {
        reference: row.reference,
        supplierCode: row.supplierCode,
        outstandingIqd: parseDecimal(row.outstandingIqd, 4n),
        dueDate: row.dueDate,
        currency: row.currency,
        priority: row.priority,
        // An advance is payable once approved. It has no "posted" state of its
        // own — nothing has been received yet — so `classify`'s posted test is
        // satisfied by the approval that authorised paying it.
        documentStatus: row.documentStatus === 'approved' ? 'posted' : row.documentStatus,
        supplierStatus: row.supplierStatus,
        hasPayableBankDetails: row.bankAccountId !== null,
      },
      supplierId: row.supplierId,
      apInvoiceId: null,
      supplierAdvanceId: row.id,
      partnerBankAccountId: row.bankAccountId,
      beneficiaryRevision: row.bankRevision,
    });
  }

  return rows;
}

/** Plain ISO date arithmetic — TECHSTACK A10 keeps `Date` out of business dates. */
function addDaysIso(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  const utc = Date.UTC(year!, month! - 1, day! + days);
  return new Date(utc).toISOString().slice(0, 10);
}

/** §15 — a proposal somebody has agreed to. Until then it is only a list. */
export async function approveProposal(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const proposal = await loadProposal(tx, id);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: proposal.branchCode,
  });

  if (proposal.status !== 'draft') {
    throw new PaymentRunStateError(proposal.proposalNo, proposal.status, 'it is not a draft.');
  }

  await statuses.assertTransitionAllowed(tx, PROPOSAL_DOCUMENT_TYPE, proposal.status, 'approved');

  await tx
    .update(paymentProposal)
    .set({ status: 'approved', approvedBy: ctx.principal.userId, approvedAt: new Date(), updatedAt: new Date() })
    .where(eq(paymentProposal.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'payment_proposal.approved',
    objectType: PROPOSAL_DOCUMENT_TYPE,
    objectId: id,
    branchCode: proposal.branchCode,
    before: { status: proposal.status },
    after: { status: 'approved' },
    outcome: 'success',
  });
}

// ---------------------------------------------------------------------------
// 07.2 and 07.3 — the batch
// ---------------------------------------------------------------------------

/**
 * §17 — the payment batch: the instruction that will go to the bank.
 *
 * Raised from an approved proposal's selected items, and from nothing else. A
 * batch assembled by hand would be a payment run nobody proposed, which is
 * precisely the gap the proposal exists to close.
 */
export async function createBatch(
  tx: Tx,
  ctx: ActorContext,
  input: { proposalId: string; paymentDate: string },
): Promise<{ id: string; batchNo: string; highRisk: boolean }> {
  const proposal = await loadProposal(tx, input.proposalId);

  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: proposal.branchCode,
  });

  if (proposal.status !== 'approved') {
    throw new PaymentRunStateError(
      proposal.proposalNo,
      proposal.status,
      'a batch comes from an approved proposal (§15, §17).',
    );
  }

  const items = await tx
    .select()
    .from(paymentProposalItem)
    .where(
      and(
        eq(paymentProposalItem.proposalId, input.proposalId),
        eq(paymentProposalItem.inclusion, 'selected'),
      ),
    )
    .orderBy(paymentProposalItem.dueDate, paymentProposalItem.reference);

  if (items.length === 0) throw new EmptyProposalError(proposal.proposalNo);

  const totalIqd = items.reduce((sum, row) => sum + parseDecimal(row.outstandingIqd, 4n), 0n);
  const threshold = await highRiskThreshold(tx, proposal.branchCode);
  const highRisk = isHighRisk(totalIqd, threshold);

  const allocated = await allocateDocumentNumber(
    tx,
    BATCH_SEQUENCE,
    { branchCode: proposal.branchCode, year: Number(input.paymentDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(paymentBatch)
    .values({
      batchNo: allocated.documentNo,
      proposalId: input.proposalId,
      branchCode: proposal.branchCode,
      bankCashAccountId: proposal.bankCashAccountId,
      paymentDate: input.paymentDate,
      currency: proposal.currency,
      totalIqd: toDecimalString(totalIqd, 4n),
      lineCount: items.length,
      highRisk,
      riskThresholdIqd: threshold === null ? null : toDecimalString(threshold, 4n),
      createdBy: ctx.principal.userId,
    })
    .returning({ id: paymentBatch.id });

  let lineNo = 0;
  for (const item of items) {
    lineNo += 1;
    await tx.insert(paymentBatchLine).values({
      batchId: created!.id,
      lineNo,
      supplierId: item.supplierId,
      apInvoiceId: item.apInvoiceId,
      supplierAdvanceId: item.supplierAdvanceId,
      partnerBankAccountId: item.partnerBankAccountId!,
      amountIqd: item.outstandingIqd,
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'payment_batch.created',
    objectType: BATCH_DOCUMENT_TYPE,
    objectId: created!.id,
    branchCode: proposal.branchCode,
    after: {
      batchNo: allocated.documentNo,
      proposalNo: proposal.proposalNo,
      lines: items.length,
      totalIqd: toDecimalString(totalIqd, 4n),
      highRisk,
      thresholdIqd: threshold === null ? null : toDecimalString(threshold, 4n),
    },
    outcome: 'success',
  });

  return { id: created!.id, batchNo: allocated.documentNo, highRisk };
}

/**
 * §17 and §15 — approval, and the beneficiary check that goes with it.
 *
 * The revision each beneficiary carried at this moment is written onto the line.
 * That single number is what makes *"a bank detail changed after approval but
 * before execution re-triggers verification"* enforceable: without it, execution
 * can only ask whether the details are approved *now*, and a fraudulent change
 * that was itself approved would sail through.
 */
export async function approveBatch(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const batch = await loadBatch(tx, id);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: batch.branchCode,
  });

  if (batch.status !== 'draft') {
    throw new PaymentRunStateError(batch.batchNo, batch.status, 'it is not awaiting approval.');
  }

  if (batch.highRisk) {
    assertSegregation(batch.batchNo, {
      createdBy: batch.createdBy,
      approvedBy: ctx.principal.userId,
    });
  }

  // §17 — every beneficiary, checked at the moment of approval.
  const lines = await beneficiariesOf(tx, id);
  for (const line of lines) {
    assertBeneficiaryPayable(line.supplierCode, line.details);
  }

  // §17 — and the money still has to be there.
  await treasury.checkPayment(tx, ctx, {
    bankCashAccountId: batch.bankCashAccountId,
    amountIqd: parseDecimal(batch.totalIqd, 4n),
    currency: batch.currency,
  });

  await statuses.assertTransitionAllowed(tx, BATCH_DOCUMENT_TYPE, batch.status, 'approved');

  for (const line of lines) {
    await tx
      .update(paymentBatchLine)
      .set({ approvedBeneficiaryRevision: line.details!.revision })
      .where(eq(paymentBatchLine.id, line.lineId));
  }

  await tx
    .update(paymentBatch)
    .set({ status: 'approved', approvedBy: ctx.principal.userId, approvedAt: new Date(), updatedAt: new Date() })
    .where(eq(paymentBatch.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'payment_batch.approved',
    objectType: BATCH_DOCUMENT_TYPE,
    objectId: id,
    branchCode: batch.branchCode,
    before: { status: batch.status },
    after: {
      status: 'approved',
      highRisk: batch.highRisk,
      beneficiaryRevisions: lines.map((line) => ({
        supplier: line.supplierCode,
        revision: line.details!.revision,
      })),
    },
    outcome: 'success',
  });
}

/**
 * §17 — execution, and the third pair of hands.
 *
 * Everything happens in the caller's transaction: the 07.2 gate asks that
 * execution *"updates every source invoice and advance in one transaction"*, and
 * a batch that half-executed would leave some invoices settled against money
 * that never left. One transaction is not an optimisation here, it is the
 * requirement.
 */
export async function executeBatch(
  tx: Tx,
  ctx: ActorContext,
  input: { batchId: string; bankInstructionRef: string },
): Promise<{ paymentIds: string[] }> {
  const batch = await loadBatch(tx, input.batchId);

  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
    branchCode: batch.branchCode,
  });

  if (batch.status !== 'approved') {
    throw new PaymentRunStateError(
      batch.batchNo,
      batch.status,
      'only an approved batch is sent to the bank (§17).',
    );
  }

  if (!input.bankInstructionRef.trim()) {
    throw new Error(
      `${batch.batchNo} needs the bank's instruction reference (§17). ` +
        'It is what the statement line will be matched against in 07.7, and a batch without one ' +
        'cannot be reconciled to the money that actually moved.',
    );
  }

  if (batch.highRisk) {
    assertSegregation(batch.batchNo, {
      createdBy: batch.createdBy,
      approvedBy: batch.approvedBy,
      executedBy: ctx.principal.userId,
    });
  }

  // §15 — the beneficiary details, checked again against what was approved.
  const lines = await beneficiariesOf(tx, input.batchId);
  for (const line of lines) {
    assertBeneficiaryPayable(line.supplierCode, line.details, line.approvedRevision);
  }

  const paymentIds: string[] = [];

  for (const line of lines) {
    if (line.supplierAdvanceId) {
      // Appendix C — an advance pays Dr Supplier Advance / Cr Bank, not
      // Dr Payables. It is money against nothing received yet, so it does not
      // reduce a debt and must not be recorded as if it did. Phase 05 already
      // owns that entry; the batch just tells it which account paid.
      await advances.pay(
        tx,
        ctx,
        line.supplierAdvanceId,
        batch.paymentDate,
        batch.bankCashAccountId,
      );

      await tx
        .update(paymentBatchLine)
        .set({ status: 'executed' })
        .where(eq(paymentBatchLine.id, line.lineId));
      continue;
    }

    const payment = await supplierPayments.create(tx, ctx, {
      supplierId: line.supplierId,
      bankCashAccountId: batch.bankCashAccountId,
      branchCode: batch.branchCode,
      paymentDate: batch.paymentDate,
      amountIqd: parseDecimal(line.amountIqd, 4n),
      currency: batch.currency,
      reference: input.bankInstructionRef,
      note: `Payment batch ${batch.batchNo}, line ${line.lineNo}`,
    });

    await supplierPayments.post(tx, ctx, payment.id);

    await supplierPayments.allocate(tx, ctx, {
      supplierPaymentId: payment.id,
      apInvoiceId: line.apInvoiceId!,
      amountIqd: parseDecimal(line.amountIqd, 4n),
    });

    await tx
      .update(paymentBatchLine)
      .set({ status: 'executed', supplierPaymentId: payment.id })
      .where(eq(paymentBatchLine.id, line.lineId));

    paymentIds.push(payment.id);
  }

  await statuses.assertTransitionAllowed(tx, BATCH_DOCUMENT_TYPE, batch.status, 'executed');

  await tx
    .update(paymentBatch)
    .set({
      status: 'executed',
      bankInstructionRef: input.bankInstructionRef.trim(),
      executedBy: ctx.principal.userId,
      executedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(paymentBatch.id, input.batchId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'payment_batch.executed',
    objectType: BATCH_DOCUMENT_TYPE,
    objectId: input.batchId,
    branchCode: batch.branchCode,
    before: { status: batch.status },
    after: {
      status: 'executed',
      bankInstructionRef: input.bankInstructionRef.trim(),
      payments: paymentIds.length,
      totalIqd: batch.totalIqd,
    },
    outcome: 'success',
  });

  return { paymentIds };
}

/**
 * §17 — a payment the bank refused before it left, or sent back afterwards.
 *
 * The 07.2 gate: *"a failed or returned payment reverts the source items to open
 * and is reported."* Both words matter and they are different events. A line
 * that fails before execution never became a payment, so there is nothing to
 * reverse — it simply leaves the batch and the invoice is open again. A line
 * that is *returned* did move money, so the payment is reversed through the
 * Phase 05 reversal, which puts the invoice back and the journal back together.
 */
export async function reportFailure(
  tx: Tx,
  ctx: ActorContext,
  input: { batchLineId: string; reason: string; reversalDate?: string },
): Promise<{ outcome: 'failed' | 'returned' }> {
  const [line] = await tx
    .select()
    .from(paymentBatchLine)
    .where(eq(paymentBatchLine.id, input.batchLineId))
    .limit(1);

  if (!line) throw new Error(`No payment batch line '${input.batchLineId}'.`);
  const batch = await loadBatch(tx, line.batchId);

  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
    branchCode: batch.branchCode,
  });

  if (!input.reason.trim()) {
    throw new Error(
      'A failed or returned payment needs a reason (§17). ' +
        'It is what tells the next run whether to try again, and what an auditor reads first.',
    );
  }

  if (line.status === 'pending') {
    await tx
      .update(paymentBatchLine)
      .set({ status: 'failed', failureReason: input.reason.trim() })
      .where(eq(paymentBatchLine.id, input.batchLineId));

    await audit.record(tx, {
      actorUserId: ctx.principal.userId,
      action: 'payment_batch.line_failed',
      objectType: BATCH_DOCUMENT_TYPE,
      objectId: line.batchId,
      branchCode: batch.branchCode,
      after: { lineNo: line.lineNo, amountIqd: line.amountIqd },
      reason: input.reason.trim(),
      outcome: 'success',
    });

    return { outcome: 'failed' };
  }

  if (line.status !== 'executed') {
    throw new PaymentRunStateError(
      `${batch.batchNo} line ${line.lineNo}`,
      line.status,
      'it has already been reported.',
    );
  }

  if (line.supplierAdvanceId) {
    // An advance line has no supplier payment behind it — it posted Dr Supplier
    // Advance / Cr Bank in its own right. Returning the money reverses that
    // entry and the advance with it. The request is not quietly re-opened: a
    // payment the bank sent back is a fact about the advance, and deciding to
    // try again is somebody's decision rather than the system's.
    const [advance] = await tx
      .select()
      .from(supplierAdvance)
      .where(eq(supplierAdvance.id, line.supplierAdvanceId))
      .limit(1);

    const [supplier] = await tx
      .select({ code: businessPartner.code })
      .from(businessPartner)
      .where(eq(businessPartner.id, advance!.supplierId))
      .limit(1);

    const [account] = await tx
      .select({ glAccountId: bankCashAccount.glAccountId })
      .from(bankCashAccount)
      .where(eq(bankCashAccount.id, batch.bankCashAccountId))
      .limit(1);

    const criteria = { branchCode: batch.branchCode };
    const dimensions = { branch: batch.branchCode, business_partner: supplier?.code ?? null };

    // §3.2 — an automatic journal is corrected through its own document, not
    // through the general reversal. The same two accounts, the other way round.
    await posting.post(tx, ctx, {
      eventType: 'purchasing.supplier_advance_payment',
      documentTypeCode: 'supplier_advance',
      source: { module: 'purchasing', documentId: advance!.id, event: 'reversed' },
      branchCode: batch.branchCode,
      documentDate: input.reversalDate ?? batch.paymentDate,
      postingDate: input.reversalDate ?? batch.paymentDate,
      description: `Supplier advance ${advance!.advanceNo} returned — ${input.reason.trim()}`,
      lines: [
        {
          role: 'bank',
          accountId: account!.glAccountId,
          debit: advance!.amountIqd,
          criteria,
          dimensions,
        },
        { role: 'supplier_advance', credit: advance!.amountIqd, criteria, dimensions },
      ],
    });

    await statuses.assertTransitionAllowed(tx, 'supplier_advance', advance!.status, 'reversed', input.reason.trim());

    await tx
      .update(supplierAdvance)
      .set({
        status: 'reversed',
        paidDate: null,
        reversedBy: ctx.principal.userId,
        reversedAt: new Date(),
        reversalReason: input.reason.trim(),
        updatedAt: new Date(),
      })
      .where(eq(supplierAdvance.id, line.supplierAdvanceId));
  } else {
    await supplierPayments.reverse(tx, ctx, line.supplierPaymentId!, {
      reversalDate: input.reversalDate ?? batch.paymentDate,
      reason: input.reason.trim(),
    });
  }

  await tx
    .update(paymentBatchLine)
    .set({
      status: 'returned',
      failureReason: input.reason.trim(),
      returnedAt: new Date(),
      returnedBy: ctx.principal.userId,
    })
    .where(eq(paymentBatchLine.id, input.batchLineId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'payment_batch.line_returned',
    objectType: BATCH_DOCUMENT_TYPE,
    objectId: line.batchId,
    branchCode: batch.branchCode,
    before: { status: 'executed' },
    after: { status: 'returned', lineNo: line.lineNo, amountIqd: line.amountIqd },
    reason: input.reason.trim(),
    outcome: 'success',
  });

  return { outcome: 'returned' };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function loadProposal(tx: Tx, id: string) {
  const [row] = await tx
    .select()
    .from(paymentProposal)
    .where(eq(paymentProposal.id, id))
    .limit(1);
  if (!row) throw new Error(`No payment proposal with id '${id}'.`);
  return row;
}

async function loadBatch(tx: Tx, id: string) {
  const [row] = await tx.select().from(paymentBatch).where(eq(paymentBatch.id, id)).limit(1);
  if (!row) throw new Error(`No payment batch with id '${id}'.`);
  return row;
}

async function beneficiariesOf(tx: Tx, batchId: string) {
  const rows = await tx
    .select({
      lineId: paymentBatchLine.id,
      lineNo: paymentBatchLine.lineNo,
      supplierId: paymentBatchLine.supplierId,
      supplierCode: businessPartner.code,
      amountIqd: paymentBatchLine.amountIqd,
      apInvoiceId: paymentBatchLine.apInvoiceId,
      supplierAdvanceId: paymentBatchLine.supplierAdvanceId,
      approvedRevision: paymentBatchLine.approvedBeneficiaryRevision,
      approvalStatus: partnerBankAccount.approvalStatus,
      isActive: partnerBankAccount.isActive,
      revision: partnerBankAccount.revision,
    })
    .from(paymentBatchLine)
    .innerJoin(businessPartner, eq(businessPartner.id, paymentBatchLine.supplierId))
    .leftJoin(partnerBankAccount, eq(partnerBankAccount.id, paymentBatchLine.partnerBankAccountId))
    .where(and(eq(paymentBatchLine.batchId, batchId), eq(paymentBatchLine.status, 'pending')))
    .orderBy(paymentBatchLine.lineNo);

  return rows.map((row) => ({
    ...row,
    details:
      row.approvalStatus === null
        ? null
        : { approvalStatus: row.approvalStatus, isActive: row.isActive!, revision: row.revision! },
  }));
}

/** The proposal with every item it considered — the report §15 asks for. */
export async function viewProposal(tx: Tx, id: string) {
  const proposal = await loadProposal(tx, id);
  const items = await tx
    .select()
    .from(paymentProposalItem)
    .where(eq(paymentProposalItem.proposalId, id))
    .orderBy(paymentProposalItem.inclusion, paymentProposalItem.dueDate);

  return {
    proposal,
    selected: items.filter((row) => row.inclusion === 'selected'),
    deferred: items.filter((row) => row.inclusion === 'deferred_funds'),
    excluded: items.filter(
      (row) => row.inclusion !== 'selected' && row.inclusion !== 'deferred_funds',
    ),
  };
}

export async function viewBatch(tx: Tx, id: string) {
  const batch = await loadBatch(tx, id);
  const lines = await tx
    .select()
    .from(paymentBatchLine)
    .where(eq(paymentBatchLine.batchId, id))
    .orderBy(paymentBatchLine.lineNo);
  return { batch, lines };
}

/** Everything the bank refused or returned, for the 07.2 gate's *"and is reported"*. */
export async function failureReport(tx: Tx, branchCode?: string | null) {
  return tx
    .select({
      batchNo: paymentBatch.batchNo,
      paymentDate: paymentBatch.paymentDate,
      lineNo: paymentBatchLine.lineNo,
      supplierCode: businessPartner.code,
      amountIqd: paymentBatchLine.amountIqd,
      status: paymentBatchLine.status,
      failureReason: paymentBatchLine.failureReason,
      returnedAt: paymentBatchLine.returnedAt,
    })
    .from(paymentBatchLine)
    .innerJoin(paymentBatch, eq(paymentBatch.id, paymentBatchLine.batchId))
    .innerJoin(businessPartner, eq(businessPartner.id, paymentBatchLine.supplierId))
    .where(
      and(
        sql`${paymentBatchLine.status} in ('failed', 'returned')`,
        branchCode ? eq(paymentBatch.branchCode, branchCode) : sql`true`,
      ),
    )
    .orderBy(paymentBatch.paymentDate, paymentBatchLine.lineNo);
}

export type { Classified };
