import { NotificationController } from '@/controllers/NotificationController';
import { route } from '@/middleware/route';
import { listNotificationsQuery } from '@/validation/notifications';

export const dynamic = 'force-dynamic';
export const GET = route({ query: listNotificationsQuery }, NotificationController.list);
