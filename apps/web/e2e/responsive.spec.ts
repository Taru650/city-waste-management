import { expect, Page, test } from '@playwright/test';
import { login, seed } from './fixtures';

/**
 * Every portal page at desktop, laptop, tablet (both orientations) and phone widths: the page never
 * scrolls sideways (wide tables, charts and maps scroll inside their cards), titles are not squeezed,
 * and the main navigation is reachable (sidebar on large screens, drawer menu below 992 px).
 * SCREENSHOTS_DIR=<dir> also saves full-page screenshots for visual review.
 */
const VIEWPORTS = [
  { name: 'desktop', width: 1920, height: 1080 },
  { name: 'laptop', width: 1366, height: 768 },
  { name: 'tablet-landscape', width: 1024, height: 768 },
  { name: 'tablet-portrait', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
];

async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500); // charts and maps lay out after data arrives
}

async function expectNoSidewaysScroll(page: Page, where: string) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  expect(scrollWidth, `${where}: page is ${scrollWidth}px wide in a ${innerWidth}px viewport`).toBeLessThanOrEqual(innerWidth);
}

async function shot(page: Page, name: string) {
  if (process.env.SCREENSHOTS_DIR) await page.screenshot({ path: `${process.env.SCREENSHOTS_DIR}/${name}.png`, fullPage: true });
}

for (const vp of VIEWPORTS) {
  test.describe(`Responsive layout: ${vp.name} (${vp.width}×${vp.height})`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('sign-in page fits the screen', async ({ page }) => {
      await page.goto('/login');
      await settle(page);
      await expect(page.getByRole('button', { name: 'Sign in' })).toBeInViewport();
      await expectNoSidewaysScroll(page, '/login');
      await shot(page, `${vp.name}-login`);
    });

    test('every page fits, titles are not squeezed, navigation is reachable', async ({ page }) => {
      test.setTimeout(120_000);
      await login(page, 'subAdminA');
      const pages = ['/dashboard', '/complaints', `/complaints/${seed().complaints.assigned.id}`, '/event-zones', '/masters', '/users', '/notifications', '/account'];
      for (const path of pages) {
        await page.goto(path);
        await settle(page);
        await expectNoSidewaysScroll(page, path);
        const title = page.locator('.page-header__title').first();
        if (await title.count()) {
          // A squeezed title wraps one letter per line; a normal one fits in at most two lines.
          const box = await title.boundingBox();
          expect(box!.height, `${path}: title is ${box!.height}px tall`).toBeLessThan(90);
        }
        await shot(page, `${vp.name}-${path.split('/').slice(1).join('-').replace(/-[0-9a-f-]{36}$/, '-detail')}`);
      }

      await page.goto('/dashboard');
      if (vp.width >= 992) {
        await expect(page.locator('.app-sider')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Open menu' })).toBeHidden();
        await page.locator('.app-sider').getByRole('link', { name: 'Complaints' }).click();
      } else {
        await expect(page.locator('.app-sider')).toBeHidden();
        await page.getByRole('button', { name: 'Open menu' }).click();
        const drawer = page.locator('.app-drawer');
        await expect(drawer.getByRole('link', { name: 'Complaints' })).toBeVisible();
        await drawer.getByRole('link', { name: 'Complaints' }).click();
        await expect(drawer.getByRole('link', { name: 'Complaints' })).toBeHidden(); // closes after choosing
      }
      await expect(page).toHaveURL(/\/complaints$/);
    });
  });
}

test('printing the dashboard gives an official report header and hides navigation', async ({ page }) => {
  await login(page, 'subAdminA');
  await settle(page);
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.report-print-header')).toBeVisible();
  await expect(page.locator('.report-print-header')).toContainText('Grievance dashboard report');
  await expect(page.locator('.app-sider')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Print / PDF' })).toBeHidden();
});

test('an unknown address shows a helpful not-found page with a way back', async ({ page }) => {
  await login(page, 'subAdminA');
  const res = await page.goto('/no-such-page');
  expect(res!.status()).toBe(404);
  await expect(page.getByText('Page not found')).toBeVisible();
  await page.getByRole('button', { name: 'Go to dashboard' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
});
