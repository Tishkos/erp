import { defineConfig, devices } from '@playwright/test';

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
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
