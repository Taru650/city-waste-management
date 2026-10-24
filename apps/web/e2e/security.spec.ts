import { expect, test } from '@playwright/test';
import { login, seed } from './fixtures';

test.describe('Portal security', () => {
  test('session tokens live only in httpOnly, SameSite=Strict, Secure cookies — never in JS or storage', async ({ page, context }) => {
    let loginBody = '';
    page.on('response', async (r) => {
      if (r.url().includes('/bff/auth/')) loginBody += await r.text().catch(() => '');
    });
    await login(page, 'subAdminA');
    const cookies = await context.cookies();
    for (const name of ['cwm_at', 'cwm_rt']) {
      const c = cookies.find((x) => x.name === name)!;
      expect(c, name).toBeDefined();
      expect(c.httpOnly).toBe(true);
      expect(c.sameSite).toBe('Strict');
      expect(c.secure).toBe(true);
    }
    expect(await page.evaluate(() => document.cookie)).not.toMatch(/cwm_at|cwm_rt/);
    const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(storage).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./); // no JWTs
    expect(loginBody).not.toMatch(/accessToken|refreshToken|eyJ[A-Za-z0-9_-]{10,}\./);
  });

  test('strict CSP with a per-request nonce; clickjacking and sniffing protections', async ({ page }) => {
    const res = await page.goto('/login');
    const csp = res!.headers()['content-security-policy'];
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).not.toMatch(/'unsafe-eval'/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).toMatch(/object-src 'none'/);
    const again = await page.goto('/login');
    expect(again!.headers()['content-security-policy']).not.toBe(csp); // fresh nonce
    expect(res!.headers()['x-frame-options']).toBe('DENY');
    expect(res!.headers()['x-content-type-options']).toBe('nosniff');
    expect(res!.headers()['x-powered-by']).toBeUndefined();
  });

  test('citizen-written HTML in a complaint is shown as text and never executes', async ({ page }) => {
    await login(page, 'supervisorA');
    await page.goto(`/complaints/${seed().complaints.xss.id}`);
    await expect(page.getByTestId('complaint-description')).toContainText('<img src=x onerror=');
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  });

  test('CSRF: state changes without our header or from another origin are refused', async ({ page, request }) => {
    await login(page, 'subAdminA');
    const id = seed().complaints.closed.id;
    const noHeader = await page.evaluate(async (cid) => (await fetch(`/bff/api/complaints/${cid}/reject`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'csrf attempt here' }),
    })).status, id);
    expect(noHeader).toBe(403);
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const crossSite = await request.post(`/bff/api/complaints/${id}/reject`, {
      headers: { cookie: cookieHeader, origin: 'https://evil.example', 'x-cwm-csrf': '1', 'content-type': 'application/json' },
      data: { reason: 'csrf attempt here' },
    });
    expect(crossSite.status()).toBe(403);
  });

  test('token endpoints and mobile-only endpoints are not reachable through the gateway', async ({ page }) => {
    await login(page, 'subAdminA');
    for (const path of ['auth/refresh', 'AUTH/login', 'auth/login/', 'media/upload-url', 'devices', 'complaints/../auth/refresh']) {
      const status = await page.evaluate(async (p) => (await fetch(`/bff/api/${p}`, {
        method: 'POST', headers: { 'x-cwm-csrf': '1', 'content-type': 'application/json' }, body: '{}',
      })).status, path);
      expect(status, path).toBe(404);
    }
  });

  test('no open redirect after login', async ({ page }) => {
    await login(page, 'subAdminA', { next: 'https://evil.example/phish', expectPath: /localhost:\d+\/dashboard/ });
  });

  test('an expired access token is refreshed transparently, once, even under parallel requests', async ({ page, context }) => {
    await login(page, 'subAdminA');
    const cookies = await context.cookies();
    // Drop the access token; only the refresh cookie remains.
    await context.clearCookies({ name: 'cwm_at' });
    expect(cookies.find((c) => c.name === 'cwm_rt')).toBeDefined();
    const statuses = await page.evaluate(async () =>
      Promise.all(Array.from({ length: 6 }, () => fetch('/bff/api/reports/summary', { headers: { 'x-cwm-csrf': '1' } }).then((r) => r.status))));
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);
    // The rotated session still works (no reuse detection triggered by the parallel refreshes).
    await page.goto('/dashboard');
    await expect(page.getByTestId('kpi-received')).toBeVisible();
  });

  test('without any session cookie the portal redirects to login and the gateway answers 401', async ({ page, context }) => {
    await login(page, 'subAdminA');
    await context.clearCookies();
    await page.goto('/users');
    await expect(page).toHaveURL(/\/login\?next=%2Fusers/);
    const status = await page.evaluate(async () => (await fetch('/bff/api/reports/summary', { headers: { 'x-cwm-csrf': '1' } })).status);
    expect(status).toBe(401);
  });
});
