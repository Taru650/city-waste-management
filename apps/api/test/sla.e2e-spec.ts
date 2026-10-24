import { Role } from '../src/common/enums';
import { JobsService, QUEUES } from '../src/modules/jobs/jobs.service';
import { SlaService } from '../src/modules/sla/sla.service';
import { api, bearer, createJurisdiction, createTestApp, createUser, Jurisdiction, quickMedia, TestCtx, TestUser, tokenFor } from './helpers';

describe('SLA enforcement and escalation (M4)', () => {
  let ctx: TestCtx;
  let j: Jurisdiction;
  let sla: SlaService;
  let typeId: string;
  let slaHours: number;
  let supervisor: TestUser;
  let subAdmin: TestUser;
  let citizenToken: string;
  let citizenId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    sla = ctx.app.get(SlaService);
    j = await createJurisdiction(ctx.ds);
    supervisor = await createUser(ctx, Role.SUPERVISOR, j);
    subAdmin = await createUser(ctx, Role.SUB_ADMIN, j);
    await ctx.ds.query(`UPDATE areas SET supervisor_id = $1 WHERE id = $2`, [supervisor.id, j.areaId]);
    const type = (await ctx.http().get(api('/masters/complaint-types'))).body.find((t: { code: string }) => t.code === 'GARBAGE_HEAP');
    typeId = type.id;
    slaHours = type.slaHours;
  });
  afterAll(() => ctx.app.close());
  beforeEach(async () => {
    const c = await createUser(ctx, Role.CITIZEN, j);
    citizenId = c.id;
    citizenToken = await tokenFor(ctx, c);
  });

  const file = async (ward = 0) =>
    (await ctx.http().post(api('/complaints')).set(bearer(citizenToken))
      .send({ typeId, ...j.wards[ward].center, description: 'Garbage not lifted', mediaIds: [await quickMedia(ctx, citizenId, j.wards[ward].center)] })
      .expect(201)).body;
  /** Move the complaint's clock back as if it had been filed `hours` ago. */
  const age = (id: string, hours: number) =>
    ctx.ds.query(
      `UPDATE complaints SET created_at = created_at - make_interval(hours => $2), sla_due_at = sla_due_at - make_interval(hours => $2) WHERE id = $1`,
      [id, hours],
    );
  const notificationsOf = (userId: string, complaintId: string) =>
    ctx.ds.query(`SELECT type FROM notifications WHERE user_id = $1 AND complaint_id = $2 ORDER BY created_at`, [userId, complaintId]);

  it('marks a complaint past its deadline once and tells the supervisor', async () => {
    const c = await file();
    await age(c.id, slaHours + 1);
    expect((await sla.sweep()).breached).toBeGreaterThanOrEqual(1);
    const detail = (await ctx.http().get(api(`/complaints/${c.id}`)).set(bearer(citizenToken))).body;
    expect(detail.slaBreached).toBe(true);
    expect(detail.slaBreachedAt).not.toBeNull();
    expect(detail.escalated).toBe(false);
    expect(detail.events.map((e: { action: string }) => e.action)).toContain('SLA_BREACH');
    expect(await notificationsOf(supervisor.id, c.id)).toEqual(expect.arrayContaining([{ type: 'SLA_BREACHED' }]));

    // idempotent: a second sweep does nothing for this complaint
    await sla.sweep();
    const [{ n }] = await ctx.ds.query(`SELECT count(*)::int AS n FROM complaint_events WHERE complaint_id = $1 AND action = 'SLA_BREACH'`, [c.id]);
    expect(n).toBe(1);
  });

  it('escalates to the Sub Admin at twice the SLA', async () => {
    const c = await file();
    await age(c.id, 2 * slaHours + 1);
    await sla.sweep();
    const detail = (await ctx.http().get(api(`/complaints/${c.id}`)).set(bearer(citizenToken))).body;
    expect(detail).toEqual(expect.objectContaining({ escalated: true, escalatedAt: expect.any(String) }));
    expect(detail.events.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['SLA_BREACH', 'ESCALATE']));
    expect(await notificationsOf(subAdmin.id, c.id)).toEqual(expect.arrayContaining([{ type: 'ESCALATED' }]));

    const saToken = await tokenFor(ctx, subAdmin);
    const escalated = await ctx.http().get(api('/complaints')).query({ escalated: 'true', pageSize: 100 }).set(bearer(saToken)).expect(200);
    expect(escalated.body.items.map((x: { id: string }) => x.id)).toContain(c.id);
    const overdue = await ctx.http().get(api('/complaints')).query({ overdue: 'true', pageSize: 100 }).set(bearer(saToken)).expect(200);
    expect(overdue.body.items.map((x: { id: string }) => x.id)).toContain(c.id);
  });

  it('an unrouted complaint past its deadline alerts the Sub Admins', async () => {
    const c = await file(1); // ward 2 has no area/supervisor
    await age(c.id, slaHours + 1);
    await sla.sweep();
    expect(await notificationsOf(subAdmin.id, c.id)).toEqual(expect.arrayContaining([{ type: 'SLA_BREACHED' }]));
  });

  it('ignores resolved and closed complaints', async () => {
    const c = await file();
    await ctx.http().post(api(`/complaints/${c.id}/resolve`)).set(bearer(await tokenFor(ctx, supervisor))).send({ remark: 'Cleaned the spot' }).expect(201);
    await age(c.id, 3 * slaHours);
    await sla.sweep();
    const [row] = await ctx.ds.query(`SELECT sla_breached_at, escalated_at FROM complaints WHERE id = $1`, [c.id]);
    expect(row).toEqual({ sla_breached_at: null, escalated_at: null });
  });

  it('a reopen restarts the SLA clock', async () => {
    const c = await file();
    await age(c.id, slaHours + 1);
    await sla.sweep();
    await ctx.http().post(api(`/complaints/${c.id}/resolve`)).set(bearer(await tokenFor(ctx, supervisor))).send({ remark: 'Cleaned the spot' }).expect(201);
    await ctx.http().post(api(`/complaints/${c.id}/feedback`)).set(bearer(citizenToken)).send({ rating: 1, reopen: true }).expect(201);
    const [row] = await ctx.ds.query(`SELECT sla_breached_at, sla_due_at > now() AS future FROM complaints WHERE id = $1`, [c.id]);
    expect(row).toEqual({ sla_breached_at: null, future: true });
  });

  it('the maintenance jobs run through the queue', async () => {
    const c = await file();
    await age(c.id, slaHours + 1);
    const jobs = ctx.app.get(JobsService);
    await jobs.add(QUEUES.MAINTENANCE, 'sla-sweep', {});
    await jobs.waitForIdle([QUEUES.MAINTENANCE]);
    const [row] = await ctx.ds.query(`SELECT sla_breached_at FROM complaints WHERE id = $1`, [c.id]);
    expect(row.sla_breached_at).not.toBeNull();
  });
});

describe('Job scheduling by process role (M4)', () => {
  const saved = { role: process.env.PROCESS_ROLE, schedules: process.env.JOBS_SCHEDULES };
  afterEach(() => {
    process.env.PROCESS_ROLE = saved.role;
    process.env.JOBS_SCHEDULES = saved.schedules;
  });

  it('worker processes register the repeating schedules', async () => {
    process.env.JOBS_SCHEDULES = 'on';
    process.env.PROCESS_ROLE = 'worker';
    const ctx = await createTestApp();
    try {
      const schedulers = await ctx.app.get(JobsService).queue(QUEUES.MAINTENANCE).getJobSchedulers();
      const byId = Object.fromEntries(schedulers.map((s) => [s.key, Number(s.every)]));
      expect(byId).toEqual(expect.objectContaining({ 'sla-sweep': 60000, 'auto-close': 3600000, 'purge-media': 3600000, 'push-dispatch': 30000 }));
      const ready = await ctx.http().get(api('/health/ready')).expect(200);
      expect(ready.body).toEqual({ status: 'ready', db: true, redis: true });
    } finally {
      await ctx.app.get(JobsService).queue(QUEUES.MAINTENANCE).obliterate({ force: true });
      await ctx.app.close();
    }
  });

  it('API-only processes run no workers, so jobs wait for a worker', async () => {
    process.env.PROCESS_ROLE = 'api';
    const ctx = await createTestApp();
    try {
      const jobs = ctx.app.get(JobsService);
      expect(jobs.runsWorkers).toBe(false);
      const job = await jobs.add(QUEUES.MAINTENANCE, 'sla-sweep', {});
      await new Promise((r) => setTimeout(r, 500));
      expect(await job.getState()).toBe('waiting');
      await job.remove();
    } finally {
      await ctx.app.close();
    }
  });
});
