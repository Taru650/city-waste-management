import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { backend, bffInput, relayAuth } from '@/lib/server/bff';
import { COOKIES } from '@/lib/server/config';

/** Changing the password rotates the session; the new tokens go into cookies. */
export async function POST(req: Request) {
  const input = await bffInput(req);
  if (input instanceof Response) return input;
  const token = (await cookies()).get(COOKIES.access)?.value;
  if (!token) return NextResponse.json({ message: 'Session expired' }, { status: 401 });
  const { currentPassword, newPassword } = input.body;
  const res = await backend('/auth/change-password', { method: 'POST', token, body: { currentPassword, newPassword }, forwardedFor: input.ip });
  return relayAuth(res);
}
