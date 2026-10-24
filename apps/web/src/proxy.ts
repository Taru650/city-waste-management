import { NextRequest, NextResponse } from 'next/server';
import { COOKIES } from './lib/server/config';
import { buildCsp } from './lib/server/csp';
import { refreshSession, secondsLeft, setSessionCookies } from './lib/server/session';

const PUBLIC = ['/login', '/forgot-password', '/reset-password'];

/**
 * Runs before every page render:
 *  - sets a fresh CSP nonce (Next applies it to its own scripts),
 *  - refreshes an expiring session here, because Server Components cannot set cookies,
 *  - sends anyone without a session to /login.
 */
export async function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = buildCsp(nonce);
  const { pathname, search } = request.nextUrl;
  const isPublic = PUBLIC.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  let access = request.cookies.get(COOKIES.access)?.value;
  const refresh = request.cookies.get(COOKIES.refresh)?.value;
  let refreshed: Awaited<ReturnType<typeof refreshSession>> = null;
  if (secondsLeft(access) < 60 && refresh) {
    refreshed = await refreshSession(refresh, request.headers.get('x-forwarded-for'));
    access = refreshed?.accessToken;
  }
  const signedIn = secondsLeft(access) > 0;

  const finish = (res: NextResponse) => {
    res.headers.set('Content-Security-Policy', csp);
    if (refreshed) setSessionCookies(res.cookies, refreshed);
    return res;
  };

  if (pathname === '/') return finish(NextResponse.redirect(new URL(signedIn ? '/dashboard' : '/login', request.url)));
  if (!signedIn && !isPublic) {
    const to = new URL('/login', request.url);
    to.searchParams.set('next', `${pathname}${search}`);
    return finish(NextResponse.redirect(to));
  }
  if (signedIn && isPublic) return finish(NextResponse.redirect(new URL('/dashboard', request.url)));

  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set('x-pathname', pathname);
  headers.set('Content-Security-Policy', csp);
  if (refreshed) {
    // Let this render see the new access token.
    const jar = new Map(request.cookies.getAll().map((c) => [c.name, c.value]));
    jar.set(COOKIES.access, refreshed.accessToken);
    jar.set(COOKIES.refresh, refreshed.refreshToken);
    headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
  }
  return finish(NextResponse.next({ request: { headers } }));
}

export const config = {
  matcher: [
    {
      source: '/((?!bff|_next/static|_next/image|favicon.ico|leaflet).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
