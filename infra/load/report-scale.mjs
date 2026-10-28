// Report scaling test: one big ULB with a year of synthetic history, then every dashboard report
// timed through the real ReportsService (same SQL as the API). Uses the load-test database
// prepared by prepare.mjs (its users, wards and types), adds DAYS × PER_DAY complaints.
//   node report-scale.mjs [days=365] [perDay=1000]
// REUSE=1 skips generation and only re-times the reports on history already loaded.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiEnv, DB_URL } from './env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = join(here, '../../apps/api');
const req = createRequire(join(apiDir, 'package.json'));
const pg = req('pg');
const DAYS = Number(process.argv[2] ?? 365);
const PER_DAY = Number(process.argv[3] ?? 1000);

const db = new pg.Client({ connectionString: DB_URL });
await db.connect();
const q = async (sql, p) => (await db.query(sql, p)).rows;
const [{ ulb_id: ulbId, district_id: districtId }] = await q(`SELECT u.id AS ulb_id, u.district_id FROM ulbs u WHERE lgd_code = 980001`);
const [{ n: already }] = await q(`SELECT count(*)::int AS n FROM complaints WHERE description = 'Synthetic history'`);
if (already && process.env.REUSE !== '1') throw new Error('synthetic history already present: run prepare.mjs first, or REUSE=1 to re-time');
if (!already) {
const t0 = Date.now();
// Complaints spread over the last DAYS days; 85 % resolved (70 % of those closed), 10 % assigned, 5 % rejected.
await q(`ALTER TABLE complaint_events DISABLE TRIGGER complaint_events_append_only`); // bulk load only
try {
await q(`
  WITH w AS (SELECT id, area_id, ST_Y(ST_Centroid(geom)) AS lat, ST_X(ST_Centroid(geom)) AS lng, row_number() OVER () - 1 AS i FROM wards WHERE ulb_id = $1),
       nw AS (SELECT count(*) AS n FROM w),
       t AS (SELECT array_agg(id) AS ids FROM complaint_types),
       ci AS (SELECT array_agg(id) AS ids FROM (SELECT id FROM users WHERE role = 'CITIZEN' LIMIT 5000) s),
       sv AS (SELECT array_agg(id) AS ids FROM users WHERE role = 'SUPERVISOR'),
       wk AS (SELECT array_agg(id) AS ids FROM users WHERE role = 'WORKER'),
       g AS (SELECT s, now() - make_interval(secs => (random() * $3::int * 86400)::int) AS created, random() AS r FROM generate_series(1, $3::int * $4::int) s)
  INSERT INTO complaints (complaint_no, citizen_id, district_id, ulb_id, ward_id, area_id, ward_source, type_id, description, location, status,
                          supervisor_id, worker_id, sla_due_at, assigned_at, resolved_at, closed_at, created_at, updated_at)
  SELECT '9801980001' || '99' || lpad(g.s::text, 6, '0'), ci.ids[1 + g.s % array_length(ci.ids, 1)], $2, $1, w.id, w.area_id, 'GPS',
         t.ids[1 + g.s % array_length(t.ids, 1)], 'Synthetic history',
         ST_SetSRID(ST_MakePoint(w.lng + (random() - 0.5) * 0.008, w.lat + (random() - 0.5) * 0.008), 4326),
         (CASE WHEN g.r < 0.595 THEN 'CLOSED' WHEN g.r < 0.85 THEN 'RESOLVED' WHEN g.r < 0.95 THEN 'ASSIGNED' ELSE 'REJECTED' END)::complaint_status,
         sv.ids[1 + g.s % array_length(sv.ids, 1)], wk.ids[1 + g.s % array_length(wk.ids, 1)],
         g.created + interval '24 hours', g.created + interval '20 minutes',
         CASE WHEN g.r < 0.85 THEN g.created + make_interval(mins => (60 + random() * 2880)::int) END,
         CASE WHEN g.r < 0.595 THEN g.created + interval '5 days' END, g.created, g.created
    FROM g CROSS JOIN nw CROSS JOIN t CROSS JOIN ci CROSS JOIN sv CROSS JOIN wk JOIN w ON w.i = g.s % nw.n`,
  [ulbId, districtId, DAYS, PER_DAY]);
await q(`
  INSERT INTO complaint_events (complaint_id, action, from_status, to_status, created_at)
  SELECT id, a, f::complaint_status, t::complaint_status, at FROM (
    SELECT id, 'CREATE' AS a, NULL AS f, 'PENDING' AS t, created_at AS at FROM complaints WHERE description = 'Synthetic history'
    UNION ALL SELECT id, 'ROUTE', 'PENDING', 'ASSIGNED', created_at + interval '1 second' FROM complaints WHERE description = 'Synthetic history'
    UNION ALL SELECT id, 'ASSIGN', 'ASSIGNED', 'ASSIGNED', assigned_at FROM complaints WHERE description = 'Synthetic history' AND status <> 'REJECTED'
    UNION ALL SELECT id, 'RESOLVE', 'WORK_IN_PROGRESS', 'RESOLVED', resolved_at FROM complaints WHERE description = 'Synthetic history' AND resolved_at IS NOT NULL
    UNION ALL SELECT id, 'CLOSE', 'RESOLVED', 'CLOSED', closed_at FROM complaints WHERE description = 'Synthetic history' AND closed_at IS NOT NULL
    UNION ALL SELECT id, 'REJECT', 'ASSIGNED', 'REJECTED', created_at + interval '2 hours' FROM complaints WHERE description = 'Synthetic history' AND status = 'REJECTED'
  ) e`);
} finally {
  await q(`ALTER TABLE complaint_events ENABLE TRIGGER complaint_events_append_only`);
}
await q(`INSERT INTO feedback (complaint_id, citizen_id, rating, created_at)
         SELECT id, citizen_id, 1 + (random() * 4)::int, resolved_at + interval '1 hour' FROM complaints
          WHERE description = 'Synthetic history' AND status = 'CLOSED' AND random() < 0.4`);
await q(`ANALYZE`);
const [{ c, e }] = await q(`SELECT (SELECT count(*) FROM complaints)::int AS c, (SELECT count(*) FROM complaint_events)::int AS e`);
console.log(`generated in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${c} complaints, ${e} events`);
}
await db.end();

// Time each report through the real service (Nest application context on the built API).
Object.assign(process.env, apiEnv, { PROCESS_ROLE: 'api', JOBS_SCHEDULES: 'off' });
const { NestFactory } = req('@nestjs/core');
const { AppModule } = req(join(apiDir, 'dist/app.module.js'));
const { ReportsService } = req(join(apiDir, 'dist/modules/reports/reports.service.js'));
const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
const reports = app.get(ReportsService);
const subAdmin = { id: '00000000-0000-4000-8000-000000000000', role: 'SUB_ADMIN', districtId, ulbId, areaId: null, mustChangePassword: false };
const fmt = (d) => d.toISOString().slice(0, 10);
const ranges = { '30 days': {}, '1 year': { from: fmt(new Date(Date.now() - 364 * 86400e3)), to: fmt(new Date()) } };
for (const [label, range] of Object.entries(ranges)) {
  for (const [name, fn] of Object.entries({
    summary: () => reports.summary(subAdmin, range),
    trend: () => reports.trend(subAdmin, range),
    ageing: () => reports.ageing(subAdmin, { ...range, groupBy: 'ward' }),
    breakdown: () => reports.breakdown(subAdmin, { ...range, by: 'ward' }),
    hotspots: () => reports.hotspots(subAdmin, range),
  })) {
    await fn(); // warm
    const t = Date.now();
    for (let i = 0; i < 3; i++) await fn();
    console.log(`${label.padEnd(8)} ${name.padEnd(10)} ${((Date.now() - t) / 3).toFixed(0).padStart(6)} ms`);
  }
}
await app.close();
