import { JobsService, QUEUES } from '../../src/modules/jobs/jobs.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { api, createTestApp, TestCtx } from '../helpers';

/**
 * Redis outage (failure drill, audit 2026-10): Redis carries only background jobs, so requests must
 * keep answering. Before the fix, awaiting a job enqueue never settled while Redis was down, and a
 * complaint action committed in the database but its HTTP request never answered.
 */
const ENV = { REDIS_URL: 'redis://127.0.0.1:6399/0', PROCESS_ROLE: 'api', JOBS_REDIS_WAIT_MS: '300' };

describe('Redis outage', () => {
  const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  let ctx: TestCtx;

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const within = async <T>(ms: number, p: Promise<T>) => {
    const started = Date.now();
    const out = await p;
    expect(Date.now() - started).toBeLessThan(ms);
    return out;
  };

  it('readiness answers 503 quickly instead of hanging', async () => {
    const res = await within(2_000, ctx.http().get(api('/health/ready')).then((r) => r));
    expect(res.status).toBe(503);
    expect(res.body).toEqual(expect.objectContaining({ db: true, redis: false }));
    await ctx.http().get(api('/health')).expect(200);
  });

  it('queueing a job gives up after the wait limit', async () => {
    await within(2_000, expect(ctx.app.get(JobsService).add(QUEUES.PUSH, 'dispatch', {})).rejects.toThrow(/Job queue unavailable/));
  });

  it('the post-commit push kick after a complaint action returns (the sweep delivers later)', async () => {
    await within(2_000, ctx.app.get(NotificationsService).kick());
  });

  it('shuts down promptly (a stop during an outage used to hang until SIGKILL)', async () => {
    const other = await createTestApp();
    await within(5_000, other.app.close());
  });
});
