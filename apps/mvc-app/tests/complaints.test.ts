import { beforeAll, describe, expect, it } from 'vitest';
import { GET as listRoute, POST as createRoute } from '@/app/api/v1/complaints/route';
import { GET as getRoute } from '@/app/api/v1/complaints/[id]/route';
import { GET as trackRoute } from '@/app/api/v1/complaints/track/[complaintNo]/route';
import { GET as mediaRoute } from '@/app/api/v1/complaints/[id]/media/route';
import { GET as candidatesRoute } from '@/app/api/v1/complaints/[id]/duplicate-candidates/route';
import { POST as assignRoute } from '@/app/api/v1/complaints/[id]/assign/route';
import { POST as startRoute } from '@/app/api/v1/complaints/[id]/start/route';
import { POST as resolveRoute } from '@/app/api/v1/complaints/[id]/resolve/route';
import { POST as rejectRoute } from '@/app/api/v1/complaints/[id]/reject/route';
import { POST as duplicateRoute } from '@/app/api/v1/complaints/[id]/duplicate/route';
import { POST as feedbackRoute } from '@/app/api/v1/complaints/[id]/feedback/route';
import { square } from '@/lib/geo';
import { newId } from '@/lib/ids';
import { ComplaintService } from '@/services/ComplaintService';
import { call, createJurisdiction, createUser, db, loginAs, one, query, run, setupTestEnvironment, type Jurisdiction, type TestUser } from './helpers';
import { makeDevice, makeJpeg, uploadMedia, type TestDevice } from './media-helpers';

setupTestEnvironment();

interface Actor { u: TestUser; token: string }
interface Citizen extends Actor { device: TestDevice }
interface World {
  j: Jurisdiction;
  sub: Actor; dist: Actor; sup: Actor; sup2: Actor; worker: Actor; worker2: Actor;
}

let typeId: string;
let typeSla: number;
let web: Actor;

const actor = async (role: Parameters<typeof createUser>[0], j?: Jurisdiction): Promise<Actor> => {
  const u = await createUser(role, j);
  return { u, token: await loginAs(u) };
};
const citizenIn = async (j: Jurisdiction): Promise<Citizen> => {
  const a = await actor('CITIZEN', j);
  return { ...a, device: await makeDevice(a.token) };
};
const staffDevice = async (a: Actor) => makeDevice(a.token);

/** A jurisdiction whose ward 1 is covered by an area with a real supervisor. */
async function world(): Promise<World> {
  const j = await createJurisdiction();
  const w: World = {
    j, sub: await actor('SUB_ADMIN', j), dist: await actor('DISTRICT_ADMIN', j), sup: await actor('SUPERVISOR', j),
    sup2: await actor('SUPERVISOR', j), worker: await actor('WORKER', j), worker2: await actor('WORKER', j),
  };
  await run(db(), `UPDATE areas SET supervisor_id = ? WHERE id = ?`, [w.sup.u.id, j.areaId]);
  return w;
}

async function photo(owner: { token: string; device: TestDevice }, at: { lat: number; lng: number }, capturedAt?: Date) {
  const r = await uploadMedia(owner.token, owner.device, await makeJpeg(64, 48), { lat: at.lat, lng: at.lng, capturedAt });
  if (r.confirm?.status !== 200) throw new Error(`photo upload failed: ${JSON.stringify(r.confirm?.body)}`);
  return r.mediaId;
}

async function file(c: Citizen, j: Jurisdiction, over: Record<string, unknown> = {}, ward = 0) {
  const at = j.wards[ward].center;
  return call(createRoute, 'POST', '/api/v1/complaints', {
    token: c.token,
    body: { typeId, lat: at.lat, lng: at.lng, description: 'Garbage heap near the school gate', mediaIds: [await photo(c, at)], ...over },
  });
}
const filed = async (c: Citizen, j: Jurisdiction, over: Record<string, unknown> = {}, ward = 0) => {
  const r = await file(c, j, over, ward);
  if (r.status !== 201) throw new Error(`could not file a complaint: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { id: string; complaintNo: string; status: string; supervisor: { id: string } | null };
};
const act = (route: typeof assignRoute, who: Actor, id: string, body: unknown = {}) => call(route, 'POST', `/api/v1/complaints/${id}/x`, { token: who.token, params: { id }, body });
const view = (who: Actor, id: string) => call(getRoute, 'GET', `/api/v1/complaints/${id}`, { token: who.token, params: { id } });
const rowOf = (id: string) => one(db(), `SELECT * FROM complaints WHERE id = ?`, [id]);
const noticesFor = async (userId: string, complaintId: string) =>
  (await query<{ type: string }>(db(), `SELECT type FROM notifications WHERE user_id = ? AND complaint_id = ? ORDER BY created_at, id`, [userId, complaintId])).map((r) => r.type);

beforeAll(async () => {
  const t = (await one(db(), `SELECT id, sla_hours FROM complaint_types WHERE active ORDER BY sort_order LIMIT 1`))!;
  typeId = t.id;
  typeSla = t.sla_hours;
  web = await actor('WEB_ADMIN');
});

describe('filing a complaint', () => {
  it('routes it to the area supervisor, numbers it, attaches the photo and tells both people', async () => {
    const w = await world();
    const c = await citizenIn(w.j);
    const r = await file(c, w.j, { landmark: '  Near the temple  ' });
    expect(r.status).toBe(201);
    const v = r.body;
    expect(v.status).toBe('ASSIGNED');
    expect(v.supervisor).toEqual({ id: w.sup.u.id, name: expect.any(String) });
    expect(v.wardSource).toBe('GPS');
    expect(v.wardMismatch).toBe(false);
    expect(v.landmark).toBe('Near the temple');
    expect(v.ward.id).toBe(w.j.wards[0].id);
    expect(v.areaId).toBe(w.j.areaId);
    expect(v.location.lat).toBeCloseTo(w.j.wards[0].center.lat, 6);
    expect(v.location.lng).toBeCloseTo(w.j.wards[0].center.lng, 6);
    expect(v.complaintNo).toMatch(/^\d{4}-\d{6}-\d{2}-\d{6}$/);
    const plain = v.complaintNo.replaceAll('-', '');
    const yearIst = new Date(Date.now() + 5.5 * 3_600_000).getUTCFullYear() % 100;
    expect(plain.slice(0, 4)).toBe(String(w.j.districtLgd).padStart(4, '0'));
    expect(plain.slice(4, 10)).toBe(String(w.j.ulbLgd).padStart(6, '0'));
    expect(Number(plain.slice(10, 12))).toBe(yearIst);
    expect(Number(plain.slice(12))).toBeGreaterThan(0);

    const hoursToDue = (new Date(v.slaDueAt).getTime() - Date.now()) / 3_600_000;
    expect(hoursToDue).toBeGreaterThan(typeSla - 0.1);
    expect(hoursToDue).toBeLessThanOrEqual(typeSla);

    const media = await query(db(), `SELECT stage, status FROM complaint_media WHERE complaint_id = ?`, [v.id]);
    expect(media).toEqual([{ stage: 'COMPLAINT', status: 'READY' }]);
    const events = await query(db(), `SELECT action, from_status, to_status FROM complaint_events WHERE complaint_id = ? ORDER BY id`, [v.id]);
    expect(events).toEqual([{ action: 'CREATE', from_status: null, to_status: 'PENDING' }, { action: 'ROUTE', from_status: 'PENDING', to_status: 'ASSIGNED' }]);
    expect(await noticesFor(c.u.id, v.id)).toEqual(['COMPLAINT_REGISTERED']);
    expect(await noticesFor(w.sup.u.id, v.id)).toEqual(['COMPLAINT_NEW']);
    expect(await noticesFor(w.sub.u.id, v.id)).toEqual([]);
  });

  it('waits in the Sub Admin queue when the ward has no supervisor', async () => {
    const w = await world();
    const c = await citizenIn(w.j);
    const v = await filed(c, w.j, {}, 1);
    expect(v.status).toBe('PENDING');
    expect(v.supervisor).toBeNull();
    expect(await noticesFor(w.sub.u.id, v.id)).toEqual(['COMPLAINT_NEW']);
    // a disabled or expired area supervisor does not count either
    await run(db(), `UPDATE users SET status = 'DISABLED' WHERE id = ?`, [w.sup.u.id]);
    expect((await filed(c, w.j)).status).toBe('PENDING');
  });

  it('files anywhere: a ward chosen by hand, in any ULB, is used and flagged when far from the GPS point', async () => {
    const home = await world();
    const away = await world();
    const c = await citizenIn(home.j);
    const gps = home.j.wards[0].center;
    // the citizen stands in ULB A but files for ULB B's ward (about thousands of km away): flagged
    const far = await file(c, home.j, { wardId: away.j.wards[0].id });
    expect(far.status).toBe(201);
    expect(far.body).toEqual(expect.objectContaining({ wardSource: 'MANUAL', wardMismatch: true }));
    expect(far.body.ulb.id).toBe(away.j.ulbId);
    expect(far.body.district.id).toBe(away.j.districtId);
    expect(far.body.supervisor.id).toBe(away.sup.u.id);
    expect(far.body.complaintNo.replaceAll('-', '').slice(4, 10)).toBe(String(away.j.ulbLgd).padStart(6, '0'));
    // a manual choice of the ward the point is inside, or one touching it, is not a mismatch
    const same = await file(c, home.j, { wardId: home.j.wards[0].id, lat: gps.lat, lng: gps.lng });
    expect(same.body.wardMismatch).toBe(false);
    const neighbour = await file(c, home.j, { wardId: home.j.wards[1].id, lat: gps.lat, lng: gps.lng + 0.004 }); // ~440 m from the neighbour's edge? it is 0.001 deg
    expect(neighbour.body.wardMismatch).toBe(false);
  });

  it('refuses a point outside every ward, an unknown or switched-off ward, and an unknown or switched-off type', async () => {
    const w = await world();
    const c = await citizenIn(w.j);
    const out = await file(c, w.j, { lat: 1.5, lng: 1.5 });
    expect(out.status).toBe(400);
    expect(out.body.message).toMatch(/choose District, ULB and Ward/);
    expect((await file(c, w.j, { wardId: newId() })).status).toBe(400);
    await run(db(), `UPDATE wards SET active = 0 WHERE id = ?`, [w.j.wards[1].id]);
    expect((await file(c, w.j, { wardId: w.j.wards[1].id })).status).toBe(400);
    expect((await file(c, w.j, { typeId: newId() })).status).toBe(400);
    await run(db(), `UPDATE complaint_types SET active = 0 WHERE id = ?`, [typeId]);
    try {
      expect((await file(c, w.j)).status).toBe(400);
    } finally {
      await run(db(), `UPDATE complaint_types SET active = 1 WHERE id = ?`, [typeId]);
    }
  });

  it('validates every field and ignores nothing it does not know', async () => {
    const w = await world();
    const c = await citizenIn(w.j);
    const at = w.j.wards[0].center;
    const good = async () => ({ typeId, lat: at.lat, lng: at.lng, description: 'Garbage heap near the school gate', mediaIds: [await photo(c, at)] });
    for (const [name, patch] of [
      ['short description', { description: 'abc' }],
      ['long description', { description: 'x'.repeat(251) }],
      ['long landmark', { landmark: 'y'.repeat(51) }],
      ['latitude 91', { lat: 91 }],
      ['longitude 181', { lng: 181 }],
      ['text coordinates', { lat: '21.2' }],
      ['accuracy over 10 km', { gpsAccuracyM: 10_001 }],
      ['no media', { mediaIds: [] }],
      ['seven media', { mediaIds: Array.from({ length: 7 }, () => newId()) }],
      ['repeated media', { mediaIds: [newId(), newId()].flatMap((x) => [x, x]) }],
      ['media that is not an id', { mediaIds: ['x'] }],
      ['role escalation field', { citizenId: newId() }],
      ['status field', { status: 'RESOLVED' }],
      ['ward as number', { wardId: 5 }],
    ] as const) {
      const r = await call(createRoute, 'POST', '/x', { token: c.token, body: { ...(await good()), ...patch } });
      expect(r.status, name).toBe(400);
    }
    expect(await query(db(), `SELECT 1 FROM complaints WHERE citizen_id = ?`, [c.u.id])).toHaveLength(0);
  });

  it('only a citizen with an accepted privacy notice may file', async () => {
    const w = await world();
    const c = await citizenIn(w.j);
    const body = { typeId, lat: 1, lng: 1, description: 'Garbage heap near the school gate', mediaIds: [newId()] };
    for (const who of [w.sub, w.sup, w.worker, w.dist, web]) expect((await call(createRoute, 'POST', '/x', { token: who.token, body })).status, who.u.role).toBe(403);
    expect((await call(createRoute, 'POST', '/x', { body })).status).toBe(401);
    const pending = await createUser('CITIZEN', w.j, { consent: false });
    expect((await call(createRoute, 'POST', '/x', { token: await loginAs(pending), body })).status).toBe(403);
    void c;
  });

  it('uses only your own, verified, unused photos', async () => {
    const w = await world();
    const a = await citizenIn(w.j);
    const b = await citizenIn(w.j);
    const at = w.j.wards[0].center;
    const theirs = await photo(b, at);
    expect((await file(a, w.j, { mediaIds: [theirs] })).status).toBe(400);
    const unfinished = await uploadMedia(a.token, a.device, await makeJpeg(64, 48), { skipConfirm: true });
    expect((await file(a, w.j, { mediaIds: [unfinished.mediaId] })).status).toBe(400);
    const rejected = await uploadMedia(a.token, a.device, await makeJpeg(64, 48), { mock: true });
    expect((await file(a, w.j, { mediaIds: [rejected.mediaId] })).status).toBe(400);
    const mine = await photo(a, at);
    const first = await file(a, w.j, { mediaIds: [mine] });
    expect(first.status).toBe(201);
    expect((await file(a, w.j, { mediaIds: [mine] })).status).toBe(400); // already used
    expect((await file(a, w.j, { mediaIds: [await photo(a, at), await photo(a, at), await photo(a, at), await photo(a, at), await photo(a, at), await photo(a, at)] })).status).toBe(400); // 6 photos > 5 per stage
  });

  it('allows ten a day, then asks the citizen to wait', async () => {
    const w = await world();
    const c = await citizenIn(w.j);
    for (let i = 0; i < 10; i++) await filed(c, w.j);
    const r = await file(c, w.j);
    expect(r.status).toBe(429);
    expect(r.body.message).toMatch(/Daily limit of 10/);
    await run(db(), `UPDATE complaints SET created_at = DATE_SUB(NOW(3), INTERVAL 25 HOUR) WHERE citizen_id = ?`, [c.u.id]);
    expect((await file(c, w.j)).status).toBe(201);
  });

  it('a failed filing leaves nothing behind and does not use up a number', async () => {
    const w = await world();
    const c = await citizenIn(w.j);
    const a = await filed(c, w.j);
    const seqOf = (no: string) => Number(no.replaceAll('-', '').slice(12));
    const before = await query(db(), `SELECT id FROM complaints WHERE ulb_id = ?`, [w.j.ulbId]);
    expect((await file(c, w.j, { mediaIds: [newId()] })).status).toBe(400); // media vanishes inside the transaction
    expect(await query(db(), `SELECT id FROM complaints WHERE ulb_id = ?`, [w.j.ulbId])).toHaveLength(before.length);
    const b = await filed(c, w.j);
    expect(seqOf(b.complaintNo)).toBe(seqOf(a.complaintNo) + 1); // no gap
  });

  it('numbers run one after another per ULB, and a crowd filing at once never gets a duplicate or a gap', async () => {
    const w = await world();
    const other = await world();
    const crowd: Citizen[] = [];
    for (let i = 0; i < 14; i++) crowd.push(await citizenIn(w.j));
    const prepared = await Promise.all(crowd.map(async (c) => ({ c, mediaIds: [await photo(c, w.j.wards[0].center)] })));
    const results = await Promise.all(
      prepared.map(({ c, mediaIds }) =>
        call(createRoute, 'POST', '/x', { token: c.token, body: { typeId, lat: w.j.wards[0].center.lat, lng: w.j.wards[0].center.lng, description: 'Garbage heap near the school gate', mediaIds } }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(Array(14).fill(201));
    const seqs = results.map((r) => Number(r.body.complaintNo.replaceAll('-', '').slice(12))).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(14);
    expect(seqs[13] - seqs[0]).toBe(13); // contiguous
    expect(seqs[0]).toBe(1);
    // another ULB has its own counter
    const o = await citizenIn(other.j);
    expect(Number((await filed(o, other.j)).complaintNo.replaceAll('-', '').slice(12))).toBe(1);
    // the number is unique across the whole system
    const dup = await query(db(), `SELECT complaint_no FROM complaints GROUP BY complaint_no HAVING COUNT(*) > 1`);
    expect(dup).toHaveLength(0);
  });

  it('inside an active event zone the zone\'s supervisor and tighter deadline apply; an ended or cancelled zone does not', async () => {
    const w = await world();
    const c = await citizenIn(w.j);
    const zoneSup = await createUser('SUPERVISOR', w.j);
    const at = w.j.wards[0].center;
    const zone = async (o: { active?: number; start?: string; end?: string; sup?: string | null; sla?: number | null }) => {
      const id = newId();
      await run(db(), `INSERT INTO event_zones (id, ulb_id, name, geom, starts_at, ends_at, supervisor_id, sla_hours, active, created_by) VALUES (?,?, 'Mela', ST_GeomFromGeoJSON(?, 1, 4326), ${o.start ?? 'DATE_SUB(NOW(3), INTERVAL 1 DAY)'}, ${o.end ?? 'DATE_ADD(NOW(3), INTERVAL 1 DAY)'}, ?, ?, ?, ?)`, [id, w.j.ulbId, JSON.stringify(square(at.lat - 0.002, at.lng - 0.002, 0.004)), o.sup === undefined ? zoneSup.id : o.sup, o.sla === undefined ? 2 : o.sla, o.active ?? 1, w.sub.u.id]);
      return id;
    };
    const live = await zone({});
    const v = await filed(c, w.j);
    expect(v.supervisor!.id).toBe(zoneSup.id);
    const full = await view(w.sub, v.id);
    expect(full.body.eventZone).toEqual({ id: live, name: 'Mela' });
    const hours = (new Date(full.body.slaDueAt).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(1.9);
    expect(hours).toBeLessThanOrEqual(2);

    const retire = () => run(db(), `UPDATE event_zones SET active = 0 WHERE ulb_id = ?`, [w.j.ulbId]); // complaints keep pointing at their zone, so zones are switched off, not deleted
    await retire();
    expect((await filed(c, w.j)).supervisor!.id).toBe(w.sup.u.id); // cancelled zone ignored
    await zone({ start: 'DATE_SUB(NOW(3), INTERVAL 3 DAY)', end: 'DATE_SUB(NOW(3), INTERVAL 1 DAY)' });
    expect((await filed(c, w.j)).supervisor!.id).toBe(w.sup.u.id); // ended zone ignored
    await retire();
    await zone({ sla: 720 });
    // a zone deadline can only tighten the type's SLA, never loosen it
    const loose = await filed(c, w.j);
    expect((new Date((await view(w.sub, loose.id)).body.slaDueAt).getTime() - Date.now()) / 3_600_000).toBeLessThanOrEqual(typeSla);
    await run(db(), `UPDATE users SET status = 'DISABLED' WHERE id = ?`, [zoneSup.id]);
    expect((await filed(c, w.j)).supervisor!.id).toBe(w.sup.u.id); // zone supervisor unavailable: area supervisor
  });
});

describe('who can see a complaint', () => {
  it('only the people responsible for it, and nobody from outside the jurisdiction (every route, every role)', async () => {
    const a = await world();
    const b = await world();
    const owner = await citizenIn(a.j);
    const stranger = await citizenIn(a.j);
    const c = await filed(owner, a.j);
    expect((await act(assignRoute, a.sup, c.id, { workerId: a.worker.u.id })).status).toBe(201);
    const outsiders: [string, Actor][] = [
      ['other citizen', stranger], ['supervisor of the same ULB, not responsible', a.sup2], ['unassigned worker', a.worker2],
      ['sub admin of another ULB', b.sub], ['district admin of another district', b.dist], ['supervisor elsewhere', b.sup], ['worker elsewhere', b.worker],
    ];
    const insiders: [string, Actor][] = [
      ['owner', owner], ['area supervisor', a.sup], ['assigned worker', a.worker], ['sub admin', a.sub], ['district admin', a.dist], ['web admin', web],
    ];
    const no = c.complaintNo;
    for (const [name, who] of insiders) {
      expect((await view(who, c.id)).status, `${name} sees it`).toBe(200);
      expect((await call(trackRoute, 'GET', '/x', { token: who.token, params: { complaintNo: no } })).status, `${name} tracks it`).toBe(200);
      expect((await call(mediaRoute, 'GET', '/x', { token: who.token, params: { id: c.id } })).status, `${name} sees the photos`).toBe(200);
      const list = await call(listRoute, 'GET', '/x', { token: who.token });
      expect(list.body.items.map((x: { id: string }) => x.id), `${name} lists it`).toContain(c.id);
    }
    for (const [name, who] of outsiders) {
      expect((await view(who, c.id)).status, `${name} cannot see it`).toBe(404);
      expect((await call(trackRoute, 'GET', '/x', { token: who.token, params: { complaintNo: no } })).status, `${name} cannot track it`).toBe(404);
      expect((await call(mediaRoute, 'GET', '/x', { token: who.token, params: { id: c.id } })).status, `${name} cannot see photos`).toBe(404);
      const list = await call(listRoute, 'GET', '/x', { token: who.token });
      expect(list.body.items.map((x: { id: string }) => x.id), `${name} does not list it`).not.toContain(c.id);
    }
    expect((await view({ token: '', u: owner.u }, c.id)).status).toBe(401);
  });

  it('every action is also closed to people who cannot see the complaint (404, never a hint it exists)', async () => {
    const a = await world();
    const b = await world();
    const owner = await citizenIn(a.j);
    const stranger = await citizenIn(a.j);
    const c = await filed(owner, a.j);
    const attempts: [string, typeof assignRoute, Actor, unknown][] = [
      ['assign', assignRoute, b.sub, { workerId: b.worker.u.id }],
      ['start', startRoute, b.worker, {}],
      ['resolve', resolveRoute, b.sup, { remark: 'Cleaned the place' }],
      ['reject', rejectRoute, b.sub, { reason: 'Not a real issue' }],
      ['duplicate', duplicateRoute, b.sup, { duplicateOfId: newId() }],
      ['feedback', feedbackRoute, stranger, { rating: 5 }],
    ];
    for (const [name, route, who, body] of attempts) expect((await act(route, who, c.id, body)).status, name).toBe(404);
    expect((await call(candidatesRoute, 'GET', '/x', { token: b.sub.token, params: { id: c.id } })).status).toBe(404);
    expect((await rowOf(c.id))!.status).toBe('ASSIGNED');
  });

  it('a supervisor keeps seeing complaints of the area they run, even after the Sub Admin hands one to someone else', async () => {
    const w = await world();
    const c = await filed(await citizenIn(w.j), w.j);
    expect((await act(assignRoute, w.sub, c.id, { supervisorId: w.sup2.u.id })).status).toBe(201);
    expect((await view(w.sup2, c.id)).status).toBe(200); // now responsible
    expect((await view(w.sup, c.id)).status).toBe(200); // still runs the area
  });

  it('shows no personal contact details in the complaint, and hides citizens\' names from the timeline', async () => {
    const w = await world();
    const owner = await citizenIn(w.j);
    const c = await filed(owner, w.j);
    await act(resolveRoute, w.sup, c.id, { remark: 'Cleaned the place' });
    const full = (await view(w.sub, c.id)).body;
    const text = JSON.stringify(full);
    expect(text).not.toContain(owner.u.mobile);
    expect(text).not.toContain(owner.u.email);
    expect(text).not.toMatch(/mobile|email|password|hash/i);
    const create = full.events.find((e: { action: string }) => e.action === 'CREATE');
    expect(create.actorRole).toBe('CITIZEN');
    expect(create.actorName).toBeNull();
    expect(full.events.find((e: { action: string }) => e.action === 'RESOLVE').actorName).toEqual(expect.any(String));
  });

  it('tracking accepts the dashed or plain number and nothing else', async () => {
    const w = await world();
    const owner = await citizenIn(w.j);
    const c = await filed(owner, w.j);
    const track = (no: string) => call(trackRoute, 'GET', '/x', { token: owner.token, params: { complaintNo: no } });
    expect((await track(c.complaintNo)).body.id).toBe(c.id);
    expect((await track(c.complaintNo.replaceAll('-', ''))).body.id).toBe(c.id);
    for (const bad of ['', '123', "x' OR 1=1 --", `${c.complaintNo}0`, c.complaintNo.replace('-', '/')]) expect((await track(bad)).status, bad).toBe(404);
  });
});

describe('the list', () => {
  it('filters, pages, orders newest first, and rejects values it cannot understand', async () => {
    const w = await world();
    const c = await citizenIn(w.j);
    const made: Awaited<ReturnType<typeof filed>>[] = [];
    for (let i = 0; i < 5; i++) made.push(await filed(c, w.j, {}, i === 4 ? 1 : 0));
    await run(db(), `UPDATE complaints SET created_at = DATE_SUB(NOW(3), INTERVAL ? HOUR) WHERE id = ?`, [5 - 0, made[0].id]);
    const ids = (r: { body: { items: { id: string }[] } }) => r.body.items.map((x) => x.id);
    const all = await call(listRoute, 'GET', '/x', { token: w.sub.token });
    expect(all.body.total).toBe(5);
    expect(ids(all)[ids(all).length - 1]).toBe(made[0].id); // oldest last
    expect(ids(await call(listRoute, 'GET', '/x', { token: w.sub.token, query: { pageSize: 2, page: 2 } }))).toHaveLength(2);
    expect((await call(listRoute, 'GET', '/x', { token: w.sub.token, query: { pageSize: 2, page: 3 } })).body.items).toHaveLength(1);
    expect((await call(listRoute, 'GET', '/x', { token: w.sub.token, query: { wardId: w.j.wards[1].id } })).body.total).toBe(1);
    expect((await call(listRoute, 'GET', '/x', { token: w.sub.token, query: { status: 'PENDING' } })).body.total).toBe(1);
    expect((await call(listRoute, 'GET', '/x', { token: w.sub.token, query: { status: 'ASSIGNED' } })).body.total).toBe(4);
    expect((await call(listRoute, 'GET', '/x', { token: w.sub.token, query: { typeId } })).body.total).toBe(5);
    expect((await call(listRoute, 'GET', '/x', { token: w.sub.token, query: { typeId: newId() } })).body.total).toBe(0);
    expect((await call(listRoute, 'GET', '/x', { token: w.sub.token, query: { from: new Date(Date.now() - 3_600_000).toISOString() } })).body.total).toBe(4);
    expect((await call(listRoute, 'GET', '/x', { token: w.sub.token, query: { to: new Date(Date.now() - 3_600_000).toISOString() } })).body.total).toBe(1);
    expect((await call(listRoute, 'GET', '/x', { token: w.sub.token, query: { open: 'true' } })).body.total).toBe(5);
    expect((await call(listRoute, 'GET', '/x', { token: w.sub.token, query: { overdue: 'true' } })).body.total).toBe(0);
    await run(db(), `UPDATE complaints SET sla_due_at = DATE_SUB(NOW(3), INTERVAL 1 HOUR), escalated = 1 WHERE id = ?`, [made[1].id]);
    expect((await call(listRoute, 'GET', '/x', { token: w.sub.token, query: { overdue: 'true' } })).body.total).toBe(1);
    expect((await call(listRoute, 'GET', '/x', { token: w.sub.token, query: { escalated: 'true' } })).body.total).toBe(1);
    expect((await call(listRoute, 'GET', '/x', { token: w.sub.token, query: { escalated: 'false' } })).body.total).toBe(4);
    for (const q of [{ status: 'DONE' }, { ulbId: 'x' }, { from: 'yesterday' }, { from: '2026-13-45' }, { pageSize: 101 }, { page: 0 }, { open: 'yes' }, { status: "PENDING' OR 1=1 --" }]) {
      expect((await call(listRoute, 'GET', '/x', { token: w.sub.token, query: q as unknown as Record<string, string | number> })).status, JSON.stringify(q)).toBe(400);
    }
    expect((await call(listRoute, 'GET', '/x', { token: w.sub.token, query: { from: '2026-01-01' } })).status).toBe(200); // a plain date is fine
    expect((await call(listRoute, 'GET', '/x')).status).toBe(401);
  });

  it('a citizen sees only their own; a district admin only their district; a worker only their tasks', async () => {
    const a = await world();
    const b = await world();
    const c1 = await citizenIn(a.j);
    const c2 = await citizenIn(a.j);
    const x = await filed(c1, a.j);
    const y = await filed(c2, a.j);
    const z = await filed(await citizenIn(b.j), b.j);
    const ids = async (who: Actor) => (await call(listRoute, 'GET', '/x', { token: who.token, query: { pageSize: 100 } })).body.items.map((i: { id: string }) => i.id);
    expect(await ids(c1)).toEqual([x.id]);
    expect(await ids(c2)).toEqual([y.id]);
    expect(await ids(a.dist)).toEqual(expect.arrayContaining([x.id, y.id]));
    expect(await ids(a.dist)).not.toContain(z.id);
    expect(await ids(a.worker)).toEqual([]);
    await act(assignRoute, a.sup, x.id, { workerId: a.worker.u.id });
    expect(await ids(a.worker)).toEqual([x.id]);
    expect(await ids(b.sup)).toEqual([z.id]);
  });
});

describe('the life of a complaint', () => {
  async function started(c: Citizen, w: World, ward = 0) {
    const v = await filed(c, w.j, {}, ward);
    return v;
  }

  it('citizen files, supervisor assigns, worker starts and resolves with proof, citizen rates: every step recorded and notified', async () => {
    const w = await world();
    const c = await citizenIn(w.j);
    const wd = await staffDevice(w.worker);
    const at = w.j.wards[0].center;
    const v = await started(c, w);

    const assigned = await act(assignRoute, w.sup, v.id, { workerId: w.worker.u.id, remark: 'Please go now' });
    expect(assigned.status).toBe(201);
    expect(assigned.body).toEqual(expect.objectContaining({ status: 'ASSIGNED', worker: { id: w.worker.u.id, name: expect.any(String) } }));
    expect(assigned.body.assignedAt).toBeTruthy();

    const startProof = await photo({ token: w.worker.token, device: wd }, at);
    const wip = await act(startRoute, w.worker, v.id, { mediaIds: [startProof], location: { lat: at.lat, lng: at.lng, accuracyM: 6 } });
    expect(wip.status).toBe(201);
    expect(wip.body.status).toBe('WORK_IN_PROGRESS');

    const endProof = await photo({ token: w.worker.token, device: wd }, at);
    const done = await act(resolveRoute, w.worker, v.id, { remark: 'Garbage removed and area swept', mediaIds: [endProof], location: { lat: at.lat, lng: at.lng } });
    expect(done.status).toBe(201);
    expect(done.body).toEqual(expect.objectContaining({ status: 'RESOLVED', resolutionRemark: 'Garbage removed and area swept' }));
    expect(done.body.resolvedAt).toBeTruthy();

    const media = await query(db(), `SELECT stage, kind FROM complaint_media WHERE complaint_id = ? ORDER BY stage`, [v.id]);
    expect(media.map((m) => m.stage).sort()).toEqual(['COMPLAINT', 'RESOLUTION', 'WORK_START']);
    const shown = await call(mediaRoute, 'GET', '/x', { token: c.token, params: { id: v.id } });
    expect(shown.body).toHaveLength(3);
    expect(shown.body.every((m: { url: string }) => /\/api\/v1\/media\/.+\/file\?v=main&exp=\d+&sig=[a-f0-9]{64}$/.test(m.url))).toBe(true);
    expect(shown.body[0].distanceM).toBeLessThanOrEqual(1);

    const rated = await act(feedbackRoute, c, v.id, { rating: 5, remark: 'Thank you' });
    expect(rated.status).toBe(201);
    expect(rated.body.status).toBe('CLOSED');
    expect(rated.body.closedAt).toBeTruthy();

    const full = (await view(w.sub, v.id)).body;
    expect(full.events.map((e: { action: string }) => e.action)).toEqual(['CREATE', 'ROUTE', 'ASSIGN', 'START', 'RESOLVE', 'CLOSE']);
    expect(full.events.map((e: { toStatus: string }) => e.toStatus)).toEqual(['PENDING', 'ASSIGNED', 'ASSIGNED', 'WORK_IN_PROGRESS', 'RESOLVED', 'CLOSED']);
    expect(full.feedback).toEqual([expect.objectContaining({ rating: 5, remark: 'Thank you', reopenRequested: false })]);
    expect(await noticesFor(c.u.id, v.id)).toEqual(['COMPLAINT_REGISTERED', 'COMPLAINT_ASSIGNED', 'WORK_STARTED', 'COMPLAINT_RESOLVED']);
    expect(await noticesFor(w.worker.u.id, v.id)).toEqual(['TASK_ASSIGNED']);
  });

  it('assigning checks the worker and the supervisor belong to this ULB and are active', async () => {
    const w = await world();
    const other = await world();
    const v = await started(await citizenIn(w.j), w);
    expect((await act(assignRoute, w.sup, v.id, {})).status).toBe(400);
    expect((await act(assignRoute, w.sup, v.id, { workerId: other.worker.u.id })).status).toBe(400); // another ULB
    expect((await act(assignRoute, w.sup, v.id, { workerId: w.sup2.u.id })).status).toBe(400); // not a worker
    expect((await act(assignRoute, w.sup, v.id, { workerId: newId() })).status).toBe(400);
    expect((await act(assignRoute, w.sup, v.id, { supervisorId: w.sup2.u.id })).status).toBe(400); // only a Sub Admin can
    expect((await act(assignRoute, w.sub, v.id, { supervisorId: w.worker.u.id })).status).toBe(400);
    expect((await act(assignRoute, w.sub, v.id, { supervisorId: other.sup.u.id })).status).toBe(400);
    await run(db(), `UPDATE users SET access_expires_at = DATE_SUB(NOW(3), INTERVAL 1 HOUR) WHERE id = ?`, [w.worker2.u.id]);
    expect((await act(assignRoute, w.sup, v.id, { workerId: w.worker2.u.id })).status).toBe(400); // expired temporary account
    for (const who of [w.worker, w.dist, web]) expect((await act(assignRoute, who, v.id, { workerId: w.worker.u.id })).status, who.u.role).toBe(403);
    await run(db(), `UPDATE complaints SET worker_id = NULL WHERE id = ?`, [v.id]);
    const spare = await actor('WORKER', w.j);
    await run(db(), `UPDATE users SET status = 'DISABLED' WHERE id = ?`, [spare.u.id]);
    expect((await act(assignRoute, w.sup, v.id, { workerId: spare.u.id })).status).toBe(400); // disabled
    expect((await act(assignRoute, w.sub, v.id, { supervisorId: w.sup2.u.id, workerId: w.worker2.u.id })).status).toBe(400); // worker2 is expired
    const ok = await act(assignRoute, w.sub, v.id, { supervisorId: w.sup2.u.id });
    expect(ok.status).toBe(201);
    expect(ok.body.supervisor.id).toBe(w.sup2.u.id);
    expect(await noticesFor(w.sup2.u.id, v.id)).toEqual(['COMPLAINT_NEW']);
  });

  it('a worker must show in-app proof to start and resolve; a supervisor may act by remark', async () => {
    const w = await world();
    const c = await citizenIn(w.j);
    const wd = await staffDevice(w.worker);
    const at = w.j.wards[0].center;
    const v = await started(c, w);
    await act(assignRoute, w.sup, v.id, { workerId: w.worker.u.id });
    expect((await act(startRoute, w.worker, v.id, {})).status).toBe(400); // no photo
    const old = await photo({ token: w.worker.token, device: wd }, at, new Date(Date.now() - 3 * 3_600_000)); // taken before the complaint was filed
    const early = await act(startRoute, w.worker, v.id, { mediaIds: [old] });
    expect(early.status).toBe(400);
    expect(early.body.message).toMatch(/after the complaint was filed/);
    const citizenPhoto = await photo(c, at);
    expect((await act(startRoute, w.worker, v.id, { mediaIds: [citizenPhoto] })).status).toBe(400); // somebody else's
    expect((await rowOf(v.id))!.status).toBe('ASSIGNED'); // nothing changed by the failures
    expect((await act(resolveRoute, w.worker, v.id, { remark: 'Cleaned', mediaIds: [await photo({ token: w.worker.token, device: wd }, at)] })).status).toBe(409); // must start first
    const good = await photo({ token: w.worker.token, device: wd }, at);
    expect((await act(startRoute, w.worker, v.id, { mediaIds: [good] })).status).toBe(201);
    expect((await act(resolveRoute, w.worker, v.id, { remark: 'Cleaned the spot' })).status).toBe(400); // no photo
    expect((await act(resolveRoute, w.worker, v.id, { remark: 'ok', mediaIds: [await photo({ token: w.worker.token, device: wd }, at)] })).status).toBe(400); // remark too short

    const v2 = await started(c, w);
    expect((await act(resolveRoute, w.sup, v2.id, { remark: 'Resolved by the supervisor on site' })).status).toBe(201); // supervisor: no photo, from ASSIGNED
    expect((await rowOf(v2.id))!.status).toBe('RESOLVED');
  });

  it('records how far from the complaint the proof and the resolver were, and flags what is outside 100 m', async () => {
    const w = await world();
    const c = await citizenIn(w.j);
    const wd = await staffDevice(w.worker);
    const at = w.j.wards[0].center;
    const v = await started(c, w);
    await act(assignRoute, w.sup, v.id, { workerId: w.worker.u.id });
    const near = await photo({ token: w.worker.token, device: wd }, { lat: at.lat + 0.0003, lng: at.lng }); // ~33 m
    expect((await act(startRoute, w.worker, v.id, { mediaIds: [near], location: { lat: at.lat + 0.0003, lng: at.lng } })).status).toBe(201);
    const far = await photo({ token: w.worker.token, device: wd }, { lat: at.lat + 0.002, lng: at.lng }); // ~222 m
    expect((await act(resolveRoute, w.worker, v.id, { remark: 'Cleaned the spot', mediaIds: [far], location: { lat: at.lat + 0.002, lng: at.lng } })).status).toBe(201);
    const media = await query<{ stage: string; distance_m: number; outside_geofence: number }>(db(), `SELECT stage, distance_m, outside_geofence FROM complaint_media WHERE complaint_id = ? AND stage <> 'COMPLAINT'`, [v.id]);
    const byStage = Object.fromEntries(media.map((m) => [m.stage, m]));
    expect(byStage.WORK_START.distance_m).toBeGreaterThan(25);
    expect(byStage.WORK_START.distance_m).toBeLessThan(40);
    expect(byStage.WORK_START.outside_geofence).toBeFalsy();
    expect(byStage.RESOLUTION.distance_m).toBeGreaterThan(200);
    expect(byStage.RESOLUTION.outside_geofence).toBeTruthy();
    const events = await query<{ action: string; meta: { distanceM: number; outsideGeofence: boolean; media: { outsideGeofence: number } } }>(db(), `SELECT action, meta FROM complaint_events WHERE complaint_id = ? AND action IN ('START','RESOLVE') ORDER BY id`, [v.id]);
    expect(events[0].meta.outsideGeofence).toBe(false);
    expect(events[1].meta.outsideGeofence).toBe(true);
    expect(events[1].meta.media.outsideGeofence).toBe(1);
  });

  it('a supervisor can reject (with a reason) or merge a duplicate; both end the complaint and tell the citizen', async () => {
    const w = await world();
    const c = await citizenIn(w.j);
    const a = await started(c, w);
    const b = await started(c, w);
    const d = await started(c, w);
    expect((await act(rejectRoute, w.sup, a.id, { reason: 'ok' })).status).toBe(400);
    const rej = await act(rejectRoute, w.sup, a.id, { reason: 'This is not a municipal matter' });
    expect(rej.status).toBe(201);
    expect(rej.body).toEqual(expect.objectContaining({ status: 'REJECTED' }));
    expect(rej.body.closedAt).toBeTruthy();
    expect(await noticesFor(c.u.id, a.id)).toContain('COMPLAINT_REJECTED');
    expect((await act(assignRoute, w.sup, a.id, { workerId: w.worker.u.id })).status).toBe(409);
    expect((await act(startRoute, w.sup, a.id, {})).status).toBe(409);
    expect((await act(rejectRoute, w.sup, a.id, { reason: 'Second thoughts here' })).status).toBe(409);
    expect((await act(resolveRoute, w.sup, a.id, { remark: 'Cleaned after all' })).status).toBe(409);

    expect((await act(duplicateRoute, w.sup, b.id, { duplicateOfId: b.id })).status).toBe(400);
    expect((await act(duplicateRoute, w.sup, b.id, { duplicateOfId: newId() })).status).toBe(400);
    expect((await act(duplicateRoute, w.sup, b.id, { duplicateOfId: a.id })).status).toBe(400); // original was rejected
    const elsewhere = await world();
    const foreign = await filed(await citizenIn(elsewhere.j), elsewhere.j);
    expect((await act(duplicateRoute, w.sup, b.id, { duplicateOfId: foreign.id })).status).toBe(400); // other ULB
    const merged = await act(duplicateRoute, w.sup, b.id, { duplicateOfId: d.id, remark: 'Same pile' });
    expect(merged.status).toBe(201);
    expect(merged.body).toEqual(expect.objectContaining({ status: 'DUPLICATE', duplicateOf: d.id }));
    expect((await act(duplicateRoute, w.sup, d.id, { duplicateOfId: b.id })).status).toBe(400); // b is now a duplicate itself
    for (const who of [c, w.worker]) {
      expect((await act(rejectRoute, who, d.id, { reason: 'I do not want this' })).status, who.u.role).toBe(403);
      expect((await act(duplicateRoute, who, d.id, { duplicateOfId: b.id })).status, who.u.role).toBe(403);
    }
  });

  it('suggests possible duplicates: same type, same ULB, within 50 m and 48 hours, never itself', async () => {
    const w = await world();
    const c = await citizenIn(w.j);
    const at = w.j.wards[0].center;
    const base = await filed(c, w.j);
    const near = await filed(c, w.j, { lat: at.lat + 0.0003, lng: at.lng }); // ~33 m
    const edge = await filed(c, w.j, { lat: at.lat, lng: at.lng + 0.0004 }); // ~43 m at this latitude
    const far = await filed(c, w.j, { lat: at.lat + 0.0006, lng: at.lng }); // ~67 m
    const otherType = (await one(db(), `SELECT id FROM complaint_types WHERE active AND id <> ? LIMIT 1`, [typeId]))!.id;
    const different = await filed(c, w.j, { typeId: otherType });
    const old = await filed(c, w.j);
    await run(db(), `UPDATE complaints SET created_at = DATE_SUB(NOW(3), INTERVAL 49 HOUR) WHERE id = ?`, [old.id]);
    const rejected = await filed(c, w.j);
    await run(db(), `UPDATE complaints SET status = 'REJECTED' WHERE id = ?`, [rejected.id]);

    const res = await call(candidatesRoute, 'GET', '/x', { token: w.sup.token, params: { id: base.id } });
    expect(res.status).toBe(200);
    const ids = res.body.map((x: { id: string }) => x.id);
    expect(ids).toEqual(expect.arrayContaining([near.id, edge.id]));
    for (const excluded of [base.id, far.id, different.id, old.id, rejected.id]) expect(ids).not.toContain(excluded);
    expect(res.body[0].id).toBe(near.id); // nearest first
    expect(res.body[0].distanceM).toBeGreaterThan(28);
    expect(res.body[0].distanceM).toBeLessThan(38);
    for (const who of [c, w.worker]) expect((await call(candidatesRoute, 'GET', '/x', { token: who.token, params: { id: base.id } })).status, who.u.role).toBe(403);
  });
});

describe('the citizen\'s verdict', () => {
  async function resolved(w: World, c: Citizen) {
    const v = await filed(c, w.j);
    await act(assignRoute, w.sup, v.id, { workerId: w.worker.u.id });
    expect((await act(resolveRoute, w.sup, v.id, { remark: 'Cleaned by the supervisor' })).status).toBe(201);
    return v;
  }

  it('a good rating closes it', async () => {
    const w = await world();
    const c = await citizenIn(w.j);
    const v = await resolved(w, c);
    expect((await act(feedbackRoute, c, v.id, { rating: 3 })).body.status).toBe('CLOSED');
    expect((await act(feedbackRoute, c, v.id, { rating: 5 })).status).toBe(409); // cannot rate twice
  });

  it('a low rating can reopen it: back to the team with a fresh deadline and a counter', async () => {
    const w = await world();
    const c = await citizenIn(w.j);
    const v = await resolved(w, c);
    await run(db(), `UPDATE complaints SET sla_due_at = DATE_SUB(NOW(3), INTERVAL 5 HOUR), sla_breached_at = DATE_SUB(NOW(3), INTERVAL 4 HOUR) WHERE id = ?`, [v.id]);
    const re = await act(feedbackRoute, c, v.id, { rating: 1, remark: 'Still dirty', reopen: true });
    expect(re.status).toBe(201);
    expect(re.body).toEqual(expect.objectContaining({ status: 'REOPENED', reopenCount: 1, resolvedAt: null, slaBreachedAt: null, escalated: false }));
    expect(new Date(re.body.slaDueAt).getTime()).toBeGreaterThan(Date.now());
    expect(await noticesFor(w.sup.u.id, v.id)).toContain('COMPLAINT_REOPENED');
    expect(await noticesFor(w.worker.u.id, v.id)).toContain('COMPLAINT_REOPENED');
    expect((await view(c, v.id)).body.feedback).toEqual([expect.objectContaining({ rating: 1, reopenRequested: true })]);
    // the team can pick it up again
    expect((await act(startRoute, w.sup, v.id, {})).status).toBe(201);
  });

  it('after two reopens the third escalates to the Sub Admin', async () => {
    const w = await world();
    const c = await citizenIn(w.j);
    const v = await resolved(w, c);
    for (let i = 1; i <= 3; i++) {
      const r = await act(feedbackRoute, c, v.id, { rating: 2, reopen: true });
      expect(r.status, `reopen ${i}`).toBe(201);
      expect(r.body.reopenCount).toBe(i);
      expect(r.body.escalated, `escalated after ${i}`).toBe(i === 3);
      expect((await act(resolveRoute, w.sup, v.id, { remark: 'Cleaned once more' })).status).toBe(201);
    }
    expect(await noticesFor(w.sub.u.id, v.id)).toContain('ESCALATED');
  });

  it('rules: reopen only with 1 or 2 stars; only on a resolved complaint; only inside 7 days; only by its owner', async () => {
    const w = await world();
    const c = await citizenIn(w.j);
    const other = await citizenIn(w.j);
    const fresh = await filed(c, w.j);
    expect((await act(feedbackRoute, c, fresh.id, { rating: 5 })).status).toBe(409); // not resolved yet
    const v = await resolved(w, c);
    expect((await act(feedbackRoute, c, v.id, { rating: 3, reopen: true })).status).toBe(400);
    for (const body of [{ rating: 0 }, { rating: 6 }, { rating: 2.5 }, { rating: '5' }, { rating: 5, remark: 'z'.repeat(251) }, { rating: 5, extra: true }, {}]) {
      expect((await act(feedbackRoute, c, v.id, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await act(feedbackRoute, other, v.id, { rating: 5 })).status).toBe(404);
    for (const who of [w.sup, w.sub, w.worker]) expect((await act(feedbackRoute, who, v.id, { rating: 5 })).status, who.u.role).toBe(403);
    await run(db(), `UPDATE complaints SET resolved_at = DATE_SUB(NOW(3), INTERVAL 8 DAY) WHERE id = ?`, [v.id]);
    const late = await act(feedbackRoute, c, v.id, { rating: 5 });
    expect(late.status).toBe(400);
    expect(late.body.message).toMatch(/window of 7 days/);
    expect(await query(db(), `SELECT 1 FROM feedback WHERE complaint_id = ?`, [v.id])).toHaveLength(0);
  });

  it('complaints nobody rated for 7 days close by themselves, with a note and a message', async () => {
    const w = await world();
    const c = await citizenIn(w.j);
    const stale = await resolved(w, c);
    const recent = await resolved(w, c);
    await run(db(), `UPDATE complaints SET resolved_at = DATE_SUB(NOW(3), INTERVAL 8 DAY) WHERE id = ?`, [stale.id]);
    await run(db(), `UPDATE complaints SET resolved_at = DATE_SUB(NOW(3), INTERVAL 6 DAY) WHERE id = ?`, [recent.id]);
    expect(await ComplaintService.autoCloseStale()).toBeGreaterThanOrEqual(1);
    expect((await rowOf(stale.id))!.status).toBe('CLOSED');
    expect((await rowOf(stale.id))!.closed_at).toBeTruthy();
    expect((await rowOf(recent.id))!.status).toBe('RESOLVED');
    const events = await query(db(), `SELECT action, remark, actor_id FROM complaint_events WHERE complaint_id = ? AND action = 'AUTO_CLOSE'`, [stale.id]);
    expect(events).toEqual([{ action: 'AUTO_CLOSE', remark: 'No feedback within window', actor_id: null }]);
    expect(await noticesFor(c.u.id, stale.id)).toContain('COMPLAINT_CLOSED');
    expect(await ComplaintService.autoCloseStale()).toBe(0);
  });
});

describe('two people acting at once', () => {
  it('only one of several simultaneous resolves wins, and the history shows it once', async () => {
    const w = await world();
    const c = await citizenIn(w.j);
    const v = await filed(c, w.j);
    const results = await Promise.all(Array.from({ length: 6 }, () => act(resolveRoute, w.sup, v.id, { remark: 'Cleaned by the supervisor' })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409, 409]);
    expect(await query(db(), `SELECT 1 FROM complaint_events WHERE complaint_id = ? AND action = 'RESOLVE'`, [v.id])).toHaveLength(1);
    expect(await noticesFor(c.u.id, v.id).then((n) => n.filter((t) => t === 'COMPLAINT_RESOLVED'))).toHaveLength(1);
  });

  it('a reject racing a resolve ends in exactly one outcome', async () => {
    const w = await world();
    const v = await filed(await citizenIn(w.j), w.j);
    const [a, b] = await Promise.all([act(rejectRoute, w.sup, v.id, { reason: 'Not our matter at all' }), act(resolveRoute, w.sub, v.id, { remark: 'Cleaned by the Sub Admin' })]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(['REJECTED', 'RESOLVED']).toContain((await rowOf(v.id))!.status);
  });

  it('rating twice at once records one verdict', async () => {
    const w = await world();
    const c = await citizenIn(w.j);
    const v = await filed(c, w.j);
    await act(resolveRoute, w.sup, v.id, { remark: 'Cleaned by the supervisor' });
    const [a, b] = await Promise.all([act(feedbackRoute, c, v.id, { rating: 5 }), act(feedbackRoute, c, v.id, { rating: 1, reopen: true })]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await query(db(), `SELECT 1 FROM feedback WHERE complaint_id = ?`, [v.id])).toHaveLength(1);
  });
});
