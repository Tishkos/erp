import { expect, test, type Page } from '@playwright/test';

/**
 * REQ-HARDEN-001 HD16 — every delivered list and settings screen reads at a
 * phone's width, right to left, with no horizontal scroll: the mobile
 * coverage the audit found missing (I1, I2), over the screens the payables
 * stages 3–8 and the later requirements delivered.
 *
 * One sign-in, one viewport, every route; the assertion is the same for all
 * of them, so a screen that regresses is named by its route.
 */
const ADMIN = { email: 'admin@example.com', password: 'Ledger-Trial-Balance-7' };

const ROUTES = [
  '/payables',
  '/payables/open-items',
  '/payables/contracts',
  '/payables/service-receipts',
  '/payables/purchase-orders',
  '/payables/goods-receipts',
  '/payables/payment-applications',
  '/payables/advances',
  '/payables/pd',
  '/payables/shipments',
  '/payables/containers',
  '/payables/loans',
  '/master-data/banks',
  '/administration/payables-settings',
  '/administration/payables-migration',
  '/administration/jobs',
  '/administration/backup-health',
  '/administration/legacy-import',
  '/administration/hr-settings',
  '/administration/whatsapp',
  '/hr/employees',
  '/hr/departments',
  '/hr/positions',
  '/hr/attendance',
  '/hr/leave',
  '/hr/payroll',
  '/hr/advances',
  '/hr/recruitment',
  '/hr/performance',
  '/hr/dashboard',
  '/hr/requests',
  '/hr/documents',
  '/hr/reports',
  '/finance/periods',
  '/projects',
  '/projects/contracts',
  '/projects/wbs',
  '/projects/plan',
  '/projects/budgets',
  '/projects/budgets/new',
  '/projects/change-orders',
  '/projects/change-orders/new',
  '/projects/costs',
  '/projects/procurement',
  '/projects/material-issues',
  '/projects/progress',
  '/projects/billing',
  '/projects/forecast',
  '/projects/close',
  '/projects/reports',
  '/administration/project-settings',
  '/inventory/in-transit',
  '/treasury/reporting',
  // REQ-FIX-001 FIX-1.
  '/treasury/deposits',
  '/payables/pd/asycuda',
];

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(ADMIN.email);
  await page.locator('input[name="password"]').fill(ADMIN.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

test.describe('HD16 · mobile, right to left, every delivered screen', () => {
  test('no horizontal scroll at 390px in Arabic, and a heading on every screen', async ({ page, context }) => {
    test.setTimeout(600_000);
    await context.addCookies([{ name: 'erp-locale', value: 'ar', domain: 'localhost', path: '/' }]);
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    const failures: string[] = [];
    for (const route of ROUTES) {
      const response = await page.goto(route, { waitUntil: 'networkidle' });
      expect(response?.status(), `${route} responds`).toBeLessThan(400);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      // The first visit compiles the route on a development server; allow it.
      await expect(page.getByRole('heading', { level: 1 }).first(), `${route} has a heading`).toBeVisible({ timeout: 45_000 });
      const width = await page.evaluate(() => document.documentElement.scrollWidth);
      if (width > 390) failures.push(`${route}: ${width}px`);
    }
    expect(failures, 'screens wider than the phone').toEqual([]);
  });
});
