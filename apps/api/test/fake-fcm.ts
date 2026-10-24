import { generateKeyPairSync, verify } from 'crypto';
import { createServer, IncomingMessage, Server } from 'http';

export interface FcmMessage {
  token: string;
  notification: { title: string; body: string };
  data: Record<string, string>;
}

/**
 * Stand-in for Google's OAuth token endpoint and FCM HTTP v1. Verifies the service-account
 * JWT signature for real. Token prefixes drive behaviour: "dead-" → 404 UNREGISTERED,
 * "flaky-" → 500, "bad-" → 400.
 */
export async function fakeFcm() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const messages: FcmMessage[] = [];
  const tokenRequests: { assertionClaims: Record<string, unknown> }[] = [];
  let accessToken = 'ya29.fake-access-token';

  const body = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let s = '';
      req.on('data', (d) => (s += d));
      req.on('end', () => resolve(s));
    });

  const server: Server = createServer(async (req, res) => {
    const text = await body(req);
    if (req.url === '/token') {
      const assertion = new URLSearchParams(text).get('assertion') ?? '';
      const [h, p, sig] = assertion.split('.');
      const ok = verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig ?? '', 'base64url'));
      if (!ok) return res.writeHead(401).end('{"error":"invalid_grant"}');
      tokenRequests.push({ assertionClaims: JSON.parse(Buffer.from(p, 'base64url').toString()) });
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: accessToken, expires_in: 3600 }));
    }
    if (req.url?.startsWith('/v1/projects/cwm-test/messages:send')) {
      if (req.headers.authorization !== `Bearer ${accessToken}`) return res.writeHead(401).end('{}');
      const { message } = JSON.parse(text) as { message: FcmMessage };
      if (message.token.startsWith('dead-')) {
        return res.writeHead(404, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }));
      }
      if (message.token.startsWith('flaky-')) return res.writeHead(500).end('{}');
      if (message.token.startsWith('bad-')) return res.writeHead(400).end('{"error":{"status":"INVALID_ARGUMENT"}}');
      messages.push(message);
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name: `projects/cwm-test/messages/${messages.length}` }));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const serviceAccount = {
    project_id: 'cwm-test',
    client_email: 'push@cwm-test.iam.gserviceaccount.com',
    private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    token_uri: `http://127.0.0.1:${port}/token`,
  };
  return {
    server,
    messages,
    tokenRequests,
    apiBase: `http://127.0.0.1:${port}`,
    serviceAccountB64: Buffer.from(JSON.stringify(serviceAccount)).toString('base64'),
    rotateAccessToken: () => (accessToken = `ya29.rotated-${Date.now()}`),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
