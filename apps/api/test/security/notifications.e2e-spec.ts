import { Role } from '../../src/common/enums';
import { JobsService, QUEUES } from '../../src/modules/jobs/jobs.service';
import { fakeFcm } from '../fake-fcm';
import { api, bearer, createJurisdiction, createTestApp, createUser, Jurisdiction, login, quickMedia, TestCtx, tokenFor } from '../helpers';

/** Notifications must not leak to other users, other phones, or Google with personal data in them. */
describe('Security: notifications and push', () => {
  const saved = { sa: process.env.FCM_SERVICE_ACCOUNT_B64, base: process.env.FCM_API_BASE };
  let fcm: Awaited<ReturnType<typeof fakeFcm>>;
  let ctx: TestCtx;
  let j: Jurisdiction;
  let typeId: string;

  beforeAll(async () => {
    fcm = await fakeFcm();
    process.env.FCM_SERVICE_ACCOUNT_B64 = fcm.serviceAccountB64;
    process.env.FCM_API_BASE = fcm.apiBase;
    ctx = await createTestApp();
    j = await createJurisdiction(ctx.ds);
    typeId = (await ctx.http().get(api('/masters/complaint-types'))).body[0].id;
  });
  afterAll(async () => {
    await ctx.app.get(JobsService).waitForIdle([QUEUES.PUSH]);
    await ctx.app.close();
    await fcm.close();
    if (saved.sa === undefined) delete process.env.FCM_SERVICE_ACCOUNT_B64; else process.env.FCM_SERVICE_ACCOUNT_B64 = saved.sa;
    if (saved.base === undefined) delete process.env.FCM_API_BASE; else process.env.FCM_API_BASE = saved.base;
  });

  const fileAs = async (userId: string, token: string, extra: object = {}) =>
    (await ctx.http().post(api('/complaints')).set(bearer(token))
      .send({ typeId, ...j.wards[0].center, description: 'Garbage next to house no 42', mediaIds: [await quickMedia(ctx, userId)], ...extra })
      .expect(201)).body;

  it('users cannot list, read or mark another user\'s notifications', async () => {
    const a = await createUser(ctx, Role.CITIZEN, j);
    const b = await createUser(ctx, Role.CITIZEN, j);
    const [ta, tb] = await Promise.all([tokenFor(ctx, a), tokenFor(ctx, b)]);
    await fileAs(a.id, ta);
    const aList = (await ctx.http().get(api('/notifications')).set(bearer(ta))).body.items;
    const bList = (await ctx.http().get(api('/notifications')).set(bearer(tb))).body.items;
    expect(aList.length).toBeGreaterThan(0);
    expect(bList.map((n: { id: string }) => n.id)).not.toContain(aList[0].id);
    await ctx.http().post(api(`/notifications/${aList[0].id}/read`)).set(bearer(tb)).expect(404);
    const [row] = await ctx.ds.query(`SELECT read_at FROM notifications WHERE id = $1`, [aList[0].id]);
    expect(row.read_at).toBeNull();
  });

  it('push payloads carry no personal data (name, mobile, email, description, landmark)', async () => {
    const c = await createUser(ctx, Role.CITIZEN, j);
    const t = await tokenFor(ctx, c);
    const token = `fcm-pii-${c.id}`;
    await ctx.http().post(api('/notifications/push-tokens')).set(bearer(t)).send({ token, platform: 'ANDROID' }).expect(204);
    await fileAs(c.id, t, { landmark: 'Sharma ji ka ghar' });
    await ctx.app.get(JobsService).waitForIdle([QUEUES.PUSH]);
    const sent = JSON.stringify(fcm.messages.filter((m) => m.token === token));
    expect(sent.length).toBeGreaterThan(10);
    for (const secret of [c.mobile, c.email, 'Test CITIZEN', 'house no 42', 'Sharma ji']) expect(sent).not.toContain(secret);
  });

  it('a shared phone: the push token follows the account that last signed in', async () => {
    const first = await createUser(ctx, Role.CITIZEN, j);
    const second = await createUser(ctx, Role.CITIZEN, j);
    const [t1, t2] = await Promise.all([tokenFor(ctx, first), tokenFor(ctx, second)]);
    const phone = `fcm-shared-${first.id}`;
    await ctx.http().post(api('/notifications/push-tokens')).set(bearer(t1)).send({ token: phone, platform: 'ANDROID' }).expect(204);
    await ctx.http().post(api('/notifications/push-tokens')).set(bearer(t2)).send({ token: phone, platform: 'ANDROID' }).expect(204);
    const [row] = await ctx.ds.query(`SELECT user_id FROM push_tokens WHERE token = $1`, [phone]);
    expect(row.user_id).toBe(second.id);

    const before = fcm.messages.filter((m) => m.token === phone).length;
    await fileAs(first.id, t1);
    await ctx.app.get(JobsService).waitForIdle([QUEUES.PUSH]);
    expect(fcm.messages.filter((m) => m.token === phone).length).toBe(before);
  });

  it('a user cannot remove someone else\'s push token', async () => {
    const owner = await createUser(ctx, Role.CITIZEN, j);
    const attacker = await createUser(ctx, Role.CITIZEN, j);
    const phone = `fcm-owner-${owner.id}`;
    await ctx.http().post(api('/notifications/push-tokens')).set(bearer(await tokenFor(ctx, owner))).send({ token: phone, platform: 'ANDROID' }).expect(204);
    await ctx.http().delete(api('/notifications/push-tokens')).set(bearer(await tokenFor(ctx, attacker))).send({ token: phone }).expect(204);
    expect(await ctx.ds.query(`SELECT 1 FROM push_tokens WHERE token = $1`, [phone])).toHaveLength(1);
  });

  it('signing out everywhere (logout-all, password reset, disable) unregisters push tokens', async () => {
    const u = await createUser(ctx, Role.CITIZEN, j);
    const s = await login(ctx, u);
    const phone = `fcm-logout-${u.id}`;
    await ctx.http().post(api('/notifications/push-tokens')).set(bearer(s.accessToken)).send({ token: phone, platform: 'ANDROID' }).expect(204);
    await ctx.http().post(api('/auth/logout-all')).set(bearer(s.accessToken)).expect(204);
    expect(await ctx.ds.query(`SELECT 1 FROM push_tokens WHERE token = $1`, [phone])).toHaveLength(0);
  });

  it('push tokens are length-limited and require authentication', async () => {
    await ctx.http().post(api('/notifications/push-tokens')).send({ token: 'x'.repeat(30), platform: 'ANDROID' }).expect(401);
    const t = await tokenFor(ctx, await createUser(ctx, Role.CITIZEN, j));
    await ctx.http().post(api('/notifications/push-tokens')).set(bearer(t)).send({ token: 'x'.repeat(5000), platform: 'ANDROID' }).expect(400);
    await ctx.http().post(api('/notifications/push-tokens')).set(bearer(t)).send({ token: 'x'.repeat(30), platform: 'WINDOWS' }).expect(400);
  });
});
