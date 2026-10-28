import { expect, test } from '@playwright/test';
import { login } from './fixtures';

test.describe('Dashboard and reports', () => {
  test('Sub Admin sees KPIs for their ULB only, matching the reports API, with charts and breakdown', async ({ page }) => {
    await login(page, 'subAdminA');
    // Other specs change statuses, so compare the screen with the API's own figures; the received
    // count is stable: ULB Alpha has 4 complaints in the window and Beta's must not be counted.
    const api = await page.evaluate(async () => (await fetch('/bff/api/reports/summary', { headers: { 'x-cwm-csrf': '1' } })).json());
    expect(api.counts.received).toBe(4);
    const kpi = (id: string) => page.getByTestId(id).locator('.ant-statistic-content-value');
    await expect(kpi('kpi-received')).toHaveText('4');
    await expect(kpi('kpi-resolved')).toHaveText(String(api.counts.resolved));
    await expect(kpi('kpi-pending')).toHaveText(String(api.counts.pending));
    await expect(kpi('kpi-rating')).toHaveText(String(api.quality.avgRating));
    await expect(page.getByTestId('chart-trend').locator('svg')).toBeVisible();
    await expect(page.getByTestId('chart-ageing').locator('svg')).toBeVisible();
    const rows = page.getByTestId('breakdown-table').locator('tbody tr.ant-table-row');
    await expect(rows).toHaveCount(2); // wards 1 and 2
  });

  test('District Admin sees every ULB of the district', async ({ page }) => {
    await login(page, 'districtAdmin');
    await expect(page.getByTestId('kpi-received').locator('.ant-statistic-content-value')).toHaveText('5');
    const table = page.getByTestId('breakdown-table');
    await expect(table.getByText('Nagar Nigam Alpha')).toBeVisible();
    await expect(table.getByText('Nagar Parishad Beta')).toBeVisible();
  });

  test('filters narrow the figures (ward filter)', async ({ page }) => {
    await login(page, 'subAdminA');
    await page.getByLabel('Ward filter').click();
    await page.getByTitle('Ward 2 · Ward 2 name').click();
    await expect(page.getByTestId('kpi-received').locator('.ant-statistic-content-value')).toHaveText('1');
  });

  test('exports download as Excel with a dated filename', async ({ page }) => {
    await login(page, 'subAdminA');
    await page.getByRole('button', { name: 'Export complaints' }).hover();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByText('Excel (.xlsx)').click()]);
    expect(download.suggestedFilename()).toMatch(/^complaints-\d{4}-\d{2}-\d{2}\.xlsx$/);
    const path = await download.path();
    const { statSync } = await import('node:fs');
    expect(statSync(path!).size).toBeGreaterThan(4000);
  });
});

test.describe('Dashboard in a browser far from IST', () => {
  test.use({ timezoneId: 'America/Los_Angeles' });

  test('the date picker shows the same IST window the figures use', async ({ page }) => {
    await login(page, 'subAdminA');
    const api = await page.evaluate(async () => (await fetch('/bff/api/reports/summary', { headers: { 'x-cwm-csrf': '1' } })).json());
    const inputs = page.locator('.ant-picker-range input');
    await expect(inputs.nth(0)).toHaveValue(api.range.from);
    await expect(inputs.nth(1)).toHaveValue(api.range.to);
  });
});
