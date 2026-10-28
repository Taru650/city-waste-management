import { AuthController } from '@/controllers/AuthController';
import { route } from '@/middleware/route';

export const dynamic = 'force-dynamic';
export const GET = route({ allowPendingPasswordChange: true, allowWithoutConsent: true }, AuthController.me);
