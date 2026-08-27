/**
 * next-intl request configuration — Phase 01.12.
 *
 * The selected UI locale is a device preference stored in a non-sensitive
 * cookie. The root layout reads the resolved locale and mirrors the entire
 * interface through its `dir` attribute.
 */
import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE } from './config';

export default getRequestConfig(async () => {
  const requested = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale = requested && isLocale(requested) ? requested : DEFAULT_LOCALE;

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
    // Explicit, not inherited from the server's environment: a figure or a date
    // must not depend on which machine rendered it.
    timeZone: process.env.ERP_TIMEZONE ?? 'Asia/Baghdad',
  };
});
