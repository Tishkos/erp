/**
 * Imports paid after the goods arrive (0426, 2026-10-24, by direction: "import
 * application payment after import … like the whole import is done then [we
 * pay]"; "a button where we skip … the current import which pays later").
 *
 * An import is flagged `payable.pay_after_arrival`. Nothing about it asks for
 * money in front: no advance is agreed on its invoices, no goods wait in On
 * Process (Without SWIFT), and the payment clocks of the nightly sweep
 * (`invoice_unfunded`, `swift_pending`, `transfer_pending`) do not run until
 * every live container of it is received. Once the goods are in, the clocks
 * run from the day the last container came in — never from an earlier date,
 * so an import that was months at sea is not stopped the morning after it
 * lands. A payment application may still be raised whenever somebody chooses.
 *
 * Pure: the sweep reads the facts in SQL and asks here.
 */

/** The register's Payment timing filter (`timing` in the address). */
export const PAYMENT_TIMINGS = ['before_arrival', 'after_arrival'] as const;
export type PaymentTiming = (typeof PAYMENT_TIMINGS)[number];

export function paymentTimingOf(value: unknown): PaymentTiming | null {
  return typeof value === 'string' && (PAYMENT_TIMINGS as readonly string[]).includes(value)
    ? (value as PaymentTiming)
    : null;
}

/**
 * Where a payment clock starts, or null when it does not run yet.
 *
 *   * an import paid before arrival: the clock's own start (`since`);
 *   * an import paid after arrival whose goods are not all in (`arrivedOn`
 *     null): no clock;
 *   * one whose goods are all in: the later of its own start and the day the
 *     last container was received.
 *
 * Dates are ISO `YYYY-MM-DD`, which compare as strings.
 */
export function paymentClockStart(
  since: string,
  payAfterArrival: boolean,
  arrivedOn: string | null,
): string | null {
  if (!payAfterArrival) return since;
  if (!arrivedOn) return null;
  return arrivedOn > since ? arrivedOn : since;
}

export class PayAfterArrivalError extends Error {
  readonly code = 'PAY_AFTER_ARRIVAL';
  constructor(detail: string) {
    super(detail);
    this.name = 'PayAfterArrivalError';
  }
}

/**
 * An invoice of an import paid after arrival agrees no advance: asking for
 * money in front is the one thing such an import does not do.
 */
export function assertNoAdvance(payableNo: string | null, advanceAsked: boolean): void {
  if (!advanceAsked) return;
  throw new PayAfterArrivalError(
    `${payableNo ?? 'This import'} is paid after the goods arrive, so its invoice asks no advance. ` +
      'Choose "No upfront payment", or untick "Pay after the goods arrive" (on the import, "Pay before arrival again").',
  );
}
