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
