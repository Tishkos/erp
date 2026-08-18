/**
 * Days Sales Outstanding — Phase 06.11, §22's KPI dictionary.
 *
 * > §22: *"**Days sales outstanding** — receivable collection indicator
 * > calculated from the **approved management formula** and **documented period
 * > basis**."*
 *
 * The blueprint gives no formula. It says the formula is management's and asks
 * that it be documented, which makes choosing one a business decision under
 * §28.1 rather than a technical one — so it is raised as **D12** in
 * `docs/DECISIONS.md` and this module is written to make changing the answer
 * cheap.
 *
 * **What is built, pending that decision.** The classic formula:
 *
 *     DSO = (closing A/R ÷ credit sales in the period) × days in the period
 *
 * on **credit sales only**, over a caller-supplied range. That is the most
 * common reading and the one a Finance reader is least likely to be surprised
 * by. Two other readings are live and neither is wrong — a countback, and an
 * average-balance variant — and D12 sets out all three.
 *
 * **Why the components are parameters rather than a query.** The A/R balance and
 * the credit-sales figure are *facts*, produced by the ageing and the ledger.
 * DSO is an *opinion* about those facts. Keeping the opinion in one small pure
 * function means changing it later touches one function and its tests, not the
 * reports that supply the numbers.
 *
 * **Cash sales are excluded, and that is a choice worth naming.** A cash sale is
 * collected the day it is made, so counting it lowers DSO — arithmetically true
 * and arguably misleading, since DSO exists to measure how long *credit* takes
 * to collect. QS makes both kinds of sale (§7.4), so the distinction matters here
 * more than at most companies. D12 asks the owner to confirm it.
 *
 * Pure. Money is scaled at 10^4; the result is days, scaled at 10^4 so a DSO of
 * 45.5 days is exact rather than rounded to 45 or 46.
 */
import { daysBetween } from './dates';

/** Days are scaled at 10^4, like money, so a fractional day is exact. */
export const DAY_SCALE = 10_000n;

export interface DsoComponents {
  /** Receivables outstanding at the end of the period. */
  readonly closingReceivableIqd: bigint;
  /** Sales made on credit in the period — see the note above on cash sales. */
  readonly creditSalesIqd: bigint;
  /** Inclusive of both ends: 1–31 January is 31 days. */
  readonly from: string;
  readonly to: string;
}

export class DsoUncomputableError extends Error {
  readonly code = 'DSO_UNCOMPUTABLE';

  constructor(readonly reason: string) {
    super(
      `Days Sales Outstanding cannot be computed: ${reason}. ` +
        'A KPI that returned a number here would be inventing one, which is worse than ' +
        'reporting that the period has no answer (§22).',
    );
    this.name = 'DsoUncomputableError';
  }
}

/** Days in the period, both ends inclusive. */
export function daysInPeriod(from: string, to: string): number {
  const days = daysBetween(from, to) + 1;
  if (days <= 0) {
    throw new DsoUncomputableError(`'${to}' is before '${from}'`);
  }
  return days;
}

/**
 * §22's DSO — the classic formula, pending D12.
 *
 * Returns days scaled at 10^4. A period with **no credit sales** has no DSO:
 * dividing by zero would be an error, and reporting zero days would say the
 * company collects instantly, which is the opposite of what an empty period
 * means. So it throws, and the report shows "—" rather than a made-up figure.
 */
export function daysSalesOutstanding(components: DsoComponents): bigint {
  const days = daysInPeriod(components.from, components.to);

  if (components.creditSalesIqd <= 0n) {
    throw new DsoUncomputableError(
      `there were no credit sales between ${components.from} and ${components.to}`,
    );
  }

  if (components.closingReceivableIqd < 0n) {
    throw new DsoUncomputableError(
      'the closing receivable balance is negative, which means customers are in credit rather than in debt',
    );
  }

  // Multiply before dividing, so the scale survives: a ratio computed first
  // would truncate to whole units and lose the fraction entirely.
  return (
    (components.closingReceivableIqd * BigInt(days) * DAY_SCALE) / components.creditSalesIqd
  );
}

/** Whether DSO can be computed at all, without throwing — for a dashboard. */
export function canComputeDso(components: DsoComponents): boolean {
  try {
    daysSalesOutstanding(components);
    return true;
  } catch {
    return false;
  }
}

/** Formats scaled days for a report: 455000 → "45.5". */
export function formatDays(scaledDays: bigint): string {
  const whole = scaledDays / DAY_SCALE;
  const fraction = (scaledDays % DAY_SCALE).toString().padStart(4, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/**
 * The other formula D12 offers, built so the decision is a one-line change
 * rather than a rewrite.
 *
 * The **countback**: walk back through the periods, consuming the receivable
 * balance against each period's sales until it is used up. The answer is how far
 * back you had to go, which follows the actual ageing of the debt rather than
 * assuming it is spread evenly.
 *
 * Not wired to anything yet — it exists so that "which formula?" is a question
 * with two working answers to compare rather than one built and one imagined.
 */
export function daysSalesOutstandingCountback(input: {
  readonly closingReceivableIqd: bigint;
  /** Most recent period first. Each is that period's credit sales and length. */
  readonly periods: readonly { readonly creditSalesIqd: bigint; readonly days: number }[];
}): bigint {
  let remaining = input.closingReceivableIqd;
  let days = 0n;

  for (const period of input.periods) {
    if (remaining <= 0n) break;

    if (remaining >= period.creditSalesIqd) {
      // The whole of this period's sales is still outstanding.
      remaining -= period.creditSalesIqd;
      days += BigInt(period.days) * DAY_SCALE;
      continue;
    }

    // Part of it: the fraction of the period the remainder represents.
    if (period.creditSalesIqd > 0n) {
      days += (remaining * BigInt(period.days) * DAY_SCALE) / period.creditSalesIqd;
    }
    remaining = 0n;
  }

  if (remaining > 0n) {
    throw new DsoUncomputableError(
      'the receivable balance is larger than every period of sales supplied, so the countback ran out of history',
    );
  }

  return days;
}
