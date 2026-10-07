import type { BrowserContext } from '@playwright/test';

/**
 * Back to English after clearing cookies. The application opens in Arabic for
 * anybody who has not chosen (2026-10-07, by direction), and every context of
 * the suite starts English through playwright.config.ts › `storageState`; a spec
 * that clears its cookies to sign out puts the language back with this, so its
 * English assertions still read what they always did.
 */
export async function keepEnglish(context: BrowserContext): Promise<void> {
  const base = new URL(process.env.E2E_BASE_URL ?? 'http://localhost:3000');
  await context.addCookies([{ name: 'erp-locale', value: 'en', domain: base.hostname, path: '/', sameSite: 'Lax' }]);
}
