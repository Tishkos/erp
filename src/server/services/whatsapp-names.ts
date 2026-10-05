/**
 * The book of WhatsApp names, kept in a file — `var/whatsapp/names.json` —
 * for the numbers listed in `var/whatsapp/expected.json` and for nobody else.
 *
 * A file rather than a table: it is what WhatsApp happened to show the bridge,
 * about numbers that are mostly not users yet, and nothing in the books
 * depends on it. `var/` outlives a deploy. `WA_NAMES_FILE` and
 * `WA_EXPECTED_FILE` override the paths.
 *
 * The expected list is the privacy rule: the bridge is linked to a person's
 * own account and is handed their whole contact list, and with no list — or a
 * number not on it — nothing is kept.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { learnName, type NameBook } from '../domain/whatsapp-names';

export function namesFile(): string {
  return process.env.WA_NAMES_FILE?.trim() || join(process.cwd(), 'var', 'whatsapp', 'names.json');
}

export function expectedFile(): string {
  return process.env.WA_EXPECTED_FILE?.trim() || join(process.cwd(), 'var', 'whatsapp', 'expected.json');
}

/** The numbers whose names may be kept: a JSON array of E.164 numbers. None, when there is no list. */
export function expectedNumbers(): ReadonlySet<string> {
  const file = expectedFile();
  if (!existsSync(file)) return new Set();
  try {
    const listed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return new Set(Array.isArray(listed) ? listed.filter((value): value is string => typeof value === 'string') : []);
  } catch {
    return new Set();
  }
}

export function knownNames(): NameBook {
  const file = namesFile();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as NameBook;
  } catch {
    // A half-written file is not worth stopping the bridge for: start again.
    return {};
  }
}

/** Learns a batch of names; writes the file only when one of them was news. Returns how many were. */
export function rememberNames(
  seen: ReadonlyArray<{ readonly e164: string; readonly saved?: string | null; readonly profile?: string | null }>,
  now: Date = new Date(),
): number {
  const expected = expectedNumbers();
  const wanted = seen.filter((one) => expected.has(one.e164));
  if (wanted.length === 0) return 0;
  const book = knownNames();
  const at = now.toISOString();
  let changed = 0;
  for (const one of wanted) if (learnName(book, one, at)) changed += 1;
  if (changed > 0) {
    const file = namesFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(book, null, 2)}\n`, 'utf8');
  }
  return changed;
}
