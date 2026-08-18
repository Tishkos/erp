/**
 * Credit control — Phase 06.3, §7.3 and §16.
 *
 * > §7.3: *"Customer Credit Limit, Payment Terms, Available Credit, Outstanding
 * > Balance, Overdue Balance and Open Order Exposure shall be calculated in real
 * > time. The system shall block approval when the Credit Limit is exceeded.
 * > Only the Sales Manager can override the block, and the reason is mandatory."*
 * > §16: *"Credit limit overrides require reason, amount, expiry and approver."*
 * > §7.7: *"Customer exposure includes open orders, invoices, receipts, credit
 * > memos and approved overrides."*
 *
 * **Exposure is five things, not one.** The temptation is to hold a single
 * "customer balance" and compare it with the limit. That number cannot be
 * audited and cannot be explained to the customer, and it goes wrong in the one
 * case that matters: goods that have gone out of the door and not yet been
 * invoiced are real exposure the ledger does not yet show. §16 names the
 * components, so they stay named.
 *
 * | Component | What it is | Why it counts |
 * |---|---|---|
 * | Outstanding invoices | Posted, unpaid | The debt |
 * | Open orders | Approved, undelivered | Committed to supply on credit |
 * | Delivered not invoiced | Gone, unbilled | Real risk the A/R ledger cannot see |
 * | Credit memos | Agreed credits | Reduces exposure |
 * | Advances / deposits | Money held | Reduces exposure |
 *
 * **An override is a dated permission, not a flag.** §16 asks for four things —
 * reason, amount, expiry and approver — and each of them is there because a
 * permanent, unattributed, unlimited waiver is how credit control stops
 * existing. So an override raises the ceiling by a stated amount, until a stated
 * date, granted by a named person, for a stated reason; and on the day after,
 * the ceiling is what it was.
 */

/** Money is scaled at 10^4 throughout. */
const MONEY_SCALE = 10_000n;

export interface ExposureComponents {
  /** Posted A/R invoices, unpaid portion. */
  readonly outstandingInvoicesIqd: bigint;
  /** Approved sales orders not yet delivered. */
  readonly openOrdersIqd: bigint;
  /** Delivered and not yet invoiced — §16's own words. */
  readonly deliveredNotInvoicedIqd: bigint;
  /** Credit memos not yet applied. Reduces exposure. */
  readonly unappliedCreditMemosIqd: bigint;
  /** Customer advances and deposits held. Reduces exposure. */
  readonly customerAdvancesIqd: bigint;
}

export const NO_EXPOSURE: ExposureComponents = Object.freeze({
  outstandingInvoicesIqd: 0n,
  openOrdersIqd: 0n,
  deliveredNotInvoicedIqd: 0n,
  unappliedCreditMemosIqd: 0n,
  customerAdvancesIqd: 0n,
});

/**
 * §7.3's *"Open Order Exposure"* and §16's composition, totalled.
 *
 * Credits are subtracted rather than netted away at source: the components stay
 * visible so a credit controller can answer *"why is this customer at their
 * limit?"* with a sentence rather than a spreadsheet.
 */
export function totalExposure(components: ExposureComponents): bigint {
  return (
    components.outstandingInvoicesIqd +
    components.openOrdersIqd +
    components.deliveredNotInvoicedIqd -
    components.unappliedCreditMemosIqd -
    components.customerAdvancesIqd
  );
}

/**
 * §16 — a credit-limit override.
 *
 * All four fields are required by the blueprint and all four are required here.
 * `amountIqd` is how much the ceiling is raised *by*, not what it is raised
 * *to*: a customer's limit may change while an override is live, and an override
 * expressed as an absolute figure would then silently lower it.
 */
export interface CreditOverride {
  readonly amountIqd: bigint;
  /** ISO date. The last day the override is good for, inclusive. */
  readonly expiresOn: string;
  readonly approvedByUserId: string;
  readonly reason: string;
}

export class CreditOverrideInvalidError extends Error {
  readonly code = 'CREDIT_OVERRIDE_INVALID';
  constructor(detail: string) {
    super(`A credit-limit override needs ${detail} (§16).`);
    this.name = 'CreditOverrideInvalidError';
  }
}

/** §16 — refuses an override missing any of the four things §16 names. */
export function assertOverrideComplete(override: CreditOverride): void {
  if (override.amountIqd <= 0n) {
    throw new CreditOverrideInvalidError('an amount — an override of nothing raises nothing');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(override.expiresOn)) {
    throw new CreditOverrideInvalidError(
      'an expiry date — a permanent override is the credit limit being changed, which is a different decision',
    );
  }
  if (!override.approvedByUserId) {
    throw new CreditOverrideInvalidError('a named approver — only the Sales Manager may grant one (§7.3)');
  }
  if (override.reason.trim().length === 0) {
    throw new CreditOverrideInvalidError(
      'a reason, and the blueprint calls it mandatory — an override nobody can explain is a limit nobody enforces',
    );
  }
}

/** Whether an override still applies on the given date. Inclusive of expiry. */
export function isOverrideLive(override: CreditOverride, onDate: string): boolean {
  return onDate <= override.expiresOn;
}

export interface CreditPosition {
  readonly limitIqd: bigint;
  readonly exposureIqd: bigint;
  /** The override in force, if any, on the date asked about. */
  readonly overrideIqd: bigint;
  /** limit + live override − exposure. Negative means over the line. */
  readonly availableIqd: bigint;
  readonly withinLimit: boolean;
}

/**
 * §7.3 — the position, as of a date.
 *
 * The date matters because the override expires on one, and "is this customer
 * within their limit?" has a different answer the day after.
 */
export function positionFor(input: {
  readonly limitIqd: bigint;
  readonly components: ExposureComponents;
  readonly override?: CreditOverride | null;
  readonly onDate: string;
}): CreditPosition {
  const exposureIqd = totalExposure(input.components);
  const overrideIqd =
    input.override && isOverrideLive(input.override, input.onDate) ? input.override.amountIqd : 0n;

  const availableIqd = input.limitIqd + overrideIqd - exposureIqd;

  return {
    limitIqd: input.limitIqd,
    exposureIqd,
    overrideIqd,
    availableIqd,
    withinLimit: availableIqd >= 0n,
  };
}

export class CreditLimitExceededError extends Error {
  readonly code = 'CREDIT_LIMIT_EXCEEDED';

  constructor(
    readonly customerCode: string,
    readonly position: CreditPosition,
    readonly requestedIqd: bigint,
  ) {
    const money = (v: bigint) => {
      const negative = v < 0n;
      const abs = negative ? -v : v;
      const whole = abs / MONEY_SCALE;
      const fraction = (abs % MONEY_SCALE).toString().padStart(4, '0').replace(/0+$/, '');
      return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
    };

    super(
      `${customerCode} has ${money(position.availableIqd)} of credit available and this order needs ` +
        `${money(requestedIqd)} (§7.3). Exposure is ${money(position.exposureIqd)} against a limit of ` +
        `${money(position.limitIqd)}${position.overrideIqd > 0n ? ` plus an override of ${money(position.overrideIqd)}` : ''}. ` +
        'The Sales Manager can raise the limit for a stated amount and period, with a reason.',
    );
    this.name = 'CreditLimitExceededError';
  }
}

/**
 * §7.3 — *"The system shall block approval when the Credit Limit is exceeded."*
 *
 * Judged on the order being approved *plus* what is already out, because the
 * question is not "was this customer within their limit this morning?" but "will
 * they be when this order is committed?"
 *
 * A zero limit is a customer with no credit, and it blocks. There is no
 * "unlimited" — a customer who should have no ceiling has a large one, stated,
 * which somebody decided and can be found.
 */
export function assertWithinCredit(input: {
  readonly customerCode: string;
  readonly limitIqd: bigint;
  readonly components: ExposureComponents;
  readonly override?: CreditOverride | null;
  readonly onDate: string;
  /** The order about to be approved, at its net value. */
  readonly requestedIqd: bigint;
}): CreditPosition {
  const position = positionFor(input);

  if (input.requestedIqd > position.availableIqd) {
    throw new CreditLimitExceededError(input.customerCode, position, input.requestedIqd);
  }

  return position;
}

/**
 * §16 acceptance criterion 3 — *"a credit hold immediately affects order
 * confirmation."*
 *
 * A hold is not a limit of zero. It is a decision that this customer is not to
 * be supplied on credit at all, whatever their limit and whatever their
 * balance — so it is checked first and no override amount reaches it. Only
 * lifting the hold lifts the hold.
 */
export class CustomerOnCreditHoldError extends Error {
  readonly code = 'CUSTOMER_ON_CREDIT_HOLD';
  constructor(readonly customerCode: string) {
    super(
      `${customerCode} is on credit hold, so no order can be approved on credit (§16). ` +
        'A credit-limit override does not lift a hold — only lifting the hold does. ' +
        'A cash sale is a different document (§7.8).',
    );
    this.name = 'CustomerOnCreditHoldError';
  }
}

export function assertNotOnCreditHold(customerCode: string, onHold: boolean): void {
  if (onHold) throw new CustomerOnCreditHoldError(customerCode);
}

export { MONEY_SCALE };
