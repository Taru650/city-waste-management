import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { backend } from '@/lib/server/backend';
import { COOKIES } from '@/lib/server/config';
import { clearSessionCookies, refreshSession, setSessionCookies } from '@/lib/server/session';
import { safeNext } from '@/lib/client/safe-next';

/**
 * The portal layout sends the browser here when the API rejects an access token that has not
 * expired yet (session signed out, account disabled, password changed on another device, or a
 * token from before session binding). Server Components cannot change cookies, so without this
 * step the proxy (which only reads the expiry) and the layout bounced the browser between
 * /dashboard and /login until the token expired.
 *
 * One refresh attempt keeps a still-valid session going; otherwise the cookies are cleared and the
 * user signs in again. Nothing is cleared while the current token still works, so a link to this
 * URL cannot sign anyone out.
 */
export async function GET(req: NextRequest) {
  const next = safeNext(req.nextUrl.searchParams.get('next'));
  const jar = await cookies();
  const ip = req.headers.get('x-forwarded-for');
  const check = async (token: string | undefined): Promise<'ok' | 'rejected'> => {
    if (!token) return 'rejected';
    const res = await backend('/auth/me', { token, forwardedFor: ip });
    if (res.ok) return 'ok';
    if (res.status === 401) return 'rejected';
    // API trouble is not a signed-out user: keep the session and let the error page explain.
    throw new Error(`Session check failed (${res.status})`);
  };

  if ((await check(jar.get(COOKIES.access)?.value)) === 'ok') return NextResponse.redirect(new URL(next, req.url));
  const refresh = jar.get(COOKIES.refresh)?.value;
  const tokens = refresh ? await refreshSession(refresh, ip) : null;
  if (tokens && (await check(tokens.accessToken)) === 'ok') {
    setSessionCookies(jar, tokens);
    return NextResponse.redirect(new URL(next, req.url));
  }
  clearSessionCookies(jar);
  const to = new URL('/login', req.url);
  to.searchParams.set('next', next);
  return NextResponse.redirect(to);
}
