import { z } from 'zod';
import { paging } from '@/lib/validators';

// FCM tokens are URL-safe base64 plus ':' (about 160-250 chars). The cap keeps the unique index safe.
const token = z.string().min(20).max(2048).regex(/^[A-Za-z0-9_:-]+$/);

export const pushTokenSchema = z.object({ token, platform: z.enum(['ANDROID', 'IOS']) }).strict();
export const removePushTokenSchema = z.object({ token }).strict();
export const listNotificationsQuery = z.object({ unread: z.enum(['true', 'false']).transform((v) => v === 'true').optional(), ...paging });
