/**
 * Investment rules — Phase 13, §13 and Appendix E (IFRS 9).
 *
 * ── What this file deliberately does not contain ────────────────────────────
 * §13 is unusually direct about it:
 *
 *   "The legal and accounting treatment of investments differs by instrument.
 *    The IT team must implement configurable types and posting rules **only
 *    after Finance defines the required categories**."
 *   "Valuation methods and frequency require Finance approval."
 *
 * So there is no category list here, no valuation-method union, and no default
 * frequency. A `ValuationMethod` type with members — `'fair_value' | 'cost' |
 * 'equity'` — would be this file answering **D2**, and it would be invisible:
 * every test would be written against the same invented rule and would pass.
 *
 * A method is therefore a **string that must name a configured row**. The domain
 * can say a valuation has no method, or that the method is not one Finance has
 * approved; it cannot say which methods exist. That is the whole difference
 * between building the mechanism and choosing the answer.
 *
 * ── Scales ──────────────────────────────────────────────────────────────────
 * Money is scale 4, as everywhere. **Units are scale 6**, like quantities: a
 * holding of 1,000 shares and a holding of 0.000001 of a fund are the same kind
 * of number, and rounding units at 4 places would lose fractional holdings that
 * exist in real portfolios.
 */

/** Money and units, both as scaled integers. */
const UNIT_SCALE = 1_000_000n;

export class ProposalIncompleteError extends Error {
  readonly code = 'INVESTMENT_PROPOSAL_INCOMPLETE';

  constructor(readonly missing: readonly string[]) {
    super(
      `An investment proposal states ${missing.join(', ')} before it is submitted ` +
        '(blueprint 13). A proposal that does not say what is being bought, in what ' +
        'currency, or what return is expected cannot be approved on its merits.',
    );
    this.name = 'ProposalIncompleteError';
  }
}

export class RequiredFieldsMissingError extends Error {
  readonly code = 'INVESTMENT_REQUIRED_FIELDS_MISSING';

  constructor(
    readonly typeCode: string,
    readonly missing: readonly string[],
  ) {
    super(
      `Investment type '${typeCode}' requires ${missing.join(', ')} (blueprint 13 — ` +
        '"investment type determines required fields"). The requirement is ' +
        "configuration, so add the value or change the type's field list.",
    );
    this.name = 'RequiredFieldsMissingError';
  }
}

export class NotApprovedForAcquisitionError extends Error {
  readonly code = 'INVESTMENT_NOT_APPROVED';

  constructor(reason: string) {
    super(`This investment cannot be acquired: ${reason}`);
    this.name = 'NotApprovedForAcquisitionError';
  }
}

export class ValuationMethodUnknownError extends Error {
  readonly code = 'INVESTMENT_VALUATION_METHOD_UNKNOWN';

  constructor(method: string | null) {
    super(
      method === null || method.trim().length === 0
        ? 'A valuation states the method it was made on (blueprint 13). Which methods ' +
          'exist is Finance\'s to decide and is configuration — decision register D2.'
        : `'${method}' is not a valuation method Finance has approved (blueprint 13, ` +
          'D2). Configure it before valuing on it; this system does not invent one.',
    );
    this.name = 'ValuationMethodUnknownError';
  }
}

export class DisposalTooLargeError extends Error {
  readonly code = 'INVESTMENT_DISPOSAL_TOO_LARGE';

  constructor(
    readonly held: bigint,
    readonly disposed: bigint,
  ) {
    super(
      `Cannot dispose of more than is held (blueprint 13). Held ${held}, disposal ` +
        `${disposed} in units of 1e-6.`,
    );
    this.name = 'DisposalTooLargeError';
  }
}

// ---------------------------------------------------------------------------
// 13.2 — the proposal
// ---------------------------------------------------------------------------

/**
 * §13's workflow step 1 names five things a proposal states.
 *
 * They are checked as a set and reported together, because §25 asks the message
 * to say what to fix and fixing one field at a time is how people come to hate a
 * system.
 */
export interface ProposalFields {
  readonly typeCode: string | null;
  readonly amountIqd: bigint | null;
  readonly currencyCode: string | null;
  readonly expectedReturn: string | null;
  readonly riskAssessment: string | null;
}

const PROPOSAL_LABELS: Record<keyof ProposalFields, string> = {
  typeCode: 'an investment type',
  amountIqd: 'an amount',
  currencyCode: 'a currency',
  expectedReturn: 'the expected return',
  riskAssessment: 'a risk assessment',
};

function blank(value: string | bigint | null): boolean {
  if (value === null) return true;
  if (typeof value === 'bigint') return value <= 0n;
  return value.trim().length === 0;
}

export function proposalGaps(fields: ProposalFields): string[] {
  return (Object.keys(PROPOSAL_LABELS) as Array<keyof ProposalFields>)
    .filter((key) => blank(fields[key]))
    .map((key) => PROPOSAL_LABELS[key]);
}

export function assertProposalComplete(fields: ProposalFields): void {
  const missing = proposalGaps(fields);
  if (missing.length > 0) throw new ProposalIncompleteError(missing);
}

// ---------------------------------------------------------------------------
// 13.1 — required fields, by type, from configuration
// ---------------------------------------------------------------------------

/**
 * §13 — *"Investment type determines required fields and account mappings."*
 *
 * The field list arrives as data. Adding a type, or changing what a type
 * demands, is a configuration change and never a code change — which is the
 * 13.1 gate stated as a function signature.
 */
export function missingRequiredFields(
  required: readonly string[],
  supplied: Readonly<Record<string, unknown>>,
): string[] {
  return required.filter((field) => {
    const value = supplied[field];
    if (value === null || value === undefined) return true;
    if (typeof value === 'string') return value.trim().length === 0;
    return false;
  });
}

export function assertRequiredFields(
  typeCode: string,
  required: readonly string[],
  supplied: Readonly<Record<string, unknown>>,
): void {
  const missing = missingRequiredFields(required, supplied);
  if (missing.length > 0) throw new RequiredFieldsMissingError(typeCode, missing);
}

// ---------------------------------------------------------------------------
// 13.2 / 13.3 — approval before acquisition
// ---------------------------------------------------------------------------

export interface ApprovalState {
  /** §13 workflow step 2 — management approval. */
  readonly managementApprovedBy: string | null;
  /** §13 — *"Treasury provides funding"*; the source of funds is approved too. */
  readonly fundingApprovedBy: string | null;
  /** §13 — *"related-party status ... where the approved process requires it"*. */
  readonly isRelatedParty: boolean;
  /**
   * Null when the type does not demand it. Where the type does, an unapproved
   * related-party investment cannot be acquired.
   */
  readonly relatedPartyApprovedBy: string | null;
  /** From the type's configuration, not from a constant here. */
  readonly relatedPartyApprovalRequired: boolean;
}

/**
 * §13 acceptance 1 — *"An approved investment proposal creates a controlled
 * acquisition record and accounting entry."*
 *
 * Both approvals, and the related-party one where configuration asks for it. The
 * three are separate people's decisions and are checked separately: a single
 * `approved` flag would let one signature stand for three.
 */
export function assertApprovedForAcquisition(state: ApprovalState): void {
  if (!state.managementApprovedBy) {
    throw new NotApprovedForAcquisitionError(
      'management has not approved the proposal (blueprint 13, workflow step 2).',
    );
  }
  if (!state.fundingApprovedBy) {
    throw new NotApprovedForAcquisitionError(
      'the funding source has not been approved (blueprint 13 — Treasury provides funding).',
    );
  }
  if (state.isRelatedParty && state.relatedPartyApprovalRequired && !state.relatedPartyApprovedBy) {
    throw new NotApprovedForAcquisitionError(
      'it is a related-party investment and the additional approval its type requires ' +
        'has not been given (blueprint 13).',
    );
  }
}

// ---------------------------------------------------------------------------
// 13.5 — valuation, without choosing a method
// ---------------------------------------------------------------------------

/**
 * A method is valid when Finance has configured it. Nothing more is knowable
 * here, and nothing more should be.
 */
export function assertValuationMethod(
  method: string | null,
  configured: readonly string[],
): void {
  if (method === null || method.trim().length === 0) {
    throw new ValuationMethodUnknownError(method);
  }
  if (!configured.includes(method)) {
    throw new ValuationMethodUnknownError(method);
  }
}

export interface Valuation {
  readonly valuedOn: string;
  readonly method: string;
  readonly valueIqd: bigint;
  readonly approvedBy: string;
}

/**
 * §13 — *"The system preserves historical valuations; it does not overwrite
 * prior values."*
 *
 * Sorted oldest first, so "the value at the time" is a lookup rather than a
 * calculation, and the method used at the time travels with it. A valuation that
 * replaced its predecessor could not answer either question.
 */
export function valuationHistory(valuations: readonly Valuation[]): Valuation[] {
  return [...valuations].sort((a, b) =>
    a.valuedOn === b.valuedOn ? 0 : a.valuedOn < b.valuedOn ? -1 : 1,
  );
}

export function latestValuation(valuations: readonly Valuation[]): Valuation | null {
  const history = valuationHistory(valuations);
  return history.length === 0 ? null : history[history.length - 1]!;
}

// ---------------------------------------------------------------------------
// 13.6 — disposal
// ---------------------------------------------------------------------------

export interface Holding {
  /** Units held, scale 6. */
  readonly unitsHeld: bigint;
  /** What the holding is carried at, scale 4. */
  readonly carryingValueIqd: bigint;
}

export interface DisposalOutcome {
  readonly unitsDisposed: bigint;
  readonly unitsRemaining: bigint;
  /** The share of carrying value that leaves with the units. */
  readonly carryingValueDisposedIqd: bigint;
  readonly carryingValueRemainingIqd: bigint;
  readonly proceedsIqd: bigint;
  /** Positive is a gain. */
  readonly realisedResultIqd: bigint;
  readonly isFullDisposal: boolean;
}

/**
 * §13.6 — *"Partial disposal reduces units and carrying value proportionally."*
 *
 * The proportion is of **units**, not of value, and the remainder is computed by
 * subtraction rather than by a second multiplication. Two roundings of the same
 * quantity do not have to agree; one rounding and a subtraction always do, which
 * is what keeps a sequence of partial disposals ending at exactly zero rather
 * than at a residue nobody can explain.
 *
 * A full disposal is recognised by units rather than by a flag, so it cannot be
 * claimed while units remain.
 */
export function disposalOutcome(
  holding: Holding,
  unitsDisposed: bigint,
  proceedsIqd: bigint,
): DisposalOutcome {
  if (unitsDisposed <= 0n) {
    throw new DisposalTooLargeError(holding.unitsHeld, unitsDisposed);
  }
  if (unitsDisposed > holding.unitsHeld) {
    throw new DisposalTooLargeError(holding.unitsHeld, unitsDisposed);
  }

  const isFullDisposal = unitsDisposed === holding.unitsHeld;

  const carryingValueDisposedIqd = isFullDisposal
    ? holding.carryingValueIqd
    : (holding.carryingValueIqd * unitsDisposed) / holding.unitsHeld;

  return {
    unitsDisposed,
    unitsRemaining: holding.unitsHeld - unitsDisposed,
    carryingValueDisposedIqd,
    carryingValueRemainingIqd: holding.carryingValueIqd - carryingValueDisposedIqd,
    proceedsIqd,
    realisedResultIqd: proceedsIqd - carryingValueDisposedIqd,
    isFullDisposal,
  };
}

// ---------------------------------------------------------------------------
// Portfolio arithmetic — 13.8
// ---------------------------------------------------------------------------

export interface PortfolioLine {
  readonly costIqd: bigint;
  readonly carryingValueIqd: bigint;
  readonly incomeIqd: bigint;
  readonly realisedResultIqd: bigint;
}

export interface PortfolioTotals {
  readonly costIqd: bigint;
  readonly carryingValueIqd: bigint;
  readonly incomeIqd: bigint;
  readonly realisedResultIqd: bigint;
  /**
   * §13 — *"BI combines investment cost, income, current value and
   * realised/unrealised result."*
   *
   * Unrealised is carrying value less cost, and it is **derived rather than
   * stored**: a stored figure would be a second opinion about the same two
   * numbers, and the two would drift the first time a valuation was corrected.
   */
  readonly unrealisedResultIqd: bigint;
  readonly totalReturnIqd: bigint;
}

export function portfolioTotals(lines: readonly PortfolioLine[]): PortfolioTotals {
  const sum = (pick: (line: PortfolioLine) => bigint) =>
    lines.reduce((total, line) => total + pick(line), 0n);

  const costIqd = sum((l) => l.costIqd);
  const carryingValueIqd = sum((l) => l.carryingValueIqd);
  const incomeIqd = sum((l) => l.incomeIqd);
  const realisedResultIqd = sum((l) => l.realisedResultIqd);
  const unrealisedResultIqd = carryingValueIqd - costIqd;

  return {
    costIqd,
    carryingValueIqd,
    incomeIqd,
    realisedResultIqd,
    unrealisedResultIqd,
    totalReturnIqd: incomeIqd + realisedResultIqd + unrealisedResultIqd,
  };
}

/**
 * The base-currency equivalent of a foreign-currency amount.
 *
 * §13 — *"Foreign-currency investments store transaction currency and
 * base-currency equivalents"*, and TECHSTACK A4 says both are stored rather than
 * one being recomputed on read. This is the conversion used at the moment of
 * storing; nothing recomputes it afterwards, because a later rate would restate
 * a transaction that already happened.
 */
export function baseEquivalent(amount: bigint, iqdPerUnit: bigint, rateScale: bigint): bigint {
  return (amount * iqdPerUnit) / rateScale;
}

export { UNIT_SCALE };
