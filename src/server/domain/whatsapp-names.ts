/**
 * The names WhatsApp shows for a number — by direction, 2026-10-04: "name
 * them, fetch them from their name in WhatsApp if possible".
 *
 * WhatsApp gives a linked device two names for a number, and neither can be
 * asked for on demand: the one the phone's owner **saved** it under, which
 * arrives with the contact list when the device is linked, and the one the
 * person gave themselves — their **profile** name — which arrives on every
 * message they send. So the bridge keeps what it is shown, as it is shown it,
 * and a contact is matched to its ERP user by somebody reading the two names
 * rather than by the bridge guessing.
 *
 * **Only the numbers that are expected.** The account the bridge is linked to
 * is somebody's own, and its contact list is their whole address book: the
 * book keeps a name only for a number on the expected list (the people named
 * for the group), and nobody else's is ever written down.
 *
 * Pure: `services/whatsapp-names.ts` keeps the book in a file.
 */
export interface KnownName {
  /** As saved on the phone the bridge is linked to. */
  readonly saved?: string;
  /** As the person named themselves on WhatsApp. */
  readonly profile?: string;
  /** When either was last learned. */
  readonly at: string;
}

export type NameBook = Record<string, KnownName>;

/** A name worth keeping: tidied, and not just the number written out again. */
export function tidyName(raw: string | null | undefined): string | null {
  const name = (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!name) return null;
  if (/^[+\d\s().-]+$/.test(name)) return null;
  return name;
}

/**
 * Adds what was just seen to the book. Returns whether anything changed, so
 * the file is written only when there is something new in it.
 */
export function learnName(
  book: NameBook,
  seen: { readonly e164: string; readonly saved?: string | null; readonly profile?: string | null },
  at: string,
): boolean {
  if (!/^\+\d{8,15}$/.test(seen.e164)) return false;
  const saved = tidyName(seen.saved);
  const profile = tidyName(seen.profile);
  if (!saved && !profile) return false;
  const before = book[seen.e164];
  const nextSaved = saved ?? before?.saved;
  const nextProfile = profile ?? before?.profile;
  if (before && before.saved === nextSaved && before.profile === nextProfile) return false;
  book[seen.e164] = {
    ...(nextSaved ? { saved: nextSaved } : {}),
    ...(nextProfile ? { profile: nextProfile } : {}),
    at,
  };
  return true;
}

/** The one name to show for a number: the saved one, else the profile one. */
export function nameOf(book: NameBook, e164: string): string | null {
  const known = book[e164];
  return known?.saved ?? known?.profile ?? null;
}
