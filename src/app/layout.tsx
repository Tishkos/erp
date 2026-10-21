import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Inter, Noto_Sans_Arabic } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { directionOf } from '@/i18n/config';
import { clientMessages } from '@/i18n/client-messages';
import './globals.css';
import { cn } from "@/lib/utils";

// Inter is the face (Intent UI's own); Noto Sans Arabic carries the Arabic. `--font-sans` is built from both (globals.css).
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  // No "Inter Fallback": it is local Arial, which has Arabic letters, so on an
  // English page every Arabic word (the company's name, a supplier's) was drawn
  // in Arial's Arabic instead of reaching Noto Sans Arabic next in the stack
  // (2026-10-06, by direction: "the Arabic font looks good … in English mode,
  // everywhere").
  adjustFontFallback: false,
  variable: '--font-inter',
});

const notoSansArabic = Noto_Sans_Arabic({
  subsets: ['arabic'],
  display: 'swap',
  variable: '--font-arabic-loaded',
});

export const metadata: Metadata = {
  title: 'Qimah Al-Safinah',
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
      className={cn(inter.variable, notoSansArabic.variable, "font-sans")}
      lang={locale}
      dir={directionOf(locale)}
      data-theme="light"
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body>
        <NextIntlClientProvider locale={locale} messages={clientMessages(messages)}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
