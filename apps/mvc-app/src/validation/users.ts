import { z } from 'zod';
import { ROLES, STAFF_ROLES } from '@/lib/enums';
import { email, mobile, personName, uuid } from '@/lib/validators';

export const createStaffSchema = z
  .object({
    role: z.enum(STAFF_ROLES as [string, ...string[]]),
    name: personName,
    mobile,
    email: email.optional(),
    /** Required when creating a District Admin. */
    districtId: uuid.optional(),
    /** Required when a District Admin (or Web Admin) creates a Sub Admin. */
    ulbId: uuid.optional(),
    /** Optional home area for a worker or supervisor. */
    areaId: uuid.optional(),
    /** Temporary staff (events): sign-in stops at this moment. Supervisors and workers only. */
    accessExpiresAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export const updateStatusSchema = z.object({ status: z.enum(['ACTIVE', 'DISABLED']) }).strict();

export const listUsersQuery = z.object({ role: z.enum(ROLES).optional() });
