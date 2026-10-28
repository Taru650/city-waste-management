import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthUser } from '../../common/auth-user';
import { complaintScope } from '../../common/complaint-scope';
import { formatComplaintNo } from '../complaints/complaint-number';
import { AgeingGroup, BreakdownBy, ReportFilterQuery } from './dto/reports.dto';
import { resolveRange } from './report-range';

const OPEN = `('PENDING','ASSIGNED','WORK_IN_PROGRESS','REOPENED')`;
const TZ = `'Asia/Kolkata'`;
export const EXPORT_ROW_LIMIT = 50_000;

const hours = (from: string, to: string) => `EXTRACT(EPOCH FROM (${to} - ${from})) / 3600`;
const round1 = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
const pct = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 1000) / 10);

/** Dimension → [key expression, label expression, joins needed]. */
const DIMENSIONS: Record<BreakdownBy | Exclude<AgeingGroup, 'none'>, { key: string; label: string }> = {
  district: { key: 'd.id', label: 'd.name' },
  ulb: { key: 'u.id', label: 'u.name' },
  ward: { key: 'w.id', label: `u.name || ' — Ward ' || w.number` },
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

interface Built {
  where: string;
  params: unknown[];
  range: { from: string; to: string; days: number };
}

/**
 * Pendency, disposal and quality analytics. Every query starts from complaintScope(), the
 * same predicate as the complaint inbox, so a report can never reveal more than the caller
 * could open. Days are IST calendar days.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly ds: DataSource) {}

  /** Geography/type filters + jurisdiction; `dated` adds the created_at window. */
  private build(user: AuthUser, q: ReportFilterQuery, dated = true): Built {
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const range = resolveRange(q.from, q.to);
    const where = [complaintScope(user, params)];
    if (q.districtId) where.push(`c.district_id = ${p(q.districtId)}`);
    if (q.ulbId) where.push(`c.ulb_id = ${p(q.ulbId)}`);
    if (q.wardId) where.push(`c.ward_id = ${p(q.wardId)}`);
    if (q.typeId) where.push(`c.type_id = ${p(q.typeId)}`);
    if (q.eventZoneId) where.push(`c.event_zone_id = ${p(q.eventZoneId)}`);
    if (dated) {
      where.push(`c.created_at >= (${p(range.from)}::date)::timestamp AT TIME ZONE ${TZ}`);
      where.push(`c.created_at < (${p(range.to)}::date + 1)::timestamp AT TIME ZONE ${TZ}`);
    }
    return { where: where.join(' AND '), params, range };
  }

  async summary(user: AuthUser, q: ReportFilterQuery) {
    const { where, params, range } = this.build(user, q);
    const disposal = hours('c.created_at', 'c.resolved_at');
    const [core] = await this.ds.query(
      `SELECT count(*)::int AS received,
              count(*) FILTER (WHERE c.status IN ('RESOLVED','CLOSED'))::int AS resolved,
              count(*) FILTER (WHERE c.status IN ${OPEN})::int AS pending,
              count(*) FILTER (WHERE c.status = 'REJECTED')::int AS rejected,
              count(*) FILTER (WHERE c.status = 'DUPLICATE')::int AS duplicate,
              count(*) FILTER (WHERE c.status IN ${OPEN} AND c.sla_due_at < now())::int AS overdue,
              count(*) FILTER (WHERE c.escalated)::int AS escalated,
              count(*) FILTER (WHERE c.reopen_count > 0)::int AS reopened,
              count(*) FILTER (WHERE c.ward_mismatch)::int AS ward_mismatch,
              avg(${disposal}) FILTER (WHERE c.resolved_at IS NOT NULL) AS avg_disposal_h,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY ${disposal}) FILTER (WHERE c.resolved_at IS NOT NULL) AS median_disposal_h,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY ${disposal}) FILTER (WHERE c.resolved_at IS NOT NULL) AS p90_disposal_h,
              avg(${hours('c.created_at', 'c.assigned_at')}) FILTER (WHERE c.assigned_at IS NOT NULL) AS avg_assign_h,
              avg((c.resolved_at <= c.sla_due_at)::int) FILTER (WHERE c.resolved_at IS NOT NULL) AS sla_compliance
         FROM complaints c WHERE ${where}`,
      params,
    );
    const [fb] = await this.ds.query(
      `SELECT count(*)::int AS feedbacks, avg(f.rating) AS avg_rating, avg((f.rating >= 4)::int) AS satisfied
         FROM feedback f JOIN complaints c ON c.id = f.complaint_id WHERE ${where}`,
      params,
    );
    const [media] = await this.ds.query(
      `SELECT count(*)::int AS proofs, count(*) FILTER (WHERE m.outside_geofence)::int AS flagged
         FROM complaint_media m JOIN complaints c ON c.id = m.complaint_id
        WHERE m.stage = 'RESOLUTION' AND ${where}`,
      params,
    );
    const types = await this.ds.query(
      `SELECT t.code, t.name_en AS "nameEn", t.name_hi AS "nameHi", count(*)::int AS count
         FROM complaints c JOIN complaint_types t ON t.id = c.type_id WHERE ${where}
        GROUP BY t.code, t.name_en, t.name_hi ORDER BY count DESC`,
      params,
    );
    const disposed = core.resolved + core.rejected + core.duplicate;
    return {
      range,
      counts: {
        received: core.received, resolved: core.resolved, pending: core.pending, rejected: core.rejected,
        duplicate: core.duplicate, overdue: core.overdue, escalated: core.escalated,
      },
      disposal: {
        disposalRatePct: core.received ? pct(disposed / core.received) : null,
        avgHours: round1(core.avg_disposal_h),
        medianHours: round1(core.median_disposal_h),
        p90Hours: round1(core.p90_disposal_h),
        avgAssignmentHours: round1(core.avg_assign_h),
        slaCompliancePct: pct(core.sla_compliance),
      },
      quality: {
        feedbacks: fb.feedbacks,
        avgRating: round1(fb.avg_rating),
        satisfiedPct: pct(fb.satisfied),
        reopenRatePct: core.resolved ? pct(core.reopened / core.resolved) : null,
        resolutionProofs: media.proofs,
        proofsOutsideGeofencePct: media.proofs ? pct(media.flagged / media.proofs) : null,
        wardMismatchPct: core.received ? pct(core.ward_mismatch / core.received) : null,
      },
      byType: types,
    };
  }

  /** Current pendency by age of complaint. Uses geography/type filters; not the date window. */
  async ageing(user: AuthUser, q: ReportFilterQuery & { groupBy?: AgeingGroup }) {
    const { where, params } = this.build(user, q, false);
    const dim = q.groupBy && q.groupBy !== 'none' ? DIMENSIONS[q.groupBy] : { key: `'all'`, label: `'All'` };
    const age = `EXTRACT(EPOCH FROM (now() - c.created_at)) / 86400`;
    const rows = await this.ds.query(
      `SELECT ${dim.key} AS key, ${dim.label} AS label, count(*)::int AS total,
              count(*) FILTER (WHERE ${age} < 1)::int AS "d0_1",
              count(*) FILTER (WHERE ${age} >= 1 AND ${age} < 3)::int AS "d1_3",
              count(*) FILTER (WHERE ${age} >= 3 AND ${age} < 7)::int AS "d3_7",
              count(*) FILTER (WHERE ${age} >= 7 AND ${age} < 15)::int AS "d7_15",
              count(*) FILTER (WHERE ${age} >= 15)::int AS "d15_plus",
              count(*) FILTER (WHERE c.sla_due_at < now())::int AS overdue
         FROM complaints c ${JOINS}
        WHERE c.status IN ${OPEN} AND ${where}
        GROUP BY 1, 2 ORDER BY total DESC LIMIT 1000`,
      params,
    );
    return { buckets: ['d0_1', 'd1_3', 'd3_7', 'd7_15', 'd15_plus'], rows };
  }

  /**
   * Date-wise received / resolved / pending-at-end-of-day. Pending is reconstructed from the
   * append-only event history (open intervals), so it is correct even across reopens.
   */
  async trend(user: AuthUser, q: ReportFilterQuery) {
    const { where, params, range } = this.build(user, q, false);
    const f = params.length + 1;
    const t = params.length + 2;
    // Counted backwards from the current open count: pending at the end of day d = open now − the net
    // change of events after d, where an event's change is (to open) − (from open). Only events since
    // the start of the range are read (no sort over the whole history). Relies on complaints.status
    // being the last event's to_status and from_status the previous one, which the state machine writes
    // in one transaction. The previous per-day correlated subqueries took 31 s for 30 days and 328 s for
    // a year in a ULB with a year of history; test/reports-trend-equivalence keeps them as the reference.
    const sod = `($${f}::date)::timestamp AT TIME ZONE ${TZ}`;
    const eod = `($${t}::date + 1)::timestamp AT TIME ZONE ${TZ}`;
    const rows = await this.ds.query(
      `WITH scoped AS (SELECT c.id, c.created_at, c.status FROM complaints c WHERE ${where}),
       days AS (SELECT d::date AS day FROM generate_series($${f}::date, $${t}::date, interval '1 day') d),
       ev AS (
         SELECT e.created_at, e.action,
                (e.to_status IN ${OPEN})::int - COALESCE((e.from_status IN ${OPEN})::int, 0) AS change
           FROM complaint_events e JOIN scoped s ON s.id = e.complaint_id
          WHERE e.created_at >= ${sod}
       ),
       open_now AS (SELECT count(*) AS n FROM scoped WHERE status IN ${OPEN}),
       after_range AS (SELECT COALESCE(sum(change), 0) AS n FROM ev WHERE created_at >= ${eod}),
       daily AS (
         SELECT (created_at AT TIME ZONE ${TZ})::date AS day, sum(change) AS change, count(*) FILTER (WHERE action = 'RESOLVE') AS resolved
           FROM ev WHERE created_at < ${eod} GROUP BY 1
       ),
       recv AS (
         SELECT (created_at AT TIME ZONE ${TZ})::date AS day, count(*) AS n FROM scoped
          WHERE created_at >= ${sod} AND created_at < ${eod} GROUP BY 1
       )
       SELECT to_char(days.day, 'YYYY-MM-DD') AS date,
              COALESCE(recv.n, 0)::int AS received,
              COALESCE(daily.resolved, 0)::int AS resolved,
              (open_now.n - after_range.n
                 - COALESCE(sum(daily.change) OVER (ORDER BY days.day DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0))::int AS pending
         FROM days LEFT JOIN recv USING (day) LEFT JOIN daily USING (day) CROSS JOIN open_now CROSS JOIN after_range
        ORDER BY days.day`,
      [...params, range.from, range.to],
    );
    return { range, rows };
  }

  async breakdown(user: AuthUser, q: ReportFilterQuery & { by: BreakdownBy }) {
    const { where, params, range } = this.build(user, q);
    const dim = DIMENSIONS[q.by];
    const disposal = hours('c.created_at', 'c.resolved_at');
    const rows = await this.ds.query(
      `WITH fb AS (SELECT complaint_id, avg(rating) AS rating FROM feedback GROUP BY complaint_id)
       SELECT ${dim.key} AS key, ${dim.label} AS label,
              count(*)::int AS received,
              count(*) FILTER (WHERE c.status IN ('RESOLVED','CLOSED'))::int AS resolved,
              count(*) FILTER (WHERE c.status IN ${OPEN})::int AS pending,
              count(*) FILTER (WHERE c.status IN ${OPEN} AND c.sla_due_at < now())::int AS overdue,
              count(*) FILTER (WHERE c.status IN ('REJECTED','DUPLICATE'))::int AS "rejectedOrDuplicate",
              avg(${disposal}) FILTER (WHERE c.resolved_at IS NOT NULL) AS avg_disposal_h,
              avg((c.resolved_at <= c.sla_due_at)::int) FILTER (WHERE c.resolved_at IS NOT NULL) AS sla_compliance,
              avg(fb.rating) AS avg_rating,
              count(*) FILTER (WHERE c.reopen_count > 0)::int AS reopened
         FROM complaints c ${JOINS} LEFT JOIN fb ON fb.complaint_id = c.id
        WHERE ${where}
        GROUP BY 1, 2 ORDER BY received DESC LIMIT 1000`,
      params,
    );
    return {
      range,
      by: q.by,
      rows: rows.map((r: Record<string, number | string | null>) => ({
        key: r.key, label: r.label, received: r.received, resolved: r.resolved, pending: r.pending, overdue: r.overdue,
        rejectedOrDuplicate: r.rejectedOrDuplicate,
        avgDisposalHours: round1(r.avg_disposal_h),
        slaCompliancePct: pct(r.sla_compliance),
        avgRating: round1(r.avg_rating),
        reopenRatePct: Number(r.resolved) ? pct(Number(r.reopened) / Number(r.resolved)) : null,
      })),
    };
  }

  /** Complaint density on a ~110 m grid, for the hotspot map. */
  async hotspots(user: AuthUser, q: ReportFilterQuery) {
    const { where, params, range } = this.build(user, q);
    const rows = await this.ds.query(
      `SELECT round(ST_Y(c.location)::numeric, 3)::float AS lat, round(ST_X(c.location)::numeric, 3)::float AS lng,
              count(*)::int AS total, count(*) FILTER (WHERE c.status IN ${OPEN})::int AS open
         FROM complaints c WHERE ${where}
        GROUP BY 1, 2 ORDER BY total DESC LIMIT 2000`,
      params,
    );
    return { range, points: rows };
  }

  /** Row-level export (no citizen identity). Refuses oversized windows instead of truncating silently. */
  async complaintRows(user: AuthUser, q: ReportFilterQuery) {
    const { where, params } = this.build(user, q);
    const [{ n }] = await this.ds.query(`SELECT count(*)::int AS n FROM complaints c WHERE ${where}`, params);
    if (n > EXPORT_ROW_LIMIT) throw new BadRequestException(`Export has ${n} rows; narrow the filters to ${EXPORT_ROW_LIMIT} or fewer`);
    const rows = await this.ds.query(
      `SELECT c.complaint_no, to_char(c.created_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') AS filed_at,
              d.name AS district, u.name AS ulb, w.number AS ward, t.name_en AS type, c.status,
              c.landmark, c.description, sv.name AS supervisor, wk.name AS worker,
              to_char(c.sla_due_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') AS sla_due,
              to_char(c.resolved_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') AS resolved_at,
              round((${hours('c.created_at', 'c.resolved_at')})::numeric, 1)::float AS disposal_hours,
              CASE WHEN c.resolved_at IS NULL THEN NULL ELSE c.resolved_at <= c.sla_due_at END AS sla_met,
              (SELECT f.rating FROM feedback f WHERE f.complaint_id = c.id ORDER BY f.created_at DESC LIMIT 1) AS rating,
              c.reopen_count, c.escalated, c.ward_mismatch
         FROM complaints c ${JOINS}
        WHERE ${where} ORDER BY c.created_at`,
      params,
    );
    return rows.map((r: { complaint_no: string }) => ({ ...r, complaint_no: formatComplaintNo(r.complaint_no) }));
  }
}
