/**
 * Payment proposal and payment batch rules — Phase 07.2 and 07.3, §15 and §17.
 *
 * > §15: *"Include due items in payment proposal based on **due date, priority,
 * > discount and available cash**."*
 * > §15 acceptance criterion 2: *"Payment proposal includes only **eligible
 * > approved** items."*
 * > §17: *"Creator, approver and executor shall be different users for
 * > **high-risk** payments."*
 * > §17: *"Payments cannot use inactive/unverified beneficiary bank details."*
 *
 * A payment run is the one place in the system where the machine proposes and a
 * person disposes. Everything here is therefore written to be **inspectable**:
 * an item that is not being paid says why, an item that is being paid says what
 * put it in front of the others, and neither answer is a number the caller has
 * to reverse-engineer from a total.
 *
 * Pure. Money is scaled at 10^4; percentages at 10^4.
 */
import { toDecimalString } from './money';

// ---------------------------------------------------------------------------
// Eligibility — §15 criterion 2
// ---------------------------------------------------------------------------

/**
 * Why an item is, or is not, in the run.
 *
 * Exclusions are **values, not silence.** A proposal that simply omitted a
 * blocked supplier would leave Finance asking why an expected payment was
 * missing, and the answer — somebody blocked them — is the most useful line on
 * the report. The same goes for an item that fits the criteria perfectly and
 * only misses out because the money ran out: `deferred_funds` is the difference
 * between "we decided not to" and "we could not".
 */
export const INCLUSIONS = [
  'selected',
  'deferred_funds',
  'excluded_not_due',
  'excluded_unapproved',
  'excluded_settled',
  'excluded_blocked',
  'excluded_no_bank_details',
  'excluded_currency',
] as const;

export type Inclusion = (typeof INCLUSIONS)[number];

export interface Candidate {
  /** Whatever identifies the item to the caller — invoice or advance number. */
  readonly reference: string;
  readonly supplierCode: string;
  /** §15 — what is still owed. Never zero for a real candidate. */
  readonly outstandingIqd: bigint;
  readonly dueDate: string;
  readonly currency: string;
  /** 1 is the most urgent. See `rank`. */
  readonly priority: number;
  /** Posted debts only; anything else is not yet a debt (§15). */
  readonly documentStatus: string;
  readonly supplierStatus: string;
  /** Approved, active, verified beneficiary details — or none (§17). */
  readonly hasPayableBankDetails: boolean;
  /** Set when an early-settlement discount is still open on the pay date. */
  readonly discountIqd?: bigint;
  readonly discountDeadline?: string | null;
}

export interface Classified extends Candidate {
  readonly inclusion: Inclusion;
  readonly reason: string | null;
}

/**
 * §15 — *"only eligible approved items."*
 *
 * The order of the tests is the order a person would apply them, and it matters
 * only in that the **first** true reason is the one reported. A settled invoice
 * belonging to a blocked supplier is reported as settled, because that is the
 * fact that ends the question.
 */
export function classify(candidate: Candidate, payOn: string, accountCurrency: string): Classified {
  const reject = (inclusion: Inclusion, reason: string): Classified => ({
    ...candidate,
    inclusion,
    reason,
  });

  // Status before amount. An unposted invoice has no total yet — the ledger
  // fixes it at posting — so reading its zero as "already paid" would be a
  // confident answer to a question that has not been asked yet.
  const live =
    candidate.documentStatus === 'posted' ||
    candidate.documentStatus === 'partially_executed' ||
    candidate.documentStatus === 'settled';

  if (!live) {
    return reject(
      'excluded_unapproved',
      `${candidate.reference} is '${candidate.documentStatus}'. It is not a debt until it is approved and posted (§15).`,
    );
  }

  if (candidate.documentStatus === 'settled' || candidate.outstandingIqd <= 0n) {
    return reject('excluded_settled', `${candidate.reference} is already paid in full.`);
  }

  if (candidate.supplierStatus === 'blocked' || candidate.supplierStatus === 'on_hold') {
    return reject(
      'excluded_blocked',
      `${candidate.supplierCode} is ${candidate.supplierStatus.replace('_', ' ')}. ` +
        'Paying them needs an authorised override with a reason (§15), which a proposal cannot grant on its own.',
    );
  }

  if (candidate.currency !== accountCurrency) {
    return reject(
      'excluded_currency',
      `${candidate.reference} is in ${candidate.currency} and the paying account holds ${accountCurrency} (§17).`,
    );
  }

  if (!candidate.hasPayableBankDetails) {
    return reject(
      'excluded_no_bank_details',
      `${candidate.supplierCode} has no approved, active bank details. §17 forbids paying to unverified beneficiary details.`,
    );
  }

  // Last, because paying early is a decision rather than a default: an item that
  // is not yet due is eligible in every other respect and is reported as such.
  if (candidate.dueDate > payOn) {
    return reject(
      'excluded_not_due',
      `${candidate.reference} falls due on ${candidate.dueDate}, after the ${payOn} payment date.`,
    );
  }

  return { ...candidate, inclusion: 'selected', reason: null };
}

// ---------------------------------------------------------------------------
// Ranking — §15's "due date, priority, discount"
// ---------------------------------------------------------------------------

/**
 * The order items are taken in when there is not enough cash for all of them.
 *
 * §15 names three inputs and does not say how they trade off, so this ranks by
 * them in the order §15 itself lists — **priority, then due date, then an
 * expiring discount** — and breaks the remaining ties on the reference so that
 * the same inputs always give the same run. What the priority *scale means* is
 * a business decision and is registered as such (D14); until it is answered
 * every supplier carries the same neutral priority, which makes this an
 * oldest-debt-first ordering in practice.
 *
 * Deterministic on purpose. A proposal that could produce two different answers
 * from the same books is one nobody can check.
 */
export function rank<T extends Candidate>(candidates: readonly T[]): T[] {
  return [...candidates].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;

    const aDiscount = a.discountIqd ?? 0n;
    const bDiscount = b.discountIqd ?? 0n;
    if (aDiscount !== bDiscount) return aDiscount > bDiscount ? -1 : 1;

    return a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Available cash — §15, §17
// ---------------------------------------------------------------------------

export interface Selection {
  readonly selected: Classified[];
  readonly deferred: Classified[];
  readonly excluded: Classified[];
  readonly selectedTotalIqd: bigint;
  readonly deferredTotalIqd: bigint;
}

/**
 * §15 — *"…and available cash."*
 *
 * Takes ranked items until the next one would not fit, and **keeps going**: a
 * large invoice that does not fit does not stop the smaller ones behind it from
 * being paid. That is a real choice and worth naming — the alternative, stopping
 * at the first item that does not fit, pays less of the debt with the same money
 * and leaves cash idle for no reason a supplier would accept.
 *
 * What does *not* happen is part-paying the item that did not fit. A partial
 * payment against an invoice is a decision about that supplier relationship, and
 * §15 gives the proposal no authority to make it.
 */
export function selectWithinFunds(
  classified: readonly Classified[],
  availableIqd: bigint,
): Selection {
  const selected: Classified[] = [];
  const deferred: Classified[] = [];
  const excluded: Classified[] = [];

  let remaining = availableIqd;

  for (const item of rank(classified)) {
    if (item.inclusion !== 'selected') {
      excluded.push(item);
      continue;
    }

    if (item.outstandingIqd <= remaining) {
      selected.push(item);
      remaining -= item.outstandingIqd;
      continue;
    }

    deferred.push({
      ...item,
      inclusion: 'deferred_funds',
      reason:
        `${toDecimalString(item.outstandingIqd, 4n)} does not fit in the ` +
        `${toDecimalString(remaining, 4n)} still available on the paying account (§15). ` +
        'It is eligible in every other respect and will lead the next run.',
    });
  }

  const total = (rows: readonly Classified[]) =>
    rows.reduce((sum, row) => sum + row.outstandingIqd, 0n);

  return {
    selected,
    deferred,
    excluded,
    selectedTotalIqd: total(selected),
    deferredTotalIqd: total(deferred),
  };
}

// ---------------------------------------------------------------------------
// Early-settlement discount — §15, Appendix D
// ---------------------------------------------------------------------------

/**
 * What an early-settlement discount would be worth if the item were paid on a
 * given date — Appendix D's *"discount opportunities"*.
 *
 * **It is an opportunity, not a deduction.** The figure ranks the item and is
 * reported; the payment is still for the full amount owed. Paying less than the
 * invoice says means recognising the difference somewhere, and which account it
 * lands in is an accounting treatment §28.1 reserves to Finance. Nothing here
 * chooses one. Registered with D14.
 */
export function discountOpportunity(input: {
  readonly outstandingIqd: bigint;
  readonly discountPercent: bigint | null;
  readonly discountDeadline: string | null;
  readonly payOn: string;
}): { amountIqd: bigint; open: boolean } {
  const { discountPercent, discountDeadline } = input;

  if (discountPercent === null || discountPercent <= 0n || !discountDeadline) {
    return { amountIqd: 0n, open: false };
  }
  if (input.payOn > discountDeadline) return { amountIqd: 0n, open: false };

  // Percent is scaled at 10^4, so dividing by 100 * 10^4 leaves money at 10^4.
  const amountIqd = (input.outstandingIqd * discountPercent) / 1_000_000n;
  return { amountIqd, open: amountIqd > 0n };
}

// ---------------------------------------------------------------------------
// High risk — §17, Phase 07.3
// ---------------------------------------------------------------------------

/**
 * §17 — *"…for **high-risk** payments."*
 *
 * §17 never says what makes a payment high-risk, so this does not guess. The
 * threshold is the **lowest amount that is high-risk**, it is configuration, and
 * it defaults to zero — which puts every payment above the line until Finance
 * sets a figure. `null` (no policy row at all) means the same thing more
 * strongly.
 *
 * The direction of the default is the whole point: a threshold nobody has set is
 * an unanswered question, not permission to skip the control. Registered as D13.
 */
export function isHighRisk(amountIqd: bigint, thresholdIqd: bigint | null): boolean {
  if (thresholdIqd === null) return true;
  return amountIqd >= thresholdIqd;
}

// ---------------------------------------------------------------------------
// Beneficiary verification — §17, §15
// ---------------------------------------------------------------------------

export class BeneficiaryNotPayableError extends Error {
  readonly code = 'BENEFICIARY_NOT_PAYABLE';

  constructor(
    readonly supplierCode: string,
    readonly problem: 'missing' | 'unapproved' | 'inactive' | 'changed',
  ) {
    const why: Record<string, string> = {
      missing: 'no bank details are recorded for them',
      unapproved: 'their bank details have not been independently approved',
      inactive: 'their bank details are not active',
      changed:
        'their bank details changed after this payment was approved, so the approval was given ' +
        'against a different account number',
    };

    super(
      `Cannot pay ${supplierCode}: ${why[problem]}. ` +
        '§17 forbids paying to inactive or unverified beneficiary bank details, and §15 requires an ' +
        'independent verification of any change — a redirected account number is the highest-value ' +
        'fraud in an ERP and the cheapest to prevent.',
    );
    this.name = 'BeneficiaryNotPayableError';
  }
}

export interface BeneficiaryDetails {
  readonly approvalStatus: string;
  readonly isActive: boolean;
  /** Bumped by the database whenever a payable field changes. */
  readonly revision: number;
}

/**
 * §17 and §15 — the beneficiary check, run **again** at execution.
 *
 * `approvedRevision` is the revision the approver saw. Comparing it at execution
 * is what turns *"bank detail changes require independent verification"* into
 * something the system can enforce rather than something a procedure asks for:
 * the approval was for an account number, and if the account number moved, the
 * approval no longer covers where the money is about to go.
 */
export function assertBeneficiaryPayable(
  supplierCode: string,
  details: BeneficiaryDetails | null,
  approvedRevision?: number | null,
): void {
  if (!details) throw new BeneficiaryNotPayableError(supplierCode, 'missing');
  if (details.approvalStatus !== 'approved') {
    throw new BeneficiaryNotPayableError(supplierCode, 'unapproved');
  }
  if (!details.isActive) throw new BeneficiaryNotPayableError(supplierCode, 'inactive');

  if (approvedRevision !== undefined && approvedRevision !== null) {
    if (details.revision !== approvedRevision) {
      throw new BeneficiaryNotPayableError(supplierCode, 'changed');
    }
  }
}
