import { NextResponse } from 'next/server';
import { backend, bffInput } from '@/lib/server/bff';

export async function POST(req: Request) {
  const input = await bffInput(req);
  if (input instanceof Response) return input;
  const { token, newPassword } = input.body;
  const res = await backend('/auth/reset-password', { method: 'POST', body: { token, newPassword }, forwardedFor: input.ip });
  if (res.status === 204) return NextResponse.json({ status: 'OK' });
  const data = await res.json().catch(() => ({}));
  return NextResponse.json({ message: data.message ?? 'Reset failed' }, { status: res.status });
}
