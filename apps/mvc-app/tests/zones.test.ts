import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GET as listRoute, POST as createRoute } from '@/app/api/v1/event-zones/route';
import { GET as getRoute, PATCH as patchRoute } from '@/app/api/v1/event-zones/[id]/route';
import { GET as complaintsRoute, POST as fileRoute } from '@/app/api/v1/complaints/route';
import { POST as resolveRoute } from '@/app/api/v1/complaints/[id]/resolve/route';
import { POST as createUserRoute } from '@/app/api/v1/users/route';
import { GET as workersRoute } from '@/app/api/v1/users/workers/route';
import { GET as meRoute } from '@/app/api/v1/auth/me/route';
import { POST as loginRoute } from '@/app/api/v1/auth/login/route';
import { POST as refreshRoute } from '@/app/api/v1/auth/refresh/route';
import { square } from '@/lib/geo';
import { newId } from '@/lib/ids';
import { ZoneService } from '@/services/ZoneService';
import { call, createJurisdiction, createUser, db, loginAs, one, query, run, setupTestEnvironment, type Jurisdiction, type TestUser } from './helpers';
import { makeDevice, makeJpeg, uploadMedia } from './media-helpers';

setupTestEnvironment();

const H = 3_600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

let j: Jurisdiction;
let other: Jurisdiction;
let sub: string;
let otherSub: string;
let areaSup: TestUser;
let zoneSup: TestUser;
let typeId: string;
let typeSla: number;

beforeAll(async () => {
  j = await createJurisdiction();
  other = await createJurisdiction();
  sub = await loginAs(await createUser('SUB_ADMIN', j));
  otherSub = await loginAs(await createUser('SUB_ADMIN', other));
  areaSup = await createUser('SUPERVISOR', j);
  zoneSup = await createUser('SUPERVISOR', j);
  await run(db(), `UPDATE areas SET supervisor_id = ? WHERE id = ?`, [areaSup.id, j.areaId]);
  const t = (await one(db(), `SELECT id, sla_hours FROM complaint_types WHERE active ORDER BY sort_order LIMIT 1`))!;
  typeId = t.id;
  typeSla = t.sla_hours;
});

const c0 = () => j.wards[0].center;
/** A 0.004 degree square (about 440 m) around the centre of ward 1. */
const boundary = (dLat = 0, dLng = 0) => square(c0().lat - 0.002 + dLat, c0().lng - 0.002 + dLng, 0.004);
const zoneBody = (over: Record<string, unknown> = {}) => ({
  ulbId: j.ulbId, name: `Mela ${newId().slice(0, 5)}`, boundary: boundary(), startsAt: iso(-H), endsAt: iso(48 * H), supervisorId: zoneSup.id, slaHours: 4, ...over,
});
const post = (token: string, body: unknown) => call(createRoute, 'POST', '/x', { token, body });
const make = async (over: Record<string, unknown> = {}) => {
  const r = await post(sub, zoneBody(over));
  if (r.status !== 201) throw new Error(`zone not created: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id as string;
};
const patch = (token: string, id: string, body: unknown) => call(patchRoute, 'PATCH', '/x', { token, params: { id }, body });
const cancel = (id: string) => patch(sub, id, { active: false });
// a failed test must not leave an active zone behind: it would block the next one as an overlap
const clearZones = () => run(db(), `UPDATE event_zones SET active = 0, handed_over_at = COALESCE(handed_over_at, NOW(3)) WHERE ulb_id = ? AND active`, [j.ulbId]);

afterEach(clearZones);

async function file(at: { lat: number; lng: number }) {
  const u = await createUser('CITIZEN', j);
  const token = await loginAs(u);
  const device = await makeDevice(token);
  const up = await uploadMedia(token, device, await makeJpeg(64, 48), { lat: at.lat, lng: at.lng });
  const res = await call(fileRoute, 'POST', '/x', { token, body: { typeId, ...at, description: 'Garbage near the mela gate', mediaIds: [up.mediaId] } });
  expect(res.status).toBe(201);
  return res.body;
}

describe('creating a zone', () => {
  it('stores it and shows its shape, size, window and supervisor', async () => {
    const id = await make({ name: 'Navratri Mela' });
    const z = (await call(getRoute, 'GET', '/x', { token: sub, params: { id } })).body;
    expect(z).toEqual(expect.objectContaining({ id, ulbId: j.ulbId, name: 'Navratri Mela', active: true, current: true, slaHours: 4, supervisorId: zoneSup.id, handedOverAt: null }));
    expect(z.boundary.type).toBe('Polygon');
    expect(z.areaM2).toBeGreaterThan(150_000);
    expect(z.areaM2).toBeLessThan(250_000); // about 0.004 x 0.004 degrees
    expect(z.stats).toEqual({ total: 0, open: 0, overdue: 0, avgDisposalHours: null });
    expect(await one(db(), `SELECT 1 AS x FROM audit_logs WHERE action = 'EVENT_ZONE_CREATED' AND entity_id = ?`, [id])).toBeTruthy();
    await clearZones();
  });

  it.each([
    ['an invalid (self-intersecting) polygon', () => ({ boundary: { type: 'Polygon', coordinates: [[[80, 25], [80.01, 25.01], [80.01, 25], [80, 25.01], [80, 25]]] } }), /not valid/],
    ['a zone outside the ULB', () => ({ boundary: square(30, 90, 0.004) }), /overlap the wards/],
    ['a zone larger than 100 km²', () => ({ boundary: square(c0().lat - 0.1, c0().lng - 0.1, 0.2) }), /100 km/],
    ['an event longer than 92 days', () => ({ endsAt: iso(100 * 24 * H) }), /92 days/],
    ['an event that already ended', () => ({ startsAt: iso(-48 * H), endsAt: iso(-H) }), /future/],
    ['end before start', () => ({ startsAt: iso(5 * H), endsAt: iso(2 * H) }), /after startsAt/],
  ])('refuses %s', async (_name, over, message) => {
    const res = await post(sub, zoneBody(over()));
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.message)).toMatch(message);
    expect(await query(db(), `SELECT 1 FROM event_zones WHERE ulb_id = ? AND active`, [j.ulbId])).toHaveLength(0);
  });

  it('refuses malformed requests before touching the database', async () => {
    for (const [name, over] of [
      ['short name', { name: 'ab' }], ['long name', { name: 'x'.repeat(121) }], ['no dates', { startsAt: undefined }], ['text dates', { startsAt: 'tomorrow' }],
      ['a date without a time zone', { startsAt: '2026-12-01T10:00:00' }], ['SLA 0', { slaHours: 0 }], ['SLA 721', { slaHours: 721 }], ['SLA 1.5', { slaHours: 1.5 }],
      ['a point instead of a polygon', { boundary: { type: 'Point', coordinates: [80, 25] } }], ['unknown field', { active: false }], ['ULB not an id', { ulbId: 'x' }],
    ] as const) {
      expect((await post(sub, zoneBody(over))).status, name).toBe(400);
    }
  });

  it('refuses a supervisor from another ULB, a disabled one, or one whose temporary access ends before the zone', async () => {
    const foreign = await createUser('SUPERVISOR', other);
    expect((await post(sub, zoneBody({ supervisorId: foreign.id }))).status).toBe(400);
    const disabled = await createUser('SUPERVISOR', j, { status: 'DISABLED' });
    expect((await post(sub, zoneBody({ supervisorId: disabled.id }))).status).toBe(400);
    expect((await post(sub, zoneBody({ supervisorId: (await createUser('WORKER', j)).id }))).status).toBe(400);
    const temp = (await call(createUserRoute, 'POST', '/x', { token: sub, body: { role: 'SUPERVISOR', name: 'Mela Temp', mobile: `8${String(Date.now()).slice(-9)}`, accessExpiresAt: iso(24 * H) } })).body;
    const res = await post(sub, zoneBody({ supervisorId: temp.id }));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/access ends before/);
    expect((await post(sub, zoneBody({ supervisorId: temp.id, endsAt: iso(20 * H) }))).status).toBe(201); // access outlasts the zone
    await clearZones();
  });

  it('refuses two active zones over the same place at the same time, but not later dates or other places', async () => {
    const id = await make();
    const clash = await post(sub, zoneBody({ boundary: boundary(0.001, 0.001) }));
    expect(clash.status).toBe(400);
    expect(clash.body.message).toMatch(/Overlaps/);
    const later = await make({ boundary: boundary(0.001, 0.001), startsAt: iso(72 * H), endsAt: iso(96 * H) });
    const elsewhere = await make({ boundary: square(c0().lat + 0.004, c0().lng + 0.006, 0.003) });
    expect((await cancel(later)).status).toBe(200);
    await cancel(elsewhere);
    // a cancelled zone no longer blocks its place
    await cancel(id);
    await make({ boundary: boundary(0.001, 0.001) });
    await clearZones();
  });

  it('simultaneous requests for the same place: exactly one wins', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => post(sub, zoneBody())));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(4);
    expect(await query(db(), `SELECT 1 FROM event_zones WHERE ulb_id = ? AND active`, [j.ulbId])).toHaveLength(1);
    await clearZones();
  });
});

describe('who can use zones', () => {
  it('only the managers of that ULB can create, edit and see it; supervisors see the zones they run; others have no access', async () => {
    const id = await make();
    const before = Number((await one(db(), `SELECT COUNT(*) AS n FROM event_zones WHERE ulb_id = ?`, [j.ulbId]))!.n);
    // A Sub Admin's zone always belongs to their own ULB whatever ulbId says, so a polygon in someone else's ULB is refused.
    const wrongPlace = await post(otherSub, zoneBody());
    expect(wrongPlace.status).toBe(400);
    expect(wrongPlace.body.message).toMatch(/overlap the wards/);
    expect(Number((await one(db(), `SELECT COUNT(*) AS n FROM event_zones WHERE ulb_id = ?`, [j.ulbId]))!.n)).toBe(before);

    expect((await patch(otherSub, id, { name: 'Hijacked' })).status).toBe(403);
    expect((await call(getRoute, 'GET', '/x', { token: otherSub, params: { id } })).status).toBe(404);
    expect((await call(listRoute, 'GET', '/x', { token: otherSub })).body.map((z: { id: string }) => z.id)).not.toContain(id);
    expect((await call(getRoute, 'GET', '/x', { token: await loginAs(zoneSup), params: { id } })).status).toBe(200);
    expect((await call(getRoute, 'GET', '/x', { token: await loginAs(areaSup), params: { id } })).status).toBe(404);
    const worker = await loginAs(await createUser('WORKER', j));
    const citizen = await loginAs(await createUser('CITIZEN', j));
    for (const t of [worker, citizen]) {
      expect((await call(listRoute, 'GET', '/x', { token: t })).status).toBe(403);
      expect((await post(t, zoneBody())).status).toBe(403);
    }
    expect((await post(await loginAs(zoneSup), zoneBody())).status).toBe(403);
    expect((await patch(await loginAs(zoneSup), id, { name: 'Mine now' })).status).toBe(403);
    expect((await call(listRoute, 'GET', '/x')).status).toBe(401);
    expect((await call(getRoute, 'GET', '/x', { token: sub, params: { id: 'nope' } })).status).toBe(404);
    expect((await call(getRoute, 'GET', '/x', { token: sub, params: { id: newId() } })).status).toBe(404);
    expect((await one(db(), `SELECT name FROM event_zones WHERE id = ?`, [id]))!.name).not.toMatch(/Hijacked|Mine now/);
    await clearZones();
  });

  it('lists with filters: current, upcoming, past, by ULB; a district admin sees the whole district', async () => {
    const live = await make();
    const soon = await make({ boundary: square(c0().lat + 0.004, c0().lng + 0.006, 0.003), startsAt: iso(24 * H), endsAt: iso(48 * H) });
    const ids = async (when: string) => (await call(listRoute, 'GET', '/x', { token: sub, query: { when } })).body.map((z: { id: string }) => z.id);
    expect(await ids('current')).toContain(live);
    expect(await ids('current')).not.toContain(soon);
    expect(await ids('upcoming')).toEqual([soon]);
    await cancel(live);
    expect(await ids('past')).toContain(live);
    expect(await ids('all')).toEqual(expect.arrayContaining([live, soon]));
    expect((await call(listRoute, 'GET', '/x', { token: sub, query: { when: 'sometime' } })).status).toBe(400);
    const dist = await loginAs(await createUser('DISTRICT_ADMIN', j));
    expect((await call(listRoute, 'GET', '/x', { token: dist })).body.map((z: { id: string }) => z.id)).toContain(soon);
    await clearZones();
  });
});

describe('editing and cancelling', () => {
  it('changes name, shape, dates, supervisor and deadline; validates the result again; clears supervisor and deadline with null', async () => {
    const id = await make();
    expect((await patch(sub, id, { name: 'Renamed Mela', slaHours: 6, endsAt: iso(60 * H) })).status).toBe(200);
    let z = (await call(getRoute, 'GET', '/x', { token: sub, params: { id } })).body;
    expect(z).toEqual(expect.objectContaining({ name: 'Renamed Mela', slaHours: 6 }));
    expect((await patch(sub, id, { supervisorId: null, slaHours: null })).status).toBe(200);
    z = (await call(getRoute, 'GET', '/x', { token: sub, params: { id } })).body;
    expect(z).toEqual(expect.objectContaining({ supervisorId: null, slaHours: null }));
    expect((await patch(sub, id, { endsAt: iso(100 * 24 * H) })).status).toBe(400);
    expect((await patch(sub, id, { boundary: square(30, 90, 0.004) })).status).toBe(400);
    expect((await patch(sub, id, { supervisorId: (await createUser('SUPERVISOR', other)).id })).status).toBe(400);
    expect((await patch(sub, id, { slaHours: 0 })).status).toBe(400);
    expect((await patch(sub, id, { ulbId: other.ulbId })).status).toBe(400);
    expect((await patch(sub, newId(), { name: 'Ghost zone' })).status).toBe(404);
    expect((await patch(sub, id, { boundary: boundary(0.0005, 0) })).status).toBe(200); // still valid and inside the ULB
    expect(await one(db(), `SELECT 1 AS x FROM audit_logs WHERE action = 'EVENT_ZONE_UPDATED' AND entity_id = ?`, [id])).toBeTruthy();
    await clearZones();
  });

  it('cannot be moved onto another active zone, and cancelling is audited', async () => {
    const a = await make();
    const b = await make({ boundary: square(c0().lat + 0.004, c0().lng + 0.006, 0.003) });
    expect((await patch(sub, b, { boundary: boundary(0.001, 0.001) })).status).toBe(400);
    expect((await cancel(a)).status).toBe(200);
    expect((await patch(sub, b, { boundary: boundary(0.001, 0.001) })).status).toBe(200); // now free
    expect((await cancel(b)).status).toBe(200);
    expect(await one(db(), `SELECT 1 AS x FROM audit_logs WHERE action = 'EVENT_ZONE_CANCELLED' AND entity_id = ?`, [a])).toBeTruthy();
    // a cancelled zone can be switched back on only if it does not clash
    const c = await make();
    expect((await patch(sub, a, { active: true })).status).toBe(400);
    await cancel(c);
    expect((await patch(sub, a, { active: true })).status).toBe(200);
    await clearZones();
  });
});

describe('routing, deadline and dashboard', () => {
  it('a complaint inside an active zone goes to the zone supervisor with the tighter deadline; outside it, to the area supervisor', async () => {
    const id = await make({ slaHours: 4 });
    const inside = await file(c0());
    expect(inside.eventZone).toEqual({ id, name: expect.stringMatching(/^Mela/) });
    const row = (await one(db(), `SELECT supervisor_id, event_zone_id, ROUND(TIMESTAMPDIFF(SECOND, created_at, sla_due_at) / 3600) AS sla FROM complaints WHERE id = ?`, [inside.id]))!;
    expect(row).toEqual({ supervisor_id: zoneSup.id, event_zone_id: id, sla: Math.min(4, typeSla) });

    const outside = await file({ lat: c0().lat + 0.004, lng: c0().lng + 0.004 }); // same ward, outside the zone
    expect(await one(db(), `SELECT supervisor_id, event_zone_id FROM complaints WHERE id = ?`, [outside.id])).toEqual({ supervisor_id: areaSup.id, event_zone_id: null });

    // the zone supervisor gets it (inbox and alert); the area supervisor keeps read access but is not alerted
    const zs = await loginAs(zoneSup);
    expect((await call(complaintsRoute, 'GET', '/x', { token: zs, query: { eventZoneId: id } })).body.items.map((c: { id: string }) => c.id)).toEqual([inside.id]);
    expect(await query(db(), `SELECT user_id FROM notifications WHERE complaint_id = ? AND type = 'COMPLAINT_NEW'`, [inside.id])).toEqual([{ user_id: zoneSup.id }]);

    const detail = (await call(getRoute, 'GET', '/x', { token: sub, params: { id } })).body;
    expect(detail.stats).toEqual(expect.objectContaining({ total: 1, open: 1, overdue: 0 }));
    expect(detail.current).toBe(true);
    await cancel(id);
  });

  it('a zone that has not started yet does not capture complaints', async () => {
    const id = await make({ startsAt: iso(24 * H), endsAt: iso(48 * H) });
    expect((await file(c0())).eventZone).toBeNull();
    await cancel(id);
  });
});

describe('handover when a zone ends or is cancelled', () => {
  it('hands open complaints back to the area supervisor with a timeline entry and a message; finished work is untouched', async () => {
    const id = await make();
    const open = await file(c0());
    const done = await file(c0());
    const zsToken = await loginAs(zoneSup);
    expect((await call(resolveRoute, 'POST', '/x', { token: zsToken, params: { id: done.id }, body: { remark: 'Cleaned the spot' } })).status).toBe(201);

    await run(db(), `UPDATE event_zones SET ends_at = DATE_SUB(NOW(3), INTERVAL 1 MINUTE), starts_at = DATE_SUB(NOW(3), INTERVAL 2 DAY) WHERE id = ?`, [id]);
    expect(await ZoneService.handover()).toBeGreaterThanOrEqual(1);
    const rows = await query<{ id: string; supervisor_id: string }>(db(), `SELECT id, supervisor_id FROM complaints WHERE id IN (?)`, [[open.id, done.id]]);
    const by = Object.fromEntries(rows.map((r) => [r.id, r.supervisor_id]));
    expect(by[open.id]).toBe(areaSup.id);
    expect(by[done.id]).toBe(zoneSup.id);
    const events = await query<{ action: string; meta: { eventZoneId: string; from: string; to: string } }>(db(), `SELECT action, meta FROM complaint_events WHERE complaint_id = ? ORDER BY id`, [open.id]);
    expect(events.map((e) => e.action)).toContain('HANDOVER');
    expect(events.find((e) => e.action === 'HANDOVER')!.meta).toEqual({ eventZoneId: id, from: zoneSup.id, to: areaSup.id });
    expect(await query(db(), `SELECT type FROM notifications WHERE user_id = ? AND complaint_id = ?`, [areaSup.id, open.id])).toEqual([{ type: 'COMPLAINT_HANDED_OVER' }]);
    expect((await one(db(), `SELECT handed_over_at FROM event_zones WHERE id = ?`, [id]))!.handed_over_at).toBeTruthy();
    expect(await ZoneService.handover()).toBe(0); // idempotent
  });

  it('cancelling a running zone triggers the same handover', async () => {
    const id = await make();
    const c = await file(c0());
    await cancel(id);
    await ZoneService.handover();
    expect((await one(db(), `SELECT supervisor_id FROM complaints WHERE id = ?`, [c.id]))!.supervisor_id).toBe(areaSup.id);
  });

  it('with nobody running the area, the Sub Admins are told instead', async () => {
    const lonely = await createJurisdiction(); // its area has no supervisor
    const subAdmin = await createUser('SUB_ADMIN', lonely);
    const zs = await createUser('SUPERVISOR', lonely);
    const adminToken = await loginAs(subAdmin);
    const lc = lonely.wards[0].center;
    const created = await call(createRoute, 'POST', '/x', { token: adminToken, body: { ulbId: lonely.ulbId, name: 'Lonely Mela', boundary: square(lc.lat - 0.002, lc.lng - 0.002, 0.004), startsAt: iso(-H), endsAt: iso(48 * H), supervisorId: zs.id } });
    expect(created.status).toBe(201);
    const u = await createUser('CITIZEN', lonely);
    const token = await loginAs(u);
    const up = await uploadMedia(token, await makeDevice(token), await makeJpeg(64, 48), { lat: lc.lat, lng: lc.lng });
    const filed = await call(fileRoute, 'POST', '/x', { token, body: { typeId, lat: lc.lat, lng: lc.lng, description: 'Garbage near the mela gate', mediaIds: [up.mediaId] } });
    expect(filed.body.supervisor.id).toBe(zs.id);
    await call(patchRoute, 'PATCH', '/x', { token: adminToken, params: { id: created.body.id }, body: { active: false } });
    await ZoneService.handover();
    expect((await one(db(), `SELECT supervisor_id FROM complaints WHERE id = ?`, [filed.body.id]))!.supervisor_id).toBeNull();
    expect((await query<{ type: string }>(db(), `SELECT type FROM notifications WHERE user_id = ? AND complaint_id = ?`, [subAdmin.id, filed.body.id])).map((r) => r.type)).toContain('COMPLAINT_HANDED_OVER');
  });

  it('extending a zone into the future after handover means it will be handed over again at its new end', async () => {
    const id = await make();
    await cancel(id);
    await ZoneService.handover();
    expect((await one(db(), `SELECT handed_over_at FROM event_zones WHERE id = ?`, [id]))!.handed_over_at).toBeTruthy();
    expect((await patch(sub, id, { active: true, endsAt: iso(72 * H) })).status).toBe(200);
    expect((await one(db(), `SELECT handed_over_at FROM event_zones WHERE id = ?`, [id]))!.handed_over_at).toBeNull();
    await clearZones();
  });
});

describe('temporary staff', () => {
  it('a temporary worker loses sign-in, sessions and refresh when access expires, and leaves the assignment list', async () => {
    const mobile = `7${String(Date.now()).slice(-9)}`;
    const created = (await call(createUserRoute, 'POST', '/x', { token: sub, body: { role: 'WORKER', name: 'Mela Helper', mobile, accessExpiresAt: iso(2 * H) } })).body;
    const session = (await call(loginRoute, 'POST', '/x', { body: { identifier: mobile, password: created.tempPassword } })).body;
    expect((await call(meRoute, 'GET', '/x', { token: session.accessToken })).status).toBe(200);
    const sup = await loginAs(areaSup);
    expect((await call(workersRoute, 'GET', '/x', { token: sup })).body.map((w: { id: string }) => w.id)).toContain(created.id);

    await run(db(), `UPDATE users SET access_expires_at = DATE_SUB(NOW(3), INTERVAL 1 SECOND) WHERE id = ?`, [created.id]);
    expect((await call(meRoute, 'GET', '/x', { token: session.accessToken })).status).toBe(401);
    expect((await call(refreshRoute, 'POST', '/x', { body: { refreshToken: session.refreshToken } })).status).toBe(401);
    expect((await call(loginRoute, 'POST', '/x', { body: { identifier: mobile, password: created.tempPassword } })).status).toBe(401);
    expect((await call(workersRoute, 'GET', '/x', { token: sup })).body.map((w: { id: string }) => w.id)).not.toContain(created.id);
  });
});
