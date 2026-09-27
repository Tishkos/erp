/**
 * Finding one record from what somebody typed.
 *
 * A drop-down is fine for five warehouses and useless for a year of invoices:
 * nobody scrolls to the invoice they want, they type its number — or part of the
 * customer's name, and then its number. These are the two steps that needs.
 *
 * Deliberately not a fuzzy match. A return is raised against one invoice, and a
 * search that guesses which of two a person meant is worse than one that says it
 * cannot tell: the first posts the wrong document, the second asks again.
 */

/** Case-insensitive, ignoring the spaces around it. */
function normalise(text: string): string {
  return text.trim().toLocaleLowerCase();
}

/**
 * The rows a typed phrase could mean, matched across every field given.
 *
 * Each whitespace-separated word must appear somewhere in the row, so
 * "issa sep" narrows the same way a person reads it — not as one string to find
 * but as two things that must both be true.
 */
export function matching<T>(
  rows: readonly T[],
  phrase: string,
  fields: (row: T) => readonly (string | null | undefined)[],
): readonly T[] {
  const words = normalise(phrase).split(/\s+/).filter(Boolean);
  if (words.length === 0) return rows;
  return rows.filter((row) => {
    const haystack = normalise(fields(row).filter(Boolean).join(' '));
    return words.every((word) => haystack.includes(word));
  });
}

/**
 * The one row a phrase names, or nothing.
 *
 * An exact key wins outright — a person who typed or picked a whole invoice
 * number has said which one, even if that number reads as part of another. Short
 * of that, a phrase that narrows to exactly one row is taken as naming it, and
 * anything still ambiguous is not guessed at.
 */
export function pickOne<T>(
  rows: readonly T[],
  phrase: string,
  key: (row: T) => string,
  fields: (row: T) => readonly (string | null | undefined)[] = (row) => [key(row)],
): T | null {
  const wanted = normalise(phrase);
  if (!wanted) return null;

  const exact = rows.filter((row) => normalise(key(row)) === wanted);
  if (exact.length === 1) return exact[0]!;

  const near = matching(rows, phrase, fields);
  return near.length === 1 ? near[0]! : null;
}

/** Why nothing was picked, so the screen can say which of the two it was. */
export type PickOutcome = 'empty' | 'found' | 'none' | 'ambiguous';

export function pickOutcome<T>(
  rows: readonly T[],
  phrase: string,
  key: (row: T) => string,
  fields: (row: T) => readonly (string | null | undefined)[] = (row) => [key(row)],
): PickOutcome {
  if (!normalise(phrase)) return 'empty';
  if (pickOne(rows, phrase, key, fields)) return 'found';
  return matching(rows, phrase, fields).length === 0 ? 'none' : 'ambiguous';
}
