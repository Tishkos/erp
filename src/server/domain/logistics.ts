/**
 * Logistics Operations — Phase 10 pure logic, §11.
 *
 * §11: *"Logistics is a separate revenue service. It manages customer import and
 * shipping service jobs, direct third-party expenses and the separate logistics
 * margin. A logistics job can be linked to the same client import file as a Money
 * Transfer transaction without combining their accounting results."*
 *
 * Everything here is arithmetic and rule-checking over values a caller already
 * holds: no database, no I/O, no imports from `services/`. The service layer
 * decides *when* to ask these questions; this module decides what the answer is,
 * and the migrations make the wrong answers unrepresentable.
 *
 * ── Why the separation from Money Transfer is mostly *not* here ──────────────
 * §2.2, §11.3 and §12.4 each state that Logistics and Money Transfer are
 * separate services with separate revenue, expenses and margin. The strongest
 * form of that guarantee is structural — a cross-reference row with no amount
 * column cannot combine two P&Ls — so it lives in the schema, not in a function
 * anyone could forget to call. What lives here is the margin definition itself
 * (§11.3: *"direct logistics expenses are allocated to the job and deducted from
 * the logistics service charge to determine job margin"*), stated once so that
 * no report can compute it a second way.
 */

import { MONEY_SCALE, toDecimalString } from './money';

// ---------------------------------------------------------------------------
// The job lifecycle — Appendix B
// ---------------------------------------------------------------------------

/**
 * Appendix B, Logistics Job: *"Draft, Approved, In Progress, Delivered, Settled,
 * Closed, Cancelled"*.
 *
 * Mapped onto §3.2's shared `document_status` vocabulary, the same set every
 * other module's documents use:
 *
 *   Draft       → draft
 *   Approved    → approved
 *   In Progress → partially_executed
 *   Delivered   → executed
 *   Settled     → settled
 *   Closed      → closed
 *   Cancelled   → cancelled
 *
 * Note what Appendix B does **not** give this document: a *Pending Approval*
 * state. Purchase Order, Goods Receipt and A/P Invoice each have one and the
 * Logistics Job does not, so approval here is a permission exercised on a draft
 * (§5.2's `approve` verb) rather than a state the document rests in. Adding a
 * submitted state would invent a control the blueprint did not ask for, and
 * §3.2 makes each document type's status list exhaustive.
 */
export const LOGISTICS_JOB_STATUSES = [
  'draft',
  'approved',
  'partially_executed',
  'executed',
  'settled',
  'closed',
] as const;

export type LogisticsJobStatus = (typeof LOGISTICS_JOB_STATUSES)[number] | 'cancelled';

/** Appendix B's order, as positions, so "skips a step" becomes a comparison. */
const STAGE_OF: Readonly<Record<string, number>> = Object.fromEntries(
  LOGISTICS_JOB_STATUSES.map((status, index) => [status, index]),
);

/** The Appendix B label, so messages read the way the menu does. */
export const JOB_STATUS_LABEL: Readonly<Record<LogisticsJobStatus, string>> = {
  draft: 'Draft',
  approved: 'Approved',
  partially_executed: 'In Progress',
  executed: 'Delivered',
  settled: 'Settled',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

export class JobStatusSkipError extends Error {
  readonly code = 'LOGISTICS_JOB_STATUS_SKIP';
  constructor(
    readonly jobNo: string,
    readonly from: LogisticsJobStatus,
    readonly to: LogisticsJobStatus,
  ) {
    super(
      `Logistics job ${jobNo} is '${JOB_STATUS_LABEL[from]}' and cannot move straight to ` +
        `'${JOB_STATUS_LABEL[to]}' (Appendix B). The workflow is ` +
        `${LOGISTICS_JOB_STATUSES.map((s) => JOB_STATUS_LABEL[s]).join(' → ')}; ` +
        'take the next step, or cancel the job.',
    );
    this.name = 'JobStatusSkipError';
  }
}

/**
 * Is this move one step forward, or a cancellation the blueprint allows?
 *
 * Forward only, one stage at a time. §11.2's workflow is a sequence of things
 * that physically happen — a carrier is engaged, goods are delivered, the client
 * settles — so a job that reached 'Delivered' without ever being 'In Progress'
 * is a record of an event nobody observed.
 *
 * **Cancellation is deliberately narrow.** Appendix B lists Cancelled without
 * saying which states reach it. A job carrying recorded third-party costs or
 * client funding has real money against it, and what becomes of that money on
 * cancellation — refund, write-off, retention of a fee — is an accounting
 * outcome §28.1 reserves to the Business Process Owner. So cancellation is
 * allowed only from Draft and Approved, where by construction nothing has
 * posted, and the wider question is recorded rather than answered here. See
 * docs/open-questions-phase-10.md, Q10-3.
 */
export function isAllowedJobTransition(
  from: LogisticsJobStatus,
  to: LogisticsJobStatus,
): boolean {
  if (from === to) return false;
  if (from === 'cancelled' || from === 'closed') return false;

  if (to === 'cancelled') return from === 'draft' || from === 'approved';
  if (to === 'draft') return false;

  const fromStage = STAGE_OF[from];
  const toStage = STAGE_OF[to];
  if (fromStage === undefined || toStage === undefined) return false;

  return toStage === fromStage + 1;
}

export function assertJobTransition(
  jobNo: string,
  from: LogisticsJobStatus,
  to: LogisticsJobStatus,
): void {
  if (!isAllowedJobTransition(from, to)) {
    throw new JobStatusSkipError(jobNo, from, to);
  }
}

// ---------------------------------------------------------------------------
// Job margin — §11.3
// ---------------------------------------------------------------------------

/**
 * The figures a margin is computed from, in scaled IQD (`MONEY_SCALE`).
 *
 * `serviceChargeIqd` is what the client is charged for the service.
 * `directCostIqd` is the third-party expense allocated to the job. Nothing else
 * belongs here: §11.3 says *"The company does not absorb logistics costs"*, and
 * the mirror of that is that the company does not load unallocated overhead onto
 * a job either.
 */
export interface JobMarginInput {
  readonly serviceChargeIqd: bigint;
  readonly directCostIqd: bigint;
}

export interface JobMargin {
  readonly serviceChargeIqd: bigint;
  readonly directCostIqd: bigint;
  readonly marginIqd: bigint;
  /** Basis points of the service charge, or null when nothing was charged. */
  readonly marginBasisPoints: number | null;
}

/**
 * §11.3 — *"direct logistics expenses are allocated to the job and deducted from
 * the logistics service charge to determine job margin"*.
 *
 * One definition, used by the settlement document, the margin report and the
 * G/L reconciliation alike. A second implementation anywhere would eventually
 * disagree with this one, and the report that disagreed would be believed.
 */
export function jobMargin(input: JobMarginInput): JobMargin {
  const marginIqd = input.serviceChargeIqd - input.directCostIqd;

  return {
    serviceChargeIqd: input.serviceChargeIqd,
    directCostIqd: input.directCostIqd,
    marginIqd,
    marginBasisPoints:
      input.serviceChargeIqd === 0n
        ? null
        : Number((marginIqd * 10_000n) / input.serviceChargeIqd),
  };
}

// ---------------------------------------------------------------------------
// Recognition — §11.4
// ---------------------------------------------------------------------------

export interface RecognitionSplit {
  /** Discharged against money the client already put in. */
  readonly fromClearingIqd: bigint;
  /** Billed to the client — the balance they still owe. */
  readonly fromReceivableIqd: bigint;
}

/**
 * §11.4's recognition row: *"Service completion and recognition | Client
 * Logistics Clearing / Client A/R | Logistics Revenue"* — two possible debits,
 * and the blueprint does not say how a part-funded job divides between them.
 *
 * Funded first. Not a preference: Client Logistics Clearing holds money the
 * client has actually paid, and debiting more of it than was credited would put
 * a liability clearing account into debit — an unfunded balance dressed up as
 * money the company is holding. The only division that keeps the clearing
 * account meaning what it says is *"discharge what was funded, bill the rest"*.
 *
 * Recorded as Q10-2 in docs/open-questions-phase-10.md for the Business Process
 * Owner to confirm, because it remains an accounting outcome (§28.1) even where
 * the arithmetic leaves one sensible answer.
 */
export function splitRecognition(
  fundedBalanceIqd: bigint,
  recognisedIqd: bigint,
): RecognitionSplit {
  if (recognisedIqd < 0n) {
    throw new RangeError(
      'A negative recognition is a credit note, not a recognition (§11.4). Reverse the settlement instead.',
    );
  }

  const available = fundedBalanceIqd > 0n ? fundedBalanceIqd : 0n;
  const fromClearingIqd = available < recognisedIqd ? available : recognisedIqd;

  return {
    fromClearingIqd,
    fromReceivableIqd: recognisedIqd - fromClearingIqd,
  };
}

/** One posted funding, as the settlement sees it. */
export interface FundingHeld {
  readonly id: string;
  /** The line role its credit went to, copied from the stage mapping. */
  readonly clearingRole: string;
  readonly amountIqd: bigint;
  /** ISO date. Oldest is discharged first. */
  readonly fundingDate: string;
}

export interface ClearingDebit {
  readonly role: string;
  readonly amountIqd: bigint;
  readonly fundingIds: readonly string[];
}

/**
 * Which clearing roles the settlement debits, and for how much.
 *
 * §11.4 lets funding credit either Client Logistics Clearing or Deferred Service
 * Balance "according to document stage", so a job funded twice at two stages has
 * money sitting in *two* accounts. The recognition must take it back out of the
 * ones it actually went into — debiting a single nominal clearing account would
 * leave a permanent balance in the other, and the §11.5 Client Balances report
 * would show money owing on a job that had been settled in full.
 *
 * Oldest funding first, so the allocation is deterministic and reproducible: a
 * settlement recomputed after a crash must produce the same journal, which §24's
 * deterministic source reference depends on.
 */
export function allocateAcrossFundings(
  fundings: readonly FundingHeld[],
  amountIqd: bigint,
): ClearingDebit[] {
  if (amountIqd < 0n) {
    throw new RangeError('A settlement discharges a positive amount of funding, or none.');
  }

  const ordered = [...fundings].sort((a, b) =>
    a.fundingDate === b.fundingDate ? a.id.localeCompare(b.id) : a.fundingDate < b.fundingDate ? -1 : 1,
  );

  const byRole = new Map<string, { amountIqd: bigint; fundingIds: string[] }>();
  let remaining = amountIqd;

  for (const funding of ordered) {
    if (remaining === 0n) break;
    const take = funding.amountIqd < remaining ? funding.amountIqd : remaining;
    if (take <= 0n) continue;

    const bucket = byRole.get(funding.clearingRole) ?? { amountIqd: 0n, fundingIds: [] };
    bucket.amountIqd += take;
    bucket.fundingIds.push(funding.id);
    byRole.set(funding.clearingRole, bucket);

    remaining -= take;
  }

  if (remaining !== 0n) {
    throw new RangeError(
      `The fundings held cover ${toDecimalString(amountIqd - remaining, MONEY_SCALE)} of the ` +
        `${toDecimalString(amountIqd, MONEY_SCALE)} being discharged. ` +
        'splitRecognition should have capped this at the funded balance — the caller has passed a figure it did not derive.',
    );
  }

  // Sorted, so the journal's line order is the same every time it is built.
  return [...byRole.entries()]
    .map(([role, bucket]) => ({ role, amountIqd: bucket.amountIqd, fundingIds: bucket.fundingIds }))
    .sort((a, b) => a.role.localeCompare(b.role));
}

// ---------------------------------------------------------------------------
// Delivery evidence — 10.7
// ---------------------------------------------------------------------------

/**
 * Which required evidence types a job is still missing.
 *
 * The required set is configuration on the service type, not a constant: an
 * air-freight job and a customs-clearance job do not prove delivery the same
 * way, and §11.2 puts "Delivery Evidence" before "Client Settlement / Billing"
 * without saying what counts as evidence for which service.
 */
export function missingEvidence(
  required: readonly string[],
  present: readonly string[],
): string[] {
  const held = new Set(present);
  return [...new Set(required)].filter((type) => !held.has(type)).sort();
}

// ---------------------------------------------------------------------------
// Close eligibility — 10.2 and 10.8
// ---------------------------------------------------------------------------

export interface CloseCheckInput {
  readonly jobNo: string;
  /** Charges agreed with the client but never carried into a settlement. */
  readonly unbilledChargeIqd: bigint;
  /** Third-party costs recorded but not yet posted. */
  readonly unsettledCostIqd: bigint;
  /** What the client still owes, or has overpaid, after settlement. */
  readonly openClientBalanceIqd: bigint;
  /** Legs the carrier has not reported as complete. */
  readonly openLegCount: number;
  /** Claims still under investigation (10.7). */
  readonly openClaimCount: number;
}

const money = (value: bigint) => toDecimalString(value, MONEY_SCALE);

/**
 * Every reason this job may not close, as sentences.
 *
 * A list rather than one throw at a time, so a clerk sees the whole job's worth
 * of remaining work at once instead of discovering it a rejection at a time. The
 * database refuses the close as well; this exists so the refusal can explain
 * itself.
 */
export function closeBlockers(input: CloseCheckInput): string[] {
  const blockers: string[] = [];

  if (input.unbilledChargeIqd !== 0n) {
    blockers.push(
      `${money(input.unbilledChargeIqd)} IQD of client charges has not been billed. ` +
        'A job that closes over an unbilled charge writes off revenue nobody decided to forgo (§11.4).',
    );
  }

  if (input.unsettledCostIqd !== 0n) {
    blockers.push(
      `${money(input.unsettledCostIqd)} IQD of third-party cost is recorded but not posted. ` +
        'Closing now would leave the cost out of the job margin the G/L reports (§11.3).',
    );
  }

  if (input.openClientBalanceIqd !== 0n) {
    blockers.push(
      `The client balance on this job is ${money(input.openClientBalanceIqd)} IQD, not zero. ` +
        'Settle or refund it — a closed job with a live balance is a balance nobody owns (§11.4).',
    );
  }

  if (input.openLegCount > 0) {
    blockers.push(
      `${input.openLegCount} route leg(s) are still open. ` +
        'Carrier payables are measured per leg, so an open leg is a cost that has not landed yet (§11.5).',
    );
  }

  if (input.openClaimCount > 0) {
    blockers.push(
      `${input.openClaimCount} claim(s) are still open. ` +
        'A claim is a delivery exception with money attached; resolve it before the job closes (§11.5).',
    );
  }

  return blockers;
}

export class JobNotCloseableError extends Error {
  readonly code = 'LOGISTICS_JOB_NOT_CLOSEABLE';
  constructor(
    readonly jobNo: string,
    readonly blockers: readonly string[],
  ) {
    super(
      `Logistics job ${jobNo} cannot be closed yet:\n` +
        blockers.map((reason) => `  · ${reason}`).join('\n'),
    );
    this.name = 'JobNotCloseableError';
  }
}

export function assertCloseable(input: CloseCheckInput): void {
  const blockers = closeBlockers(input);
  if (blockers.length > 0) throw new JobNotCloseableError(input.jobNo, blockers);
}

// ---------------------------------------------------------------------------
// Carrier performance — 10.3
// ---------------------------------------------------------------------------

export interface LegPerformance {
  readonly plannedArrival: string | null;
  readonly actualArrival: string | null;
}

export interface CarrierPerformance {
  readonly legs: number;
  readonly delivered: number;
  readonly onTime: number;
  readonly late: number;
  /** Null until at least one leg has both a plan and an outcome to compare. */
  readonly onTimeBasisPoints: number | null;
}

/**
 * Carrier performance for the Appendix D report (§11.5) and the Logistics
 * Dashboard's proof-of-delivery exceptions.
 *
 * Business dates are ISO strings throughout this codebase, never JS `Date`, so
 * the comparison is a string comparison — correct for `YYYY-MM-DD` and carrying
 * no timezone with it. A `Date` here would make "arrived on time" depend on the
 * server's offset.
 *
 * A leg with no planned arrival counts as delivered but is not scored: a carrier
 * cannot be late against a date nobody agreed.
 */
export function carrierPerformance(legs: readonly LegPerformance[]): CarrierPerformance {
  let delivered = 0;
  let onTime = 0;
  let late = 0;

  for (const leg of legs) {
    if (!leg.actualArrival) continue;
    delivered += 1;
    if (!leg.plannedArrival) continue;
    if (leg.actualArrival <= leg.plannedArrival) onTime += 1;
    else late += 1;
  }

  const scored = onTime + late;

  return {
    legs: legs.length,
    delivered,
    onTime,
    late,
    onTimeBasisPoints: scored === 0 ? null : Math.round((onTime * 10_000) / scored),
  };
}
