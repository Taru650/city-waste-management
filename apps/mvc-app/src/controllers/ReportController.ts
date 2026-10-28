import type { z } from 'zod';
import { AuditModel } from '@/models/AuditModel';
import { db } from '@/db/connection';
import { exportSlots } from '@/lib/exportSlots';
import { toCsv, toXlsx, type Column } from '@/lib/reportExport';
import type { Ctx } from '@/middleware/route';
import { ReportService } from '@/services/ReportService';
import type { ageingQuery, breakdownQuery, exportQuery, reportFilterQuery } from '@/validation/reports';

type P = Record<string, string>;

const BREAKDOWN_COLUMNS: Column[] = [
  { key: 'label', header: 'Name', width: 32 }, { key: 'received', header: 'Received' }, { key: 'resolved', header: 'Resolved' },
  { key: 'pending', header: 'Pending' }, { key: 'overdue', header: 'Overdue' }, { key: 'rejectedOrDuplicate', header: 'Rejected/Duplicate' },
  { key: 'avgDisposalHours', header: 'Avg disposal (h)' }, { key: 'slaCompliancePct', header: 'SLA met %' },
  { key: 'avgRating', header: 'Avg rating' }, { key: 'reopenRatePct', header: 'Reopen %' },
];
const AGEING_COLUMNS: Column[] = [
  { key: 'label', header: 'Name', width: 32 }, { key: 'total', header: 'Pending' }, { key: 'd0_1', header: '< 1 day' },
  { key: 'd1_3', header: '1–3 days' }, { key: 'd3_7', header: '3–7 days' }, { key: 'd7_15', header: '7–15 days' },
  { key: 'd15_plus', header: '> 15 days' }, { key: 'overdue', header: 'Past SLA' },
];
const TREND_COLUMNS: Column[] = [
  { key: 'date', header: 'Date' }, { key: 'received', header: 'Received' }, { key: 'resolved', header: 'Resolved' },
  { key: 'pending', header: 'Pending at day end' },
];
const COMPLAINT_COLUMNS: Column[] = [
  { key: 'complaint_no', header: 'Complaint no.', width: 24 }, { key: 'filed_at', header: 'Filed (IST)', width: 18 },
  { key: 'district', header: 'District' }, { key: 'ulb', header: 'ULB', width: 24 }, { key: 'ward', header: 'Ward' },
  { key: 'type', header: 'Type', width: 24 }, { key: 'status', header: 'Status', width: 18 },
  { key: 'landmark', header: 'Landmark', width: 24 }, { key: 'description', header: 'Description', width: 50 },
  { key: 'supervisor', header: 'Supervisor', width: 20 }, { key: 'worker', header: 'Worker', width: 20 },
  { key: 'sla_due', header: 'SLA due', width: 18 }, { key: 'resolved_at', header: 'Resolved (IST)', width: 18 },
  { key: 'disposal_hours', header: 'Disposal (h)' }, { key: 'sla_met', header: 'SLA met' }, { key: 'rating', header: 'Rating' },
  { key: 'reopen_count', header: 'Reopens' }, { key: 'escalated', header: 'Escalated' }, { key: 'ward_mismatch', header: 'Ward mismatch' },
];

async function build(user: Ctx<unknown, unknown, P>['user'], q: z.infer<typeof exportQuery>) {
  switch (q.report) {
    case 'breakdown': {
      const r = await ReportService.breakdown(user, q);
      return { title: `Complaints by ${q.by}`, columns: BREAKDOWN_COLUMNS, rows: r.rows as unknown as Record<string, unknown>[], range: r.range };
    }
    case 'ageing': {
      const r = await ReportService.ageing(user, q);
      return { title: `Pendency ageing by ${q.groupBy}`, columns: AGEING_COLUMNS, rows: r.rows as unknown as Record<string, unknown>[], range: undefined };
    }
    case 'trend': {
      const r = await ReportService.trend(user, q);
      return { title: 'Date-wise trend', columns: TREND_COLUMNS, rows: r.rows as unknown as Record<string, unknown>[], range: r.range };
    }
    default:
      return { title: 'Complaints', columns: COMPLAINT_COLUMNS, rows: await ReportService.complaintRows(user, q), range: undefined };
  }
}

/** Reports for administrators and supervisors (supervisors see their own areas only). */
export const ReportController = {
  summary: ({ user, query }: Ctx<undefined, z.infer<typeof reportFilterQuery>, P>) => ReportService.summary(user, query),
  ageing: ({ user, query }: Ctx<undefined, z.infer<typeof ageingQuery>, P>) => ReportService.ageing(user, query),
  trend: ({ user, query }: Ctx<undefined, z.infer<typeof reportFilterQuery>, P>) => ReportService.trend(user, query),
  breakdown: ({ user, query }: Ctx<undefined, z.infer<typeof breakdownQuery>, P>) => ReportService.breakdown(user, query),
  hotspots: ({ user, query }: Ctx<undefined, z.infer<typeof reportFilterQuery>, P>) => ReportService.hotspots(user, query),

  async export({ user, query: q, client }: Ctx<undefined, z.infer<typeof exportQuery>, P>) {
    const release = exportSlots.acquire(user.id); // one export at a time per user, two per process
    try {
      const { title, columns, rows, range } = await build(user, q);
      const subtitle = range ? `${range.from} to ${range.to} (IST) — generated ${new Date().toISOString()}` : `As of ${new Date().toISOString()}`;
      await AuditModel.log(db(), { actorId: user.id, action: 'REPORT_EXPORTED', entity: 'report', entityId: q.report, ip: client.ip, meta: { format: q.format, rows: rows.length, filters: { ...q } } });
      const filename = `${q.report}-${new Date().toISOString().slice(0, 10)}.${q.format}`;
      const body = q.format === 'csv' ? toCsv(columns, rows) : await toXlsx(title, subtitle, columns, rows);
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: {
          'Content-Type': q.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Length': String(body.length),
        },
      });
    } finally {
      release();
    }
  },
};
