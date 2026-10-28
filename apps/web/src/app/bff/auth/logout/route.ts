import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { backend, bffInput } from '@/lib/server/bff';
import { COOKIES } from '@/lib/server/config';
import { clearSessionCookies } from '@/lib/server/session';

export async function POST(req: Request) {
  const input = await bffInput(req);
  if (input instanceof Response) return input;
  const jar = await cookies();
  const refreshToken = jar.get(COOKIES.refresh)?.value;
  if (refreshToken) await backend('/auth/logout', { method: 'POST', body: { refreshToken }, forwardedFor: input.ip }).catch(() => undefined);
  clearSessionCookies(jar);
  return NextResponse.json({ status: 'OK' });
}
