import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

/**
 * The application opens in Arabic for anybody who has not chosen a language
 * (2026-10-07, by direction). The specs read English unless they say otherwise,
 * so every context starts with the language cookie set to English — a spec that
 * wants Arabic sets the cookie itself, as it always has (`i18n/config.ts` ›
 * LOCALE_COOKIE).
 */
const ENGLISH = {
  cookies: [
    {
      name: 'erp-locale',
      value: 'en',
      domain: new URL(BASE_URL).hostname,
      path: '/',
      expires: -1,
      httpOnly: false,
      secure: false,
      sameSite: 'Lax' as const,
    },
  ],
  origins: [],
};

/**
 * End-to-end tests — Phase 00.5 baseline.
 *
 * These carry the §26 critical UAT scenarios from Phase 06 onward, and the
 * §25 acceptance criterion 1 authorisation tests: "inaccessible modules and
 * records cannot be reached through direct URL or API."
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Serialised in CI so database-backed scenarios do not race; unset locally so
  // Playwright picks a sensible default for the machine.
  ...(process.env.CI ? { workers: 1 } : {}),
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',

  use: {
    baseURL: BASE_URL,
    storageState: ENGLISH,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: /mobile-rtl\.spec\.ts/ },
    // REQ-HARDEN-001 I1 — a phone, right to left: the one spec written for it
    // runs here and nowhere else, so the desktop run stays what it was.
    { name: 'mobile', use: { ...devices['Pixel 5'] }, testMatch: /mobile-rtl\.spec\.ts/ },
  ],

  webServer: {
    command: 'npm run dev',
    url: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
