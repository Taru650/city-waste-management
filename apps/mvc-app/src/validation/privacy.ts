import { z } from 'zod';
import { email, personName } from '@/lib/validators';

export const consentSchema = z.object({ noticeVersion: z.string().max(20), language: z.enum(['hi', 'en']) }).strict();

export const correctProfileSchema = z
  .object({
    name: personName.optional(),
    /** null removes it. */
    guardianName: personName.nullable().optional(),
    email: email.optional(),
  })
  .strict();

export const erasureSchema = z.object({ password: z.string().max(128) }).strict();
