import { serverConfig, COOKIES } from './config';
import { backend } from './backend';

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface CookieJar {
  set(name: string, value: string, options: Record<string, unknown>): unknown;
  delete(name: string): unknown;
}

const REFRESH_MAX_AGE = 7 * 24 * 3600;

const base = () => ({ httpOnly: true, secure: serverConfig.cookieSecure, sameSite: 'strict' as const, path: '/' });

export function setSessionCookies(jar: CookieJar, t: SessionTokens) {
  jar.set(COOKIES.access, t.accessToken, { ...base(), maxAge: t.expiresIn });
  jar.set(COOKIES.refresh, t.refreshToken, { ...base(), maxAge: REFRESH_MAX_AGE });
  jar.delete(COOKIES.mfa);
}

export function clearSessionCookies(jar: CookieJar) {
  for (const name of Object.values(COOKIES)) jar.set(name, '', { ...base(), maxAge: 0 });
}

export function setMfaCookie(jar: CookieJar, mfaToken: string) {
  jar.set(COOKIES.mfa, mfaToken, { ...base(), maxAge: 300 });
}

/** Seconds until the JWT expires (no signature check: the API verifies; this only decides when to refresh). */
export function secondsLeft(jwt: string | undefined): number {
  if (!jwt) return 0;
  try {
    const { exp } = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
    return typeof exp === 'number' ? exp - Math.floor(Date.now() / 1000) : 0;
  } catch {
    return 0;
  }
}

/**
 * Refresh tokens are single-use and reuse revokes the whole session (theft detection), so
 * parallel requests from one browser must not each refresh. Concurrent callers with the same
 * refresh token share one in-flight refresh, and the result is remembered briefly for
 * requests that arrive just after. (Multiple portal replicas need sticky sessions.)
 */
const inflight = new Map<string, Promise<SessionTokens | null>>();
const recent = new Map<string, { tokens: SessionTokens; until: number }>();

export function refreshSession(refreshToken: string, forwardedFor?: string | null): Promise<SessionTokens | null> {
  const cached = recent.get(refreshToken);
  if (cached && cached.until > Date.now()) return Promise.resolve(cached.tokens);
  const running = inflight.get(refreshToken);
  if (running) return running;
  const p = (async () => {
    try {
      const res = await backend('/auth/refresh', { method: 'POST', body: { refreshToken }, forwardedFor });
      if (!res.ok) return null;
      const tokens = (await res.json()) as SessionTokens;
      recent.set(refreshToken, { tokens, until: Date.now() + 30_000 });
      return tokens;
    } catch {
      return null;
    } finally {
      setTimeout(() => inflight.delete(refreshToken), 0);
      for (const [k, v] of recent) if (v.until < Date.now()) recent.delete(k);
    }
  })();
  inflight.set(refreshToken, p);
  return p;
}
