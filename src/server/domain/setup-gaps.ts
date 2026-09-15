/**
 * Why a document cannot be raised yet, said precisely.
 *
 * The Sales Invoice form told somebody "Add a customer first" while their
 * Customers screen was showing a customer. Both were true and neither was
 * useful: the customer existed and had been deactivated, so the picker was
 * empty and the message described a different problem from the one they had.
 *
 * §25 asks for the field, the reason and the corrective action. "Add a
 * customer" is a corrective action for an empty table; it is a wrong
 * instruction for a table with one inactive row in it, and following it makes a
 * second customer nobody wanted.
 *
 * So the distinction is drawn here rather than in six screens: nothing exists,
 * or things exist and none of them can be used.
 */
export interface Gap {
  /** The translation key under `admin.setup`. */
  readonly key: string;
  /** How many exist but cannot be used — only set when that is the case. */
  readonly count?: number;
}

/**
 * Reports the gap, or nothing when there is none.
 *
 * `total` counts the records of that kind; `usable` counts the ones a document
 * can actually name. They differ exactly when something is there and cannot be
 * used, which is the case worth a different sentence.
 */
export function gapFor(kind: string, total: number, usable: number): Gap | null {
  if (usable > 0) return null;
  if (total === 0) return { key: `no_${kind}` };
  return { key: `no_active_${kind}`, count: total };
}

/** Every gap on a form, in the order the fields appear on it. */
export function gapsFor(
  counts: readonly { readonly kind: string; readonly total: number; readonly usable: number }[],
): Gap[] {
  return counts
    .map((entry) => gapFor(entry.kind, entry.total, entry.usable))
    .filter((gap): gap is Gap => gap !== null);
}
