/**
 * next-intl request configuration — Phase 01.12.
 *
 * One locale is offered (§1.1, English-only) and the plumbing that would offer
 * more is in place (§25, "without redesign"). Adding Arabic is: add `'ar'` to
 * LOCALES, add messages/ar.json, and the layout's `dir` follows on its own.
 */
import { getRequestConfig } from 'next-intl/server';
import { DEFAULT_LOCALE } from './config';

export default getRequestConfig(async () => {
  const locale = DEFAULT_LOCALE;

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
    // Explicit, not inherited from the server's environment: a figure or a date
    // must not depend on which machine rendered it.
    timeZone: process.env.ERP_TIMEZONE ?? 'Asia/Baghdad',
  };
});
