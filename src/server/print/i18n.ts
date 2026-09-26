import { createTranslator, type AbstractIntlMessages } from 'next-intl';
import type { Locale } from '@/i18n/config';
import en from '../../../messages/en.json';
import ar from '../../../messages/ar.json';

/**
 * The message catalogue, in the language of the document rather than of the
 * session — an Arabic-working accountant prints an English invoice for an
 * English-reading supplier without touching their own setting.
 *
 * Built from the same catalogue files the screens read, so a label on paper is
 * the label on the screen; and without Next's request machinery, so the
 * builders run the same in a route handler and in a test.
 */
export type Translate = (key: string, values?: Record<string, string | number>) => string;

const CATALOGUE: Readonly<Record<Locale, AbstractIntlMessages>> = {
  en: en as unknown as AbstractIntlMessages,
  ar: ar as unknown as AbstractIntlMessages,
};

export interface Messages {
  readonly admin: Translate;
  readonly column: Translate;
  readonly page: Translate;
  readonly status: Translate;
  readonly print: Translate;
  readonly shell: Translate;
}

export function messagesFor(locale: Locale): Messages {
  const make = (namespace: string): Translate => {
    const t = createTranslator({
      locale,
      messages: CATALOGUE[locale],
      namespace,
      timeZone: process.env.ERP_TIMEZONE ?? 'Asia/Baghdad',
    }) as unknown as Translate;
    return (key, values) => t(key, values);
  };
  return {
    admin: make('admin'),
    column: make('column'),
    page: make('page'),
    status: make('status'),
    print: make('print'),
    shell: make('shell'),
  };
}
