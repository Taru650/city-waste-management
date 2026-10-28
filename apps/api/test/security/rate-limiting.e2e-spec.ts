import { api, createTestApp, TestCtx } from '../helpers';

/** OWASP API4: brute-force and resource exhaustion limits. */
describe('Security: rate limiting', () => {
  const saved = { ...process.env };
  let ctx: TestCtx;

  beforeAll(async () => {
    process.env.RATE_LIMIT_GLOBAL_PER_MIN = '15';
    process.env.RATE_LIMIT_AUTH_PER_MIN = '3';
    ctx = await createTestApp();
  });
  afterAll(async () => {
    await ctx.app.close();
    process.env.RATE_LIMIT_GLOBAL_PER_MIN = saved.RATE_LIMIT_GLOBAL_PER_MIN;
    process.env.RATE_LIMIT_AUTH_PER_MIN = saved.RATE_LIMIT_AUTH_PER_MIN;
  });

  it('throttles credential endpoints per client IP', async () => {
    const attempt = () => ctx.http().post(api('/auth/login')).send({ identifier: '9000000009', password: 'Wrong#pass1' });
    for (let i = 0; i < 3; i++) expect((await attempt()).status).toBe(401);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ statusCode: 429, message: 'Too many requests' });
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('applies a global per-IP limit to every route', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 16; i++) statuses.push((await ctx.http().get(api('/masters/districts'))).status);
    expect(statuses.slice(0, 15).every((s) => s === 200)).toBe(true);
    expect(statuses[15]).toBe(429);
  });
});
