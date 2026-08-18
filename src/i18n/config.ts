/**
 * Localisation — Phase 01.12.
 *
 * §25: *"The localisation architecture shall allow Arabic labels and
 * right-to-left layout later without redesign."*
 * §1.1: *"English-only user interface and documents."*
 *
 * Both at once: English is the only locale offered today, and the mechanism
 * that would add Arabic exists from the first screen. That is not speculative
 * generality — retrofitting RTL means revisiting every margin, every icon and
 * every table in the application, which is a redesign by any honest name
 * (TECHSTACK A11). The cost of carrying `dir` and a message catalogue now is
 * close to nothing; the cost of adding them in Phase 20 is the whole UI.
 *
 * What the architecture commits to:
 *
 *   1. No user-visible string is written in a component. Labels are keys.
 *   2. Layout uses CSS logical properties — `margin-inline-start`, never
 *      `margin-left` — so direction flips with `dir` and nothing else.
 *   3. Numbers, dates and money are formatted through `Intl` with an explicit
 *      locale, never through `toLocaleString()` with the server's default or
 *      `toFixed()`.
 *
 * Rule 3 has an accounting reason as well as a linguistic one. §1.1 fixes IQD
 * as the ledger currency and USD as the reporting equivalent; a figure rendered
 * by whichever locale the server happens to run under is a figure nobody can
 * reconcile.
 */

export const LOCALES = ['en'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/** Locales that read right to left. Consulted, not hardcoded per component. */
const RTL_LOCALES: readonly string[] = ['ar', 'fa', 'he', 'ur'];

export type Direction = 'ltr' | 'rtl';

export function directionOf(locale: string): Direction {
  return RTL_LOCALES.includes(locale.split('-')[0]!) ? 'rtl' : 'ltr';
}

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/**
 * Money formatting — §1.1's two currencies.
 *
 * Takes the scaled-integer string the database returns (`numeric(19,4)` comes
 * back as a string precisely so no value passes through a float) and formats it
 * for display. IQD has no minor unit in practice, so it shows whole dinars;
 * USD shows cents.
 */
export function formatMoney(
  amount: string | number,
  currency: 'IQD' | 'USD',
  locale: Locale = DEFAULT_LOCALE,
): string {
  const value = typeof amount === 'string' ? Number(amount) : amount;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: currency === 'IQD' ? 0 : 2,
    maximumFractionDigits: currency === 'IQD' ? 0 : 2,
  }).format(value);
}

/** Quantities — six decimals kept, trailing zeros dropped for reading. */
export function formatQuantity(
  quantity: string | number,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const value = typeof quantity === 'string' ? Number(quantity) : quantity;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(value);
}

/**
 * A business date — an ISO `YYYY-MM-DD` string, never a JS Date (TECHSTACK A10).
 *
 * Parsed as UTC deliberately: `new Date('2026-02-01')` is midnight UTC, but
 * `new Date(2026, 1, 1)` is midnight local, and formatting the first with a
 * local time zone can render the day before. An accounting date that shifts by
 * one day west of Greenwich is a posting in the wrong period.
 */
export function formatBusinessDate(
  isoDate: string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  if (!year || !month || !day) return isoDate;
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    timeZone: 'UTC',
  }).format(Date.UTC(year, month - 1, day));
}

/** A timestamp — an instant, so the viewer's zone is the right one to use. */
export function formatTimestamp(iso: string, locale: Locale = DEFAULT_LOCALE): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));
}
