import { NextResponse } from 'next/server';
import { backend, bffInput } from '@/lib/server/bff';

export async function POST(req: Request) {
  const input = await bffInput(req);
  if (input instanceof Response) return input;
  const res = await backend('/auth/forgot-password', { method: 'POST', body: { identifier: input.body.identifier, captchaToken: input.body.captchaToken }, forwardedFor: input.ip });
  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
