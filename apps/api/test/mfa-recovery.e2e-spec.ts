import { execFileSync } from 'child_process';
import { join } from 'path';
import { authenticator } from 'otplib';
import { Role } from '../src/common/enums';
import { api, bearer, createJurisdiction, createTestApp, createUser, Jurisdiction, login, PASSWORD, TestCtx, TestUser, tokenFor } from './helpers';

describe('MFA recovery (M4)', () => {
  let ctx: TestCtx;
  let j: Jurisdiction;

  beforeAll(async () => {
    ctx = await createTestApp();
    j = await createJurisdiction(ctx.ds);
  });
  afterAll(() => ctx.app.close());

  /** Enrols a fresh Sub Admin through the API and returns the recovery codes. */
  async function enrolledSubAdmin(jur = j): Promise<{ user: TestUser; secret: string; codes: string[] }> {
    const user = await createUser(ctx, Role.SUB_ADMIN, jur, { mfa: false });
    const res = await ctx.http().post(api('/auth/login')).send({ identifier: user.mobile, password: PASSWORD }).expect(200);
    const enroll = await ctx.http().post(api('/auth/mfa/enroll')).send({ mfaToken: res.body.mfaToken }).expect(200);
    const act = await ctx.http().post(api('/auth/mfa/activate'))
      .send({ mfaToken: res.body.mfaToken, code: authenticator.generate(enroll.body.secret) }).expect(200);
    return { user: { ...user, mfaSecret: enroll.body.secret }, secret: enroll.body.secret, codes: act.body.recoveryCodes };
  }
  const mfaToken = async (u: TestUser) =>
    (await ctx.http().post(api('/auth/login')).send({ identifier: u.mobile, password: PASSWORD }).expect(200)).body.mfaToken;

  it('activation returns 10 one-time recovery codes, stored only as hashes', async () => {
    const { user, codes } = await enrolledSubAdmin();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    codes.forEach((c) => expect(c).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/));
    const dump = JSON.stringify(await ctx.ds.query(`SELECT * FROM mfa_recovery_codes WHERE user_id = $1`, [user.id]));
    codes.forEach((c) => expect(dump).not.toContain(c.replace('-', '')));
  });

  it('a recovery code signs in once, case- and dash-insensitively', async () => {
    const { user, codes } = await enrolledSubAdmin();
    const res = await ctx.http().post(api('/auth/mfa/recover'))
      .send({ mfaToken: await mfaToken(user), recoveryCode: codes[0].toLowerCase().replace('-', '') }).expect(200);
    expect(res.body).toEqual(expect.objectContaining({ accessToken: expect.any(String), recoveryCodesRemaining: 9 }));
    await ctx.http().post(api('/auth/mfa/recover')).send({ mfaToken: await mfaToken(user), recoveryCode: codes[0] }).expect(401);
    const me = await ctx.http().get(api('/auth/me')).set(bearer(res.body.accessToken)).expect(200);
    expect(me.body.recoveryCodesRemaining).toBe(9);
  });

  it('wrong recovery codes count towards the account lockout', async () => {
    const { user, codes } = await enrolledSubAdmin();
    for (let i = 0; i < 5; i++) {
      await ctx.http().post(api('/auth/mfa/recover')).send({ mfaToken: await mfaToken(user), recoveryCode: 'AAAAA-AAAAA' }).expect(401);
    }
    // locked: even a valid code is refused now (login itself is refused while locked)
    await ctx.http().post(api('/auth/login')).send({ identifier: user.mobile, password: PASSWORD }).expect(401);
    await ctx.ds.query(`UPDATE users SET locked_until = NULL WHERE id = $1`, [user.id]);
    await ctx.http().post(api('/auth/mfa/recover')).send({ mfaToken: await mfaToken(user), recoveryCode: codes[1] }).expect(200);
  });

  it('regenerating codes needs a current TOTP code and voids the old set', async () => {
    const { user, secret, codes } = await enrolledSubAdmin();
    const session = await login(ctx, user);
    await ctx.http().post(api('/auth/mfa/recovery-codes')).set(bearer(session.accessToken)).send({ code: '000000' }).expect(401);
    await ctx.ds.query(`UPDATE users SET mfa_last_step = NULL WHERE id = $1`, [user.id]);
    const fresh = await ctx.http().post(api('/auth/mfa/recovery-codes')).set(bearer(session.accessToken))
      .send({ code: authenticator.generate(secret) }).expect(200);
    expect(fresh.body.recoveryCodes).toHaveLength(10);
    await ctx.http().post(api('/auth/mfa/recover')).send({ mfaToken: await mfaToken(user), recoveryCode: codes[2] }).expect(401);
    await ctx.http().post(api('/auth/mfa/recover')).send({ mfaToken: await mfaToken(user), recoveryCode: fresh.body.recoveryCodes[0] }).expect(200);
  });

  describe('admin MFA reset (lost phone and lost codes)', () => {
    it('the District Admin resets a Sub Admin\'s MFA; the Sub Admin is signed out and must re-enrol', async () => {
      const { user } = await enrolledSubAdmin();
      const session = await login(ctx, user);
      const da = await tokenFor(ctx, await createUser(ctx, Role.DISTRICT_ADMIN, j));
      await ctx.http().post(api(`/users/${user.id}/reset-mfa`)).set(bearer(da)).expect(201);
      await ctx.http().get(api('/auth/me')).set(bearer(session.accessToken)).expect(401);
      const again = await ctx.http().post(api('/auth/login')).send({ identifier: user.mobile, password: PASSWORD }).expect(200);
      expect(again.body.status).toBe('MFA_ENROLLMENT_REQUIRED');
      const [audit] = await ctx.ds.query(`SELECT 1 FROM audit_logs WHERE action = 'MFA_RESET_BY_ADMIN' AND entity_id = $1`, [user.id]);
      expect(audit).toBeDefined();
    });

    it('break-glass CLI clears a Web Admin\'s MFA (nobody sits above Web Admin) and audits it', async () => {
      const admin = await createUser(ctx, Role.WEB_ADMIN);
      const session = await login(ctx, admin);
      execFileSync(join(__dirname, '../node_modules/.bin/ts-node'), ['src/database/seed.ts'], {
        cwd: join(__dirname, '..'),
        env: { ...process.env, RESET_ADMIN_MFA_MOBILE: admin.mobile },
        stdio: 'pipe',
      });
      await ctx.http().get(api('/auth/me')).set(bearer(session.accessToken)).expect(401);
      const again = await ctx.http().post(api('/auth/login')).send({ identifier: admin.mobile, password: PASSWORD }).expect(200);
      expect(again.body.status).toBe('MFA_ENROLLMENT_REQUIRED');
      const [audit] = await ctx.ds.query(`SELECT 1 FROM audit_logs WHERE action = 'MFA_RESET_BREAK_GLASS' AND entity_id = $1`, [admin.id]);
      expect(audit).toBeDefined();
    }, 60_000);

    it('only the manager in the same jurisdiction can reset, and only for MFA users', async () => {
      const { user } = await enrolledSubAdmin();
      const otherDa = await tokenFor(ctx, await createUser(ctx, Role.DISTRICT_ADMIN, await createJurisdiction(ctx.ds)));
      await ctx.http().post(api(`/users/${user.id}/reset-mfa`)).set(bearer(otherDa)).expect(404);
      const peer = await tokenFor(ctx, await createUser(ctx, Role.SUB_ADMIN, j));
      await ctx.http().post(api(`/users/${user.id}/reset-mfa`)).set(bearer(peer)).expect(404);
      const citizen = await createUser(ctx, Role.CITIZEN, j);
      await ctx.http().post(api(`/users/${citizen.id}/reset-mfa`)).set(bearer(peer)).expect(400);
    });
  });
});
