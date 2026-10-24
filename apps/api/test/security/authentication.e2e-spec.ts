import { JwtService } from '@nestjs/jwt';
import { Role } from '../../src/common/enums';
import { api, bearer, createJurisdiction, createTestApp, createUser, Jurisdiction, login, PASSWORD, TestCtx } from '../helpers';

/** OWASP ASVS V2 (authentication) and V3 (session management). */
describe('Security: authentication and sessions', () => {
  let ctx: TestCtx;
  let j: Jurisdiction;
  const jwt = new JwtService();

  beforeAll(async () => {
    ctx = await createTestApp();
    j = await createJurisdiction(ctx.ds);
  });
  afterAll(() => ctx.app.close());

  const PROTECTED: [string, string][] = [
    ['get', '/auth/me'], ['get', '/complaints'], ['post', '/complaints'], ['get', '/users'], ['post', '/users'],
    ['get', '/masters/locate?lat=21&lng=81'], ['post', '/masters/districts'], ['post', '/auth/logout-all'],
    ['post', '/auth/change-password'],
  ];

  it.each(PROTECTED)('%s %s requires a token', async (method, path) => {
    const res = await (ctx.http() as never as Record<string, (p: string) => import('supertest').Test>)[method](api(path)).send({});
    expect(res.status).toBe(401);
  });

  it.each([
    ['no Bearer prefix', (t: string) => t],
    ['garbage', () => 'Bearer not.a.jwt'],
    ['empty', () => 'Bearer '],
  ])('rejects malformed authorization header (%s)', async (_n, make) => {
    const u = await createUser(ctx, Role.CITIZEN, j);
    const { accessToken } = await login(ctx, u);
    await ctx.http().get(api('/auth/me')).set('Authorization', make(accessToken)).expect(401);
  });

  it('rejects tokens signed with another secret, alg=none, expired tokens and wrong token types', async () => {
    const u = await createUser(ctx, Role.CITIZEN, j);
    const claims = { sub: u.id, role: 'CITIZEN', tv: 0, typ: 'access' };
    const forged = await jwt.signAsync(claims, { secret: 'attacker-secret-attacker-secret-attacker!!', algorithm: 'HS256' });
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
    const algNone = `${header}.${payload}.`;
    const expired = await jwt.signAsync({ ...claims, exp: Math.floor(Date.now() / 1000) - 10 }, { secret: process.env.JWT_ACCESS_SECRET });
    const mfaTyped = await jwt.signAsync({ ...claims, typ: 'mfa' }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: 600 });
    const mfaSecretSigned = await jwt.signAsync(claims, { secret: process.env.JWT_MFA_SECRET, expiresIn: 600 });
    for (const t of [forged, algNone, expired, mfaTyped, mfaSecretSigned]) {
      await ctx.http().get(api('/auth/me')).set(bearer(t)).expect(401);
    }
  });

  it('a forged role claim does not grant that role (role is read from the DB)', async () => {
    const u = await createUser(ctx, Role.CITIZEN, j);
    const t = await jwt.signAsync({ sub: u.id, role: 'WEB_ADMIN', tv: 0, typ: 'access' }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: 600 });
    // Even with the real secret, the role claim is ignored for authorisation.
    await ctx.http().get(api('/users')).set(bearer(t)).expect(403);
  });

  it('an MFA step token cannot be used as an access token', async () => {
    const sa = await createUser(ctx, Role.SUB_ADMIN, j);
    const res = await ctx.http().post(api('/auth/login')).send({ identifier: sa.mobile, password: PASSWORD }).expect(200);
    await ctx.http().get(api('/auth/me')).set(bearer(res.body.mfaToken)).expect(401);
  });

  it('refresh-token reuse is detected and revokes the whole session family', async () => {
    const u = await createUser(ctx, Role.CITIZEN, j);
    const s1 = await login(ctx, u);
    const s2 = (await ctx.http().post(api('/auth/refresh')).send({ refreshToken: s1.refreshToken }).expect(200)).body;
    // attacker replays the stolen, already-rotated token
    await ctx.http().post(api('/auth/refresh')).send({ refreshToken: s1.refreshToken }).expect(401);
    // the legitimate holder's newer token is now dead too
    await ctx.http().post(api('/auth/refresh')).send({ refreshToken: s2.refreshToken }).expect(401);
  });

  it('logout-all invalidates outstanding access tokens immediately', async () => {
    const u = await createUser(ctx, Role.CITIZEN, j);
    const a = await login(ctx, u);
    const b = await login(ctx, u);
    await ctx.http().post(api('/auth/logout-all')).set(bearer(a.accessToken)).expect(204);
    await ctx.http().get(api('/auth/me')).set(bearer(b.accessToken)).expect(401);
    await ctx.http().post(api('/auth/refresh')).send({ refreshToken: b.refreshToken }).expect(401);
  });

  it('locks the account for 15 minutes after 5 wrong passwords', async () => {
    const u = await createUser(ctx, Role.CITIZEN, j);
    for (let i = 0; i < 5; i++) {
      await ctx.http().post(api('/auth/login')).send({ identifier: u.mobile, password: 'Wrong#pass1' }).expect(401);
    }
    // correct password is refused while locked, with the same generic error
    const locked = await ctx.http().post(api('/auth/login')).send({ identifier: u.mobile, password: PASSWORD }).expect(401);
    expect(locked.body.message).toBe('Invalid credentials');
    const [audit] = await ctx.ds.query(`SELECT 1 FROM audit_logs WHERE actor_id = $1 AND action = 'ACCOUNT_LOCKED'`, [u.id]);
    expect(audit).toBeDefined();
    await ctx.ds.query(`UPDATE users SET locked_until = now() - interval '1 second' WHERE id = $1`, [u.id]);
    await ctx.http().post(api('/auth/login')).send({ identifier: u.mobile, password: PASSWORD }).expect(200);
  });

  it('does not reveal whether an account exists (login and password reset)', async () => {
    const u = await createUser(ctx, Role.CITIZEN, j);
    const wrongPw = await ctx.http().post(api('/auth/login')).send({ identifier: u.mobile, password: 'Wrong#pass1' });
    const noUser = await ctx.http().post(api('/auth/login')).send({ identifier: '6000000000', password: 'Wrong#pass1' });
    expect([wrongPw.status, wrongPw.body]).toEqual([noUser.status, noUser.body]);

    const known = await ctx.http().post(api('/auth/forgot-password')).send({ identifier: u.email });
    const unknown = await ctx.http().post(api('/auth/forgot-password')).send({ identifier: 'nobody@example.in' });
    expect([known.status, known.body]).toEqual([unknown.status, unknown.body]);
  });

  it('disabled accounts cannot log in or reset their password', async () => {
    const u = await createUser(ctx, Role.CITIZEN, j);
    await ctx.ds.query(`UPDATE users SET status = 'DISABLED' WHERE id = $1`, [u.id]);
    await ctx.http().post(api('/auth/login')).send({ identifier: u.mobile, password: PASSWORD }).expect(401);
    const before = ctx.mail.sent.length;
    await ctx.http().post(api('/auth/forgot-password')).send({ identifier: u.email }).expect(202);
    expect(ctx.mail.sent.length).toBe(before);
  });

  it('stores refresh and reset tokens only as hashes', async () => {
    const u = await createUser(ctx, Role.CITIZEN, j);
    const s = await login(ctx, u);
    await ctx.http().post(api('/auth/forgot-password')).send({ identifier: u.email }).expect(202);
    const reset = ctx.mail.lastTokenFor(u.email)!;
    const dump = JSON.stringify([
      await ctx.ds.query(`SELECT * FROM refresh_tokens WHERE user_id = $1`, [u.id]),
      await ctx.ds.query(`SELECT * FROM password_resets WHERE user_id = $1`, [u.id]),
    ]);
    expect(dump).not.toContain(s.refreshToken);
    expect(dump).not.toContain(reset);
  });
});
