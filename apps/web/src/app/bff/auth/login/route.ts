import { backend, bffInput, relayAuth } from '@/lib/server/bff';

export async function POST(req: Request) {
  const input = await bffInput(req);
  if (input instanceof Response) return input;
  const { identifier, password, captchaToken } = input.body;
  const res = await backend('/auth/login', { method: 'POST', body: { identifier, password, captchaToken }, forwardedFor: input.ip });
  return relayAuth(res);
}
