import { createHash } from 'crypto';
import { createServer, IncomingHttpHeaders, Server } from 'http';
import { AddressInfo } from 'net';
import { Role } from '../../src/common/enums';
import { NOTICE_VERSION } from '../../src/modules/privacy/notice';
import { api, bearer, createJurisdiction, createTestApp, createUser, Jurisdiction, PASSWORD, TestCtx, tokenFor, uniqueMobile } from '../helpers';

/** HIBP k-anonymity range API, against a local stand-in (the real service is not reachable from CI). */
const LEAKED = 'Kanpur#Leak2026';
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex').toUpperCase();

describe('Breached-password check (M10)', () => {
  let ctx: TestCtx;
  let j: Jurisdiction;
  let server: Server;
  let behaviour: 'ok' | 'down' | 'slow' = 'ok';
  const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
  const saved = { mode: process.env.BREACHED_PASSWORD_CHECK, url: process.env.BREACHED_PASSWORD_URL, t: process.env.BREACHED_PASSWORD_TIMEOUT_MS };

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ url: req.url!, headers: req.headers });
      if (behaviour === 'down') return res.writeHead(503).end();
      const respond = () => {
        const prefix = req.url!.split('/').pop()!;
        const lines = ['0018A45C4D1DEF81644B54AB7F969B88D65:0', '00D4F6E8FA6EECAD2A3AA415EEC418D38EC:2']; // padding + noise
        if (sha1(LEAKED).startsWith(prefix)) lines.push(`${sha1(LEAKED).slice(5)}:3730471`);
        res.writeHead(200, { 'content-type': 'text/plain' }).end(lines.join('\r\n'));
      };
      if (behaviour === 'slow') setTimeout(respond, 1500);
      else respond();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    Object.assign(process.env, {
      BREACHED_PASSWORD_CHECK: 'on', BREACHED_PASSWORD_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, BREACHED_PASSWORD_TIMEOUT_MS: '300',
    });
    ctx = await createTestApp();
    j = await createJurisdiction(ctx.ds);
  });

  afterAll(async () => {
    await ctx.app.close();
    server.close();
    for (const [k, v] of [['BREACHED_PASSWORD_CHECK', saved.mode], ['BREACHED_PASSWORD_URL', saved.url], ['BREACHED_PASSWORD_TIMEOUT_MS', saved.t]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  const register = (password: string) => ctx.http().post(api('/auth/register')).send({
    homeWardId: j.wards[0].id, name: 'Asha Devi', mobile: uniqueMobile(), email: `b${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.in`,
    password, consentNoticeVersion: NOTICE_VERSION,
  });

  it('refuses a breached password; only a 5-character hash prefix leaves the server, with padding requested', async () => {
    seen.length = 0;
    const res = await register(LEAKED).expect(400);
    expect(res.body.message).toMatch(/data breach/);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`/range/${sha1(LEAKED).slice(0, 5)}`);
    expect(seen[0].headers['add-padding']).toBe('true');
    expect(JSON.stringify(seen)).not.toContain(sha1(LEAKED).slice(5));
    expect(JSON.stringify(seen)).not.toContain(LEAKED);
  });

  it('accepts a password that is not in the list (padding entries with count 0 never match)', async () => {
    await register(PASSWORD).expect(201);
  });

  it('applies to password changes too', async () => {
    const token = await tokenFor(ctx, await createUser(ctx, Role.CITIZEN, j));
    const res = await ctx.http().post(api('/auth/change-password')).set(bearer(token)).send({ currentPassword: PASSWORD, newPassword: LEAKED }).expect(400);
    expect(res.body.message).toMatch(/data breach/);
  });

  it.each(['down', 'slow'] as const)('when the service is %s, registration is not blocked (deny-list still applies)', async (b) => {
    behaviour = b;
    const started = Date.now();
    await register(LEAKED).expect(201);
    expect(Date.now() - started).toBeLessThan(1500); // the timeout, not the slow response
    expect((await register('password123').expect(400)).body.message).toMatch(/too common/);
    behaviour = 'ok';
  });
});
