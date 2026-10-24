import { Role } from '../src/common/enums';
import { JobsService, QUEUES } from '../src/modules/jobs/jobs.service';
import { NotificationsService } from '../src/modules/notifications/notifications.service';
import { fakeFcm } from './fake-fcm';
import { api, bearer, createJurisdiction, createTestApp, createUser, Jurisdiction, quickMedia, TestCtx, TestUser, tokenFor } from './helpers';

describe('Notifications and push (M4)', () => {
  const saved = { sa: process.env.FCM_SERVICE_ACCOUNT_B64, base: process.env.FCM_API_BASE };
  let fcm: Awaited<ReturnType<typeof fakeFcm>>;
  let ctx: TestCtx;
  let jobs: JobsService;
  let j: Jurisdiction;
  let typeId: string;
  let supervisor: TestUser;
  let supervisorToken: string;
  let worker: TestUser;
  let workerToken: string;
  let citizen: TestUser;
  let citizenToken: string;

  beforeAll(async () => {
    fcm = await fakeFcm();
    process.env.FCM_SERVICE_ACCOUNT_B64 = fcm.serviceAccountB64;
    process.env.FCM_API_BASE = fcm.apiBase;
    ctx = await createTestApp();
    jobs = ctx.app.get(JobsService);
    j = await createJurisdiction(ctx.ds);
    supervisor = await createUser(ctx, Role.SUPERVISOR, j);
    await ctx.ds.query(`UPDATE areas SET supervisor_id = $1 WHERE id = $2`, [supervisor.id, j.areaId]);
    worker = await createUser(ctx, Role.WORKER, j);
    [supervisorToken, workerToken] = await Promise.all([tokenFor(ctx, supervisor), tokenFor(ctx, worker)]);
    typeId = (await ctx.http().get(api('/masters/complaint-types'))).body[0].id;
  });
  afterAll(async () => {
    await jobs.waitForIdle([QUEUES.PUSH]);
    await ctx.app.close();
    await fcm.close();
    process.env.FCM_SERVICE_ACCOUNT_B64 = saved.sa;
    process.env.FCM_API_BASE = saved.base;
    if (!saved.sa) delete process.env.FCM_SERVICE_ACCOUNT_B64;
    if (!saved.base) delete process.env.FCM_API_BASE;
  });
  beforeEach(async () => {
    citizen = await createUser(ctx, Role.CITIZEN, j);
    citizenToken = await tokenFor(ctx, citizen);
  });

  const file = async () =>
    (await ctx.http().post(api('/complaints')).set(bearer(citizenToken))
      .send({ typeId, ...j.wards[0].center, description: 'Garbage near the market', landmark: 'Gandhi Chowk',
        mediaIds: [await quickMedia(ctx, citizen.id, j.wards[0].center)] })
      .expect(201)).body;
  const types = async (token: string, complaintId: string) =>
    (await ctx.http().get(api('/notifications')).query({ pageSize: 100 }).set(bearer(token)).expect(200)).body.items
      .filter((n: { complaintId: string }) => n.complaintId === complaintId)
      .map((n: { type: string }) => n.type)
      .reverse();
  const flushPush = () => jobs.waitForIdle([QUEUES.PUSH]);

  it('tells each party about each step of the complaint', async () => {
    const c = await file();
    await ctx.http().post(api(`/complaints/${c.id}/assign`)).set(bearer(supervisorToken)).send({ workerId: worker.id }).expect(201);
    await ctx.http().post(api(`/complaints/${c.id}/start`)).set(bearer(workerToken)).send({ mediaIds: [await quickMedia(ctx, worker.id, j.wards[0].center)] }).expect(201);
    await ctx.http().post(api(`/complaints/${c.id}/resolve`)).set(bearer(workerToken))
      .send({ remark: 'Safai ho gayi', mediaIds: [await quickMedia(ctx, worker.id, j.wards[0].center)] }).expect(201);
    await ctx.http().post(api(`/complaints/${c.id}/feedback`)).set(bearer(citizenToken)).send({ rating: 1, reopen: true }).expect(201);

    expect(await types(citizenToken, c.id)).toEqual(['COMPLAINT_REGISTERED', 'COMPLAINT_ASSIGNED', 'WORK_STARTED', 'COMPLAINT_RESOLVED']);
    expect(await types(supervisorToken, c.id)).toEqual(['COMPLAINT_NEW', 'COMPLAINT_REOPENED']);
    expect(await types(workerToken, c.id)).toEqual(['TASK_ASSIGNED', 'COMPLAINT_REOPENED']);
  });

  it('a rolled-back action sends nothing', async () => {
    const c = await file();
    await ctx.http().post(api(`/complaints/${c.id}/assign`)).set(bearer(supervisorToken)).send({ workerId: worker.id }).expect(201);
    await ctx.http().post(api(`/complaints/${c.id}/start`)).set(bearer(workerToken)).send({}).expect(400); // no photo → rolled back
    expect(await types(citizenToken, c.id)).not.toContain('WORK_STARTED');
  });

  it('speaks Hindi by default and English on request', async () => {
    const c = await file();
    const hi = (await ctx.http().get(api('/notifications')).set(bearer(citizenToken))).body.items.find((n: { complaintId: string }) => n.complaintId === c.id);
    expect(hi.title).toBe('शिकायत दर्ज हुई');
    await ctx.http().patch(api('/auth/me/preferences')).set(bearer(citizenToken)).send({ preferredLanguage: 'en' }).expect(200);
    const en = (await ctx.http().get(api('/notifications')).set(bearer(citizenToken))).body.items.find((n: { complaintId: string }) => n.complaintId === c.id);
    expect(en.title).toBe('Complaint registered');
    await ctx.http().patch(api('/auth/me/preferences')).set(bearer(citizenToken)).send({ preferredLanguage: 'fr' }).expect(400);
  });

  it('unread count, mark one read, mark all read', async () => {
    await file();
    await file();
    const count = async () => (await ctx.http().get(api('/notifications/unread-count')).set(bearer(citizenToken))).body.count;
    expect(await count()).toBe(2);
    const first = (await ctx.http().get(api('/notifications')).query({ unread: 'true' }).set(bearer(citizenToken))).body.items[0];
    await ctx.http().post(api(`/notifications/${first.id}/read`)).set(bearer(citizenToken)).expect(204);
    expect(await count()).toBe(1);
    await ctx.http().post(api('/notifications/read-all')).set(bearer(citizenToken)).expect(204);
    expect(await count()).toBe(0);
  });

  it('pushes to the user\'s phones through FCM, in their language, and marks it SENT', async () => {
    const token = `fcm-${citizen.id}`;
    await ctx.http().post(api('/notifications/push-tokens')).set(bearer(citizenToken)).send({ token, platform: 'ANDROID' }).expect(204);
    const c = await file();
    await flushPush();
    const msg = fcm.messages.find((m) => m.token === token && m.data.complaintId === c.id);
    expect(msg).toBeDefined();
    expect(msg!.notification.title).toBe('शिकायत दर्ज हुई');
    expect(msg!.data.type).toBe('COMPLAINT_REGISTERED');
    const [row] = await ctx.ds.query(`SELECT push_status FROM notifications WHERE user_id = $1 AND complaint_id = $2`, [citizen.id, c.id]);
    expect(row.push_status).toBe('SENT');
  });

  it('drops tokens FCM reports as unregistered; retries transient failures up to the limit', async () => {
    await ctx.http().post(api('/notifications/push-tokens')).set(bearer(citizenToken)).send({ token: `dead-${citizen.id}`, platform: 'ANDROID' }).expect(204);
    await file();
    await flushPush();
    expect(await ctx.ds.query(`SELECT 1 FROM push_tokens WHERE token = $1`, [`dead-${citizen.id}`])).toHaveLength(0);

    const other = await createUser(ctx, Role.CITIZEN, j);
    const otherToken = await tokenFor(ctx, other);
    await ctx.http().post(api('/notifications/push-tokens')).set(bearer(otherToken)).send({ token: `flaky-${other.id}`, platform: 'ANDROID' }).expect(204);
    await ctx.ds.transaction((m) => ctx.app.get(NotificationsService).notify(m, [other.id], {
      type: 'TEST', title: { en: 't', hi: 't' }, body: { en: 'b', hi: 'b' },
    }));
    const svc = ctx.app.get(NotificationsService);
    for (let i = 0; i < 6; i++) await svc.dispatchPending();
    const [row] = await ctx.ds.query(`SELECT push_status, push_attempts FROM notifications WHERE user_id = $1 AND type = 'TEST'`, [other.id]);
    expect(row).toEqual({ push_status: 'FAILED', push_attempts: 5 });
  });

  it('users without a registered phone get in-app notifications only (SKIPPED push)', async () => {
    const c = await file();
    await flushPush();
    const [row] = await ctx.ds.query(`SELECT push_status FROM notifications WHERE user_id = $1 AND complaint_id = $2`, [citizen.id, c.id]);
    expect(row.push_status).toBe('SKIPPED');
  });
});
