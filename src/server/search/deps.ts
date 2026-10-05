/**
 * The strings and figures of a search result, in the reader's language.
 *
 * Built from next-intl's server translator (`getTranslations('search')`) and the
 * application's own date and money formatters, so a result reads exactly as the
 * register it opens does. Used by the palette's route and by the /search page.
 */
import { formatBusinessDate, formatMoney, type Locale } from '../../i18n/config';
import type { PresentDeps } from './present';

/** The part of next-intl's translator the strings need. */
export interface SearchTranslator {
  (key: string): string;
  has(key: string): boolean;
}

export function presentDeps(t: SearchTranslator, locale: string): PresentDeps {
  const typed = locale as Locale;
  return {
    locale,
    typeLabel: (key) => (t.has(`types.${key}`) ? t(`types.${key}`) : key.replace(/_/g, ' ')),
    statusLabel: (code) => (t.has(`status.${code}`) ? t(`status.${code}`) : null),
    date: (iso) => formatBusinessDate(iso, typed),
    money: (value, currency) => formatMoney(value, currency, typed),
  };
}
