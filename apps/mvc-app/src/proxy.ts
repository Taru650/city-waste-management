import { NextRequest, NextResponse } from 'next/server';
import { getConfig } from '@/config/env';
import { corsHeaders } from '@/middleware/cors';
import { buildCsp } from '@/middleware/csp';
import { COOKIES } from '@/middleware/http';

const PUBLIC = ['/login', '/forgot-password', '/reset-password', '/privacy', '/session'];

/**
 * Runs before every page and API request:
 *  - API: answers CORS preflights and labels responses for the origins listed in CORS_ORIGINS;
 *  - pages: gives each response a fresh CSP nonce (Next applies it to its own scripts) and sends visitors
 *    with no session cookie to the sign-in page. The cookie only says "a session may exist"; the portal
 *    layout validates it against the database on every page, and /session renews or ends it.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const cfg = getConfig();

  if (pathname.startsWith('/api/')) {
    const cors = corsHeaders(request.headers.get('origin'), cfg.corsOrigins);
    if (request.method === 'OPTIONS' && request.headers.has('access-control-request-method')) {
      return new NextResponse(null, { status: cors ? 204 : 403, headers: cors ?? {} });
    }
    const res = NextResponse.next();
    for (const [k, v] of Object.entries(cors ?? {})) res.headers.set(k, v);
    return res;
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = buildCsp(nonce, {
    tileOrigin: new URL(cfg.mapTileUrl.replace(/\{[a-z]\}/g, 'a')).origin,
    dev: cfg.env === 'development',
    upgradeInsecure: cfg.appUrl.startsWith('https://'),
  });
  const hasSession = !!(request.cookies.get(COOKIES.access)?.value || request.cookies.get(COOKIES.refresh)?.value);
  const isPublic = PUBLIC.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const finish = (res: NextResponse) => {
    res.headers.set('Content-Security-Policy', csp);
    return res;
  };

  if (pathname === '/') return finish(NextResponse.redirect(new URL(hasSession ? '/dashboard' : '/login', request.url)));
  if (!hasSession && !isPublic) {
    const to = new URL('/login', request.url);
    to.searchParams.set('next', `${pathname}${search}`);
    return finish(NextResponse.redirect(to));
  }

  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('x-pathname', pathname);
  headers.set('Content-Security-Policy', csp);
  return finish(NextResponse.next({ request: { headers } }));
}

export const config = {
  matcher: [
    {
      source: '/((?!_next/static|_next/image|favicon.ico|icon.svg|leaflet).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
