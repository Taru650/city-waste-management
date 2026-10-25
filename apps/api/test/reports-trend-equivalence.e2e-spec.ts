import { Role } from '../src/common/enums';
import { ReportsService } from '../src/modules/reports/reports.service';
import { createJurisdiction, createTestApp, createUser, Jurisdiction, TestCtx } from './helpers';

/**
 * The trend report was rewritten (M9) from per-day correlated subqueries (31 s for 30 days on a
 * year of data) to counting back from the current open count. This keeps the old query as the reference and checks both agree
 * on random histories with reopens, several open spells and complaints opened before the range.
 */
const REFERENCE = `
  WITH scoped AS (SELECT c.id, c.created_at FROM complaints c WHERE c.ulb_id = $1),
  days AS (
    SELECT d::date AS day, (d::date)::timestamp AT TIME ZONE 'Asia/Kolkata' AS sod, (d::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata' AS eod
      FROM generate_series($2::date, $3::date, interval '1 day') d),
  ev AS (
    SELECT e.complaint_id, e.created_at AS since, e.to_status, e.action,
           COALESCE(lead(e.created_at) OVER (PARTITION BY e.complaint_id ORDER BY e.id), 'infinity') AS until
      FROM complaint_events e JOIN scoped s ON s.id = e.complaint_id)
  SELECT to_char(days.day, 'YYYY-MM-DD') AS date,
         (SELECT count(*) FROM scoped s WHERE s.created_at >= days.sod AND s.created_at < days.eod)::int AS received,
         (SELECT count(*) FROM ev WHERE ev.action = 'RESOLVE' AND ev.since >= days.sod AND ev.since < days.eod)::int AS resolved,
         (SELECT count(DISTINCT ev.complaint_id) FROM ev
           WHERE ev.to_status IN ('PENDING','ASSIGNED','WORK_IN_PROGRESS','REOPENED') AND ev.since < days.eod AND ev.until >= days.eod)::int AS pending
    FROM days ORDER BY days.day`;

describe('Trend report: set-based rewrite equals the reference query', () => {
  let ctx: TestCtx;
  let j: Jurisdiction;

  beforeAll(async () => {
    ctx = await createTestApp();
    j = await createJurisdiction(ctx.ds);
    const citizen = await createUser(ctx, Role.CITIZEN, j);
    const [type] = await ctx.ds.query(`SELECT id FROM complaint_types LIMIT 1`);
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const H = 3_600_000;
    const base = Date.now() - 50 * 24 * H;
    for (let i = 0; i < 300; i++) {
      let t = base + rnd() * 48 * 24 * H;
      const [c] = await ctx.ds.query(
        `INSERT INTO complaints (complaint_no, citizen_id, district_id, ulb_id, ward_id, ward_source, type_id, description, location, status, sla_due_at, created_at)
         VALUES ($1, $2, $3, $4, $5, 'GPS', $6, 'equivalence', ST_SetSRID(ST_MakePoint(80, 25), 4326), 'PENDING', now(), $7) RETURNING id`,
        [`${String(j.districtLgd).padStart(4, '0')}${String(j.ulbLgd).padStart(6, '0')}77${String(i).padStart(6, '0')}`, citizen.id, j.districtId, j.ulbId, j.wards[0].id, type.id, new Date(t)],
      );
      const steps: [string, string | null, string][] = [['CREATE', null, 'PENDING'], ['ROUTE', 'PENDING', 'ASSIGNED']];
      if (rnd() < 0.7) steps.push(['START', 'ASSIGNED', 'WORK_IN_PROGRESS']);
      const r = rnd();
      if (r < 0.15) steps.push(['REJECT', steps[steps.length - 1][2], 'REJECTED']);
      else if (r < 0.85) {
        steps.push(['RESOLVE', steps[steps.length - 1][2], 'RESOLVED']);
        const reopens = rnd() < 0.3 ? 1 + Math.floor(rnd() * 2) : 0; // several spells
        for (let k = 0; k < reopens; k++) {
          steps.push(['REOPEN', 'RESOLVED', 'REOPENED'], ['ASSIGN', 'REOPENED', 'ASSIGNED']);
          if (rnd() < 0.8) steps.push(['RESOLVE', 'ASSIGNED', 'RESOLVED']);
          else break;
        }
        if (steps[steps.length - 1][2] === 'RESOLVED' && rnd() < 0.6) steps.push(['CLOSE', 'RESOLVED', 'CLOSED']);
        if (rnd() < 0.1) steps.push(['SLA_BREACH', steps[steps.length - 1][2], steps[steps.length - 1][2]]); // timeline-only
      }
      // complaints.status is the last transition's status, as the state machine keeps it.
      await ctx.ds.query(`UPDATE complaints SET status = $2 WHERE id = $1`, [c.id, steps[steps.length - 1][2]]);
      for (const [action, from, to] of steps) {
        await ctx.ds.query(`INSERT INTO complaint_events (complaint_id, action, from_status, to_status, created_at) VALUES ($1, $2, $3, $4, $5)`,
          [c.id, action, from, to, new Date(t)]);
        t = Math.min(t + (rnd() < 0.2 ? rnd() * 60_000 : rnd() * 3 * 24 * H), Date.now() - 60_000); // some same-day, some multi-day steps
      }
    }
  });
  afterAll(() => ctx.app.close());

  it.each([
    ['last 30 days', 30, 0],
    ['a window in the middle (open complaints carried in from before it)', 12, 20],
    ['a single day', 1, 5],
  ])('%s', async (_l, length, endAgo) => {
    const day = (ago: number) => new Date(Date.now() - ago * 86_400_000 + 5.5 * 3_600_000).toISOString().slice(0, 10);
    const from = day(endAgo + length - 1);
    const to = day(endAgo);
    const expected = await ctx.ds.query(REFERENCE, [j.ulbId, from, to]);
    const subAdmin = { id: 'x', role: Role.SUB_ADMIN, districtId: j.districtId, ulbId: j.ulbId, areaId: null, mustChangePassword: false };
    const actual = await ctx.app.get(ReportsService).trend(subAdmin, { from, to });
    expect(actual.rows).toEqual(expected);
    expect(expected.some((r: { pending: number }) => r.pending > 0)).toBe(true);
  });
});
