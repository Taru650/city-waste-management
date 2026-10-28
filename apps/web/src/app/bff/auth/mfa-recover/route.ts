import { NextResponse } from 'next/server';
import { backend, bffInput, mfaToken, relayAuth } from '@/lib/server/bff';

export async function POST(req: Request) {
  const input = await bffInput(req);
  if (input instanceof Response) return input;
  const token = await mfaToken();
  if (!token) return NextResponse.json({ message: 'Sign in again' }, { status: 401 });
  const res = await backend('/auth/mfa/recover', {
    method: 'POST', body: { mfaToken: token, recoveryCode: input.body.recoveryCode }, forwardedFor: input.ip,
  });
  return relayAuth(res, (d) => ({ recoveryCodesRemaining: d.recoveryCodesRemaining }));
}
