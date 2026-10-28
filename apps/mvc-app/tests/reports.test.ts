import ExcelJS from 'exceljs';
import { randomInt } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { GET as summaryRoute } from '@/app/api/v1/reports/summary/route';
import { GET as ageingRoute } from '@/app/api/v1/reports/ageing/route';
import { GET as trendRoute } from '@/app/api/v1/reports/trend/route';
import { GET as breakdownRoute } from '@/app/api/v1/reports/breakdown/route';
import { GET as hotspotsRoute } from '@/app/api/v1/reports/hotspots/route';
import { GET as exportRoute } from '@/app/api/v1/reports/export/route';
import { GET as complaintsRoute } from '@/app/api/v1/complaints/route';
import { exportSlots } from '@/lib/exportSlots';
import { newId } from '@/lib/ids';
import { toCsv } from '@/lib/reportExport';
import { resolveRange, safeCell, todayIst } from '@/lib/reportRange';
import { call, callBinary, createJurisdiction, createUser, db, loginAs, one, query, run, setupTestEnvironment, type Jurisdiction, type TestUser } from './helpers';

setupTestEnvironment();

const ist = (s: string) => new Date(`${s.replace(' ', 'T')}:00+05:30`);

let j: Jurisdiction;
let other: Jurisdiction;
let typeId: string;
let supervisor: TestUser;
let nextNo = 1;
const ids: Record<string, string> = {};
const token: Record<string, string> = {};
const range = { from: '2026-10-01', to: '2026-10-03' };

async function insertComplaint(
  jur: Jurisdiction,
  key: string | null,
  o: { filed: Date; status: string; supervisorId?: string; description?: string; mismatch?: boolean; dueHours?: number; resolved?: Date; closed?: Date; assigned?: Date },
): Promise<string> {
  const citizen = await createUser('CITIZEN', jur);
  const id = newId();
  const c = jur.wards[0].center;
  nextNo += 1;
  const no = `${String(8_000_000_000 + nextNo)}${String(randomInt(1e8)).padStart(8, '0')}`.slice(0, 18);
  await run(
    db(),
    `INSERT INTO complaints (id, complaint_no, citizen_id, district_id, ulb_id, ward_id, area_id, ward_source, ward_mismatch, type_id, description, location,
                             status, supervisor_id, sla_due_at, resolved_at, closed_at, assigned_at, created_at)
     VALUES (?,?,?,?,?,?,?, 'GPS', ?, ?, ?, ST_PointFromText(?, 4326, 'axis-order=long-lat'), ?,?,?,?,?,?,?)`,
    [
      id, no, citizen.id, jur.districtId, jur.ulbId, jur.wards[0].id, jur.areaId, o.mismatch ? 1 : 0, typeId, o.description ?? 'Garbage heap near the market',
      `POINT(${c.lng} ${c.lat})`, o.status, o.supervisorId ?? null, new Date(o.filed.getTime() + (o.dueHours ?? 24) * 3_600_000), o.resolved ?? null, o.closed ?? null,
      o.assigned ?? null, o.filed,
    ],
  );
  if (key) ids[key] = id;
  return id;
}
/** Events chained the way the state machine writes them (the trend report relies on from_status). */
async function events(complaintId: string, steps: [string, string, Date][]) {
  let prev: string | null = null;
  for (const [action, to, at] of steps) {
    await run(db(), `INSERT INTO complaint_events (complaint_id, action, from_status, to_status, created_at) VALUES (?,?,?,?,?)`, [complaintId, action, prev, to, at]);
    prev = to;
  }
}
const rate = async (complaintId: string, rating: number) => {
  const u = await createUser('CITIZEN', j);
  await run(db(), `INSERT INTO feedback (complaint_id, citizen_id, rating) VALUES (?,?,?)`, [complaintId, u.id, rating]);
};
const get = (route: typeof summaryRoute, path: string, who: string, query: Record<string, string | undefined> = range) =>
  call(route, 'GET', path, { token: token[who], query: query as Record<string, string> });

/**
 * Known data, exact numbers (the same scenario the verified API is tested with). Times are IST, range 2026-10-01..03.
 *  C1 filed 01 10:00, resolved 01 20:00 (10 h, SLA met), closed, rating 5
 *  C2 filed 01 10:00, resolved 03 10:00 (48 h, SLA missed), closed, rating 2
 *  C3 filed 02 09:00, assigned, still open and past SLA (area of supervisor A)
 *  C4 filed 03 09:00, rejected 03 10:00
 *  X  filed 01 10:00 in another district (must never appear)
 */
beforeAll(async () => {
  j = await createJurisdiction();
  other = await createJurisdiction();
  typeId = (await one(db(), `SELECT id FROM complaint_types WHERE code = 'GARBAGE_HEAP'`))!.id;
  supervisor = await createUser('SUPERVISOR', j);
  await run(db(), `UPDATE areas SET supervisor_id = ? WHERE id = ?`, [supervisor.id, j.areaId]);

  const c1 = await insertComplaint(j, 'C1', { filed: ist('2026-10-01 10:00'), status: 'CLOSED', resolved: ist('2026-10-01 20:00'), closed: ist('2026-10-01 21:00') });
  await events(c1, [['CREATE', 'PENDING', ist('2026-10-01 10:00')], ['RESOLVE', 'RESOLVED', ist('2026-10-01 20:00')], ['CLOSE', 'CLOSED', ist('2026-10-01 21:00')]]);
  await rate(c1, 5);
  const c2 = await insertComplaint(j, 'C2', { filed: ist('2026-10-01 10:00'), status: 'CLOSED', resolved: ist('2026-10-03 10:00'), closed: ist('2026-10-03 11:00'), description: '=HYPERLINK("http://evil.example","click")' });
  await events(c2, [['CREATE', 'PENDING', ist('2026-10-01 10:00')], ['RESOLVE', 'RESOLVED', ist('2026-10-03 10:00')], ['CLOSE', 'CLOSED', ist('2026-10-03 11:00')]]);
  await rate(c2, 2);
  const c3 = await insertComplaint(j, 'C3', { filed: ist('2026-10-02 09:00'), status: 'ASSIGNED', supervisorId: supervisor.id });
  await events(c3, [['CREATE', 'PENDING', ist('2026-10-02 09:00')], ['ROUTE', 'ASSIGNED', ist('2026-10-02 09:00')]]);
  const c4 = await insertComplaint(j, 'C4', { filed: ist('2026-10-03 09:00'), status: 'REJECTED', closed: ist('2026-10-03 10:00') });
  await events(c4, [['CREATE', 'PENDING', ist('2026-10-03 09:00')], ['REJECT', 'REJECTED', ist('2026-10-03 10:00')]]);
  const x = await insertComplaint(other, 'X', { filed: ist('2026-10-01 10:00'), status: 'PENDING' });
  await events(x, [['CREATE', 'PENDING', ist('2026-10-01 10:00')]]);

  const mk = async (key: string, role: Parameters<typeof createUser>[0], jur: Jurisdiction) => (token[key] = await loginAs(await createUser(role, jur)));
  await mk('subAdmin', 'SUB_ADMIN', j);
  await mk('districtAdmin', 'DISTRICT_ADMIN', j);
  await mk('otherSubAdmin', 'SUB_ADMIN', other);
  await mk('worker', 'WORKER', j);
  await mk('citizen', 'CITIZEN', j);
  token.supervisor = await loginAs(supervisor);
  token.web = await loginAs(await createUser('WEB_ADMIN', j));
});

describe('summary', () => {
  it('counts, disposal times, SLA compliance and satisfaction, to the decimal', async () => {
    const res = await get(summaryRoute, '/x', 'subAdmin');
    expect(res.status).toBe(200);
    expect(res.body.range).toEqual({ from: '2026-10-01', to: '2026-10-03', days: 3 });
    expect(res.body.counts).toEqual({ received: 4, resolved: 2, pending: 1, rejected: 1, duplicate: 0, overdue: 1, escalated: 0 });
    expect(res.body.disposal).toEqual({ disposalRatePct: 75, avgHours: 29, medianHours: 29, p90Hours: 44.2, avgAssignmentHours: null, slaCompliancePct: 50 });
    expect(res.body.quality).toEqual(expect.objectContaining({ feedbacks: 2, avgRating: 3.5, satisfiedPct: 50, reopenRatePct: 0, wardMismatchPct: 0, resolutionProofs: 0, proofsOutsideGeofencePct: null }));
    expect(res.body.byType).toEqual([expect.objectContaining({ code: 'GARBAGE_HEAP', count: 4 })]);
  });

  it('an empty window answers with zeros and nulls, not errors', async () => {
    const res = await get(summaryRoute, '/x', 'subAdmin', { from: '2025-01-01', to: '2025-01-05' });
    expect(res.status).toBe(200);
    expect(res.body.counts.received).toBe(0);
    expect(res.body.disposal).toEqual({ disposalRatePct: null, avgHours: null, medianHours: null, p90Hours: null, avgAssignmentHours: null, slaCompliancePct: null });
    expect(res.body.byType).toEqual([]);
  });

  it('percentiles interpolate like PostgreSQL percentile_cont, for odd and even counts and a single value', async () => {
    const jur = await createJurisdiction();
    const t = await loginAs(await createUser('SUB_ADMIN', jur));
    const base = ist('2026-09-10 08:00');
    const hours = [1, 2, 3, 4, 10];
    for (const h of hours) await insertComplaint(jur, null, { filed: base, status: 'RESOLVED', resolved: new Date(base.getTime() + h * 3_600_000) });
    const five = (await call(summaryRoute, 'GET', '/x', { token: t, query: { from: '2026-09-10', to: '2026-09-10' } })).body.disposal;
    expect(five).toEqual(expect.objectContaining({ avgHours: 4, medianHours: 3, p90Hours: 7.6 })); // 4 + 0.6 * (10 - 4)
    await insertComplaint(jur, null, { filed: base, status: 'RESOLVED', resolved: new Date(base.getTime() + 20 * 3_600_000) });
    const six = (await call(summaryRoute, 'GET', '/x', { token: t, query: { from: '2026-09-10', to: '2026-09-10' } })).body.disposal;
    expect(six.medianHours).toBe(3.5); // (3 + 4) / 2
    const solo = await createJurisdiction();
    const ts = await loginAs(await createUser('SUB_ADMIN', solo));
    await insertComplaint(solo, null, { filed: base, status: 'RESOLVED', resolved: new Date(base.getTime() + 6 * 3_600_000) });
    expect((await call(summaryRoute, 'GET', '/x', { token: ts, query: { from: '2026-09-10', to: '2026-09-10' } })).body.disposal).toEqual(expect.objectContaining({ medianHours: 6, p90Hours: 6 }));
  });

  it('counts escalations, reopens, ward mismatches and assignment time', async () => {
    const jur = await createJurisdiction();
    const t = await loginAs(await createUser('SUB_ADMIN', jur));
    const base = ist('2026-09-12 08:00');
    const a = await insertComplaint(jur, null, { filed: base, status: 'RESOLVED', resolved: new Date(base.getTime() + 5 * 3_600_000), assigned: new Date(base.getTime() + 2 * 3_600_000), mismatch: true });
    await run(db(), `UPDATE complaints SET escalated = 1, reopen_count = 1 WHERE id = ?`, [a]);
    await insertComplaint(jur, null, { filed: base, status: 'PENDING', assigned: new Date(base.getTime() + 4 * 3_600_000) });
    const r = (await call(summaryRoute, 'GET', '/x', { token: t, query: { from: '2026-09-12', to: '2026-09-12' } })).body;
    expect(r.counts).toEqual(expect.objectContaining({ received: 2, resolved: 1, escalated: 1 }));
    expect(r.disposal.avgAssignmentHours).toBe(3);
    expect(r.quality).toEqual(expect.objectContaining({ reopenRatePct: 100, wardMismatchPct: 50 }));
  });
});

describe('trend', () => {
  it('date-wise received, resolved and pending at day end, rebuilt from history', async () => {
    const res = await get(trendRoute, '/x', 'subAdmin');
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([
      { date: '2026-10-01', received: 2, resolved: 1, pending: 1 },
      { date: '2026-10-02', received: 1, resolved: 0, pending: 2 },
      { date: '2026-10-03', received: 1, resolved: 1, pending: 1 },
    ]);
  });
});

describe('ageing and breakdown', () => {
  it('current pendency in age buckets, grouped', async () => {
    const res = await get(ageingRoute, '/x', 'subAdmin', { groupBy: 'supervisor' });
    expect(res.body.buckets).toEqual(['d0_1', 'd1_3', 'd3_7', 'd7_15', 'd15_plus']);
    expect(res.body.rows).toEqual([expect.objectContaining({ key: supervisor.id, total: 1, d15_plus: 1, overdue: 1 })]);
    const all = await get(ageingRoute, '/x', 'subAdmin', {});
    expect(all.body.rows).toEqual([expect.objectContaining({ key: 'all', label: 'All', total: expect.any(Number) })]);
    for (const by of ['district', 'ulb', 'ward', 'type', 'none']) expect((await get(ageingRoute, '/x', 'subAdmin', { groupBy: by })).status, by).toBe(200);
  });

  it('breakdown by ULB, type, worker and every other dimension', async () => {
    const byUlb = await get(breakdownRoute, '/x', 'subAdmin', { ...range, by: 'ulb' });
    expect(byUlb.body.rows).toEqual([expect.objectContaining({ key: j.ulbId, received: 4, resolved: 2, pending: 1, overdue: 1, rejectedOrDuplicate: 1, avgDisposalHours: 29, slaCompliancePct: 50, avgRating: 3.5, reopenRatePct: 0 })]);
    const byWorker = await get(breakdownRoute, '/x', 'subAdmin', { ...range, by: 'worker' });
    expect(byWorker.body.rows).toEqual([expect.objectContaining({ key: null, label: 'Unassigned', received: 4 })]);
    const byWard = await get(breakdownRoute, '/x', 'subAdmin', { ...range, by: 'ward' });
    expect(byWard.body.rows[0].label).toMatch(/ — Ward 1$/);
    for (const by of ['district', 'type', 'supervisor']) expect((await get(breakdownRoute, '/x', 'subAdmin', { ...range, by })).status, by).toBe(200);
    expect((await get(breakdownRoute, '/x', 'subAdmin', { ...range, by: 'citizen' })).status).toBe(400);
    expect((await get(breakdownRoute, '/x', 'subAdmin', { ...range, by: "ulb' OR 1=1 --" })).status).toBe(400);
    expect((await get(ageingRoute, '/x', 'subAdmin', { groupBy: 'citizen' })).status).toBe(400);
  });

  it('hotspots aggregate locations on a grid', async () => {
    const res = await get(hotspotsRoute, '/x', 'subAdmin');
    expect(res.body.points).toEqual([expect.objectContaining({ total: 4, open: 1 })]);
    expect(res.body.points[0].lat).toBeCloseTo(j.wards[0].center.lat, 2);
    expect(res.body.points[0].lng).toBeCloseTo(j.wards[0].center.lng, 2);
  });

  it('filters by ward, type, ULB and district', async () => {
    const by = async (q: Record<string, string>) => (await get(summaryRoute, '/x', 'subAdmin', { ...range, ...q })).body.counts.received;
    expect(await by({ wardId: j.wards[0].id })).toBe(4);
    expect(await by({ wardId: j.wards[1].id })).toBe(0);
    expect(await by({ typeId })).toBe(4);
    expect(await by({ typeId: newId() })).toBe(0);
    expect(await by({ ulbId: j.ulbId })).toBe(4);
    expect(await by({ districtId: j.districtId })).toBe(4);
    expect(await by({ eventZoneId: newId() })).toBe(0);
    for (const bad of [{ wardId: 'x' }, { typeId: "1' OR '1'='1" }, { districtId: '1' }]) expect((await get(summaryRoute, '/x', 'subAdmin', { ...range, ...bad })).status, JSON.stringify(bad)).toBe(400);
  });
});

describe('scope: a report never shows more than the inbox', () => {
  it("another ULB's Sub Admin sees none of this data, even when filtering by this ULB", async () => {
    expect((await get(summaryRoute, '/x', 'otherSubAdmin')).body.counts.received).toBe(1); // only X
    expect((await get(summaryRoute, '/x', 'otherSubAdmin', { ...range, ulbId: j.ulbId })).body.counts.received).toBe(0);
    expect((await get(trendRoute, '/x', 'otherSubAdmin', { ...range, ulbId: j.ulbId })).body.rows.every((r: { received: number; pending: number }) => r.received === 0 && r.pending === 0)).toBe(true);
    expect((await get(breakdownRoute, '/x', 'otherSubAdmin', { ...range, by: 'ulb' })).body.rows.map((r: { key: string }) => r.key)).toEqual([other.ulbId]);
  });

  it('a supervisor sees only complaints of the area they run', async () => {
    expect((await get(summaryRoute, '/x', 'supervisor')).body.counts.received).toBe(4);
    const area2 = newId();
    await run(db(), `INSERT INTO areas (id, ulb_id, name) VALUES (?, ?, 'Area Z')`, [area2, j.ulbId]);
    await run(db(), `UPDATE complaints SET area_id = ? WHERE id = ?`, [area2, ids.C4]);
    try {
      expect((await get(summaryRoute, '/x', 'supervisor')).body.counts.received).toBe(3);
    } finally {
      await run(db(), `UPDATE complaints SET area_id = ? WHERE id = ?`, [j.areaId, ids.C4]);
    }
  });

  it('every figure matches what the same person can list in the inbox', async () => {
    // IST window as instants, so the inbox filter and the report cover the same complaints
    const win = { from: '2026-09-30T18:30:00Z', to: '2026-10-03T18:30:00Z' };
    for (const who of ['subAdmin', 'districtAdmin', 'supervisor', 'otherSubAdmin']) {
      const report = (await get(summaryRoute, '/x', who)).body.counts.received;
      const inbox = (await call(complaintsRoute, 'GET', '/x', { token: token[who], query: { ...win, pageSize: 1 } })).body.total;
      expect(report, who).toBe(inbox);
    }
    const web = (await get(summaryRoute, '/x', 'web')).body.counts.received;
    expect(web).toBeGreaterThanOrEqual(5); // sees both districts
  });

  it('workers and citizens cannot use reports; visitors are asked to sign in', async () => {
    for (const route of [summaryRoute, ageingRoute, trendRoute, breakdownRoute, hotspotsRoute]) {
      expect((await get(route, '/x', 'worker')).status).toBe(403);
      expect((await get(route, '/x', 'citizen')).status).toBe(403);
      expect((await call(route, 'GET', '/x', { query: range })).status).toBe(401);
    }
    expect((await get(exportRoute, '/x', 'citizen', { ...range, report: 'complaints' })).status).toBe(403);
  });

  it('rejects bad ranges and dates', async () => {
    for (const q of [{ from: '2024-01-01', to: '2026-10-03' }, { from: '2026-10-05', to: '2026-10-03' }, { from: '2026-13-01' }, { from: '2026-02-30', to: '2026-03-01' }, { from: "2026-10-01' OR '1'='1" }, { from: '1 Oct' }, { to: '2026/10/03' }]) {
      expect((await get(summaryRoute, '/x', 'subAdmin', q)).status, JSON.stringify(q)).toBe(400);
    }
    expect((await get(summaryRoute, '/x', 'subAdmin', { from: '2026-10-03', to: '2026-10-03' })).status).toBe(200);
    expect((await get(summaryRoute, '/x', 'subAdmin', { from: '2025-10-03', to: '2026-10-03' })).status).toBe(200); // 366 days
  });
});

describe('days are India days, not UTC days', () => {
  it('a complaint at 00:30 IST (previous evening in UTC) and one at 23:50 IST land on the right day, in every report', async () => {
    const jur = await createJurisdiction();
    const t = await loginAs(await createUser('SUB_ADMIN', jur));
    const early = await insertComplaint(jur, null, { filed: ist('2026-09-20 00:30'), status: 'PENDING' }); // 2026-09-19 19:00 UTC
    const late = await insertComplaint(jur, null, { filed: ist('2026-09-20 23:50'), status: 'PENDING' }); // 2026-09-20 18:20 UTC
    await events(early, [['CREATE', 'PENDING', ist('2026-09-20 00:30')]]);
    await events(late, [['CREATE', 'PENDING', ist('2026-09-20 23:50')]]);
    const q = (from: string, to: string) => ({ from, to });
    const received = async (route: typeof summaryRoute, from: string, to: string) => (await call(route, 'GET', '/x', { token: t, query: q(from, to) })).body;
    expect((await received(summaryRoute, '2026-09-20', '2026-09-20')).counts.received).toBe(2);
    expect((await received(summaryRoute, '2026-09-19', '2026-09-19')).counts.received).toBe(0);
    expect((await received(summaryRoute, '2026-09-21', '2026-09-21')).counts.received).toBe(0);
    const trend = (await received(trendRoute, '2026-09-19', '2026-09-21')).rows;
    expect(trend).toEqual([
      { date: '2026-09-19', received: 0, resolved: 0, pending: 0 },
      { date: '2026-09-20', received: 2, resolved: 0, pending: 2 },
      { date: '2026-09-21', received: 0, resolved: 0, pending: 2 },
    ]);
    expect((await received(breakdownRoute, '2026-09-20', '2026-09-20')).rows[0].received).toBe(2);
    expect((await received(hotspotsRoute, '2026-09-19', '2026-09-19')).points).toEqual([]);
    const csv = await callBinary(exportRoute, 'GET', '/x', { token: t, query: { from: '2026-09-20', to: '2026-09-20', report: 'complaints', format: 'csv' } });
    const lines = csv.bytes.toString('utf8').replace(/^﻿/, '').split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('2026-09-20 00:30'); // shown in India time
    expect(lines[2]).toContain('2026-09-20 23:50');
  });
});

describe('the trend report agrees with an independent calculation on messy histories', () => {
  const OPEN = ['PENDING', 'ASSIGNED', 'WORK_IN_PROGRESS', 'REOPENED'];
  let jur: Jurisdiction;
  let sub: string;

  beforeAll(async () => {
    jur = await createJurisdiction();
    sub = await loginAs(await createUser('SUB_ADMIN', jur));
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const H = 3_600_000;
    const base = Date.now() - 50 * 24 * H;
    for (let i = 0; i < 150; i++) {
      let t = base + rnd() * 48 * 24 * H;
      const filed = new Date(t);
      const steps: [string, string, Date][] = [];
      const push = (action: string, to: string) => steps.push([action, to, new Date(t)]);
      const next = () => (t = Math.min(t + (rnd() < 0.2 ? rnd() * 60_000 : rnd() * 3 * 24 * H), Date.now() - 60_000));
      push('CREATE', 'PENDING');
      next();
      push('ROUTE', 'ASSIGNED');
      let status = 'ASSIGNED';
      if (rnd() < 0.7) { next(); push('START', 'WORK_IN_PROGRESS'); status = 'WORK_IN_PROGRESS'; }
      const r = rnd();
      if (r < 0.15) { next(); push('REJECT', 'REJECTED'); status = 'REJECTED'; }
      else if (r < 0.85) {
        next(); push('RESOLVE', 'RESOLVED'); status = 'RESOLVED';
        const reopens = rnd() < 0.3 ? 1 + Math.floor(rnd() * 2) : 0;
        for (let k = 0; k < reopens; k++) {
          next(); push('REOPEN', 'REOPENED'); next(); push('ASSIGN', 'ASSIGNED'); status = 'ASSIGNED';
          if (rnd() < 0.8) { next(); push('RESOLVE', 'RESOLVED'); status = 'RESOLVED'; } else break;
        }
        if (status === 'RESOLVED' && rnd() < 0.6) { next(); push('CLOSE', 'CLOSED'); status = 'CLOSED'; }
        if (rnd() < 0.1) { next(); push('SLA_BREACH', status); } // timeline-only entry
      }
      const id = await insertComplaint(jur, null, { filed, status });
      await events(id, steps);
    }
  });

  /** Straight from the definition: pending at the end of a day = the last event before that moment leaves it open. */
  async function reference(from: string, to: string) {
    const rows = await query<{ complaint_id: string; action: string; to_status: string; created_at: Date; id: number }>(
      db(), `SELECT e.complaint_id, e.action, e.to_status, e.created_at, e.id FROM complaint_events e JOIN complaints c ON c.id = e.complaint_id WHERE c.ulb_id = ? ORDER BY e.id`, [jur.ulbId]);
    const created = await query<{ created_at: Date }>(db(), `SELECT created_at FROM complaints WHERE ulb_id = ?`, [jur.ulbId]);
    const byComplaint = new Map<string, typeof rows>();
    for (const e of rows) (byComplaint.get(e.complaint_id) ?? byComplaint.set(e.complaint_id, []).get(e.complaint_id)!).push(e);
    const out = [];
    for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d = new Date(d.getTime() + 86_400_000)) {
      const day = d.toISOString().slice(0, 10);
      const sod = new Date(`${day}T00:00:00+05:30`).getTime();
      const eod = sod + 86_400_000;
      let pending = 0;
      for (const list of byComplaint.values()) {
        const before = list.filter((e) => e.created_at.getTime() < eod);
        if (before.length && OPEN.includes(before[before.length - 1].to_status)) pending += 1;
      }
      out.push({
        date: day,
        received: created.filter((c) => c.created_at.getTime() >= sod && c.created_at.getTime() < eod).length,
        resolved: rows.filter((e) => e.action === 'RESOLVE' && e.created_at.getTime() >= sod && e.created_at.getTime() < eod).length,
        pending,
      });
    }
    return out;
  }

  it.each([
    ['the last 30 days', 30, 0],
    ['a window in the middle (open complaints carried in from before it)', 12, 20],
    ['a single day', 1, 5],
    ['a full year range', 200, 0],
  ])('%s', async (_name, length, endAgo) => {
    const day = (ago: number) => new Date(Date.now() - ago * 86_400_000 + 5.5 * 3_600_000).toISOString().slice(0, 10);
    const from = day(endAgo + length - 1);
    const to = day(endAgo);
    const expected = await reference(from, to);
    const actual = await call(trendRoute, 'GET', '/x', { token: sub, query: { from, to } });
    expect(actual.status).toBe(200);
    expect(actual.body.rows).toEqual(expected);
    if (length >= 12) expect(expected.some((r) => r.pending > 0)).toBe(true);
  });
});

describe('export', () => {
  const download = (who: string, q: Record<string, string>) => callBinary(exportRoute, 'GET', '/x', { token: token[who], query: { ...range, ...q } });

  it('Excel export of complaints: no citizen identity, formulas neutralised, audited', async () => {
    const res = await download('subAdmin', { report: 'complaints', format: 'xlsx' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="complaints-\d{4}-\d{2}-\d{2}\.xlsx"$/);
    expect(res.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.bytes as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    expect(ws.getRow(4).values).toEqual(expect.arrayContaining(['Complaint no.', 'Status', 'Description']));
    expect(ws.rowCount).toBe(4 + 4);
    const values = JSON.stringify(ws.getSheetValues());
    expect(values).toContain("'=HYPERLINK");
    expect(values).not.toMatch(/"=HYPERLINK/);
    expect(values).not.toMatch(/Test CITIZEN|@example\.gov\.in/);
    const dataRows = ws.getRows(5, 4)!.map((r) => r.values as unknown[]);
    expect(dataRows.map((r) => r[7])).toEqual(expect.arrayContaining(['CLOSED', 'ASSIGNED', 'REJECTED'])); // Status column
    const audit = (await one(db(), `SELECT meta FROM audit_logs WHERE action = 'REPORT_EXPORTED' ORDER BY id DESC LIMIT 1`))!;
    expect(audit.meta).toEqual(expect.objectContaining({ format: 'xlsx', rows: 4, filters: expect.objectContaining({ report: 'complaints' }) }));
  });

  it('CSV export of the trend, with a byte-order mark for Excel', async () => {
    const res = await download('subAdmin', { report: 'trend', format: 'csv' });
    expect(res.headers.get('content-type')).toMatch(/^text\/csv/);
    expect(res.bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(res.bytes.toString('utf8').replace(/^﻿/, '').split('\r\n')).toEqual([
      'Date,Received,Resolved,Pending at day end', '2026-10-01,2,1,1', '2026-10-02,1,0,2', '2026-10-03,1,1,1',
    ]);
  });

  it('breakdown and ageing exports, in both formats', async () => {
    for (const report of ['breakdown', 'ageing'] as const) {
      expect((await download('subAdmin', { report, format: 'csv' })).status, report).toBe(200);
      const xlsx = await download('districtAdmin', { report, format: 'xlsx' });
      expect(xlsx.status, report).toBe(200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(xlsx.bytes as unknown as ArrayBuffer);
      expect(wb.worksheets[0].rowCount).toBeGreaterThanOrEqual(5);
    }
    expect((await download('subAdmin', { report: 'nonsense' })).status).toBe(400);
    expect((await download('subAdmin', { report: 'trend', format: 'pdf' })).status).toBe(400);
    expect((await callBinary(exportRoute, 'GET', '/x', { token: token.subAdmin, query: range })).status).toBe(400); // report is required
  });

  it('CSV quoting: commas, quotes and line breaks stay inside their cell; formulas are defused', () => {
    const csv = toCsv([{ key: 'a', header: 'A' }, { key: 'b', header: 'B' }], [{ a: 'say "hi", ok', b: 'line1\nline2' }, { a: '=1+1', b: '+SUM(A1)' }, { a: '-5', b: '@x' }, { a: null, b: 0 }])
      .toString('utf8').replace(/^﻿/, '');
    expect(csv).toBe('A,B\r\n"say ""hi"", ok","line1\nline2"\r\n\'=1+1,\'+SUM(A1)\r\n\'-5,\'@x\r\n,0');
    expect(safeCell('=cmd')).toBe("'=cmd");
    expect(safeCell('\t=x')).toBe("'\t=x");
    expect(safeCell('plain')).toBe('plain');
    expect(safeCell(42)).toBe(42);
  });

  it('one export at a time per user; the slot is freed afterwards, even when the export fails', async () => {
    const userId = JSON.parse(Buffer.from(token.subAdmin.split('.')[1], 'base64url').toString()).sub;
    const release = exportSlots.acquire(userId); // an export of this user is still being built
    const busy = await call(exportRoute, 'GET', '/x', { token: token.subAdmin, query: { ...range, report: 'trend', format: 'csv' } });
    expect(busy.status).toBe(429);
    expect(busy.body).toEqual({ statusCode: 429, message: expect.stringMatching(/previous export/) });
    expect((await download('districtAdmin', { report: 'trend', format: 'csv' })).status).toBe(200); // other users are not blocked
    release();
    release(); // releasing twice is harmless
    expect((await download('subAdmin', { report: 'trend', format: 'csv' })).status).toBe(200);
    // an export that fails (range too long) must not keep the slot
    expect((await download('subAdmin', { from: '2024-01-01', to: '2026-10-03', report: 'complaints', format: 'xlsx' })).status).toBe(400);
    expect(exportSlots.inUse).toBe(0);
  });

  it('at most two exports build at once in a process', async () => {
    const r1 = exportSlots.acquire('u1');
    const r2 = exportSlots.acquire('u2');
    const res = await download('subAdmin', { report: 'trend', format: 'csv' });
    expect(res.status).toBe(429);
    expect(res.bytes.toString()).toMatch(/busy/);
    r1();
    r2();
    expect(exportSlots.inUse).toBe(0);
  });

  it('refuses an export of more than 50,000 rows instead of cutting it off', async () => {
    const jur = await createJurisdiction();
    const t = await loginAs(await createUser('SUB_ADMIN', jur));
    const citizen = (await createUser('CITIZEN', jur)).id;
    const c = jur.wards[0].center;
    const batch = ist('2026-08-05 10:00');
    // 50,001 complaints through a cross join of digit tables (no recursion limit involved)
    const d = (n: string) => `(SELECT 0 AS ${n} UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)`;
    await run(
      db(),
      `INSERT INTO complaints (id, complaint_no, citizen_id, district_id, ulb_id, ward_id, area_id, ward_source, type_id, description, location, status, sla_due_at, created_at)
       SELECT UUID(), CONCAT('7', LPAD(n, 17, '0')), ?, ?, ?, ?, ?, 'GPS', ?, 'bulk', ST_PointFromText(?, 4326, 'axis-order=long-lat'), 'PENDING', ?, ?
         FROM (SELECT a.a + b.b * 10 + c.c * 100 + d.d * 1000 + e.e * 10000 + 1 + ? AS n
                 FROM ${d('a')} a, ${d('b')} b, ${d('c')} c, ${d('d')} d, ${d('e')} e) x
        WHERE n <= 50001 + ?`,
      [citizen, jur.districtId, jur.ulbId, jur.wards[0].id, jur.areaId, typeId, `POINT(${c.lng} ${c.lat})`, new Date(batch.getTime() + 86_400_000), batch, 600_000 + jur.districtLgd * 100_000, 600_000 + jur.districtLgd * 100_000],
    );
    try {
      const res = await call(exportRoute, 'GET', '/x', { token: t, query: { from: '2026-08-05', to: '2026-08-05', report: 'complaints', format: 'csv' } });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Export has 50001 rows; narrow the filters to 50000 or fewer/);
      // the summaries still work on that much data
      expect((await call(summaryRoute, 'GET', '/x', { token: t, query: { from: '2026-08-05', to: '2026-08-05' } })).body.counts.received).toBe(50_001);
    } finally {
      await run(db(), `DELETE FROM complaints WHERE ulb_id = ?`, [jur.ulbId]);
    }
  }, 180_000);
});

describe('date helpers', () => {
  it('uses India time for "today" and bounds the window', () => {
    expect(todayIst(new Date('2026-10-28T20:00:00Z'))).toBe('2026-10-29'); // 01:30 IST next day
    expect(todayIst(new Date('2026-10-28T10:00:00Z'))).toBe('2026-10-28');
    expect(resolveRange(undefined, '2026-10-30', new Date())).toEqual({ from: '2026-10-01', to: '2026-10-30', days: 30 });
    expect(resolveRange('2026-10-01', '2026-10-01', new Date()).days).toBe(1);
  });
});
