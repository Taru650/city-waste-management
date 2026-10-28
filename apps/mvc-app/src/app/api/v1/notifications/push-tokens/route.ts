import { NotificationController } from '@/controllers/NotificationController';
import { route } from '@/middleware/route';
import { pushTokenSchema, removePushTokenSchema } from '@/validation/notifications';

export const dynamic = 'force-dynamic';
export const POST = route({ body: pushTokenSchema }, NotificationController.registerToken);
// Allowed while the privacy notice is pending: signing out must always be able to drop the token.
export const DELETE = route({ allowWithoutConsent: true, body: removePushTokenSchema }, NotificationController.removeToken);
