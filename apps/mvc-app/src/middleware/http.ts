import { getConfig } from '@/config/env';

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

export const COOKIES = { access: 'cwm_at', refresh: 'cwm_rt' } as const;
export const CSRF_HEADER = 'x-cwm-csrf';

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name && !(name in out)) out[name] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Session cookies: httpOnly (scripts cannot read them), SameSite=Strict (never sent from another site). */
export function sessionCookie(name: string, value: string, maxAgeSeconds: number): string {
  const secure = getConfig().cookieSecure ? '; Secure' : '';
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

export function clearCookie(name: string): string {
  return sessionCookie(name, '', 0);
}

/**
 * The caller's IP for rate limits and the audit log, or null when it cannot be known safely.
 *
 * Next.js passes a client-supplied X-Forwarded-For through unchanged, so the header is only believed
 * for the number of reverse proxies you declare (TRUST_PROXY_HOPS): each trusted proxy appends the address
 * it received the request from, so with N proxies the client is the Nth entry from the right. With no proxy
 * declared (local development) the header is ignored, because anyone could forge it.
 */
export function clientInfo(req: Request): ClientInfo {
  const hops = getConfig().trustProxyHops;
  let ip: string | null = null;
  const xff = req.headers.get('x-forwarded-for');
  if (hops > 0 && xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    ip = parts[Math.max(0, parts.length - hops)] ?? null;
  }
  return { ip: ip?.slice(0, 64) ?? null, userAgent: req.headers.get('user-agent')?.slice(0, 255) ?? null };
}

/** Where this request says it came from, for the same-origin check. */
export function expectedOrigin(req: Request): string {
  const c = getConfig();
  if (c.production) return c.appUrl;
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  const proto = req.headers.get('x-forwarded-proto') ?? new URL(req.url).protocol.replace(':', '');
  return `${proto}://${host}`;
}

/**
 * CSRF defence for cookie sessions, on top of SameSite=Strict: state-changing requests must come from our
 * own origin and carry a custom header (which a cross-site form or image cannot set, and a cross-site fetch
 * cannot send without a CORS preflight that we never approve).
 */
export function csrfOk(req: Request): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  if (req.headers.get(CSRF_HEADER) !== '1') return false;
  const origin = req.headers.get('origin');
  if (origin) return origin === expectedOrigin(req);
  return req.headers.get('sec-fetch-site') === 'same-origin';
}
