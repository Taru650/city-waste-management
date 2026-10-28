import { z } from 'zod';
import { COMPLAINT_STATUSES } from '@/lib/enums';
import { paging, uuid } from '@/lib/validators';

const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);
const mediaIds = (max: number) => z.array(uuid).max(max).refine((a) => new Set(a).size === a.length, 'mediaIds must be unique');

const geoPoint = z.object({ lat, lng, accuracyM: z.number().min(0).max(10_000).optional() }).strict();
/** ISO 8601 date or date-time (for example 2026-10-01 or 2026-10-01T00:00:00+05:30). */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/, 'must be an ISO 8601 date')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'must be a real date')
  .transform((v) => new Date(v));
const flag = z.enum(['true', 'false']).transform((v) => v === 'true');

export const createComplaintSchema = z
  .object({
    typeId: uuid,
    /** Where the problem is (captured with the photo). */
    lat,
    lng,
    gpsAccuracyM: z.number().min(0).max(10_000).optional(),
    /** Ward chosen by the citizen. Omit to use the ward detected from GPS. Any ward of any ULB is allowed. */
    wardId: uuid.optional(),
    landmark: text(0, 50).optional(),
    description: text(5, 250),
    /** Verified in-app captures (POST /media/upload-url, PUT, confirm). 1 to 6 items. */
    mediaIds: mediaIds(6).min(1),
  })
  .strict();

export const assignSchema = z.object({ workerId: uuid.optional(), supervisorId: uuid.optional(), remark: text(0, 500).optional() }).strict();
export const startSchema = z.object({ remark: text(0, 500).optional(), mediaIds: mediaIds(6).optional(), location: geoPoint.optional() }).strict();
export const resolveSchema = z.object({ remark: text(5, 500), mediaIds: mediaIds(6).optional(), location: geoPoint.optional() }).strict();
export const rejectSchema = z.object({ reason: text(5, 500) }).strict();
export const duplicateSchema = z.object({ duplicateOfId: uuid, remark: text(0, 500).optional() }).strict();
export const feedbackSchema = z
  .object({
    rating: z.number().int().min(1).max(5),
    remark: text(0, 250).optional(),
    /** Only allowed with a rating of 1 or 2. */
    reopen: z.boolean().optional(),
  })
  .strict();

export const listComplaintsQuery = z.object({
  status: z.enum(COMPLAINT_STATUSES).optional(),
  ulbId: uuid.optional(),
  wardId: uuid.optional(),
  typeId: uuid.optional(),
  eventZoneId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  escalated: flag.optional(),
  open: flag.optional(),
  overdue: flag.optional(),
  ...paging,
});
