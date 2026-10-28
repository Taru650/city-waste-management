import { NotificationController } from '@/controllers/NotificationController';
import { route } from '@/middleware/route';

export const dynamic = 'force-dynamic';
export const GET = route({}, NotificationController.unreadCount);
