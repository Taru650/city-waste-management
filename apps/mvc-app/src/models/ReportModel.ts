import type { Db } from '@/db/sql';
import { one, query } from '@/db/sql';
import type { AuthUser } from '@/middleware/auth';
import { complaintScope } from './ComplaintModel';
import type { AgeingGroup, BreakdownBy, ReportFilter } from '@/validation/reports';

const OPEN = `('PENDING','ASSIGNED','WORK_IN_PROGRESS','REOPENED')`;
const IST_TS = (col: string) => `CONVERT_TZ(${col}, '+00:00', '+05:30')`;
const HOURS = (from: string, to: string) => `(TIMESTAMPDIFF(MICROSECOND, ${from}, ${to}) / 3600000000)`;
const HOURS_TO_DISPOSAL = HOURS('c.created_at', 'c.resolved_at');

/** Dimension -> key and label expressions. */
const DIMENSIONS: Record<BreakdownBy | Exclude<AgeingGroup, 'none'>, { key: string; label: string }> = {
  district: { key: 'd.id', label: 'd.name' },
  ulb: { key: 'u.id', label: 'u.name' },
  ward: { key: 'w.id', label: `CONCAT(u.name, ' — Ward ', w.number)` },
  type: { key: 't.id', label: 't.name_en' },
  supervisor: { key: 'c.supervisor_id', label: `COALESCE(sv.name, 'Unassigned')` },
  worker: { key: 'c.worker_id', label: `COALESCE(wk.name, 'Unassigned')` },
};

const JOINS = `
  JOIN districts d ON d.id = c.district_id
  JOIN ulbs u ON u.id = c.ulb_id
  JOIN wards w ON w.id = c.ward_id
  JOIN complaint_types t ON t.id = c.type_id
  LEFT JOIN users sv ON sv.id = c.supervisor_id
  LEFT JOIN users wk ON wk.id = c.worker_id`;

export interface Where {
  sql: string;
  params: unknown[];
}

/**
 * Every report starts from complaintScope(), the same predicate as the complaint inbox, so a report can never reveal
 * more than the caller could open. `window` limits to complaints filed in [start, end).
 */
export function reportWhere(user: AuthUser, f: ReportFilter, window?: { start: Date; end: Date }): Where {
  const scope = complaintScope(user);
  const parts = [scope.sql];
  const params: unknown[] = [...scope.params];
  const add = (sql: string, v: unknown) => {
    parts.push(sql);
    params.push(v);
  };
  if (f.districtId) add('c.district_id = ?', f.districtId);
  if (f.ulbId) add('c.ulb_id = ?', f.ulbId);
  if (f.wardId) add('c.ward_id = ?', f.wardId);
  if (f.typeId) add('c.type_id = ?', f.typeId);
  if (f.eventZoneId) add('c.event_zone_id = ?', f.eventZoneId);
  if (window) {
    add('c.created_at >= ?', window.start);
    add('c.created_at < ?', window.end);
  }
  return { sql: parts.join(' AND '), params };
}

type Row = Record<string, any>;  

export const ReportModel = {
  core(d: Db, w: Where) {
    return one<Row>(
      d,
      `SELECT COUNT(*) AS received,
              COALESCE(SUM(c.status IN ('RESOLVED','CLOSED')), 0) AS resolved,
              COALESCE(SUM(c.status IN ${OPEN}), 0) AS pending,
              COALESCE(SUM(c.status = 'REJECTED'), 0) AS rejected,
              COALESCE(SUM(c.status = 'DUPLICATE'), 0) AS duplicate,
              COALESCE(SUM(c.status IN ${OPEN} AND c.sla_due_at < NOW(3)), 0) AS overdue,
              COALESCE(SUM(c.escalated), 0) AS escalated,
              COALESCE(SUM(c.reopen_count > 0), 0) AS reopened,
              COALESCE(SUM(c.ward_mismatch), 0) AS ward_mismatch,
              AVG(CASE WHEN c.resolved_at IS NOT NULL THEN ${HOURS_TO_DISPOSAL} END) AS avg_disposal_h,
              AVG(CASE WHEN c.assigned_at IS NOT NULL THEN ${HOURS('c.created_at', 'c.assigned_at')} END) AS avg_assign_h,
              AVG(CASE WHEN c.resolved_at IS NOT NULL THEN (c.resolved_at <= c.sla_due_at) END) AS sla_compliance
         FROM complaints c WHERE ${w.sql}`,
      w.params,
    );
  },

  /** The values at positions that surround each requested percentile of disposal time (interpolated by the service). */
  async disposalPercentiles(d: Db, w: Where, percentiles: number[]) {
    const wanted = percentiles.flatMap((p) => [`FLOOR(1 + (x.cnt - 1) * ${p})`, `CEIL(1 + (x.cnt - 1) * ${p})`]).join(', ');
    const rows = await query<{ h: number; rn: number; cnt: number }>(
      d,
      `SELECT x.h, x.rn, x.cnt
         FROM (SELECT ${HOURS_TO_DISPOSAL} AS h, ROW_NUMBER() OVER (ORDER BY ${HOURS_TO_DISPOSAL}, c.id) AS rn, COUNT(*) OVER () AS cnt
                 FROM complaints c WHERE ${w.sql} AND c.resolved_at IS NOT NULL) x
        WHERE x.rn IN (${wanted})`,
      w.params,
    );
    return rows.map((r) => ({ h: Number(r.h), rn: Number(r.rn), cnt: Number(r.cnt) }));
  },

  feedback(d: Db, w: Where) {
    return one<Row>(
      d,
      `SELECT COUNT(*) AS feedbacks, AVG(f.rating) AS avg_rating, AVG(f.rating >= 4) AS satisfied
         FROM feedback f JOIN complaints c ON c.id = f.complaint_id WHERE ${w.sql}`,
      w.params,
    );
  },

  proofs(d: Db, w: Where) {
    return one<Row>(
      d,
      `SELECT COUNT(*) AS proofs, COALESCE(SUM(m.outside_geofence), 0) AS flagged
         FROM complaint_media m JOIN complaints c ON c.id = m.complaint_id
        WHERE m.stage = 'RESOLUTION' AND ${w.sql}`,
      w.params,
    );
  },

  byType(d: Db, w: Where) {
    return query<Row>(
      d,
      `SELECT t.code, t.name_en AS nameEn, t.name_hi AS nameHi, COUNT(*) AS count
         FROM complaints c JOIN complaint_types t ON t.id = c.type_id WHERE ${w.sql}
        GROUP BY t.code, t.name_en, t.name_hi ORDER BY count DESC, t.code`,
      w.params,
    );
  },

  ageing(d: Db, w: Where, groupBy: AgeingGroup) {
    const dim = groupBy !== 'none' ? DIMENSIONS[groupBy] : { key: `'all'`, label: `'All'` };
    const age = `(TIMESTAMPDIFF(MICROSECOND, c.created_at, NOW(3)) / 86400000000)`;
    return query<Row>(
      d,
      `SELECT ${dim.key} AS \`key\`, ${dim.label} AS label, COUNT(*) AS total,
              COALESCE(SUM(${age} < 1), 0) AS d0_1,
              COALESCE(SUM(${age} >= 1 AND ${age} < 3), 0) AS d1_3,
              COALESCE(SUM(${age} >= 3 AND ${age} < 7), 0) AS d3_7,
              COALESCE(SUM(${age} >= 7 AND ${age} < 15), 0) AS d7_15,
              COALESCE(SUM(${age} >= 15), 0) AS d15_plus,
              COALESCE(SUM(c.sla_due_at < NOW(3)), 0) AS overdue
         FROM complaints c ${JOINS}
        WHERE c.status IN ${OPEN} AND ${w.sql}
        GROUP BY 1, 2 ORDER BY total DESC, label LIMIT 1000`,
      w.params,
    );
  },

  /**
   * Date-wise received / resolved / pending at the end of each IST day. Pending is counted backwards from the current
   * open count using the change each event made (to open minus from open), so it is right across reopens. Only
   * events since the start of the range are read. Relies on complaints.status being the last event's to_status and
   * from_status being the previous one, which the state machine writes in one transaction.
   */
  trend(d: Db, w: Where, range: { from: string; to: string }, start: Date, end: Date) {
    return query<Row>(
      d,
      `WITH RECURSIVE
         days AS (SELECT DATE(?) AS day UNION ALL SELECT day + INTERVAL 1 DAY FROM days WHERE day < DATE(?)),
         scoped AS (SELECT c.id, c.created_at, c.status FROM complaints c WHERE ${w.sql}),
         ev AS (
           SELECT e.created_at, e.action, ((e.to_status IN ${OPEN}) - COALESCE(e.from_status IN ${OPEN}, 0)) AS chg
             FROM complaint_events e JOIN scoped s ON s.id = e.complaint_id
            WHERE e.created_at >= ?
         ),
         open_now AS (SELECT COUNT(*) AS n FROM scoped WHERE status IN ${OPEN}),
         after_range AS (SELECT COALESCE(SUM(chg), 0) AS n FROM ev WHERE created_at >= ?),
         daily AS (
           SELECT DATE(${IST_TS('created_at')}) AS day, SUM(chg) AS chg, SUM(action = 'RESOLVE') AS resolved
             FROM ev WHERE created_at < ? GROUP BY 1
         ),
         recv AS (
           SELECT DATE(${IST_TS('created_at')}) AS day, COUNT(*) AS n FROM scoped WHERE created_at >= ? AND created_at < ? GROUP BY 1
         )
       SELECT DATE_FORMAT(days.day, '%Y-%m-%d') AS date,
              COALESCE(recv.n, 0) AS received,
              COALESCE(daily.resolved, 0) AS resolved,
              (open_now.n - after_range.n
                 - COALESCE(SUM(daily.chg) OVER (ORDER BY days.day DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)) AS pending
         FROM days
         LEFT JOIN recv ON recv.day = days.day
         LEFT JOIN daily ON daily.day = days.day
         CROSS JOIN open_now CROSS JOIN after_range
        ORDER BY days.day`,
      [range.from, range.to, ...w.params, start, end, end, start, end],
    );
  },

  breakdown(d: Db, w: Where, by: BreakdownBy) {
    const dim = DIMENSIONS[by];
    return query<Row>(
      d,
      `WITH fb AS (SELECT complaint_id, AVG(rating) AS rating FROM feedback GROUP BY complaint_id)
       SELECT ${dim.key} AS \`key\`, ${dim.label} AS label,
              COUNT(*) AS received,
              COALESCE(SUM(c.status IN ('RESOLVED','CLOSED')), 0) AS resolved,
              COALESCE(SUM(c.status IN ${OPEN}), 0) AS pending,
              COALESCE(SUM(c.status IN ${OPEN} AND c.sla_due_at < NOW(3)), 0) AS overdue,
              COALESCE(SUM(c.status IN ('REJECTED','DUPLICATE')), 0) AS rejectedOrDuplicate,
              AVG(CASE WHEN c.resolved_at IS NOT NULL THEN ${HOURS_TO_DISPOSAL} END) AS avg_disposal_h,
              AVG(CASE WHEN c.resolved_at IS NOT NULL THEN (c.resolved_at <= c.sla_due_at) END) AS sla_compliance,
              AVG(fb.rating) AS avg_rating,
              COALESCE(SUM(c.reopen_count > 0), 0) AS reopened
         FROM complaints c ${JOINS} LEFT JOIN fb ON fb.complaint_id = c.id
        WHERE ${w.sql}
        GROUP BY 1, 2 ORDER BY received DESC, label LIMIT 1000`,
      w.params,
    );
  },

  /** Complaint density on a grid of about 110 m. */
  hotspots(d: Db, w: Where) {
    return query<Row>(
      d,
      `SELECT ROUND(c.lat, 3) AS lat, ROUND(c.lng, 3) AS lng, COUNT(*) AS total, COALESCE(SUM(c.status IN ${OPEN}), 0) AS open
         FROM complaints c WHERE ${w.sql}
        GROUP BY 1, 2 ORDER BY total DESC, lat, lng LIMIT 2000`,
      w.params,
    );
  },

  async countRows(d: Db, w: Where): Promise<number> {
    return Number((await one<{ n: number }>(d, `SELECT COUNT(*) AS n FROM complaints c WHERE ${w.sql}`, w.params))!.n);
  },

  /** Row-level export. No citizen identity is selected. */
  complaintRows(d: Db, w: Where) {
    return query<Row>(
      d,
      `SELECT c.complaint_no, DATE_FORMAT(${IST_TS('c.created_at')}, '%Y-%m-%d %H:%i') AS filed_at,
              d.name AS district, u.name AS ulb, w.number AS ward, t.name_en AS type, c.status,
              c.landmark, c.description, sv.name AS supervisor, wk.name AS worker,
              DATE_FORMAT(${IST_TS('c.sla_due_at')}, '%Y-%m-%d %H:%i') AS sla_due,
              DATE_FORMAT(${IST_TS('c.resolved_at')}, '%Y-%m-%d %H:%i') AS resolved_at,
              ROUND(${HOURS_TO_DISPOSAL}, 1) AS disposal_hours,
              CASE WHEN c.resolved_at IS NULL THEN NULL ELSE (c.resolved_at <= c.sla_due_at) END AS sla_met,
              (SELECT f.rating FROM feedback f WHERE f.complaint_id = c.id ORDER BY f.created_at DESC, f.id DESC LIMIT 1) AS rating,
              c.reopen_count, c.escalated, c.ward_mismatch
         FROM complaints c ${JOINS}
        WHERE ${w.sql} ORDER BY c.created_at, c.id`,
      w.params,
    );
  },
};
