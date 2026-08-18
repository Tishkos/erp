/**
 * Bank reconciliation — Phase 07.7, §17.
 *
 * > §17: *"Automatic matching by amount, date, reference and counterparty, with
 * > manual confirmation."* · *"Reconciliation cannot be finalised with
 * > unexplained differences unless an authorised adjustment is posted."* ·
 * > *"Statement lines are immutable after reconciliation; corrections use
 * > reopen/adjustment workflow."*
 * > §17 acceptance criterion 3: *"Reconciled bank balance agrees to the G/L for
 * > the same date."*
 *
 * Two records of the same money, kept by two organisations, and the job is to
 * explain every difference between them. Not to remove the differences —
 * **timing differences are real and correct**, and a reconciliation that made
 * them disappear would be hiding the one thing it exists to show.
 *
 * Everything here is pure. What it deliberately does **not** do is decide: a
 * proposed match is a suggestion with a score attached, and §17 requires a
 * person to confirm it. A system that matched on its own would be a system that
 * quietly agreed the bank balance to itself.
 *
 * Money is scaled at 10^4.
 */
import { toDecimalString } from './money';
import { daysBetween } from './dates';

// ---------------------------------------------------------------------------
// Matching — §17
// ---------------------------------------------------------------------------

export interface StatementSide {
  readonly id: string;
  readonly bookingDate: string;
  /** Signed: positive is money into the account. */
  readonly amountIqd: bigint;
  readonly reference: string | null;
  readonly counterparty: string | null;
}

export interface LedgerSide {
  readonly id: string;
  readonly postingDate: string;
  /** Signed the same way: positive is a debit to the bank account. */
  readonly amountIqd: bigint;
  readonly reference: string | null;
  readonly counterparty: string | null;
}

export interface Suggestion {
  readonly statementLineIds: readonly string[];
  readonly ledgerItemIds: readonly string[];
  /** 0–100. Only the amount is required; everything else is corroboration. */
  readonly confidence: number;
  readonly why: string;
}

/** How far apart two dates can be and still be the same payment. */
export const DATE_TOLERANCE_DAYS = 5;

function normalise(value: string | null): string {
  return (value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * How much two entries look like the same movement.
 *
 * **The amount is not scored, it is required.** Two entries of different amounts
 * are not a weak match, they are not a match — proposing one would invite
 * somebody to confirm a difference away. Everything else adds confidence:
 *
 * | Signal | Weight | Why |
 * |---|---|---|
 * | Reference | 40 | The strongest corroboration there is; both sides quote the instruction |
 * | Counterparty | 25 | Names vary in spelling, so this is worth less than it looks |
 * | Same day | 25 | Falls off over five days, because clearing takes time |
 *
 * Returns `null` when the amounts differ, so a caller cannot accidentally treat
 * a non-match as a low-confidence one.
 */
export function score(statement: StatementSide, ledger: LedgerSide): number | null {
  if (statement.amountIqd !== ledger.amountIqd) return null;

  const gap = Math.abs(daysBetween(ledger.postingDate, statement.bookingDate));
  if (gap > DATE_TOLERANCE_DAYS) return null;

  let confidence = 10; // The amount matched and the dates are close.

  const statementRef = normalise(statement.reference);
  const ledgerRef = normalise(ledger.reference);
  if (statementRef && ledgerRef) {
    if (statementRef === ledgerRef) confidence += 40;
    else if (statementRef.includes(ledgerRef) || ledgerRef.includes(statementRef)) {
      confidence += 25;
    }
  }

  const statementParty = normalise(statement.counterparty);
  const ledgerParty = normalise(ledger.counterparty);
  if (statementParty && ledgerParty && statementParty === ledgerParty) confidence += 25;

  confidence += Math.round((25 * (DATE_TOLERANCE_DAYS - gap)) / DATE_TOLERANCE_DAYS);

  return Math.min(confidence, 100);
}

/**
 * §17 — *"automatic matching … with manual confirmation."*
 *
 * One-to-one pairs, best first, each entry used once. Deterministic: the same
 * books give the same suggestions, because a workspace that reshuffled itself
 * between two people looking at it is a workspace neither of them trusts.
 *
 * **Nothing here is confirmed.** Every result is a suggestion; §17 gives the
 * confirming to a person, and this returns the evidence they need to do it.
 */
export function proposeMatches(
  statementLines: readonly StatementSide[],
  ledgerItems: readonly LedgerSide[],
): Suggestion[] {
  const candidates: { statement: string; ledger: string; confidence: number; why: string }[] = [];

  for (const line of statementLines) {
    for (const item of ledgerItems) {
      const confidence = score(line, item);
      if (confidence === null) continue;

      const reasons: string[] = [`amount ${toDecimalString(line.amountIqd, 4n)}`];
      if (normalise(line.reference) && normalise(line.reference) === normalise(item.reference)) {
        reasons.push(`reference ${line.reference}`);
      }
      if (
        normalise(line.counterparty) &&
        normalise(line.counterparty) === normalise(item.counterparty)
      ) {
        reasons.push(`counterparty ${line.counterparty}`);
      }
      const gap = Math.abs(daysBetween(item.postingDate, line.bookingDate));
      reasons.push(gap === 0 ? 'same day' : `${gap} day${gap === 1 ? '' : 's'} apart`);

      candidates.push({
        statement: line.id,
        ledger: item.id,
        confidence,
        why: reasons.join(', '),
      });
    }
  }

  candidates.sort((a, b) => {
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    if (a.statement !== b.statement) return a.statement < b.statement ? -1 : 1;
    return a.ledger < b.ledger ? -1 : 1;
  });

  const usedStatement = new Set<string>();
  const usedLedger = new Set<string>();
  const matches: Suggestion[] = [];

  for (const candidate of candidates) {
    if (usedStatement.has(candidate.statement) || usedLedger.has(candidate.ledger)) continue;
    usedStatement.add(candidate.statement);
    usedLedger.add(candidate.ledger);
    matches.push({
      statementLineIds: [candidate.statement],
      ledgerItemIds: [candidate.ledger],
      confidence: candidate.confidence,
      why: candidate.why,
    });
  }

  return matches;
}

export class MatchDoesNotBalanceError extends Error {
  readonly code = 'MATCH_DOES_NOT_BALANCE';

  constructor(
    readonly statementIqd: bigint,
    readonly ledgerIqd: bigint,
  ) {
    super(
      `The statement side of this match totals ${toDecimalString(statementIqd, 4n)} and the ledger ` +
        `side totals ${toDecimalString(ledgerIqd, 4n)}. ` +
        'A match says "these are the same money", and money that is not equal is not the same ' +
        'money (§17). If the difference is a bank charge or a fee, post it as an adjustment and ' +
        'match that too — which records what the difference *was*.',
    );
    this.name = 'MatchDoesNotBalanceError';
  }
}

/**
 * §17, and the §12.5 case Phase 09 depends on.
 *
 * A match is a set of statement lines against a set of ledger items, and the two
 * sides must total the same. Modelling it as a *set* rather than a pair is what
 * makes the Money Transfer batch work: §12.5 puts one bank debit against several
 * internally separate transfers, each keeping its own document, client, branch
 * and margin, and requires the batch total to reconcile to the single statement
 * amount. One-to-one matching cannot express that, and retrofitting it later
 * would mean rebuilding the workspace.
 */
export function assertMatchBalances(
  statementAmounts: readonly bigint[],
  ledgerAmounts: readonly bigint[],
): void {
  const statementIqd = statementAmounts.reduce((total, amount) => total + amount, 0n);
  const ledgerIqd = ledgerAmounts.reduce((total, amount) => total + amount, 0n);

  if (statementIqd !== ledgerIqd) throw new MatchDoesNotBalanceError(statementIqd, ledgerIqd);
}

// ---------------------------------------------------------------------------
// The reconciliation arithmetic — §17 acceptance criterion 3
// ---------------------------------------------------------------------------

export interface ReconciliationInput {
  /** The bank's closing balance, from the statement. */
  readonly statementClosingIqd: bigint;
  /** The G/L balance of the mapped account at the same date. */
  readonly ledgerBalanceIqd: bigint;
  /**
   * Ledger debits with no statement line yet — money we have recorded receiving
   * that the bank has not yet shown.
   */
  readonly depositsInTransitIqd: bigint;
  /**
   * Ledger credits with no statement line yet — payments we have recorded
   * making that the bank has not yet taken. Given as a positive number.
   */
  readonly unpresentedPaymentsIqd: bigint;
}

export interface ReconciliationResult {
  /** What the bank's balance becomes once timing differences are applied. */
  readonly reconciledBalanceIqd: bigint;
  /** Reconciled balance less the G/L. Zero is the goal. */
  readonly differenceIqd: bigint;
  readonly balanced: boolean;
}

/**
 * §17 acceptance criterion 3 — *"reconciled bank balance agrees to the G/L for
 * the same date."*
 *
 * The classic arithmetic, and worth writing out because the sign of each term is
 * where reconciliations go wrong:
 *
 * ```text
 *   bank's closing balance
 * + deposits in transit        (we have it, the bank has not shown it yet)
 * − unpresented payments       (we have paid it, the bank has not taken it yet)
 * = the reconciled balance, which should equal the G/L
 * ```
 *
 * **Timing differences are not errors.** A cheque written on the 28th and
 * presented on the 3rd makes the two records disagree, and both are right. What
 * is left after applying them is the *unexplained* difference, and that is the
 * only figure §17 refuses to let anybody finalise over.
 */
export function reconcile(input: ReconciliationInput): ReconciliationResult {
  const reconciledBalanceIqd =
    input.statementClosingIqd + input.depositsInTransitIqd - input.unpresentedPaymentsIqd;

  const differenceIqd = reconciledBalanceIqd - input.ledgerBalanceIqd;

  return { reconciledBalanceIqd, differenceIqd, balanced: differenceIqd === 0n };
}

export class UnexplainedDifferenceError extends Error {
  readonly code = 'UNEXPLAINED_DIFFERENCE';

  constructor(readonly differenceIqd: bigint) {
    super(
      `The reconciliation is out by ${toDecimalString(differenceIqd, 4n)} and §17 will not let it ` +
        'be finalised. Either the difference is a real item — a bank charge, interest, a returned ' +
        'payment — in which case post the adjustment and match it, or something is missing, in ' +
        'which case finalising would put a tick against a balance nobody has agreed.',
    );
    this.name = 'UnexplainedDifferenceError';
  }
}

/**
 * §17 — *"reconciliation cannot be finalised with unexplained differences unless
 * an authorised adjustment is posted."*
 *
 * The sentence has two halves and both matter. A difference blocks the
 * finalisation; posting an adjustment does not *waive* the block, it removes the
 * difference by explaining it — the adjustment is a real journal, matched to a
 * real statement line, and afterwards the arithmetic balances on its own.
 *
 * So there is no override flag here, and that is deliberate. A flag would let
 * somebody finalise over a difference they had not explained, which is the exact
 * outcome §17 is written to prevent.
 */
export function assertFinalisable(result: ReconciliationResult): void {
  if (!result.balanced) throw new UnexplainedDifferenceError(result.differenceIqd);
}
