import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { backend } from '@/lib/server/backend';
import { COOKIES } from '@/lib/server/config';
import { csrfOk } from '@/lib/server/csrf';
import { isBlocked, normalisePath } from '@/lib/server/proxy-rules';
import { clearSessionCookies, refreshSession, secondsLeft, setSessionCookies } from '@/lib/server/session';

/**
 * Same-origin gateway from the browser to the API. Adds the Bearer token from the httpOnly
 * cookie, refreshes once on expiry, and streams the response back (JSON or file exports).
 * Endpoints that only make sense on the server are not reachable through here.
 */
const PASS_HEADERS = ['content-type', 'content-disposition'];

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  if (!csrfOk(req)) return NextResponse.json({ message: 'Forbidden' }, { status: 403 });
  const segments = (await ctx.params).path;
  if (isBlocked(segments)) return NextResponse.json({ message: 'Not found' }, { status: 404 });
  const path = normalisePath(segments).split('/').map(encodeURIComponent).join('/');

  const jar = await cookies();
  let access = jar.get(COOKIES.access)?.value;
  const refresh = jar.get(COOKIES.refresh)?.value;
  const ip = req.headers.get('x-forwarded-for');
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await req.text();
  let refreshed = null;

  if (secondsLeft(access) < 30 && refresh) {
    refreshed = await refreshSession(refresh, ip);
    access = refreshed?.accessToken;
  }
  if (!access) {
    clearSessionCookies(jar);
    return NextResponse.json({ message: 'Session expired' }, { status: 401 });
  }

  const call = (token: string) =>
    backend(`/${path}${req.nextUrl.search}`, {
      method: req.method, token, rawBody: body || undefined, forwardedFor: ip,
      headers: body ? { 'content-type': 'application/json' } : {},
    });
  let res = await call(access);
  if (res.status === 401 && refresh && !refreshed) {
    refreshed = await refreshSession(refresh, ip);
    if (refreshed) res = await call(refreshed.accessToken);
  }
  if (refreshed) setSessionCookies(jar, refreshed);
  if (res.status === 401) clearSessionCookies(jar);

  const headers = new Headers({ 'cache-control': 'no-store' });
  for (const h of PASS_HEADERS) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new NextResponse(res.body, { status: res.status, headers });
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
