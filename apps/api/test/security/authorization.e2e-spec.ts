import { NOTICE_VERSION } from '../../src/modules/privacy/notice';
import { Role } from '../../src/common/enums';
import { api, bearer, createJurisdiction, createTestApp, createUser, Jurisdiction, quickMedia, TestCtx, TestUser, tokenFor } from '../helpers';

/** OWASP API1 (BOLA/IDOR), API3 (mass assignment) and API5 (function-level authorisation). */
describe('Security: authorisation and jurisdiction isolation', () => {
  let ctx: TestCtx;
  let j: Jurisdiction;
  let other: Jurisdiction;
  let typeId: string;
  const t: Record<string, string> = {};
  const u: Record<string, TestUser> = {};
  let complaintId: string;
  let complaintNo: string;
  let otherAreaComplaintId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    j = await createJurisdiction(ctx.ds);
    other = await createJurisdiction(ctx.ds);
    typeId = (await ctx.http().get(api('/masters/complaint-types'))).body[0].id;

    u.citizenA = await createUser(ctx, Role.CITIZEN, j);
    u.citizenB = await createUser(ctx, Role.CITIZEN, j);
    u.supervisor = await createUser(ctx, Role.SUPERVISOR, j);
    u.supervisorSameUlbOtherArea = await createUser(ctx, Role.SUPERVISOR, j);
    u.supervisorOtherUlb = await createUser(ctx, Role.SUPERVISOR, other);
    u.worker = await createUser(ctx, Role.WORKER, j);
    u.otherWorker = await createUser(ctx, Role.WORKER, j);
    u.subAdminOther = await createUser(ctx, Role.SUB_ADMIN, other);
    u.districtAdminOther = await createUser(ctx, Role.DISTRICT_ADMIN, other);
    await ctx.ds.query(`UPDATE areas SET supervisor_id = $1 WHERE id = $2`, [u.supervisor.id, j.areaId]);
    const [area2] = await ctx.ds.query(`INSERT INTO areas (ulb_id, name, supervisor_id) VALUES ($1, 'Area 2', $2) RETURNING id`, [j.ulbId, u.supervisorSameUlbOtherArea.id]);
    await ctx.ds.query(`UPDATE wards SET area_id = $1 WHERE id = $2`, [area2.id, j.wards[1].id]);
    for (const [k, v] of Object.entries(u)) t[k] = await tokenFor(ctx, v);

    const c = await ctx.http().post(api('/complaints')).set(bearer(t.citizenA))
      .send({ typeId, ...j.wards[0].center, description: 'Garbage near the school gate', mediaIds: [await quickMedia(ctx, u.citizenA.id)] }).expect(201);
    complaintId = c.body.id;
    complaintNo = c.body.complaintNo;
    await ctx.http().post(api(`/complaints/${complaintId}/assign`)).set(bearer(t.supervisor)).send({ workerId: u.worker.id }).expect(201);
    const c2 = await ctx.http().post(api('/complaints')).set(bearer(t.citizenB))
      .send({ typeId, ...j.wards[1].center, description: 'Drain overflowing on main road', mediaIds: [await quickMedia(ctx, u.citizenB.id)] }).expect(201);
    otherAreaComplaintId = c2.body.id;
  });
  afterAll(() => ctx.app.close());

  describe('IDOR: complaints of others are invisible (404, not 403, so IDs cannot be probed)', () => {
    it.each(['citizenB', 'supervisorSameUlbOtherArea', 'supervisorOtherUlb', 'otherWorker', 'subAdminOther', 'districtAdminOther'])(
      '%s cannot read the complaint by id or number',
      async (who) => {
        await ctx.http().get(api(`/complaints/${complaintId}`)).set(bearer(t[who])).expect(404);
        await ctx.http().get(api(`/complaints/track/${complaintNo}`)).set(bearer(t[who])).expect(404);
        const list = await ctx.http().get(api('/complaints')).query({ pageSize: 100 }).set(bearer(t[who])).expect(200);
        expect(list.body.items.map((c: { id: string }) => c.id)).not.toContain(complaintId);
      },
    );

    it('a supervisor of another ULB cannot act on the complaint', async () => {
      await ctx.http().post(api(`/complaints/${complaintId}/reject`)).set(bearer(t.supervisorOtherUlb)).send({ reason: 'Not valid at all' }).expect(404);
      await ctx.http().post(api(`/complaints/${complaintId}/assign`)).set(bearer(t.supervisorSameUlbOtherArea)).send({ workerId: u.otherWorker.id }).expect(404);
    });

    it('a worker who is not assigned cannot start or resolve it', async () => {
      await ctx.http().post(api(`/complaints/${complaintId}/start`)).set(bearer(t.otherWorker)).send({}).expect(404);
      await ctx.http().post(api(`/complaints/${complaintId}/resolve`)).set(bearer(t.otherWorker)).send({ remark: 'Fake resolution' }).expect(404);
    });

    it('another citizen cannot give feedback on it', async () => {
      await ctx.http().post(api(`/complaints/${complaintId}/feedback`)).set(bearer(t.citizenB)).send({ rating: 1 }).expect(404);
    });

    it('a supervisor only sees their own area\'s complaints', async () => {
      await ctx.http().get(api(`/complaints/${otherAreaComplaintId}`)).set(bearer(t.supervisor)).expect(404);
      await ctx.http().get(api(`/complaints/${otherAreaComplaintId}`)).set(bearer(t.supervisorSameUlbOtherArea)).expect(200);
    });

    it('the owner, assigned staff and in-jurisdiction admins can read it', async () => {
      await ctx.http().get(api(`/complaints/${complaintId}`)).set(bearer(t.citizenA)).expect(200);
      await ctx.http().get(api(`/complaints/${complaintId}`)).set(bearer(t.worker)).expect(200);
      await ctx.http().get(api(`/complaints/${complaintId}`)).set(bearer(t.supervisor)).expect(200);
    });

    it('citizen views do not expose the citizen\'s identity to field staff or other citizens\' PII', async () => {
      const res = await ctx.http().get(api(`/complaints/${complaintId}`)).set(bearer(t.worker)).expect(200);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(u.citizenA.mobile);
      expect(body).not.toContain(u.citizenA.email);
      expect(res.body.citizenId).toBeUndefined();
    });
  });

  describe('function-level authorisation', () => {
    it.each([
      ['get', '/users'], ['post', '/users'], ['post', '/masters/districts'], ['post', '/masters/ulbs'], ['post', '/masters/wards'],
      ['post', '/masters/areas'],
    ])('a citizen gets 403 on %s %s', async (method, path) => {
      const req = (ctx.http() as never as Record<string, (p: string) => import('supertest').Test>)[method](api(path));
      await req.set(bearer(t.citizenA)).send({}).expect(403);
    });

    it('workers cannot triage', async () => {
      for (const action of ['assign', 'reject', 'duplicate']) {
        await ctx.http().post(api(`/complaints/${complaintId}/${action}`)).set(bearer(t.worker)).send({}).expect(403);
      }
    });

    it('staff cannot file complaints or give feedback as citizens', async () => {
      await ctx.http().post(api('/complaints')).set(bearer(t.supervisor)).send({ typeId, ...j.wards[0].center, description: 'Staff complaint' }).expect(403);
      await ctx.http().post(api(`/complaints/${complaintId}/feedback`)).set(bearer(t.worker)).send({ rating: 5 }).expect(403);
    });
  });

  describe('mass assignment', () => {
    it('registration cannot choose a role or status', async () => {
      const res = await ctx.http().post(api('/auth/register')).send({
        homeWardId: j.wards[0].id, consentNoticeVersion: NOTICE_VERSION, name: 'Evil User', mobile: '7000000001', email: 'evil@example.in', password: 'Swachh#2026city',
        role: 'WEB_ADMIN', status: 'ACTIVE',
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/property role should not exist/);
    });

    it('a citizen cannot set status, assignee or owner when filing', async () => {
      const res = await ctx.http().post(api('/complaints')).set(bearer(t.citizenB)).send({
        typeId, ...j.wards[0].center, description: 'Trying to self-resolve', mediaIds: [await quickMedia(ctx, u.citizenB.id)],
        status: 'CLOSED', workerId: u.worker.id, citizenId: u.citizenA.id,
      });
      expect(res.status).toBe(400);
    });

    it('a Sub Admin cannot create staff in another ULB by passing ulbId', async () => {
      const sa = await createUser(ctx, Role.SUB_ADMIN, j);
      const res = await ctx.http().post(api('/users')).set(bearer(await tokenFor(ctx, sa)))
        .send({ role: 'WORKER', name: 'Planted Worker', mobile: '7000000002', ulbId: other.ulbId }).expect(201);
      const [row] = await ctx.ds.query(`SELECT ulb_id FROM users WHERE id = $1`, [res.body.id]);
      expect(row.ulb_id).toBe(j.ulbId);
    });
  });
});
