/**
 * Payables — REQ-AP-001, the rules a database cannot hold.
 *
 * Three things live here, pure and framework-free like the rest of the
 * domain:
 *
 * **The reference key (R1).** One normalisation, used for creation, matching
 * and search alike, and the same rule the sheet's formulas used — upper case,
 * letters and digits only — so a reference typed `csa-al0001-1`, ` CSA
 * AL0001 1` or `CSA-AL0001-1` is one import, not three.
 *
 * **Stage derivation (§6, R2).** A payable's stage is the highest-numbered
 * stage of its type's rail whose rule holds. The *rails* are configuration
 * (rows of `payable_stage`); the *rules* are named predicates here, because
 * what makes "All received" true is this requirement's to fix, not a
 * setting's. A rule that reads a lane whose documents arrive in a later
 * build stage simply evaluates false until they exist — which is R2 working
 * as stated: lanes are independent, and so are the build stages.
 *
 * **Hold completion (§19, D2).** What an automatic `PENDING_REASON` hold
 * demands before the payable's lane is editable again.
 */

export class PayableValidationError extends Error {
  readonly code = 'PAYABLE_INVALID';
  constructor(
    readonly field: string,
    detail: string,
  ) {
    super(`${field}: ${detail}`);
    this.name = 'PayableValidationError';
  }
}

// ---------------------------------------------------------------------------
// R1 — the reference key
// ---------------------------------------------------------------------------

/**
 * The supplier's reference, normalised for matching: upper case, `[A-Z0-9]`
 * only. `CSA-AL0001-1` and `csa al0001/1` both key as `CSAAL00011`.
 */
export function referenceKey(reference: string): string {
  const key = reference.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (key.length === 0) {
    throw new PayableValidationError(
      'supplier_reference',
      `"${reference}" contains no letters or digits, so nothing could ever match it. ` +
        'Enter the supplier’s PO / INV / contract number as written.',
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// §6 — stage derivation
// ---------------------------------------------------------------------------

/**
 * Everything a stage rule may ask about a payable, gathered by the service
 * in one place so the rules stay pure. Facts about lanes that have no
 * documents yet default to their empty value — false and zero.
 */
export interface StageFacts {
  /** Order lane. */
  readonly postedInvoiceCount: number;
  readonly approvedInvoiceCount: number;
  /** Payment lane (build stage 3). */
  readonly instalmentPlanSet: boolean;
  readonly firstInstalmentFunded: boolean;
  readonly paymentSentCount: number;
  readonly fullyPaid: boolean;
  readonly allPaymentsConfirmed: boolean;
  readonly statementMatched: boolean;
  /** PD lane (build stage 4). */
  readonly livePdCount: number;
  readonly allPdsWrittenOff: boolean;
  /** Shipment and warehouse lanes (build stage 5). */
  readonly containerCount: number;
  readonly containersReceived: number;
  readonly receivedQuantityMatches: boolean;
  readonly goodsReceiptPosted: boolean;
  /** Service lane (build stage 2). */
  readonly serviceConfirmed: boolean;
  readonly recurringConfirmed: boolean;
  /** Advance type (build stage 3). */
  readonly advanceApproved: boolean;
  readonly advancePaid: boolean;
  readonly advanceSettled: boolean;
}

/** The empty world — a payable that exists and nothing more. */
export const NO_FACTS: StageFacts = Object.freeze({
  postedInvoiceCount: 0,
  approvedInvoiceCount: 0,
  instalmentPlanSet: false,
  firstInstalmentFunded: false,
  paymentSentCount: 0,
  fullyPaid: false,
  allPaymentsConfirmed: false,
  statementMatched: false,
  livePdCount: 0,
  allPdsWrittenOff: false,
  containerCount: 0,
  containersReceived: 0,
  receivedQuantityMatches: false,
  goodsReceiptPosted: false,
  serviceConfirmed: false,
  recurringConfirmed: false,
  advanceApproved: false,
  advancePaid: false,
  advanceSettled: false,
});

type StageRule = (f: StageFacts) => boolean;

/**
 * The named rules the seed rails reference (`payable_stage.rule_name`).
 *
 * Import 6 and 7 are exclusive by construction — partly needs an unreceived
 * container, all needs none — and 8 (`import_cleared`) contains 7's condition,
 * which is §20.1's "8 requires 7" stated as arithmetic rather than a caveat.
 */
export const STAGE_RULES: Readonly<Record<string, StageRule>> = Object.freeze({
  /** Every rail's floor: the payable exists. */
  opened: () => true,

  invoice_posted: (f) => f.postedInvoiceCount > 0,
  invoice_approved: (f) => f.approvedInvoiceCount > 0,
  payment_sent: (f) => f.paymentSentCount > 0,
  fully_paid: (f) => f.fullyPaid,
  closed_matched: (f) => f.fullyPaid && f.statementMatched,

  import_invoiced_funded: (f) =>
    f.postedInvoiceCount > 0 && f.instalmentPlanSet && f.firstInstalmentFunded,
  import_pd_registered: (f) => f.livePdCount > 0,
  import_shipped: (f) => f.containerCount > 0,
  import_partly_received: (f) =>
    f.containersReceived > 0 && f.containersReceived < f.containerCount,
  import_all_received: (f) => f.containerCount > 0 && f.containersReceived === f.containerCount,
  import_cleared: (f) =>
    f.fullyPaid &&
    f.allPaymentsConfirmed &&
    f.containerCount > 0 &&
    f.containersReceived === f.containerCount &&
    f.receivedQuantityMatches &&
    f.allPdsWrittenOff,

  service_confirmed: (f) => f.serviceConfirmed,
  recurring_confirmed: (f) => f.recurringConfirmed,
  goods_received: (f) => f.goodsReceiptPosted,

  advance_approved: (f) => f.advanceApproved,
  advance_paid: (f) => f.advancePaid,
  advance_settled: (f) => f.advanceSettled,
});

export interface StageRow {
  readonly code: string;
  readonly sequence: number;
  readonly ruleName: string;
  readonly active: boolean;
}

export class UnknownStageRuleError extends Error {
  readonly code = 'UNKNOWN_STAGE_RULE';
  constructor(ruleName: string, stageCode: string) {
    super(
      `Stage '${stageCode}' names the rule '${ruleName}', which this build does not implement. ` +
        'A stage can be renamed or resequenced in settings; what makes it true is code (§6).',
    );
    this.name = 'UnknownStageRuleError';
  }
}

/**
 * The derivation: the highest-sequenced active stage whose rule holds.
 *
 * Total by construction — every seeded rail's first stage uses `opened`,
 * which always holds; a configured rail that leaves no stage true is a
 * configuration error and says so rather than guessing.
 */
export function deriveStage(rail: readonly StageRow[], facts: StageFacts): string {
  const active = rail
    .filter((s) => s.active)
    .slice()
    .sort((a, b) => a.sequence - b.sequence);

  let current: string | null = null;
  for (const stage of active) {
    const rule = STAGE_RULES[stage.ruleName];
    if (!rule) throw new UnknownStageRuleError(stage.ruleName, stage.code);
    if (rule(facts)) current = stage.code;
  }

  if (current === null) {
    throw new PayableValidationError(
      'stage',
      'no stage of this type’s rail holds — a rail must start from a stage whose rule is ‘opened’.',
    );
  }
  return current;
}

// ---------------------------------------------------------------------------
// §19 — holds
// ---------------------------------------------------------------------------

/** The system reason the sweep opens holds under. Completing it is §19.1. */
export const PENDING_REASON = 'PENDING_REASON';

export class HoldIncompleteError extends Error {
  readonly code = 'HOLD_INCOMPLETE';
  constructor(detail: string) {
    super(detail);
    this.name = 'HoldIncompleteError';
  }
}

export interface HoldCompletion {
  readonly reasonCode: string;
  readonly reasonRequiresDetail: boolean;
  readonly detail?: string | null;
  readonly ownerUserId?: string | null;
  readonly nextAction?: string | null;
  readonly nextActionDue?: string | null;
}

/**
 * §19.2 — what a hold must carry to stand as an answer to "why is it
 * stopped?": a real reason, an owner, and a next action with a date.
 */
export function assertHoldComplete(input: HoldCompletion): void {
  if (!input.reasonCode || input.reasonCode === PENDING_REASON) {
    throw new HoldIncompleteError(
      'Choose the reason the payable is stopped — ‘reason required’ is the question, not an answer.',
    );
  }
  if (input.reasonRequiresDetail && !input.detail?.trim()) {
    throw new HoldIncompleteError(
      `Reason ${input.reasonCode} requires the detail in words — say what is actually wrong.`,
    );
  }
  if (!input.ownerUserId) {
    throw new HoldIncompleteError(
      'Name who is following this up. A stop nobody owns stays stopped.',
    );
  }
  if (!input.nextAction?.trim()) {
    throw new HoldIncompleteError('Say what happens next — the next action is required.');
  }
  if (!input.nextActionDue) {
    throw new HoldIncompleteError('Give the next action its expected date.');
  }
}

// ---------------------------------------------------------------------------
// §19.3 — time limits
// ---------------------------------------------------------------------------

export interface TimeLimitRow {
  readonly scope: string;
  readonly limitDays: number;
  readonly escalateAfterDays: number | null;
  readonly escalateToRole: string | null;
  readonly active: boolean;
  /** ISO date. A changed limit is a new row; old rows keep their validity. */
  readonly validFrom: string;
}

/** What a check's condition is about, for scope matching. */
export interface LimitScope {
  readonly typeCode?: string | null;
  readonly bankCode?: string | null;
  readonly methodCode?: string | null;
  readonly portCode?: string | null;
  readonly supplierId?: string | null;
}

const SCOPE_RANK: Readonly<Record<string, number>> = Object.freeze({
  supplier: 5,
  bank: 4,
  method: 4,
  port: 4,
  type: 3,
  all: 1,
});

function scopeMatches(scope: string, about: LimitScope): boolean {
  if (scope === 'all') return true;
  const [kind, ...rest] = scope.split(':');
  const value = rest.join(':');
  switch (kind) {
    case 'type':
      return about.typeCode === value;
    case 'bank':
      return about.bankCode === value;
    case 'method':
      return about.methodCode === value;
    case 'port':
      return about.portCode === value;
    case 'supplier':
      return about.supplierId === value;
    default:
      return false;
  }
}

/**
 * The limit in force: among active rows whose scope matches and whose
 * validity has begun, the most specific wins; a tie goes to the newest
 * validity, so "change the limit" is "add a row" (§19.3).
 */
export function limitInForce(
  rows: readonly TimeLimitRow[],
  about: LimitScope,
  asOf: string,
): TimeLimitRow | null {
  const candidates = rows.filter(
    (row) => row.active && row.validFrom <= asOf && scopeMatches(row.scope, about),
  );
  if (candidates.length === 0) return null;

  return candidates.reduce((best, row) => {
    const bestRank = SCOPE_RANK[best.scope.split(':')[0]!] ?? 0;
    const rowRank = SCOPE_RANK[row.scope.split(':')[0]!] ?? 0;
    if (rowRank !== bestRank) return rowRank > bestRank ? row : best;
    return row.validFrom > best.validFrom ? row : best;
  });
}
