import { NextResponse } from 'next/server';
import QRCode from 'qrcode';
import { backend, bffInput, mfaToken } from '@/lib/server/bff';

/** Returns the authenticator QR code (rendered server-side) and the secret for manual entry. */
export async function POST(req: Request) {
  const input = await bffInput(req);
  if (input instanceof Response) return input;
  const token = await mfaToken();
  if (!token) return NextResponse.json({ message: 'Sign in again' }, { status: 401 });
  const res = await backend('/auth/mfa/enroll', { method: 'POST', body: { mfaToken: token }, forwardedFor: input.ip });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return NextResponse.json({ message: data.message ?? 'Sign in again' }, { status: res.status });
  const otpauthUrl = String(data.otpauthUrl).replace('CityWasteMgmt:', 'Swachh%20Seva:');
  return NextResponse.json({ secret: data.secret, qr: await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 }) });
}
