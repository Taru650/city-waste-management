import ExcelJS from 'exceljs';
import { randomInt } from 'crypto';
import { Role } from '../src/common/enums';
import { api, bearer, createJurisdiction, createTestApp, createUser, Jurisdiction, TestCtx, TestUser, tokenFor } from './helpers';

/**
 * Known data, exact numbers. Times are IST. Range 2026-10-01..2026-10-03.
 *  C1 filed 01 10:00, resolved 01 20:00 (10 h, SLA met), closed, rating 5
 *  C2 filed 01 10:00, resolved 03 10:00 (48 h, SLA missed), closed, rating 2
 *  C3 filed 02 09:00, assigned, still open and past SLA (area of supervisor A)
 *  C4 filed 03 09:00, rejected 03 10:00
 *  X  filed 01 10:00 in another district (must never appear)
 */
describe('Reports (M5/M6)', () => {
  let ctx: TestCtx;
  let j: Jurisdiction;
  let other: Jurisdiction;
  let typeId: string;
  let supervisor: TestUser;
  let token: Record<string, string>;
  const ids: Record<string, string> = {};
  const range = { from: '2026-10-01', to: '2026-10-03' };

  const ist = (s: string) => `${s}+05:30`;

  async function insert(
    jur: Jurisdiction, key: string,
    o: { filed: string; status: string; supervisorId?: string; events: [string, string, string | null][]; resolved?: string; closed?: string; rating?: number; description?: string },
  ) {
    const citizen = await createUser(ctx, Role.CITIZEN, jur);
    const [row] = await ctx.ds.query(
      `INSERT INTO complaints (complaint_no, citizen_id, district_id, ulb_id, ward_id, area_id, ward_source, type_id, description,
                               location, status, supervisor_id, sla_due_at, resolved_at, closed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'GPS', $7, $8, ST_SetSRID(ST_MakePoint($10, $9), 4326), $11, $12,
               $13::timestamptz + interval '24 hours', $14, $15, $13)
       RETURNING id`,
      [
        String(randomInt(1e9)).padStart(9, '0') + String(randomInt(1e9)).padStart(9, '0'), citizen.id, jur.districtId, jur.ulbId,
        jur.wards[0].id, jur.areaId, typeId, o.description ?? 'Garbage heap near the market', jur.wards[0].center.lat, jur.wards[0].center.lng,
        o.status, o.supervisorId ?? null, ist(o.filed), o.resolved ? ist(o.resolved) : null, o.closed ? ist(o.closed) : null,
      ],
    );
    for (const [action, to, at] of o.events) {
      await ctx.ds.query(`INSERT INTO complaint_events (complaint_id, action, to_status, created_at) VALUES ($1, $2, $3, $4)`, [row.id, action, to, ist(at!)]);
    }
    if (o.rating) await ctx.ds.query(`INSERT INTO feedback (complaint_id, citizen_id, rating) VALUES ($1, $2, $3)`, [row.id, citizen.id, o.rating]);
    ids[key] = row.id;
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    j = await createJurisdiction(ctx.ds);
    other = await createJurisdiction(ctx.ds);
    typeId = (await ctx.http().get(api('/masters/complaint-types'))).body.find((t: { code: string }) => t.code === 'GARBAGE_HEAP').id;
    supervisor = await createUser(ctx, Role.SUPERVISOR, j);
    await ctx.ds.query(`UPDATE areas SET supervisor_id = $1 WHERE id = $2`, [supervisor.id, j.areaId]);

    await insert(j, 'C1', { filed: '2026-10-01 10:00', status: 'CLOSED', resolved: '2026-10-01 20:00', closed: '2026-10-01 21:00', rating: 5,
      events: [['CREATE', 'PENDING', '2026-10-01 10:00'], ['RESOLVE', 'RESOLVED', '2026-10-01 20:00'], ['CLOSE', 'CLOSED', '2026-10-01 21:00']] });
    await insert(j, 'C2', { filed: '2026-10-01 10:00', status: 'CLOSED', resolved: '2026-10-03 10:00', closed: '2026-10-03 11:00', rating: 2,
      description: '=HYPERLINK("http://evil.example","click")',
      events: [['CREATE', 'PENDING', '2026-10-01 10:00'], ['RESOLVE', 'RESOLVED', '2026-10-03 10:00'], ['CLOSE', 'CLOSED', '2026-10-03 11:00']] });
    await insert(j, 'C3', { filed: '2026-10-02 09:00', status: 'ASSIGNED', supervisorId: supervisor.id,
      events: [['CREATE', 'PENDING', '2026-10-02 09:00'], ['ROUTE', 'ASSIGNED', '2026-10-02 09:00']] });
    await insert(j, 'C4', { filed: '2026-10-03 09:00', status: 'REJECTED', closed: '2026-10-03 10:00',
      events: [['CREATE', 'PENDING', '2026-10-03 09:00'], ['REJECT', 'REJECTED', '2026-10-03 10:00']] });
    await insert(other, 'X', { filed: '2026-10-01 10:00', status: 'PENDING', events: [['CREATE', 'PENDING', '2026-10-01 10:00']] });

    token = {
      subAdmin: await tokenFor(ctx, await createUser(ctx, Role.SUB_ADMIN, j)),
      districtAdmin: await tokenFor(ctx, await createUser(ctx, Role.DISTRICT_ADMIN, j)),
      otherSubAdmin: await tokenFor(ctx, await createUser(ctx, Role.SUB_ADMIN, other)),
      supervisor: await tokenFor(ctx, supervisor),
      worker: await tokenFor(ctx, await createUser(ctx, Role.WORKER, j)),
      citizen: await tokenFor(ctx, await createUser(ctx, Role.CITIZEN, j)),
    };
  });
  afterAll(() => ctx.app.close());

  const get = (path: string, who: string, query: object = range) => ctx.http().get(api(path)).query(query).set(bearer(token[who]));

  it('summary: counts, disposal times, SLA compliance and satisfaction', async () => {
    const res = await get('/reports/summary', 'subAdmin').expect(200);
    expect(res.body.counts).toEqual({ received: 4, resolved: 2, pending: 1, rejected: 1, duplicate: 0, overdue: 1, escalated: 0 });
    expect(res.body.disposal).toEqual({
      disposalRatePct: 75, avgHours: 29, medianHours: 29, p90Hours: 44.2, avgAssignmentHours: null, slaCompliancePct: 50,
    });
    expect(res.body.quality).toEqual(expect.objectContaining({ feedbacks: 2, avgRating: 3.5, satisfiedPct: 50, reopenRatePct: 0, wardMismatchPct: 0 }));
    expect(res.body.byType).toEqual([expect.objectContaining({ code: 'GARBAGE_HEAP', count: 4 })]);
  });

  it('trend: date-wise received, resolved and pending at day end (rebuilt from history)', async () => {
    const res = await get('/reports/trend', 'subAdmin').expect(200);
    expect(res.body.rows).toEqual([
      { date: '2026-10-01', received: 2, resolved: 1, pending: 1 },
      { date: '2026-10-02', received: 1, resolved: 0, pending: 2 },
      { date: '2026-10-03', received: 1, resolved: 1, pending: 1 },
    ]);
  });

  it('ageing: current pendency in age buckets, grouped', async () => {
    const res = await get('/reports/ageing', 'subAdmin', { groupBy: 'supervisor' }).expect(200);
    expect(res.body.rows).toEqual([expect.objectContaining({ key: supervisor.id, total: 1, d15_plus: 1, overdue: 1 })]);
  });

  it('breakdown by ULB, type and worker', async () => {
    const byUlb = await get('/reports/breakdown', 'subAdmin', { ...range, by: 'ulb' }).expect(200);
    expect(byUlb.body.rows).toEqual([expect.objectContaining({
      key: j.ulbId, received: 4, resolved: 2, pending: 1, overdue: 1, rejectedOrDuplicate: 1, avgDisposalHours: 29, slaCompliancePct: 50, avgRating: 3.5,
    })]);
    const byWorker = await get('/reports/breakdown', 'subAdmin', { ...range, by: 'worker' }).expect(200);
    expect(byWorker.body.rows).toEqual([expect.objectContaining({ key: null, label: 'Unassigned', received: 4 })]);
    await get('/reports/breakdown', 'subAdmin', { ...range, by: 'citizen' }).expect(400);
  });

  it('hotspots aggregate locations on a grid', async () => {
    const res = await get('/reports/hotspots', 'subAdmin').expect(200);
    expect(res.body.points).toEqual([expect.objectContaining({ total: 4, open: 1 })]);
  });

  describe('scope', () => {
    it('another ULB\'s Sub Admin sees none of this data, even when filtering by this ULB', async () => {
      const own = await get('/reports/summary', 'otherSubAdmin').expect(200);
      expect(own.body.counts.received).toBe(1); // only X
      const probing = await get('/reports/summary', 'otherSubAdmin', { ...range, ulbId: j.ulbId }).expect(200);
      expect(probing.body.counts.received).toBe(0);
    });

    it('a supervisor sees only complaints of their area', async () => {
      const res = await get('/reports/summary', 'supervisor').expect(200);
      expect(res.body.counts.received).toBe(4); // all four are in Area A (area_id), C3 also assigned to them
      const [area2] = await ctx.ds.query(`INSERT INTO areas (ulb_id, name) VALUES ($1, 'Area Z') RETURNING id`, [j.ulbId]);
      await ctx.ds.query(`UPDATE complaints SET area_id = $1 WHERE id = $2`, [area2.id, ids.C4]);
      const after = await get('/reports/summary', 'supervisor').expect(200);
      expect(after.body.counts.received).toBe(3);
      await ctx.ds.query(`UPDATE complaints SET area_id = $1 WHERE id = $2`, [j.areaId, ids.C4]);
    });

    it('workers and citizens cannot use reports', async () => {
      await get('/reports/summary', 'worker').expect(403);
      await get('/reports/export', 'citizen', { ...range, report: 'complaints' }).expect(403);
    });

    it('rejects bad ranges', async () => {
      await get('/reports/summary', 'subAdmin', { from: '2024-01-01', to: '2026-10-03' }).expect(400);
      await get('/reports/summary', 'subAdmin', { from: '2026-10-05', to: '2026-10-03' }).expect(400);
      await get('/reports/summary', 'subAdmin', { from: '2026-13-01' }).expect(400);
      await get('/reports/summary', 'subAdmin', { from: "2026-10-01' OR '1'='1" }).expect(400);
    });
  });

  describe('export', () => {
    it('Excel export of complaints: no citizen identity, formulas neutralised, audited', async () => {
      const res = await get('/reports/export', 'subAdmin', { ...range, report: 'complaints', format: 'xlsx' })
        .buffer(true).parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(res.headers['content-disposition']).toMatch(/attachment; filename="complaints-\d{4}-\d{2}-\d{2}\.xlsx"/);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(res.body);
      const ws = wb.worksheets[0];
      expect(ws.getRow(4).values).toEqual(expect.arrayContaining(['Complaint no.', 'Status', 'Description']));
      const values = JSON.stringify(ws.getSheetValues());
      expect(ws.rowCount).toBe(4 + 4);
      expect(values).toContain("'=HYPERLINK");
      expect(values).not.toMatch(/"=HYPERLINK/);
      expect(values).not.toMatch(/Test CITIZEN|@example\.gov\.in/);
      const [audit] = await ctx.ds.query(`SELECT meta FROM audit_logs WHERE action = 'REPORT_EXPORTED' ORDER BY id DESC LIMIT 1`);
      expect(audit.meta).toEqual(expect.objectContaining({ format: 'xlsx', rows: 4 }));
    });

    it('CSV export of the trend with BOM', async () => {
      const res = await get('/reports/export', 'subAdmin', { ...range, report: 'trend', format: 'csv' }).expect(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.text.replace(/^\uFEFF/, '').split('\r\n')).toEqual([
        'Date,Received,Resolved,Pending at day end', '2026-10-01,2,1,1', '2026-10-02,1,0,2', '2026-10-03,1,1,1',
      ]);
    });
  });
});
