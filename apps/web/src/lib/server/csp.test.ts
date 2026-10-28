import { afterEach, describe, expect, it, vi } from 'vitest';

async function csp(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const { buildCsp } = await import('./csp');
  return buildCsp('NONCE');
}

describe('CSP', () => {
  afterEach(() => {
    delete process.env.HCAPTCHA_SITE_KEY;
  });

  it('allows no third-party script, frame or connection without hCaptcha', async () => {
    const p = await csp({ HCAPTCHA_SITE_KEY: undefined });
    expect(p).toContain("script-src 'self' 'nonce-NONCE' 'strict-dynamic'");
    expect(p).not.toMatch(/hcaptcha/);
    expect(p).not.toMatch(/frame-src/);
    expect(p).toContain("frame-ancestors 'none'");
  });

  it('adds only the hCaptcha hosts (script, frame, connect) when a site key is configured', async () => {
    const p = await csp({ HCAPTCHA_SITE_KEY: '10000000-ffff-ffff-ffff-000000000001' });
    expect(p).toContain("script-src 'self' 'nonce-NONCE' 'strict-dynamic' https://hcaptcha.com https://*.hcaptcha.com");
    expect(p).toContain('frame-src https://hcaptcha.com https://*.hcaptcha.com');
    expect(p).toContain("connect-src 'self' https://hcaptcha.com https://*.hcaptcha.com");
    expect(p).not.toMatch(/unsafe-inline'[^;]*script|script-src[^;]*unsafe-inline/);
  });
});
