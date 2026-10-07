/**
 * The figures a chart says beside its marks — a part's share of the whole, a
 * large amount said short — worked out exactly before anything is drawn.
 *
 * Money arrives as the service's decimal strings and is compared, summed and
 * divided as scaled bigints (`dashboard-charts.moneyOf`); a `number` appears
 * only as the ratio handed to `Intl` for a percentage, the last step. Pure:
 * usable from a server component or a page alike.
 */
import { moneyOf, sumMoney } from '@/server/domain/dashboard-charts';
import { formatMoney, type Locale } from '@/i18n/config';

/** The part's share of the whole, to a tenth of a percent, as a ratio for `Intl` — 0 when there is no whole. */
export function shareRatio(part: bigint, whole: bigint): number {
  if (whole <= 0n || part <= 0n) return 0;
  return Number((part * 1000n) / whole) / 1000;
}

/** "62%" — and "0.4%" rather than a "0%" that would say a real amount is nothing. */
export function percentText(ratio: number, locale: Locale): string {
  const fine = ratio > 0 && ratio < 0.01;
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: fine ? 1 : 0 }).format(ratio);
}

/** Each amount's share of their sum, in the amounts' order (negative amounts have none: a share of a net is not one). */
export function sharesOf(amounts: readonly string[], locale: Locale): (string | null)[] {
  const values = amounts.map((amount) => moneyOf(amount));
  if (values.some((value) => value < 0n)) return values.map(() => null);
  const whole = sumMoney(amounts);
  return values.map((value) => percentText(shareRatio(value, whole), locale));
}

/** From eight whole digits, a dinar figure is said short ("1.25B IQD") with the exact amount kept for its title. */
export const COMPACT_FROM_DIGITS = 8;

export function shortMoney(decimal: string, currency: string, locale: Locale): { readonly text: string; readonly exact: string; readonly shortened: boolean } {
  const exact = formatMoney(decimal, currency, locale);
  const whole = decimal.replace(/^-/, '').split('.')[0] ?? '';
  if (whole.length < COMPACT_FROM_DIGITS) return { text: exact, exact, shortened: false };
  const short = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 2 }).format(Number(decimal));
  return { text: `${short} ${currency}`, exact, shortened: true };
}
