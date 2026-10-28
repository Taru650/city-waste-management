import { setTimeout as sleep } from 'node:timers/promises';
import { Role } from '../../src/common/enums';
import { dataSourceOptions } from '../../src/database/data-source';
import { api, bearer, createJurisdiction, createTestApp, createUser, login, TestCtx } from '../helpers';

/**
 * Database limits (audit M1): a slow query, a transaction left open or an exhausted pool must fail
 * fast with a clear answer instead of hanging every request behind it. Tiny limits make it testable.
 */
const LIMITS = {
  DB_POOL_MAX: '2',
  DB_STATEMENT_TIMEOUT_MS: '300',
  DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '500',
  DB_CONNECTION_TIMEOUT_MS: '400',
  PROCESS_ROLE: 'api',
};

describe('Database limits', () => {
  const saved = Object.fromEntries(Object.keys(LIMITS).map((k) => [k, process.env[k]]));
  let ctx: TestCtx;

  beforeAll(async () => {
    Object.assign(process.env, LIMITS);
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('cancels a statement that runs past the limit', async () => {
    const started = Date.now();
    await expect(ctx.ds.query('SELECT pg_sleep(2)')).rejects.toMatchObject({ code: '57014' });
    expect(Date.now() - started).toBeLessThan(1500);
    await expect(ctx.ds.query('SELECT 1 AS ok')).resolves.toEqual([{ ok: 1 }]);
  });

  it('ends a transaction left open, releasing its locks', async () => {
    const qr = ctx.ds.createQueryRunner();
    await qr.startTransaction();
    await qr.query('SELECT 1');
    await sleep(1_000);
    await expect(qr.query('SELECT 1')).rejects.toThrow();
    await qr.release().catch(() => undefined);
  });

  it('a request that cannot get a connection gets a 503 quickly, and the API recovers', async () => {
    const j = await createJurisdiction(ctx.ds);
    const { accessToken } = await login(ctx, await createUser(ctx, Role.SUPERVISOR, j));
    const held = [ctx.ds.createQueryRunner(), ctx.ds.createQueryRunner()];
    await Promise.all(held.map((q) => q.connect()));
    try {
      const started = Date.now();
      const res = await ctx.http().get(api('/auth/me')).set(bearer(accessToken)).expect(503);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(res.body).toEqual({ statusCode: 503, message: expect.stringMatching(/try again/i) });
    } finally {
      await Promise.all(held.map((q) => q.release()));
    }
    await ctx.http().get(api('/auth/me')).set(bearer(accessToken)).expect(200);
  });

  it('migrations and maintenance scripts run without these limits', () => {
    expect(dataSourceOptions('postgres://x/y').extra).toEqual({ max: 20 });
  });
});
