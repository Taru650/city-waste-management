import { Role } from '../src/common/enums';
import { api, bearer, createJurisdiction, createTestApp, createUser, Jurisdiction, square, TestCtx, tokenFor } from './helpers';

describe('Masters: districts, ULBs, wards, areas (M2)', () => {
  let ctx: TestCtx;
  let j: Jurisdiction;
  let other: Jurisdiction;
  let webAdmin: string;
  let districtAdmin: string;
  let subAdmin: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    j = await createJurisdiction(ctx.ds);
    other = await createJurisdiction(ctx.ds);
    webAdmin = await tokenFor(ctx, await createUser(ctx, Role.WEB_ADMIN));
    districtAdmin = await tokenFor(ctx, await createUser(ctx, Role.DISTRICT_ADMIN, j));
    subAdmin = await tokenFor(ctx, await createUser(ctx, Role.SUB_ADMIN, j));
  });
  afterAll(() => ctx.app.close());

  it('public dropdowns: district → ULB → ward, and complaint types in Hindi and English', async () => {
    const districts = await ctx.http().get(api('/masters/districts')).expect(200);
    expect(districts.body.map((d: { id: string }) => d.id)).toContain(j.districtId);
    const ulbs = await ctx.http().get(api(`/masters/districts/${j.districtId}/ulbs`)).expect(200);
    expect(ulbs.body).toEqual([expect.objectContaining({ id: j.ulbId, lgdCode: j.ulbLgd, type: 'NAGAR_NIGAM' })]);
    const wards = await ctx.http().get(api(`/masters/ulbs/${j.ulbId}/wards`)).expect(200);
    expect(wards.body).toHaveLength(2);
    expect(wards.body[0]).toEqual(expect.objectContaining({ number: 1, hasBoundary: true }));
    const types = await ctx.http().get(api('/masters/complaint-types')).expect(200);
    expect(types.body.find((t: { code: string }) => t.code === 'WATER_LOGGING')).toEqual(
      expect.objectContaining({ nameHi: 'जल भराव', slaHours: 24 }),
    );
  });

  it('locates ward / ULB / district from a GPS point', async () => {
    const res = await ctx.http().get(api('/masters/locate')).query(j.wards[1].center).set(bearer(subAdmin)).expect(200);
    expect(res.body).toEqual(expect.objectContaining({ wardId: j.wards[1].id, ulbId: j.ulbId, districtId: j.districtId }));
    await ctx.http().get(api('/masters/locate')).query({ lat: -45, lng: 10 }).set(bearer(subAdmin)).expect(404);
    await ctx.http().get(api('/masters/locate')).query({ lat: 95, lng: 10 }).set(bearer(subAdmin)).expect(400);
  });

  it('Web Admin creates a district with its LGD code; duplicates are refused', async () => {
    const lgd = 5000 + Math.floor(Math.random() * 4000);
    await ctx.http().post(api('/masters/districts')).set(bearer(webAdmin)).send({ lgdCode: lgd, name: 'Raipur', nameHi: 'रायपुर' }).expect(201);
    await ctx.http().post(api('/masters/districts')).set(bearer(webAdmin)).send({ lgdCode: lgd, name: 'Again' }).expect(409);
    await ctx.http().post(api('/masters/districts')).set(bearer(districtAdmin)).send({ lgdCode: lgd + 1, name: 'X' }).expect(403);
  });

  it('District Admin creates ULBs only in their own district', async () => {
    const lgd = 600000 + Math.floor(Math.random() * 99999);
    await ctx.http().post(api('/masters/ulbs')).set(bearer(districtAdmin))
      .send({ districtId: j.districtId, lgdCode: lgd, type: 'NAGAR_PARISHAD', name: 'Nagar Parishad X' }).expect(201);
    await ctx.http().post(api('/masters/ulbs')).set(bearer(districtAdmin))
      .send({ districtId: other.districtId, lgdCode: lgd + 1, type: 'NAGAR_PANCHAYAT', name: 'Elsewhere' }).expect(403);
  });

  it('Sub Admin manages wards with GeoJSON boundaries in their ULB only', async () => {
    const [{ n }] = await ctx.ds.query(`SELECT nextval('test_region_seq')::int AS n`);
    const boundary = square(10 + Math.floor(n / 50) * 0.1, 70 + (n % 50) * 0.1);
    const created = await ctx.http().post(api('/masters/wards')).set(bearer(subAdmin))
      .send({ ulbId: j.ulbId, number: 50, name: 'Shanti Nagar', boundary }).expect(201);
    await ctx.http().post(api('/masters/wards')).set(bearer(subAdmin)).send({ ulbId: j.ulbId, number: 50 }).expect(409);
    await ctx.http().post(api('/masters/wards')).set(bearer(subAdmin)).send({ ulbId: other.ulbId, number: 51 }).expect(403);
    // self-intersecting "bow-tie" polygon is rejected by PostGIS validation
    const bowtie = { type: 'Polygon', coordinates: [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]] };
    await ctx.http().patch(api(`/masters/wards/${created.body.id}`)).set(bearer(subAdmin)).send({ boundary: bowtie }).expect(400);
  });

  describe('ward boundaries must not overlap within a ULB', () => {
    let k: Jurisdiction;
    let lat: number;
    let lng: number;
    const ward = (number: number, boundary: object) =>
      ctx.http().post(api('/masters/wards')).set(bearer(subAdmin)).send({ ulbId: k.ulbId, number, boundary });
    beforeAll(async () => {
      // Two adjacent 0.01° (~1.1 km) wards, numbered 1 and 2, in a fresh region of the Sub Admin's ULB.
      k = await createJurisdiction(ctx.ds);
      await ctx.ds.query(`UPDATE wards SET ulb_id = $1, number = number + 900 WHERE id = ANY($2)`, [j.ulbId, k.wards.map((w) => w.id)]);
      k = { ...k, ulbId: j.ulbId };
      ({ lat, lng } = { lat: k.wards[0].center.lat - 0.005, lng: k.wards[0].center.lng - 0.005 });
    });

    it('refuses a boundary covering part of another ward and says which', async () => {
      const res = await ward(960, square(lat, lng + 0.005)).expect(400);
      expect(res.body.message).toMatch(/overlaps ward 901 \([\d,]+ m²\), ward 902 \([\d,]+ m²\)/);
      expect(await ctx.ds.query(`SELECT 1 FROM wards WHERE ulb_id = $1 AND number = '960'`, [j.ulbId])).toEqual([]);
    });

    it('accepts wards that only share an edge, or overlap by a hand-drawing sliver', async () => {
      await ward(961, square(lat, lng + 0.02)).expect(201); // shares ward 902's east edge
      // ~0.05 m x 1.1 km ≈ 60 m² over ward 961: under the 100 m² tolerance.
      await ward(962, square(lat, lng + 0.03 - 0.0000005)).expect(201);
    });

    it('a new boundary on an existing ward is checked too, and a refused change is rolled back', async () => {
      const [w901] = await ctx.ds.query(`SELECT id, ST_AsText(geom) AS geom FROM wards WHERE ulb_id = $1 AND number = '901'`, [j.ulbId]);
      await ctx.http().patch(api(`/masters/wards/${w901.id}`)).set(bearer(subAdmin)).send({ boundary: square(lat, lng + 0.002) }).expect(400);
      const [after] = await ctx.ds.query(`SELECT ST_AsText(geom) AS geom FROM wards WHERE id = $1`, [w901.id]);
      expect(after.geom).toBe(w901.geom);
    });

    it('inactive wards do not block, but switching one back on is checked', async () => {
      const w902 = k.wards[1].id;
      await ctx.http().patch(api(`/masters/wards/${w902}`)).set(bearer(subAdmin)).send({ active: false }).expect(200);
      await ward(963, square(lat, lng + 0.01)).expect(201); // exactly where the inactive ward 902 was
      await ctx.http().patch(api(`/masters/wards/${w902}`)).set(bearer(subAdmin)).send({ active: true }).expect(400);
      const [{ active }] = await ctx.ds.query(`SELECT active FROM wards WHERE id = $1`, [w902]);
      expect(active).toBe(false);
    });

    it('where legacy wards overlap, GPS lookup always picks the same ward', async () => {
      // Data loaded before this check could still overlap: the answer must not change between calls.
      const [{ id: a }] = await ctx.ds.query(
        `INSERT INTO wards (ulb_id, number, geom) VALUES ($1, '970', ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($2), 4326))) RETURNING id`,
        [j.ulbId, JSON.stringify(square(lat + 0.03, lng))],
      );
      const [{ id: b }] = await ctx.ds.query(
        `INSERT INTO wards (ulb_id, number, geom) VALUES ($1, '971', ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($2), 4326))) RETURNING id`,
        [j.ulbId, JSON.stringify(square(lat + 0.03, lng))],
      );
      const expected = [a, b].sort()[0];
      for (let i = 0; i < 5; i++) {
        const res = await ctx.http().get(api('/masters/locate')).query({ lat: lat + 0.035, lng: lng + 0.005 }).set(bearer(subAdmin)).expect(200);
        expect(res.body.wardId).toBe(expected);
      }
    });
  });

  it('Sub Admin creates an area with wards and a supervisor of the same ULB', async () => {
    const sup = await createUser(ctx, Role.SUPERVISOR, j);
    const otherSup = await createUser(ctx, Role.SUPERVISOR, other);
    const res = await ctx.http().post(api('/masters/areas')).set(bearer(subAdmin))
      .send({ ulbId: j.ulbId, name: 'Area B', supervisorId: sup.id, wardIds: [j.wards[1].id] }).expect(201);
    const areas = await ctx.http().get(api(`/masters/ulbs/${j.ulbId}/areas`)).set(bearer(subAdmin)).expect(200);
    expect(areas.body.find((a: { id: string }) => a.id === res.body.id)).toEqual(
      expect.objectContaining({ supervisorId: sup.id, wardIds: [j.wards[1].id] }),
    );
    await ctx.http().patch(api(`/masters/areas/${res.body.id}`)).set(bearer(subAdmin)).send({ supervisorId: otherSup.id }).expect(400);
    await ctx.http().patch(api(`/masters/areas/${res.body.id}`)).set(bearer(subAdmin)).send({ wardIds: [other.wards[0].id] }).expect(400);
    // undo so other tests see ward 2 without an area
    await ctx.http().patch(api(`/masters/areas/${res.body.id}`)).set(bearer(subAdmin)).send({ wardIds: [] }).expect(200);
  });

  it('only Web Admin changes complaint-type SLAs', async () => {
    const types = (await ctx.http().get(api('/masters/complaint-types'))).body;
    const other = types.find((t: { code: string }) => t.code === 'OTHER');
    await ctx.http().patch(api(`/masters/complaint-types/${other.id}`)).set(bearer(subAdmin)).send({ slaHours: 10 }).expect(403);
    await ctx.http().patch(api(`/masters/complaint-types/${other.id}`)).set(bearer(webAdmin)).send({ slaHours: 72 }).expect(200);
  });

  it('ward boundaries as GeoJSON for maps, scoped; inactive types listed for Web Admin', async () => {
    const fc = await ctx.http().get(api(`/masters/ulbs/${j.ulbId}/boundaries`)).set(bearer(subAdmin)).expect(200);
    expect(fc.body.type).toBe('FeatureCollection');
    expect(fc.body.features[0]).toEqual(expect.objectContaining({ type: 'Feature', geometry: expect.objectContaining({ type: 'MultiPolygon' }) }));
    await ctx.http().get(api(`/masters/ulbs/${other.ulbId}/boundaries`)).set(bearer(subAdmin)).expect(403);
    const sup = await tokenFor(ctx, await createUser(ctx, Role.SUPERVISOR, j));
    await ctx.http().get(api(`/masters/ulbs/${j.ulbId}/boundaries`)).set(bearer(sup)).expect(200);
    await ctx.http().get(api(`/masters/ulbs/${other.ulbId}/boundaries`)).set(bearer(sup)).expect(403);
    const all = await ctx.http().get(api('/masters/complaint-types/all')).set(bearer(webAdmin)).expect(200);
    expect(all.body.length).toBeGreaterThanOrEqual(8);
    await ctx.http().get(api('/masters/complaint-types/all')).set(bearer(subAdmin)).expect(403);
  });
});
