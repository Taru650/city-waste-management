import { NotificationController } from '@/controllers/NotificationController';
import { route } from '@/middleware/route';

export const dynamic = 'force-dynamic';
export const POST = route({}, NotificationController.read);
