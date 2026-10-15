/**
 * The rules of a kept form (2026-10-15) — no browser here, so they are tested
 * on their own. `components/admin/form-memory.tsx` is the browser half.
 */

/** Every kept form's key starts with this, then the person, then the form and its record. */
export const FORM_MEMORY_PREFIX = 'qimah:form:';

/** A draft nobody came back to for this long is let go. */
export const FORM_MEMORY_DAYS = 14;

/** Each field name's values, in the order the page draws its fields. */
export type StoredValues = Readonly<Record<string, readonly string[]>>;

export interface StoredForm {
  readonly v: 1;
  readonly title: string;
  readonly href: string;
  /** ISO time of the last change. */
  readonly savedAt: string;
  /** Set when the form was sent: a save that went through leaves nothing to restore. */
  readonly submittedAt: string | null;
  readonly values: StoredValues;
}

export function memoryKey(owner: string, storageKey: string): string {
  return `${FORM_MEMORY_PREFIX}${owner}:${storageKey}`;
}

/** A stored entry, when it is one this version wrote; else null. */
export function parseStored(raw: string | null | undefined): StoredForm | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredForm>;
    if (value?.v !== 1 || typeof value.savedAt !== 'string' || typeof value.values !== 'object' || value.values === null) return null;
    return {
      v: 1,
      title: typeof value.title === 'string' ? value.title : '',
      href: typeof value.href === 'string' ? value.href : '',
      savedAt: value.savedAt,
      submittedAt: typeof value.submittedAt === 'string' ? value.submittedAt : null,
      values: value.values as StoredValues,
    };
  } catch {
    return null;
  }
}

/** The entry under `key` in this browser, or null (none, unreadable, or storage refused). */
export function readStored(key: string): StoredForm | null {
  try {
    return parseStored(globalThis.localStorage?.getItem(key));
  } catch {
    return null;
  }
}

export function isExpired(entry: Pick<StoredForm, 'savedAt'>, now: number): boolean {
  const saved = Date.parse(entry.savedAt);
  return !Number.isFinite(saved) || now - saved > FORM_MEMORY_DAYS * 86_400_000;
}

/**
 * Whether a kept entry is put back into the form: not expired, and either
 * never sent or sent and refused (the page came back with `?error=`). A form
 * sent without a refusal was saved — its record exists — so it starts empty.
 */
export function shouldRestore(entry: StoredForm, at: { readonly refused: boolean; readonly now: number }): boolean {
  if (isExpired(entry, at.now)) return false;
  return entry.submittedAt === null || at.refused;
}

/** Nothing was typed: every field holds what the page drew it with. */
export function isEmptyChange(initial: StoredValues, current: StoredValues): boolean {
  const names = new Set([...Object.keys(initial), ...Object.keys(current)]);
  for (const name of names) {
    const a = initial[name] ?? [];
    const b = current[name] ?? [];
    // A field that is not there (a grid's row not drawn yet) reads as blank.
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      if ((a[index] ?? '') !== (b[index] ?? '')) return false;
    }
  }
  return true;
}

export interface Draft {
  readonly key: string;
  readonly entry: StoredForm;
}

/** The drafts under `prefix` still in progress — not sent, not expired — the latest first. */
export function draftsOf(pairs: readonly (readonly [string, string])[], prefix: string, now: number): Draft[] {
  const drafts: Draft[] = [];
  for (const [key, raw] of pairs) {
    if (!key.startsWith(prefix)) continue;
    const entry = parseStored(raw);
    if (!entry || entry.submittedAt !== null || isExpired(entry, now)) continue;
    drafts.push({ key, entry });
  }
  return drafts.sort((a, b) => b.entry.savedAt.localeCompare(a.entry.savedAt));
}
