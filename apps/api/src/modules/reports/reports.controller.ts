import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { AuthUser } from '../../common/auth-user';
import { Client } from '../../common/client-info';
import { CurrentUser, Roles } from '../../common/decorators';
import { Role } from '../../common/enums';
import { AuditService } from '../audit/audit.service';
import { ClientInfo } from '../auth/session.service';
import { AgeingQuery, BreakdownQuery, ExportQuery, ReportFilterQuery } from './dto/reports.dto';
import { ExportSlots } from './export-slots';
import { Column, toCsv, toXlsx } from './report-export';
import { ReportsService } from './reports.service';

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

/** Reports for administrators and supervisors (supervisors see their own areas only). */
@ApiTags('reports')
@ApiBearerAuth()
@Roles(Role.WEB_ADMIN, Role.DISTRICT_ADMIN, Role.SUB_ADMIN, Role.SUPERVISOR)
@Controller('reports')
export class ReportsController {
  readonly exportSlots = new ExportSlots();

  constructor(private readonly reports: ReportsService, private readonly audit: AuditService) {}

  @Get('summary')
  summary(@CurrentUser() user: AuthUser, @Query() q: ReportFilterQuery) {
    return this.reports.summary(user, q);
  }

  @Get('ageing')
  ageing(@CurrentUser() user: AuthUser, @Query() q: AgeingQuery) {
    return this.reports.ageing(user, q);
  }

  @Get('trend')
  trend(@CurrentUser() user: AuthUser, @Query() q: ReportFilterQuery) {
    return this.reports.trend(user, q);
  }

  @Get('breakdown')
  breakdown(@CurrentUser() user: AuthUser, @Query() q: BreakdownQuery) {
    return this.reports.breakdown(user, q);
  }

  @Get('hotspots')
  hotspots(@CurrentUser() user: AuthUser, @Query() q: ReportFilterQuery) {
    return this.reports.hotspots(user, q);
  }

  @Get('export')
  async export(@CurrentUser() user: AuthUser, @Query() q: ExportQuery, @Client() client: ClientInfo, @Res() res: Response) {
    const release = this.exportSlots.acquire(user.id);
    try {
      await this.writeExport(user, q, client, res);
    } finally {
      release();
    }
  }

  private async writeExport(user: AuthUser, q: ExportQuery, client: ClientInfo, res: Response) {
    let title: string;
    let columns: Column[];
    let rows: Record<string, unknown>[];
    let range: { from: string; to: string } | undefined;
    switch (q.report) {
      case 'breakdown': {
        const r = await this.reports.breakdown(user, q);
        [title, columns, rows, range] = [`Complaints by ${q.by}`, BREAKDOWN_COLUMNS, r.rows, r.range];
        break;
      }
      case 'ageing': {
        const r = await this.reports.ageing(user, q);
        [title, columns, rows] = [`Pendency ageing by ${q.groupBy}`, AGEING_COLUMNS, r.rows];
        break;
      }
      case 'trend': {
        const r = await this.reports.trend(user, q);
        [title, columns, rows, range] = ['Date-wise trend', TREND_COLUMNS, r.rows, r.range];
        break;
      }
      default: {
        rows = await this.reports.complaintRows(user, q);
        [title, columns] = ['Complaints', COMPLAINT_COLUMNS];
      }
    }
    const subtitle = range ? `${range.from} to ${range.to} (IST) — generated ${new Date().toISOString()}` : `As of ${new Date().toISOString()}`;
    await this.audit.log({
      actorId: user.id, action: 'REPORT_EXPORTED', entity: 'report', entityId: q.report, ip: client.ip,
      meta: { format: q.format, rows: rows.length, filters: { ...q } },
    });
    const filename = `${q.report}-${new Date().toISOString().slice(0, 10)}.${q.format}`;
    const body = q.format === 'csv' ? toCsv(columns, rows) : await toXlsx(title, subtitle, columns, rows);
    res
      .status(200)
      .set({
        'Content-Type': q.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
      })
      .send(body);
  }
}
