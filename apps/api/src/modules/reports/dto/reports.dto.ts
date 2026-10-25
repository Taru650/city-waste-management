import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID, Matches } from 'class-validator';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ReportFilterQuery {
  @ApiPropertyOptional({ description: 'From date (IST, inclusive), YYYY-MM-DD. Default: 29 days before `to`.' })
  @IsOptional() @Matches(DATE, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({ description: 'To date (IST, inclusive), YYYY-MM-DD. Default: today.' })
  @IsOptional() @Matches(DATE, { message: 'to must be YYYY-MM-DD' })
  to?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID()
  districtId?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID()
  ulbId?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID()
  wardId?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID()
  typeId?: string;

  @ApiPropertyOptional({ description: 'Event zone dashboard' }) @IsOptional() @IsUUID()
  eventZoneId?: string;
}

export const BREAKDOWN_BY = ['district', 'ulb', 'ward', 'type', 'supervisor', 'worker'] as const;
export type BreakdownBy = (typeof BREAKDOWN_BY)[number];

export class BreakdownQuery extends ReportFilterQuery {
  @ApiPropertyOptional({ enum: BREAKDOWN_BY, default: 'ulb' }) @IsOptional() @IsIn(BREAKDOWN_BY)
  by: BreakdownBy = 'ulb';
}

export const AGEING_GROUP = ['none', 'district', 'ulb', 'ward', 'type', 'supervisor'] as const;
export type AgeingGroup = (typeof AGEING_GROUP)[number];

export class AgeingQuery extends ReportFilterQuery {
  @ApiPropertyOptional({ enum: AGEING_GROUP, default: 'none' }) @IsOptional() @IsIn(AGEING_GROUP)
  groupBy: AgeingGroup = 'none';
}

export const EXPORT_REPORTS = ['complaints', 'breakdown', 'ageing', 'trend'] as const;

export class ExportQuery extends ReportFilterQuery {
  @ApiPropertyOptional({ enum: EXPORT_REPORTS }) @IsIn(EXPORT_REPORTS)
  report: (typeof EXPORT_REPORTS)[number];

  @ApiPropertyOptional({ enum: ['xlsx', 'csv'], default: 'xlsx' }) @IsOptional() @IsIn(['xlsx', 'csv'])
  format: 'xlsx' | 'csv' = 'xlsx';

  @ApiPropertyOptional({ enum: BREAKDOWN_BY }) @IsOptional() @IsIn(BREAKDOWN_BY)
  by: BreakdownBy = 'ulb';

  @ApiPropertyOptional({ enum: AGEING_GROUP }) @IsOptional() @IsIn(AGEING_GROUP)
  groupBy: AgeingGroup = 'ulb';
}
