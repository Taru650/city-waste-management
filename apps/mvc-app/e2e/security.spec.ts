import { expect, test } from '@playwright/test';
import { login, USERS } from './fixtures';
import { PASSWORD } from './env.mjs';

const ALLOWED = 'https://partner.example'; // CORS_ORIGINS in e2e/env.mjs

test.describe('Cross-site protection', () => {
  test('a cookie-authenticated write without the CSRF header is refused', async ({ page }) => {
    await login(page, 'subAdmin');
    const r = await page.request.post('/api/v1/notifications/read-all', { data: {} });
    expect(r.status()).toBe(403);
  });

  test('a cookie-authenticated write claiming to come from another site is refused', async ({ page }) => {
    await login(page, 'subAdmin');
    const r = await page.request.post('/api/v1/notifications/read-all', { data: {}, headers: { 'x-cwm-csrf': '1', origin: 'https://evil.example' } });
    expect(r.status()).toBe(403);
  });

  test('the same write from our own page works', async ({ page }) => {
    await login(page, 'subAdmin');
    const status = await page.evaluate(async () => (await fetch('/api/v1/notifications/read-all', {
      method: 'POST', headers: { 'x-cwm-csrf': '1', 'content-type': 'application/json' }, body: '{}', credentials: 'same-origin',
    })).status);
    expect(status).toBeLessThan(300);
  });
});

test.describe('CORS (apps and other websites use bearer tokens, never cookies)', () => {
  test('a preflight from a listed origin is answered, without credentials', async ({ request }) => {
    const r = await request.fetch('/api/v1/complaints', {
      method: 'OPTIONS',
      headers: { origin: ALLOWED, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
    });
    expect(r.status()).toBe(204);
    expect(r.headers()['access-control-allow-origin']).toBe(ALLOWED);
    expect(r.headers()['access-control-allow-credentials']).toBeUndefined();
    expect(r.headers()['access-control-allow-headers']).toContain('Authorization');
  });

  test('a preflight from an unlisted origin is refused', async ({ request }) => {
    const r = await request.fetch('/api/v1/complaints', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(r.status()).toBe(403);
    expect(r.headers()['access-control-allow-origin']).toBeUndefined();
  });

  test('responses to a listed origin carry the CORS headers; others do not', async ({ request }) => {
    const ok = await request.get('/api/v1/health', { headers: { origin: ALLOWED } });
    expect(ok.headers()['access-control-allow-origin']).toBe(ALLOWED);
    expect(ok.headers().vary).toContain('Origin');
    const no = await request.get('/api/v1/health', { headers: { origin: 'https://evil.example' } });
    expect(no.headers()['access-control-allow-origin']).toBeUndefined();
  });

  test('a listed origin with a bearer token can use the API; the same origin with only a cookie cannot write', async ({ request, playwright, baseURL }) => {
    const login1 = await request.post('/api/v1/auth/login', { data: { identifier: USERS.subAdmin, password: PASSWORD } });
    const { accessToken } = await login1.json();
    expect(accessToken).toBeTruthy();
    const withToken = await request.get('/api/v1/complaints', { headers: { origin: ALLOWED, authorization: `Bearer ${accessToken}` } });
    expect(withToken.status()).toBe(200);
    // Cookie session + foreign origin + the right header: still refused (origin mismatch).
    const ctx = await playwright.request.newContext({ baseURL });
    await ctx.post('/api/v1/auth/login', { data: { identifier: USERS.subAdmin, password: PASSWORD, session: 'cookie' }, headers: { 'x-cwm-csrf': '1' } });
    const w = await ctx.post('/api/v1/notifications/read-all', { data: {}, headers: { 'x-cwm-csrf': '1', origin: ALLOWED } });
    expect(w.status()).toBe(403);
    await ctx.dispose();
  });
});

test.describe('Page and API headers', () => {
  test('API responses are never cached and carry nosniff', async ({ request }) => {
    const r = await request.get('/api/v1/health');
    expect(r.headers()['cache-control']).toBe('no-store');
    expect(r.headers()['x-content-type-options']).toBe('nosniff');
  });

  test('pages send the security headers', async ({ request }) => {
    const r = await request.get('/login');
    const h = r.headers();
    expect(h['strict-transport-security']).toContain('max-age=');
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['referrer-policy']).toBe('no-referrer');
    expect(h['permissions-policy']).toContain('camera=()');
    expect(h['x-powered-by']).toBeUndefined();
  });

  test('every portal page needs a session', async ({ request }) => {
    for (const p of ['/dashboard', '/complaints', '/masters', '/users', '/event-zones', '/notifications', '/account']) {
      const r = await request.get(p, { maxRedirects: 0 });
      expect(r.status(), p).toBe(307);
      expect(r.headers().location, p).toContain('/login');
    }
  });
});
