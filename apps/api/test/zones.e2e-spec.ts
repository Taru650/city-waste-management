import { Role } from '../src/common/enums';
import { ZonesService } from '../src/modules/zones/zones.service';
import { api, bearer, createJurisdiction, createTestApp, createUser, Jurisdiction, login, quickMedia, square, TestCtx, TestUser, tokenFor } from './helpers';

const H = 3_600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

describe('Event zones and temporary staff (M8)', () => {
  let ctx: TestCtx;
  let zones: ZonesService;
  let j: Jurisdiction;
  let other: Jurisdiction;
  let subAdmin: string;
  let otherSubAdmin: string;
  let areaSupervisor: TestUser;
  let zoneSupervisor: TestUser;
  let typeId: string;
  let typeSla: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    zones = ctx.app.get(ZonesService);
    j = await createJurisdiction(ctx.ds);
    other = await createJurisdiction(ctx.ds);
    subAdmin = await tokenFor(ctx, await createUser(ctx, Role.SUB_ADMIN, j));
    otherSubAdmin = await tokenFor(ctx, await createUser(ctx, Role.SUB_ADMIN, other));
    areaSupervisor = await createUser(ctx, Role.SUPERVISOR, j);
    zoneSupervisor = await createUser(ctx, Role.SUPERVISOR, j);
    await ctx.ds.query(`UPDATE areas SET supervisor_id = $1 WHERE id = $2`, [areaSupervisor.id, j.areaId]);
    const type = (await ctx.http().get(api('/masters/complaint-types'))).body.find((t: { code: string }) => t.code === 'GARBAGE_HEAP');
    typeId = type.id;
    typeSla = type.slaHours;
  });
  afterAll(() => ctx.app.close());
  // A failed test must not leave an active zone behind (it would block the next one as an overlap).
  afterEach(() => ctx.ds.query(`UPDATE event_zones SET active = false, handed_over_at = COALESCE(handed_over_at, now()) WHERE ulb_id = $1 AND active`, [j.ulbId]));

  const c0 = () => j.wards[0].center;
  /** A 0.004° square (~440 m) around the centre of ward 1. */
  const boundary = (dLat = 0, dLng = 0) => square(c0().lat - 0.002 + dLat, c0().lng - 0.002 + dLng, 0.004);
  const zoneBody = (over: object = {}) => ({
    ulbId: j.ulbId, name: `Mela ${Math.random().toString(36).slice(2, 7)}`, boundary: boundary(),
    startsAt: iso(-H), endsAt: iso(48 * H), supervisorId: zoneSupervisor.id, slaHours: 4, ...over,
  });
  const createZone = async (over: object = {}) => (await ctx.http().post(api('/event-zones')).set(bearer(subAdmin)).send(zoneBody(over)).expect(201)).body.id as string;
  const cancel = (id: string) => ctx.http().patch(api(`/event-zones/${id}`)).set(bearer(subAdmin)).send({ active: false }).expect(200);
  const file = async (at: { lat: number; lng: number }) => {
    const citizen = await createUser(ctx, Role.CITIZEN, j);
    const token = await tokenFor(ctx, citizen);
    const res = await ctx.http().post(api('/complaints')).set(bearer(token))
      .send({ typeId, ...at, description: 'Garbage near the mela gate', mediaIds: [await quickMedia(ctx, citizen.id, at)] }).expect(201);
    return res.body;
  };

  describe('creation rules', () => {
    it.each([
      ['an invalid (self-intersecting) polygon', { boundary: { type: 'Polygon', coordinates: [[[80, 25], [80.01, 25.01], [80.01, 25], [80, 25.01], [80, 25]]] } }, /not valid/],
      ['a zone outside the ULB', { boundary: square(30, 90, 0.004) }, /overlap the wards/],
      // getter: the jurisdiction only exists once beforeAll has run
      ['a zone larger than 100 km²', { get boundary() { return square(c0().lat - 0.1, c0().lng - 0.1, 0.2); } }, /100 km/],
      ['an event longer than 92 days', { endsAt: iso(100 * 24 * H) }, /92 days/],
      ['an event that already ended', { startsAt: iso(-48 * H), endsAt: iso(-H) }, /future/],
      ['end before start', { startsAt: iso(5 * H), endsAt: iso(2 * H) }, /after startsAt/],
    ])('refuses %s', async (_l, over, msg) => {
      const res = await ctx.http().post(api('/event-zones')).set(bearer(subAdmin)).send(zoneBody(over));
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.message)).toMatch(msg);
    });

    it('refuses a supervisor from another ULB or whose temporary access ends before the zone', async () => {
      const foreign = await createUser(ctx, Role.SUPERVISOR, other);
      await ctx.http().post(api('/event-zones')).set(bearer(subAdmin)).send(zoneBody({ supervisorId: foreign.id })).expect(400);
      const temp = (await ctx.http().post(api('/users')).set(bearer(subAdmin))
        .send({ role: 'SUPERVISOR', name: 'Mela Temp', mobile: `8${String(Date.now()).slice(-9)}`, accessExpiresAt: iso(24 * H) }).expect(201)).body;
      const res = await ctx.http().post(api('/event-zones')).set(bearer(subAdmin)).send(zoneBody({ supervisorId: temp.id })).expect(400);
      expect(res.body.message).toMatch(/access ends before/);
    });

    it('refuses two active zones over the same place at the same time (ambiguous routing)', async () => {
      const id = await createZone();
      const res = await ctx.http().post(api('/event-zones')).set(bearer(subAdmin)).send(zoneBody({ boundary: boundary(0.001, 0.001) })).expect(400);
      expect(res.body.message).toMatch(/Overlaps/);
      // Same place, later dates: fine.
      const later = await createZone({ boundary: boundary(0.001, 0.001), startsAt: iso(72 * H), endsAt: iso(96 * H) });
      await cancel(later);
      await cancel(id);
    });
  });

  describe('jurisdiction', () => {
    it('another ULB cannot create, edit or see the zone; supervisors see only zones they run; workers have no access', async () => {
      const id = await createZone();
      // A Sub Admin's zone always belongs to their own ULB whatever ulbId says, so a polygon in
      // someone else's ULB is refused and nothing is created there.
      const before = (await ctx.ds.query(`SELECT count(*)::int AS n FROM event_zones WHERE ulb_id = $1`, [j.ulbId]))[0].n;
      const res = await ctx.http().post(api('/event-zones')).set(bearer(otherSubAdmin)).send(zoneBody()).expect(400);
      expect(res.body.message).toMatch(/overlap the wards/);
      expect((await ctx.ds.query(`SELECT count(*)::int AS n FROM event_zones WHERE ulb_id = $1`, [j.ulbId]))[0].n).toBe(before);
      await ctx.http().patch(api(`/event-zones/${id}`)).set(bearer(otherSubAdmin)).send({ name: 'Hijacked' }).expect(403);
      await ctx.http().get(api(`/event-zones/${id}`)).set(bearer(otherSubAdmin)).expect(404);
      expect((await ctx.http().get(api('/event-zones')).set(bearer(otherSubAdmin))).body.map((z: { id: string }) => z.id)).not.toContain(id);
      await ctx.http().get(api(`/event-zones/${id}`)).set(bearer(await tokenFor(ctx, zoneSupervisor))).expect(200);
      await ctx.http().get(api(`/event-zones/${id}`)).set(bearer(await tokenFor(ctx, areaSupervisor))).expect(404);
      await ctx.http().get(api('/event-zones')).set(bearer(await tokenFor(ctx, await createUser(ctx, Role.WORKER, j)))).expect(403);
      await ctx.http().post(api('/event-zones')).set(bearer(await tokenFor(ctx, zoneSupervisor))).send(zoneBody()).expect(403);
      await cancel(id);
    });
  });

  describe('routing, deadline and dashboard', () => {
    it('a complaint inside an active zone goes to the zone supervisor with the tighter deadline; outside it, to the area supervisor', async () => {
      const id = await createZone({ slaHours: 4 });
      const inside = await file(c0());
      expect(inside.eventZone).toEqual({ id, name: expect.stringMatching(/^Mela/) });
      const [row] = await ctx.ds.query(
        `SELECT supervisor_id, event_zone_id, round(extract(epoch FROM sla_due_at - created_at) / 3600) AS sla FROM complaints WHERE id = $1`,
        [inside.id],
      );
      expect(row).toEqual({ supervisor_id: zoneSupervisor.id, event_zone_id: id, sla: String(Math.min(4, typeSla)) });

      const outside = await file({ lat: c0().lat + 0.004, lng: c0().lng + 0.004 }); // same ward, outside the zone
      const [o] = await ctx.ds.query(`SELECT supervisor_id, event_zone_id FROM complaints WHERE id = $1`, [outside.id]);
      expect(o).toEqual({ supervisor_id: areaSupervisor.id, event_zone_id: null });

      // The zone supervisor gets it (inbox + alert). The area supervisor keeps read access for
      // oversight (area scope) but is not alerted.
      const zs = await tokenFor(ctx, zoneSupervisor);
      expect((await ctx.http().get(api('/complaints')).set(bearer(zs)).query({ eventZoneId: id })).body.items.map((c: { id: string }) => c.id)).toEqual([inside.id]);
      const alerted = await ctx.ds.query(`SELECT user_id FROM notifications WHERE complaint_id = $1 AND type = 'COMPLAINT_NEW'`, [inside.id]);
      expect(alerted).toEqual([{ user_id: zoneSupervisor.id }]);

      // Event dashboard: reports filtered to the zone.
      const summary = (await ctx.http().get(api('/reports/summary')).set(bearer(subAdmin)).query({ eventZoneId: id }).expect(200)).body;
      expect(summary.counts.received).toBe(1);
      const detail = (await ctx.http().get(api(`/event-zones/${id}`)).set(bearer(subAdmin)).expect(200)).body;
      expect(detail.stats).toEqual(expect.objectContaining({ total: 1, open: 1 }));
      expect(detail.current).toBe(true);
      await cancel(id);
    });

    it('a zone that has not started yet does not capture complaints', async () => {
      const id = await createZone({ startsAt: iso(24 * H), endsAt: iso(48 * H) });
      const c = await file(c0());
      expect(c.eventZone).toBeNull();
      await cancel(id);
    });
  });

  describe('handover when a zone ends or is cancelled', () => {
    it('hands open complaints back to the area supervisor with a timeline entry and a notification; closed work is untouched', async () => {
      const id = await createZone();
      const open = await file(c0());
      const done = await file(c0());
      await ctx.http().post(api(`/complaints/${done.id}/resolve`)).set(bearer(await tokenFor(ctx, zoneSupervisor))).send({ remark: 'Cleaned the spot' }).expect(201);

      await ctx.ds.query(`UPDATE event_zones SET ends_at = now() - interval '1 minute', starts_at = now() - interval '2 days' WHERE id = $1`, [id]);
      expect(await zones.handover()).toBeGreaterThanOrEqual(1);
      const rows = await ctx.ds.query(`SELECT id, supervisor_id FROM complaints WHERE id = ANY($1)`, [[open.id, done.id]]);
      const by = Object.fromEntries(rows.map((r: { id: string; supervisor_id: string }) => [r.id, r.supervisor_id]));
      expect(by[open.id]).toBe(areaSupervisor.id);
      expect(by[done.id]).toBe(zoneSupervisor.id);
      const events = await ctx.ds.query(`SELECT action FROM complaint_events WHERE complaint_id = $1 ORDER BY id`, [open.id]);
      expect(events.map((e: { action: string }) => e.action)).toContain('HANDOVER');
      const notes = await ctx.ds.query(`SELECT type FROM notifications WHERE user_id = $1 AND complaint_id = $2`, [areaSupervisor.id, open.id]);
      expect(notes).toEqual([{ type: 'COMPLAINT_HANDED_OVER' }]);
      const [z] = await ctx.ds.query(`SELECT handed_over_at FROM event_zones WHERE id = $1`, [id]);
      expect(z.handed_over_at).not.toBeNull();
      expect(await zones.handover()).toBe(0); // idempotent
    });

    it('cancelling a running zone triggers the same handover', async () => {
      const id = await createZone();
      const c = await file(c0());
      await cancel(id);
      await zones.handover();
      const [row] = await ctx.ds.query(`SELECT supervisor_id FROM complaints WHERE id = $1`, [c.id]);
      expect(row.supervisor_id).toBe(areaSupervisor.id);
    });
  });

  describe('temporary staff', () => {
    it('a temporary worker loses sign-in, open sessions and refresh when access expires, and leaves the assignment list', async () => {
      const mobile = `7${String(Date.now()).slice(-9)}`;
      const created = (await ctx.http().post(api('/users')).set(bearer(subAdmin))
        .send({ role: 'WORKER', name: 'Mela Helper', mobile, accessExpiresAt: iso(2 * H) }).expect(201)).body;
      const worker: TestUser = { id: created.id, role: Role.WORKER, mobile, email: '', password: created.tempPassword };
      const session = await login(ctx, worker);
      const listed = (await ctx.http().get(api('/users')).set(bearer(subAdmin))).body.find((u: { id: string }) => u.id === created.id);
      expect(listed.accessExpiresAt).toBeTruthy();
      const sup = await tokenFor(ctx, areaSupervisor);
      expect((await ctx.http().get(api('/users/workers')).set(bearer(sup))).body.map((w: { id: string }) => w.id)).toContain(created.id);

      await ctx.ds.query(`UPDATE users SET access_expires_at = now() - interval '1 second' WHERE id = $1`, [created.id]);
      await ctx.http().get(api('/auth/me')).set(bearer(session.accessToken)).expect(401);
      await ctx.http().post(api('/auth/refresh')).send({ refreshToken: session.refreshToken }).expect(401);
      await ctx.http().post(api('/auth/login')).send({ identifier: mobile, password: created.tempPassword }).expect(401);
      expect((await ctx.http().get(api('/users/workers')).set(bearer(sup))).body.map((w: { id: string }) => w.id)).not.toContain(created.id);
    });

    it('only supervisors and workers can be temporary, for at most a year, ending in the future', async () => {
      const send = (over: object) => ctx.http().post(api('/users')).set(bearer(subAdmin)).send({ role: 'WORKER', name: 'Temp', mobile: `6${String(Date.now()).slice(-9)}`, ...over });
      await send({ accessExpiresAt: iso(-H) }).expect(400);
      await send({ accessExpiresAt: iso(400 * 24 * H) }).expect(400);
      await send({ accessExpiresAt: 'tomorrow' }).expect(400);
    });
  });
});
