import { serverConfig } from './config';

export const CSRF_HEADER = 'x-cwm-csrf';

/**
 * Defence in depth on top of SameSite=Strict cookies: state-changing BFF calls must come
 * from our own origin and carry a custom header (which a cross-site form or image cannot set,
 * and a cross-site fetch cannot send without a CORS preflight we never answer).
 */
export function csrfOk(req: Request): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  if (req.headers.get(CSRF_HEADER) !== '1') return false;
  const origin = req.headers.get('origin');
  const site = req.headers.get('sec-fetch-site');
  if (origin) return origin === expectedOrigin(req);
  return site === 'same-origin';
}

export function expectedOrigin(req: Request): string {
  if (serverConfig.portalOrigin) return serverConfig.portalOrigin;
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  const proto = req.headers.get('x-forwarded-proto') ?? new URL(req.url).protocol.replace(':', '');
  return `${proto}://${host}`;
}
