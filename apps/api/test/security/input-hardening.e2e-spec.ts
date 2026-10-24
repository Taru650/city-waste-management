import { Role } from '../../src/common/enums';
import { api, bearer, createJurisdiction, createTestApp, createUser, Jurisdiction, quickMedia, subOf, TestCtx, tokenFor } from '../helpers';

/** OWASP A03 (injection), API4 (resource consumption), A05 (misconfiguration / error leakage). */
describe('Security: input handling', () => {
  let ctx: TestCtx;
  let j: Jurisdiction;
  let citizen: string;
  let typeId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    j = await createJurisdiction(ctx.ds);
    citizen = await tokenFor(ctx, await createUser(ctx, Role.CITIZEN, j));
    typeId = (await ctx.http().get(api('/masters/complaint-types'))).body[0].id;
  });
  afterAll(() => ctx.app.close());

  const SQLI = ["' OR '1'='1", "1; DROP TABLE complaints; --", "' UNION SELECT password_hash FROM users --", '$1', "\\'; --"];

  it.each(SQLI)('SQL injection in query, path and body parameters is inert: %p', async (payload) => {
    await ctx.http().get(api('/complaints')).query({ status: payload }).set(bearer(citizen)).expect(400);
    await ctx.http().get(api('/complaints')).query({ wardId: payload }).set(bearer(citizen)).expect(400);
    await ctx.http().get(api(`/complaints/${encodeURIComponent(payload)}`)).set(bearer(citizen)).expect(400);
    await ctx.http().get(api(`/complaints/track/${encodeURIComponent(payload)}`)).set(bearer(citizen)).expect(404);
    const login = await ctx.http().post(api('/auth/login')).send({ identifier: payload, password: payload });
    expect([400, 401]).toContain(login.status); // 400 when too short to be an identifier
    const [{ ok }] = await ctx.ds.query(`SELECT to_regclass('public.complaints') IS NOT NULL AS ok`);
    expect(ok).toBe(true);
  });

  it('free text with SQL and script content is stored verbatim and served as inert JSON', async () => {
    const description = `<script>alert(1)</script> '; DROP TABLE users; --`;
    const res = await ctx.http().post(api('/complaints')).set(bearer(citizen)).send({ typeId, ...j.wards[0].center, description, mediaIds: [await quickMedia(ctx, subOf(citizen))] }).expect(201);
    expect(res.body.description).toBe(description);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const [{ n }] = await ctx.ds.query(`SELECT count(*)::int AS n FROM users`);
    expect(n).toBeGreaterThan(0);
  });

  it('rejects bodies over 1 MB', async () => {
    const res = await ctx.http().post(api('/auth/login')).set('content-type', 'application/json')
      .send(JSON.stringify({ identifier: 'x'.repeat(1_100_000), password: 'y' }));
    expect(res.status).toBe(413);
  });

  it('malformed JSON gets a 400 without parser internals', async () => {
    const res = await ctx.http().post(api('/auth/login')).set('content-type', 'application/json').send('{"identifier": ');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/at JSON\.parse|node_modules|stack/i);
  });

  it('prototype pollution payloads are rejected and do not pollute', async () => {
    const res = await ctx.http().post(api('/auth/login')).set('content-type', 'application/json')
      .send('{"identifier":"9000000000","password":"x","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
    expect([400, 401]).toContain(res.status);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects wrong types and out-of-range coordinates', async () => {
    for (const bad of [{ lat: '21.2; DROP' }, { lat: 91 }, { lng: -181 }, { lat: null }, { typeId: 'not-a-uuid' }]) {
      await ctx.http().post(api('/complaints')).set(bearer(citizen)).send({ typeId, ...j.wards[0].center, description: 'Valid text', mediaIds: [await quickMedia(ctx, subOf(citizen))], ...bad }).expect(400);
    }
  });

  it('caps password length to bound Argon2 cost', async () => {
    await ctx.http().post(api('/auth/login')).send({ identifier: '9000000000', password: 'a'.repeat(10_000) }).expect(400);
  });

  it('unknown routes and server errors never leak stack traces', async () => {
    const res = await ctx.http().get(api('/does-not-exist')).set(bearer(citizen)).expect(404);
    expect(JSON.stringify(res.body)).not.toMatch(/stack|node_modules|\.ts:/);
  });
});
