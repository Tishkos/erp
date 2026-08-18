import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { directionOf } from '@/i18n/config';
import './globals.css';

export const metadata: Metadata = {
  title: 'ERP',
  description: 'Integrated ERP System',
};

/**
 * Root layout — Phase 01.12.
 *
 * `lang` and `dir` come from the locale, in one place. §25: *"the localisation
 * architecture shall allow Arabic labels and right-to-left layout later without
 * redesign."* Adding Arabic changes what `getLocale()` returns and nothing
 * else — every stylesheet rule uses logical properties, so the layout mirrors
 * itself (see globals.css).
 *
 * English is the launch language (§1.1). The mechanism exists from day one
 * because retrofitting RTL is a rewrite (TECHSTACK A11).
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html lang={locale} dir={directionOf(locale)}>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
