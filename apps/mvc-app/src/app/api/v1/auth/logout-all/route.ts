import { AuthController } from '@/controllers/AuthController';
import { route } from '@/middleware/route';

export const dynamic = 'force-dynamic';
export const POST = route({ allowPendingPasswordChange: true, allowWithoutConsent: true }, AuthController.logoutAll);
