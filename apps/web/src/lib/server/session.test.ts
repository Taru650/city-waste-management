import { afterEach, describe, expect, it, vi } from 'vitest';
import { refreshSession, secondsLeft } from './session';

const jwt = (exp: number) => `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.y`;

describe('secondsLeft', () => {
  it('reads exp without trusting the token for anything else', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(secondsLeft(jwt(now + 100))).toBeGreaterThan(95);
    expect(secondsLeft(jwt(now - 5))).toBeLessThan(0);
    expect(secondsLeft('garbage')).toBe(0);
    expect(secondsLeft(undefined)).toBe(0);
  });
});

describe('refreshSession single-flight', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('parallel callers with the same refresh token share one API call (rotation reuse would revoke the session)', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ accessToken: 'a2', refreshToken: 'r2', expiresIn: 900 }), { status: 200 });
    }));
    const results = await Promise.all([refreshSession('r1'), refreshSession('r1'), refreshSession('r1')]);
    expect(calls).toBe(1);
    expect(results.every((r) => r?.refreshToken === 'r2')).toBe(true);
    // a late request with the old token within the grace window reuses the result
    expect((await refreshSession('r1'))?.accessToken).toBe('a2');
    expect(calls).toBe(1);
  });

  it('returns null when the API refuses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    expect(await refreshSession('revoked')).toBeNull();
  });
});
