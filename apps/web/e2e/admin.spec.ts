import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { login, sql } from './fixtures';

test.describe('Administration', () => {
  test('Sub Admin creates a worker and sees the temporary password once', async ({ page }) => {
    await login(page, 'subAdminA');
    await page.goto('/users');
    await page.getByRole('button', { name: 'Add staff' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Role').click();
    await page.getByTitle('Sanitation Worker').click();
    await dialog.getByLabel('Full name').fill('Kavita New Worker');
    await dialog.getByLabel('Mobile').fill('9199999901');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByTestId('temp-password')).toHaveText(/^[A-Za-z0-9]{12}$/);
    await page.getByRole('button', { name: 'OK' }).click();
    await expect(page.getByTestId('staff-table').getByText('Kavita New Worker')).toBeVisible();
    const [row] = await sql<{ ulb_id: string; must_change_password: boolean }>(
      `SELECT ulb_id, must_change_password FROM users WHERE name = 'Kavita New Worker'`,
    );
    expect(row.must_change_password).toBe(true);
  });

  test('Sub Admin disables a worker', async ({ page }) => {
    await login(page, 'subAdminA');
    await page.goto('/users');
    const row = page.getByTestId('staff-table').locator('tr', { hasText: 'Mohan Worker' });
    await row.getByRole('button', { name: 'Disable' }).click();
    await page.getByRole('button', { name: 'OK' }).click();
    await expect(row.getByText('DISABLED')).toBeVisible();
  });

  test('Sub Admin adds a ward with a GeoJSON boundary', async ({ page }, info) => {
    mkdirSync(info.outputDir, { recursive: true });
    const file = join(info.outputDir, 'ward-9.geojson');
    writeFileSync(file, JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { name: 'Ward 9' }, geometry: { type: 'Polygon', coordinates: [[[80.02, 25.0], [80.03, 25.0], [80.03, 25.01], [80.02, 25.01], [80.02, 25.0]]] } }],
    }));
    await login(page, 'subAdminA');
    await page.goto('/masters');
    await page.getByRole('tab', { name: 'Wards' }).click();
    await page.getByRole('button', { name: 'Add ward' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Ward number').fill('9');
    await dialog.getByLabel('Ward name (optional)').fill('Gandhi Nagar');
    await dialog.locator('input[type=file]').setInputFiles(file);
    await expect(dialog.locator('.leaflet-container')).toBeVisible();
    await dialog.getByRole('button', { name: 'Save' }).click();
    const row = page.locator('tr', { hasText: 'Gandhi Nagar' });
    await expect(row.getByText('Mapped')).toBeVisible();
  });

  test('Web Admin changes a complaint type SLA', async ({ page }) => {
    await login(page, 'webAdmin');
    await page.goto('/masters');
    await page.getByRole('tab', { name: 'Complaint types & SLA' }).click();
    const input = page.getByLabel('SLA hours for Dead animal');
    await input.fill('8');
    await input.blur();
    await expect(page.getByText('Saved')).toBeVisible();
    const [t] = await sql<{ sla_hours: number }>(`SELECT sla_hours FROM complaint_types WHERE code = 'DEAD_ANIMAL'`);
    expect(t.sla_hours).toBe(8);
  });
});
