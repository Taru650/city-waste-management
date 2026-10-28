import { expect, test } from '@playwright/test';
import { login } from './fixtures';

test.describe('Privacy and signed-in error handling (M9)', () => {
  test('the privacy notice is public, in English and Hindi, and linked from sign-in', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('link', { name: 'Privacy notice' }).click();
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(page.getByTestId('notice-en')).toHaveText(/Privacy notice/);
    await expect(page.getByTestId('notice-hi')).toHaveText(/गोपनीयता सूचना/);
    await expect(page.getByText('Data Protection Board of India')).toBeVisible();
  });

  test('a wrong authenticator code while signed in shows an error and keeps the session', async ({ page }) => {
    await login(page, 'subAdminA');
    await page.goto('/account');
    await page.getByRole('button', { name: 'New recovery codes' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByPlaceholder('123456').fill('000000');
    await dialog.getByRole('button', { name: 'OK' }).click();
    await expect(page.getByText('Invalid code')).toBeVisible();
    await expect(page).toHaveURL(/\/account$/); // before the fix: thrown back to /login
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard$/);
  });
});
