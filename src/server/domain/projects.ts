/**
 * Projects and contracting — Phase 11, §10 and §19.
 *
 * > §10: *"Budget checks distinguish budget, committed, actual, forecast and
 * > available amounts."*
 * > §10: *"Retention and advances are separate balances, not ordinary revenue or
 * > expense."*
 * > §10: *"Change orders are versioned … update contract value, budget and
 * > forecast while **preserving baseline**."*
 * > §10: *"Project closure is blocked by open purchase orders, unreturned stock,
 * > unbilled costs, unapproved variations or unresolved advances/retention."*
 *
 * **What is deliberately absent: revenue recognition.** §10 requires Finance to
 * approve the recognition and cost-recognition policy before progress billing
 * and WIP are developed, and forbids IT from inventing the treatment. D1 is
 * open, so there is no default here — not even a percentage-of-completion one
 * "to be changed later", which is exactly the shape of the mistake §28 is
 * written to prevent: it would silently produce wrong financial statements for
 * as long as nobody revisited it.
 *
 * Pure. Money is scaled at 10^4; percentages at 10^4.
 */
import { toDecimalString } from './money';

// ---------------------------------------------------------------------------
// Work breakdown structure — §10
// ---------------------------------------------------------------------------

export class WbsCycleError extends Error {
  readonly code = 'WBS_CYCLE';
  constructor(readonly path: readonly string[]) {
    super(
      `That parent would make a cycle: ${path.join(' → ')}. ` +
        'A work breakdown structure is a tree — an element cannot be part of its own work, and a ' +
        'cycle would make every roll-up of cost or progress run forever.',
    );
    this.name = 'WbsCycleError';
  }
}

/**
 * §10 — a WBS is a hierarchy, and a hierarchy has no cycles.
 *
 * Checked by walking up from the proposed parent: if the element being moved
 * appears on the way to the root, the move would close a loop. The same shape
 * §4.1's department hierarchy uses, and for the same reason — a roll-up over a
 * cycle does not terminate.
 */
export function assertNoWbsCycle(
  elementCode: string,
  parentCode: string | null,
  parentOf: ReadonlyMap<string, string | null>,
): void {
  if (parentCode === null) return;
  if (parentCode === elementCode) throw new WbsCycleError([elementCode, elementCode]);

  const path = [elementCode];
  let cursor: string | null = parentCode;
  const seen = new Set<string>();

  while (cursor !== null) {
    path.push(cursor);
    if (cursor === elementCode) throw new WbsCycleError(path);
    if (seen.has(cursor)) return; // A pre-existing cycle is not this move's fault.
    seen.add(cursor);
    cursor = parentOf.get(cursor) ?? null;
  }
}

// ---------------------------------------------------------------------------
// The five budget amounts — §10, §19
// ---------------------------------------------------------------------------

export interface BudgetAmounts {
  /** The approved baseline for this line. */
  readonly budgetIqd: bigint;
  /** Approved variations, positive or negative. */
  readonly revisionsIqd: bigint;
  /** §19 — approved purchase orders and contracts not yet received. */
  readonly committedIqd: bigint;
  /** What has actually been posted against it. */
  readonly actualIqd: bigint;
  /** What the project manager expects the final figure to be. */
  readonly forecastIqd: bigint;
}

export interface BudgetPosition extends BudgetAmounts {
  /** The revised budget: baseline plus approved variations. */
  readonly revisedIqd: bigint;
  /** §10 — what is left to spend. */
  readonly availableIqd: bigint;
}

/**
 * §10 — *"budget checks distinguish budget, committed, actual, forecast and
 * available amounts."*
 *
 * ```text
 *   available = budget + approved revisions − commitments − actuals
 * ```
 *
 * Forecast is deliberately **not** in that arithmetic. A forecast is somebody's
 * opinion about the end of the job; availability is a fact about what has been
 * spent and promised. Netting the opinion into the fact would let an optimistic
 * forecast create spending room that does not exist — and §19's whole point is
 * that a commitment reduces availability the moment it is approved.
 */
export function budgetPosition(amounts: BudgetAmounts): BudgetPosition {
  const revisedIqd = amounts.budgetIqd + amounts.revisionsIqd;
  return {
    ...amounts,
    revisedIqd,
    availableIqd: revisedIqd - amounts.committedIqd - amounts.actualIqd,
  };
}

export class BudgetExceededError extends Error {
  readonly code = 'BUDGET_EXCEEDED';
  constructor(
    readonly costCode: string,
    readonly availableIqd: bigint,
    readonly requestedIqd: bigint,
  ) {
    super(
      `${costCode} has ${toDecimalString(availableIqd, 4n)} available and this needs ` +
        `${toDecimalString(requestedIqd, 4n)} (§10, §19). ` +
        'Raise a variation to increase the budget, or move the cost to a code that has room — ' +
        'either way somebody decides, rather than the overspend being discovered at the close.',
    );
    this.name = 'BudgetExceededError';
  }
}

/**
 * §10 — *"no project spending without an active project and valid budget/cost
 * code where required."*
 *
 * Whether a code is *required* is configuration per project: a small internal
 * job may not carry a budget at all, and refusing every unbudgeted cost would
 * make the module unusable for those. What is not configurable is the arithmetic
 * once a budget exists.
 */
export function assertWithinBudget(
  costCode: string,
  position: BudgetPosition,
  requestedIqd: bigint,
): void {
  if (requestedIqd > position.availableIqd) {
    throw new BudgetExceededError(costCode, position.availableIqd, requestedIqd);
  }
}

// ---------------------------------------------------------------------------
// Progress and certificates — §10
// ---------------------------------------------------------------------------

export class ProgressExceededError extends Error {
  readonly code = 'PROGRESS_EXCEEDED';
  constructor(
    readonly measuredPercent: bigint,
    readonly certifiedPercent: bigint,
  ) {
    super(
      `The certificate claims ${toDecimalString(certifiedPercent, 4n)}% against ` +
        `${toDecimalString(measuredPercent, 4n)}% of approved measured progress (§10). ` +
        'A certificate is the customer being asked to pay for work somebody measured; certifying ' +
        'beyond the measurement bills for work nobody has said was done.',
    );
    this.name = 'ProgressExceededError';
  }
}

/** §10 — *"a client certificate cannot exceed approved measured progress."* */
export function assertWithinMeasuredProgress(
  measuredPercent: bigint,
  certifiedPercent: bigint,
): void {
  if (certifiedPercent > measuredPercent) {
    throw new ProgressExceededError(measuredPercent, certifiedPercent);
  }
}

// ---------------------------------------------------------------------------
// Progress billing: retention and advances — §10
// ---------------------------------------------------------------------------

export interface BillingTerms {
  /** Withheld from each certificate until release. Scaled 10^4, so 5% is 50000. */
  readonly retentionPercent: bigint;
  /** Recovered from each certificate against the advance already paid. */
  readonly advanceRecoveryPercent: bigint;
}

export interface ProgressBill {
  /** What the certificate says the work is worth. */
  readonly grossIqd: bigint;
  /** §10 — held back, and held as its own balance. */
  readonly retentionIqd: bigint;
  /** §10 — taken back against the advance, and never more than remains of it. */
  readonly advanceRecoveredIqd: bigint;
  /** What the customer is actually asked to pay now. */
  readonly netIqd: bigint;
}

/**
 * §10 acceptance criterion 4 — *"progress billing correctly calculates advance
 * recovery and retention where configured."*
 *
 * Three figures out of one certificate, and none of them is revenue. Retention
 * is money the customer owes but is entitled to hold; the advance recovery is
 * money they already paid being applied. §10 requires both to sit in **their own
 * balances**, which is why they are returned separately rather than folded into
 * a net figure the ledger would have to take apart again.
 *
 * Recovery is bounded by what is left of the advance. Recovering more than was
 * advanced would turn a liability into a receivable by arithmetic rather than by
 * anybody's decision.
 */
export function progressBill(
  grossIqd: bigint,
  terms: BillingTerms,
  advanceOutstandingIqd: bigint,
): ProgressBill {
  const retentionIqd = (grossIqd * terms.retentionPercent) / 1_000_000n;

  const wanted = (grossIqd * terms.advanceRecoveryPercent) / 1_000_000n;
  const advanceRecoveredIqd = wanted > advanceOutstandingIqd ? advanceOutstandingIqd : wanted;

  return {
    grossIqd,
    retentionIqd,
    advanceRecoveredIqd,
    netIqd: grossIqd - retentionIqd - advanceRecoveredIqd,
  };
}

// ---------------------------------------------------------------------------
// Variations — §10 acceptance criterion 3
// ---------------------------------------------------------------------------

export interface Baseline {
  readonly contractValueIqd: bigint;
  readonly budgetIqd: bigint;
  readonly startsOn: string;
  readonly endsOn: string;
}

export interface RevisedPosition extends Baseline {
  readonly revisedContractValueIqd: bigint;
  readonly revisedBudgetIqd: bigint;
  readonly revisedEndsOn: string;
  readonly variations: number;
}

/**
 * §10 acceptance criterion 3 — *"variations preserve original baseline and show
 * approved revised values."*
 *
 * Both figures, always, and the baseline is never recomputed from the revised
 * one. That is the whole of the rule: a project whose baseline moves with each
 * variation cannot answer *"how far have we drifted?"*, which is the only
 * question the baseline exists to answer.
 */
export function revisedPosition(
  baseline: Baseline,
  approved: readonly { contractDeltaIqd: bigint; budgetDeltaIqd: bigint; endsOn?: string | null }[],
): RevisedPosition {
  let contract = baseline.contractValueIqd;
  let budget = baseline.budgetIqd;
  let endsOn = baseline.endsOn;

  for (const variation of approved) {
    contract += variation.contractDeltaIqd;
    budget += variation.budgetDeltaIqd;
    if (variation.endsOn) endsOn = variation.endsOn;
  }

  return {
    ...baseline,
    revisedContractValueIqd: contract,
    revisedBudgetIqd: budget,
    revisedEndsOn: endsOn,
    variations: approved.length,
  };
}

// ---------------------------------------------------------------------------
// Closeout — §10 acceptance criterion 5
// ---------------------------------------------------------------------------

/** §10's five conditions, in §10's own order. */
export const CLOSEOUT_BLOCKERS = [
  'open_purchase_orders',
  'unreturned_stock',
  'unbilled_costs',
  'unapproved_variations',
  'unresolved_advances_or_retention',
] as const;

export type CloseoutBlocker = (typeof CLOSEOUT_BLOCKERS)[number];

export interface CloseoutState {
  readonly openPurchaseOrders: number;
  readonly unreturnedStockItems: number;
  readonly unbilledCostIqd: bigint;
  readonly unapprovedVariations: number;
  readonly advanceOutstandingIqd: bigint;
  readonly retentionOutstandingIqd: bigint;
}

export interface CloseoutFinding {
  readonly blocker: CloseoutBlocker;
  readonly detail: string;
}

export class ProjectNotCloseableError extends Error {
  readonly code = 'PROJECT_NOT_CLOSEABLE';
  constructor(
    readonly projectCode: string,
    readonly findings: readonly CloseoutFinding[],
  ) {
    super(
      `${projectCode} cannot be closed (§10). ${findings.length} thing(s) are unresolved:\n` +
        findings.map((f) => `  · ${f.detail}`).join('\n') +
        '\nClosing over any of them would file the project as finished while money or stock is ' +
        'still moving against it.',
    );
    this.name = 'ProjectNotCloseableError';
  }
}

/**
 * §10 — *"project closure is blocked by open purchase orders, unreturned stock,
 * unbilled costs, unapproved variations or unresolved advances/retention."*
 *
 * **Every** blocker is reported, not the first. Closing a project is usually
 * somebody working through a list, and a system that revealed the list one item
 * at a time would turn one afternoon into five.
 */
export function closeoutFindings(state: CloseoutState): CloseoutFinding[] {
  const findings: CloseoutFinding[] = [];

  if (state.openPurchaseOrders > 0) {
    findings.push({
      blocker: 'open_purchase_orders',
      detail: `${state.openPurchaseOrders} purchase order(s) are still open.`,
    });
  }
  if (state.unreturnedStockItems > 0) {
    findings.push({
      blocker: 'unreturned_stock',
      detail: `${state.unreturnedStockItems} stock item(s) issued to the project have not come back.`,
    });
  }
  if (state.unbilledCostIqd > 0n) {
    findings.push({
      blocker: 'unbilled_costs',
      detail: `${toDecimalString(state.unbilledCostIqd, 4n)} of cost has not been billed.`,
    });
  }
  if (state.unapprovedVariations > 0) {
    findings.push({
      blocker: 'unapproved_variations',
      detail: `${state.unapprovedVariations} variation(s) are waiting for approval.`,
    });
  }
  if (state.advanceOutstandingIqd > 0n || state.retentionOutstandingIqd > 0n) {
    findings.push({
      blocker: 'unresolved_advances_or_retention',
      detail:
        `${toDecimalString(state.advanceOutstandingIqd, 4n)} of advance and ` +
        `${toDecimalString(state.retentionOutstandingIqd, 4n)} of retention are unresolved.`,
    });
  }

  return findings;
}

export function assertCloseable(projectCode: string, state: CloseoutState): void {
  const findings = closeoutFindings(state);
  if (findings.length > 0) throw new ProjectNotCloseableError(projectCode, findings);
}
