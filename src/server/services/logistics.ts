/**
 * Logistics Operations — Phase 10 service layer, §11.
 *
 * Every function takes the caller's `tx` and never opens its own. §24 requires
 * the module's records, the journal and the subledger to commit together, which
 * is only possible when they share a transaction.
 *
 * ── What this module is careful *not* to decide ─────────────────────────────
 * Three questions §11 leaves open are accounting outcomes, and §28.1 puts those
 * beyond the implementation team. None of them is answered in code here:
 *
 *   · which clearing role a funding credits at each job stage — read from
 *     `logistics_funding_stage_role`, which ships empty, so funding cannot post
 *     until Finance configures it (Q10-1);
 *   · what a cancellation does with money already posted — refused rather than
 *     guessed (Q10-3);
 *   · what a claim does to the ledger — nothing, because Appendix C has no row
 *     for one (Q10-4).
 *
 * The one place a rule is applied without a written blueprint sentence is the
 * split between Client Logistics Clearing and Client A/R at recognition, and the
 * reasoning is set out in `domain/logistics.ts` — the clearing account cannot be
 * debited past what was funded without ceasing to mean what it says. It is
 * recorded as Q10-2 all the same.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  businessPartner,
  clientImportFile,
  clientImportFileReference,
  logisticsCarrier,
  logisticsClaim,
  logisticsClientCharge,
  logisticsClientFunding,
  logisticsDeliveryEvidence,
  logisticsFundingStageRole,
  logisticsJob,
  logisticsJobCost,
  logisticsJobLeg,
  logisticsJobSettlement,
  logisticsRoute,
  logisticsServiceType,
  logisticsServiceTypeEvidence,
} from '../db/schema';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';
import {
  allocateAcrossFundings,
  assertCloseable,
  assertJobTransition,
  jobMargin,
  missingEvidence,
  splitRecognition,
  type LogisticsJobStatus,
} from '../domain/logistics';
import type { PostingLineRequest } from '../domain/posting';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as statuses from './statuses';
import * as posting from './posting';
import { allocateDocumentNumber } from './numbering';

/** §2.2 — the business line every logistics posting carries. */
export const BUSINESS_LINE = 'LOGISTICS';
/** The module name on every source reference, for §3.3's drill-down. */
export const MODULE = 'logistics';

/** One register for both services — D16, answered 2026-08-18. */
export const IMPORT_FILE_TYPE = 'client_import_file';
export const JOB_TYPE = 'logistics_job';
export const FUNDING_TYPE = 'logistics_client_funding';
export const COST_TYPE = 'logistics_job_cost';
export const SETTLEMENT_TYPE = 'logistics_job_settlement';
export const CLAIM_TYPE = 'logistics_claim';

const money = (value: bigint) => toDecimalString(value, MONEY_SCALE);
const amount = (value: string) => parseDecimal(value, MONEY_SCALE);

// ---------------------------------------------------------------------------
// Errors — every one names the clause it comes from (§25)
// ---------------------------------------------------------------------------

export class LogisticsNotFoundError extends Error {
  readonly code = 'LOGISTICS_NOT_FOUND';
  constructor(what: string, id: string) {
    super(`No ${what} '${id}'.`);
    this.name = 'LogisticsNotFoundError';
  }
}

export class LogisticsStateError extends Error {
  readonly code = 'LOGISTICS_STATE_INVALID';
  constructor(documentNo: string, status: string, detail: string) {
    super(`${documentNo} is '${status}': ${detail}`);
    this.name = 'LogisticsStateError';
  }
}

/** §11.4 — the stage mapping Finance has not filled in yet. */
export class FundingStageNotMappedError extends Error {
  readonly code = 'LOGISTICS_FUNDING_STAGE_NOT_MAPPED';
  constructor(readonly jobStatus: string) {
    super(
      `Section 11.4 credits client funding to "Client Logistics Clearing or Deferred Service Balance ` +
        `according to document stage", and no role is configured for a job at stage '${jobStatus}'. ` +
        'Finance sets the mapping in Logistics Settings — the posting will not choose between two ' +
        'accounts on its own (§28.1, open question Q10-1).',
    );
    this.name = 'FundingStageNotMappedError';
  }
}

export class MissingDeliveryEvidenceError extends Error {
  readonly code = 'LOGISTICS_EVIDENCE_MISSING';
  constructor(
    readonly jobNo: string,
    readonly serviceTypeCode: string,
    readonly missing: readonly string[],
  ) {
    super(
      `Logistics job ${jobNo} cannot settle: service type ${serviceTypeCode} requires ` +
        `${missing.join(', ')}, and ${missing.length === 1 ? 'it is' : 'they are'} not recorded (§11.2). ` +
        'Record the delivery evidence first — the settlement is what tells the ledger the service was completed.',
    );
    this.name = 'MissingDeliveryEvidenceError';
  }
}

export class NothingToSettleError extends Error {
  readonly code = 'LOGISTICS_NOTHING_TO_SETTLE';
  constructor(readonly jobNo: string) {
    super(
      `Logistics job ${jobNo} has no unbilled client charges, so there is nothing to recognise (§11.4). ` +
        'Add the charge the client agreed, or close the job if the service was free of charge.',
    );
    this.name = 'NothingToSettleError';
  }
}

// ---------------------------------------------------------------------------
// 10.1 Client import files
// ---------------------------------------------------------------------------

export interface CreateImportFileInput {
  readonly clientId: string;
  readonly branchCode: string;
  readonly openedOn: string;
  readonly originCountry?: string | null;
  readonly description?: string | null;
  readonly note?: string | null;
}

export async function createImportFile(
  tx: Tx,
  ctx: ActorContext,
  input: CreateImportFileInput,
): Promise<{ id: string; fileNo: string }> {
  await authz.authorize(ctx.principal, 'create', IMPORT_FILE_TYPE, {
    branchCode: input.branchCode,
  });

  const allocated = await allocateDocumentNumber(
    tx,
    // One register, one counter. Two sequences both minting CIF numbers gave
    // two consignments the same file number (D16).
    'CLIENT_IMPORT_FILE',
    { branchCode: input.branchCode, year: Number(input.openedOn.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(clientImportFile)
    .values({
      fileNo: allocated.documentNo,
      clientId: input.clientId,
      branchCode: input.branchCode,
      openedOn: input.openedOn,
      originCountry: input.originCountry ?? null,
      description: input.description ?? null,
      note: input.note ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: clientImportFile.id });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'client_import_file.created',
    objectType: IMPORT_FILE_TYPE,
    objectId: created!.id,
    branchCode: input.branchCode,
    after: { fileNo: allocated.documentNo, clientId: input.clientId },
    outcome: 'success',
  });

  return { id: created!.id, fileNo: allocated.documentNo };
}

/**
 * Records that a document concerns this import file — §11's cross-reference.
 *
 * Deliberately module-agnostic. Phase 09 calls this with its own module name and
 * document type when a money transfer relates to the same shipment, and neither
 * phase needs to know the other's tables. What it cannot do, in any module, is
 * carry an amount: the row has no column for one, so the link can never become a
 * combined total (§11.3, §12.4).
 */
export async function linkToImportFile(
  tx: Tx,
  ctx: ActorContext,
  input: {
    readonly importFileId: string;
    readonly module: string;
    readonly documentType: string;
    readonly documentId: string;
    readonly documentNo: string;
    readonly note?: string | null;
  },
): Promise<{ id: string }> {
  const file = await loadImportFile(tx, input.importFileId);

  await authz.authorize(ctx.principal, 'edit_draft', IMPORT_FILE_TYPE, {
    branchCode: file.branchCode,
  });

  const [created] = await tx
    .insert(clientImportFileReference)
    .values({
      importFileId: input.importFileId,
      module: input.module,
      documentType: input.documentType,
      documentId: input.documentId,
      documentNo: input.documentNo,
      note: input.note ?? null,
      linkedBy: ctx.principal.userId,
    })
    .returning({ id: clientImportFileReference.id });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'client_import_file.linked',
    objectType: IMPORT_FILE_TYPE,
    objectId: input.importFileId,
    branchCode: file.branchCode,
    after: {
      fileNo: file.fileNo,
      module: input.module,
      documentType: input.documentType,
      documentNo: input.documentNo,
    },
    outcome: 'success',
  });

  return { id: created!.id };
}

/** Withdraws a cross-reference. §11 — a link is removed, never re-pointed. */
export async function unlinkFromImportFile(
  tx: Tx,
  ctx: ActorContext,
  input: { readonly module: string; readonly documentId: string; readonly reason: string },
): Promise<void> {
  const [reference] = await tx
    .select()
    .from(clientImportFileReference)
    .where(
      and(
        eq(clientImportFileReference.module, input.module),
        eq(clientImportFileReference.documentId, input.documentId),
      ),
    )
    .limit(1);

  if (!reference) throw new LogisticsNotFoundError('cross-reference', input.documentId);

  const file = await loadImportFile(tx, reference.importFileId);

  await authz.authorize(ctx.principal, 'edit_draft', IMPORT_FILE_TYPE, {
    branchCode: file.branchCode,
  });

  if (input.reason.trim().length === 0) {
    throw new Error(
      'Withdrawing a cross-reference needs a reason (§5.4). Reports have already been run against this file.',
    );
  }

  await tx
    .delete(clientImportFileReference)
    .where(eq(clientImportFileReference.id, reference.id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'client_import_file.unlinked',
    objectType: IMPORT_FILE_TYPE,
    objectId: reference.importFileId,
    branchCode: file.branchCode,
    before: { module: reference.module, documentNo: reference.documentNo },
    reason: input.reason.trim(),
    outcome: 'success',
  });
}

export async function closeImportFile(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  closedOn: string,
): Promise<void> {
  const file = await loadImportFile(tx, id);

  await authz.authorize(ctx.principal, 'approve', IMPORT_FILE_TYPE, {
    branchCode: file.branchCode,
  });

  await tx
    .update(clientImportFile)
    .set({ status: 'closed', closedOn, updatedAt: new Date() })
    .where(eq(clientImportFile.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'client_import_file.closed',
    objectType: IMPORT_FILE_TYPE,
    objectId: id,
    branchCode: file.branchCode,
    before: { status: file.status },
    after: { status: 'closed', closedOn },
    outcome: 'success',
  });
}

async function loadImportFile(tx: Tx, id: string) {
  const [file] = await tx
    .select()
    .from(clientImportFile)
    .where(eq(clientImportFile.id, id))
    .limit(1);
  if (!file) throw new LogisticsNotFoundError('client import file', id);
  return file;
}

// ---------------------------------------------------------------------------
// 10.3 / 10.7 Masters and configuration
// ---------------------------------------------------------------------------

export async function createCarrier(
  tx: Tx,
  ctx: ActorContext,
  input: {
    readonly code: string;
    readonly name: string;
    readonly businessPartnerId: string;
    readonly mode: string;
    readonly carrierReference?: string | null;
  },
): Promise<void> {
  await authz.authorize(ctx.principal, 'create', 'logistics_carrier', {
    branchCode: ctx.branchCode,
  });

  await tx.insert(logisticsCarrier).values({
    code: input.code,
    name: input.name,
    businessPartnerId: input.businessPartnerId,
    mode: input.mode,
    carrierReference: input.carrierReference ?? null,
    createdBy: ctx.principal.userId,
  });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'logistics_carrier.created',
    objectType: 'logistics_carrier',
    objectId: input.code,
    branchCode: ctx.branchCode,
    after: { code: input.code, mode: input.mode },
    outcome: 'success',
  });
}

export async function createRoute(
  tx: Tx,
  ctx: ActorContext,
  input: {
    readonly code: string;
    readonly name: string;
    readonly origin: string;
    readonly destination: string;
  },
): Promise<void> {
  await authz.authorize(ctx.principal, 'create', 'logistics_route', {
    branchCode: ctx.branchCode,
  });
  await tx.insert(logisticsRoute).values(input);
}

export async function createServiceType(
  tx: Tx,
  ctx: ActorContext,
  input: {
    readonly code: string;
    readonly name: string;
    readonly description?: string | null;
    /** What a job of this type must prove before it may settle (10.7). */
    readonly requiredEvidence?: readonly string[];
  },
): Promise<void> {
  await authz.authorize(ctx.principal, 'create', 'logistics_service_type', {
    branchCode: ctx.branchCode,
  });

  await tx.insert(logisticsServiceType).values({
    code: input.code,
    name: input.name,
    description: input.description ?? null,
  });

  for (const evidenceType of input.requiredEvidence ?? []) {
    await tx
      .insert(logisticsServiceTypeEvidence)
      .values({ serviceTypeCode: input.code, evidenceType })
      .onConflictDoNothing();
  }
}

/**
 * §11.4 — Finance says which clearing role a funding credits at each job stage.
 *
 * `configure`, not `create`: §5.5 treats this as configuration under review, and
 * a change here changes the accounting of every funding posted afterwards.
 */
export async function setFundingStageRole(
  tx: Tx,
  ctx: ActorContext,
  input: {
    readonly jobStatus: LogisticsJobStatus;
    readonly lineRole: string;
    readonly note?: string | null;
  },
): Promise<void> {
  await authz.authorize(ctx.principal, 'configure', 'logistics_client_funding', {
    branchCode: ctx.branchCode,
  });

  await tx
    .insert(logisticsFundingStageRole)
    .values({
      jobStatus: input.jobStatus as never,
      lineRole: input.lineRole,
      note: input.note ?? null,
      updatedBy: ctx.principal.userId,
    })
    .onConflictDoUpdate({
      target: logisticsFundingStageRole.jobStatus,
      set: {
        lineRole: input.lineRole,
        note: input.note ?? null,
        updatedBy: ctx.principal.userId,
        updatedAt: new Date(),
      },
    });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'logistics_funding_stage_role.configured',
    objectType: 'logistics_client_funding',
    objectId: input.jobStatus,
    branchCode: ctx.branchCode,
    after: { jobStatus: input.jobStatus, lineRole: input.lineRole },
    outcome: 'success',
  });
}

// ---------------------------------------------------------------------------
// 10.2 The job
// ---------------------------------------------------------------------------

export interface CreateJobInput {
  readonly importFileId: string;
  readonly serviceTypeCode: string;
  readonly routeCode?: string | null;
  readonly branchCode: string;
  readonly departmentCode: string;
  readonly jobDate: string;
  readonly promisedDeliveryDate?: string | null;
  readonly currencyCode?: string;
  readonly description?: string | null;
  readonly note?: string | null;
}

/**
 * Raises a job as a draft, and cross-references it to its import file in the
 * same transaction.
 *
 * The link is not optional and not a separate step: Appendix B names the Client
 * Import File as this document's source, and §11.5's cross-reference report is
 * only complete if every job appears in it. A job that could exist unlinked
 * would be invisible to the one report whose purpose is to show that Logistics
 * and Money Transfer are being kept apart.
 */
export async function createJob(
  tx: Tx,
  ctx: ActorContext,
  input: CreateJobInput,
): Promise<{ id: string; jobNo: string }> {
  await authz.authorize(ctx.principal, 'create', JOB_TYPE, { branchCode: input.branchCode });

  const file = await loadImportFile(tx, input.importFileId);

  const allocated = await allocateDocumentNumber(
    tx,
    'LOGISTICS_JOB',
    { branchCode: input.branchCode, year: Number(input.jobDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(logisticsJob)
    .values({
      jobNo: allocated.documentNo,
      importFileId: input.importFileId,
      clientId: file.clientId,
      serviceTypeCode: input.serviceTypeCode,
      routeCode: input.routeCode ?? null,
      branchCode: input.branchCode,
      departmentCode: input.departmentCode,
      jobDate: input.jobDate,
      promisedDeliveryDate: input.promisedDeliveryDate ?? null,
      currencyCode: input.currencyCode ?? 'IQD',
      description: input.description ?? null,
      note: input.note ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: logisticsJob.id });

  await linkToImportFile(tx, ctx, {
    importFileId: input.importFileId,
    module: MODULE,
    documentType: JOB_TYPE,
    documentId: created!.id,
    documentNo: allocated.documentNo,
    note: 'Linked when the job was raised (Appendix B — the import file is the job\'s source document).',
  });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'logistics_job.created',
    objectType: JOB_TYPE,
    objectId: created!.id,
    branchCode: input.branchCode,
    after: { jobNo: allocated.documentNo, fileNo: file.fileNo, serviceType: input.serviceTypeCode },
    outcome: 'success',
  });

  return { id: created!.id, jobNo: allocated.documentNo };
}

async function loadJob(tx: Tx, id: string) {
  const [job] = await tx.select().from(logisticsJob).where(eq(logisticsJob.id, id)).limit(1);
  if (!job) throw new LogisticsNotFoundError('logistics job', id);
  return job;
}

/**
 * Moves the job one step along Appendix B's workflow.
 *
 * One function rather than seven, because the rule being enforced is the same
 * every time — "the next step, and only the next step" — and seven functions
 * would be seven places for it to drift. The domain module owns the ordering;
 * the status machine (§3.2) is consulted as well, so a transition somebody
 * removes from configuration stops working without a code change.
 */
export async function advanceJob(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  to: LogisticsJobStatus,
  options: { readonly deliveredOn?: string } = {},
): Promise<void> {
  const job = await loadJob(tx, id);

  const verb = to === 'approved' ? 'approve' : to === 'closed' ? 'approve' : 'execute';
  await authz.authorize(ctx.principal, verb, JOB_TYPE, { branchCode: job.branchCode });

  assertJobTransition(job.jobNo, job.status as LogisticsJobStatus, to);
  await statuses.assertTransitionAllowed(tx, JOB_TYPE, job.status, to);

  // §5.2 — the person who raised a job does not approve it. The approval is what
  // authorises the spend that follows it, so it is not a formality.
  if (to === 'approved' && job.createdBy === ctx.principal.userId && !ctx.principal.isSuperUser) {
    throw new LogisticsStateError(
      job.jobNo,
      job.status,
      'the person who raised a job cannot approve it (§5.2). The approval is what authorises the third-party spend.',
    );
  }

  if (to === 'closed') {
    assertCloseable({ jobNo: job.jobNo, ...(await closePosition(tx, id)) });
  }

  await tx
    .update(logisticsJob)
    .set({
      status: to as never,
      approvedBy: to === 'approved' ? ctx.principal.userId : job.approvedBy,
      approvedAt: to === 'approved' ? new Date() : job.approvedAt,
      deliveredOn: to === 'executed' ? (options.deliveredOn ?? job.jobDate) : job.deliveredOn,
      settledAt: to === 'settled' ? new Date() : job.settledAt,
      closedAt: to === 'closed' ? new Date() : job.closedAt,
      updatedAt: new Date(),
    })
    .where(eq(logisticsJob.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: `logistics_job.${to}`,
    objectType: JOB_TYPE,
    objectId: id,
    branchCode: job.branchCode,
    before: { status: job.status },
    after: { status: to },
    outcome: 'success',
  });
}

/**
 * Appendix B's Cancelled state, reachable only before anything has posted.
 *
 * The narrowness is the point, and it is argued in `domain/logistics.ts`: what
 * happens to posted costs and client funding on a cancellation is a Finance
 * decision (Q10-3), so the system refuses rather than invents one.
 */
export async function cancelJob(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  reason: string,
): Promise<void> {
  const job = await loadJob(tx, id);

  await authz.authorize(ctx.principal, 'reverse_cancel', JOB_TYPE, {
    branchCode: job.branchCode,
  });

  if (reason.trim().length === 0) {
    throw new Error('Cancelling a job needs a reason (§5.4).');
  }

  // Checked before the generic ordering rule so the refusal says *why* rather
  // than merely that the move is not on the list. From In Progress onward the
  // job may carry posted cost and client funding, and what becomes of that money
  // is a Finance decision (§28.1, Q10-3) — not one this service may take.
  if (job.status !== 'draft' && job.status !== 'approved') {
    throw new LogisticsStateError(
      job.jobNo,
      job.status,
      'the job is already under way, so it cannot simply be cancelled (Appendix B). ' +
        'Costs or client funding may have posted against it, and what happens to that money ' +
        'is a Finance decision — see open question Q10-3.',
    );
  }

  assertJobTransition(job.jobNo, job.status as LogisticsJobStatus, 'cancelled');
  await statuses.assertTransitionAllowed(tx, JOB_TYPE, job.status, 'cancelled', reason.trim());

  await tx
    .update(logisticsJob)
    .set({
      status: 'cancelled',
      cancelledBy: ctx.principal.userId,
      cancelledAt: new Date(),
      cancellationReason: reason.trim(),
      updatedAt: new Date(),
    })
    .where(eq(logisticsJob.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'logistics_job.cancelled',
    objectType: JOB_TYPE,
    objectId: id,
    branchCode: job.branchCode,
    before: { status: job.status },
    after: { status: 'cancelled' },
    reason: reason.trim(),
    outcome: 'success',
  });
}

// ---------------------------------------------------------------------------
// 10.3 Legs
// ---------------------------------------------------------------------------

export async function addLeg(
  tx: Tx,
  ctx: ActorContext,
  input: {
    readonly jobId: string;
    readonly carrierCode: string;
    readonly mode: string;
    readonly origin: string;
    readonly destination: string;
    readonly plannedDeparture?: string | null;
    readonly plannedArrival?: string | null;
    readonly transportDocumentNo?: string | null;
  },
): Promise<{ id: string; legNo: number }> {
  const job = await loadJob(tx, input.jobId);

  await authz.authorize(ctx.principal, 'edit_draft', JOB_TYPE, { branchCode: job.branchCode });

  const [nextRow] = await tx
    .select({ next: sql<number>`coalesce(max(${logisticsJobLeg.legNo}), 0) + 1` })
    .from(logisticsJobLeg)
    .where(eq(logisticsJobLeg.jobId, input.jobId));

  const next = nextRow!.next;

  const [created] = await tx
    .insert(logisticsJobLeg)
    .values({
      jobId: input.jobId,
      legNo: next,
      carrierCode: input.carrierCode,
      mode: input.mode,
      origin: input.origin,
      destination: input.destination,
      plannedDeparture: input.plannedDeparture ?? null,
      plannedArrival: input.plannedArrival ?? null,
      transportDocumentNo: input.transportDocumentNo ?? null,
    })
    .returning({ id: logisticsJobLeg.id });

  return { id: created!.id, legNo: next };
}

export async function completeLeg(
  tx: Tx,
  ctx: ActorContext,
  legId: string,
  actual: { readonly departure?: string | null; readonly arrival: string },
): Promise<void> {
  const [leg] = await tx
    .select()
    .from(logisticsJobLeg)
    .where(eq(logisticsJobLeg.id, legId))
    .limit(1);
  if (!leg) throw new LogisticsNotFoundError('route leg', legId);

  const job = await loadJob(tx, leg.jobId);
  await authz.authorize(ctx.principal, 'execute', JOB_TYPE, { branchCode: job.branchCode });

  await tx
    .update(logisticsJobLeg)
    .set({
      status: 'completed',
      actualDeparture: actual.departure ?? leg.actualDeparture,
      actualArrival: actual.arrival,
      updatedAt: new Date(),
    })
    .where(eq(logisticsJobLeg.id, legId));
}

// ---------------------------------------------------------------------------
// 10.4 Client charges and funding
// ---------------------------------------------------------------------------

export async function addClientCharge(
  tx: Tx,
  ctx: ActorContext,
  input: {
    readonly jobId: string;
    readonly chargeType: string;
    readonly description: string;
    readonly amountIqd: bigint;
  },
): Promise<{ id: string; lineNo: number }> {
  const job = await loadJob(tx, input.jobId);

  await authz.authorize(ctx.principal, 'create', 'logistics_client_charge', {
    branchCode: job.branchCode,
  });

  const [nextRow] = await tx
    .select({ next: sql<number>`coalesce(max(${logisticsClientCharge.lineNo}), 0) + 1` })
    .from(logisticsClientCharge)
    .where(eq(logisticsClientCharge.jobId, input.jobId));

  const next = nextRow!.next;

  const [created] = await tx
    .insert(logisticsClientCharge)
    .values({
      jobId: input.jobId,
      lineNo: next,
      chargeType: input.chargeType,
      description: input.description,
      amount: money(input.amountIqd),
      currencyCode: job.currencyCode,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: logisticsClientCharge.id });

  return { id: created!.id, lineNo: next };
}

export interface CreateFundingInput {
  readonly jobId: string;
  readonly fundingDate: string;
  readonly amountIqd: bigint;
  readonly receivedVia: 'bank' | 'cash' | 'client_account';
  readonly bankCashAccountId?: string | null;
  readonly note?: string | null;
}

export async function createFunding(
  tx: Tx,
  ctx: ActorContext,
  input: CreateFundingInput,
): Promise<{ id: string; fundingNo: string }> {
  const job = await loadJob(tx, input.jobId);

  await authz.authorize(ctx.principal, 'create', FUNDING_TYPE, { branchCode: job.branchCode });

  const allocated = await allocateDocumentNumber(
    tx,
    'LOGISTICS_CLIENT_FUNDING',
    { branchCode: job.branchCode, year: Number(input.fundingDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(logisticsClientFunding)
    .values({
      fundingNo: allocated.documentNo,
      jobId: input.jobId,
      branchCode: job.branchCode,
      fundingDate: input.fundingDate,
      amount: money(input.amountIqd),
      currencyCode: job.currencyCode,
      receivedVia: input.receivedVia,
      bankCashAccountId: input.bankCashAccountId ?? null,
      note: input.note ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: logisticsClientFunding.id });

  return { id: created!.id, fundingNo: allocated.documentNo };
}

/**
 * §11.4, first row — *Dr Bank, Cash or Client Account / Cr Client Logistics
 * Clearing or Deferred Service Balance according to document stage.*
 *
 * The credit role is looked up rather than chosen, and the lookup failing is a
 * refusal with a sentence, not a fallback. Falling back to "whichever account is
 * probably right" is how a module ends up having made an accounting decision
 * nobody signed off.
 */
export async function postFunding(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ journalEntryId: string; clearingRole: string }> {
  const [funding] = await tx
    .select()
    .from(logisticsClientFunding)
    .where(eq(logisticsClientFunding.id, id))
    .limit(1);
  if (!funding) throw new LogisticsNotFoundError('client funding', id);

  await authz.authorize(ctx.principal, 'post', FUNDING_TYPE, { branchCode: funding.branchCode });

  if (funding.status !== 'draft') {
    throw new LogisticsStateError(
      funding.fundingNo,
      funding.status,
      'only a draft funding can be posted.',
    );
  }

  const job = await loadJob(tx, funding.jobId);
  const client = await partnerCode(tx, job.clientId);

  const [stage] = await tx
    .select()
    .from(logisticsFundingStageRole)
    .where(eq(logisticsFundingStageRole.jobStatus, job.status))
    .limit(1);

  if (!stage) throw new FundingStageNotMappedError(job.status);

  const value = amount(funding.amount);
  const debitRole =
    funding.receivedVia === 'client_account' ? 'client_account' : funding.receivedVia;

  const dimensions = {
    branch: funding.branchCode,
    business_line: BUSINESS_LINE,
    business_partner: client,
  };
  const criteria = { branchCode: funding.branchCode };

  const result = await posting.post(tx, ctx, {
    eventType: 'logistics.client_funding',
    documentTypeCode: FUNDING_TYPE,
    source: { module: MODULE, documentId: id, event: 'posted' },
    branchCode: funding.branchCode,
    documentDate: funding.fundingDate,
    postingDate: funding.fundingDate,
    currency: funding.currencyCode,
    description: `Logistics client funding ${funding.fundingNo} — job ${job.jobNo}`,
    lines: [
      { role: debitRole, debit: money(value), criteria, dimensions },
      { role: stage.lineRole, credit: money(value), criteria, dimensions },
    ],
  });

  await statuses.assertTransitionAllowed(tx, FUNDING_TYPE, funding.status, 'posted');

  await tx
    .update(logisticsClientFunding)
    .set({
      status: 'posted',
      clearingRole: stage.lineRole,
      journalEntryId: result.journalEntryId,
      postedBy: ctx.principal.userId,
      postedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(logisticsClientFunding.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'logistics_client_funding.posted',
    objectType: FUNDING_TYPE,
    objectId: id,
    branchCode: funding.branchCode,
    after: {
      fundingNo: funding.fundingNo,
      jobStage: job.status,
      clearingRole: stage.lineRole,
      journalEntryId: result.journalEntryId,
    },
    outcome: 'success',
  });

  return { journalEntryId: result.journalEntryId, clearingRole: stage.lineRole };
}

// ---------------------------------------------------------------------------
// 10.5 Third-party cost
// ---------------------------------------------------------------------------

export interface CreateCostInput {
  readonly jobId: string;
  /** Appendix C makes the job link mandatory; there is no input without one. */
  readonly legId?: string | null;
  readonly costDate: string;
  readonly costType: string;
  readonly description: string;
  readonly amountIqd: bigint;
  readonly currencyCode?: string;
  readonly settlementMode: 'bank' | 'supplier_payable';
  readonly bankCashAccountId?: string | null;
  readonly supplierId?: string | null;
  readonly supplierReference?: string | null;
}

export async function createCost(
  tx: Tx,
  ctx: ActorContext,
  input: CreateCostInput,
): Promise<{ id: string; costNo: string }> {
  const job = await loadJob(tx, input.jobId);

  await authz.authorize(ctx.principal, 'create', COST_TYPE, { branchCode: job.branchCode });

  const allocated = await allocateDocumentNumber(
    tx,
    'LOGISTICS_JOB_COST',
    { branchCode: job.branchCode, year: Number(input.costDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(logisticsJobCost)
    .values({
      costNo: allocated.documentNo,
      jobId: input.jobId,
      legId: input.legId ?? null,
      branchCode: job.branchCode,
      costDate: input.costDate,
      costType: input.costType,
      description: input.description,
      amount: money(input.amountIqd),
      currencyCode: input.currencyCode ?? job.currencyCode,
      settlementMode: input.settlementMode,
      bankCashAccountId: input.bankCashAccountId ?? null,
      supplierId: input.supplierId ?? null,
      supplierReference: input.supplierReference ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: logisticsJobCost.id });

  return { id: created!.id, costNo: allocated.documentNo };
}

/**
 * §11.4, second row — *Dr Logistics Job Cost / Cr Bank or Supplier A/P.*
 *
 * One debit role, always `logistics_job_cost`, so §11.3's *"the company does not
 * absorb logistics costs"* holds by construction: there is no code path here
 * that emits a general expense role, and §3.3's mapping is what decides which
 * account the role means. The credit role follows the settlement mode, and a
 * supplier payable carries the supplier as its business partner dimension so the
 * A/P subledger picks it up (10.3's reconciliation gate).
 */
export async function postCost(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ journalEntryId: string }> {
  const [cost] = await tx
    .select()
    .from(logisticsJobCost)
    .where(eq(logisticsJobCost.id, id))
    .limit(1);
  if (!cost) throw new LogisticsNotFoundError('logistics cost', id);

  await authz.authorize(ctx.principal, 'post', COST_TYPE, { branchCode: cost.branchCode });

  if (cost.status !== 'draft') {
    throw new LogisticsStateError(cost.costNo, cost.status, 'only a draft cost can be posted.');
  }

  const job = await loadJob(tx, cost.jobId);
  const supplier = cost.supplierId ? await partnerCode(tx, cost.supplierId) : null;

  const value = amount(cost.amount);
  const criteria = { branchCode: cost.branchCode };

  // §4.2 — the expense side carries the department that owns the job and the
  // Logistics business line. Both are mandatory on operating expense accounts,
  // and taking them from the job rather than from the poster is what keeps every
  // cost on a job attributed the same way.
  const costDimensions = {
    branch: cost.branchCode,
    business_line: BUSINESS_LINE,
    department: job.departmentCode,
  };

  const creditDimensions = {
    branch: cost.branchCode,
    business_line: BUSINESS_LINE,
    ...(supplier ? { business_partner: supplier } : {}),
  };

  const lines: PostingLineRequest[] = [
    { role: 'logistics_job_cost', debit: money(value), criteria, dimensions: costDimensions },
    {
      role: cost.settlementMode === 'bank' ? 'bank' : 'supplier_payable',
      credit: money(value),
      criteria,
      dimensions: creditDimensions,
    },
  ];

  const result = await posting.post(tx, ctx, {
    eventType: 'logistics.job_cost',
    documentTypeCode: COST_TYPE,
    source: { module: MODULE, documentId: id, event: 'posted' },
    branchCode: cost.branchCode,
    documentDate: cost.costDate,
    postingDate: cost.costDate,
    currency: cost.currencyCode,
    description: `Logistics direct cost ${cost.costNo} — job ${job.jobNo}, ${cost.description}`,
    lines,
  });

  await statuses.assertTransitionAllowed(tx, COST_TYPE, cost.status, 'posted');

  await tx
    .update(logisticsJobCost)
    .set({
      status: 'posted',
      journalEntryId: result.journalEntryId,
      postedBy: ctx.principal.userId,
      postedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(logisticsJobCost.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'logistics_job_cost.posted',
    objectType: COST_TYPE,
    objectId: id,
    branchCode: cost.branchCode,
    after: { costNo: cost.costNo, jobNo: job.jobNo, journalEntryId: result.journalEntryId },
    outcome: 'success',
  });

  return { journalEntryId: result.journalEntryId };
}

// ---------------------------------------------------------------------------
// 10.7 Delivery evidence and claims
// ---------------------------------------------------------------------------

export async function recordDeliveryEvidence(
  tx: Tx,
  ctx: ActorContext,
  input: {
    readonly jobId: string;
    readonly evidenceType: string;
    readonly attachmentId: string;
    readonly receivedOn: string;
    readonly note?: string | null;
  },
): Promise<{ id: string }> {
  const job = await loadJob(tx, input.jobId);

  await authz.authorize(ctx.principal, 'create', 'logistics_delivery_evidence', {
    branchCode: job.branchCode,
  });

  const [created] = await tx
    .insert(logisticsDeliveryEvidence)
    .values({
      jobId: input.jobId,
      evidenceType: input.evidenceType,
      attachmentId: input.attachmentId,
      receivedOn: input.receivedOn,
      note: input.note ?? null,
      recordedBy: ctx.principal.userId,
    })
    .returning({ id: logisticsDeliveryEvidence.id });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'logistics_delivery_evidence.recorded',
    objectType: 'logistics_delivery_evidence',
    objectId: created!.id,
    branchCode: job.branchCode,
    after: { jobNo: job.jobNo, evidenceType: input.evidenceType },
    outcome: 'success',
  });

  return { id: created!.id };
}

export async function raiseClaim(
  tx: Tx,
  ctx: ActorContext,
  input: {
    readonly jobId: string;
    readonly legId?: string | null;
    readonly claimType: string;
    readonly raisedOn: string;
    readonly description: string;
    readonly estimatedAmountIqd?: bigint | null;
  },
): Promise<{ id: string; claimNo: string }> {
  const job = await loadJob(tx, input.jobId);

  await authz.authorize(ctx.principal, 'create', CLAIM_TYPE, { branchCode: job.branchCode });

  const allocated = await allocateDocumentNumber(
    tx,
    'LOGISTICS_CLAIM',
    { branchCode: job.branchCode, year: Number(input.raisedOn.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(logisticsClaim)
    .values({
      claimNo: allocated.documentNo,
      jobId: input.jobId,
      legId: input.legId ?? null,
      claimType: input.claimType,
      raisedOn: input.raisedOn,
      description: input.description,
      estimatedAmount:
        input.estimatedAmountIqd == null ? null : money(input.estimatedAmountIqd),
      currencyCode: input.estimatedAmountIqd == null ? null : job.currencyCode,
      raisedBy: ctx.principal.userId,
    })
    .returning({ id: logisticsClaim.id });

  return { id: created!.id, claimNo: allocated.documentNo };
}

export async function resolveClaim(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  outcome: { readonly status: 'resolved' | 'rejected'; readonly resolution: string },
): Promise<void> {
  const [claim] = await tx.select().from(logisticsClaim).where(eq(logisticsClaim.id, id)).limit(1);
  if (!claim) throw new LogisticsNotFoundError('claim', id);

  const job = await loadJob(tx, claim.jobId);
  await authz.authorize(ctx.principal, 'approve', CLAIM_TYPE, { branchCode: job.branchCode });

  if (outcome.resolution.trim().length === 0) {
    throw new Error('Closing a claim needs its reason recorded (§5.4).');
  }

  await tx
    .update(logisticsClaim)
    .set({
      status: outcome.status,
      resolution: outcome.resolution.trim(),
      resolvedBy: ctx.principal.userId,
      resolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(logisticsClaim.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: `logistics_claim.${outcome.status}`,
    objectType: CLAIM_TYPE,
    objectId: id,
    branchCode: job.branchCode,
    before: { status: claim.status },
    after: { status: outcome.status },
    reason: outcome.resolution.trim(),
    outcome: 'success',
  });
}

/** 10.7 — what a job still has to prove before it may settle. */
export async function evidenceGap(tx: Tx, jobId: string): Promise<string[]> {
  const job = await loadJob(tx, jobId);

  const required = await tx
    .select({ type: logisticsServiceTypeEvidence.evidenceType })
    .from(logisticsServiceTypeEvidence)
    .where(eq(logisticsServiceTypeEvidence.serviceTypeCode, job.serviceTypeCode));

  const held = await tx
    .select({ type: logisticsDeliveryEvidence.evidenceType })
    .from(logisticsDeliveryEvidence)
    .where(eq(logisticsDeliveryEvidence.jobId, jobId));

  return missingEvidence(
    required.map((r) => r.type),
    held.map((h) => h.type),
  );
}

// ---------------------------------------------------------------------------
// 10.8 Settlement, billing and close
// ---------------------------------------------------------------------------

/**
 * Raises the settlement for everything the client has been charged and not yet
 * billed.
 *
 * The recognised amount is not an input. It is the sum of the unbilled charges,
 * because §11.4 recognises *the service* — allowing a caller to name a different
 * figure would let the revenue posted diverge from what the client was told they
 * owed, and 10.8's "job margin reconciles to the G/L" would be untestable.
 */
export async function createSettlement(
  tx: Tx,
  ctx: ActorContext,
  input: { readonly jobId: string; readonly settlementDate: string; readonly note?: string | null },
): Promise<{ id: string; settlementNo: string; recognisedIqd: bigint }> {
  const job = await loadJob(tx, input.jobId);

  await authz.authorize(ctx.principal, 'create', SETTLEMENT_TYPE, {
    branchCode: job.branchCode,
  });

  const gap = await evidenceGap(tx, input.jobId);
  if (gap.length > 0) {
    throw new MissingDeliveryEvidenceError(job.jobNo, job.serviceTypeCode, gap);
  }

  const unbilled = await tx
    .select()
    .from(logisticsClientCharge)
    .where(
      and(
        eq(logisticsClientCharge.jobId, input.jobId),
        isNull(logisticsClientCharge.settlementId),
      ),
    )
    .orderBy(logisticsClientCharge.lineNo);

  if (unbilled.length === 0) throw new NothingToSettleError(job.jobNo);

  const recognised = unbilled.reduce((total, line) => total + amount(line.amount), 0n);
  const funded = await fundedBalance(tx, input.jobId);
  const split = splitRecognition(funded, recognised);

  const allocated = await allocateDocumentNumber(
    tx,
    'LOGISTICS_JOB_SETTLEMENT',
    { branchCode: job.branchCode, year: Number(input.settlementDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(logisticsJobSettlement)
    .values({
      settlementNo: allocated.documentNo,
      jobId: input.jobId,
      branchCode: job.branchCode,
      settlementDate: input.settlementDate,
      recognisedAmount: money(recognised),
      fromClearingAmount: money(split.fromClearingIqd),
      fromReceivableAmount: money(split.fromReceivableIqd),
      currencyCode: job.currencyCode,
      note: input.note ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: logisticsJobSettlement.id });

  // The charges are marked as billed here, not at posting: they are what this
  // settlement covers, and a second settlement raised in the meantime must not
  // be able to claim them as well.
  await tx
    .update(logisticsClientCharge)
    .set({ settlementId: created!.id })
    .where(
      inArray(
        logisticsClientCharge.id,
        unbilled.map((line) => line.id),
      ),
    );

  return { id: created!.id, settlementNo: allocated.documentNo, recognisedIqd: recognised };
}

/**
 * §11.4, third row — *Dr Client Logistics Clearing / Client A/R, Cr Logistics
 * Revenue.*
 *
 * Appendix C: *"Logistics service recognition … Separate from Money Transfer
 * margin."* The credit is the single role `logistics_revenue`, which §3.3's
 * mapping resolves to a logistics revenue account; no money transfer event names
 * that role, and every line carries `business_line = LOGISTICS`, so the two
 * services stay apart in the G/L as well as in the module.
 *
 * The clearing debit is split across the roles the fundings actually credited
 * (see `allocateAcrossFundings`), so a job funded at two different stages leaves
 * neither clearing account holding a residue.
 */
export async function postSettlement(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ journalEntryId: string }> {
  const [settlement] = await tx
    .select()
    .from(logisticsJobSettlement)
    .where(eq(logisticsJobSettlement.id, id))
    .limit(1);
  if (!settlement) throw new LogisticsNotFoundError('settlement', id);

  await authz.authorize(ctx.principal, 'post', SETTLEMENT_TYPE, {
    branchCode: settlement.branchCode,
  });

  if (settlement.status !== 'draft') {
    throw new LogisticsStateError(
      settlement.settlementNo,
      settlement.status,
      'only a draft settlement can be posted.',
    );
  }

  const job = await loadJob(tx, settlement.jobId);
  const client = await partnerCode(tx, job.clientId);

  const fromClearing = amount(settlement.fromClearingAmount);
  const fromReceivable = amount(settlement.fromReceivableAmount);
  const recognised = amount(settlement.recognisedAmount);

  const criteria = { branchCode: settlement.branchCode };
  const dimensions = {
    branch: settlement.branchCode,
    business_line: BUSINESS_LINE,
    business_partner: client,
  };

  const lines: PostingLineRequest[] = [];

  if (fromClearing > 0n) {
    const fundings = await tx
      .select()
      .from(logisticsClientFunding)
      .where(
        and(
          eq(logisticsClientFunding.jobId, settlement.jobId),
          eq(logisticsClientFunding.status, 'posted'),
        ),
      );

    const held = fundings.map((funding) => ({
      id: funding.id,
      clearingRole: funding.clearingRole!,
      amountIqd: amount(funding.amount),
      fundingDate: funding.fundingDate,
    }));

    for (const debit of allocateAcrossFundings(held, fromClearing)) {
      lines.push({
        role: debit.role,
        debit: money(debit.amountIqd),
        criteria,
        dimensions,
        description: `Discharges ${debit.fundingIds.length} client funding(s)`,
      });
    }
  }

  if (fromReceivable > 0n) {
    lines.push({
      role: 'client_receivable',
      debit: money(fromReceivable),
      criteria,
      dimensions,
      description: 'Billed to the client — unfunded balance of the service charge',
    });
  }

  lines.push({
    role: 'logistics_revenue',
    credit: money(recognised),
    criteria,
    dimensions,
  });

  const result = await posting.post(tx, ctx, {
    eventType: 'logistics.job_settlement',
    documentTypeCode: SETTLEMENT_TYPE,
    source: { module: MODULE, documentId: id, event: 'posted' },
    branchCode: settlement.branchCode,
    documentDate: settlement.settlementDate,
    postingDate: settlement.settlementDate,
    currency: settlement.currencyCode,
    description: `Logistics settlement ${settlement.settlementNo} — job ${job.jobNo}`,
    lines,
  });

  await statuses.assertTransitionAllowed(tx, SETTLEMENT_TYPE, settlement.status, 'posted');

  await tx
    .update(logisticsJobSettlement)
    .set({
      status: 'posted',
      journalEntryId: result.journalEntryId,
      postedBy: ctx.principal.userId,
      postedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(logisticsJobSettlement.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'logistics_job_settlement.posted',
    objectType: SETTLEMENT_TYPE,
    objectId: id,
    branchCode: settlement.branchCode,
    after: {
      settlementNo: settlement.settlementNo,
      jobNo: job.jobNo,
      recognised: settlement.recognisedAmount,
      fromClearing: settlement.fromClearingAmount,
      fromReceivable: settlement.fromReceivableAmount,
      journalEntryId: result.journalEntryId,
    },
    outcome: 'success',
  });

  return { journalEntryId: result.journalEntryId };
}

// ---------------------------------------------------------------------------
// Positions the close and the reports both read
// ---------------------------------------------------------------------------

/** Client money held against a job — posted fundings only (§11.4). */
export async function fundedBalance(tx: Tx, jobId: string): Promise<bigint> {
  const rows = await tx
    .select({ amount: logisticsClientFunding.amount })
    .from(logisticsClientFunding)
    .where(
      and(eq(logisticsClientFunding.jobId, jobId), eq(logisticsClientFunding.status, 'posted')),
    );

  return rows.reduce((total, row) => total + amount(row.amount), 0n);
}

/**
 * The five questions the close asks, in the shape `closeBlockers` wants.
 *
 * Read here and judged in the domain, so the sentences a clerk sees and the
 * refusal the database issues are computed from the same numbers.
 */
export async function closePosition(tx: Tx, jobId: string) {
  const [unbilled] = await tx
    .select({ total: sql<string>`coalesce(sum(${logisticsClientCharge.amount}), 0)::text` })
    .from(logisticsClientCharge)
    .where(
      and(eq(logisticsClientCharge.jobId, jobId), isNull(logisticsClientCharge.settlementId)),
    );

  const [draftCosts] = await tx
    .select({ total: sql<string>`coalesce(sum(${logisticsJobCost.amount}), 0)::text` })
    .from(logisticsJobCost)
    .where(and(eq(logisticsJobCost.jobId, jobId), eq(logisticsJobCost.status, 'draft')));

  const [recognised] = await tx
    .select({
      total: sql<string>`coalesce(sum(${logisticsJobSettlement.recognisedAmount}), 0)::text`,
    })
    .from(logisticsJobSettlement)
    .where(
      and(eq(logisticsJobSettlement.jobId, jobId), eq(logisticsJobSettlement.status, 'posted')),
    );

  const [openLegs] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(logisticsJobLeg)
    .where(
      and(
        eq(logisticsJobLeg.jobId, jobId),
        sql`${logisticsJobLeg.status} not in ('completed', 'cancelled')`,
      ),
    );

  const [openClaims] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(logisticsClaim)
    .where(
      and(
        eq(logisticsClaim.jobId, jobId),
        sql`${logisticsClaim.status} in ('open', 'under_review')`,
      ),
    );

  return {
    unbilledChargeIqd: amount(unbilled!.total),
    unsettledCostIqd: amount(draftCosts!.total),
    openClientBalanceIqd: (await fundedBalance(tx, jobId)) - amount(recognised!.total),
    openLegCount: openLegs!.count,
    openClaimCount: openClaims!.count,
  };
}

/**
 * §11.3's job margin, from the documents rather than from a stored total.
 *
 * Posted figures only. A draft cost is not yet in the G/L, and a margin that
 * counted it would disagree with the ledger — which is exactly what 10.8's gate
 * measures.
 */
export async function marginFor(tx: Tx, jobId: string) {
  const [charged] = await tx
    .select({
      total: sql<string>`coalesce(sum(${logisticsJobSettlement.recognisedAmount}), 0)::text`,
    })
    .from(logisticsJobSettlement)
    .where(
      and(eq(logisticsJobSettlement.jobId, jobId), eq(logisticsJobSettlement.status, 'posted')),
    );

  const [costs] = await tx
    .select({ total: sql<string>`coalesce(sum(${logisticsJobCost.amount}), 0)::text` })
    .from(logisticsJobCost)
    .where(and(eq(logisticsJobCost.jobId, jobId), eq(logisticsJobCost.status, 'posted')));

  return jobMargin({
    serviceChargeIqd: amount(charged!.total),
    directCostIqd: amount(costs!.total),
  });
}

async function partnerCode(tx: Tx, id: string): Promise<string> {
  const [partner] = await tx
    .select({ code: businessPartner.code })
    .from(businessPartner)
    .where(eq(businessPartner.id, id))
    .limit(1);
  if (!partner) throw new LogisticsNotFoundError('business partner', id);
  return partner.code;
}

export async function viewJob(tx: Tx, id: string) {
  const job = await loadJob(tx, id);
  const legs = await tx
    .select()
    .from(logisticsJobLeg)
    .where(eq(logisticsJobLeg.jobId, id))
    .orderBy(logisticsJobLeg.legNo);
  const charges = await tx
    .select()
    .from(logisticsClientCharge)
    .where(eq(logisticsClientCharge.jobId, id))
    .orderBy(logisticsClientCharge.lineNo);

  return { job, legs, charges };
}
