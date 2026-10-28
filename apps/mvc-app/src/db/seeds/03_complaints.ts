import { createHash, generateKeyPairSync } from 'node:crypto';
import type { Knex } from 'knex';
import sharp from 'sharp';
import { getConfig } from '@/config/env';
import { DEMO_USERS } from '@/db/seed-helpers';
import { one, query, run } from '@/db/sql';
import { keyFingerprint } from '@/lib/captureManifest';
import { buildComplaintNo } from '@/lib/complaintNumber';
import { blindIndex } from '@/lib/crypto';
import { newId } from '@/lib/ids';
import { templates, type NotificationContent } from '@/lib/notificationTemplates';
import { Storage } from '@/lib/storage';

/**
 * Demo complaints with a believable month of history: filed over the last 30 days in the three demo ULBs, moved through
 * the same states, by the same people, in the same order as the live system would (events, ratings, reopens, SLA
 * breaches, an event zone, photos, notifications). Everything is deterministic, so two installs show the same data.
 * Skipped when the demo ULBs already have complaints.
 */
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Ward { id: string; ulbId: string; areaId: string | null; number: number; bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number } }
interface Person { id: string; name: string }
interface Step { action: string; to: string | null; at: number; actor: string | null; remark?: string; meta?: unknown }

const CITIZEN_REMARKS_GOOD = ['Cleaned quickly, thank you', 'Good work by the team', 'Area is clean now', 'Quick response'];
const CITIZEN_REMARKS_BAD = ['Still dirty, they only moved it', 'Garbage is back already', 'Nothing was cleaned properly'];
const RESOLVE_REMARKS = ['Garbage cleared and the spot swept', 'Drain cleaned and waste removed', 'Area cleaned, bins emptied', 'Dead animal removed and the place disinfected'];
const REJECT_REASONS = ['Private property: not covered by the municipal service', 'No problem found at the location', 'Outside the city limits'];
const DESCRIPTIONS = [
  'Garbage heap near the school gate has not been cleared for days',
  'Drain is blocked and dirty water is flowing on the road',
  'Water logging on the main road after rain',
  'Dead animal lying near the market',
  'Public toilet is dirty and has no water',
  'Garbage is being burnt near the park',
  'Road in front of the temple has not been swept',
  'Overflowing dustbin at the bus stop',
];

export async function seed(knex: Knex): Promise<void> {
  const ulbRows = await query<{ id: string; lgd_code: number; district_id: string; dlgd: number }>(
    knex,
    `SELECT u.id, u.lgd_code, u.district_id, d.lgd_code AS dlgd FROM ulbs u JOIN districts d ON d.id = u.district_id WHERE u.lgd_code IN (800001, 800002, 800101) ORDER BY u.lgd_code`,
  );
  if (ulbRows.length < 3) {
    console.log('  complaints: demo geography not found, skipped');
    return;
  }
  const existing = await one<{ n: number }>(knex, `SELECT COUNT(*) AS n FROM complaints WHERE ulb_id IN (?)`, [ulbRows.map((u) => u.id)]);
  if (Number(existing?.n) > 0) {
    console.log(`  complaints: ${existing?.n} demo complaints already exist, skipped`);
    return;
  }

  const random = rng(20261028);
  const between = (a: number, b: number) => a + random() * (b - a);
  const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)];
  const weighted = <T>(items: [T, number][]) => {
    let r = random() * items.reduce((s, [, w]) => s + w, 0);
    for (const [v, w] of items) if ((r -= w) < 0) return v;
    return items[items.length - 1][0];
  };
  const now = Date.now();

  // ---- the people and places the seeders created before ----
  const user = async (key: string): Promise<Person> => {
    const def = DEMO_USERS.find((u) => u.key === key)!;
    const r = (await one<{ id: string }>(knex, `SELECT id FROM users WHERE mobile_hash = ?`, [blindIndex(def.mobile)]))!;
    return { id: r.id, name: def.name };
  };
  const [citizens, supNorth, supSouth, worker1, worker2, subA, subB] = await Promise.all([
    Promise.all(['citizen1', 'citizen2', 'citizen3'].map(user)),
    user('supervisorNorth'), user('supervisorSouth'), user('worker1'), user('worker2'), user('subAdminA'), user('subAdminB'),
  ]);
  const ulbA = ulbRows.find((u) => u.lgd_code === 800001)!;
  const ulbB = ulbRows.find((u) => u.lgd_code === 800002)!;
  const ulbC = ulbRows.find((u) => u.lgd_code === 800101)!;
  const areaRows = await query<{ id: string; name: string }>(knex, `SELECT id, name FROM areas WHERE ulb_id = ?`, [ulbA.id]);
  const northArea = areaRows.find((a) => a.name === 'North Zone')!.id;

  const wardRows = await query<{ id: string; ulb_id: string; area_id: string | null; number: number; gj: unknown }>(
    knex,
    `SELECT w.id, w.ulb_id, w.area_id, w.number, ST_AsGeoJSON(b.geom) AS gj FROM wards w JOIN ward_boundaries b ON b.ward_id = w.id WHERE w.ulb_id IN (?) ORDER BY w.ulb_id, w.number`,
    [ulbRows.map((u) => u.id)],
  );
  const wards: Ward[] = wardRows.map((w) => {
    const g = (typeof w.gj === 'string' ? JSON.parse(w.gj) : w.gj) as { coordinates: number[][][] };
    const pts = g.coordinates[0];
    return {
      id: w.id, ulbId: w.ulb_id, areaId: w.area_id, number: w.number,
      bbox: { minLng: Math.min(...pts.map((p) => p[0])), maxLng: Math.max(...pts.map((p) => p[0])), minLat: Math.min(...pts.map((p) => p[1])), maxLat: Math.max(...pts.map((p) => p[1])) },
    };
  });
  const types = await query<{ id: string; code: string; name_en: string; sla_hours: number }>(knex, `SELECT id, code, name_en, sla_hours FROM complaint_types WHERE active ORDER BY sort_order`);
  const areaSupervisor = (areaId: string | null): Person | null => (areaId === null ? null : areaId === northArea ? supNorth : supSouth);
  const workerOf = (areaId: string | null) => (areaId === northArea ? worker1 : worker2);

  // ---- devices that "took" the photos (the private keys are thrown away: these are demo records) ----
  const deviceFor = new Map<string, string>();
  const ensureDevice = async (userId: string) => {
    if (deviceFor.has(userId)) return deviceFor.get(userId)!;
    const publicKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const id = newId();
    await run(knex, `INSERT INTO devices (id, user_id, public_key, key_fingerprint, platform, app_version, integrity_verdict) VALUES (?,?,?,?, 'ANDROID', '1.0.0-demo', 'UNVERIFIED')`, [id, userId, publicKey, keyFingerprint(publicKey)]);
    deviceFor.set(userId, id);
    return id;
  };

  // ---- plan every complaint (no database writes yet) ----
  interface Plan {
    id: string; ulb: typeof ulbA; ward: Ward; citizen: Person; type: (typeof types)[number]; description: string; landmark: string | null;
    lat: number; lng: number; createdAt: number; supervisor: Person | null; worker: Person | null; steps: Step[]; zone: boolean; mismatch: boolean;
    duplicateOf?: string; ratings: { rating: number; remark: string | null; reopen: boolean; at: number }[];
  }
  const plans: Plan[] = [];
  // [ulb, how many, how many days back]; the small ULBs have only recent complaints so they do not all look overdue
  const counts: [typeof ulbA, number, number][] = [[ulbA, 46, 29.5], [ulbB, 7, 2.5], [ulbC, 3, 1.5]];
  for (const [ulb, n, back] of counts) {
    const ulbWards = wards.filter((w) => w.ulbId === ulb.id);
    for (let i = 0; i < n; i++) {
      const ward = pick(ulbWards);
      const type = weighted(types.map((t) => [t, t.code === 'GARBAGE_HEAP' ? 4 : t.code === 'DRAIN_BLOCKAGE' ? 3 : 1] as [typeof t, number]));
      const createdAt = now - between(0.05, back) * DAY;
      const citizen = ulb === ulbA ? pick(citizens) : citizens[i % citizens.length];
      const supervisor = areaSupervisor(ward.areaId);
      const worker = supervisor ? workerOf(ward.areaId) : null;
      const plan: Plan = {
        id: newId(), ulb, ward, citizen, type, description: pick(DESCRIPTIONS), landmark: random() < 0.6 ? pick(['Near the temple', 'Opposite the school', 'Behind the market', 'Next to the bus stop', 'Beside the park gate']) : null,
        lat: between(ward.bbox.minLat + 0.0008, ward.bbox.maxLat - 0.0008), lng: between(ward.bbox.minLng + 0.0008, ward.bbox.maxLng - 0.0008),
        createdAt, supervisor, worker, steps: [], zone: false, mismatch: ulb !== ulbA && random() < 0.5, ratings: [],
      };
      plans.push(plan);
    }
  }
  plans.sort((a, b) => a.createdAt - b.createdAt);

  // Walk each complaint through its life; steps that would lie in the future are simply not taken yet.
  const futureSafe = (steps: Step[]) => steps.filter((s) => s.at <= now - MIN);
  for (const p of plans) {
    const s: Step[] = [];
    let t = p.createdAt;
    const add = (action: string, to: string | null, actor: string | null, extra: Partial<Step> = {}) => s.push({ action, to, at: t, actor, ...extra });
    add('CREATE', 'PENDING', p.citizen.id);
    const ageDays = (now - p.createdAt) / DAY;
    if (p.supervisor) add('ROUTE', 'ASSIGNED', null, { meta: { supervisorId: p.supervisor.id } });
    const sla = p.type.sla_hours * HOUR;
    // Older complaints are mostly finished; only recent ones are still moving. A few old ones stay stuck to show overdue and escalation.
    const outcome = p.supervisor
      ? ageDays < 1
        ? weighted<string>([['ASSIGNED', 35], ['WIP', 25], ['RESOLVED', 15], ['STUCK', 25]])
        : ageDays < 3
          ? weighted<string>([['ASSIGNED', 12], ['WIP', 10], ['RESOLVED', 18], ['CLOSED', 35], ['REOPENED', 5], ['REJECTED', 8], ['DUPLICATE', 4], ['STUCK', 8]])
          : weighted<string>([['ASSIGNED', 1], ['WIP', 1], ['RESOLVED', ageDays < 7 ? 6 : 0], ['CLOSED', 66], ['REOPENED', 8], ['REJECTED', 8], ['DUPLICATE', 5], ['STUCK', 2], ['ESCALATED', 3]])
      : p.ulb === ulbC
        ? 'PENDING' // no staff accounts in this ULB: complaints wait for its Sub Admin
        : weighted<string>([['PENDING', 70], ['REJECTED', 20], ['DUPLICATE', 10]]);
    const sup = p.supervisor?.id ?? subB.id;
    const wk = p.worker?.id ?? null;
    const assign = () => {
      t += between(20, 180) * MIN;
      add('ASSIGN', 'ASSIGNED', sup, { remark: 'Please attend to this today', meta: { workerId: wk, supervisorId: p.supervisor?.id } });
    };
    const start = () => {
      t += between(30, 240) * MIN;
      add('START', 'WORK_IN_PROGRESS', wk);
    };
    const resolve = () => {
      t += between(1, Math.max(2, p.type.sla_hours * 0.8)) * HOUR;
      add('RESOLVE', 'RESOLVED', wk, { remark: pick(RESOLVE_REMARKS) });
    };
    const rate = (good: boolean) => {
      t += between(2, 60) * HOUR;
      const rating = good ? Math.round(between(3, 5)) : Math.round(between(1, 2));
      p.ratings.push({ rating, remark: random() < 0.7 ? pick(good ? CITIZEN_REMARKS_GOOD : CITIZEN_REMARKS_BAD) : null, reopen: !good, at: t });
      add(good ? 'CLOSE' : 'REOPEN', good ? 'CLOSED' : 'REOPENED', p.citizen.id, { remark: p.ratings[p.ratings.length - 1].remark ?? undefined });
    };
    switch (outcome) {
      case 'WIP': assign(); start(); break;
      case 'RESOLVED': assign(); start(); resolve(); break;
      case 'CLOSED': {
        assign(); start(); resolve();
        if (random() < 0.85) rate(true);
        else { t += 7 * DAY + HOUR; add('AUTO_CLOSE', 'CLOSED', null, { remark: 'No feedback within window' }); }
        break;
      }
      case 'REOPENED': {
        assign(); start(); resolve(); rate(false);
        if (ageDays > 6 && random() < 0.7) { assign(); start(); resolve(); rate(true); }
        break;
      }
      case 'ASSIGNED': if (random() < 0.6) assign(); break;
      case 'REJECTED': t += between(1, 12) * HOUR; add('REJECT', 'REJECTED', sup, { remark: pick(REJECT_REASONS) }); break;
      case 'DUPLICATE': {
        const earlier = plans.find((o) => o !== p && o.ulb === p.ulb && o.ward === p.ward && o.type === p.type && o.createdAt < p.createdAt);
        if (earlier) { t += between(1, 8) * HOUR; p.duplicateOf = earlier.id; add('MARK_DUPLICATE', 'DUPLICATE', sup, { remark: 'Same spot as an earlier complaint', meta: { duplicateOf: earlier.id } }); }
        break;
      }
      default: break; // PENDING, STUCK, ESCALATED: left waiting (they become overdue below)
    }
    p.steps = futureSafe(s);
    p.ratings = p.ratings.filter((r) => r.at <= now - MIN); // a rating belongs to a step that has happened
    if (outcome === 'STUCK' || outcome === 'ESCALATED') p.steps = p.steps.filter((x) => x.action === 'CREATE' || x.action === 'ROUTE');

    // Late and escalated: only for complaints still open after the last step.
    const open = (st: string | null) => !!st && ['PENDING', 'ASSIGNED', 'WORK_IN_PROGRESS', 'REOPENED'].includes(st);
    const last = [...p.steps].reverse().find((x) => x.to !== null)!;
    if (open(last.to)) {
      const lastReopen = [...p.steps].reverse().find((x) => x.action === 'REOPEN');
      const due = (lastReopen ? lastReopen.at : p.createdAt) + sla;
      if (due <= now - MIN) {
        p.steps.push({ action: 'SLA_BREACH', to: null, at: due, actor: null, remark: 'Resolution deadline passed' });
        if (due + sla <= now - MIN) p.steps.push({ action: 'ESCALATE', to: null, at: due + sla, actor: null, remark: 'Unresolved at twice the SLA' });
      }
    }
    p.steps.sort((a, b) => a.at - b.at);
  }

  // A ward chosen by hand that is far from where the photo was taken (flagged for the supervisor).
  for (const p of plans) if (p.mismatch) p.lat += 0.02;

  // A running event zone (a fair near the north wards) takes a few of the newest complaints in that area.
  const zoneUlbWards = wards.filter((w) => w.ulbId === ulbA.id && w.areaId === northArea);
  const zoneWard = zoneUlbWards[1] ?? zoneUlbWards[0];
  const zoneBox = {
    minLat: (zoneWard.bbox.minLat + zoneWard.bbox.maxLat) / 2 - 0.003, maxLat: (zoneWard.bbox.minLat + zoneWard.bbox.maxLat) / 2 + 0.003,
    minLng: (zoneWard.bbox.minLng + zoneWard.bbox.maxLng) / 2 - 0.003, maxLng: (zoneWard.bbox.minLng + zoneWard.bbox.maxLng) / 2 + 0.003,
  };
  const zoneStart = now - 3 * DAY;
  const inZone = plans.filter((p) => p.ward === zoneWard && p.createdAt >= zoneStart && p.steps.some((s) => s.action === 'ROUTE')).slice(0, 3);
  for (const p of inZone) {
    p.zone = true;
    p.lat = between(zoneBox.minLat + 0.0005, zoneBox.maxLat - 0.0005);
    p.lng = between(zoneBox.minLng + 0.0005, zoneBox.maxLng - 0.0005);
  }

  // ---- write everything in one transaction ----
  const zoneId = newId();
  await knex.transaction(async (trx) => {
    const subAdminAUser = subA;
    await run(
      trx,
      `INSERT INTO event_zones (id, ulb_id, name, geom, starts_at, ends_at, supervisor_id, sla_hours, active, created_by) VALUES (?,?,?, ST_GeomFromGeoJSON(?, 1, 4326), ?,?,?,?,1,?)`,
      [
        zoneId, ulbA.id, 'Demo Mela Ground',
        JSON.stringify({ type: 'Polygon', coordinates: [[[zoneBox.minLng, zoneBox.minLat], [zoneBox.maxLng, zoneBox.minLat], [zoneBox.maxLng, zoneBox.maxLat], [zoneBox.minLng, zoneBox.maxLat], [zoneBox.minLng, zoneBox.minLat]]] }),
        new Date(zoneStart), new Date(now + 5 * DAY), supNorth.id, 6, subAdminAUser.id,
      ],
    );

    // numbers: per ULB and IST year, in order of filing
    const seqs = new Map<string, number>();
    const yearIst = (ms: number) => new Date(ms + 5.5 * HOUR).getUTCFullYear();
    const noticeFor = (action: string, no: string): { content: NotificationContent; to: 'citizen' | 'supervisor' | 'worker' | 'sub' } | null => {
      switch (action) {
        case 'CREATE': return { content: templates.registered(no), to: 'citizen' };
        case 'ASSIGN': return { content: templates.assigned(no), to: 'citizen' };
        case 'START': return { content: templates.started(no), to: 'citizen' };
        case 'RESOLVE': return { content: templates.resolved(no), to: 'citizen' };
        case 'REJECT': return { content: templates.rejected(no), to: 'citizen' };
        case 'MARK_DUPLICATE': return { content: templates.duplicate(no), to: 'citizen' };
        case 'CLOSE': case 'AUTO_CLOSE': return { content: templates.closed(no), to: 'citizen' };
        case 'REOPEN': return { content: templates.reopened(no), to: 'supervisor' };
        case 'SLA_BREACH': return { content: templates.slaBreached(no), to: 'supervisor' };
        case 'ESCALATE': return { content: templates.escalated(no), to: 'sub' };
        default: return null;
      }
    };

    const photoJobs: { plan: Plan; no: string; stage: 'COMPLAINT' | 'WORK_START' | 'RESOLUTION'; at: number; owner: string }[] = [];
    for (const p of plans) {
      const year = yearIst(p.createdAt);
      const key = `${p.ulb.id}:${year}`;
      const seq = (seqs.get(key) ?? 0) + 1;
      seqs.set(key, seq);
      const no = buildComplaintNo(p.ulb.dlgd, p.ulb.lgd_code, year, seq);

      // Derive the row from the steps, the way the live system would have left it.
      const changes = p.steps.filter((s) => s.to !== null);
      const status = changes[changes.length - 1].to!;
      const lastReopen = [...p.steps].reverse().find((s) => s.action === 'REOPEN');
      const lastOf = (a: string[]) => [...p.steps].reverse().find((s) => a.includes(s.action));
      const route = p.steps.find((s) => s.action === 'ROUTE');
      const firstAssign = route ?? p.steps.find((s) => s.action === 'ASSIGN');
      const resolveStep = ['RESOLVED', 'CLOSED'].includes(status) ? lastOf(['RESOLVE']) : undefined;
      const closeStep = ['CLOSED', 'REJECTED', 'DUPLICATE'].includes(status) ? lastOf(['CLOSE', 'AUTO_CLOSE', 'REJECT', 'MARK_DUPLICATE']) : undefined;
      const assignStep = lastOf(['ASSIGN']);
      const supervisorId = p.zone ? supNorth.id : p.supervisor?.id ?? null;
      const slaMs = (p.zone ? Math.min(6, p.type.sla_hours) : p.type.sla_hours) * HOUR;
      const dueAt = (lastReopen ? lastReopen.at : p.createdAt) + slaMs;
      const breach = p.steps.find((s) => s.action === 'SLA_BREACH' && (!lastReopen || s.at > lastReopen.at));
      const escalate = p.steps.find((s) => s.action === 'ESCALATE');
      const reopenCount = p.steps.filter((s) => s.action === 'REOPEN').length;

      await run(
        trx,
        `INSERT INTO complaints (id, complaint_no, citizen_id, district_id, ulb_id, ward_id, area_id, ward_source, ward_mismatch, type_id, landmark, description, location,
                                 gps_accuracy_m, status, supervisor_id, worker_id, duplicate_of, event_zone_id, reopen_count, escalated, sla_due_at, sla_breached_at,
                                 escalated_at, assigned_at, resolved_at, closed_at, resolution_remark, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?, ST_PointFromText(?, 4326, 'axis-order=long-lat'), ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          p.id, no, p.citizen.id, p.ulb.district_id, p.ulb.id, p.ward.id, p.ward.areaId, p.mismatch ? 'MANUAL' : 'GPS', p.mismatch ? 1 : 0, p.type.id, p.landmark, p.description,
          `POINT(${p.lng} ${p.lat})`, Math.round(between(4, 30)), status, supervisorId, assignStep ? p.worker?.id ?? null : null, p.duplicateOf ?? null, p.zone ? zoneId : null,
          reopenCount, escalate || reopenCount > 2 ? 1 : 0, new Date(dueAt), breach ? new Date(breach.at) : null, escalate ? new Date(escalate.at) : null,
          firstAssign ? new Date(firstAssign.at) : null, resolveStep ? new Date(resolveStep.at) : null, closeStep ? new Date(closeStep.at) : null,
          resolveStep?.remark ?? null, new Date(p.createdAt), new Date(p.steps[p.steps.length - 1].at),
        ],
      );

      // The history, chained exactly as the state machine writes it.
      let prev: string | null = null;
      for (const s of p.steps) {
        const to = s.to ?? prev ?? 'PENDING';
        await run(trx, `INSERT INTO complaint_events (complaint_id, action, from_status, to_status, actor_id, remark, meta, created_at) VALUES (?,?,?,?,?,?,?,?)`, [
          p.id, s.action, prev, to, s.actor, s.remark ?? null, s.meta === undefined ? null : JSON.stringify(s.meta), new Date(s.at),
        ]);
        if (s.to !== null) prev = s.to;
        const n = noticeFor(s.action, no);
        if (n) {
          const target = n.to === 'citizen' ? p.citizen.id : n.to === 'supervisor' ? supervisorId : n.to === 'sub' ? (p.ulb === ulbB ? subB.id : subA.id) : null;
          if (target) {
            const read = now - s.at > 3 * DAY ? new Date(s.at + 2 * HOUR) : null;
            await run(trx, `INSERT INTO notifications (user_id, type, complaint_id, title_en, title_hi, body_en, body_hi, push_status, read_at, created_at) VALUES (?,?,?,?,?,?,?, 'SKIPPED', ?, ?)`, [
              target, n.content.type, p.id, n.content.title.en, n.content.title.hi, n.content.body.en, n.content.body.hi, read, new Date(s.at),
            ]);
          }
        }
      }
      for (const r of p.ratings) {
        await run(trx, `INSERT INTO feedback (complaint_id, citizen_id, rating, remark, reopen_requested, created_at) VALUES (?,?,?,?,?,?)`, [p.id, p.citizen.id, r.rating, r.remark, r.reopen ? 1 : 0, new Date(r.at)]);
      }

      photoJobs.push({ plan: p, no, stage: 'COMPLAINT', at: p.createdAt, owner: p.citizen.id });
      const startStep = p.steps.find((s) => s.action === 'START');
      if (startStep && p.worker) photoJobs.push({ plan: p, no, stage: 'WORK_START', at: startStep.at + 2 * MIN, owner: p.worker.id });
      const lastResolve = lastOf(['RESOLVE']);
      if (lastResolve && p.worker) photoJobs.push({ plan: p, no, stage: 'RESOLUTION', at: lastResolve.at - 2 * MIN, owner: p.worker.id });
    }
    for (const [key, last] of seqs) {
      const [ulbId, year] = key.split(':');
      await run(trx, `INSERT INTO complaint_seq (ulb_id, year, last_no) VALUES (?,?,?) ON DUPLICATE KEY UPDATE last_no = GREATEST(last_no, VALUES(last_no))`, [ulbId, Number(year), last]);
    }

    // Photos: simple generated pictures (a coloured card naming the complaint and stage), stored like real uploads.
    const palette = { COMPLAINT: ['#6b5b4b', '#3d352d'], WORK_START: ['#b9772e', '#7a4a17'], RESOLUTION: ['#3f8f5b', '#1f5a37'] } as const;
    const label = { COMPLAINT: 'Reported by citizen', WORK_START: 'Work started', RESOLUTION: 'After cleaning' } as const;
    for (const j of photoJobs) {
      const deviceId = await ensureDevice(j.owner);
      const [c1, c2] = palette[j.stage];
      const dots = Array.from({ length: 14 }, () => `<circle cx="${Math.round(between(30, 770))}" cy="${Math.round(between(120, 560))}" r="${Math.round(between(6, 30))}" fill="#ffffff" opacity="0.10"/>`).join('');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
        <rect width="800" height="600" fill="url(#g)"/>${dots}
        <text x="40" y="90" font-family="Arial, sans-serif" font-size="44" fill="#fff" font-weight="bold">${label[j.stage]}</text>
        <text x="40" y="150" font-family="Arial, sans-serif" font-size="28" fill="#fff" opacity="0.9">${j.plan.type.name_en}</text>
        <text x="40" y="560" font-family="Arial, sans-serif" font-size="26" fill="#fff" opacity="0.85">${j.no.slice(0, 4)}-${j.no.slice(4, 10)}-${j.no.slice(10, 12)}-${j.no.slice(12)}  (demo image)</text></svg>`;
      const main = await sharp(Buffer.from(svg)).jpeg({ quality: 72 }).toBuffer();
      const thumb = await sharp(main).resize({ width: 320, height: 320, fit: 'inside' }).jpeg({ quality: 70 }).toBuffer();
      const id = newId();
      const month = new Date(j.at).toISOString().slice(0, 7).replace('-', '/');
      const objectKey = `media/${month}/${id}.jpg`;
      const thumbKey = `media/${month}/${id}.thumb.jpg`;
      await Storage.put(objectKey, main);
      await Storage.put(thumbKey, thumb);
      const sha = createHash('sha256').update(main).digest('hex');
      const near = j.stage === 'COMPLAINT' ? 0 : between(2, 40) / 111_000;
      await run(
        trx,
        `INSERT INTO complaint_media (id, owner_id, device_id, complaint_id, stage, kind, status, content_type, declared_bytes, declared_sha256, object_key, thumb_key, stored_content_type,
                                      bytes_stored, width, height, captured_at, location, gps_accuracy_m, manifest, signature, scan_status, distance_m, outside_geofence,
                                      created_at, confirmed_at, processed_at, attached_at)
         VALUES (?,?,?,?,?, 'PHOTO', 'READY', 'image/jpeg', ?,?,?,?, 'image/jpeg', ?,800,600,?, ST_PointFromText(?, 4326, 'axis-order=long-lat'), 8, ?, 'demo-seed', 'SKIPPED', ?, 0, ?,?,?,?)`,
        [
          id, j.owner, deviceId, j.plan.id, j.stage, main.length, sha, objectKey, thumbKey, main.length, new Date(j.at),
          `POINT(${j.plan.lng + near} ${j.plan.lat})`, JSON.stringify({ demo: true }), Math.round(near * 111_000), new Date(j.at), new Date(j.at), new Date(j.at), new Date(j.at),
        ],
      );
    }
    const open = plans.filter((p) => ['PENDING', 'ASSIGNED', 'WORK_IN_PROGRESS', 'REOPENED'].includes(p.steps.filter((s) => s.to).slice(-1)[0].to!)).length;
    console.log(`  complaints: ${plans.length} demo complaints (${open} open), ${photoJobs.length} photos, 1 event zone`);
  });
}
