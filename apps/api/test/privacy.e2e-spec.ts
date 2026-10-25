import { Role } from '../src/common/enums';
import { NOTICE_VERSION } from '../src/modules/privacy/notice';
import { PrivacyService } from '../src/modules/privacy/privacy.service';
import { api, bearer, createJurisdiction, createTestApp, createUser, Jurisdiction, login, PASSWORD, quickMedia, TestCtx, tokenFor, uniqueMobile } from './helpers';

describe('DPDP Act: notice, consent, access, correction, erasure, retention (M9)', () => {
  let ctx: TestCtx;
  let j: Jurisdiction;
  let typeId: string;

  beforeAll(async () => {
    process.env.GRIEVANCE_OFFICER_NAME = 'Grievance Officer, Nagar Nigam';
    process.env.GRIEVANCE_OFFICER_EMAIL = 'grievance@example.gov.in';
    ctx = await createTestApp();
    delete process.env.GRIEVANCE_OFFICER_NAME;
    delete process.env.GRIEVANCE_OFFICER_EMAIL;
    j = await createJurisdiction(ctx.ds);
    typeId = (await ctx.http().get(api('/masters/complaint-types'))).body[0].id;
  });
  afterAll(() => ctx.app.close());

  const registration = (over: object = {}) => ({
    homeWardId: j.wards[0].id, name: 'Asha Devi', mobile: uniqueMobile(), email: `p${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.in`,
    password: PASSWORD, consentNoticeVersion: NOTICE_VERSION, consentLanguage: 'hi', ...over,
  });
  const register = async (over: object = {}) => {
    const body = registration(over);
    const res = await ctx.http().post(api('/auth/register')).send(body).expect(201);
    const [u] = await ctx.ds.query(`SELECT id FROM users WHERE mobile_hash = $1`, [ctx.pii.blindIndex(body.mobile)]);
    return { ...body, id: u.id as string, token: res.body.accessToken as string, refresh: res.body.refreshToken as string };
  };
  const file = async (userId: string, token: string) => {
    const at = j.wards[0].center;
    return (await ctx.http().post(api('/complaints')).set(bearer(token))
      .send({ typeId, ...at, description: 'Garbage near my house no. 12', mediaIds: [await quickMedia(ctx, userId, at)] }).expect(201)).body;
  };

  it('publishes the notice in Hindi and English with the grievance officer, without signing in', async () => {
    const n = (await ctx.http().get(api('/privacy/notice')).expect(200)).body;
    expect(n.version).toBe(NOTICE_VERSION);
    expect(n.grievanceOfficer).toEqual(expect.objectContaining({ name: 'Grievance Officer, Nagar Nigam', email: 'grievance@example.gov.in' }));
    expect(n.hi.sections.length).toBe(n.en.sections.length);
    expect(JSON.stringify(n.en)).toMatch(/Data Protection Board/);
  });

  describe('consent', () => {
    it('no account without consent to the current notice; consent is recorded with version and language', async () => {
      const without: Record<string, unknown> = registration();
      delete without.consentNoticeVersion;
      await ctx.http().post(api('/auth/register')).send(without).expect(400);
      const stale = await ctx.http().post(api('/auth/register')).send(registration({ consentNoticeVersion: '2020-01-01' })).expect(409);
      expect(stale.body.message).toMatch(/notice has changed/);
      const c = await register();
      const rows = await ctx.ds.query(`SELECT purpose, notice_version, language, withdrawn_at FROM consents WHERE user_id = $1`, [c.id]);
      expect(rows).toEqual([{ purpose: 'COMPLAINTS_SERVICE', notice_version: NOTICE_VERSION, language: 'hi', withdrawn_at: null }]);
      expect((await ctx.http().get(api('/auth/me')).set(bearer(c.token))).body.consentRequired).toBe(false);
    });

    it('a citizen without a recorded consent (older account, changed notice) is asked again', async () => {
      const old = await createUser(ctx, Role.CITIZEN, j);
      const token = await tokenFor(ctx, old);
      expect((await ctx.http().get(api('/auth/me')).set(bearer(token))).body.consentRequired).toBe(true);
      await ctx.http().post(api('/privacy/consent')).set(bearer(token)).send({ noticeVersion: 'old', language: 'en' }).expect(409);
      await ctx.http().post(api('/privacy/consent')).set(bearer(token)).send({ noticeVersion: NOTICE_VERSION, language: 'en' }).expect(200);
      expect((await ctx.http().get(api('/auth/me')).set(bearer(token))).body.consentRequired).toBe(false);
      const staff = await tokenFor(ctx, await createUser(ctx, Role.WORKER, j));
      expect((await ctx.http().get(api('/auth/me')).set(bearer(staff))).body.consentRequired).toBe(false);
      await ctx.http().post(api('/privacy/consent')).set(bearer(staff)).send({ noticeVersion: NOTICE_VERSION, language: 'en' }).expect(403);
    });
  });

  describe('access (export)', () => {
    it('returns everything about the citizen and nothing about anyone else', async () => {
      const a = await register();
      const b = await register();
      const mine = await file(a.id, a.token);
      const theirs = await file(b.id, b.token);
      const res = await ctx.http().get(api('/privacy/my-data')).set(bearer(a.token)).expect(200);
      const d = res.body;
      expect(d.profile).toEqual(expect.objectContaining({ name: 'Asha Devi', mobile: a.mobile, email: a.email }));
      expect(d.consents).toHaveLength(1);
      expect(d.complaints.map((c: { complaintNo: string }) => c.complaintNo)).toEqual([mine.complaintNo]);
      expect(JSON.stringify(d)).not.toContain(theirs.complaintNo);
      expect(JSON.stringify(d)).not.toContain(b.mobile);
      expect(d.complaints[0].yourMedia).toHaveLength(1);
      expect(d.devices.length).toBeGreaterThanOrEqual(1);
      const [audit] = await ctx.ds.query(`SELECT action FROM audit_logs WHERE actor_id = $1 AND action = 'DATA_EXPORTED'`, [a.id]);
      expect(audit).toBeDefined();
    });

    it('is for citizens only', async () => {
      const staff = await tokenFor(ctx, await createUser(ctx, Role.SUPERVISOR, j));
      await ctx.http().get(api('/privacy/my-data')).set(bearer(staff)).expect(403);
      await ctx.http().get(api('/privacy/my-data')).expect(401);
    });
  });

  describe('correction', () => {
    it('corrects name, father/husband name and email; refuses an email used by another account; the mobile is not editable', async () => {
      const a = await register({ guardianName: 'Ram Lal' });
      const b = await register();
      await ctx.http().patch(api('/privacy/profile')).set(bearer(a.token)).send({ name: 'Asha Kumari', guardianName: null }).expect(204);
      await ctx.http().patch(api('/privacy/profile')).set(bearer(a.token)).send({ email: b.email }).expect(409);
      await ctx.http().patch(api('/privacy/profile')).set(bearer(a.token)).send({ mobile: '9000000000' }).expect(400);
      await ctx.http().patch(api('/privacy/profile')).set(bearer(a.token)).send({ email: `new${a.email}` }).expect(204);
      const me = (await ctx.http().get(api('/auth/me')).set(bearer(a.token))).body;
      expect(me).toEqual(expect.objectContaining({ name: 'Asha Kumari', guardianName: null, email: `new${a.email}`, mobile: a.mobile }));
    });
  });

  describe('erasure (and consent withdrawal)', () => {
    it('needs the password; erases identity and contact details at once, ends every session, keeps complaints anonymously', async () => {
      const a = await register();
      const c = await file(a.id, a.token);
      await ctx.ds.query(`INSERT INTO feedback (complaint_id, citizen_id, rating, remark) VALUES ($1, $2, 4, 'My neighbour Mr Sharma dumps here')`, [c.id, a.id]);
      await ctx.http().post(api('/notifications/push-tokens')).set(bearer(a.token)).send({ token: 'fcm-token-for-erasure-test-000001', platform: 'ANDROID' }).expect(204);

      await ctx.http().post(api('/privacy/erasure')).set(bearer(a.token)).send({ password: 'wrong-password' }).expect(400);
      await ctx.http().post(api('/privacy/erasure')).set(bearer(a.token)).send({ password: a.password }).expect(204);

      await ctx.http().get(api('/auth/me')).set(bearer(a.token)).expect(401);
      await ctx.http().post(api('/auth/refresh')).send({ refreshToken: a.refresh }).expect(401);
      await ctx.http().post(api('/auth/login')).send({ identifier: a.mobile, password: a.password }).expect(401);

      const [u] = await ctx.ds.query(`SELECT name, guardian_name, mobile_enc, mobile_hash, email_enc, email_hash, status, erased_at FROM users WHERE id = $1`, [a.id]);
      expect(u).toEqual(expect.objectContaining({ name: 'Deleted user', guardian_name: null, mobile_enc: null, mobile_hash: null, email_enc: null, email_hash: null, status: 'DISABLED' }));
      expect(u.erased_at).not.toBeNull();
      const counts = (await ctx.ds.query(
        `SELECT (SELECT count(*)::int FROM notifications WHERE user_id = $1) AS notes,
                (SELECT count(*)::int FROM push_tokens WHERE user_id = $1) AS push,
                (SELECT count(*)::int FROM devices WHERE user_id = $1 AND revoked_at IS NULL) AS devices,
                (SELECT count(*)::int FROM consents WHERE user_id = $1 AND withdrawn_at IS NULL) AS consents,
                (SELECT count(*)::int FROM complaints WHERE citizen_id = $1) AS complaints,
                (SELECT remark FROM feedback WHERE complaint_id = $2) AS remark`,
        [a.id, c.id],
      ))[0];
      expect(counts).toEqual({ notes: 0, push: 0, devices: 0, consents: 0, complaints: 1, remark: null });
      const [audit] = await ctx.ds.query(`SELECT action FROM audit_logs WHERE entity_id = $1 AND action = 'ACCOUNT_ERASED'`, [a.id]);
      expect(audit).toBeDefined();

      // The complaint still works for the ULB, without the citizen's identity.
      const sa = await tokenFor(ctx, await createUser(ctx, Role.SUB_ADMIN, j));
      const view = (await ctx.http().get(api(`/complaints/${c.id}`)).set(bearer(sa)).expect(200)).body;
      expect(JSON.stringify(view)).not.toMatch(new RegExp(`${a.mobile}|${a.email}|Asha Devi`));

      // The same mobile number can open a new account.
      await ctx.http().post(api('/auth/register')).send(registration({ mobile: a.mobile, email: a.email })).expect(201);
    });

    it('staff accounts are closed by their administrator, not by self-service erasure', async () => {
      const w = await createUser(ctx, Role.WORKER, j);
      await ctx.http().post(api('/privacy/erasure')).set(bearer(await tokenFor(ctx, w))).send({ password: w.password }).expect(403);
    });
  });

  it('feedback stays append-only apart from clearing the remark', async () => {
    const a = await register();
    const c = await file(a.id, a.token);
    const [f] = await ctx.ds.query(`INSERT INTO feedback (complaint_id, citizen_id, rating, remark) VALUES ($1, $2, 2, 'x') RETURNING id`, [c.id, a.id]);
    await expect(ctx.ds.query(`UPDATE feedback SET rating = 5 WHERE id = $1`, [f.id])).rejects.toThrow(/append-only/);
    await expect(ctx.ds.query(`UPDATE feedback SET rating = 5, remark = NULL WHERE id = $1`, [f.id])).rejects.toThrow(/append-only/);
    await expect(ctx.ds.query(`DELETE FROM feedback WHERE id = $1`, [f.id])).rejects.toThrow(/append-only/);
    await ctx.ds.query(`UPDATE feedback SET remark = NULL WHERE id = $1`, [f.id]);
  });

  describe('retention', () => {
    it('deletes old read notifications and spent session tokens; keeps recent ones', async () => {
      const u = await createUser(ctx, Role.CITIZEN, j);
      await login(ctx, u);
      await ctx.ds.query(
        `INSERT INTO notifications (user_id, type, title_en, title_hi, body_en, body_hi, read_at, created_at) VALUES
           ($1, 'T', 'old', 'old', 'b', 'b', now() - interval '200 days', now() - interval '200 days'),
           ($1, 'T', 'recent', 'recent', 'b', 'b', now(), now() - interval '10 days'),
           ($1, 'T', 'old unread', 'x', 'b', 'b', NULL, now() - interval '400 days')`,
        [u.id],
      );
      await ctx.ds.query(
        `UPDATE refresh_tokens SET revoked_at = now() - interval '40 days', created_at = now() - interval '40 days' WHERE user_id = $1`,
        [u.id],
      );
      await ctx.app.get(PrivacyService).purge();
      const left = await ctx.ds.query(`SELECT title_en FROM notifications WHERE user_id = $1 ORDER BY title_en`, [u.id]);
      expect(left).toEqual([{ title_en: 'recent' }]);
      const [{ n }] = await ctx.ds.query(`SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id = $1`, [u.id]);
      expect(n).toBe(0);
    });
  });
});
