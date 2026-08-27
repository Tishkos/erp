import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Inter, Noto_Sans_Arabic, Geist } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { directionOf } from '@/i18n/config';
import './globals.css';
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

const notoSansArabic = Noto_Sans_Arabic({
  subsets: ['arabic'],
  display: 'swap',
  variable: '--font-arabic-loaded',
});

export const metadata: Metadata = {
  title: 'QS ERP | Qimah Al-Safinah',
  description: 'Qimah Al-Safinah integrated enterprise resource planning system',
};

const THEME_BOOTSTRAP_SCRIPT = `
  (function () {
    var theme = 'light';
    try {
      var storedTheme = window.localStorage.getItem('data-theme');
      if (storedTheme === 'light' || storedTheme === 'dark') theme = storedTheme;
    } catch (error) {}
    document.documentElement.setAttribute('data-theme', theme);
  })();
`;

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
    <html
      className={cn(inter.variable, notoSansArabic.variable, "font-sans", geist.variable)}
      lang={locale}
      dir={directionOf(locale)}
      data-theme="light"
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
