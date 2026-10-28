import { expect, test } from '@playwright/test';
import { login, seed } from './fixtures';

test.describe('Complaint handling', () => {
  test('inbox lists only the Sub Admin\'s ULB, filterable by status', async ({ page }) => {
    await login(page, 'subAdminA');
    await page.goto('/complaints');
    const table = page.getByTestId('complaints-table');
    await expect(table.getByText(seed().complaints.assigned.no)).toBeVisible();
    await expect(table.getByText(seed().complaints.beta.no)).toHaveCount(0);
    await page.getByLabel('Status filter').click();
    await page.getByTitle('Pending').click();
    await expect(page).toHaveURL(/status=PENDING/);
    await expect(table.getByText(seed().complaints.pending.no)).toBeVisible();
    await expect(table.getByText(seed().complaints.assigned.no)).toHaveCount(0);
  });

  test('detail shows the evidence photo loaded from storage, map and history', async ({ page }) => {
    await login(page, 'supervisorA');
    await page.goto(`/complaints/${seed().complaints.assigned.id}`);
    await expect(page.getByTestId('complaint-no')).toHaveText(seed().complaints.assigned.no);
    const img = page.getByTestId('evidence').locator('img').first();
    await expect(img).toBeVisible();
    // The image really loaded (signed S3 URL allowed by the CSP), not a broken placeholder.
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
    await expect(page.getByText('Routed to supervisor')).toBeVisible();
  });

  test('supervisor assigns a worker; status and history update', async ({ page }) => {
    await login(page, 'supervisorA');
    await page.goto(`/complaints/${seed().complaints.assigned.id}`);
    await page.getByRole('button', { name: 'Assign worker' }).click();
    await page.getByLabel('Sanitation worker').click();
    await page.getByTitle(/Sunita Worker/).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Assign' }).click();
    await expect(page.getByText('Sunita Worker').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reassign' })).toBeVisible();
    await expect(page.locator('.ant-timeline').getByText('Assigned', { exact: true })).toBeVisible();
  });

  test('Sub Admin rejects an unrouted complaint with a reason', async ({ page }) => {
    await login(page, 'subAdminA');
    await page.goto(`/complaints/${seed().complaints.pending.id}`);
    await page.getByRole('button', { name: 'Reject' }).click();
    await page.getByLabel('Reason (shown in the history)').fill('Private property, outside ULB jurisdiction');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('complaint-status')).toHaveText('Rejected');
    await expect(page.getByText('“Private property, outside ULB jurisdiction”')).toBeVisible();
  });

  test('a supervisor only sees complaints of their area', async ({ page }) => {
    await login(page, 'supervisorA');
    await page.goto('/complaints');
    await expect(page.getByTestId('complaints-table').getByText(seed().complaints.assigned.no)).toBeVisible();
    // ward 2 has no area → not this supervisor's
    await expect(page.getByTestId('complaints-table').getByText(seed().complaints.pending.no)).toHaveCount(0);
  });

  test('another ULB\'s complaint cannot be opened by URL', async ({ page }) => {
    await login(page, 'subAdminA');
    await page.goto(`/complaints/${seed().complaints.beta.id}`);
    await expect(page.getByText('Complaint not found')).toBeVisible();
  });
});
