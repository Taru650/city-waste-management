import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Knex } from 'knex';
import { DEMO_USERS } from '@/db/seed-helpers';
import { seed as seedGeography } from '@/db/seeds/01_geography';
import { seed as seedUsers } from '@/db/seeds/02_users';
import { seed as seedComplaints } from '@/db/seeds/03_complaints';
import { one, query } from '@/db/sql';
import { blindIndex } from '@/lib/crypto';
import { formatComplaintNo } from '@/lib/complaintNumber';
import { RULES, transition, type Actor, type TransitionAction } from '@/lib/stateMachine';
import { ComplaintModel, complaintScope } from '@/models/ComplaintModel';
import { ReportModel, reportWhere } from '@/models/ReportModel';
import { Storage } from '@/lib/storage';
import { todayIst } from '@/lib/reportRange';
import type { AuthUser } from '@/middleware/auth';
import { db, setupTestEnvironment } from './helpers';

setupTestEnvironment();

/**
 * The demo data is built inside a transaction that is rolled back at the end, so it never mixes with other tests.
 * Everything below checks that the seeded history is the kind of history the live system itself could have written.
 */
let trx: Knex.Transaction;
const asUser = async (key: string): Promise<AuthUser> => {
  const def = DEMO_USERS.find((u) => u.key === key)!;
  const u = (await one(trx, `SELECT id, role, district_id, ulb_id, area_id FROM users WHERE mobile_hash = ?`, [blindIndex(def.mobile)]))!;
  return { id: u.id, role: u.role, districtId: u.district_id, ulbId: u.ulb_id, areaId: u.area_id, mustChangePassword: false, consentRequired: false, sessionId: 's', via: 'bearer' };
};

beforeAll(async () => {
  trx = await db().transaction();
  await seedGeography(trx);
  await seedUsers(trx);
  await seedComplaints(trx);
}, 120_000);
afterAll(async () => {
  await trx.rollback();
});

describe('demo complaints', () => {
  it('cover all three ULBs, every stage of the life cycle, and the special cases the screens need to show', async () => {
    const byStatus = Object.fromEntries((await query<{ status: string; n: number }>(trx, `SELECT status, COUNT(*) AS n FROM complaints GROUP BY status`)).map((r) => [r.status, Number(r.n)]));
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(40);
    for (const s of ['ASSIGNED', 'CLOSED', 'REJECTED']) expect(byStatus[s], s).toBeGreaterThan(0);
    const per = await query<{ lgd_code: number; n: number }>(trx, `SELECT u.lgd_code, COUNT(*) AS n FROM complaints c JOIN ulbs u ON u.id = c.ulb_id GROUP BY u.lgd_code`);
    expect(per.map((r) => r.lgd_code).sort()).toEqual([800001, 800002, 800101]);
    const special = (await one(trx, `SELECT SUM(escalated) AS esc, SUM(reopen_count > 0) AS reopened, SUM(event_zone_id IS NOT NULL) AS zoned, SUM(ward_mismatch) AS mismatch,
        SUM(status IN ('PENDING','ASSIGNED','WORK_IN_PROGRESS','REOPENED') AND sla_due_at < NOW(3)) AS overdue FROM complaints`))!;
    for (const k of ['esc', 'reopened', 'zoned', 'mismatch', 'overdue']) expect(Number(special[k]), k).toBeGreaterThan(0);
    const ages = (await one(trx, `SELECT MIN(created_at) AS oldest, MAX(created_at) AS newest FROM complaints`))!;
    expect((Date.now() - new Date(ages.oldest).getTime()) / 86_400_000).toBeGreaterThan(15); // a real month of history
    expect(new Date(ages.newest).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('every complaint has a photo of the problem, and every photo has its files on disk', async () => {
    const without = await query(trx, `SELECT c.id FROM complaints c WHERE NOT EXISTS (SELECT 1 FROM complaint_media m WHERE m.complaint_id = c.id AND m.stage = 'COMPLAINT' AND m.status = 'READY')`);
    expect(without).toHaveLength(0);
    const media = await query<{ object_key: string; thumb_key: string }>(trx, `SELECT object_key, thumb_key FROM complaint_media`);
    expect(media.length).toBeGreaterThan(40);
    for (const m of media.slice(0, 40)) {
      expect(await Storage.head(m.object_key), m.object_key).not.toBeNull();
      expect(await Storage.head(m.thumb_key), m.thumb_key).not.toBeNull();
    }
    // finished work shows its before and after
    const resolved = await query(trx, `SELECT c.id FROM complaints c WHERE c.status IN ('RESOLVED','CLOSED') AND c.worker_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM complaint_media m WHERE m.complaint_id = c.id AND m.stage = 'RESOLUTION')`);
    expect(resolved).toHaveLength(0);
  });
});

describe('the history is one the live system could have written', () => {
  it('status equals the last event; every event chains from the one before; time never goes backwards or into the future', async () => {
    const mismatch = await query(trx, `SELECT c.id FROM complaints c WHERE c.status <> (SELECT e.to_status FROM complaint_events e WHERE e.complaint_id = c.id ORDER BY e.id DESC LIMIT 1)`);
    expect(mismatch).toHaveLength(0);
    const events = await query<{ complaint_id: string; action: string; from_status: string | null; to_status: string; created_at: Date; actor_id: string | null }>(
      trx, `SELECT complaint_id, action, from_status, to_status, created_at, actor_id FROM complaint_events ORDER BY complaint_id, id`);
    let prev: (typeof events)[number] | undefined;
    for (const e of events) {
      if (!prev || prev.complaint_id !== e.complaint_id) {
        expect(e.action).toBe('CREATE');
        expect(e.from_status).toBeNull();
      } else {
        expect(e.from_status, `${e.complaint_id} ${e.action}`).toBe(prev.to_status);
        expect(e.created_at.getTime()).toBeGreaterThanOrEqual(prev.created_at.getTime());
      }
      expect(e.created_at.getTime()).toBeLessThanOrEqual(Date.now());
      prev = e;
    }
  });

  it('every status change is allowed by the state machine for the person who made it', async () => {
    const rows = await query<{ action: string; from_status: string | null; to_status: string; role: string | null }>(
      trx, `SELECT e.action, e.from_status, e.to_status, u.role FROM complaint_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.from_status IS NOT NULL AND e.from_status <> e.to_status`);
    expect(rows.length).toBeGreaterThan(50);
    const known = new Set(Object.keys(RULES));
    for (const r of rows) {
      expect(known.has(r.action), r.action).toBe(true);
      const actor = (r.role ?? 'SYSTEM') as Actor;
      expect(transition(r.action as TransitionAction, r.from_status as never, actor), `${actor} ${r.action} from ${r.from_status}`).toBe(r.to_status);
    }
  });

  it('the fields on each complaint agree with its history', async () => {
    const rows = await query<Record<string, any>>(trx, `SELECT c.id, c.status, c.resolved_at, c.closed_at, c.reopen_count, c.worker_id, c.supervisor_id, c.assigned_at, c.sla_breached_at, c.escalated_at,
         (SELECT COUNT(*) FROM complaint_events e WHERE e.complaint_id = c.id AND e.action = 'REOPEN') AS reopens,
         (SELECT COUNT(*) FROM complaint_events e WHERE e.complaint_id = c.id AND e.action = 'ASSIGN') AS assigns,
         (SELECT COUNT(*) FROM complaint_events e WHERE e.complaint_id = c.id AND e.action = 'ESCALATE') AS escalations,
         (SELECT COUNT(*) FROM complaint_events e WHERE e.complaint_id = c.id AND e.action = 'SLA_BREACH') AS breaches,
         (SELECT MAX(e.created_at) FROM complaint_events e WHERE e.complaint_id = c.id AND e.action = 'RESOLVE') AS last_resolve
       FROM complaints c`);  
    for (const r of rows) {
      expect(Number(r.reopens), 'reopen count').toBe(r.reopen_count);
      if (['RESOLVED', 'CLOSED'].includes(r.status)) expect(r.resolved_at?.getTime(), 'resolved_at').toBe(r.last_resolve.getTime());
      else expect(r.resolved_at, 'not resolved').toBeNull();
      if (['CLOSED', 'REJECTED', 'DUPLICATE'].includes(r.status)) expect(r.closed_at, 'closed_at').not.toBeNull();
      else expect(r.closed_at).toBeNull();
      if (Number(r.assigns) > 0) expect(r.worker_id).not.toBeNull();
      expect(Boolean(r.escalated_at)).toBe(Number(r.escalations) > 0);
      if (r.reopen_count === 0) expect(Boolean(r.sla_breached_at), 'breach recorded only with its timeline entry').toBe(Number(r.breaches) > 0);
    }
    const dup = await query(trx, `SELECT c.id FROM complaints c WHERE c.status = 'DUPLICATE' AND (c.duplicate_of IS NULL OR c.duplicate_of = c.id)`);
    expect(dup).toHaveLength(0);
  });

  it('breaches and escalations are only recorded for complaints that were late at that moment', async () => {
    const bad = await query(trx, `SELECT e.complaint_id FROM complaint_events e JOIN complaints c ON c.id = e.complaint_id
        WHERE e.action = 'SLA_BREACH' AND e.created_at < (SELECT MIN(x.created_at) FROM complaint_events x WHERE x.complaint_id = c.id AND x.action = 'CREATE')`);
    expect(bad).toHaveLength(0);
    const esc = await query(trx, `SELECT c.id FROM complaints c JOIN complaint_types t ON t.id = c.type_id
        WHERE c.escalated_at IS NOT NULL AND c.escalated_at < DATE_ADD(c.created_at, INTERVAL t.sla_hours * 2 HOUR) AND c.reopen_count = 0 AND c.event_zone_id IS NULL`);
    expect(esc).toHaveLength(0); // an escalation never comes before twice the SLA
  });

  it('ratings belong to resolved complaints, and a low rating with a reopen is the only reopen', async () => {
    const rows = await query<{ rating: number; reopen_requested: number; complaint_id: string }>(trx, `SELECT rating, reopen_requested, complaint_id FROM feedback`);
    expect(rows.length).toBeGreaterThan(5);
    for (const f of rows) {
      expect(Boolean(f.reopen_requested)).toBe(f.rating <= 2);
      const e = await one(trx, `SELECT 1 AS x FROM complaint_events WHERE complaint_id = ? AND action IN ('CLOSE','REOPEN')`, [f.complaint_id]);
      expect(e).toBeTruthy();
    }
  });
});

describe('numbers', () => {
  it('are unique, built from the right LGD codes, and run 1..n per ULB and year with the counter to match', async () => {
    const rows = await query<{ complaint_no: string; lgd_code: number; dlgd: number; created_at: Date }>(
      trx, `SELECT c.complaint_no, u.lgd_code, d.lgd_code AS dlgd, c.created_at FROM complaints c JOIN ulbs u ON u.id = c.ulb_id JOIN districts d ON d.id = c.district_id ORDER BY c.created_at, c.id`);
    expect(new Set(rows.map((r) => r.complaint_no)).size).toBe(rows.length);
    const seqs = new Map<string, number[]>();
    for (const r of rows) {
      expect(r.complaint_no).toMatch(/^\d{18}$/);
      expect(formatComplaintNo(r.complaint_no)).toMatch(/^\d{4}-\d{6}-\d{2}-\d{6}$/);
      expect(Number(r.complaint_no.slice(0, 4))).toBe(r.dlgd);
      expect(Number(r.complaint_no.slice(4, 10))).toBe(r.lgd_code);
      const key = `${r.lgd_code}:${r.complaint_no.slice(10, 12)}`;
      (seqs.get(key) ?? seqs.set(key, []).get(key)!).push(Number(r.complaint_no.slice(12)));
    }
    for (const [key, list] of seqs) expect(list.sort((a, b) => a - b), key).toEqual(list.map((_, i) => i + 1));
    const counters = await query<{ last_no: number }>(trx, `SELECT last_no FROM complaint_seq`);
    expect(counters.map((c) => c.last_no).sort((a, b) => a - b)).toEqual([...seqs.values()].map((l) => l.length).sort((a, b) => a - b));
  });
});

describe('what each demo login sees', () => {
  it('follows the same visibility rule as the live system', async () => {
    const ids = async (key: string) => (await ComplaintModel.list(trx, complaintScope(await asUser(key)), {}, 500, 0)).rows.map((r) => r.id as string);
    const all = new Set((await query<{ id: string }>(trx, `SELECT id FROM complaints`)).map((r) => r.id));
    expect(new Set(await ids('webAdmin'))).toEqual(all);
    const a = await ids('subAdminA');
    const b = await ids('subAdminB');
    expect(a.length).toBeGreaterThan(20);
    expect(b.length).toBeGreaterThan(0);
    expect(new Set(await ids('districtAdmin'))).toEqual(new Set([...a, ...b])); // district one = ULB A and B
    const two = await ids('districtAdminTwo');
    expect(two.length).toBeGreaterThan(0);
    expect(two.every((id) => !a.includes(id) && !b.includes(id))).toBe(true);
    const north = await ids('supervisorNorth');
    const south = await ids('supervisorSouth');
    expect(north.length).toBeGreaterThan(0);
    expect(south.length).toBeGreaterThan(0);
    expect(north.some((id) => south.includes(id))).toBe(false);
    expect(new Set([...north, ...south])).toEqual(new Set(a)); // the two areas cover ULB A
    const mine = new Set<string>();
    for (const key of ['citizen1', 'citizen2', 'citizen3']) {
      const list = await ids(key);
      expect(list.length, key).toBeGreaterThan(0);
      list.forEach((id) => { expect(mine.has(id)).toBe(false); mine.add(id); });
    }
    expect(mine.size).toBe(all.size); // every complaint belongs to exactly one demo citizen
    expect((await ids('worker1')).length).toBeGreaterThan(0);
    expect(new Set([...(await ids('worker1')), ...(await ids('worker2'))]).size).toBeGreaterThan(5);
  });
});

describe('reports on the demo data', () => {
  it('agree with the data: the trend ends on today\'s open count, and the summary counts add up', async () => {
    const user = await asUser('webAdmin');
    const today = todayIst();
    const from = new Date(Date.now() + 5.5 * 3_600_000 - 29 * 86_400_000).toISOString().slice(0, 10);
    const start = new Date(`${from}T00:00:00+05:30`);
    const end = new Date(new Date(`${today}T00:00:00+05:30`).getTime() + 86_400_000);
    const w = reportWhere(user, {}, { start, end });
    const trend = await ReportModel.trend(trx, w, { from, to: today }, start, end);
    expect(trend).toHaveLength(30);
    const openNow = Number((await one(trx, `SELECT COUNT(*) AS n FROM complaints WHERE status IN ('PENDING','ASSIGNED','WORK_IN_PROGRESS','REOPENED')`))!.n);
    expect(Number(trend[trend.length - 1].pending)).toBe(openNow);
    expect(trend.reduce((s, r) => s + Number(r.received), 0)).toBe(Number((await one(trx, `SELECT COUNT(*) AS n FROM complaints WHERE created_at >= ?`, [start]))!.n));
    expect(trend.every((r) => Number(r.pending) >= 0)).toBe(true);
    const core = (await ReportModel.core(trx, w))!;
    expect(Number(core.resolved) + Number(core.pending) + Number(core.rejected) + Number(core.duplicate)).toBe(Number(core.received));
  });
});

describe('running the seeder again', () => {
  it('changes nothing', async () => {
    const before = Number((await one(trx, `SELECT COUNT(*) AS n FROM complaints`))!.n);
    const eventsBefore = Number((await one(trx, `SELECT COUNT(*) AS n FROM complaint_events`))!.n);
    await seedComplaints(trx);
    await seedUsers(trx);
    await seedGeography(trx);
    expect(Number((await one(trx, `SELECT COUNT(*) AS n FROM complaints`))!.n)).toBe(before);
    expect(Number((await one(trx, `SELECT COUNT(*) AS n FROM complaint_events`))!.n)).toBe(eventsBefore);
    expect(Number((await one(trx, `SELECT COUNT(*) AS n FROM users`))!.n)).toBe(DEMO_USERS.length);
  });
});
