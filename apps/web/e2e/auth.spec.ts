import { expect, test } from '@playwright/test';
import { authenticator } from 'otplib';
import { login, seed, sql } from './fixtures';

test.describe('Sign-in flows', () => {
  test('unauthenticated visitors are sent to login and returned afterwards', async ({ page }) => {
    await page.goto('/complaints?status=PENDING');
    await expect(page).toHaveURL(/\/login\?next=%2Fcomplaints%3Fstatus%3DPENDING/);
    await login(page, 'subAdminA', { next: '/complaints?status=PENDING', expectPath: /\/complaints\?status=PENDING/ });
  });

  test('wrong password shows a generic error', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Mobile number or email').fill(seed().users.subAdminA.mobile);
    await page.getByLabel('Password').fill('Wrong#password1');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByTestId('login-error')).toHaveText('Invalid credentials');
  });

  test('a new administrator sets up the authenticator and gets recovery codes once', async ({ page }) => {
    const u = seed().users.newSubAdmin;
    await page.goto('/login');
    await page.getByLabel('Mobile number or email').fill(u.mobile);
    await page.getByLabel('Password').fill(u.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('img', { name: 'Authenticator QR code' })).toBeVisible();
    const secret = (await page.getByTestId('mfa-secret').innerText()).trim();
    await page.getByLabel('Code shown in the app').fill(authenticator.generate(secret));
    await page.getByRole('button', { name: 'Turn on' }).click();
    const codes = (await page.getByTestId('recovery-codes').innerText()).trim().split('\n');
    expect(codes).toHaveLength(10);
    await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await page.getByText('I have saved my recovery codes').click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('a recovery code signs an administrator in when the phone is lost', async ({ page }) => {
    const u = seed().users.recoverySubAdmin;
    // Recovery codes are stored hashed, so get a known set by generating them on the Account page.
    await login(page, 'recoverySubAdmin');
    await page.goto('/account');
    await page.getByRole('button', { name: 'New recovery codes' }).click();
    await sql(`UPDATE users SET mfa_last_step = NULL WHERE id = $1`, [u.id]);
    await page.getByPlaceholder('123456').fill(authenticator.generate(u.mfaSecret!));
    await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click();
    const codes = (await page.getByTestId('new-codes').innerText()).trim().split('\n');
    await page.getByTestId('user-menu').hover();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);

    await page.getByLabel('Mobile number or email').fill(u.mobile);
    await page.getByLabel('Password').fill(u.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('button', { name: /Use a recovery code/ }).click();
    await page.getByLabel('Recovery code').fill(codes[0]);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('staff with a temporary password must change it before anything else', async ({ page }) => {
    await login(page, 'tempSupervisor', { expectPath: /\/account\?mustChange=1/ });
    await expect(page.getByTestId('must-change')).toBeVisible();
    await page.goto('/complaints');
    await expect(page).toHaveURL(/\/account\?mustChange=1/);
    await page.getByLabel('Temporary password').fill(seed().users.tempSupervisor.password);
    await page.getByLabel('New password', { exact: true }).fill('Changed#Pass2026');
    await page.getByLabel('Confirm new password').fill('Changed#Pass2026');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('field workers are pointed to the mobile app', async ({ page }) => {
    await login(page, 'workerA1', { expectPath: /\/dashboard/ });
    await expect(page.getByText('Please use the mobile app')).toBeVisible();
  });

  test('signing out ends the session', async ({ page, context }) => {
    await login(page, 'supervisorA');
    await page.getByTestId('user-menu').hover();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    const names = (await context.cookies()).filter((c) => c.value).map((c) => c.name);
    expect(names).not.toContain('cwm_at');
    expect(names).not.toContain('cwm_rt');
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });
});
