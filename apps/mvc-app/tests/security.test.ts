import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, base64url } from 'jose';
import { POST as login } from '@/app/api/v1/auth/login/route';
import { POST as refresh } from '@/app/api/v1/auth/refresh/route';
import { POST as logoutAll } from '@/app/api/v1/auth/logout-all/route';
import { POST as changePassword } from '@/app/api/v1/auth/change-password/route';
import { GET as me } from '@/app/api/v1/auth/me/route';
import { GET as health } from '@/app/api/v1/health/route';
import { buildConfig, getConfig, resetConfigForTests } from '@/config/env';
import { UserModel } from '@/models/UserModel';
import { newId } from '@/lib/ids';
import { BASE, PASSWORD, browser, call, cookieJar, createJurisdiction, createUser, db, one, run, useTestEnvironment, type Jurisdiction } from './helpers';

useTestEnvironment();

let j: Jurisdiction;
beforeAll(async () => {
  j = await createJurisdiction();
});

const secret = () => getConfig().jwtAccessSecret as Uint8Array;

async function session(role: 'CITIZEN' | 'SUPERVISOR' = 'CITIZEN') {
  const u = await createUser(role, j);
  const s = (await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: PASSWORD } })).body;
  const claims = JSON.parse(Buffer.from(s.accessToken.split('.')[1], 'base64url').toString());
  return { u, s, claims: claims as { sub: string; role: string; tv: number; sid: string } };
}

const forge = (claims: Record<string, unknown>, opts: { secret?: Uint8Array; exp?: string | number; alg?: 'HS256' } = {}) =>
  new SignJWT(claims).setProtectedHeader({ alg: opts.alg ?? 'HS256' }).setIssuedAt().setExpirationTime(opts.exp ?? '10m').sign(opts.secret ?? secret());

describe('access tokens cannot be forged or misused', () => {
  it('no credentials, garbage, a non-Bearer scheme and a token in the URL all give 401', async () => {
    const { s } = await session();
    expect((await call(me, 'GET', '/api/v1/auth/me')).status).toBe(401);
    expect((await call(me, 'GET', '/api/v1/auth/me', { token: 'not.a.jwt' })).status).toBe(401);
    expect((await call(me, 'GET', '/api/v1/auth/me', { headers: { authorization: `Basic ${s.accessToken}` } })).status).toBe(401);
    expect((await call(me, 'GET', '/api/v1/auth/me', { headers: { authorization: s.accessToken } })).status).toBe(401);
    expect((await call(me, 'GET', '/api/v1/auth/me', { query: { access_token: s.accessToken, token: s.accessToken } })).status).toBe(401);
  });

  it('a token signed with another key, with alg "none", or already expired is refused', async () => {
    const { claims } = await session();
    const base = { role: claims.role, tv: claims.tv, sid: claims.sid, typ: 'access' };
    const foreign = await forge({ ...base, sub: claims.sub }, { secret: new TextEncoder().encode('another-secret-another-secret-another-secret') });
    const expired = await forge({ ...base, sub: claims.sub }, { exp: Math.floor(Date.now() / 1000) - 60 });
    const none = `${base64url.encode(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${base64url.encode(JSON.stringify({ ...base, sub: claims.sub, exp: Math.floor(Date.now() / 1000) + 600 }))}.`;
    for (const token of [foreign, expired, none]) expect((await call(me, 'GET', '/api/v1/auth/me', { token })).status).toBe(401);
    // control: the same claims signed correctly are accepted
    expect((await call(me, 'GET', '/api/v1/auth/me', { token: await forge({ ...base, sub: claims.sub }) })).status).toBe(200);
  });

  it('a token tampered after signing is refused (payload swapped for another user\'s)', async () => {
    const a = await session();
    const b = await session();
    const [h, , sig] = a.s.accessToken.split('.');
    const swapped = `${h}.${b.s.accessToken.split('.')[1]}.${sig}`;
    expect((await call(me, 'GET', '/api/v1/auth/me', { token: swapped })).status).toBe(401);
  });

  it('the wrong token type, a missing / unknown / someone else\'s session id, and a stale version are refused', async () => {
    const a = await session();
    const b = await session();
    const ok = { sub: a.claims.sub, role: a.claims.role, tv: a.claims.tv, sid: a.claims.sid, typ: 'access' };
    const bad = [
      { ...ok, typ: 'refresh' },
      { ...ok, typ: undefined },
      { ...ok, sid: undefined },
      { ...ok, sid: newId() },
      { ...ok, sid: 'not-a-uuid' },
      { ...ok, sid: b.claims.sid }, // a live session, but not this user's
      { ...ok, tv: a.claims.tv + 1 },
      { ...ok, sub: 'x'.repeat(40) },
    ];
    for (const claims of bad) expect((await call(me, 'GET', '/api/v1/auth/me', { token: await forge(claims) })).status).toBe(401);
  });

  it('the role comes from the database, not from the token: a forged "WEB_ADMIN" claim changes nothing', async () => {
    const a = await session('CITIZEN');
    const token = await forge({ sub: a.claims.sub, role: 'WEB_ADMIN', tv: a.claims.tv, sid: a.claims.sid, typ: 'access' });
    const res = await call(me, 'GET', '/api/v1/auth/me', { token });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('CITIZEN');
  });

  it('a Bearer header that is wrong does not fall back to a valid cookie', async () => {
    const { u } = await session();
    const web = await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: PASSWORD, session: 'cookie' } });
    const jar = cookieJar(web);
    expect((await call(me, 'GET', '/api/v1/auth/me', { cookies: jar })).status).toBe(200);
    expect((await call(me, 'GET', '/api/v1/auth/me', { cookies: jar, token: 'junk' })).status).toBe(401);
  });

  it('raising a user\'s privileges in the database is picked up at once, and a token_version bump kills old tokens', async () => {
    const a = await session('SUPERVISOR');
    await run(db(), `UPDATE users SET token_version = token_version + 1 WHERE id = ?`, [a.u.id]);
    expect((await call(me, 'GET', '/api/v1/auth/me', { token: a.s.accessToken })).status).toBe(401);
  });
});

describe('cross-site request forgery (cookie sessions)', () => {
  async function webSession() {
    const u = await createUser('SUB_ADMIN', j);
    const web = await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: PASSWORD, session: 'cookie' } });
    return { u, jar: cookieJar(web) };
  }

  it('a state-changing request with only the cookie is refused', async () => {
    const { jar } = await webSession();
    expect((await call(logoutAll, 'POST', '/api/v1/auth/logout-all', { cookies: jar })).status).toBe(403);
  });

  it('header present but the Origin is another site, or the browser says cross-site: refused', async () => {
    const { jar } = await webSession();
    const attempts: Record<string, string>[] = [
      { 'x-cwm-csrf': '1', origin: 'https://evil.example' },
      { 'x-cwm-csrf': '1', origin: 'http://localhost:3001' },
      { 'x-cwm-csrf': '1', 'sec-fetch-site': 'cross-site' },
      { 'x-cwm-csrf': '1' },
      { origin: BASE },
      { 'x-cwm-csrf': 'true', origin: BASE },
    ];
    for (const headers of attempts) {
      expect((await call(logoutAll, 'POST', '/api/v1/auth/logout-all', { cookies: jar, headers })).status).toBe(403);
    }
  });

  it('same-origin requests pass, with an Origin header or with Sec-Fetch-Site', async () => {
    const a = await webSession();
    expect((await call(logoutAll, 'POST', '/api/v1/auth/logout-all', { cookies: a.jar, headers: { 'x-cwm-csrf': '1', origin: BASE } })).status).toBe(204);
    const b = await webSession();
    expect((await call(logoutAll, 'POST', '/api/v1/auth/logout-all', { cookies: b.jar, headers: { 'x-cwm-csrf': '1', 'sec-fetch-site': 'same-origin' } })).status).toBe(204);
  });

  it('apps sending a Bearer token need no CSRF header (nothing is sent automatically by a browser)', async () => {
    const { s } = await session();
    expect((await call(logoutAll, 'POST', '/api/v1/auth/logout-all', { token: s.accessToken })).status).toBe(204);
  });

  it('refresh and login also refuse cross-site requests that carry cookies, and GET is never blocked', async () => {
    const { u, jar } = await webSession();
    expect((await call(refresh, 'POST', '/api/v1/auth/refresh', { cookies: { cwm_rt: jar.cwm_rt }, body: {} })).status).toBe(403);
    expect((await call(login, 'POST', '/api/v1/auth/login', { cookies: jar, body: { identifier: u.mobile, password: PASSWORD } })).status).toBe(403);
    expect((await call(me, 'GET', '/api/v1/auth/me', { cookies: jar })).status).toBe(200);
    // no cookies at all (an app): no browser, nothing to forge
    expect((await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: PASSWORD } })).status).toBe(200);
  });

  it('changing the password by cookie needs the CSRF header too', async () => {
    const { u, jar } = await webSession();
    const body = { currentPassword: PASSWORD, newPassword: 'Brand#New2026x' };
    expect((await call(changePassword, 'POST', '/api/v1/auth/change-password', { cookies: jar, body })).status).toBe(403);
    expect((await call(changePassword, 'POST', '/api/v1/auth/change-password', { ...browser(jar), body })).status).toBe(200);
    expect(u.id).toBeTruthy();
  });

  it('session cookies are httpOnly + SameSite=Strict, and Secure when configured', async () => {
    const u = await createUser('SUPERVISOR', j);
    process.env.COOKIE_SECURE = 'true';
    resetConfigForTests();
    try {
      const res = await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: PASSWORD, session: 'cookie' } });
      expect(res.cookies.length).toBe(2);
      for (const c of res.cookies) expect(c).toMatch(/; Secure/);
    } finally {
      process.env.COOKIE_SECURE = 'false';
      resetConfigForTests();
    }
  });
});

describe('hostile input', () => {
  const post = (opts: Parameters<typeof call>[3]) => call(login, 'POST', '/api/v1/auth/login', opts);

  it('requires JSON: other content types give 415', async () => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '']) {
      const res = await post({ rawBody: JSON.stringify({ identifier: 'a@b.in', password: 'x' }), headers: type ? { 'content-type': type } : {} });
      expect(res.status).toBe(415);
    }
  });

  it('rejects malformed JSON, NUL bytes (raw and escaped), arrays and oversized bodies', async () => {
    const json = { 'content-type': 'application/json' };
    expect((await post({ rawBody: '{"identifier": ', headers: json })).status).toBe(400);
    expect((await post({ rawBody: '{"identifier":"ab\u0000c","password":"x"}', headers: json })).status).toBe(400);
    expect((await post({ rawBody: '{"identifier":"ab\\u0000c","password":"x"}', headers: json })).status).toBe(400);
    expect((await post({ rawBody: '[1,2,3]', headers: json })).status).toBe(400);
    expect((await post({ rawBody: 'null', headers: json })).status).toBe(400);
    const big = await post({ rawBody: JSON.stringify({ identifier: 'a'.repeat(1_200_000), password: 'x' }), headers: json });
    expect(big.status).toBe(413);
    const huge = await post({ rawBody: '{"identifier":"x","password":"y"}', headers: { ...json, 'content-length': '5000000' } });
    expect(huge.status).toBe(413);
  });

  it('a NUL byte in the URL is refused', async () => {
    expect((await call(me, 'GET', '/api/v1/auth/me?x=%00')).status).toBe(400);
  });

  it('unknown fields and wrong types are refused, never ignored (mass assignment / operator injection)', async () => {
    const u = await createUser('CITIZEN', j);
    for (const body of [
      { identifier: u.mobile, password: PASSWORD, role: 'WEB_ADMIN' },
      { identifier: u.mobile, password: PASSWORD, isAdmin: true },
      { identifier: { $ne: null }, password: PASSWORD },
      { identifier: u.mobile, password: { $ne: '' } },
      { identifier: [u.mobile], password: PASSWORD },
      { identifier: u.mobile, password: ['a', 'b'] },
      { identifier: u.mobile, password: PASSWORD, session: 'both' },
      { identifier: 12345678, password: PASSWORD },
      { identifier: u.mobile, password: 'x'.repeat(129) }, // bounded, so hashing cannot be used to burn CPU
    ]) {
      const res = await post({ body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('SQL metacharacters in credentials are just wrong credentials: 401, never a database error', async () => {
    const u = await createUser('CITIZEN', j);
    for (const identifier of [`' OR '1'='1`, `${u.mobile}'; DROP TABLE users; --`, `${u.email}' --`, `\\\\\\`, '"'.repeat(5), '%%%', '___']) {
      const res = await post({ body: { identifier, password: `' OR '1'='1` } });
      expect(res.status, identifier).toBe(401);
    }
    expect(await one(db(), `SELECT COUNT(*) AS n FROM users`)).toEqual({ n: expect.any(Number) });
  });

  it('error replies carry no stack traces, SQL or secrets', async () => {
    const res = await post({ body: { identifier: 'someone@example.in', password: 'x' } });
    expect(JSON.stringify(res.body)).not.toMatch(/at \w+|node_modules|SELECT|mysql|knex|secret/i);
  });
});

describe('responses', () => {
  it('are never cached and carry hardening headers, including errors', async () => {
    const u = await createUser('CITIZEN', j);
    const ok = await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: PASSWORD } });
    const bad = await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: u.mobile, password: 'nope' } });
    const open = await call(health, 'GET', '/api/v1/health');
    for (const r of [ok, bad, open]) {
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('content-security-policy')).toContain("default-src 'none'");
    }
  });

  it('passwords, hashes and tokens never appear in the profile', async () => {
    const { s } = await session();
    const text = JSON.stringify((await call(me, 'GET', '/api/v1/auth/me', { token: s.accessToken })).body);
    expect(text).not.toMatch(/argon2|passwordHash|password_hash|token_version|tokenVersion|_enc|blind|refresh|secret/i);
    expect(text).not.toContain(PASSWORD);
  });
});

describe('failures are handled safely', () => {
  afterEach(() => vi.restoreAllMocks());

  it('an unexpected error becomes a generic 500 with no detail', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(UserModel, 'findForLoginByHash').mockRejectedValue(new Error('secret internal detail: table users, password 123'));
    const res = await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: 'a@b.in', password: PASSWORD } });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ statusCode: 500, message: 'Internal server error' });
  });

  it('an unreachable database is a 503 "try again", not a crash', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(UserModel, 'findForLoginByHash').mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3306'), { code: 'ECONNREFUSED' }));
    const res = await call(login, 'POST', '/api/v1/auth/login', { body: { identifier: 'a@b.in', password: PASSWORD } });
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/);
  });
});

describe('rate limiting and client addresses', () => {
  afterEach(() => {
    for (const k of ['RATE_LIMIT_AUTH_PER_MIN', 'TRUST_PROXY_HOPS']) delete process.env[k];
    process.env.RATE_LIMIT_AUTH_PER_MIN = '100000';
    process.env.TRUST_PROXY_HOPS = '0';
    resetConfigForTests();
  });
  const attempt = (headers: Record<string, string> = {}) => call(login, 'POST', '/api/v1/auth/login', { body: { identifier: 'nobody@example.in', password: PASSWORD }, headers });

  it('credential endpoints answer 429 with Retry-After once the limit is passed', async () => {
    process.env.RATE_LIMIT_AUTH_PER_MIN = '3';
    resetConfigForTests();
    const codes: number[] = [];
    let last = await attempt();
    codes.push(last.status);
    for (let i = 0; i < 3; i++) { last = await attempt(); codes.push(last.status); }
    expect(codes).toEqual([401, 401, 401, 429]);
    expect(Number(last.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('with no trusted proxy a forged X-Forwarded-For does not buy a fresh allowance', async () => {
    process.env.RATE_LIMIT_AUTH_PER_MIN = '2';
    process.env.TRUST_PROXY_HOPS = '0';
    resetConfigForTests();
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await attempt({ 'x-forwarded-for': `10.0.0.${i}` })).status);
    expect(codes).toEqual([401, 401, 429, 429]);
  });

  it('behind one trusted proxy the address the proxy appended counts, and forged leading entries do not', async () => {
    process.env.RATE_LIMIT_AUTH_PER_MIN = '2';
    process.env.TRUST_PROXY_HOPS = '1';
    resetConfigForTests();
    const fromAttacker = [] as number[];
    for (let i = 0; i < 4; i++) fromAttacker.push((await attempt({ 'x-forwarded-for': `1.1.1.${i}, 203.0.113.9` })).status);
    expect(fromAttacker).toEqual([401, 401, 429, 429]);
    // a different real client (what the proxy appends) has its own allowance
    expect((await attempt({ 'x-forwarded-for': '1.1.1.1, 203.0.113.77' })).status).toBe(401);
  });

  it('production refuses to start with insecure cookies or without a declared proxy', () => {
    const base = { NODE_ENV: 'production', JWT_ACCESS_SECRET: 'x'.repeat(40), PII_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'), PII_HASH_KEY: Buffer.alloc(32, 2).toString('base64'), DB_PASSWORD: 'x', APP_URL: 'https://example.in' };
    expect(() => buildConfig({ ...base, COOKIE_SECURE: 'false', TRUST_PROXY_HOPS: '1' } as NodeJS.ProcessEnv)).toThrow(/COOKIE_SECURE/);
    expect(() => buildConfig({ ...base, COOKIE_SECURE: 'true', TRUST_PROXY_HOPS: '0' } as NodeJS.ProcessEnv)).toThrow(/TRUST_PROXY_HOPS/);
    expect(() => buildConfig({ ...base, COOKIE_SECURE: 'true', TRUST_PROXY_HOPS: '1' } as NodeJS.ProcessEnv)).not.toThrow();
  });

  it('weak or missing secrets stop the app from starting', () => {
    const base = { NODE_ENV: 'development', DB_PASSWORD: 'x' };
    expect(() => buildConfig(base as NodeJS.ProcessEnv)).toThrow(/Configuration problem/);
    expect(() => buildConfig({ ...base, JWT_ACCESS_SECRET: 'short', PII_ENCRYPTION_KEY: 'abc', PII_HASH_KEY: 'abc' } as NodeJS.ProcessEnv)).toThrow(/Configuration problem/);
  });
});
