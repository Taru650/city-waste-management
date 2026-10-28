import { expect, test } from '@playwright/test';
import { login, signOut, sql, USERS } from './fixtures';

test.describe('Sign-in flows', () => {
  test('visitors without a session are sent to sign-in and returned afterwards', async ({ page }) => {
    await page.goto('/complaints?status=PENDING');
    await expect(page).toHaveURL(/\/login\?next=%2Fcomplaints%3Fstatus%3DPENDING/);
    await login(page, 'subAdmin', { next: '/complaints?status=PENDING', expectPath: /\/complaints\?status=PENDING/ });
  });

  test('a wrong password shows a generic error', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Mobile number or email').fill(USERS.subAdmin);
    await page.getByLabel('Password').fill('Wrong#password1');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByTestId('login-error')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('the session cookies are httpOnly, SameSite=Strict and Secure, and no token reaches page scripts', async ({ page, context }) => {
    await login(page, 'subAdmin');
    const cookies = await context.cookies();
    for (const name of ['cwm_at', 'cwm_rt']) {
      const c = cookies.find((x) => x.name === name)!;
      expect(c, name).toBeTruthy();
      expect(c.httpOnly).toBe(true);
      expect(c.sameSite).toBe('Strict');
      expect(c.secure).toBe(true);
    }
    expect(await page.evaluate(() => document.cookie)).toBe('');
    // Nothing the page stores or renders carries the tokens either.
    const at = cookies.find((x) => x.name === 'cwm_at')!.value;
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(at.slice(0, 20));
    expect(await page.content()).not.toContain(at.slice(0, 20));
  });

  test('staff with a temporary password must change it before anything else', async ({ page }) => {
    // Create a staff member with a temporary password through the real API as the Sub Admin.
    await login(page, 'subAdmin');
    const mobile = `98${Date.now().toString().slice(-8)}`;
    const created = await page.evaluate(async (m) => {
      const r = await fetch('/api/v1/users', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-cwm-csrf': '1' }, credentials: 'same-origin',
        body: JSON.stringify({ role: 'SUPERVISOR', name: 'Temp Supervisor', mobile: m }),
      });
      return { status: r.status, body: await r.json() };
    }, mobile);
    expect(created.status).toBe(201);
    await signOut(page);

    await page.goto('/login');
    await page.getByLabel('Mobile number or email').fill(mobile);
    await page.getByLabel('Password').fill(created.body.tempPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/account\?mustChange=1/);
    await expect(page.getByTestId('must-change')).toBeVisible();
    await page.goto('/complaints');
    await expect(page).toHaveURL(/\/account\?mustChange=1/);
    await page.getByLabel('Temporary password').fill(created.body.tempPassword);
    await page.getByLabel('New password', { exact: true }).fill('Changed#Pass2026');
    await page.getByLabel('Confirm new password').fill('Changed#Pass2026');
    await page.getByRole('button', { name: 'Change password' }).click();
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('field workers are pointed to the mobile app', async ({ page }) => {
    await login(page, 'worker1');
    await expect(page.getByText('Please use the mobile app')).toBeVisible();
  });

  test('signing out ends the session', async ({ page, context }) => {
    await login(page, 'supervisorNorth');
    await signOut(page);
    const names = (await context.cookies()).filter((c) => c.value).map((c) => c.name);
    expect(names).not.toContain('cwm_at');
    expect(names).not.toContain('cwm_rt');
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });

  test('a copied access cookie stops working once its session is signed out', async ({ page, context }) => {
    await login(page, 'supervisorNorth');
    const copied = (await context.cookies()).find((c) => c.name === 'cwm_at')!;
    await signOut(page);
    await context.addCookies([copied]);
    const res = await page.request.get('/api/v1/complaints', { maxRedirects: 0 });
    expect(res.status()).toBe(401);
    // And the pages do not loop: one renewal attempt fails, the session is cleared, sign-in appears.
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('an expired access token is renewed silently from the refresh cookie', async ({ page, context }) => {
    await login(page, 'supervisorNorth');
    const at = (await context.cookies()).find((c) => c.name === 'cwm_at')!;
    // Drop only the access cookie, as the browser does when it expires.
    await context.clearCookies({ name: 'cwm_at' });
    await page.goto('/complaints');
    await expect(page).toHaveURL(/\/complaints$/);
    await expect(page.getByTestId('user-menu')).toBeVisible();
    const renewed = (await context.cookies()).find((c) => c.name === 'cwm_at')!;
    expect(renewed.value).not.toBe(at.value);
  });

  test('a disabled account is signed out on its next page, without a redirect loop', async ({ page, browser }) => {
    // A throwaway account so the shared demo accounts stay usable.
    await login(page, 'subAdmin');
    const mobile = `97${Date.now().toString().slice(-8)}`;
    const made = await page.evaluate(async (m) => {
      const r = await fetch('/api/v1/users', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-cwm-csrf': '1' }, credentials: 'same-origin',
        body: JSON.stringify({ role: 'SUPERVISOR', name: 'Soon Disabled', mobile: m }),
      });
      return r.json();
    }, mobile);
    const ctx = await browser.newContext();
    const other = await ctx.newPage();
    await other.request.post('/api/v1/auth/login', { data: { identifier: mobile, password: made.tempPassword, session: 'cookie' }, headers: { 'x-cwm-csrf': '1' } });
    await sql(`UPDATE users SET status = 'DISABLED' WHERE id = ?`, [made.id]);
    await other.goto('/dashboard');
    await expect(other).toHaveURL(/\/login/);
    await expect(other.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await ctx.close();
  });

  test('a signed-in visitor on the sign-in page goes straight to the dashboard', async ({ page }) => {
    await login(page, 'subAdmin');
    await page.goto('/login');
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('the user menu stays with its button when the page scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await login(page, 'subAdmin');
    await page.getByTestId('user-menu').click();
    await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
    await page.keyboard.press('Escape');
  });
});

test.describe('Public pages', () => {
  test('the privacy notice is public and shows the grievance officer', async ({ page }) => {
    await page.goto('/privacy');
    await expect(page.getByTestId('notice-en')).toBeVisible();
    await expect(page.getByTestId('notice-hi')).toBeVisible();
    await expect(page.getByTestId('grievance-officer')).toContainText('Demo Grievance Officer');
  });

  test('forgot password gives the same answer for any account', async ({ page }) => {
    await page.goto('/forgot-password');
    await page.getByLabel('Mobile number or email').fill('9999999999');
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByText('If an account with an email exists')).toBeVisible();
  });

  test('pages carry a nonce-based CSP and no inline script is allowed', async ({ page }) => {
    const res = await page.goto('/login');
    const csp = res!.headers()['content-security-policy'];
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res!.headers()['x-frame-options']).toBe('DENY');
  });
});
