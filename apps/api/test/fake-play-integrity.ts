import { generateKeyPairSync, verify } from 'crypto';
import { createServer, IncomingMessage, Server } from 'http';
import type { IntegrityPayload } from '../src/modules/attestation/play-integrity';

/**
 * Stand-in for Google's OAuth token endpoint, Play Integrity decodeIntegrityToken and hCaptcha
 * siteverify. Real tokens are encrypted by Google; here a token is `fake.<base64url(JSON payload)>`
 * so tests (and the Dart contract test) can craft exactly the verdict they need.
 * Special tokens: "down" → 500, anything not starting with "fake." → 400.
 */
export async function fakePlayIntegrity() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const accessToken = 'ya29.integrity-access-token';
  const decodes: { packageName: string; payload?: IntegrityPayload }[] = [];
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let s = '';
      req.on('data', (d) => (s += d));
      req.on('end', () => resolve(s));
    });
  const json = (res: import('http').ServerResponse, status: number, body: unknown) =>
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

  const server: Server = createServer(async (req, res) => {
    const text = await read(req);
    if (req.url === '/token') {
      const [h, p, sig] = (new URLSearchParams(text).get('assertion') ?? '').split('.');
      const ok = verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig ?? '', 'base64url'));
      const claims = ok ? JSON.parse(Buffer.from(p, 'base64url').toString()) : {};
      if (!ok || claims.scope !== 'https://www.googleapis.com/auth/playintegrity') return json(res, 401, { error: 'invalid_grant' });
      return json(res, 200, { access_token: accessToken, expires_in: 3600 });
    }
    if (req.url === '/siteverify') return json(res, 200, { success: new URLSearchParams(text).get('response') === 'human' });
    const m = req.url?.match(/^\/v1\/([^/:]+):decodeIntegrityToken$/);
    if (m) {
      if (req.headers.authorization !== `Bearer ${accessToken}`) return json(res, 401, {});
      const token = (JSON.parse(text) as { integrity_token: string }).integrity_token;
      if (token === 'down') return json(res, 500, {});
      if (!token.startsWith('fake.')) return json(res, 400, { error: { status: 'INVALID_ARGUMENT' } });
      const payload = JSON.parse(Buffer.from(token.slice(5), 'base64url').toString()) as IntegrityPayload;
      decodes.push({ packageName: decodeURIComponent(m[1]), payload });
      // Google only decodes tokens minted for this package.
      if (payload.requestDetails?.requestPackageName !== decodeURIComponent(m[1])) return json(res, 400, { error: { status: 'INVALID_ARGUMENT' } });
      return json(res, 200, { tokenPayloadExternal: payload });
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const serviceAccount = {
    project_id: 'cwm-test',
    client_email: 'integrity@cwm-test.iam.gserviceaccount.com',
    private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    token_uri: `${base}/token`,
  };
  return {
    decodes,
    apiBase: base,
    siteverifyUrl: `${base}/siteverify`,
    serviceAccountB64: Buffer.from(JSON.stringify(serviceAccount)).toString('base64'),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export const CERT = 'cwm-release-cert-sha256';

/** A token whose payload passes every check for [packageName] and [nonce], with overrides. */
export function fakeToken(packageName: string, nonce: string, o: { app?: string; device?: string[]; cert?: string; ageMs?: number; pkg?: string } = {}) {
  const payload: IntegrityPayload = {
    requestDetails: { requestPackageName: o.pkg ?? packageName, nonce, timestampMillis: String(Date.now() - (o.ageMs ?? 0)) },
    appIntegrity: { appRecognitionVerdict: o.app ?? 'PLAY_RECOGNIZED', packageName: o.pkg ?? packageName, certificateSha256Digest: [o.cert ?? CERT] },
    deviceIntegrity: { deviceRecognitionVerdict: o.device ?? ['MEETS_DEVICE_INTEGRITY', 'MEETS_BASIC_INTEGRITY'] },
  };
  return `fake.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}
