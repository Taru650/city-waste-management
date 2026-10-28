import { db } from '@/db/connection';
import { badRequest } from '@/lib/errors';
import { formatComplaintNo } from '@/lib/complaintNumber';
import { rangeBounds, resolveRange } from '@/lib/reportRange';
import { ReportModel, reportWhere } from '@/models/ReportModel';
import type { AuthUser } from '@/middleware/auth';
import type { AgeingGroup, BreakdownBy, ReportFilter } from '@/validation/reports';

export const EXPORT_ROW_LIMIT = 50_000;

type Row = Record<string, any>;  
const num = (v: unknown) => Number(v ?? 0);
const round1 = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
const pct = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 1000) / 10);

/** Linear-interpolated percentile (what PostgreSQL's percentile_cont does) from the rows around the wanted position. */
function percentile(rows: { h: number; rn: number; cnt: number }[], p: number): number | null {
  if (!rows.length) return null;
  const cnt = rows[0].cnt;
  const pos = 1 + (cnt - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const at = (rn: number) => rows.find((r) => r.rn === rn)!.h;
  return at(lo) + (pos - lo) * (at(hi) - at(lo));
}

/**
 * Pendency, disposal and quality analytics. Days are IST calendar days; every query starts from the same visibility
 * rule as the complaint inbox.
 */
export const ReportService = {
  async summary(user: AuthUser, q: ReportFilter) {
    const range = resolveRange(q.from, q.to);
    const w = reportWhere(user, q, rangeBounds(range));
    const [core, fb, media, types, pcts] = await Promise.all([
      ReportModel.core(db(), w),
      ReportModel.feedback(db(), w),
      ReportModel.proofs(db(), w),
      ReportModel.byType(db(), w),
      ReportModel.disposalPercentiles(db(), w, [0.5, 0.9]),
    ]);
    const c = core!;
    const received = num(c.received);
    const resolved = num(c.resolved);
    const disposed = resolved + num(c.rejected) + num(c.duplicate);
    return {
      range,
      counts: {
        received, resolved, pending: num(c.pending), rejected: num(c.rejected), duplicate: num(c.duplicate), overdue: num(c.overdue), escalated: num(c.escalated),
      },
      disposal: {
        disposalRatePct: received ? pct(disposed / received) : null,
        avgHours: round1(c.avg_disposal_h),
        medianHours: round1(percentile(pcts, 0.5)),
        p90Hours: round1(percentile(pcts, 0.9)),
        avgAssignmentHours: round1(c.avg_assign_h),
        slaCompliancePct: pct(c.sla_compliance),
      },
      quality: {
        feedbacks: num(fb!.feedbacks),
        avgRating: round1(fb!.avg_rating),
        satisfiedPct: pct(fb!.satisfied),
        reopenRatePct: resolved ? pct(num(c.reopened) / resolved) : null,
        resolutionProofs: num(media!.proofs),
        proofsOutsideGeofencePct: num(media!.proofs) ? pct(num(media!.flagged) / num(media!.proofs)) : null,
        wardMismatchPct: received ? pct(num(c.ward_mismatch) / received) : null,
      },
      byType: types.map((t) => ({ code: t.code, nameEn: t.nameEn, nameHi: t.nameHi, count: num(t.count) })),
    };
  },

  /** Current pendency by age of complaint. Uses geography and type filters; not the date window. */
  async ageing(user: AuthUser, q: ReportFilter & { groupBy?: AgeingGroup }) {
    const rows = await ReportModel.ageing(db(), reportWhere(user, q), q.groupBy ?? 'none');
    return {
      buckets: ['d0_1', 'd1_3', 'd3_7', 'd7_15', 'd15_plus'],
      rows: rows.map((r) => ({
        key: r.key, label: r.label, total: num(r.total), d0_1: num(r.d0_1), d1_3: num(r.d1_3), d3_7: num(r.d3_7), d7_15: num(r.d7_15), d15_plus: num(r.d15_plus), overdue: num(r.overdue),
      })),
    };
  },

  async trend(user: AuthUser, q: ReportFilter) {
    const range = resolveRange(q.from, q.to);
    const { start, end } = rangeBounds(range);
    const rows = await ReportModel.trend(db(), reportWhere(user, q), range, start, end);
    return { range, rows: rows.map((r) => ({ date: r.date as string, received: num(r.received), resolved: num(r.resolved), pending: num(r.pending) })) };
  },

  async breakdown(user: AuthUser, q: ReportFilter & { by: BreakdownBy }) {
    const range = resolveRange(q.from, q.to);
    const rows = await ReportModel.breakdown(db(), reportWhere(user, q, rangeBounds(range)), q.by);
    return {
      range,
      by: q.by,
      rows: rows.map((r) => ({
        key: r.key, label: r.label, received: num(r.received), resolved: num(r.resolved), pending: num(r.pending), overdue: num(r.overdue),
        rejectedOrDuplicate: num(r.rejectedOrDuplicate),
        avgDisposalHours: round1(r.avg_disposal_h),
        slaCompliancePct: pct(r.sla_compliance),
        avgRating: round1(r.avg_rating),
        reopenRatePct: num(r.resolved) ? pct(num(r.reopened) / num(r.resolved)) : null,
      })),
    };
  },

  async hotspots(user: AuthUser, q: ReportFilter) {
    const range = resolveRange(q.from, q.to);
    const rows = await ReportModel.hotspots(db(), reportWhere(user, q, rangeBounds(range)));
    return { range, points: rows.map((r) => ({ lat: Number(r.lat), lng: Number(r.lng), total: num(r.total), open: num(r.open) })) };
  },

  /** Row-level export (no citizen identity). Refuses oversized windows instead of truncating silently. */
  async complaintRows(user: AuthUser, q: ReportFilter): Promise<Record<string, unknown>[]> {
    const range = resolveRange(q.from, q.to);
    const w = reportWhere(user, q, rangeBounds(range));
    const n = await ReportModel.countRows(db(), w);
    if (n > EXPORT_ROW_LIMIT) throw badRequest(`Export has ${n} rows; narrow the filters to ${EXPORT_ROW_LIMIT} or fewer`);
    const rows = await ReportModel.complaintRows(db(), w);
    return rows.map((r: Row) => ({
      ...r,
      complaint_no: formatComplaintNo(r.complaint_no),
      disposal_hours: r.disposal_hours === null ? null : Number(r.disposal_hours),
      sla_met: r.sla_met === null ? null : !!r.sla_met,
      escalated: !!r.escalated,
      ward_mismatch: !!r.ward_mismatch,
    }));
  },
};
