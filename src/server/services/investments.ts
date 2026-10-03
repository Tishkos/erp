/**
 * Investment Management — Phase 13, §13 and Appendix E (IFRS 9).
 *
 * ── What this service will not do ───────────────────────────────────────────
 * §13: *"The IT team must implement configurable types and posting rules only
 * after Finance defines the required categories."*
 *
 * So there is no category here, no valuation method, and no impairment trigger.
 * Every one of those is a row in a catalogue Finance fills, and both catalogues
 * ship empty. The effect is that this module is fully built and **records
 * nothing** until D2 is answered: an investment names a type through a foreign
 * key, a valuation names a method the same way, and neither has anything to point
 * at. Emptiness refuses rather than permits, which is the only arrangement in
 * which building ahead of the decision is safe.
 *
 * ── Carrying value is read, never stored ────────────────────────────────────
 * §13 requires historical valuations to be preserved and never overwritten, so
 * the current carrying value is the latest valuation — or cost, before the first
 * one — less impairment. Computing it on demand is what makes "the value on that
 * date" and "the value now" the same question asked twice, rather than two
 * columns that can disagree.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  attachment,
  bankCashAccount,
  businessPartner,
  investment,
  investmentCapitalCall,
  investmentDisposal,
  investmentFunding,
  investmentImpairment,
  investmentIncome,
  investmentProposal,
  investmentType,
  investmentValuation,
  investmentValuationMethod,
} from '../db/schema';
import { parseDecimal, toDecimalString } from '../domain/money';
import {
  assertApprovedForAcquisition,
  assertProposalComplete,
  assertRequiredFields,
  assertValuationMethod,
  disposalOutcome,
  portfolioTotals,
  type ApprovalState,
} from '../domain/investments';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as posting from './posting';
import type { PostingLineRequest } from '../domain/posting';
import * as statuses from './statuses';
import * as treasury from './treasury';
import { allocateDocumentNumber } from './numbering';

export const PROPOSAL_DOCUMENT_TYPE = 'investment_proposal';
export const DOCUMENT_TYPE = 'investment';
export const PERMISSION_OBJECT = 'investment';

const PROPOSAL_SEQUENCE = 'INVESTMENT_PROPOSAL';
const INVESTMENT_SEQUENCE = 'INVESTMENT';
const FUNDING_SEQUENCE = 'INVESTMENT_FUNDING';
const INCOME_SEQUENCE = 'INVESTMENT_INCOME';
const DISPOSAL_SEQUENCE = 'INVESTMENT_DISPOSAL';

export class InvestmentStateError extends Error {
  readonly code = 'INVESTMENT_STATE_INVALID';
  constructor(investmentNo: string, status: string, detail: string) {
    super(`Investment ${investmentNo} is '${status}': ${detail}`);
    this.name = 'InvestmentStateError';
  }
}

export class UnknownInvestmentTypeError extends Error {
  readonly code = 'INVESTMENT_TYPE_UNKNOWN';
  constructor(code: string) {
    super(
      `There is no active investment type '${code}'. §13 leaves the categories to ` +
        'Finance and this system ships with none — see decision register D2. Configure ' +
        'the type before recording an investment under it.',
    );
    this.name = 'UnknownInvestmentTypeError';
  }
}

async function loadType(tx: Tx, code: string) {
  const [row] = await tx
    .select()
    .from(investmentType)
    .where(and(eq(investmentType.code, code), eq(investmentType.active, true)))
    .limit(1);
  if (!row) throw new UnknownInvestmentTypeError(code);
  return row;
}

async function loadInvestment(tx: Tx, id: string) {
  const [row] = await tx.select().from(investment).where(eq(investment.id, id)).limit(1);
  if (!row) throw new Error(`No investment '${id}'.`);
  return row;
}

async function loadProposal(tx: Tx, id: string) {
  const [row] = await tx
    .select()
    .from(investmentProposal)
    .where(eq(investmentProposal.id, id))
    .limit(1);
  if (!row) throw new Error(`No investment proposal '${id}'.`);
  return row;
}

/** The methods Finance has approved. Empty until D2. */
async function configuredMethods(tx: Tx): Promise<string[]> {
  const rows = await tx
    .select({ code: investmentValuationMethod.code })
    .from(investmentValuationMethod)
    .where(eq(investmentValuationMethod.active, true));
  return rows.map((r) => r.code);
}

// ---------------------------------------------------------------------------
// 13.2 — proposal and approval
// ---------------------------------------------------------------------------

export interface ProposeInput {
  readonly typeCode: string;
  readonly branchCode: string;
  readonly amountIqd: bigint;
  readonly currencyCode: string;
  readonly expectedReturn: string;
  readonly riskAssessment: string;
  readonly proposedOn: string;
  readonly counterpartyPartnerId?: string | null;
  readonly isRelatedParty?: boolean;
  readonly relatedPartyNote?: string | null;
}

export async function propose(
  tx: Tx,
  ctx: ActorContext,
  input: ProposeInput,
): Promise<{ id: string; proposalNo: string }> {
  await authz.authorize(ctx.principal, 'create', PROPOSAL_DOCUMENT_TYPE, {
    branchCode: input.branchCode,
  });

  // The type must exist before anything else is checked: without it there is no
  // required-field list to check against, and D2 is the reason there may be none.
  await loadType(tx, input.typeCode);

  assertProposalComplete({
    typeCode: input.typeCode,
    amountIqd: input.amountIqd,
    currencyCode: input.currencyCode,
    expectedReturn: input.expectedReturn,
    riskAssessment: input.riskAssessment,
  });

  const allocated = await allocateDocumentNumber(
    tx,
    PROPOSAL_SEQUENCE,
    { branchCode: input.branchCode, year: Number(input.proposedOn.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(investmentProposal)
    .values({
      proposalNo: allocated.documentNo,
      typeCode: input.typeCode,
      branchCode: input.branchCode,
      amountIqd: toDecimalString(input.amountIqd, 4n),
      currencyCode: input.currencyCode,
      expectedReturn: input.expectedReturn.trim(),
      riskAssessment: input.riskAssessment.trim(),
      counterpartyPartnerId: input.counterpartyPartnerId ?? null,
      isRelatedParty: input.isRelatedParty ?? false,
      relatedPartyNote: input.relatedPartyNote ?? null,
      proposedOn: input.proposedOn,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: investmentProposal.id });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'investment_proposal.created',
    objectType: PROPOSAL_DOCUMENT_TYPE,
    objectId: created!.id,
    branchCode: input.branchCode,
    after: { proposalNo: allocated.documentNo, typeCode: input.typeCode },
    outcome: 'success',
  });

  return { id: created!.id, proposalNo: allocated.documentNo };
}

/**
 * §13 workflow step 2, and the funding approval beside it.
 *
 * `which` names the approval rather than there being one `approve` that guesses.
 * Three named approvals are three auditable facts; one is a flag that cannot
 * answer "who agreed to spend the money?"
 */
export async function approve(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  which: 'management' | 'funding' | 'related_party',
): Promise<void> {
  const proposal = await loadProposal(tx, id);

  await authz.authorize(ctx.principal, 'approve', PROPOSAL_DOCUMENT_TYPE, {
    branchCode: proposal.branchCode,
    objectId: id,
  });

  // the super user approves alone, by direction 2026-10-03 — the company has one approver and a rule nobody can satisfy approves nothing.
  if (proposal.createdBy === ctx.principal.userId && !ctx.principal.isSuperUser) {
    throw new Error(
      `${proposal.proposalNo} was raised by you, so somebody else approves it (§5.2). ` +
        'An investment approved by the person proposing it has one signature, not two.',
    );
  }

  if (proposal.rejectedBy) {
    throw new Error(`${proposal.proposalNo} was rejected; raise a new proposal.`);
  }

  const now = new Date();
  const patch =
    which === 'management'
      ? { managementApprovedBy: ctx.principal.userId, managementApprovedAt: now }
      : which === 'funding'
        ? { fundingApprovedBy: ctx.principal.userId, fundingApprovedAt: now }
        : { relatedPartyApprovedBy: ctx.principal.userId, relatedPartyApprovedAt: now };

  await tx
    .update(investmentProposal)
    .set({ ...patch, updatedAt: now })
    .where(eq(investmentProposal.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: `investment_proposal.approved.${which}`,
    objectType: PROPOSAL_DOCUMENT_TYPE,
    objectId: id,
    branchCode: proposal.branchCode,
    after: { which },
    outcome: 'success',
  });
}

export async function reject(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  reason: string,
): Promise<void> {
  const proposal = await loadProposal(tx, id);

  await authz.authorize(ctx.principal, 'approve', PROPOSAL_DOCUMENT_TYPE, {
    branchCode: proposal.branchCode,
    objectId: id,
  });

  if (reason.trim().length === 0) {
    throw new Error('A rejected proposal says why, so the next one can be better.');
  }

  await statuses.assertTransitionAllowed(tx, PROPOSAL_DOCUMENT_TYPE, proposal.status, 'rejected');

  await tx
    .update(investmentProposal)
    .set({
      status: 'rejected',
      rejectedBy: ctx.principal.userId,
      rejectionReason: reason.trim(),
      updatedAt: new Date(),
    })
    .where(eq(investmentProposal.id, id));
}

// ---------------------------------------------------------------------------
// 13.3 — acquisition
// ---------------------------------------------------------------------------

export interface AcquireInput {
  readonly proposalId: string;
  readonly description: string;
  readonly acquiredOn: string;
  readonly units: bigint;
  readonly amountTxn: bigint;
  readonly amountIqd: bigint;
  readonly bankCashAccountId: string;
  readonly custodian?: string | null;
  readonly custodyAccount?: string | null;
  readonly ownershipPercent?: string | null;
  readonly maturityDate?: string | null;
  /** Whatever the type's `requiredFields` names, supplied by the caller. */
  readonly fields?: Readonly<Record<string, unknown>>;
}

/**
 * §13 acceptance 1 — *"An approved investment proposal creates a controlled
 * acquisition record and accounting entry."*
 *
 * One transaction: the register entry, the funding row and the journal. If the
 * posting fails there is no register entry, which is the only arrangement under
 * which the register and the ledger cannot disagree.
 */
export async function acquire(
  tx: Tx,
  ctx: ActorContext,
  input: AcquireInput,
): Promise<{ id: string; investmentNo: string; journalEntryId: string }> {
  const proposal = await loadProposal(tx, input.proposalId);
  const type = await loadType(tx, proposal.typeCode);

  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, {
    branchCode: proposal.branchCode,
  });

  const approvals: ApprovalState = {
    managementApprovedBy: proposal.managementApprovedBy,
    fundingApprovedBy: proposal.fundingApprovedBy,
    isRelatedParty: proposal.isRelatedParty,
    relatedPartyApprovedBy: proposal.relatedPartyApprovedBy,
    relatedPartyApprovalRequired: type.relatedPartyApprovalRequired,
  };
  assertApprovedForAcquisition(approvals);

  // §13 — the type says what it needs to know about this instrument.
  assertRequiredFields(type.code, type.requiredFields ?? [], {
    custodian: input.custodian ?? null,
    custodyAccount: input.custodyAccount ?? null,
    ownershipPercent: input.ownershipPercent ?? null,
    maturityDate: input.maturityDate ?? null,
    counterparty: proposal.counterpartyPartnerId,
    ...(input.fields ?? {}),
  });

  const allocated = await allocateDocumentNumber(
    tx,
    INVESTMENT_SEQUENCE,
    { branchCode: proposal.branchCode, year: Number(input.acquiredOn.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(investment)
    .values({
      investmentNo: allocated.documentNo,
      status: 'posted',
      typeCode: type.code,
      proposalId: proposal.id,
      branchCode: proposal.branchCode,
      description: input.description,
      counterpartyPartnerId: proposal.counterpartyPartnerId,
      custodian: input.custodian ?? null,
      custodyAccount: input.custodyAccount ?? null,
      ownershipPercent: input.ownershipPercent ?? null,
      unitsHeld: toDecimalString(input.units, 6n),
      currencyCode: proposal.currencyCode,
      costTxn: toDecimalString(input.amountTxn, 4n),
      costIqd: toDecimalString(input.amountIqd, 4n),
      acquiredOn: input.acquiredOn,
      maturityDate: input.maturityDate ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: investment.id });

  const journalEntryId = await postFunding(tx, ctx, {
    investmentId: created!.id,
    investmentNo: allocated.documentNo,
    branchCode: proposal.branchCode,
    costAccountRole: type.costAccountRole,
    kind: 'acquisition',
    fundedOn: input.acquiredOn,
    units: input.units,
    amountTxn: input.amountTxn,
    amountIqd: input.amountIqd,
    bankCashAccountId: input.bankCashAccountId,
  });

  await tx
    .update(investmentProposal)
    .set({ status: 'settled', updatedAt: new Date() })
    .where(eq(investmentProposal.id, proposal.id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'investment.acquired',
    objectType: DOCUMENT_TYPE,
    objectId: created!.id,
    branchCode: proposal.branchCode,
    after: { investmentNo: allocated.documentNo, costIqd: toDecimalString(input.amountIqd, 4n) },
    outcome: 'success',
  });

  return { id: created!.id, investmentNo: allocated.documentNo, journalEntryId };
}

/**
 * Dr the investment's cost account / Cr the bank it was paid from.
 *
 * §13 — *"Treasury provides funding"*: the credit is the bank account the money
 * left, not an account a mapping chose. That is the same correction Phase 07
 * made for supplier payments, and for the same reason — the money left a
 * particular account and the ledger has to say which.
 */
async function postFunding(
  tx: Tx,
  ctx: ActorContext,
  input: {
    investmentId: string;
    investmentNo: string;
    branchCode: string;
    costAccountRole: string;
    kind: 'acquisition' | 'capital_call';
    fundedOn: string;
    units: bigint;
    amountTxn: bigint;
    amountIqd: bigint;
    bankCashAccountId: string;
  },
): Promise<string> {
  const [account] = await tx
    .select({ glAccountId: bankCashAccount.glAccountId, currency: bankCashAccount.currency })
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, input.bankCashAccountId))
    .limit(1);
  if (!account) throw new Error(`No bank or cash account '${input.bankCashAccountId}'.`);

  // §13 — *"Treasury provides funding and receives proceeds."* So the money
  // leaves under Phase 07's controls rather than beside them: the account's
  // currency must match, the funds must actually be there, and §17 decides
  // whether the amount needs a higher approval. Phase 05's supplier payments
  // pass through the same three checks, which is the point of their being in one
  // place — a caller that remembered two of the three would be a caller whose
  // payments are *nearly* controlled.
  await treasury.checkPayment(tx, ctx, {
    bankCashAccountId: input.bankCashAccountId,
    amountIqd: input.amountIqd,
    currency: account.currency,
  });

  const criteria = { branchCode: input.branchCode };
  const dimensions = { branch: input.branchCode };

  const result = await posting.post(tx, ctx, {
    eventType: 'investments.acquisition',
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'investments', documentId: input.investmentId, event: input.kind },
    branchCode: input.branchCode,
    documentDate: input.fundedOn,
    postingDate: input.fundedOn,
    description: `Investment ${input.investmentNo} — ${input.kind.replace('_', ' ')}`,
    lines: [
      {
        role: input.costAccountRole,
        debit: toDecimalString(input.amountIqd, 4n),
        criteria,
        dimensions,
      },
      {
        role: 'bank',
        accountId: account.glAccountId,
        credit: toDecimalString(input.amountIqd, 4n),
        criteria,
        dimensions,
      },
    ],
  });

  const allocated = await allocateDocumentNumber(
    tx,
    FUNDING_SEQUENCE,
    { branchCode: input.branchCode, year: Number(input.fundedOn.slice(0, 4)) },
    ctx.principal.userId,
  );

  await tx.insert(investmentFunding).values({
    investmentId: input.investmentId,
    fundingNo: allocated.documentNo,
    kind: input.kind,
    fundedOn: input.fundedOn,
    unitsAcquired: toDecimalString(input.units, 6n),
    amountTxn: toDecimalString(input.amountTxn, 4n),
    amountIqd: toDecimalString(input.amountIqd, 4n),
    bankCashAccountId: input.bankCashAccountId,
    journalEntryId: result.journalEntryId,
    postedBy: ctx.principal.userId,
  });

  return result.journalEntryId;
}

/** A capital call met, or any further money into an existing holding. */
export async function fund(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: {
    fundedOn: string;
    units?: bigint;
    amountTxn: bigint;
    amountIqd: bigint;
    bankCashAccountId: string;
    capitalCallId?: string | null;
  },
): Promise<{ journalEntryId: string }> {
  const held = await loadInvestment(tx, id);
  const type = await loadType(tx, held.typeCode);

  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, { branchCode: held.branchCode });

  if (held.disposedOn) {
    throw new InvestmentStateError(
      held.investmentNo,
      held.status,
      'a disposed holding takes no further funding.',
    );
  }

  const journalEntryId = await postFunding(tx, ctx, {
    investmentId: id,
    investmentNo: held.investmentNo,
    branchCode: held.branchCode,
    costAccountRole: type.costAccountRole,
    kind: 'capital_call',
    fundedOn: input.fundedOn,
    units: input.units ?? 0n,
    amountTxn: input.amountTxn,
    amountIqd: input.amountIqd,
    bankCashAccountId: input.bankCashAccountId,
  });

  await tx
    .update(investment)
    .set({
      unitsHeld: sql`${investment.unitsHeld} + ${toDecimalString(input.units ?? 0n, 6n)}`,
      costTxn: sql`${investment.costTxn} + ${toDecimalString(input.amountTxn, 4n)}`,
      costIqd: sql`${investment.costIqd} + ${toDecimalString(input.amountIqd, 4n)}`,
      updatedAt: new Date(),
    })
    .where(eq(investment.id, id));

  if (input.capitalCallId) {
    const [funding] = await tx
      .select({ id: investmentFunding.id })
      .from(investmentFunding)
      .where(eq(investmentFunding.journalEntryId, journalEntryId))
      .limit(1);
    await tx
      .update(investmentCapitalCall)
      .set({ fundedById: funding?.id ?? null })
      .where(eq(investmentCapitalCall.id, input.capitalCallId));
  }

  return { journalEntryId };
}

// ---------------------------------------------------------------------------
// 13.4 — income
// ---------------------------------------------------------------------------

/**
 * §13 acceptance 3 — *"Income and disposal trace to bank transactions and
 * supporting documents."*
 *
 * Both are required arguments, and both are NOT NULL columns. There is no path
 * that records income without evidence, which is what §13's *"require source
 * evidence"* asks for without qualification.
 */
export async function recordIncome(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: {
    kind: string;
    receivedOn: string;
    amountTxn: bigint;
    amountIqd: bigint;
    bankCashAccountId: string;
    evidenceAttachmentId: string;
  },
): Promise<{ id: string; incomeNo: string; journalEntryId: string }> {
  const held = await loadInvestment(tx, id);
  const type = await loadType(tx, held.typeCode);

  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, { branchCode: held.branchCode });

  if (input.kind.trim().length === 0) {
    throw new Error('Income says what kind it is — a dividend, interest, a distribution (§13).');
  }

  const [evidence] = await tx
    .select({ id: attachment.id })
    .from(attachment)
    .where(eq(attachment.id, input.evidenceAttachmentId))
    .limit(1);
  if (!evidence) {
    throw new Error(
      `There is no attachment '${input.evidenceAttachmentId}'. §13 requires income to ` +
        'rest on source evidence, so the document is attached before the income is posted.',
    );
  }

  const [account] = await tx
    .select({ glAccountId: bankCashAccount.glAccountId })
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, input.bankCashAccountId))
    .limit(1);
  if (!account) throw new Error(`No bank or cash account '${input.bankCashAccountId}'.`);

  const criteria = { branchCode: held.branchCode };
  const dimensions = { branch: held.branchCode };

  // The number first, because the posting is keyed on it.
  //
  // The source key was `income-<date>` and that was a bug: the posting engine
  // treats (module, document, event) as the identity of a posting, so a holding
  // paying a dividend and an interest coupon on the same day recorded two income
  // rows against **one** journal. The document number is unique by construction,
  // which is exactly what an identity needs to be.
  const allocated = await allocateDocumentNumber(
    tx,
    INCOME_SEQUENCE,
    { branchCode: held.branchCode, year: Number(input.receivedOn.slice(0, 4)) },
    ctx.principal.userId,
  );

  const result = await posting.post(tx, ctx, {
    eventType: 'investments.income',
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'investments', documentId: id, event: `income-${allocated.documentNo}` },
    branchCode: held.branchCode,
    documentDate: input.receivedOn,
    postingDate: input.receivedOn,
    description: `Investment ${held.investmentNo} — ${input.kind.trim()}`,
    lines: [
      {
        role: 'bank',
        accountId: account.glAccountId,
        debit: toDecimalString(input.amountIqd, 4n),
        criteria,
        dimensions,
      },
      {
        role: type.incomeAccountRole,
        credit: toDecimalString(input.amountIqd, 4n),
        criteria,
        dimensions,
      },
    ],
  });

  const [created] = await tx
    .insert(investmentIncome)
    .values({
      investmentId: id,
      incomeNo: allocated.documentNo,
      kind: input.kind.trim(),
      receivedOn: input.receivedOn,
      amountTxn: toDecimalString(input.amountTxn, 4n),
      amountIqd: toDecimalString(input.amountIqd, 4n),
      bankCashAccountId: input.bankCashAccountId,
      evidenceAttachmentId: input.evidenceAttachmentId,
      journalEntryId: result.journalEntryId,
      postedBy: ctx.principal.userId,
    })
    .returning({ id: investmentIncome.id });

  return {
    id: created!.id,
    incomeNo: allocated.documentNo,
    journalEntryId: result.journalEntryId,
  };
}

// ---------------------------------------------------------------------------
// 13.5 — valuation and impairment
// ---------------------------------------------------------------------------

/**
 * §13 — *"The system preserves historical valuations; it does not overwrite
 * prior values."*
 *
 * Insert only. There is no update path here, and the unique index on
 * (investment, date) means a correction is a new date rather than a rewrite of
 * an old one.
 */
export async function value(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: {
    valuedOn: string;
    methodCode: string;
    valueTxn: bigint;
    valueIqd: bigint;
    basis?: string | null;
  },
): Promise<{ id: string }> {
  const held = await loadInvestment(tx, id);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: held.branchCode,
  });

  // D2 — the domain refuses a method Finance has not configured, and refuses to
  // guess which methods exist.
  assertValuationMethod(input.methodCode, await configuredMethods(tx));

  const [created] = await tx
    .insert(investmentValuation)
    .values({
      investmentId: id,
      valuedOn: input.valuedOn,
      methodCode: input.methodCode,
      valueTxn: toDecimalString(input.valueTxn, 4n),
      valueIqd: toDecimalString(input.valueIqd, 4n),
      approvedBy: ctx.principal.userId,
      basis: input.basis ?? null,
    })
    .returning({ id: investmentValuation.id });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'investment.valued',
    objectType: DOCUMENT_TYPE,
    objectId: id,
    branchCode: held.branchCode,
    after: {
      valuedOn: input.valuedOn,
      methodCode: input.methodCode,
      valueIqd: toDecimalString(input.valueIqd, 4n),
    },
    outcome: 'success',
  });

  return { id: created!.id };
}

/** Every valuation ever made, oldest first, with the method used at the time. */
export async function valuations(tx: Tx, id: string) {
  return tx
    .select({
      valuedOn: investmentValuation.valuedOn,
      methodCode: investmentValuation.methodCode,
      valueIqd: investmentValuation.valueIqd,
      approvedBy: investmentValuation.approvedBy,
      approvedAt: investmentValuation.approvedAt,
      basis: investmentValuation.basis,
    })
    .from(investmentValuation)
    .where(eq(investmentValuation.investmentId, id))
    .orderBy(investmentValuation.valuedOn);
}

/**
 * Carrying value: the latest valuation, or cost before there is one, less
 * impairment.
 *
 * Read rather than stored — see the note at the head of this file.
 */
export async function carryingValueOf(
  tx: Tx,
  id: string,
): Promise<{ costIqd: bigint; valuedIqd: bigint | null; impairedIqd: bigint; carryingIqd: bigint }> {
  const held = await loadInvestment(tx, id);

  const [latest] = await tx
    .select({ valueIqd: investmentValuation.valueIqd })
    .from(investmentValuation)
    .where(eq(investmentValuation.investmentId, id))
    .orderBy(desc(investmentValuation.valuedOn))
    .limit(1);

  const [impaired] = await tx
    .select({ total: sql<string>`coalesce(sum(${investmentImpairment.amountIqd}), 0)` })
    .from(investmentImpairment)
    .where(eq(investmentImpairment.investmentId, id));

  const costIqd = parseDecimal(held.costIqd, 4n);
  const valuedIqd = latest ? parseDecimal(latest.valueIqd, 4n) : null;
  const impairedIqd = parseDecimal(impaired?.total ?? '0', 4n);

  return {
    costIqd,
    valuedIqd,
    impairedIqd,
    carryingIqd: (valuedIqd ?? costIqd) - impairedIqd,
  };
}

export async function impair(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: { impairedOn: string; amountIqd: bigint; basis: string },
): Promise<{ id: string; journalEntryId: string }> {
  const held = await loadInvestment(tx, id);
  const type = await loadType(tx, held.typeCode);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: held.branchCode,
  });

  if (input.basis.trim().length === 0) {
    throw new Error(
      'An impairment states the basis it rests on (§13). The trigger and measurement ' +
        'basis are Finance\'s — decision register D2 — so the reason is recorded in ' +
        'their words rather than computed here.',
    );
  }

  const before = await carryingValueOf(tx, id);
  if (input.amountIqd <= 0n || input.amountIqd > before.carryingIqd) {
    throw new Error(
      `An impairment of ${toDecimalString(input.amountIqd, 4n)} does not fit inside a ` +
        `carrying value of ${toDecimalString(before.carryingIqd, 4n)} (§13). Beyond it, ` +
        'that is a disposal.',
    );
  }

  const criteria = { branchCode: held.branchCode };
  const dimensions = { branch: held.branchCode };

  // An impairment has no document number, so its **id is minted here** and used
  // both as the posting's identity and as the row's primary key.
  //
  // Keying on the date would have merged two impairments made on one day into a
  // single journal — the same defect income and disposal had. Writing the row
  // first and updating it afterwards would work too, and is what Phase 12's
  // depreciation does, but `investment_impairment` is granted INSERT and not
  // UPDATE: an impairment is a decision Finance made on a date, and a record of
  // it that could be edited is not a record. Minting the id keeps both — one
  // insert, and an identity the posting can be keyed on.
  const impairmentId = randomUUID();

  const result = await posting.post(tx, ctx, {
    eventType: 'investments.impairment',
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'investments', documentId: id, event: `impairment-${impairmentId}` },
    branchCode: held.branchCode,
    documentDate: input.impairedOn,
    postingDate: input.impairedOn,
    description: `Investment ${held.investmentNo} — impairment`,
    lines: [
      {
        role: type.impairmentAccountRole,
        debit: toDecimalString(input.amountIqd, 4n),
        criteria,
        dimensions,
      },
      {
        role: type.valuationAccountRole,
        credit: toDecimalString(input.amountIqd, 4n),
        criteria,
        dimensions,
      },
    ],
  });

  await tx.insert(investmentImpairment).values({
    id: impairmentId,
    investmentId: id,
    impairedOn: input.impairedOn,
    amountIqd: toDecimalString(input.amountIqd, 4n),
    basis: input.basis.trim(),
    carryingValueBeforeIqd: toDecimalString(before.carryingIqd, 4n),
    approvedBy: ctx.principal.userId,
    journalEntryId: result.journalEntryId,
  });

  return { id: impairmentId, journalEntryId: result.journalEntryId };
}

// ---------------------------------------------------------------------------
// 13.6 — disposal
// ---------------------------------------------------------------------------

export async function dispose(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: {
    disposedOn: string;
    unitsDisposed: bigint;
    proceedsTxn: bigint;
    proceedsIqd: bigint;
    bankCashAccountId: string;
    evidenceAttachmentId: string;
  },
): Promise<{
  id: string;
  disposalNo: string;
  journalEntryId: string;
  realisedResultIqd: bigint;
  isFullDisposal: boolean;
}> {
  const held = await loadInvestment(tx, id);
  const type = await loadType(tx, held.typeCode);

  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, { branchCode: held.branchCode });

  if (held.disposedOn) {
    throw new InvestmentStateError(
      held.investmentNo,
      held.status,
      'it has already been disposed of in full.',
    );
  }

  const [evidence] = await tx
    .select({ id: attachment.id })
    .from(attachment)
    .where(eq(attachment.id, input.evidenceAttachmentId))
    .limit(1);
  if (!evidence) {
    throw new Error(
      `There is no attachment '${input.evidenceAttachmentId}'. §13 requires a disposal ` +
        'to rest on source evidence.',
    );
  }

  const carrying = await carryingValueOf(tx, id);
  const outcome = disposalOutcome(
    {
      unitsHeld: parseDecimal(held.unitsHeld, 6n),
      carryingValueIqd: carrying.carryingIqd,
    },
    input.unitsDisposed,
    input.proceedsIqd,
  );

  const [account] = await tx
    .select({ glAccountId: bankCashAccount.glAccountId })
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, input.bankCashAccountId))
    .limit(1);
  if (!account) throw new Error(`No bank or cash account '${input.bankCashAccountId}'.`);

  const criteria = { branchCode: held.branchCode };
  const dimensions = { branch: held.branchCode };

  const lines: PostingLineRequest[] = [
    {
      role: 'bank',
      accountId: account.glAccountId,
      debit: toDecimalString(input.proceedsIqd, 4n),
      criteria,
      dimensions,
    },
    {
      role: type.costAccountRole,
      credit: toDecimalString(outcome.carryingValueDisposedIqd, 4n),
      criteria,
      dimensions,
    },
  ];

  // A gain is a credit and a loss is a debit; neither line exists when proceeds
  // and carrying value agree, because a journal line of nothing says nothing.
  if (outcome.realisedResultIqd > 0n) {
    lines.push({
      role: type.disposalGainRole,
      credit: toDecimalString(outcome.realisedResultIqd, 4n),
      criteria,
      dimensions,
    });
  } else if (outcome.realisedResultIqd < 0n) {
    lines.push({
      role: type.disposalLossRole,
      debit: toDecimalString(-outcome.realisedResultIqd, 4n),
      criteria,
      dimensions,
    });
  }

  // Keyed on the disposal number, not the date: two partial disposals on one day
  // are two disposals, and keying on the date would have made them one journal.
  const allocated = await allocateDocumentNumber(
    tx,
    DISPOSAL_SEQUENCE,
    { branchCode: held.branchCode, year: Number(input.disposedOn.slice(0, 4)) },
    ctx.principal.userId,
  );

  const result = await posting.post(tx, ctx, {
    eventType: 'investments.disposal',
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'investments', documentId: id, event: `disposal-${allocated.documentNo}` },
    branchCode: held.branchCode,
    documentDate: input.disposedOn,
    postingDate: input.disposedOn,
    description: `Investment ${held.investmentNo} — disposal`,
    lines,
  });

  const [created] = await tx
    .insert(investmentDisposal)
    .values({
      investmentId: id,
      disposalNo: allocated.documentNo,
      disposedOn: input.disposedOn,
      unitsDisposed: toDecimalString(outcome.unitsDisposed, 6n),
      proceedsTxn: toDecimalString(input.proceedsTxn, 4n),
      proceedsIqd: toDecimalString(input.proceedsIqd, 4n),
      carryingValueDisposedIqd: toDecimalString(outcome.carryingValueDisposedIqd, 4n),
      realisedResultIqd: toDecimalString(outcome.realisedResultIqd, 4n),
      isFullDisposal: outcome.isFullDisposal,
      bankCashAccountId: input.bankCashAccountId,
      evidenceAttachmentId: input.evidenceAttachmentId,
      journalEntryId: result.journalEntryId,
      postedBy: ctx.principal.userId,
    })
    .returning({ id: investmentDisposal.id });

  await tx
    .update(investment)
    .set({
      unitsHeld: toDecimalString(outcome.unitsRemaining, 6n),
      costIqd: toDecimalString(carrying.costIqd - outcome.carryingValueDisposedIqd, 4n),
      ...(outcome.isFullDisposal
        ? { status: 'closed' as const, disposedOn: input.disposedOn, closedBy: ctx.principal.userId, closedAt: new Date() }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(investment.id, id));

  return {
    id: created!.id,
    disposalNo: allocated.documentNo,
    journalEntryId: result.journalEntryId,
    realisedResultIqd: outcome.realisedResultIqd,
    isFullDisposal: outcome.isFullDisposal,
  };
}

// ---------------------------------------------------------------------------
// 13.7 / 13.8 — calendar and reports
// ---------------------------------------------------------------------------

export async function raiseCapitalCall(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: { dueOn: string; amountTxn: bigint; amountIqd: bigint; note?: string | null },
): Promise<{ id: string }> {
  const held = await loadInvestment(tx, id);
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: held.branchCode,
  });

  const [created] = await tx
    .insert(investmentCapitalCall)
    .values({
      investmentId: id,
      dueOn: input.dueOn,
      amountTxn: toDecimalString(input.amountTxn, 4n),
      amountIqd: toDecimalString(input.amountIqd, 4n),
      note: input.note ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: investmentCapitalCall.id });

  return { id: created!.id };
}

/**
 * §13.7 — *"the maturity, review, document expiry and capital-call calendar
 * shows all four event types."*
 *
 * One list, so a person planning a month looks in one place.
 *
 * **Three of the four are here. Document expiry is Phase 17's.** §21 gives the
 * Document Centre *"expiry date and renewal owner"*, and `attachment` has no
 * expiry column because Phase 17 has not been built. Adding one here would give
 * this module a private copy of a field the whole system is going to share —
 * which is the mistake Phases 09 and 10 made with the client import file, and it
 * cost a merge to undo.
 *
 * So the fourth arm is absent rather than invented, and the union is shaped so
 * that adding it is one `union all` and no change to the result. Phase 17 adds
 * it; nothing here moves.
 */
export async function calendar(tx: Tx, ctx: ActorContext, upToDate: string) {
  await authz.authorize(ctx.principal, 'view', PERMISSION_OBJECT, { branchCode: ctx.branchCode });

  const result = (await tx.execute(sql`
    select 'maturity' as kind, i.investment_no as reference, i.description,
           i.maturity_date::text as due_on, null::text as amount_txn
      from investment i
     where i.maturity_date is not null and i.maturity_date <= ${upToDate}
       and i.disposed_on is null
    union all
    select 'review', i.investment_no, i.description,
           i.next_review_on::text, null
      from investment i
     where i.next_review_on is not null and i.next_review_on <= ${upToDate}
       and i.disposed_on is null
    union all
    select 'capital_call', i.investment_no, coalesce(c.note, i.description),
           c.due_on::text, c.amount_txn::text
      from investment_capital_call c
      join investment i on i.id = c.investment_id
     where c.due_on <= ${upToDate} and c.funded_by_id is null
     order by due_on, reference
  `)) as unknown as {
    rows: Array<{
      kind: string;
      reference: string;
      description: string | null;
      due_on: string;
      amount_txn: string | null;
    }>;
  };

  return result.rows;
}

/**
 * §13.8 — the investment register, and §13 acceptance 4: it reconciles to the
 * investment G/L accounts.
 *
 * Carrying value and unrealised result are computed here rather than read from
 * a column, so the report cannot disagree with the valuation history it is drawn
 * from.
 */
export async function register(
  tx: Tx,
  ctx: ActorContext,
  filter: { typeCode?: string | null; counterpartyPartnerId?: string | null; includeDisposed?: boolean } = {},
) {
  await authz.authorize(ctx.principal, 'view', PERMISSION_OBJECT, { branchCode: ctx.branchCode });

  const result = (await tx.execute(sql`
    select i.investment_no                                          as "investmentNo",
           i.description                                            as "description",
           i.type_code                                              as "typeCode",
           i.status::text                                           as "status",
           i.currency_code                                          as "currencyCode",
           i.branch_code                                            as "branchCode",
           p.code                                                   as "counterpartyCode",
           i.units_held::text                                       as "unitsHeld",
           i.cost_iqd::text                                         as "costIqd",
           coalesce((select v.value_iqd from investment_valuation v
                      where v.investment_id = i.id
                      order by v.valued_on desc limit 1),
                    i.cost_iqd)::text                               as "valuedIqd",
           coalesce((select sum(m.amount_iqd) from investment_impairment m
                      where m.investment_id = i.id), 0)::text       as "impairedIqd",
           (coalesce((select v.value_iqd from investment_valuation v
                       where v.investment_id = i.id
                       order by v.valued_on desc limit 1), i.cost_iqd)
             - coalesce((select sum(m.amount_iqd) from investment_impairment m
                          where m.investment_id = i.id), 0))::text  as "carryingValueIqd",
           coalesce((select sum(n.amount_iqd) from investment_income n
                      where n.investment_id = i.id), 0)::text       as "incomeIqd",
           coalesce((select sum(d.realised_result_iqd) from investment_disposal d
                      where d.investment_id = i.id), 0)::text       as "realisedResultIqd"
      from investment i
      left join business_partner p on p.id = i.counterparty_partner_id
     where (${filter.typeCode ?? null}::text is null or i.type_code = ${filter.typeCode ?? null})
       and (${filter.counterpartyPartnerId ?? null}::uuid is null
            or i.counterparty_partner_id = ${filter.counterpartyPartnerId ?? null})
       and (${filter.includeDisposed ?? false} or i.disposed_on is null)
     order by i.investment_no
  `)) as unknown as { rows: Array<Record<string, string>> };

  return result.rows;
}

/** §13.8 — portfolio totals, with realised and unrealised reported separately. */
export async function portfolio(
  tx: Tx,
  ctx: ActorContext,
  filter: Parameters<typeof register>[2] = {},
) {
  const rows = await register(tx, ctx, filter);
  const totals = portfolioTotals(
    rows.map((r) => ({
      costIqd: parseDecimal(r.costIqd!, 4n),
      carryingValueIqd: parseDecimal(r.carryingValueIqd!, 4n),
      incomeIqd: parseDecimal(r.incomeIqd!, 4n),
      realisedResultIqd: parseDecimal(r.realisedResultIqd!, 4n),
    })),
  );

  return {
    lines: rows,
    costIqd: toDecimalString(totals.costIqd, 4n),
    carryingValueIqd: toDecimalString(totals.carryingValueIqd, 4n),
    incomeIqd: toDecimalString(totals.incomeIqd, 4n),
    realisedResultIqd: toDecimalString(totals.realisedResultIqd, 4n),
    unrealisedResultIqd: toDecimalString(totals.unrealisedResultIqd, 4n),
    totalReturnIqd: toDecimalString(totals.totalReturnIqd, 4n),
  };
}

export { businessPartner };
