import { AuthController } from '@/controllers/AuthController';
import { route } from '@/middleware/route';
import { changePasswordSchema } from '@/validation/auth';

export const dynamic = 'force-dynamic';
export const POST = route(
  { throttle: 'auth', allowPendingPasswordChange: true, allowWithoutConsent: true, body: changePasswordSchema },
  AuthController.changePassword,
);
