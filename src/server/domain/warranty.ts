/**
 * §7.4 warranty — Phase 06.7.
 *
 * > §7.4: *"Warranty starts on the A/R Invoice date. Warranty duration is
 * > maintained in Item Master and the end date is calculated automatically."*
 * > §9.3: *"Warranty fields are optional."*
 *
 * Two sentences, and between them the whole rule: the *start* is a fact about
 * the sale, the *duration* is a fact about the item, and the *end* is neither —
 * it is arithmetic, so nobody types it. A warranty end date that could be
 * entered by hand is one that can be extended by hand, and the first time a
 * customer disputes a repair the company has no answer to *"who changed this?"*
 *
 * And the optionality matters as much: §9.3 makes warranty fields optional, so
 * an item with no duration has **no warranty**, not a warranty of zero months.
 * The two look alike in a database and behave differently at a counter — a
 * zero-length record says *"the warranty expired on the day you bought it"*,
 * which is a claim the company would then have to defend.
 *
 * Pure: no SQL, no clock.
 */
import { addMonths, daysBetween } from './dates';

/**
 * Whether an item carries a warranty at all.
 *
 * `null` and `0` are different answers and are treated differently. Zero months
 * is a deliberate statement that this item is sold without cover, and it still
 * produces no record — see `warrantyFor`.
 */
export function hasWarranty(warrantyMonths: number | null | undefined): boolean {
  return typeof warrantyMonths === 'number' && warrantyMonths > 0;
}

/**
 * The end of a warranty — §7.4's *"calculated automatically"*.
 *
 * Months rather than days, because that is how a warranty is sold: *"one year
 * from purchase"*, not *"365 days"*. `addMonths` clamps to the end of a shorter
 * month, so a sale on 31 January with a one-month warranty ends on 28 February
 * rather than rolling into March — the customer gets the month they were
 * promised and not a day more by accident.
 *
 * Inclusive of the end date: cover on 15 February 2027 is cover *through* that
 * day. The alternative reading would silently shorten every warranty by a day.
 */
export function warrantyEndFor(invoiceDate: string, warrantyMonths: number): string {
  if (!Number.isInteger(warrantyMonths) || warrantyMonths <= 0) {
    throw new RangeError(
      `A warranty of ${warrantyMonths} months is not a duration. An item sold without cover has no duration at all (§9.3).`,
    );
  }

  return addMonths(invoiceDate, warrantyMonths);
}

export interface WarrantyRegistration {
  readonly startsOn: string;
  readonly endsOn: string;
  readonly months: number;
}

/**
 * The warranty a sale creates, or nothing.
 *
 * Returning `null` rather than a zero-length registration is the 06.7 gate:
 * *"items without a warranty duration produce no warranty record rather than a
 * zero-length one."* A caller that must branch cannot forget to.
 */
export function warrantyFor(input: {
  readonly invoiceDate: string;
  readonly warrantyMonths: number | null | undefined;
}): WarrantyRegistration | null {
  if (!hasWarranty(input.warrantyMonths)) return null;

  const months = input.warrantyMonths as number;

  return {
    startsOn: input.invoiceDate,
    endsOn: warrantyEndFor(input.invoiceDate, months),
    months,
  };
}

/**
 * Whether a warranty covers a given day.
 *
 * Both ends inclusive: a unit sold on the 1st with a one-month warranty is
 * covered on the 1st and on the 1st of the next month. Comparison is on ISO
 * date strings, which sort correctly and carry no timezone (TECHSTACK A10) —
 * the same reason business dates are never JS `Date` objects anywhere here.
 */
export function isCovered(
  warranty: { readonly startsOn: string; readonly endsOn: string },
  onDate: string,
): boolean {
  return onDate >= warranty.startsOn && onDate <= warranty.endsOn;
}

/** Days of cover remaining on a date. Zero once it has expired. */
export function coverRemaining(
  warranty: { readonly endsOn: string },
  onDate: string,
): number {
  const days = daysBetween(onDate, warranty.endsOn);
  return days > 0 ? days : 0;
}
