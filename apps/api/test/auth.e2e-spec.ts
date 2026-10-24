import { authenticator } from 'otplib';
import { Role } from '../src/common/enums';
import { api, bearer, createJurisdiction, createTestApp, createUser, Jurisdiction, login, PASSWORD, TestCtx, uniqueMobile } from './helpers';

describe('Auth (M1)', () => {
  let ctx: TestCtx;
  let j: Jurisdiction;

  beforeAll(async () => {
    ctx = await createTestApp();
    j = await createJurisdiction(ctx.ds);
  });
  afterAll(() => ctx.app.close());

  const registration = (over: object = {}) => ({
    homeWardId: j.wards[0].id,
    name: 'रमेश Kumar',
    guardianName: 'Suresh Kumar',
    mobile: uniqueMobile(),
    email: `c${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.in`,
    password: PASSWORD,
    ...over,
  });

  describe('citizen registration (no OTP in v1)', () => {
    it('registers, signs in immediately and derives district/ULB from the ward', async () => {
      const body = registration();
      const res = await ctx.http().post(api('/auth/register')).send(body).expect(201);
      expect(res.body).toEqual(expect.objectContaining({ accessToken: expect.any(String), refreshToken: expect.any(String), tokenType: 'Bearer' }));
      const me = await ctx.http().get(api('/auth/me')).set(bearer(res.body.accessToken)).expect(200);
      expect(me.body).toEqual(expect.objectContaining({
        role: 'CITIZEN', status: 'UNVERIFIED_MOBILE', mobile: body.mobile, email: body.email,
        homeWardId: j.wards[0].id, homeUlbId: j.ulbId, homeDistrictId: j.districtId,
      }));
    });

    it('stores mobile and email encrypted, never in clear', async () => {
      const body = registration();
      await ctx.http().post(api('/auth/register')).send(body).expect(201);
      const [row] = await ctx.ds.query(`SELECT * FROM users WHERE mobile_hash = $1`, [ctx.pii.blindIndex(body.mobile)]);
      expect(JSON.stringify(row)).not.toContain(body.mobile);
      expect(JSON.stringify(row)).not.toContain(body.email);
      expect(row.password_hash).toMatch(/^\$argon2id\$/);
    });

    it('rejects a duplicate mobile or email', async () => {
      const body = registration();
      await ctx.http().post(api('/auth/register')).send(body).expect(201);
      await ctx.http().post(api('/auth/register')).send(registration({ mobile: body.mobile })).expect(409);
      await ctx.http().post(api('/auth/register')).send(registration({ email: body.email.toUpperCase() })).expect(409);
    });

    it.each([
      [{ mobile: '12345' }], [{ mobile: '5876543210' }], [{ email: 'not-an-email' }], [{ password: 'weakpass' }],
      [{ password: 'Password@123' }], [{ homeWardId: '00000000-0000-4000-8000-000000000000' }], [{ name: '<script>' }],
    ])('rejects invalid input %p', async (over) => {
      const res = await ctx.http().post(api('/auth/register')).send(registration(over));
      expect(res.status).toBe(400);
    });
  });

  describe('login, refresh and logout', () => {
    it('accepts mobile or email as identifier', async () => {
      const u = await createUser(ctx, Role.CITIZEN, j);
      await ctx.http().post(api('/auth/login')).send({ identifier: u.mobile, password: PASSWORD }).expect(200);
      const r = await ctx.http().post(api('/auth/login')).send({ identifier: u.email.toUpperCase(), password: PASSWORD }).expect(200);
      expect(r.body.status).toBe('OK');
    });

    it('rotates refresh tokens and logout revokes the session', async () => {
      const u = await createUser(ctx, Role.CITIZEN, j);
      const s1 = await login(ctx, u);
      const s2 = (await ctx.http().post(api('/auth/refresh')).send({ refreshToken: s1.refreshToken }).expect(200)).body;
      expect(s2.refreshToken).not.toBe(s1.refreshToken);
      await ctx.http().get(api('/auth/me')).set(bearer(s2.accessToken)).expect(200);
      await ctx.http().post(api('/auth/logout')).send({ refreshToken: s2.refreshToken }).expect(204);
      await ctx.http().post(api('/auth/refresh')).send({ refreshToken: s2.refreshToken }).expect(401);
    });
  });

  describe('forced password change for staff accounts', () => {
    it('blocks everything except change-password until the temp password is replaced', async () => {
      const w = await createUser(ctx, Role.WORKER, j, { mustChangePassword: true });
      const s = await login(ctx, w);
      await ctx.http().get(api('/complaints')).set(bearer(s.accessToken)).expect(403);
      await ctx.http().get(api('/auth/me')).set(bearer(s.accessToken)).expect(200);
      const changed = await ctx.http().post(api('/auth/change-password')).set(bearer(s.accessToken))
        .send({ currentPassword: PASSWORD, newPassword: 'NewSwachh#2027' }).expect(200);
      // Old token is dead (token_version bumped); new one works everywhere.
      await ctx.http().get(api('/auth/me')).set(bearer(s.accessToken)).expect(401);
      await ctx.http().get(api('/complaints')).set(bearer(changed.body.accessToken)).expect(200);
    });

    it('requires the correct current password', async () => {
      const u = await createUser(ctx, Role.CITIZEN, j);
      const s = await login(ctx, u);
      await ctx.http().post(api('/auth/change-password')).set(bearer(s.accessToken))
        .send({ currentPassword: 'wrong-Pass1', newPassword: 'NewSwachh#2027' }).expect(400);
    });
  });

  describe('password reset by email', () => {
    it('resets with a single-use link and signs out every session', async () => {
      const u = await createUser(ctx, Role.CITIZEN, j);
      const s = await login(ctx, u);
      await ctx.http().post(api('/auth/forgot-password')).send({ identifier: u.mobile }).expect(202);
      const token = ctx.mail.lastTokenFor(u.email)!;
      expect(token).toBeDefined();
      await ctx.http().post(api('/auth/reset-password')).send({ token, newPassword: 'Reset#Swachh2026' }).expect(204);
      // single use
      await ctx.http().post(api('/auth/reset-password')).send({ token, newPassword: 'Again#Swachh2026' }).expect(400);
      // all old sessions revoked
      await ctx.http().get(api('/auth/me')).set(bearer(s.accessToken)).expect(401);
      await ctx.http().post(api('/auth/refresh')).send({ refreshToken: s.refreshToken }).expect(401);
      // new password works, old does not
      await ctx.http().post(api('/auth/login')).send({ identifier: u.mobile, password: PASSWORD }).expect(401);
      await ctx.http().post(api('/auth/login')).send({ identifier: u.mobile, password: 'Reset#Swachh2026' }).expect(200);
    });

    it('a newer reset link invalidates the older one', async () => {
      const u = await createUser(ctx, Role.CITIZEN, j);
      await ctx.http().post(api('/auth/forgot-password')).send({ identifier: u.email }).expect(202);
      const first = ctx.mail.lastTokenFor(u.email)!;
      await ctx.http().post(api('/auth/forgot-password')).send({ identifier: u.email }).expect(202);
      await ctx.http().post(api('/auth/reset-password')).send({ token: first, newPassword: 'Reset#Swachh2026' }).expect(400);
    });

    it('expired links are refused', async () => {
      const u = await createUser(ctx, Role.CITIZEN, j);
      await ctx.http().post(api('/auth/forgot-password')).send({ identifier: u.email }).expect(202);
      const token = ctx.mail.lastTokenFor(u.email)!;
      await ctx.ds.query(`UPDATE password_resets SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [u.id]);
      await ctx.http().post(api('/auth/reset-password')).send({ token, newPassword: 'Reset#Swachh2026' }).expect(400);
    });

    it('rejects a weak new password', async () => {
      const u = await createUser(ctx, Role.CITIZEN, j);
      await ctx.http().post(api('/auth/forgot-password')).send({ identifier: u.email }).expect(202);
      await ctx.http().post(api('/auth/reset-password')).send({ token: ctx.mail.lastTokenFor(u.email), newPassword: 'password1' }).expect(400);
    });
  });

  describe('MFA for administrators', () => {
    it('a new Sub Admin must enrol TOTP before getting any token', async () => {
      const sa = await createUser(ctx, Role.SUB_ADMIN, j, { mfa: false });
      const res = await ctx.http().post(api('/auth/login')).send({ identifier: sa.mobile, password: PASSWORD }).expect(200);
      expect(res.body).toEqual({ status: 'MFA_ENROLLMENT_REQUIRED', mfaToken: expect.any(String) });
      expect(res.body.accessToken).toBeUndefined();

      const enroll = await ctx.http().post(api('/auth/mfa/enroll')).send({ mfaToken: res.body.mfaToken }).expect(200);
      expect(enroll.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
      await ctx.http().post(api('/auth/mfa/activate')).send({ mfaToken: res.body.mfaToken, code: '000000' }).expect(401);
      const ok = await ctx.http().post(api('/auth/mfa/activate'))
        .send({ mfaToken: res.body.mfaToken, code: authenticator.generate(enroll.body.secret) }).expect(200);
      expect(ok.body.accessToken).toBeDefined();

      // Next login asks for a code; the enrolment token can no longer be used.
      const again = await ctx.http().post(api('/auth/login')).send({ identifier: sa.mobile, password: PASSWORD }).expect(200);
      expect(again.body.status).toBe('MFA_REQUIRED');
      await ctx.http().post(api('/auth/mfa/enroll')).send({ mfaToken: res.body.mfaToken }).expect(401);
    });

    it('a TOTP code cannot be replayed', async () => {
      const da = await createUser(ctx, Role.DISTRICT_ADMIN, j);
      const code = authenticator.generate(da.mfaSecret!);
      const t1 = (await ctx.http().post(api('/auth/login')).send({ identifier: da.mobile, password: PASSWORD })).body.mfaToken;
      await ctx.http().post(api('/auth/mfa/verify')).send({ mfaToken: t1, code }).expect(200);
      const t2 = (await ctx.http().post(api('/auth/login')).send({ identifier: da.mobile, password: PASSWORD })).body.mfaToken;
      await ctx.http().post(api('/auth/mfa/verify')).send({ mfaToken: t2, code }).expect(401);
    });

    it('supervisors, workers and citizens are not asked for MFA', async () => {
      for (const role of [Role.SUPERVISOR, Role.WORKER, Role.CITIZEN]) {
        const u = await createUser(ctx, role, j);
        const res = await ctx.http().post(api('/auth/login')).send({ identifier: u.mobile, password: PASSWORD }).expect(200);
        expect(res.body.status).toBe('OK');
      }
    });
  });
});
