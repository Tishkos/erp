/**
 * Money Transfer — Phase 09, §12.
 *
 * The arithmetic of the service, with no I/O. §12.4 names six figures the system
 * "shall calculate"; this file is the only place they are calculated, so a
 * report, a screen and a posting cannot disagree about what the margin is.
 *
 * ── What is *not* decided here ──────────────────────────────────────────────
 * §12.4 gives the six names and §22 defines transfer margin as *"approved client
 * rate economics less actual transfer cost, fees and recognised FX effects
 * **according to finance policy**"*. The policy is Finance's (§28.1), so the
 * disputed step — whether a residual client balance is owed back to the client
 * or becomes the company's margin — is not chosen here. It is recorded in
 * `docs/open-questions-phase-09.md`. What this file computes is only what the
 * blueprint and the Phase 09 gates pin down exactly:
 *
 *   Total Client Deposits       Σ posted deposits on the client account
 *   Transfer Principal          the IQD transfer amount (§12.2 — the ledger amount)
 *   Gross Exchange Spread       from the two rates (09.3 gate)
 *   Direct Expenses             Σ posted fees and charges linked to the transfer
 *   Net Service Margin          spread less direct expenses (09.7 gate)
 *   Remaining Client Balance    deposits less principal less expenses charged
 *                               to the client (09.8 gate, verbatim)
 *
 * Every amount here is a scaled BigInt at MONEY_SCALE and every rate a scaled
 * BigInt at RATE_SCALE. No floats: a service whose entire result is the
 * difference between two large near-equal numbers cannot afford them.
 */
import { MONEY_SCALE, toDecimalString, toIqd } from './money';

/**
 * §12.6 — *"Initiated -> Sent -> Returned -> Refunded."*
 *
 * Appendix B lists eight Money Transfer statuses. They are carried on the shared
 * `document_status` vocabulary of §3.2 rather than a private enum, so the Phase
 * 01 status machine, the controlled-field freeze and the workflow engine all
 * apply without a second implementation (§24). The mapping:
 *
 * | Appendix B | document_status | why |
 * |---|---|---|
 * | Draft     | `draft`    | |
 * | Funded    | `approved` | funding confirmed and the amount specified; no money has moved |
 * | Initiated | `posted`   | §12.3 — Initiate Transfer *"creates the transfer entry"*; the ledger carries it |
 * | Sent      | `executed` | the bank has executed the instruction |
 * | Completed | `settled`  | the beneficiary has the money; the case can close |
 * | Returned  | `rejected` | the counterparty refused it and sent it back |
 * | Refunded  | `closed`   | the client has been made whole; nothing is outstanding |
 * | Reversed  | `reversed` | |
 *
 * `rejected` for Returned is the loosest of the eight and is worth naming: in
 * §3.2's vocabulary a rejection is an instruction that was refused, which is
 * what a returned transfer is — refused by the beneficiary bank rather than by
 * an internal approver. The alternative, a second private state column beside
 * `status`, was rejected because two state machines on one row drift, and the
 * one that drifts is always the one nobody is reading.
 */
export const TRANSFER_STAGE_BY_STATUS = {
  draft: 'Draft',
  approved: 'Funded',
  posted: 'Initiated',
  executed: 'Sent',
  settled: 'Completed',
  rejected: 'Returned',
  closed: 'Refunded',
  reversed: 'Reversed',
} as const;

export type TransferStatus = keyof typeof TRANSFER_STAGE_BY_STATUS;

/** Appendix B's own name for a status, for a screen or a report heading. */
export function transferStageName(status: string): string {
  return (TRANSFER_STAGE_BY_STATUS as Record<string, string>)[status] ?? status;
}

/**
 * §12.3 — *"Rates and service details remain editable while only deposit entries
 * exist. After Initiate Transfer creates the transfer entry, the transaction is
 * locked."*
 *
 * Initiation is `posted`, so everything from `posted` onward is locked. Stated
 * as the *editable* set rather than the locked one deliberately: a status added
 * later is then locked by default, which is the safe direction for this
 * particular rule to be wrong in.
 */
const EDITABLE_STATUSES: ReadonlySet<string> = new Set(['draft', 'approved']);

export function isTransferEditable(status: string): boolean {
  return EDITABLE_STATUSES.has(status);
}

/** §12.7 acceptance 2 — *"The system prevents editing after Initiate Transfer."* */
export class TransferLockedError extends Error {
  readonly code = 'MONEY_TRANSFER_LOCKED';

  constructor(
    readonly transferNo: string,
    readonly status: string,
  ) {
    super(
      `Money transfer ${transferNo} is '${status}'; Initiate Transfer has created the transfer entry, ` +
        'so the transaction is locked (§12.3). Correction requires a full reversal and a new transaction — ' +
        'there is no partial edit path, by design.',
    );
    this.name = 'TransferLockedError';
  }
}

// ---------------------------------------------------------------------------
// 09.3 — the two rates
// ---------------------------------------------------------------------------

/**
 * §12.2 — *"Official exchange rate and client exchange rate."*
 *
 * Both are published rates from the Phase 02 engine, never numbers typed on the
 * transfer (§14.3 — *"Rates are maintained only in the Finance Exchange Rate
 * section"*). Phase 02's `rate_type` already distinguishes them: `accounting` is
 * *"the approved rate the ledger posts at"* — the official rate — and `client`
 * is *"the rate quoted to a customer (§12 money transfer pricing)"*. Phase 09
 * therefore introduces no rate table of its own; it names the two that exist.
 */
export const OFFICIAL_RATE_TYPE = 'accounting' as const;
export const CLIENT_RATE_TYPE = 'client' as const;

export interface TransferRates {
  /** IQD per one USD at the official rate, scaled by RATE_SCALE. */
  readonly officialIqdPerUsd: bigint;
  /** IQD per one USD at the rate quoted to the client, scaled by RATE_SCALE. */
  readonly clientIqdPerUsd: bigint;
}

/**
 * 09.3 gate — *"Gross Exchange Spread computes from the two rates and is
 * reproducible."*
 *
 * The client is charged the requested USD equivalent at the client rate; the
 * same USD equivalent at the official rate is what it is actually worth. The
 * spread is the difference.
 *
 * ── Why a difference of two conversions, not one conversion at a rate difference ─
 * `toIqd(usd, client) - toIqd(usd, official)` and `toIqd(usd, client - official)`
 * can disagree by one unit in the last place, so the choice has to be made
 * rather than fallen into. Each of the two conversions is a figure that exists
 * in its own right — what the client was charged, and what the transfer is
 * officially worth — and both appear on the client statement. Deriving the
 * spread from a rate nobody was ever quoted would make the reported spread
 * unreproducible from the reported amounts, which is what the gate forbids.
 */
export function grossExchangeSpread(requestedUsd: bigint, rates: TransferRates): bigint {
  if (requestedUsd < 0n) {
    throw new RangeError(
      `A requested USD equivalent cannot be negative, received ${toDecimalString(requestedUsd)}.`,
    );
  }
  return toIqd(requestedUsd, rates.clientIqdPerUsd) - toIqd(requestedUsd, rates.officialIqdPerUsd);
}

/** What the client is charged for the requested USD equivalent, in IQD. */
export function clientChargeIqd(requestedUsd: bigint, rates: TransferRates): bigint {
  return toIqd(requestedUsd, rates.clientIqdPerUsd);
}

/** What the requested USD equivalent is officially worth, in IQD. */
export function officialValueIqd(requestedUsd: bigint, rates: TransferRates): bigint {
  return toIqd(requestedUsd, rates.officialIqdPerUsd);
}

// ---------------------------------------------------------------------------
// 09.8 — the six figures of §12.4
// ---------------------------------------------------------------------------

export interface MarginInputs {
  /** Σ posted deposits on the client account (§12.3 — one or several). */
  readonly totalClientDepositsIqd: bigint;
  /** The IQD transfer amount. §12.2 and 09.4: this, not the USD, is the ledger amount. */
  readonly transferPrincipalIqd: bigint;
  /** §12.2 — the requested USD equivalent, held "for pricing and reference". */
  readonly requestedUsd: bigint;
  readonly rates: TransferRates;
  /** Σ posted bank charges and other direct expenses linked to the transfer (§12.4). */
  readonly directExpensesIqd: bigint;
  /**
   * The part of those expenses borne by the client rather than by the company.
   *
   * A separate figure because §12.6 makes the distinction load-bearing: on a
   * returned transfer *"the company absorbs all bank charges"*, so an expense
   * must be able to say which side it falls on. Never inferred — every expense
   * states it (`money_transfer_expense.charged_to_client` has no default,
   * precisely so that nobody's silence decides it).
   */
  readonly expensesChargedToClientIqd: bigint;
}

/** The six figures §12.4 requires the system to calculate. */
export interface TransferMargin {
  readonly totalClientDepositsIqd: bigint;
  readonly transferPrincipalIqd: bigint;
  readonly grossExchangeSpreadIqd: bigint;
  readonly directExpensesIqd: bigint;
  readonly netServiceMarginIqd: bigint;
  readonly remainingClientBalanceIqd: bigint;
}

/**
 * §12.4 — *"The system shall calculate Total Client Deposits, Transfer
 * Principal, Gross Exchange Spread, Direct Expenses, Net Service Margin and
 * Remaining Client Balance."*
 *
 * Two of the six are defined by the Phase 09 gates rather than by §12.4 itself,
 * and both are quoted where they are used:
 *
 *   09.7  "Fees reduce Net Service Margin and are visible separately from Gross
 *          Exchange Spread"                    → net = spread − direct expenses
 *   09.8  "Remaining Client Balance equals deposits less transfer principal less
 *          expenses charged to the client"
 *
 * Neither is an accounting choice: both are stated outright and the wording
 * leaves no second reading. What the company then *does* with a remaining
 * balance is policy, and is not answered here.
 */
export function calculateMargin(input: MarginInputs): TransferMargin {
  const spread = grossExchangeSpread(input.requestedUsd, input.rates);

  return {
    totalClientDepositsIqd: input.totalClientDepositsIqd,
    transferPrincipalIqd: input.transferPrincipalIqd,
    grossExchangeSpreadIqd: spread,
    directExpensesIqd: input.directExpensesIqd,
    // 09.7 — fees reduce the net margin and stay visible beside the spread
    // rather than being netted into it.
    netServiceMarginIqd: spread - input.directExpensesIqd,
    // 09.8, verbatim.
    remainingClientBalanceIqd:
      input.totalClientDepositsIqd - input.transferPrincipalIqd - input.expensesChargedToClientIqd,
  };
}

/** The margin as decimal strings, for a report or an API response. */
export function marginToStrings(margin: TransferMargin): Record<keyof TransferMargin, string> {
  return {
    totalClientDepositsIqd: toDecimalString(margin.totalClientDepositsIqd, MONEY_SCALE),
    transferPrincipalIqd: toDecimalString(margin.transferPrincipalIqd, MONEY_SCALE),
    grossExchangeSpreadIqd: toDecimalString(margin.grossExchangeSpreadIqd, MONEY_SCALE),
    directExpensesIqd: toDecimalString(margin.directExpensesIqd, MONEY_SCALE),
    netServiceMarginIqd: toDecimalString(margin.netServiceMarginIqd, MONEY_SCALE),
    remainingClientBalanceIqd: toDecimalString(margin.remainingClientBalanceIqd, MONEY_SCALE),
  };
}

// ---------------------------------------------------------------------------
// 09.2 — the client clearing balance
// ---------------------------------------------------------------------------

export interface DepositUsage {
  readonly amountIqd: bigint;
  readonly usedIqd: bigint;
  readonly refundedIqd: bigint;
}

/**
 * 09.2 gate — *"The client clearing balance equals the sum of deposits less
 * usage at all times."*
 *
 * There is no stored balance anywhere in this module: the balance is this sum,
 * so it cannot drift from the deposits it is made of. The same reasoning §24
 * gives for the subledger — *"balances are derived from immutable entries"*.
 */
export function clientClearingBalance(deposits: readonly DepositUsage[]): bigint {
  return deposits.reduce((sum, d) => sum + d.amountIqd - d.usedIqd - d.refundedIqd, 0n);
}

/** What a single deposit still has available to spend. */
export function depositAvailable(deposit: DepositUsage): bigint {
  return deposit.amountIqd - deposit.usedIqd - deposit.refundedIqd;
}

/**
 * §12.3 — *"A client can make one or several partial deposits."*
 *
 * Consumption is oldest-deposit-first. The order matters because Appendix B
 * gives a deposit its own statuses — Available, Partially Used, Used — so the
 * system has to say *which* deposit a transfer consumed, not merely that the
 * balance fell. Oldest-first is the same convention Phase 04 uses for FIFO cost
 * layers, and it is the one a client reading a statement expects: the money that
 * arrived first is the money that went.
 */
export function allocateAcrossDeposits<T extends DepositUsage>(
  deposits: readonly T[],
  amountIqd: bigint,
): ReadonlyArray<{ deposit: T; appliedIqd: bigint }> {
  if (amountIqd < 0n) {
    throw new RangeError(`Cannot allocate a negative amount, received ${toDecimalString(amountIqd)}.`);
  }

  const applied: Array<{ deposit: T; appliedIqd: bigint }> = [];
  let outstanding = amountIqd;

  for (const deposit of deposits) {
    if (outstanding === 0n) break;
    const available = depositAvailable(deposit);
    if (available <= 0n) continue;

    const take = available < outstanding ? available : outstanding;
    applied.push({ deposit, appliedIqd: take });
    outstanding -= take;
  }

  if (outstanding > 0n) {
    throw new InsufficientClientFundsError(amountIqd, amountIqd - outstanding);
  }

  return applied;
}

/**
 * §12.3 — the client account is funded by the client's own deposits, and a
 * transfer draws only on those.
 *
 * The reason this is an error rather than an overdraft: the money in the client
 * clearing account belongs to the client, and sending more than they deposited
 * would be the company funding a transfer out of *other* clients' money. That
 * is the single failure Appendix E's FATF reference exists to prevent, and it
 * has to be impossible rather than discouraged.
 */
export class InsufficientClientFundsError extends Error {
  readonly code = 'CLIENT_FUNDS_INSUFFICIENT';

  constructor(
    readonly requestedIqd: bigint,
    readonly availableIqd: bigint,
  ) {
    const money = (v: bigint) => toDecimalString(v, MONEY_SCALE);
    super(
      `The client account holds ${money(availableIqd)} but ${money(requestedIqd)} was requested (§12.3). ` +
        'A transfer draws only on the deposits this client actually made; the shortfall would otherwise ' +
        "be funded from other clients' money.",
    );
    this.name = 'InsufficientClientFundsError';
  }
}

// ---------------------------------------------------------------------------
// 09.6 — Bank Execution Batch
// ---------------------------------------------------------------------------

/**
 * §12.7 acceptance 3 — *"Bank Execution Batch lines sum exactly to the bank
 * execution total."*
 *
 * "Exactly" is the whole point, so this is an equality on scaled integers and
 * there is no tolerance parameter to widen later. The batch total is the amount
 * the *bank* debited, taken from the bank advice; the lines are what the company
 * says it was for. Execution is refused until the two agree.
 */
export function batchLinesSumTo(total: bigint, lineAmounts: readonly bigint[]): boolean {
  return sumOf(lineAmounts) === total;
}

export function sumOf(amounts: readonly bigint[]): bigint {
  return amounts.reduce((sum, amount) => sum + amount, 0n);
}

export class BatchOutOfBalanceError extends Error {
  readonly code = 'BANK_EXECUTION_BATCH_OUT_OF_BALANCE';

  constructor(
    readonly batchNo: string,
    readonly total: bigint,
    readonly lineSum: bigint,
  ) {
    const money = (v: bigint) => toDecimalString(v, MONEY_SCALE);
    super(
      `Bank execution batch ${batchNo} totals ${money(total)} but its lines sum to ${money(lineSum)} ` +
        '(§12.5, §12.7). The batch total is the single amount the bank debited; until the lines account ' +
        `for all of it, ${money(total - lineSum)} of company money is unexplained.`,
    );
    this.name = 'BatchOutOfBalanceError';
  }
}

// ---------------------------------------------------------------------------
// 09.9 — returned transfers
// ---------------------------------------------------------------------------

/**
 * §12.6 — *"The client receives a full refund. The company absorbs all bank
 * charges."*
 *
 * Two sentences, one rule: the refund is the client's whole balance, and the
 * charges do not come out of it. Expressed as a predicate so the service and the
 * database can both state it and neither is the only one that does.
 */
export function isFullRefund(refundIqd: bigint, clientBalanceIqd: bigint): boolean {
  return refundIqd === clientBalanceIqd;
}

export class PartialRefundError extends Error {
  readonly code = 'MONEY_TRANSFER_REFUND_NOT_FULL';

  constructor(
    readonly transferNo: string,
    readonly offered: bigint,
    readonly due: bigint,
  ) {
    const money = (v: bigint) => toDecimalString(v, MONEY_SCALE);
    super(
      `Transfer ${transferNo} was returned, so the client receives a full refund of ${money(due)} ` +
        `(§12.6) — not ${money(offered)}. The company absorbs all bank charges; deducting them from the ` +
        'refund would charge the client for a transfer that never arrived.',
    );
    this.name = 'PartialRefundError';
  }
}

// ---------------------------------------------------------------------------
// 09.1 — KYC completeness
// ---------------------------------------------------------------------------

/**
 * §21 — *"KYC/compliance records are linked to the business partner and relevant
 * Money Transfer cases."* Appendix E cites the FATF MVTS guidance for
 * risk-based controls.
 *
 * ── What this does and does not decide ──────────────────────────────────────
 * *Which* documents a client must produce, what risk score bands mean, and how
 * often a review must be repeated are compliance decisions that belong to Legal
 * (§28.1, go-live gate 5, decision **D9**). None of them are chosen here.
 *
 * What is built is the mechanism: a KYC record has an approval state and an
 * expiry, the required-document catalogue is a table Compliance fills, and a
 * transfer cannot be initiated unless the record is approved and unexpired on
 * the transfer date. That much follows from §12 alone — a regulated service that
 * could send client money with no completed identification would fail the gate
 * whatever Legal decides the specifics to be.
 */
/**
 * The standing of a client who has no KYC record at all.
 *
 * A distinct value rather than `null`, so "never identified" and "identified and
 * refused" are different sentences to whoever is told they cannot send the
 * money. They lead to different next actions.
 */
export const NO_KYC_RECORD = 'none';

export interface KycStanding {
  readonly status: string;
  /** Inclusive ISO date. Null means Compliance set no expiry on this record. */
  readonly expiresOn: string | null;
  /** Codes from the required-document catalogue that this record still lacks. */
  readonly missingDocumentCodes: readonly string[];
}

export function isKycComplete(standing: KycStanding, onDate: string): boolean {
  if (standing.status !== 'approved') return false;
  if (standing.missingDocumentCodes.length > 0) return false;
  // Inclusive: a record expiring today still covers today.
  if (standing.expiresOn !== null && standing.expiresOn < onDate) return false;
  return true;
}

export class KycIncompleteError extends Error {
  readonly code = 'CLIENT_KYC_INCOMPLETE';

  constructor(
    readonly partnerCode: string,
    readonly standing: KycStanding,
    readonly onDate: string,
  ) {
    const why =
      standing.status === NO_KYC_RECORD
        ? 'there is no approved KYC record for them'
        : standing.status !== 'approved'
          ? `the KYC record is '${standing.status}', not approved`
          : standing.missingDocumentCodes.length > 0
            ? `these required documents are missing: ${standing.missingDocumentCodes.join(', ')}`
            : `the KYC record expired on ${standing.expiresOn}`;

    super(
      `No transfer can be initiated for client ${partnerCode} on ${onDate}: ${why} (§21, Appendix E). ` +
        'Money Transfer is a regulated service; identification is completed before client money moves, ' +
        'not after.',
    );
    this.name = 'KycIncompleteError';
  }
}
