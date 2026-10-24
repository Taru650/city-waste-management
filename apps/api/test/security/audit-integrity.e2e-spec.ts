import { Role } from '../../src/common/enums';
import { api, bearer, createJurisdiction, createTestApp, createUser, Jurisdiction, login, quickMedia, TestCtx, tokenFor } from '../helpers';

/** OWASP A09: tamper-evident logging; CERT-In requires reliable logs. */
describe('Security: audit trail integrity', () => {
  let ctx: TestCtx;
  let j: Jurisdiction;

  beforeAll(async () => {
    ctx = await createTestApp();
    j = await createJurisdiction(ctx.ds);
  });
  afterAll(() => ctx.app.close());

  it('complaint history, feedback and audit logs are append-only at the database level', async () => {
    const citizen = await createUser(ctx, Role.CITIZEN, j);
    const typeId = (await ctx.http().get(api('/masters/complaint-types'))).body[0].id;
    const c = await ctx.http().post(api('/complaints')).set(bearer(await tokenFor(ctx, citizen)))
      .send({ typeId, ...j.wards[0].center, description: 'Garbage dump near park', mediaIds: [await quickMedia(ctx, citizen.id)] }).expect(201);
    await ctx.ds.query(`INSERT INTO feedback (complaint_id, citizen_id, rating) VALUES ($1, $2, 4)`, [c.body.id, citizen.id]);
    for (const sql of [
      `UPDATE complaint_events SET remark = 'tampered' WHERE complaint_id = '${c.body.id}'`,
      `DELETE FROM complaint_events WHERE complaint_id = '${c.body.id}'`,
      `UPDATE audit_logs SET action = 'tampered'`,
      `DELETE FROM audit_logs`,
      `DELETE FROM feedback`,
      `TRUNCATE complaint_events CASCADE`,
      `TRUNCATE audit_logs`,
      `TRUNCATE feedback`,
    ]) {
      await expect(ctx.ds.query(sql)).rejects.toThrow(/append-only/);
    }
  });

  it('records security-relevant events with actor and IP', async () => {
    const u = await createUser(ctx, Role.CITIZEN, j);
    await login(ctx, u);
    const rows = await ctx.ds.query(`SELECT action, ip FROM audit_logs WHERE actor_id = $1`, [u.id]);
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'LOGIN', ip: expect.any(String) })]));
  });
});
