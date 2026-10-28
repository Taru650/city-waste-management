import { beforeAll, describe, expect, it } from 'vitest';
import { GET as districts, POST as createDistrict } from '@/app/api/v1/masters/districts/route';
import { GET as ulbsOf } from '@/app/api/v1/masters/districts/[id]/ulbs/route';
import { POST as createUlb } from '@/app/api/v1/masters/ulbs/route';
import { GET as wardsOf } from '@/app/api/v1/masters/ulbs/[id]/wards/route';
import { GET as boundariesOf } from '@/app/api/v1/masters/ulbs/[id]/boundaries/route';
import { GET as areasOf } from '@/app/api/v1/masters/ulbs/[id]/areas/route';
import { GET as complaintTypes } from '@/app/api/v1/masters/complaint-types/route';
import { GET as allComplaintTypes } from '@/app/api/v1/masters/complaint-types/all/route';
import { PATCH as patchComplaintType } from '@/app/api/v1/masters/complaint-types/[id]/route';
import { GET as locate } from '@/app/api/v1/masters/locate/route';
import { POST as createWard } from '@/app/api/v1/masters/wards/route';
import { PATCH as patchWard } from '@/app/api/v1/masters/wards/[id]/route';
import { POST as createArea } from '@/app/api/v1/masters/areas/route';
import { PATCH as patchArea } from '@/app/api/v1/masters/areas/[id]/route';
import { square } from '@/lib/geo';
import { newId } from '@/lib/ids';
import { call, createJurisdiction, createUser, db, loginAs, one, query, run, setupTestEnvironment, type Jurisdiction } from './helpers';

setupTestEnvironment();

let a: Jurisdiction; // two separate jurisdictions, to prove one cannot touch the other
let b: Jurisdiction;
const tok: Record<string, string> = {};
let nextLgd = 5000;

const wardSquare = (j: Jurisdiction, k: number, dLng = 0) => {
  // ward k (0-based) of the test grid: lat as in createJurisdiction, lng stepping 0.01
  const c = j.wards[0].center;
  return square(c.lat - 0.005, c.lng - 0.005 + k * 0.01 + dLng);
};

beforeAll(async () => {
  a = await createJurisdiction();
  b = await createJurisdiction();
  const make = async (key: string, role: Parameters<typeof createUser>[0], j?: Jurisdiction) => (tok[key] = await loginAs(await createUser(role, j)));
  await make('web', 'WEB_ADMIN');
  await make('distA', 'DISTRICT_ADMIN', a);
  await make('distB', 'DISTRICT_ADMIN', b);
  await make('subA', 'SUB_ADMIN', a);
  await make('subB', 'SUB_ADMIN', b);
  await make('supA', 'SUPERVISOR', a);
  await make('supB', 'SUPERVISOR', b);
  await make('workerA', 'WORKER', a);
  await make('citizen', 'CITIZEN', a);
});

describe('public dropdown data', () => {
  it('lists districts, ULBs and wards without signing in; unknown ids give empty lists, bad ids 404', async () => {
    const ds = await call(districts, 'GET', '/api/v1/masters/districts');
    expect(ds.status).toBe(200);
    expect(ds.body.map((d: { id: string }) => d.id)).toContain(a.districtId);
    expect(ds.body[0]).toEqual(expect.objectContaining({ id: expect.any(String), lgdCode: expect.any(Number), name: expect.any(String) }));

    const us = await call(ulbsOf, 'GET', `/api/v1/masters/districts/${a.districtId}/ulbs`, { params: { id: a.districtId } });
    expect(us.body).toEqual([expect.objectContaining({ id: a.ulbId, type: 'NAGAR_NIGAM' })]);

    const ws = await call(wardsOf, 'GET', `/api/v1/masters/ulbs/${a.ulbId}/wards`, { params: { id: a.ulbId } });
    expect(ws.body.map((w: { number: number }) => w.number)).toEqual([1, 2]);
    expect(ws.body[0].hasBoundary).toBe(true);
    expect(ws.body[0].areaId).toBe(a.areaId);
    expect(ws.body[1].areaId).toBeNull();

    const id = newId();
    expect((await call(wardsOf, 'GET', '/x', { params: { id } })).body).toEqual([]);
    expect((await call(wardsOf, 'GET', '/x', { params: { id: 'not-a-uuid' } })).status).toBe(404);
    expect((await call(wardsOf, 'GET', '/x', { params: { id: "' OR 1=1 --" } })).status).toBe(404);
  });

  it('complaint types: public list hides inactive ones; the full list is for Web Admin only', async () => {
    const pub = await call(complaintTypes, 'GET', '/api/v1/masters/complaint-types');
    expect(pub.status).toBe(200);
    expect(pub.body.length).toBeGreaterThanOrEqual(8);
    expect(pub.body.every((t: { active: boolean }) => t.active === true)).toBe(true);
    expect(pub.body[0]).toEqual(expect.objectContaining({ code: expect.any(String), nameEn: expect.any(String), slaHours: expect.any(Number) }));
    expect((await call(allComplaintTypes, 'GET', '/x', { token: tok.web })).status).toBe(200);
    for (const k of ['distA', 'subA', 'supA', 'workerA', 'citizen']) expect((await call(allComplaintTypes, 'GET', '/x', { token: tok[k] })).status, k).toBe(403);
    expect((await call(allComplaintTypes, 'GET', '/x')).status).toBe(401);
  });
});

describe('locating a GPS point', () => {
  it('returns the ward, ULB and district for a point inside a ward, and no internal ids beyond those', async () => {
    const r = await call(locate, 'GET', '/api/v1/masters/locate', { token: tok.citizen, query: { lat: a.wards[1].center.lat, lng: a.wards[1].center.lng } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual(expect.objectContaining({ wardId: a.wards[1].id, wardNumber: 2, ulbId: a.ulbId, districtId: a.districtId, ulbType: 'NAGAR_NIGAM' }));
    expect(Object.keys(r.body).sort()).toEqual(['districtId', 'districtName', 'ulbId', 'ulbName', 'ulbType', 'wardId', 'wardName', 'wardNumber']);
  });

  it('the answer depends on the point, not on who asks (coordinates are lat, lng - not swapped)', async () => {
    const inA = await call(locate, 'GET', '/x', { token: tok.subB, query: { lat: a.wards[0].center.lat, lng: a.wards[0].center.lng } });
    expect(inA.body.ulbId).toBe(a.ulbId);
    const swapped = await call(locate, 'GET', '/x', { token: tok.citizen, query: { lat: a.wards[0].center.lng, lng: a.wards[0].center.lat } });
    expect([404, 400]).toContain(swapped.status); // lat=70.. is out of range or empty, never silently "found"
  });

  it('404 with a hint when no ward covers the point; 400 for impossible coordinates; 401 without sign-in', async () => {
    expect((await call(locate, 'GET', '/x', { token: tok.citizen, query: { lat: 1, lng: 1 } })).status).toBe(404);
    for (const q of [{ lat: 91, lng: 10 }, { lat: 10, lng: 181 }, { lat: 'abc', lng: 10 }, { lat: 10 }]) {
      expect((await call(locate, 'GET', '/x', { token: tok.citizen, query: q as Record<string, string | number> })).status, JSON.stringify(q)).toBe(400);
    }
    expect((await call(locate, 'GET', '/x', { query: { lat: 10, lng: 70 } })).status).toBe(401);
  });

  it('a point on the shared edge of two wards still gets one consistent answer', async () => {
    const edge = { lat: a.wards[0].center.lat, lng: a.wards[0].center.lng + 0.005 };
    const answers = new Set<number | string>();
    for (let i = 0; i < 5; i++) {
      const r = await call(locate, 'GET', '/x', { token: tok.citizen, query: edge });
      answers.add(r.status === 200 ? r.body.wardId : r.status);
    }
    expect(answers.size).toBe(1);
  });

  it('where legacy data overlaps, the lowest ward id always wins', async () => {
    const j = await createJurisdiction();
    const extra = newId();
    await run(db(), `INSERT INTO wards (id, ulb_id, number) VALUES (?,?,3)`, [extra, j.ulbId]);
    await run(db(), `INSERT INTO ward_boundaries (ward_id, geom) VALUES (?, ST_GeomFromGeoJSON(?, 1, 4326))`, [extra, JSON.stringify(wardSquare(j, 0))]);
    const expected = [j.wards[0].id, extra].sort()[0];
    const t = await loginAs(await createUser('CITIZEN', j));
    for (let i = 0; i < 5; i++) {
      expect((await call(locate, 'GET', '/x', { token: t, query: j.wards[0].center })).body.wardId).toBe(expected);
    }
  });
});

describe('ward boundaries for maps', () => {
  it('returns GeoJSON for people who manage or supervise that ULB, and nobody else', async () => {
    const ok = await call(boundariesOf, 'GET', '/x', { token: tok.subA, params: { id: a.ulbId } });
    expect(ok.status).toBe(200);
    expect(ok.body.type).toBe('FeatureCollection');
    expect(ok.body.features).toHaveLength(2);
    expect(ok.body.features[0]).toEqual(expect.objectContaining({ type: 'Feature', geometry: expect.objectContaining({ type: 'Polygon' }), properties: expect.objectContaining({ number: 1 }) }));
    for (const k of ['web', 'distA', 'subA', 'supA']) expect((await call(boundariesOf, 'GET', '/x', { token: tok[k], params: { id: a.ulbId } })).status, k).toBe(200);
    for (const k of ['distB', 'subB', 'supB']) expect((await call(boundariesOf, 'GET', '/x', { token: tok[k], params: { id: a.ulbId } })).status, k).toBe(403);
    for (const k of ['workerA', 'citizen']) expect((await call(boundariesOf, 'GET', '/x', { token: tok[k], params: { id: a.ulbId } })).status, k).toBe(403);
    expect((await call(boundariesOf, 'GET', '/x', { params: { id: a.ulbId } })).status).toBe(401);
  });
});

describe('Web Admin: districts, ULBs and complaint types', () => {
  it('creates a district (and refuses duplicates, bad input and other roles)', async () => {
    const lgd = nextLgd++;
    const ok = await call(createDistrict, 'POST', '/x', { token: tok.web, body: { lgdCode: lgd, name: 'Test District' } });
    expect(ok.status).toBe(201);
    expect(await one(db(), `SELECT 1 AS x FROM audit_logs WHERE action = 'DISTRICT_CREATED' AND entity_id = ?`, [ok.body.id])).toBeTruthy();
    expect((await call(createDistrict, 'POST', '/x', { token: tok.web, body: { lgdCode: lgd, name: 'Again' } })).status).toBe(409);
    for (const body of [{ lgdCode: 0, name: 'X1' }, { lgdCode: 10000, name: 'X1' }, { lgdCode: 1.5, name: 'X1' }, { lgdCode: '12', name: 'X1' }, { lgdCode: nextLgd++, name: 'A' }, { lgdCode: nextLgd++, name: 'Ok', admin: true }]) {
      expect((await call(createDistrict, 'POST', '/x', { token: tok.web, body })).status, JSON.stringify(body)).toBe(400);
    }
    for (const k of ['distA', 'subA', 'supA', 'workerA', 'citizen']) {
      expect((await call(createDistrict, 'POST', '/x', { token: tok[k], body: { lgdCode: nextLgd++, name: 'Nope' } })).status, k).toBe(403);
    }
    expect((await call(createDistrict, 'POST', '/x', { body: { lgdCode: nextLgd++, name: 'Nope' } })).status).toBe(401);
  });

  it('creates ULBs: Web Admin anywhere, District Admin only in their own district', async () => {
    const body = (districtId: string, extra = {}) => ({ districtId, lgdCode: nextLgd++, type: 'NAGAR_PARISHAD', name: 'Test Parishad', ...extra });
    expect((await call(createUlb, 'POST', '/x', { token: tok.web, body: body(a.districtId) })).status).toBe(201);
    expect((await call(createUlb, 'POST', '/x', { token: tok.distA, body: body(a.districtId) })).status).toBe(201);
    expect((await call(createUlb, 'POST', '/x', { token: tok.distA, body: body(b.districtId) })).status).toBe(403);
    expect((await call(createUlb, 'POST', '/x', { token: tok.web, body: body(newId()) })).status).toBe(404);
    expect((await call(createUlb, 'POST', '/x', { token: tok.web, body: body(a.districtId, { type: 'VILLAGE' }) })).status).toBe(400);
    expect((await call(createUlb, 'POST', '/x', { token: tok.subA, body: body(a.districtId) })).status).toBe(403);
    const dup = body(a.districtId);
    expect((await call(createUlb, 'POST', '/x', { token: tok.web, body: dup })).status).toBe(201);
    expect((await call(createUlb, 'POST', '/x', { token: tok.web, body: dup })).status).toBe(409);
  });

  it('stores a ULB boundary and refuses an invalid polygon without leaving a half-created ULB', async () => {
    const lgd = nextLgd++;
    const good = await call(createUlb, 'POST', '/x', { token: tok.web, body: { districtId: a.districtId, lgdCode: lgd, type: 'NAGAR_NIGAM', name: 'With Boundary', boundary: square(20, 80, 0.1) } });
    expect(good.status).toBe(201);
    expect(await one(db(), `SELECT 1 AS x FROM ulb_boundaries WHERE ulb_id = ?`, [good.body.id])).toBeTruthy();

    const bowTie = { type: 'Polygon', coordinates: [[[80, 20], [80.1, 20.1], [80.1, 20], [80, 20.1], [80, 20]]] };
    const lgd2 = nextLgd++;
    const bad = await call(createUlb, 'POST', '/x', { token: tok.web, body: { districtId: a.districtId, lgdCode: lgd2, type: 'NAGAR_NIGAM', name: 'Bow Tie', boundary: bowTie } });
    expect(bad.status).toBe(400);
    expect(await one(db(), `SELECT 1 AS x FROM ulbs WHERE lgd_code = ?`, [lgd2])).toBeUndefined();
  });

  it('Web Admin changes SLA hours and availability of a complaint type, within limits', async () => {
    const t = (await query(db(), `SELECT id, sla_hours FROM complaint_types ORDER BY sort_order LIMIT 1`))[0];
    const url = `/api/v1/masters/complaint-types/${t.id}`;
    const ok = await call(patchComplaintType, 'PATCH', url, { token: tok.web, params: { id: t.id }, body: { slaHours: 36 } });
    expect(ok.status).toBe(200);
    expect((await one(db(), `SELECT sla_hours FROM complaint_types WHERE id = ?`, [t.id]))!.sla_hours).toBe(36);
    await call(patchComplaintType, 'PATCH', url, { token: tok.web, params: { id: t.id }, body: { slaHours: t.sla_hours } });
    for (const body of [{ slaHours: 0 }, { slaHours: 721 }, { slaHours: 1.5 }, { active: 'yes' }, { code: 'HACK' }]) {
      expect((await call(patchComplaintType, 'PATCH', url, { token: tok.web, params: { id: t.id }, body })).status, JSON.stringify(body)).toBe(400);
    }
    expect((await call(patchComplaintType, 'PATCH', url, { token: tok.web, params: { id: newId() }, body: { slaHours: 5 } })).status).toBe(404);
    expect((await call(patchComplaintType, 'PATCH', url, { token: tok.subA, params: { id: t.id }, body: { slaHours: 5 } })).status).toBe(403);
    expect((await one(db(), `SELECT sla_hours FROM complaint_types WHERE id = ?`, [t.id]))!.sla_hours).toBe(t.sla_hours);
  });
});

describe('wards and their boundaries', () => {
  const wardCount = async (ulbId: string) => Number((await one(db(), `SELECT COUNT(*) AS n FROM wards WHERE ulb_id = ?`, [ulbId]))!.n);

  it('Sub Admin adds a ward with a boundary that shares an edge with a neighbour', async () => {
    const j = await createJurisdiction();
    const t = await loginAs(await createUser('SUB_ADMIN', j));
    const r = await call(createWard, 'POST', '/x', { token: t, body: { ulbId: j.ulbId, number: 3, name: 'Third', boundary: wardSquare(j, 2) } });
    expect(r.status).toBe(201);
    expect((await call(locate, 'GET', '/x', { token: t, query: { lat: j.wards[0].center.lat, lng: j.wards[0].center.lng + 0.02 } })).body.wardId).toBe(r.body.id);
  });

  it('refuses a ward that overlaps another, names it, and leaves nothing behind', async () => {
    const j = await createJurisdiction();
    const t = await loginAs(await createUser('SUB_ADMIN', j));
    const before = await wardCount(j.ulbId);
    const r = await call(createWard, 'POST', '/x', { token: t, body: { ulbId: j.ulbId, number: 3, boundary: wardSquare(j, 1, -0.005) } });
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toMatch(/overlaps ward 1 \(.*ward 2 \(/); // the square straddles both neighbours
    expect(await wardCount(j.ulbId)).toBe(before);
    expect(await one(db(), `SELECT 1 AS x FROM ward_boundaries WHERE ward_id IN (SELECT id FROM wards WHERE ulb_id = ? AND number = 3)`, [j.ulbId])).toBeUndefined();
  });

  const overlapReported = (message: unknown, ward: number) => {
    const m = new RegExp(`ward ${ward} \\(([\\d,]+) m²\\)`).exec(String(message));
    return m ? Number(m[1].replace(/,/g, '')) : NaN;
  };

  it('measures an overlap in square metres (geodesic) and refuses it', async () => {
    const j = await createJurisdiction();
    const t = await loginAs(await createUser('SUB_ADMIN', j));
    // 0.01 degree tall ward (about 1,112 m) overlapping ward 2 by 2e-6 degrees (about 0.22 m wide): about 242 m²
    const small = await call(createWard, 'POST', '/x', { token: t, body: { ulbId: j.ulbId, number: 3, boundary: wardSquare(j, 2, -0.000002) } });
    expect(small.status).toBe(400);
    expect(overlapReported(small.body.message, 2)).toBeGreaterThan(230);
    expect(overlapReported(small.body.message, 2)).toBeLessThan(255);
    // 1e-5 degrees wide: about 1,212 m²
    const bigger = await call(createWard, 'POST', '/x', { token: t, body: { ulbId: j.ulbId, number: 4, boundary: wardSquare(j, 2, -0.00001) } });
    expect(bigger.status).toBe(400);
    expect(overlapReported(bigger.body.message, 2)).toBeGreaterThan(1180);
    expect(overlapReported(bigger.body.message, 2)).toBeLessThan(1250);
  });

  it('hairline offsets (edges within about 10 cm but not identical) are refused with advice, never a crash', async () => {
    // MySQL cannot compute a reliable geodesic intersection here (measured); the upload fails closed and says how to fix it.
    const j = await createJurisdiction();
    const t = await loginAs(await createUser('SUB_ADMIN', j));
    for (const offset of [-0.0000005, -0.000001]) {
      const r = await call(createWard, 'POST', '/x', { token: t, body: { ulbId: j.ulbId, number: 3, boundary: wardSquare(j, 2, offset) } });
      expect(r.status, `offset ${offset}`).toBe(400);
      expect(String(r.body.message)).toMatch(/identical vertices/);
    }
    expect(await wardCount(j.ulbId)).toBe(2);
  });

  it('tolerates an overlap under 100 m² and refuses one over it (measured on small wards)', async () => {
    const j = await createJurisdiction();
    const t = await loginAs(await createUser('SUB_ADMIN', j));
    const c = j.wards[0].center;
    const lat0 = c.lat + 0.05; // well clear of the two grid wards
    const lng0 = c.lng;
    const tile = (k: number, shift = 0) => square(lat0, lng0 + k * 0.0002 - shift, 0.0002); // 22 m x 22 m tiles
    expect((await call(createWard, 'POST', '/x', { token: t, body: { ulbId: j.ulbId, number: 3, boundary: tile(0) } })).status).toBe(201);
    // overlaps tile 0 by 5e-6 degrees (0.55 m x 22 m = about 12 m²): within the tolerance
    expect((await call(createWard, 'POST', '/x', { token: t, body: { ulbId: j.ulbId, number: 4, boundary: tile(1, 0.000005) } })).status).toBe(201);
    // overlaps tile 1 by 5e-5 degrees (5.5 m x 22 m = about 122 m²): over the tolerance
    const over = await call(createWard, 'POST', '/x', { token: t, body: { ulbId: j.ulbId, number: 5, boundary: tile(2, 0.00005) } });
    expect(over.status).toBe(400);
    expect(overlapReported(over.body.message, 4)).toBeGreaterThan(100);
    expect(overlapReported(over.body.message, 4)).toBeLessThan(150);
  });

  it('two overlapping uploads at the same moment: exactly one is accepted', async () => {
    const j = await createJurisdiction();
    const t = await loginAs(await createUser('SUB_ADMIN', j));
    const results = await Promise.all([3, 4, 5, 6].map((n) => call(createWard, 'POST', '/x', { token: t, body: { ulbId: j.ulbId, number: n, boundary: wardSquare(j, 2) } })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(3);
    expect(await wardCount(j.ulbId)).toBe(3);
  });

  it('duplicate ward numbers conflict; bad numbers and polygons are rejected', async () => {
    const j = await createJurisdiction();
    const t = await loginAs(await createUser('SUB_ADMIN', j));
    expect((await call(createWard, 'POST', '/x', { token: t, body: { ulbId: j.ulbId, number: 1 } })).status).toBe(409);
    for (const body of [
      { ulbId: j.ulbId, number: 0 },
      { ulbId: j.ulbId, number: 5, boundary: { type: 'Point', coordinates: [1, 1] } },
      { ulbId: j.ulbId, number: 5, boundary: { type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] } },
      { ulbId: j.ulbId, number: 5, boundary: { type: 'Polygon', coordinates: [[[200, 0], [201, 0], [201, 1], [200, 0]]] } },
      { ulbId: j.ulbId, number: 5, boundary: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]]] } }, // ring not closed
      { ulbId: j.ulbId, number: 5, boundary: { type: 'Polygon', coordinates: [[[80, 20], [80.1, 20.1], [80.1, 20], [80, 20.1], [80, 20]]] } }, // self-intersecting
      { ulbId: 'nope', number: 5 },
    ]) {
      expect((await call(createWard, 'POST', '/x', { token: t, body })).status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect(await wardCount(j.ulbId)).toBe(2);
  });

  it('only the managers of that ULB may add or change wards', async () => {
    const body = { ulbId: a.ulbId, number: 90, name: 'Not allowed' };
    for (const k of ['distB', 'subB']) expect((await call(createWard, 'POST', '/x', { token: tok[k], body })).status, k).toBe(403);
    for (const k of ['supA', 'workerA', 'citizen']) expect((await call(createWard, 'POST', '/x', { token: tok[k], body })).status, k).toBe(403);
    expect((await call(createWard, 'POST', '/x', { token: tok.subA, body: { ...body, ulbId: newId() } })).status).toBe(404);
    expect((await call(createWard, 'POST', '/x', { body })).status).toBe(401);
    for (const k of ['distB', 'subB', 'supA', 'citizen']) {
      expect((await call(patchWard, 'PATCH', '/x', { token: tok[k], params: { id: a.wards[0].id }, body: { name: 'Hacked' } })).status, k).toBe(403);
    }
    expect((await call(patchWard, 'PATCH', '/x', { token: tok.subA, params: { id: newId() }, body: { name: 'x' } })).status).toBe(404);
    expect((await one(db(), `SELECT name FROM wards WHERE id = ?`, [a.wards[0].id]))!.name).not.toBe('Hacked');
  });

  it('changing a boundary or switching a ward back on is checked for overlap; a failed change keeps the old boundary', async () => {
    const j = await createJurisdiction();
    const t = await loginAs(await createUser('SUB_ADMIN', j));
    const [w1, w2] = j.wards;
    const bad = await call(patchWard, 'PATCH', '/x', { token: t, params: { id: w2.id }, body: { boundary: wardSquare(j, 0, 0.002) } });
    expect(bad.status).toBe(400);
    expect((await call(locate, 'GET', '/x', { token: t, query: w2.center })).body.wardId).toBe(w2.id); // old boundary intact

    // switch ward 2 off, put a new ward on its ground, then try to switch ward 2 back on
    expect((await call(patchWard, 'PATCH', '/x', { token: t, params: { id: w2.id }, body: { active: false } })).status).toBe(200);
    expect((await call(createWard, 'POST', '/x', { token: t, body: { ulbId: j.ulbId, number: 3, boundary: wardSquare(j, 1) } })).status).toBe(201);
    const back = await call(patchWard, 'PATCH', '/x', { token: t, params: { id: w2.id }, body: { active: true } });
    expect(back.status).toBe(400);
    expect((await one(db(), `SELECT active FROM wards WHERE id = ?`, [w2.id]))!.active).toBeFalsy();

    // a fully valid change works
    const moved = await call(patchWard, 'PATCH', '/x', { token: t, params: { id: w1.id }, body: { name: 'Renamed', boundary: wardSquare(j, 0, -0.0001) } });
    expect(moved.status).toBe(200);
    expect((await one(db(), `SELECT name FROM wards WHERE id = ?`, [w1.id]))!.name).toBe('Renamed');
  });

  it('an inactive ward does not block, and is not found by, location lookup', async () => {
    const j = await createJurisdiction();
    const t = await loginAs(await createUser('SUB_ADMIN', j));
    await call(patchWard, 'PATCH', '/x', { token: t, params: { id: j.wards[1].id }, body: { active: false } });
    expect((await call(locate, 'GET', '/x', { token: t, query: j.wards[1].center })).status).toBe(404);
    expect((await call(createWard, 'POST', '/x', { token: t, body: { ulbId: j.ulbId, number: 7, boundary: wardSquare(j, 1) } })).status).toBe(201);
  });
});

describe('areas', () => {
  it('creates an area with a supervisor and wards, lists it, and edits it', async () => {
    const j = await createJurisdiction();
    const sub = await loginAs(await createUser('SUB_ADMIN', j));
    const sup1 = await createUser('SUPERVISOR', j);
    const sup2 = await createUser('SUPERVISOR', j);
    const made = await call(createArea, 'POST', '/x', { token: sub, body: { ulbId: j.ulbId, name: 'South', supervisorId: sup1.id, wardIds: [j.wards[1].id] } });
    expect(made.status).toBe(201);
    let list = await call(areasOf, 'GET', '/x', { token: sub, params: { id: j.ulbId } });
    const south = list.body.find((x: { name: string }) => x.name === 'South');
    expect(south).toEqual(expect.objectContaining({ supervisorId: sup1.id, wardIds: [j.wards[1].id] }));

    expect((await call(patchArea, 'PATCH', '/x', { token: sub, params: { id: made.body.id }, body: { supervisorId: sup2.id, wardIds: [j.wards[0].id] } })).status).toBe(200);
    list = await call(areasOf, 'GET', '/x', { token: sub, params: { id: j.ulbId } });
    const moved = list.body.find((x: { name: string }) => x.name === 'South');
    expect(moved).toEqual(expect.objectContaining({ supervisorId: sup2.id, wardIds: [j.wards[0].id] }));
    expect((await one(db(), `SELECT area_id FROM wards WHERE id = ?`, [j.wards[1].id]))!.area_id).toBeNull();

    expect((await call(patchArea, 'PATCH', '/x', { token: sub, params: { id: made.body.id }, body: { supervisorId: null } })).status).toBe(200);
    expect((await one(db(), `SELECT supervisor_id FROM areas WHERE id = ?`, [made.body.id]))!.supervisor_id).toBeNull();
  });

  it('refuses a supervisor or ward from another ULB and leaves nothing half-done', async () => {
    const sub = tok.subA;
    const foreignSup = await createUser('SUPERVISOR', b);
    const before = Number((await one(db(), `SELECT COUNT(*) AS n FROM areas WHERE ulb_id = ?`, [a.ulbId]))!.n);
    expect((await call(createArea, 'POST', '/x', { token: sub, body: { ulbId: a.ulbId, name: 'Bad sup', supervisorId: foreignSup.id, wardIds: [] } })).status).toBe(400);
    expect((await call(createArea, 'POST', '/x', { token: sub, body: { ulbId: a.ulbId, name: 'Bad ward', wardIds: [b.wards[0].id] } })).status).toBe(400);
    expect((await call(createArea, 'POST', '/x', { token: sub, body: { ulbId: a.ulbId, name: 'Missing ward', wardIds: [newId()] } })).status).toBe(400);
    expect(Number((await one(db(), `SELECT COUNT(*) AS n FROM areas WHERE ulb_id = ?`, [a.ulbId]))!.n)).toBe(before);
    expect((await one(db(), `SELECT area_id FROM wards WHERE id = ?`, [b.wards[0].id]))!.area_id).toBe(b.areaId); // the other ULB's ward is untouched
    // a supervisor who is disabled cannot be given an area
    const disabled = await createUser('SUPERVISOR', a, { status: 'DISABLED' });
    expect((await call(createArea, 'POST', '/x', { token: sub, body: { ulbId: a.ulbId, name: 'Disabled sup', supervisorId: disabled.id, wardIds: [] } })).status).toBe(400);
  });

  it('area names are unique within a ULB', async () => {
    const j = await createJurisdiction();
    const sub = await loginAs(await createUser('SUB_ADMIN', j));
    expect((await call(createArea, 'POST', '/x', { token: sub, body: { ulbId: j.ulbId, name: 'Area A', wardIds: [] } })).status).toBe(409);
  });

  it('another ULB\'s managers cannot list, create or edit areas; roles below Sub Admin cannot at all', async () => {
    for (const k of ['distB', 'subB']) {
      expect((await call(areasOf, 'GET', '/x', { token: tok[k], params: { id: a.ulbId } })).status, k).toBe(403);
      expect((await call(createArea, 'POST', '/x', { token: tok[k], body: { ulbId: a.ulbId, name: 'X', wardIds: [] } })).status, k).toBe(403);
      expect((await call(patchArea, 'PATCH', '/x', { token: tok[k], params: { id: a.areaId }, body: { wardIds: [] } })).status, k).toBe(403);
    }
    for (const k of ['supA', 'workerA', 'citizen']) {
      expect((await call(areasOf, 'GET', '/x', { token: tok[k], params: { id: a.ulbId } })).status, k).toBe(403);
      expect((await call(patchArea, 'PATCH', '/x', { token: tok[k], params: { id: a.areaId }, body: { wardIds: [] } })).status, k).toBe(403);
    }
    expect((await call(patchArea, 'PATCH', '/x', { token: tok.subA, params: { id: newId() }, body: { wardIds: [] } })).status).toBe(404);
    expect((await call(areasOf, 'GET', '/x', { params: { id: a.ulbId } })).status).toBe(401);
  });
});
