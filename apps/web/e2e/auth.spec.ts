import { expect, test } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { apiEnv } from './env.mjs';
import { authenticator } from 'otplib';
import { login, seed, signOut, sql } from './fixtures';

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
    await signOut(page);

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
    await signOut(page);
    const names = (await context.cookies()).filter((c) => c.value).map((c) => c.name);
    expect(names).not.toContain('cwm_at');
    expect(names).not.toContain('cwm_rt');
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });

  test('a copied access cookie stops working once its session is signed out', async ({ page, context }) => {
    await login(page, 'supervisorA');
    const copied = (await context.cookies()).find((c) => c.name === 'cwm_at')!;
    await signOut(page);
    // Someone replays the cookie they copied before sign-out (shared office PC, malware, a proxy log).
    await context.addCookies([copied]);
    const res = await page.request.get('/bff/api/complaints', { maxRedirects: 0 });
    expect(res.status()).toBe(401);
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('a session ended elsewhere lands on sign-in, not in a redirect loop', async ({ page, context }) => {
    await login(page, 'supervisorA');
    const copied = (await context.cookies()).find((c) => c.name === 'cwm_at')!;
    await signOut(page);
    // The browser still holds an unexpired access token the API no longer accepts (session revoked,
    // account disabled, password changed on another device). Open a page directly.
    await context.addCookies([copied]);
    await page.goto('/complaints');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('a token from before session binding is renewed silently, not sent to sign-in', async ({ page, context }) => {
    await login(page, 'supervisorA');
    const at = (await context.cookies()).find((c) => c.name === 'cwm_at')!;
    // Same user and token version, but no session id: what every browser holds right after the upgrade.
    const { sid: _sid, ...claims } = JSON.parse(Buffer.from(at.value.split('.')[1], 'base64url').toString());
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}`;
    const legacy = `${unsigned}.${createHmac('sha256', apiEnv.JWT_ACCESS_SECRET).update(unsigned).digest('base64url')}`;
    await context.addCookies([{ ...at, value: legacy }]);
    await page.goto('/complaints');
    await expect(page).toHaveURL(/\/complaints$/);
    await expect(page.getByTestId('user-menu')).toBeVisible();
    const renewed = (await context.cookies()).find((c) => c.name === 'cwm_at')!.value;
    expect(JSON.parse(Buffer.from(renewed.split('.')[1], 'base64url').toString()).sid).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('the user menu stays with its button when the page scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await login(page, 'supervisorA');
    await page.getByTestId('user-menu').click();
    const item = page.getByRole('menuitem', { name: 'Sign out' });
    await expect(item).toBeVisible();
    // Where is the item at the instant the page scrolls (before any re-positioning)? A menu attached
    // to <body> moves with the page while its button stays in the sticky header, then snaps back,
    // and a click caught in between landed on nothing.
    const drift = await item.evaluate(async (el) => {
      const y0 = el.getBoundingClientRect().y;
      let worst = 0;
      const seen = () => { worst = Math.max(worst, Math.abs(el.getBoundingClientRect().y - y0)); };
      window.addEventListener('scroll', seen, { capture: true });
      for (const dy of [120, 120, 120]) { window.scrollBy(0, dy); seen(); await new Promise((r) => requestAnimationFrame(r)); }
      window.removeEventListener('scroll', seen, { capture: true });
      return { worst, scrolled: window.scrollY };
    });
    expect(drift.scrolled).toBeGreaterThan(100);
    expect(drift.worst).toBeLessThan(2);
    await expect(item).toBeVisible();
  });
});
