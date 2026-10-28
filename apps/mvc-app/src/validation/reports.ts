import { z } from 'zod';
import { uuid } from '@/lib/validators';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

export const BREAKDOWN_BY = ['district', 'ulb', 'ward', 'type', 'supervisor', 'worker'] as const;
export const AGEING_GROUP = ['none', 'district', 'ulb', 'ward', 'type', 'supervisor'] as const;
export const EXPORT_REPORTS = ['complaints', 'breakdown', 'ageing', 'trend'] as const;
export type BreakdownBy = (typeof BREAKDOWN_BY)[number];
export type AgeingGroup = (typeof AGEING_GROUP)[number];

const filters = {
  /** From date (IST, inclusive). Default: 29 days before `to`. */
  from: date.optional(),
  /** To date (IST, inclusive). Default: today. */
  to: date.optional(),
  districtId: uuid.optional(),
  ulbId: uuid.optional(),
  wardId: uuid.optional(),
  typeId: uuid.optional(),
  /** Event zone dashboard. */
  eventZoneId: uuid.optional(),
};

export const reportFilterQuery = z.object(filters);
export const breakdownQuery = z.object({ ...filters, by: z.enum(BREAKDOWN_BY).default('ulb') });
export const ageingQuery = z.object({ ...filters, groupBy: z.enum(AGEING_GROUP).default('none') });
export const exportQuery = z.object({
  ...filters,
  report: z.enum(EXPORT_REPORTS),
  format: z.enum(['xlsx', 'csv']).default('xlsx'),
  by: z.enum(BREAKDOWN_BY).default('ulb'),
  groupBy: z.enum(AGEING_GROUP).default('ulb'),
});

export type ReportFilter = z.infer<typeof reportFilterQuery>;
