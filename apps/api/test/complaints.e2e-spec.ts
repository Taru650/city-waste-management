import { Role } from '../src/common/enums';
import { api, bearer, createJurisdiction, createTestApp, createUser, Jurisdiction, TestCtx, TestUser, tokenFor } from './helpers';

describe('Complaint lifecycle (M2)', () => {
  let ctx: TestCtx;
  let j: Jurisdiction;
  let other: Jurisdiction;
  let typeId: string;
  let citizen: TestUser;
  let citizenToken: string;
  let supervisor: TestUser;
  let supervisorToken: string;
  let worker: TestUser;
  let workerToken: string;
  let subAdminToken: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    j = await createJurisdiction(ctx.ds);
    other = await createJurisdiction(ctx.ds);
    supervisor = await createUser(ctx, Role.SUPERVISOR, j);
    await ctx.ds.query(`UPDATE areas SET supervisor_id = $1 WHERE id = $2`, [supervisor.id, j.areaId]);
    worker = await createUser(ctx, Role.WORKER, j);
    [supervisorToken, workerToken, subAdminToken] = await Promise.all([
      tokenFor(ctx, supervisor), tokenFor(ctx, worker),
      tokenFor(ctx, await createUser(ctx, Role.SUB_ADMIN, j)),
    ]);
    typeId = (await ctx.http().get(api('/masters/complaint-types'))).body.find((t: { code: string }) => t.code === 'GARBAGE_HEAP').id;
  });
  afterAll(() => ctx.app.close());

  // A fresh citizen per test keeps each test under the 10-complaints-a-day limit.
  beforeEach(async () => {
    citizen = await createUser(ctx, Role.CITIZEN, other); // lives in another district, complains here
    citizenToken = await tokenFor(ctx, citizen);
  });

  const file = (token: string, over: object = {}) =>
    ctx.http().post(api('/complaints')).set(bearer(token)).send({
      typeId, ...j.wards[0].center, gpsAccuracyM: 8, landmark: 'Near Shiv Mandir', description: 'Kachra ka dher 3 din se pada hai', ...over,
    });

  describe('filing and routing', () => {
    it('detects the ward from GPS (not the citizen\'s home ward) and routes to the area supervisor', async () => {
      const res = await file(citizenToken).expect(201);
      expect(res.body).toEqual(expect.objectContaining({
        status: 'ASSIGNED',
        wardSource: 'GPS',
        wardMismatch: false,
        ward: { id: j.wards[0].id, number: 1 },
        ulb: expect.objectContaining({ id: j.ulbId }),
        district: expect.objectContaining({ id: j.districtId }),
        supervisor: { id: supervisor.id, name: expect.any(String) },
      }));
      const events = (await ctx.http().get(api(`/complaints/${res.body.id}`)).set(bearer(citizenToken)).expect(200)).body.events;
      expect(events.map((e: { action: string }) => e.action)).toEqual(['CREATE', 'ROUTE']);
    });

    it('builds the complaint number from district LGD + ULB LGD + year + sequence', async () => {
      const res = await file(citizenToken).expect(201);
      const yy = String(new Date().getFullYear() % 100).padStart(2, '0');
      expect(res.body.complaintNo).toMatch(
        new RegExp(`^${String(j.districtLgd).padStart(4, '0')}-${String(j.ulbLgd).padStart(6, '0')}-${yy}-\\d{6}$`),
      );
      const tracked = await ctx.http().get(api(`/complaints/track/${res.body.complaintNo}`)).set(bearer(citizenToken)).expect(200);
      expect(tracked.body.id).toBe(res.body.id);
    });

    it('a ward without an area/supervisor waits PENDING in the Sub Admin queue', async () => {
      const res = await file(citizenToken, j.wards[1].center).expect(201);
      expect(res.body).toEqual(expect.objectContaining({ status: 'PENDING', supervisor: null, ward: { id: j.wards[1].id, number: 2 } }));
      const queue = await ctx.http().get(api('/complaints')).query({ status: 'PENDING' }).set(bearer(subAdminToken)).expect(200);
      expect(queue.body.items.map((c: { id: string }) => c.id)).toContain(res.body.id);
    });

    it('a citizen-chosen ward far from the GPS point is accepted but flagged', async () => {
      const res = await file(citizenToken, { wardId: other.wards[0].id }).expect(201);
      expect(res.body).toEqual(expect.objectContaining({ wardSource: 'MANUAL', wardMismatch: true, ulb: expect.objectContaining({ id: other.ulbId }) }));
      // Standing in ward 1 about 110 m from the ward 2 boundary, choosing ward 2: plausible, not flagged.
      const nearPoint = { lat: j.wards[0].center.lat, lng: j.wards[1].center.lng - 0.006 };
      const near = await file(citizenToken, { ...nearPoint, wardId: j.wards[1].id }).expect(201);
      expect(near.body).toEqual(expect.objectContaining({ wardSource: 'MANUAL', wardMismatch: false }));
    });

    it('asks for a manual ward when GPS is outside every ward boundary', async () => {
      await file(citizenToken, { lat: -40, lng: 20 }).expect(400);
    });

    it('validates lengths from the SRS (landmark 50, description 250)', async () => {
      await file(citizenToken, { landmark: 'x'.repeat(51) }).expect(400);
      await file(citizenToken, { description: 'x'.repeat(251) }).expect(400);
    });

    it('only citizens file complaints', async () => {
      await file(workerToken).expect(403);
      await file(supervisorToken).expect(403);
    });

    it('generates unique, gap-free numbers under concurrency', async () => {
      const j2 = await createJurisdiction(ctx.ds);
      const citizens = await Promise.all(Array.from({ length: 5 }, () => createUser(ctx, Role.CITIZEN, j2)));
      const tokens = await Promise.all(citizens.map((c) => tokenFor(ctx, c)));
      const results = await Promise.all(
        tokens.flatMap((t) => Array.from({ length: 8 }, () => file(t, j2.wards[0].center))),
      );
      expect(results.every((r) => r.status === 201)).toBe(true);
      const seqs = results.map((r) => Number(r.body.complaintNo.slice(-6))).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    });

    it('enforces 10 complaints per citizen per 24 hours', async () => {
      const c = await createUser(ctx, Role.CITIZEN, j);
      const t = await tokenFor(ctx, c);
      for (let i = 0; i < 10; i++) await file(t).expect(201);
      await file(t).expect(429);
    });
  });

  describe('assignment, field work and resolution', () => {
    it('supervisor assigns → worker starts → worker resolves with location → citizen closes with rating', async () => {
      const c = (await file(citizenToken).expect(201)).body;

      // Worker cannot see it before assignment.
      await ctx.http().get(api(`/complaints/${c.id}`)).set(bearer(workerToken)).expect(404);

      const assigned = await ctx.http().post(api(`/complaints/${c.id}/assign`)).set(bearer(supervisorToken))
        .send({ workerId: worker.id, remark: 'Urgent' }).expect(201);
      expect(assigned.body).toEqual(expect.objectContaining({ status: 'ASSIGNED', worker: { id: worker.id, name: expect.any(String) } }));

      const tasks = await ctx.http().get(api('/complaints')).set(bearer(workerToken)).expect(200);
      expect(tasks.body.items.map((x: { id: string }) => x.id)).toContain(c.id);

      // Worker must start before resolving.
      await ctx.http().post(api(`/complaints/${c.id}/resolve`)).set(bearer(workerToken)).send({ remark: 'Done cleaning' }).expect(409);
      await ctx.http().post(api(`/complaints/${c.id}/start`)).set(bearer(workerToken)).send({ location: j.wards[0].center }).expect(201);
      const resolved = await ctx.http().post(api(`/complaints/${c.id}/resolve`)).set(bearer(workerToken))
        .send({ remark: 'Kachra uthaya, chuna dala', location: j.wards[0].center }).expect(201);
      expect(resolved.body).toEqual(expect.objectContaining({ status: 'RESOLVED', resolutionRemark: 'Kachra uthaya, chuna dala' }));

      const closed = await ctx.http().post(api(`/complaints/${c.id}/feedback`)).set(bearer(citizenToken))
        .send({ rating: 5, remark: 'Bahut accha kaam' }).expect(201);
      expect(closed.body.status).toBe('CLOSED');

      const detail = (await ctx.http().get(api(`/complaints/${c.id}`)).set(bearer(citizenToken))).body;
      expect(detail.events.map((e: { action: string }) => e.action)).toEqual(['CREATE', 'ROUTE', 'ASSIGN', 'START', 'RESOLVE', 'CLOSE']);
      expect(detail.feedback).toEqual([expect.objectContaining({ rating: 5, reopenRequested: false })]);
      // Feedback only once per resolution.
      await ctx.http().post(api(`/complaints/${c.id}/feedback`)).set(bearer(citizenToken)).send({ rating: 1 }).expect(409);
    });

    it('flags a resolution recorded away from the complaint location', async () => {
      const c = (await file(citizenToken).expect(201)).body;
      await ctx.http().post(api(`/complaints/${c.id}/resolve`)).set(bearer(supervisorToken))
        .send({ remark: 'Resolved by supervisor', location: other.wards[0].center }).expect(201);
      const [ev] = await ctx.ds.query(`SELECT meta FROM complaint_events WHERE complaint_id = $1 AND action = 'RESOLVE'`, [c.id]);
      expect(ev.meta).toEqual(expect.objectContaining({ outsideGeofence: true, distanceM: expect.any(Number) }));
    });

    it('a worker of another ULB cannot be assigned', async () => {
      const c = (await file(citizenToken).expect(201)).body;
      const outsider = await createUser(ctx, Role.WORKER, other);
      await ctx.http().post(api(`/complaints/${c.id}/assign`)).set(bearer(supervisorToken)).send({ workerId: outsider.id }).expect(400);
    });

    it('Sub Admin can hand a PENDING complaint to a supervisor', async () => {
      const c = (await file(citizenToken, j.wards[1].center).expect(201)).body;
      const res = await ctx.http().post(api(`/complaints/${c.id}/assign`)).set(bearer(subAdminToken))
        .send({ supervisorId: supervisor.id, workerId: worker.id }).expect(201);
      expect(res.body).toEqual(expect.objectContaining({ status: 'ASSIGNED', supervisor: expect.objectContaining({ id: supervisor.id }) }));
      // supervisor-only users cannot change the supervisor
      await ctx.http().post(api(`/complaints/${c.id}/assign`)).set(bearer(supervisorToken)).send({ supervisorId: supervisor.id }).expect(400);
    });
  });

  describe('triage: reject and duplicate', () => {
    it('rejects with a mandatory reason', async () => {
      const c = (await file(citizenToken).expect(201)).body;
      await ctx.http().post(api(`/complaints/${c.id}/reject`)).set(bearer(supervisorToken)).send({}).expect(400);
      const res = await ctx.http().post(api(`/complaints/${c.id}/reject`)).set(bearer(supervisorToken))
        .send({ reason: 'Private property, not ULB jurisdiction' }).expect(201);
      expect(res.body.status).toBe('REJECTED');
      await ctx.http().post(api(`/complaints/${c.id}/assign`)).set(bearer(supervisorToken)).send({ workerId: worker.id }).expect(409);
    });

    it('suggests nearby same-type complaints and merges a duplicate', async () => {
      const a = (await file(citizenToken).expect(201)).body;
      const b = (await file(citizenToken, { lat: j.wards[0].center.lat + 0.0002 }).expect(201)).body; // ~22 m away
      const candidates = await ctx.http().get(api(`/complaints/${b.id}/duplicate-candidates`)).set(bearer(supervisorToken)).expect(200);
      expect(candidates.body.map((x: { id: string }) => x.id)).toContain(a.id);
      await ctx.http().post(api(`/complaints/${b.id}/duplicate`)).set(bearer(supervisorToken)).send({ duplicateOfId: b.id }).expect(400);
      const res = await ctx.http().post(api(`/complaints/${b.id}/duplicate`)).set(bearer(supervisorToken)).send({ duplicateOfId: a.id }).expect(201);
      expect(res.body).toEqual(expect.objectContaining({ status: 'DUPLICATE', duplicateOf: a.id }));
    });
  });

  describe('citizen feedback and reopen', () => {
    async function resolvedComplaint() {
      const c = (await file(citizenToken).expect(201)).body;
      await ctx.http().post(api(`/complaints/${c.id}/resolve`)).set(bearer(supervisorToken)).send({ remark: 'Cleaned the spot' }).expect(201);
      return c;
    }

    it('reopen requires a low rating', async () => {
      const c = await resolvedComplaint();
      await ctx.http().post(api(`/complaints/${c.id}/feedback`)).set(bearer(citizenToken)).send({ rating: 4, reopen: true }).expect(400);
      await ctx.http().post(api(`/complaints/${c.id}/feedback`)).set(bearer(citizenToken)).send({ rating: 6 }).expect(400);
    });

    it('a rating of 1-2 with reopen sends it back to the supervisor with a fresh SLA; third reopen escalates', async () => {
      const c = await resolvedComplaint();
      for (let round = 1; round <= 3; round++) {
        const res = await ctx.http().post(api(`/complaints/${c.id}/feedback`)).set(bearer(citizenToken))
          .send({ rating: 1, remark: 'Abhi bhi kachra hai', reopen: true }).expect(201);
        expect(res.body).toEqual(expect.objectContaining({ status: 'REOPENED', reopenCount: round, escalated: round > 2 }));
        await ctx.http().post(api(`/complaints/${c.id}/resolve`)).set(bearer(supervisorToken)).send({ remark: 'Cleaned again' }).expect(201);
      }
    });

    it('a low rating without reopen still closes', async () => {
      const c = await resolvedComplaint();
      const res = await ctx.http().post(api(`/complaints/${c.id}/feedback`)).set(bearer(citizenToken)).send({ rating: 2 }).expect(201);
      expect(res.body.status).toBe('CLOSED');
    });

    it('feedback closes after 7 days, and unrated complaints are auto-closed', async () => {
      const c = await resolvedComplaint();
      await ctx.ds.query(`UPDATE complaints SET resolved_at = now() - interval '8 days' WHERE id = $1`, [c.id]);
      await ctx.http().post(api(`/complaints/${c.id}/feedback`)).set(bearer(citizenToken)).send({ rating: 1, reopen: true }).expect(400);
      const { ComplaintsService } = await import('../src/modules/complaints/complaints.service');
      expect(await ctx.app.get(ComplaintsService).autoCloseStale()).toBeGreaterThanOrEqual(1);
      const detail = (await ctx.http().get(api(`/complaints/${c.id}`)).set(bearer(citizenToken))).body;
      expect(detail.status).toBe('CLOSED');
      expect(detail.events.at(-1).action).toBe('AUTO_CLOSE');
    });
  });

  describe('listing', () => {
    it('filters and paginates, newest first', async () => {
      const res = await ctx.http().get(api('/complaints')).query({ status: 'ASSIGNED', pageSize: 2 }).set(bearer(supervisorToken)).expect(200);
      expect(res.body.items.length).toBeLessThanOrEqual(2);
      expect(res.body.items.every((c: { status: string }) => c.status === 'ASSIGNED')).toBe(true);
      expect(res.body.total).toBeGreaterThanOrEqual(res.body.items.length);
      await ctx.http().get(api('/complaints')).query({ pageSize: 1000 }).set(bearer(supervisorToken)).expect(400);
    });

    it('District Admin sees all ULBs of the district but cannot act', async () => {
      const da = await tokenFor(ctx, await createUser(ctx, Role.DISTRICT_ADMIN, j));
      const list = await ctx.http().get(api('/complaints')).set(bearer(da)).expect(200);
      expect(list.body.total).toBeGreaterThan(0);
      const id = list.body.items[0].id;
      await ctx.http().post(api(`/complaints/${id}/assign`)).set(bearer(da)).send({ workerId: worker.id }).expect(403);
    });
  });
});
