import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { backend } from './backend';
import { COOKIES } from './config';
import { csrfOk } from './csrf';
import { SessionTokens, setMfaCookie, setSessionCookies } from './session';

export const forbidden = () => NextResponse.json({ message: 'Forbidden' }, { status: 403 });

/** Shared guard for BFF handlers: CSRF check, JSON body, forwarded client IP. */
export async function bffInput(req: Request): Promise<{ body: Record<string, unknown>; ip: string | null } | NextResponse> {
  if (!csrfOk(req)) return forbidden();
  let body: Record<string, unknown> = {};
  if (req.method !== 'GET') {
    try {
      body = (await req.json()) ?? {};
    } catch {
      body = {};
    }
  }
  return { body, ip: req.headers.get('x-forwarded-for') };
}

/** Relay an API auth result: tokens go into httpOnly cookies, never into the response body. */
export async function relayAuth(res: Response, extra: (data: Record<string, unknown>) => Record<string, unknown> = () => ({})) {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) return NextResponse.json({ message: data.message ?? 'Request failed' }, { status: res.status });
  const jar = await cookies();
  if (data.accessToken) {
    setSessionCookies(jar, data as unknown as SessionTokens);
    return NextResponse.json({ status: 'OK', ...extra(data) });
  }
  if (data.mfaToken) setMfaCookie(jar, String(data.mfaToken));
  return NextResponse.json({ status: data.status, ...extra(data) });
}

export async function mfaToken(): Promise<string | undefined> {
  return (await cookies()).get(COOKIES.mfa)?.value;
}

export { backend };
