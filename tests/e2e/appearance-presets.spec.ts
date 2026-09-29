import { expect, test } from '@playwright/test';

async function signIn(page: import('@playwright/test').Page) {
  await page.goto('/sign-in');
  await page.getByLabel('Email', { exact: true }).fill('admin@example.com');
  await page.getByLabel('Password', { exact: true }).fill('Ledger-Trial-Balance-7');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('/');
}

async function openAppearance(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(page.getByRole('radiogroup', { name: 'Interface style' })).toBeVisible();
}

test('appearance presets save per user and leave the active color theme alone', async ({ page }, testInfo) => {
  await signIn(page);
  const root = page.locator('.erp-root');
  const activePalette = await root.getAttribute('data-palette');
  const activeAccent = await root.getAttribute('data-accent');
  await openAppearance(page);

  const current = page.getByRole('radio', { name: /Current \/ Default/ });
  await expect(current).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('radio')).toHaveCount(7);
  await page.screenshot({ path: testInfo.outputPath('appearance-current.png') });

  await page.getByRole('radio', { name: /Enterprise/ }).click();
  await expect(root).toHaveAttribute('data-appearance', 'enterprise');
  await expect(root).toHaveAttribute('data-density', 'compact');
  await expect(root).toHaveAttribute('data-radius', 'sharp');
  await expect(root).toHaveAttribute('data-width', 'wide');
  await expect(root).toHaveAttribute('data-palette', activePalette!);
  await expect(root).toHaveAttribute('data-accent', activeAccent!);
  await expect(page.getByRole('status')).toHaveText('Appearance saved to your account.');
  await page.screenshot({ path: testInfo.outputPath('appearance-enterprise.png') });

  await page.reload();
  await expect(root).toHaveAttribute('data-appearance', 'enterprise');
  await openAppearance(page);
  await expect(page.getByRole('radio', { name: /Enterprise/ })).toHaveAttribute('aria-checked', 'true');
  await page.locator('.erp-advanced-appearance > summary').click();
  await page.getByRole('button', { name: 'Strong', exact: true }).click();
  await expect(root).toHaveAttribute('data-border-style', 'strong');

  await page.getByRole('radio', { name: /Current \/ Default/ }).click();
  await expect(page.getByRole('status')).toHaveText('Appearance saved to your account.');
  await expect(root).toHaveAttribute('data-appearance', 'current');
  await expect(root).toHaveAttribute('data-density', 'comfortable');
  await expect(root).toHaveAttribute('data-radius', 'soft');
  await expect(root).toHaveAttribute('data-width', 'fluid');
  await expect(root).toHaveAttribute('data-border-style', 'standard');
});
